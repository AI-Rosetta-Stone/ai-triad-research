// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type { DebateSession, TurnValidation, TaxonomySuggestion } from '../../../types/debate';
import { useDebateStore } from '../store';
import { api } from '@bridge';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { parseAIJson } from '@lib/debate/helpers';
import { parseEntrySummaries } from '@lib/debate/entrySummaries';
import { entrySummarizationPrompt } from '../../../prompts/debate';
import { findNodeMetaInStore } from './taxonomyContext';
import { _abortController, isCancellationError } from './guards';
import { ActionableError } from '@lib/debate/errors';
// getDocTitles lives in a store-free module to avoid a load-order cycle (t/1779);
// re-exported here so existing importers (debate*Slice) stay unchanged.
export { getDocTitles } from './docTitles';

/**
 * Phase-safe debate state update. Background async tasks (extractClaimsAndUpdateAN,
 * runNeutralCheckpoint, summarizeTranscriptEntry) read debate state, do work, then
 * spread the stale snapshot back via set(). If synthesis has set phase='closed' in
 * the meantime, the spread clobbers it back to 'debate' — a phase regression.
 *
 * This helper preserves the current phase when merging background updates.
 */
export function phaseGuardedSet(
  get: () => any,
  set: (partial: any) => void,
  updates: Partial<DebateSession>,
): void {
  const current = get().activeDebate as DebateSession | null;
  if (!current) return;
  set({ activeDebate: { ...current, ...updates } });
}

/** Normalize progress from either flat shape (Electron IPC) or nested retry shape (lib DebateProgress). */
function normalizeProgress(p: Record<string, unknown>): { attempt: number; maxRetries: number; backoffSeconds?: number; limitType?: string; limitMessage?: string; phase?: string } {
  // Lib DebateProgress: { phase: 'retry', retry: { attempt, maxRetries, backoffSeconds }, message }
  const retry = p.retry as { attempt: number; maxRetries: number; backoffSeconds: number } | undefined;
  if (retry && typeof retry === 'object') {
    return {
      attempt: retry.attempt,
      maxRetries: retry.maxRetries,
      backoffSeconds: retry.backoffSeconds,
      limitMessage: p.message as string | undefined,
      phase: p.phase as string | undefined,
    };
  }
  // Flat shape from Electron IPC: { attempt, maxRetries, backoffSeconds, limitType, limitMessage }
  return p as { attempt: number; maxRetries: number; backoffSeconds?: number; limitType?: string; limitMessage?: string };
}

/** Call generateText with progress tracking — subscribes to onGenerateTextProgress */
export async function generateTextWithProgress(
  prompt: string,
  model: string,
  activity: string,

  set: (partial: any) => void,
  timeoutMs?: number,
): Promise<{ text: string }> {
  set({ debateGeneratingStartedAt: Date.now(), debateActivity: activity, debateProgress: null });
  const unsubscribe = api.onGenerateTextProgress((progress: Record<string, unknown>) => {
    set({ debateProgress: normalizeProgress(progress) });
  });
  try {
    // Thread the live debate abort signal (t/2508) so cancelAndResetAbort() physically
    // kills the in-flight request instead of merely gating late results. Read inline:
    // the currently-active controller is the one owning this call at await time.
    const result = await api.generateText(prompt, model, timeoutMs, undefined, { signal: _abortController?.signal, purpose: activity });
    return result;
  } catch (err) {
    if (isCancellationError(err)) {
      // Deliberate cancel (Switch model / Cancel debate) — record at info, not error,
      // and re-throw the tagged error so the caller's catch can bail quietly (t/2508).
      getGlobalRecorder()?.record({ type: 'debate.lifecycle', component: 'debate-store', level: 'info', message: `AI generation cancelled: ${activity}` });
    }
    throw err;
  } finally {
    unsubscribe();
    set({ debateProgress: null, debateActivity: null, debateGeneratingStartedAt: null });
  }
}

/** t/782: WARN (flight recorder + console) when a structured Brief was dropped or kept with a soft problem. */
function warnStructuredBrief(entryId: string, debateId: string | undefined, dropped?: string, soft?: string): void {
  if (dropped) {
    getGlobalRecorder()?.record({ type: 'ai.fallback', component: 'debate-store', level: 'warn', debate_id: debateId, message: `Structured Brief dropped for entry ${entryId} (${dropped}); the brief paragraph is kept`, data: { entry_id: entryId, reason: dropped } });
    console.warn(`[debate] WARN summarizeEntry: structured Brief dropped for ${entryId} (${dropped}); brief paragraph kept (t/782)`);
  }
  if (soft) {
    getGlobalRecorder()?.record({ type: 'system.error', component: 'debate-store', level: 'warn', debate_id: debateId, message: `Structured Brief kept with a warning for entry ${entryId}: ${soft}`, data: { entry_id: entryId, reason: soft } });
    console.warn(`[debate] WARN summarizeEntry: ${entryId} ${soft} (t/782)`);
  }
}

/** Post-turn summarization (DT-2): generate brief + medium summaries for a transcript entry. */
export async function summarizeTranscriptEntry(
  entryId: string,
  content: string,
  speaker: string,
  model: string,
  get: () => { activeDebate: DebateSession | null },
  set: (partial: Partial<{ activeDebate: DebateSession | null }>) => void,
): Promise<void> {
  const MAX_RETRIES = 2;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const prompt = entrySummarizationPrompt(content, speaker);
      const { text } = await api.generateText(prompt, model);
      // t/782: the same parser the engine path uses (t/700), so the two can't diverge. brief and medium are
      // required; brief_claim/brief_points are kept only when well formed. Unparseable JSON throws into the
      // catch below, which retries.
      const { summaries, structuredDropped, structuredWarning } = parseEntrySummaries(text);
      if (!summaries) {
        console.warn(`[debate] summarizeEntry: missing brief/medium (attempt ${attempt + 1}/${MAX_RETRIES}). Raw response:`, text.slice(0, 500));
        continue;
      }
      warnStructuredBrief(entryId, get().activeDebate?.id, structuredDropped, structuredWarning);
      // Re-read current state to avoid clobbering phase changes from concurrent tasks
      const debate = get().activeDebate;
      if (!debate) return;
      const entry = debate.transcript.find(e => e.id === entryId);
      if (entry) {
        entry.summaries = summaries;
        set({ activeDebate: { ...debate } });
      }
      return; // success
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        debate_id: get().activeDebate?.id,
        component: 'debate-store',
        level: 'warn',
        message: `Summarize entry failed (attempt ${attempt + 1}/${MAX_RETRIES})`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      console.warn(`[debate] summarizeEntry failed (attempt ${attempt + 1}/${MAX_RETRIES}):`, err);
    }
  }
  console.warn(`[debate] summarizeEntry: all ${MAX_RETRIES} attempts failed for entry ${entryId}. Detail level pills will be unavailable for this entry.`);
  try {
      const s = useDebateStore.getState();
    if (s.debateWarnings.length < 50) {
      useDebateStore.setState({ debateWarnings: [...s.debateWarnings, 'Entry summarization failed — detail level pills unavailable'] });
    }
  } catch (e) { getGlobalRecorder()?.record({ type: 'system.error', debate_id: get().activeDebate?.id, component: 'debate-store', level: 'warn', message: 'Store not ready during summarizeEntry warning push', error: { name: (e as Error).name ?? 'Error', message: String(e), stack: (e as Error).stack } }); }
}

export function routeTurnValidatorHintsIntoSuggestions(
  validation: TurnValidation,
  entryId: string,
  existing: TaxonomySuggestion[] | undefined,
): TaxonomySuggestion[] {
  const out: TaxonomySuggestion[] = existing ? [...existing] : [];
  const HINT_TO_SUGGESTION = {
    narrow: 'narrow', broaden: 'broaden', split: 'split', merge: 'merge',
    qualify: 'qualify', retire: 'retire', new_node: 'new_node',
  } as const;

  for (const hint of validation.clarifies_taxonomy) {
    const type = HINT_TO_SUGGESTION[hint.action];
    if (!type) continue;

    if (type === 'new_node') {
      if (!hint.label) continue;
      if (out.some(s => s.source === 'turn-validator' && s.suggestion_type === 'new_node' && s.node_label === hint.label)) continue;
      out.push({
        node_id: `pending:${hint.label}`,
        node_label: hint.label,
        node_pov: 'unknown',
        suggestion_type: 'new_node',
        rationale: hint.rationale || 'Proposed mid-debate by the turn validator.',
        evidence_claim_ids: hint.evidence_claim_id ? [hint.evidence_claim_id] : undefined,
        source: 'turn-validator',
        origin_entry_id: entryId,
      });
      continue;
    }

    if (!hint.node_id) continue;
    if (out.some(s => s.source === 'turn-validator' && s.node_id === hint.node_id && s.suggestion_type === type)) continue;

    const meta = findNodeMetaInStore(hint.node_id);
    out.push({
      node_id: hint.node_id,
      node_label: meta?.label ?? hint.node_id,
      node_pov: meta?.pov ?? 'unknown',
      suggestion_type: type,
      current_description: meta?.description,
      rationale: hint.rationale || 'Surfaced mid-debate by the turn validator.',
      evidence_claim_ids: hint.evidence_claim_id ? [hint.evidence_claim_id] : undefined,
      source: 'turn-validator',
      origin_entry_id: entryId,
      merge_with_node_ids: type === 'merge' ? hint.node_ids : undefined,
    });
  }
  return out;
}

// ── Source evidence index (lazy-loaded once per session via IPC) ──
let _cachedEvidenceIndex: Record<string, unknown> | null | undefined;
export async function getSourceEvidenceIndex(): Promise<Record<string, unknown> | undefined> {
  if (_cachedEvidenceIndex !== undefined) return _cachedEvidenceIndex ?? undefined;
  try {
    const bridge = api as unknown as { loadSourceEvidenceIndex?: () => Promise<Record<string, unknown> | null> };
    console.log(`[debate-store] getSourceEvidenceIndex: bridge.loadSourceEvidenceIndex exists = ${!!bridge.loadSourceEvidenceIndex}`);
    if (!bridge.loadSourceEvidenceIndex) { _cachedEvidenceIndex = null; return undefined; }
    const result = await bridge.loadSourceEvidenceIndex();
    console.log(`[debate-store] getSourceEvidenceIndex: result = ${result ? `object with ${Object.keys(result).length} keys` : String(result)}`);
    _cachedEvidenceIndex = result;
    return result ?? undefined;
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'debate-store',
      level: 'warn',
      message: 'Failed to load source evidence index',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    console.error(`[debate-store] getSourceEvidenceIndex ERROR:`, err);
    _cachedEvidenceIndex = null;
    return undefined;
  }
}

// ── Stage generate factory (shared by opening + cross-respond) ──

// t/4044: the onServed recorder for a speaker's stage-generate lives with the factory it feeds.
export { servedTurnRecorder } from './failoverTracking';

export function makeStageGenerate(
  set: (partial: Record<string, unknown>) => void,
  model: string,
  // t/4044: told the requested and served model after each successful call (shared/failoverTracking.ts).
  onServed?: (requested: string, served: string | undefined) => void,
): (prompt: string, callModel: string, options: { temperature?: number; timeoutMs?: number; maxTokens?: number }, label: string) => Promise<string> {
  return async (prompt, callModel, options, label) => {
    set({ debateGeneratingStartedAt: Date.now(), debateActivity: label, debateProgress: null });
    const unsubscribe = api.onGenerateTextProgress((progress: Record<string, unknown>) => {
      set({ debateProgress: normalizeProgress(progress) });
    });
    try {
      // Thread the live debate abort signal (t/2508) — see generateTextWithProgress.
      const result = await api.generateText(prompt, callModel || model, options.timeoutMs, options.temperature, { signal: _abortController?.signal, purpose: label, maxTokens: options.maxTokens });
      // t/3525: the live app's stage pipeline (this function) never routes through
      // lib/debate/aiAdapter.ts's equivalent check — mirror it here so a truncated/blocked
      // response fails loudly instead of reaching parseAIJson as corrupt partial JSON.
      if (result.stopReason === 'max_tokens') {
        throw new ActionableError({
          goal: 'Generate AI response',
          problem: `Response truncated at provider output limit for "${label}" — JSON parse would fail on partial output`,
          location: 'generation.makeStageGenerate',
          nextSteps: ['Raise maxTokens for this stage', 'Shorten the prompt'],
        });
      }
      if (result.stopReason === 'content_filter') {
        throw new ActionableError({
          goal: 'Generate AI response',
          problem: `Response blocked by provider content policy for "${label}"`,
          location: 'generation.makeStageGenerate',
          nextSteps: ['Review the prompt for policy-violating content', 'Try a different model or backend'],
        });
      }
      onServed?.(callModel || model, result.servedModel);
      return result.text;
    } catch (err) {
      if (isCancellationError(err)) {
        getGlobalRecorder()?.record({ type: 'debate.lifecycle', component: 'debate-store', level: 'info', message: `AI generation cancelled: ${label}` });
      }
      throw err;
    } finally {
      unsubscribe();
      set({ debateProgress: null, debateActivity: null, debateGeneratingStartedAt: null });
    }
  };
}
