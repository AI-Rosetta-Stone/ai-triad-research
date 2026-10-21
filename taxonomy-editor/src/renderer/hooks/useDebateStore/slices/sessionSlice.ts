// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type { StateCreator } from 'zustand';
import { sessionModelFingerprint } from '../shared/sessionFingerprint';
import { latchUnobservedHistory } from '../shared/failoverTracking';
import type { DebateStore } from '../types';
import type {
  DebateSession,
  DebateSessionSummary,
  DebateSourceType,
  DebateAudience,
  SpeakerId,
  SeatTag,
  TranscriptEntry,
  EntryDiagnostics,
} from '../../../types/debate';
import { POVER_INFO, AI_POVERS, POV_KEYS, normalizeActivePovers, migrateSpeakerId } from '../../../types/debate';
import { api, setActiveDebateId, isElectronMode } from '@bridge';
import { isCircuitOpenError, getCircuitCooldownMs } from '../../../bridge/resilience';
import { buildDebateDelta } from './buildDebateDelta';
import { getDocTitles } from '../shared/docTitles';
import { enterClarificationOrBegin } from '../shared/clarificationGuard';
import { getRemoteRunLeaseHolder, notifyDebateSaved } from '../shared/debateRunLease';
import type { DocMetaMap } from '@lib/debate/evidenceFromSummaries';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { trackDebateAbandon, trackDebateStart } from '../../../lib/analyticsEmitter';
import { useTaxonomyStore } from '../../useTaxonomyStore';
import { resolveNode } from '../../useTaxonomyStore/superseded'; // t/4355
import { usePromptConfigStore } from '../../usePromptConfigStore';
import { mapErrorToUserMessage } from '../../../utils/errorMessages';
import { formatSituationDebateContext, situationTopicSynthesisPrompt } from '../../../prompts/debate';
import type { SituationTopicSynthesisResult } from '../../../prompts/debate';
import { normalizeBdiLayer } from '@lib/debate';
import { interpretationText } from '@lib/debate/taxonomyTypes';
import { generateId, nowISO } from '@lib/debate/helpers';
import type { MoveAnnotation } from '@lib/debate/helpers';
import { getMoveName, parseAIJson } from '@lib/debate/helpers';
import { disambiguateTerms } from '@lib/debate/vocabularyDisambiguation';
import type { CampOrigin, StandardizedTerm, ColloquialTerm } from '@lib/dictionary/types';
import { resetDoctrinalAnchoringCache } from '../shared/taxonomyContext';
import { resetNeutralMapping } from '../shared/neutralCheckpoint';
import { resetSignalHistory, resetGapInjectionCount, setGapInjectionCount } from '../shared/diagnostics';
import { isStateAhead } from '../shared/phaseOrder';

/** Viewer-save skips already logged, one per (debate, holder run), so auto-save ticks don't flood the recorder. */
const _viewerSaveSkipLogged = new Set<string>();
/** Automatic saves a viewer skips quietly (t/3917): timers, coalescing/retry, background
 *  compression, load recovery, and run-internal saves. Any OTHER caller is a user edit, and the
 *  user is told it wasn't saved; the next refresh from the holder would otherwise silently undo
 *  it. The live run caught compressOldTranscript missing from an earlier version of this list,
 *  which would have shown a false "your change wasn't saved" notice. */
const BACKGROUND_SAVE_CALLERS = new Set(['auto-save', 'DebateWorkspace:autoSave', 'coalesced-followup', 'breaker-cooldown-retry', 'compressOldTranscript', 'loadDebate:interrupted_turn_recovery', 'news-report-save-retry', 'synthesis-complete', 'updatePhase']);
const BACKGROUND_SAVE_PREFIXES = ['crossRespond:', 'runOpeningStatements:', 'extractClaimsAndUpdateAN', 'extractTopicScope'];
const isBackgroundSave = (caller: string): boolean =>
  BACKGROUND_SAVE_CALLERS.has(caller) || BACKGROUND_SAVE_PREFIXES.some(p => caller.startsWith(p));

declare const __APP_VERSION__: string;

export interface SessionSlice {
  sessions: DebateSessionSummary[];
  sessionsLoading: boolean;
  activeDebateId: string | null;
  activeDebate: DebateSession | null;
  debateLoading: boolean;

  loadSessions: () => Promise<void>;
  createDebate: (topic: string, povers: SpeakerId[], userIsPover: boolean, sourceType?: DebateSourceType, sourceRef?: string, sourceContent?: string, debateModel?: string, protocolId?: string, debateTemperature?: number, debateAudience?: DebateAudience, options?: { title?: string; evaluatorModel?: string; pacing?: string; useAdaptiveStaging?: boolean; phaseBoundsOverride?: { maxConfrontationRounds?: number; maxArgumentationRounds?: number; maxConcludingRounds?: number }; speakerModels?: Record<string, string>; modelTier?: 'basic' | 'advanced'; /** t/4046: backends eligible for a multi-provider run; keys model_pool (t/4044). */ eligibleBackends?: string[]; stepMode?: boolean; stageModels?: { brief?: string; plan?: string; cite?: string }; background?: string; excludeGreatestHits?: boolean; narrativeVoicing?: boolean; /** t/3958: absent ⇒ every seat untagged. Never pass `{}` — t/3975's seatSouls treats any key presence as "tagged". */ seatTags?: Partial<Record<SpeakerId, SeatTag>> }) => Promise<string>;
  // Config is threaded into createDebate's existing options param at creation time (t/3783) —
  // never patched onto the session afterward. A post-creation mutate-then-save races every
  // concurrent `set({ activeDebate: { ...fresh } })` in the opening/clarification pipeline,
  // which discards an in-place mutation the store never saw via set().
  createSituationDebate: (ccNodeId: string, config?: {
    effectiveModel?: string; pacing?: string; useAdaptiveStaging?: boolean;
    temperature?: number; audience?: DebateAudience; protocolId?: string;
    /** t/3929: passed through to createDebate unchanged, so the engine sees the same
     *  adaptive config from a situation debate as from a normal one (t/3882, PI: mirror
     *  the normal path). Same field and shape as createDebate's option. */
    phaseBoundsOverride?: NonNullable<Parameters<SessionSlice['createDebate']>[10]>['phaseBoundsOverride'];
  }) => Promise<string>;
  createConflictDebate: (claimId: string) => Promise<string>;
  loadDebate: (id: string) => Promise<void>;
  loadDebateFromData: (raw: unknown, opts?: { readOnly?: boolean }) => void;
  // Concurrent-load coalescing (t/2326): loads of the same debate id in flight at
  // once share ONE promise, so a debate window that mounts N hooks fires the IPC —
  // and applies the loaded snapshot — exactly once. Mirrors the save-coalescing
  // (_saveInFlight/_saveDirty) below. Keyed by debate id; entries are cleared when
  // their load settles.
  _loadInFlight: Record<string, Promise<void>>;
  deleteDebate: (id: string) => Promise<void>;
  renameDebate: (id: string, newTitle: string) => Promise<void>;
  closeDebate: () => void;
  addTranscriptEntry: (entry: Omit<TranscriptEntry, 'id' | 'timestamp'>) => string;
  // Slot-first opening lifecycle (t/2907). upsert inserts a per-speaker opening slot
  // at generation start (or returns the existing slot's id — no duplicate), and update
  // mutates it in place through generating→retrying→done/error, so a retry cycles one
  // card instead of appending new panels + system retry-toast entries.
  upsertTranscriptEntry: (entry: Omit<TranscriptEntry, 'id' | 'timestamp'>) => string;
  updateTranscriptEntry: (id: string, patch: Partial<TranscriptEntry>) => void;
  deleteTranscriptEntries: (entryIds: string[]) => Promise<void>;
  togglePover: (poverId: SpeakerId) => Promise<void>;
  updatePhase: (phase: DebateSession['phase']) => void;
  updateTopic: (topic: Partial<DebateSession['topic']>) => void;
  // `caller` is required (t/2326): a diagnostic label naming the trigger of every
  // save. Making it mandatory kills the `caller:"unknown"` blind spot that hid a
  // regressed-state save in the d1c7f7b6 incident — tsc now flags any save site
  // that omits it.
  saveDebate: (caller: string) => Promise<void>;
  _saveInFlight: boolean;
  _saveDirty: boolean;
  // Snapshot-diff dirty tracking for incremental (delta) save on web (t/1637).
  // `_lastSyncedSnapshot` is a structuredClone of the session state as last
  // successfully persisted to the server; `_lastSyncedVersion` is the server
  // `_saveVersion` that snapshot was acknowledged at. Together they let saveDebate
  // build a minimal DebateDelta. `null` = never synced this session (first save is
  // always a full PUT — lazy migration, absent version == 0). Electron never uses
  // these (the store routes Electron saves through the full path).
  _lastSyncedVersion: number | null;
  _lastSyncedSnapshot: DebateSession | null;
  // Save-durability under an OPEN 'save' circuit breaker (t/3073). When a save is rejected
  // because the breaker is open, it is NOT dropped: it is flagged degraded and re-attempted
  // after the breaker cooldown. `_breakerRetryCount` counts consecutive breaker-blocked
  // attempts (reset to 0 on any successful save); `_breakerRetryScheduled` guards against
  // scheduling more than one cooldown retry when several callers race the open breaker.
  _breakerRetryCount: number;
  _breakerRetryScheduled: boolean;
  toggleStepMode: () => Promise<void>;
  setDebatePhase: (phase: 'confrontation' | 'argumentation' | 'concluding') => Promise<void>;
}

// ── saveDebate phase helpers (t/1848) ────────────────────────────────
// saveDebate was a single 72-complexity async action. Its cohesive phases are
// extracted here as helpers (bodies moved verbatim; see ADR-007 split pattern).
// The load-bearing t/1637 save-path selection is preserved intact inside
// persistDebateToServer; ADR-003 record() calls stay inline in saveDebate's catch.
type SessionSet = Parameters<StateCreator<DebateStore, [], [], SessionSlice>>[0];
type SessionGet = Parameters<StateCreator<DebateStore, [], [], SessionSlice>>[1];

/**
 * Stamp doc_meta for document-grounded debates so source-authority/recency
 * calibration resolves on BOTH save paths (Electron IPC save + web POST) — t/1779.
 * App-run debates never instantiate DebateEngine, whose filesystem-derived
 * `docTitles` was the only place doc provenance was computed; without it,
 * extractCalibrationData saw no docMeta and computeSourceAuthority returned all-null.
 * Stamp from the same client-side catalog the turn pipeline already uses
 * (getDocTitles), keyed to the doc_ids actually cited in the argument network.
 * Doc-less debates cite no source docs → doc_meta stays undefined (back-compat).
 */
// Returns undefined (a synchronous no-op) when the debate cites no source docs, so
// saveDebate does NOT introduce an await before the network save — preserving the
// original timing the coalescing / t/1637 sent-snapshot invariants depend on. Only
// when there ARE cited docs does it return a promise the caller awaits.
function stampDocMeta(activeDebate: DebateSession): void | Promise<void> {
  const citedDocIds = new Set<string>();
  for (const node of activeDebate.argument_network?.nodes ?? []) {
    for (const item of node.evidence_graph?.evidence_items ?? []) {
      if (item.source_doc_id) citedDocIds.add(item.source_doc_id);
    }
  }
  if (citedDocIds.size === 0) return;
  return applyDocMeta(activeDebate, citedDocIds);
}

async function applyDocMeta(activeDebate: DebateSession, citedDocIds: Set<string>): Promise<void> {
  const catalog = await getDocTitles();
  if (!catalog) return;
  const docMeta: DocMetaMap = {};
  for (const id of citedDocIds) {
    const meta = catalog[id];
    if (meta) docMeta[id] = meta;
  }
  if (Object.keys(docMeta).length > 0) activeDebate.doc_meta = docMeta;
}

/** Tally move-type and disagreement-type counts from one transcript entry's metadata. */
function tallyMoveTypes(
  overview: { move_type_counts: Record<string, number>; disagreement_type_counts: Record<string, number> },
  meta: Record<string, unknown> | undefined,
): void {
  if (Array.isArray(meta?.move_types)) {
    for (const m of meta.move_types as (string | MoveAnnotation)[]) {
      const name = getMoveName(m);
      overview.move_type_counts[name] = (overview.move_type_counts[name] ?? 0) + 1;
    }
  }
  if (typeof meta?.disagreement_type === 'string') {
    overview.disagreement_type_counts[meta.disagreement_type] =
      (overview.disagreement_type_counts[meta.disagreement_type] ?? 0) + 1;
  }
}

/** Sum accepted/rejected claim counts across all per-entry extraction traces. */
function tallyClaimCounts(
  overview: { claims_accepted: number; claims_rejected: number },
  entries: Record<string, EntryDiagnostics>,
): void {
  for (const diag of Object.values(entries) as EntryDiagnostics[]) {
    const trace = diag.extraction_trace;
    if (trace) {
      overview.claims_accepted += trace.candidates_accepted ?? 0;
      overview.claims_rejected += trace.candidates_rejected ?? 0;
    }
  }
}

/** Recompute the diagnostics overview aggregates (move/disagreement counts, accept/reject, situation citations) before save. */
function rebuildOverviewDiagnostics(activeDebate: DebateSession): void {
  const overview = activeDebate.diagnostics?.overview;
  if (!overview) return;
  overview.move_type_counts = {};
  overview.disagreement_type_counts = {};
  overview.claims_accepted = 0;
  overview.claims_rejected = 0;
  let turnsWithSitRefs = 0;
  let totalDebateTurns = 0;
  const uniqueSitIds = new Set<string>();
  for (const e of activeDebate.transcript) {
    if (e.type !== 'statement' && e.type !== 'opening') continue;
    totalDebateTurns++;
    const meta = e.metadata as Record<string, unknown> | undefined;
    tallyMoveTypes(overview, meta);
    const refs = e.taxonomy_refs;
    if (refs && refs.length > 0) {
      const sitRefs = refs.filter(r => r.node_id.startsWith('sit-'));
      if (sitRefs.length > 0) {
        turnsWithSitRefs++;
        for (const r of sitRefs) uniqueSitIds.add(r.node_id);
      }
    }
  }
  tallyClaimCounts(overview, activeDebate.diagnostics?.entries ?? {});
  if (totalDebateTurns > 0) {
    overview.situation_citations = {
      turns_with_sit_refs: turnsWithSitRefs,
      total_debate_turns: totalDebateTurns,
      citation_rate: turnsWithSitRefs / totalDebateTurns,
      unique_sit_ids_cited: [...uniqueSitIds].sort(),
    };
  }
}

/** Assemble the flight-recorder save-diagnostics payload for a debate. */
function buildSaveDiag(activeDebate: DebateSession, caller: string) {
  const payloadBytes = JSON.stringify(activeDebate).length;
  const turnCount = activeDebate.transcript.length;
  const nodeCount = (activeDebate as unknown as Record<string, unknown>).argument_network
    ? ((activeDebate as unknown as Record<string, { nodes?: unknown[] }>).argument_network?.nodes?.length ?? 0)
    : 0;
  return { phase: activeDebate.phase, transcript_length: turnCount, caller, payload_bytes: payloadBytes, turn_count: turnCount, node_count: nodeCount };
}
type SaveDiag = ReturnType<typeof buildSaveDiag>;

/**
 * Select and execute the save path (t/1637, parent t/1470). Web (2nd+ save of a
 * session that already has a sync baseline) ships a minimal delta via PATCH;
 * Electron and the first save of any session full-PUT. The server stores a
 * full-PUT body VERBATIM (it does NOT bump `_saveVersion`), so on the full-PUT
 * path the client stamps the next monotonic version and records it as the new
 * sync baseline; on the delta path the server returns the authoritative `newVersion`.
 */
async function persistDebateToServer(activeDebate: DebateSession, saveDiag: SaveDiag, get: SessionGet, set: SessionSet): Promise<void> {
  const { _lastSyncedVersion, _lastSyncedSnapshot } = get();

  // Post-save bookkeeping shared by every success path: refresh the sessions
  // summary row and emit the flight-recorder save event.
  const recordSaved = (mode: string, saveVersion?: number) => {
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === activeDebate.id
          ? { ...s, title: activeDebate.title, updated_at: activeDebate.updated_at, phase: activeDebate.phase }
          : s,
      ),
    }));
    getGlobalRecorder()?.record({ type: 'state.save', component: 'debate-store', level: 'info', debate_id: activeDebate.id, message: 'Debate saved', data: { ...saveDiag, save_mode: mode, save_version: saveVersion } });
  };

  // Full PUT + baseline seed. `baseVersion` is the version the server currently
  // holds; we stamp baseVersion+1 so a subsequent delta's baseVersion matches the
  // stored value. The snapshot we install is the EXACT state we sent, captured
  // BEFORE the await — never a post-await re-clone (t/1637 load-bearing condition:
  // an edit landing mid-flight must survive into the next delta).
  const fullPutAndSeed = async (baseVersion: number) => {
    const nextVersion = baseVersion + 1;
    activeDebate._saveVersion = nextVersion;
    const sent = structuredClone(activeDebate);
    await api.saveDebateSession(activeDebate, saveDiag.caller);
    set({ _lastSyncedSnapshot: sent, _lastSyncedVersion: nextVersion });
    recordSaved('full', nextVersion);
  };

  if (isElectronMode()) {
    // Electron desktop: local full-save, no version bookkeeping (deltas are
    // a web-only optimization).
    await api.saveDebateSession(activeDebate, saveDiag.caller);
    recordSaved('electron');
  } else if (_lastSyncedVersion === null || _lastSyncedSnapshot === null) {
    // Web, first save of a freshly-created (never-synced) session.
    await fullPutAndSeed(activeDebate._saveVersion ?? 0);
  } else {
    // Web, 2nd+ save with an established baseline → incremental delta.
    const result = buildDebateDelta(_lastSyncedSnapshot, activeDebate, _lastSyncedVersion);
    if (result.kind === 'empty') {
      // Nothing changed since the last sync — skip the network round-trip.
      getGlobalRecorder()?.record({ type: 'state.save', component: 'debate-store', level: 'info', debate_id: activeDebate.id, message: 'Debate save skipped — no changes since last sync', data: { ...saveDiag, save_mode: 'noop' } });
    } else if (result.kind === 'full') {
      // A change the delta model can't represent (in-place transcript/mutation
      // edit or truncation) — full-PUT and re-baseline.
      await fullPutAndSeed(_lastSyncedVersion);
    } else {
      const sent = structuredClone(activeDebate);
      try {
        const { newVersion } = await api.saveDebateDelta(result.delta);
        activeDebate._saveVersion = newVersion;
        sent._saveVersion = newVersion;
        set({ _lastSyncedSnapshot: sent, _lastSyncedVersion: newVersion });
        recordSaved('delta', newVersion);
      } catch (deltaErr) {
        const code = (deltaErr as Error & { errorCode?: string }).errorCode;
        if (code !== 'version_conflict') throw deltaErr; // save_in_progress / other → outer catch
        // Stale baseVersion: another writer advanced the server. Fall back to
        // an UNCONDITIONAL (never version-gated) full PUT — last-writer-wins —
        // so a second concurrent write can't re-conflict us into a retry loop
        // (t/1637). Stamp from the server's reported currentVersion when present.
        const currentVersion = (deltaErr as Error & { currentVersion?: number }).currentVersion;
        getGlobalRecorder()?.record({ type: 'state.save-coalesced', component: 'debate-store', level: 'warn', debate_id: activeDebate.id, message: `Delta save version_conflict (server at ${currentVersion ?? '?'}) — falling back to full PUT` });
        await fullPutAndSeed(typeof currentVersion === 'number' ? currentVersion : _lastSyncedVersion);
      }
    }
  }
}

/**
 * Classify a save failure and build the user-facing error state (t/1639, t/2231).
 * Distinguishes two durable-save-loss classes:
 *   1. HTTP 401/402/403 — auth or quota failure; the server rejected the write
 *      permanently until the user fixes their credentials or account.
 *   2. Disk total-loss (debateIO/t/1638) — rename + copy both failed, a .tmp
 *      recovery copy was preserved. Electron IPC strips the enriched
 *      ActionableError's structured fields, but the composed `.message` survives
 *      with stable markers.
 * The at-risk count is recomputed locally from the transcript (not string-scraped).
 */
function computeSaveErrorState(err: unknown, activeDebate: DebateSession): { isDurableSaveLoss: boolean; isBreakerBlocked: boolean; atRiskTurns: number; debateError: string } {
  const rawMessage = String((err as Error)?.message ?? '');
  const httpStatus = (err as { httpStatus?: number }).httpStatus;
  const isAuthQuotaFailure = httpStatus === 401 || httpStatus === 402 || httpStatus === 403;
  const isDiskLoss =
    rawMessage.includes('taxonomy-editor/src/main/debateIO.ts saveDebateSession') &&
    (rawMessage.includes('only durable copy') || rawMessage.includes('at risk of being lost'));
  // Breaker-blocked (t/3073): the 'save' circuit is OPEN, so this save never reached the
  // server. Detected via the TYPED discriminator, never a message substring (t/2952). This
  // is a recoverable degraded state — flagged (never silent), then queued for cooldown retry
  // by the caller — so it counts as save_degraded but is NOT a durable (terminal) loss.
  const isBreakerBlocked = isCircuitOpenError(err);
  const isDurableSaveLoss = isAuthQuotaFailure || isDiskLoss;
  const atRiskTurns = activeDebate.transcript.filter(
    (t) => t.type === 'statement' || t.type === 'opening',
  ).length;
  let debateError: string;
  if (isAuthQuotaFailure) {
    debateError = `Save failed: the server rejected this save (HTTP ${httpStatus}). ${atRiskTurns} ${atRiskTurns === 1 ? 'turn is' : 'turns are'} at risk of being lost. Check your API key and account status in Settings.`;
  } else if (isDiskLoss) {
    debateError = `Save failed: this debate couldn't be written to disk — another process (the app itself, antivirus, or a file indexer) is holding the file open. ${atRiskTurns} ${atRiskTurns === 1 ? 'turn is' : 'turns are'} at risk. A recovery copy was preserved on disk; retry the save once the lock clears, and don't close the app before it succeeds.`;
  } else if (isBreakerBlocked) {
    debateError = `Saving is paused while the server recovers. ${atRiskTurns} ${atRiskTurns === 1 ? 'turn is' : 'turns are'} not yet saved — this will retry automatically. Keep the app open.`;
  } else {
    debateError = mapErrorToUserMessage(err);
  }
  return { isDurableSaveLoss, isBreakerBlocked, atRiskTurns, debateError };
}

/** Max consecutive breaker-blocked save attempts before auto-retry stops and the state
 *  escalates to the LOUD terminal message (t/3073). */
const BREAKER_RETRY_CAP = 5;

/**
 * A save rejected by an OPEN 'save' circuit breaker (t/3073). Never dropped:
 *   - Under the cap: surface the degraded state and schedule ONE retry after the breaker
 *     cooldown (a `_breakerRetryScheduled` guard keeps racing callers from stacking timers).
 *     The retry rides the normal saveDebate path, whose HALF_OPEN probe either closes the
 *     breaker (save succeeds, counters reset in saveDebate's try) or re-queues.
 *   - At the cap: auto-retry stops and we emit a LOUD, actionable terminal state (TL
 *     refinement) — exact unsaved-turn count + "export a local copy now" — never a silent
 *     give-up. Saves still self-heal on the next natural save (each new turn calls
 *     saveDebate); a success there resets the counters.
 */
function handleBreakerBlockedSave(
  activeDebate: DebateSession,
  caller: string,
  atRiskTurns: number,
  degradedError: string,
  get: SessionGet,
  set: SessionSet,
): void {
  const attempts = get()._breakerRetryCount;
  if (attempts >= BREAKER_RETRY_CAP) {
    const loudError = `Save failed: the server stayed unreachable through ${attempts} automatic retries. ${atRiskTurns} ${atRiskTurns === 1 ? 'turn is' : 'turns are'} unsaved. Export this debate now (Export ▸ Download) to keep a local copy — saving retries on your next turn once the server recovers.`;
    set({ debateError: loudError, _breakerRetryScheduled: false });
    getGlobalRecorder()?.record({ type: 'state.error', component: 'debate-store', level: 'error', debate_id: activeDebate.id, message: 'Debate save abandoned after breaker-retry cap — turns unsaved, local export advised', error: { name: 'SaveBreakerExhaustedError', message: `save circuit OPEN through ${attempts} retries` }, data: { caller, turn_count: activeDebate.transcript.length, save_degraded: true, breaker_retry_exhausted: true, at_risk_turns: atRiskTurns } });
    return;
  }
  // Degraded but recoverable: surface it (observable — never save_degraded:false), then
  // schedule one cooldown retry unless a peer caller already did.
  set({ debateError: degradedError });
  getGlobalRecorder()?.record({ type: 'state.error', component: 'debate-store', level: 'warn', debate_id: activeDebate.id, message: 'Debate save paused — save circuit OPEN, retrying after cooldown', error: { name: 'SaveBreakerBlockedError', message: 'save circuit breaker OPEN' }, data: { caller, turn_count: activeDebate.transcript.length, save_degraded: true, breaker_retry: attempts + 1, at_risk_turns: atRiskTurns } });
  if (get()._breakerRetryScheduled) return;
  set({ _breakerRetryScheduled: true, _breakerRetryCount: attempts + 1 });
  const delay = getCircuitCooldownMs() + Math.random() * 500;
  setTimeout(() => {
    set({ _breakerRetryScheduled: false });
    void get().saveDebate('breaker-cooldown-retry');
  }, delay);
}

/**
 * Opening/statement vocabulary disambiguation (t/2907). Extracted so BOTH the
 * append path (addTranscriptEntry) and the slot-completion path (updateTranscriptEntry,
 * used when a generating opening slot resolves to its final statement) apply identical
 * enrichment — otherwise slot-first openings would silently lose vocabulary_resolutions.
 * Mutates `entry.metadata` in place; no-op for non-debater entries or when no colloquial
 * terms are loaded.
 */
function applyVocabularyResolutions(
  entry: TranscriptEntry,
  vocabularyTerms: { colloquial?: ColloquialTerm[] } | null | undefined,
): void {
  if (!vocabularyTerms?.colloquial) return;
  if (entry.type !== 'opening' && entry.type !== 'statement') return;
  if (entry.speaker === 'system' || entry.speaker === 'moderator' || entry.speaker === 'user') return;
  const poverPov = POVER_INFO[entry.speaker as Exclude<SpeakerId, 'user'>]?.pov as CampOrigin | undefined;
  if (!poverPov) return;
  const result = disambiguateTerms(entry.content, poverPov, vocabularyTerms.colloquial);
  if (result.terms.length === 0) return;
  entry.metadata = entry.metadata ?? {};
  entry.metadata.vocabulary_resolutions = result.terms
    .filter(t => !t.ambiguous)
    .map(t => ({ colloquial: t.bare, canonical: t.canonical, confidence: t.confidence, offset: t.offset }));
  if (result.ambiguousCount > 0) {
    entry.metadata.vocabulary_ambiguities = result.terms
      .filter(t => t.ambiguous)
      .map(t => ({ colloquial: t.bare, offset: t.offset }));
  }
}

// t/3958: kept out of createDebate's own body so it doesn't push that method past the
// ESLint complexity-budget baseline (t/3821). Returns a spreadable fragment, not a bare
// value — `seat_tags: undefined` would still leave the KEY present on the session object
// (JSON.stringify drops it, but in-memory `'seat_tags' in session` would be true); spreading
// `{}` keeps the key genuinely absent when every seat is untagged (p/521#34, Rosetta Stone).
function normalizeSeatTags(options?: { seatTags?: Partial<Record<SpeakerId, SeatTag>> }): { seat_tags?: Partial<Record<SpeakerId, SeatTag>> } {
  const t = options?.seatTags;
  return t && Object.keys(t).length > 0 ? { seat_tags: t } : {};
}

// t/4120: the view setup BOTH load paths need once a session is active. loadDebateFromData (the
// community popout) used to skip it, so Analysis → Terms showed raw sense IDs (no dictionary), the
// analysis views ran with the previous debate's prompt config, and the diagnostics popout showed stale
// state. Deliberately excludes loadDebate's write-side setup (setActiveDebateId, setDebateTemperature):
// a read-only community view must not change the user's active debate or backend temperature.
function applyLoadedSessionSetup(get: SessionGet, set: SessionSet, session: DebateSession, caller: string): void {
  const id = session.id;
  if (!get().vocabularyTerms) {
    api.loadDictionary().then(dict => {
      if (dict.standardized.length > 0 && get().activeDebateId === id) {
        set({ vocabularyTerms: { standardized: dict.standardized as StandardizedTerm[], colloquial: dict.colloquial as ColloquialTerm[] } });
      }
    }).catch((err: unknown) => {
      getGlobalRecorder()?.record({ type: 'system.error', debate_id: id, component: 'debate-store', level: 'warn', message: `Dictionary load failed (${caller}, non-critical)`, error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
    });
  }
  usePromptConfigStore.getState().loadSessionConfig(
    (session as unknown as Record<string, unknown>).prompt_config as Record<string, number | boolean | string> | undefined
  );
  try { api.sendDiagnosticsState({ debate: session, selectedEntry: null }); } catch (e) { getGlobalRecorder()?.record({ type: 'system.error', debate_id: id, component: 'debate-store', level: 'warn', message: `Diagnostics broadcast to popout failed (${caller})`, error: { name: (e as Error).name ?? 'Error', message: String(e), stack: (e as Error).stack } }); }
}

export const createSessionSlice: StateCreator<DebateStore, [], [], SessionSlice> = (set, get) => ({
  sessions: [],
  sessionsLoading: false,
  activeDebateId: null,
  activeDebate: null,
  debateLoading: false,
  _saveInFlight: false,
  _saveDirty: false,
  _loadInFlight: {},
  _lastSyncedVersion: null,
  _lastSyncedSnapshot: null,
  _breakerRetryCount: 0,
  _breakerRetryScheduled: false,

  loadSessions: async () => {
    set({ sessionsLoading: true });
    try {
      const raw = await api.listDebateSessionsMeta();
      set({ sessions: raw as DebateSessionSummary[], sessionsLoading: false });
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'debate-store',
        level: 'error',
        message: 'Failed to load debate sessions',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      set({ sessionsLoading: false });
    }
  },

  createDebate: async (topic, povers, userIsPover, sourceType = 'topic', sourceRef = '', sourceContent = '', debateModel, protocolId, debateTemperature, debateAudience, options) => {
    try {
      const quota = await api.getDebateQuotaStatus();
      if (!quota.allowed) {
        const msg = `You've reached the debate limit (${quota.current}/${quota.limit}). Delete existing debates to start a new one.`;
        set({ debateError: msg });
        throw new Error(msg);
      }
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'debate-store', level: 'warn', message: 'Quota pre-check failed — proceeding (save-time check is safety net)', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
    }
    resetDoctrinalAnchoringCache();
    resetNeutralMapping();
    resetSignalHistory();
    resetGapInjectionCount();
    const id = generateId();
    const now = nowISO();
    const title = options?.title?.trim() || (topic.length > 60 ? topic.slice(0, 57) + '...' : topic);
    const runId = generateId();
    const effectiveModel = debateModel || useTaxonomyStore.getState().geminiModel;
    const session: DebateSession = {
      id,
      run_id: runId,
      title,
      created_at: now,
      updated_at: now,
      app_version: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : undefined,
      audience: debateAudience ?? get().audience,
      phase: 'setup',
      topic: {
        original: topic,
        refined: null,
        final: topic,
        background: options?.background || undefined,
      },
      source_type: sourceType,
      source_ref: sourceRef,
      source_content: sourceContent,
      active_povers: povers,
      user_is_pover: userIsPover,
      transcript: [],
      context_summaries: [],
      generated_with_prompt_version: 'dolce-phase-1',
      debate_model: effectiveModel,
      evaluator_model: options?.evaluatorModel || undefined,
      speaker_models: options?.speakerModels || undefined,
      stage_models: options?.stageModels ? { ...options.stageModels } as Record<string, string> : undefined,
      model_tier: options?.modelTier || undefined,
      // t/4044: calibration model fingerprint, computed here at creation and never on save.
      ...sessionModelFingerprint(effectiveModel, options),
      protocol_id: protocolId || 'structured',
      // Greatest-hits exclusion toggle (t/1980, parent t/1979; engine rescope t/1438).
      // Store is the single writer for app-created debates (which orchestrate via
      // useDebateStore + in-renderer taxonomyRelevance, never the lib DebateEngine —
      // t/1779); the CLI engine writes it for CLI-created sessions. Persisted here so
      // it round-trips via save/load; absent on old debates ⇒ readers coalesce to false.
      exclude_greatest_hits: options?.excludeGreatestHits ?? false,
      // h3 opening narrative voicing (experiment). Absent ⇒ off.
      ...(options?.narrativeVoicing ? { narrative_voicing_enabled: true } : {}),
      // Per-seat POV tag (t/3958). Threaded through unchanged — buildDebateOptions already
      // normalizes {} to undefined, but coalesce again here so no caller can regress it.
      ...normalizeSeatTags(options),
      debate_temperature: debateTemperature ?? undefined,
      adaptive_staging: options?.useAdaptiveStaging
        ? { enabled: true, pacing: (options.pacing as 'tight' | 'moderate' | 'thorough') ?? 'moderate', phase_bounds_override: options.phaseBoundsOverride, step_mode: options.stepMode || undefined }
        : undefined,
      origin: { mode: 'gui' },
    };
    await api.saveDebateSession(session, 'createDebate');
    api.trackEvent('debate_start', 'debate', { topic: session.title, protocol: protocolId || 'structured' });
    trackDebateStart(id, session.title, protocolId || 'structured');
    const aiPoversForOrder = AI_POVERS.filter(p => povers.includes(p));
    const shuffledOrder = [...aiPoversForOrder];
    for (let i = shuffledOrder.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffledOrder[i], shuffledOrder[j]] = [shuffledOrder[j], shuffledOrder[i]];
    }
    set({ activeDebateId: id, activeDebate: session, debateModel: effectiveModel, debateTemperature: debateTemperature ?? null, openingOrder: shuffledOrder });
    setActiveDebateId(id);
    api.setDebateTemperature(debateTemperature ?? null).catch((err: unknown) => { getGlobalRecorder()?.record({ type: 'system.error', component: 'debate-store', level: 'warn', message: 'setDebateTemperature failed (non-critical)', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } }); });
    await get().loadSessions();
    getGlobalRecorder()?.setEventContext({ debate_id: id, run_id: runId });
    getGlobalRecorder()?.record({ type: 'lifecycle', component: 'debate-store', level: 'info', debate_id: id, run_id: runId, message: 'Debate created', data: { topic: title, povers, protocol: protocolId, model: effectiveModel } });
    getGlobalRecorder()?.record({ type: 'debate.phase', component: 'debate-store', level: 'info', debate_id: id, run_id: runId, message: 'debate.start', data: { phase: 'setup', topic: title, povers, protocol: protocolId, model: effectiveModel, audience: session.audience, source_type: sourceType, source_ref: sourceRef } });
    return id;
  },

  createSituationDebate: async (ccNodeId: string, config) => {
    const taxState = useTaxonomyStore.getState();
    const ccNode = taxState.situations?.nodes.find(n => n.id === ccNodeId);
    if (!ccNode) throw new Error(`Situation node ${ccNodeId} not found`);

    const linkedNodeDescriptions: string[] = [];
    // New debate context: a superseded link is given to the model as its survivor (t/4355), once.
    const seenLinked = new Set<string>();
    for (const linkedId of ccNode.linked_nodes) {
      const node = resolveNode(taxState, linkedId);
      if (node && !seenLinked.has(node.id)) {
        seenLinked.add(node.id);
        linkedNodeDescriptions.push(`[${node.id}] ${node.label}: ${node.description}`);
      }
    }

    const conflictSummaries: string[] = [];
    for (const conflictId of ccNode.conflict_ids) {
      const conflict = taxState.conflicts.find(c => c.claim_id === conflictId);
      if (conflict) {
        const stances = conflict.instances.map(i => `${i.doc_id}: ${i.stance}`).join('; ');
        conflictSummaries.push(`[${conflict.claim_id}] ${conflict.claim_label} — ${conflict.description} (${stances})`);
      }
    }

    const attrs = ccNode.graph_attributes as Record<string, unknown> | undefined;
    const sourceContent = formatSituationDebateContext({
      id: ccNode.id,
      label: ccNode.label,
      description: ccNode.description,
      interpretations: {
        accelerationist: interpretationText(ccNode.interpretations.accelerationist),
        safetyist: interpretationText(ccNode.interpretations.safetyist),
        skeptic: interpretationText(ccNode.interpretations.skeptic),
      },
      assumes: attrs?.assumes as string[] | undefined,
      steelmanVulnerability: attrs?.steelman_vulnerability as string | undefined,
      possibleFallacies: attrs?.possible_fallacies as { fallacy: string; confidence: string; explanation: string }[] | undefined,
      linkedNodeDescriptions,
      conflictSummaries,
    });

    // Best-effort: synthesize a contestable proposition as the topic. Any failure — thrown
    // error, unparseable response, or an empty/missing proposition — falls back to the
    // situation label with a WARN (Fallback-Path Logging, root AGENTS.md); synthesis never
    // blocks debate creation.
    let proposition: string | undefined;
    try {
      const prompt = situationTopicSynthesisPrompt({
        label: ccNode.label,
        description: ccNode.description,
        interpretations: ccNode.interpretations,
        disagreementType: ccNode.disagreement_type,
        assumes: attrs?.assumes as string[] | undefined,
        conflictSummaries,
      }, get().audience);
      const model = useTaxonomyStore.getState().geminiModel;
      const { text } = await api.generateText(prompt, model);
      const parsed = parseAIJson<SituationTopicSynthesisResult>(text);
      if (parsed?.proposition && parsed.proposition.trim().length > 0) {
        proposition = parsed.proposition.trim();
      } else {
        getGlobalRecorder()?.record({
          type: 'system.error',
          component: 'debate-store',
          level: 'warn',
          message: 'Situation topic synthesis failed — falling back to situation label',
          error: { name: 'SituationTopicSynthesisFallback', message: 'empty or malformed synthesis response', stack: undefined },
        });
      }
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'debate-store',
        level: 'warn',
        message: 'Situation topic synthesis failed — falling back to situation label',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
    }

    const topic = proposition ?? ccNode.label;
    const allPovers = [...AI_POVERS] as SpeakerId[];

    const id = await get().createDebate(
      topic, allPovers, false, 'situations', ccNodeId, sourceContent,
      config?.effectiveModel, config?.protocolId, config?.temperature, config?.audience,
      { title: ccNode.label, useAdaptiveStaging: config?.useAdaptiveStaging, pacing: config?.pacing, phaseBoundsOverride: config?.phaseBoundsOverride },
    );
    await get().loadDebate(id);
    await enterClarificationOrBegin(get);
    await get().saveDebate('createSituationDebate');
    return id;
  },

  createConflictDebate: async (claimId: string) => {
    const taxState = useTaxonomyStore.getState();
    const conflict = taxState.conflicts.find(c => c.claim_id === claimId);
    if (!conflict) throw new Error(`Conflict ${claimId} not found`);

    const lines: string[] = [
      `=== CONFLICT: ${conflict.claim_id} ===`,
      `Claim: ${conflict.claim_label}`,
      `Description: ${conflict.description}`,
      `Status: ${conflict.status}`,
    ];

    if (conflict.instances.length > 0) {
      lines.push('', '=== DOCUMENTED INSTANCES ===');
      for (const inst of conflict.instances) {
        lines.push(`- [${inst.doc_id}] (${inst.stance}): ${inst.assertion}`);
      }
    }

    if (conflict.linked_taxonomy_nodes.length > 0) {
      lines.push('', '=== LINKED TAXONOMY NODES ===');
      for (const linkedId of conflict.linked_taxonomy_nodes) {
        for (const pov of POV_KEYS) {
          const file = taxState[pov];
          const node = file?.nodes.find(n => n.id === linkedId);
          if (node) {
            lines.push(`[${node.id}] ${node.label}: ${node.description}`);
            break;
          }
        }
        const sitNode = taxState.situations?.nodes.find(n => n.id === linkedId);
        if (sitNode) {
          lines.push(`[${sitNode.id}] ${sitNode.label}: ${sitNode.description}`);
        }
      }
    }

    if (conflict.human_notes.length > 0) {
      lines.push('', '=== HUMAN NOTES ===');
      for (const note of conflict.human_notes) {
        lines.push(`- ${note.author} (${note.date}): ${note.note}`);
      }
    }

    const sourceContent = lines.join('\n');
    const topic = `Conflict: ${conflict.claim_label}`;
    const allPovers = [...AI_POVERS] as SpeakerId[];

    const id = await get().createDebate(topic, allPovers, false, 'topic', claimId, sourceContent);
    await enterClarificationOrBegin(get);
    await get().saveDebate('createConflictDebate');
    return id;
  },

  loadDebate: async (id) => {
    // t/2326: coalesce concurrent loads of the same debate id to a single in-flight
    // request. On debate-window open several hooks mount and each fires loadDebate;
    // without this, the 2nd/3rd load resolves with a now-stale disk snapshot and
    // re-applies it over interrupted-turn recovery, regressing phase/transcript
    // (incident d1c7f7b6). Sharing one promise means the IPC fires — and the snapshot
    // applies — exactly once. Mirrors the save-coalescing (_saveInFlight) below.
    const existing = get()._loadInFlight[id];
    if (existing !== undefined) {
      getGlobalRecorder()?.record({ type: 'state.load-coalesced', component: 'debate-store', level: 'info', debate_id: id, message: 'Load coalesced — sharing in-flight request' });
      return existing;
    }
    const runLoad = async (): Promise<void> => {
      resetDoctrinalAnchoringCache();
      resetSignalHistory();
      resetGapInjectionCount();
      resetNeutralMapping();
      set({ debateLoading: true, debateError: null, debateWarnings: [], newsReport: null, newsReportLoading: false, newsReportError: null });
      try {
        const raw = await api.loadDebateSession(id);
        const session = raw as DebateSession;
        session.active_povers = normalizeActivePovers(session.active_povers);
        for (const entry of session.transcript) {
          entry.speaker = migrateSpeakerId(entry.speaker) as SpeakerId;
        }
        if (session.opening_order) {
          session.opening_order = session.opening_order.map(s => migrateSpeakerId(s)) as typeof session.opening_order;
        }
        if (session.argument_network?.nodes) {
          for (const node of session.argument_network.nodes) {
            node.speaker = migrateSpeakerId(node.speaker) as typeof node.speaker;
          }
        }

        for (const entry of session.transcript) {
          if (entry.type === 'concluding' && entry.metadata?.synthesis) {
            const synthesis = entry.metadata.synthesis as { areas_of_disagreement?: { bdi_layer?: string }[] };
            if (Array.isArray(synthesis.areas_of_disagreement)) {
              for (const d of synthesis.areas_of_disagreement) {
                if (d.bdi_layer) {
                  d.bdi_layer = normalizeBdiLayer(d.bdi_layer as Parameters<typeof normalizeBdiLayer>[0]);
                }
              }
            }
          }
        }
        // t/2326 load-guard: if the in-memory state is already AHEAD of this loaded
        // snapshot (later phase or longer transcript), refuse to apply it — a stale
        // disk read must not clobber interrupted-turn recovery or live generation.
        // Load-side analog of the t/194 state-guard; shares isStateAhead so the two
        // stay consistent. Coalescing kills the concurrent-burst case; this also
        // covers a single load that resolves after in-memory advanced.
        const inMemory = get().activeDebate;
        if (inMemory && inMemory.id === id && isStateAhead(inMemory, session)) {
          getGlobalRecorder()?.record({ type: 'state.load-guard', component: 'debate-store', level: 'warn', debate_id: id, message: 'Load skipped — in-memory state is ahead of loaded snapshot', data: { current_phase: inMemory.phase, loaded_phase: session.phase, current_transcript: inMemory.transcript.length, loaded_transcript: session.transcript.length } });
          set({ debateLoading: false });
          return;
        }
        // t/4044 (SO e/281#2 condition 1): a session saved before per-turn tracking can't be promoted.
        Object.assign(session, latchUnobservedHistory(session));
        const runId = generateId();
        session.run_id = runId;
        set({ activeDebateId: id, activeDebate: session, debateLoading: false, debateModel: session.debate_model || null, debateTemperature: session.debate_temperature ?? null, audience: session.audience ?? 'policymakers', openingOrder: session.opening_order ?? [], selectedDiagEntry: null, _lastSyncedVersion: session._saveVersion ?? 0, _lastSyncedSnapshot: structuredClone(session) });
        setActiveDebateId(id);
        setGapInjectionCount(session.gap_injections?.length ?? 0);
        applyLoadedSessionSetup(get, set, session, 'loadDebate');
        api.setDebateTemperature(session.debate_temperature ?? null).catch((err: unknown) => { getGlobalRecorder()?.record({ type: 'system.error', component: 'debate-store', level: 'warn', message: 'setDebateTemperature failed (non-critical)', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } }); });
        getGlobalRecorder()?.setEventContext({ debate_id: id, run_id: runId });
        getGlobalRecorder()?.record({ type: 'state.load', component: 'debate-store', level: 'info', debate_id: id, run_id: runId, message: 'Debate loaded', data: { phase: session.phase, transcript_length: session.transcript.length, an_nodes: (session as unknown as Record<string, unknown>).argument_network ? ((session as unknown as Record<string, unknown>).argument_network as { nodes?: unknown[] }).nodes?.length ?? 0 : 0 } });
        getGlobalRecorder()?.record({ type: 'debate.phase', component: 'debate-store', level: 'info', debate_id: id, run_id: runId, message: 'debate.start', data: { phase: session.phase, topic: session.topic.final, povers: session.active_povers, protocol: session.protocol_id, model: session.debate_model, transcript_length: session.transcript.length, resumed: true } });

        if (session.interrupted_turn) {
          const resumeSpeaker = session.interrupted_turn.speaker as SpeakerId;
          const speakerLabel = POVER_INFO[session.interrupted_turn.speaker as Exclude<SpeakerId, 'user'>]?.label ?? session.interrupted_turn.speaker;
          getGlobalRecorder()?.record({ type: 'lifecycle', component: 'debate-store', level: 'info', debate_id: id, message: 'Interrupted turn detected on load', data: session.interrupted_turn });
          get().addTranscriptEntry({
            type: 'system',
            speaker: 'system',
            content: `[Recovered] ${speakerLabel}'s turn was interrupted when the window closed (round ${session.interrupted_turn.round}, ${session.interrupted_turn.phase} phase). Auto-resuming…`,
            taxonomy_refs: [],
            metadata: { interrupted_turn_recovery: true, ...session.interrupted_turn },
          });
          const fresh = get().activeDebate;
          if (fresh) {
            const { interrupted_turn: _, ...cleaned } = fresh;
            set({ activeDebate: cleaned as DebateSession });
          }
          void get().saveDebate('loadDebate:interrupted_turn_recovery');
          setTimeout(() => {
            const s = get();
            if (s.activeDebate?.protocol_id === 'socratic') {
              // Socratic is user-driven (ask/probe/summarize) with a single AI
              // debater; crossRespond requires >=2 AI debaters and would bail with a
              // "Need at least 2 AI debaters" error toast. The interrupted_turn field
              // is already cleared above, so there is nothing to auto-resume — the
              // user simply drives the next turn. Sibling of t/2536 (Q5). (t/2539)
              getGlobalRecorder()?.record({ type: 'lifecycle', component: 'debate-store', level: 'info', debate_id: id, message: 'Interrupted-turn auto-resume skipped for socratic protocol' });
            } else if (s.activeDebateId === id && !s.debateGenerating) {
              getGlobalRecorder()?.record({ type: 'lifecycle', component: 'debate-store', level: 'info', debate_id: id, message: 'Auto-resuming after interrupted turn recovery' });
              // Engage the generating indicator up front so the Continue button is
              // disabled during crossRespond's ramp-up (edge load + moderator
              // selection); crossRespond otherwise sets debateGenerating too late,
              // leaving Continue live long enough for a click to double-fire the
              // resumed round (t/1656). crossRespond owns the flag from here and
              // clears it on completion/error.
              set({ debateGenerating: resumeSpeaker, debateActivity: `${speakerLabel} is resuming…`, debateStepStartedAt: Date.now() });
              void s.crossRespond().finally(() => {
                // Safety net: if crossRespond bailed before taking ownership of the
                // indicator (no activeDebate, driver-claim denied, <2 debaters), our
                // sentinel is still set — clear it so the indicator isn't stuck on.
                if (get().debateGenerating === resumeSpeaker) {
                  set({ debateGenerating: null, debateActivity: null });
                }
              });
            } else {
              getGlobalRecorder()?.record({ type: 'lifecycle', component: 'debate-store', level: 'info', debate_id: id, message: 'Loop not auto-resumed', data: { reason: s.activeDebateId !== id ? 'debate_switched' : 'already_generating', activeDebateId: s.activeDebateId, debateGenerating: s.debateGenerating } });
            }
          }, 100);
        }
      } catch (err) {
        getGlobalRecorder()?.record({ type: 'state.error', component: 'debate-store', level: 'error', debate_id: id, message: 'Failed to load debate', error: { name: 'LoadError', message: String(err), stack: (err as Error).stack } });
        set({ debateLoading: false, debateError: mapErrorToUserMessage(err) });
      }
    };
    const promise = runLoad();
    set((state) => ({ _loadInFlight: { ...state._loadInFlight, [id]: promise } }));
    try {
      await promise;
    } finally {
      set((state) => {
        const next = { ...state._loadInFlight };
        delete next[id];
        return { _loadInFlight: next };
      });
    }
  },

  loadDebateFromData: (raw, opts) => {
    resetDoctrinalAnchoringCache();
    resetSignalHistory();
    resetGapInjectionCount();
    resetNeutralMapping();
    const session = raw as DebateSession;
    session.active_povers = normalizeActivePovers(session.active_povers);
    for (const entry of session.transcript) {
      entry.speaker = migrateSpeakerId(entry.speaker) as SpeakerId;
    }
    if (session.opening_order) {
      session.opening_order = session.opening_order.map(s => migrateSpeakerId(s)) as typeof session.opening_order;
    }
    if (session.argument_network?.nodes) {
      for (const node of session.argument_network.nodes) {
        node.speaker = migrateSpeakerId(node.speaker) as typeof node.speaker;
      }
    }
    for (const entry of session.transcript) {
      if (entry.type === 'concluding' && entry.metadata?.synthesis) {
        const synthesis = entry.metadata.synthesis as { areas_of_disagreement?: { bdi_layer?: string }[] };
        if (Array.isArray(synthesis.areas_of_disagreement)) {
          for (const d of synthesis.areas_of_disagreement) {
            if (d.bdi_layer) {
              d.bdi_layer = normalizeBdiLayer(d.bdi_layer as Parameters<typeof normalizeBdiLayer>[0]);
            }
          }
        }
      }
    }
    Object.assign(session, latchUnobservedHistory(session)); // t/4044 condition 1, as in loadDebate
    const runId = generateId();
    session.run_id = runId;
    set({
      activeDebateId: session.id,
      activeDebate: session,
      debateLoading: false,
      debateError: null,
      debateWarnings: [],
      debateModel: session.debate_model || null,
      debateTemperature: session.debate_temperature ?? null,
      audience: session.audience ?? 'policymakers',
      openingOrder: session.opening_order ?? [],
      selectedDiagEntry: null,
      // Fail-safe default (t/2399 TL#6.3): loadDebateFromData is the raw-data load entry, and its
      // only caller today is the community popout (readOnly:true). A future caller that omits
      // readOnly is loading data of unknown provenance — default to read-only so it can never
      // silently become editable + auto-save over foreign/community content (store.ts autosave
      // guard keys off communityReadOnly). Personal loads go through loadDebate, not this path.
      communityReadOnly: opts?.readOnly ?? true,
      _lastSyncedVersion: session._saveVersion ?? 0,
      _lastSyncedSnapshot: structuredClone(session),
    });
    setGapInjectionCount(session.gap_injections?.length ?? 0);
    applyLoadedSessionSetup(get, set, session, 'loadDebateFromData');
    getGlobalRecorder()?.setEventContext({ debate_id: session.id, run_id: runId });
    getGlobalRecorder()?.record({ type: 'state.load', component: 'debate-store', level: 'info', debate_id: session.id, run_id: runId, message: 'Debate loaded from data', data: { phase: session.phase, transcript_length: session.transcript.length, readOnly: opts?.readOnly ?? true } });
  },

  deleteDebate: async (id) => {
    try {
      await api.deleteDebateSession(id);
      const { activeDebateId } = get();
      if (activeDebateId === id) {
        set({ activeDebateId: null, activeDebate: null, debateModel: null });
        setActiveDebateId(null);
        getGlobalRecorder()?.setEventContext({ debate_id: undefined, run_id: undefined, phase: undefined, round: undefined, turn_index: undefined, speaker: undefined });
      }
      await get().loadSessions();
      getGlobalRecorder()?.record({ type: 'lifecycle', component: 'debate-store', level: 'info', debate_id: id, message: 'Debate deleted' });
      getGlobalRecorder()?.record({ type: 'debate.lifecycle', component: 'debate-store', level: 'info', debate_id: id, message: 'debate.ended', data: { reason: 'deleted' } });
      trackDebateAbandon(id, 'deleted');
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        debate_id: id,
        component: 'debate-store',
        level: 'error',
        message: 'Failed to delete debate',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      set({ debateError: mapErrorToUserMessage(err) });
    }
  },

  renameDebate: async (id, newTitle) => {
    try {
      const raw = await api.loadDebateSession(id);
      const session = raw as DebateSession;
      session.active_povers = normalizeActivePovers(session.active_povers);
      session.title = newTitle;
      session.updated_at = nowISO();
      await api.saveDebateSession(session, 'renameDebate');
      if (get().activeDebateId === id) {
        set({ activeDebate: session });
      }
      await get().loadSessions();
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        debate_id: id,
        component: 'debate-store',
        level: 'error',
        message: 'Failed to rename debate',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      set({ debateError: mapErrorToUserMessage(err) });
    }
  },

  closeDebate: () => {
    const closingId = get().activeDebateId;
    set({ activeDebateId: null, activeDebate: null, debateError: null, debateWarnings: [], debateGenerating: null, debateModel: null, debateTemperature: null, vocabularyTerms: null });
    setActiveDebateId(null);
    api.setDebateTemperature(null).catch((err: unknown) => { getGlobalRecorder()?.record({ type: 'system.error', component: 'debate-store', level: 'warn', message: 'setDebateTemperature failed (non-critical)', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } }); });
    usePromptConfigStore.getState().resetSession();
    getGlobalRecorder()?.setEventContext({ debate_id: undefined, run_id: undefined, phase: undefined, round: undefined, turn_index: undefined, speaker: undefined });
    if (closingId) {
      getGlobalRecorder()?.record({ type: 'lifecycle', component: 'debate-store', level: 'info', debate_id: closingId, message: 'Debate closed' });
      getGlobalRecorder()?.record({ type: 'debate.lifecycle', component: 'debate-store', level: 'info', debate_id: closingId, message: 'debate.ended', data: { reason: 'closed' } });
      trackDebateAbandon(closingId, 'closed');
    }
  },

  addTranscriptEntry: (entry) => {
    const { activeDebate, vocabularyTerms } = get();
    const entryId = generateId();
    if (!activeDebate) return entryId;

    if (entry.type === 'opening' && entry.speaker !== 'system') {
      const existing = activeDebate.transcript.find(
        e => e.type === 'opening' && e.speaker === entry.speaker,
      );
      if (existing) {
        getGlobalRecorder()?.record({
          type: 'system.error', component: 'debate-store', level: 'warn',
          debate_id: activeDebate.id,
          message: `Duplicate opening blocked for ${entry.speaker} — already has opening ${existing.id}`,
        });
        return existing.id;
      }
    }

    const full: TranscriptEntry = {
      ...entry,
      id: entryId,
      timestamp: nowISO(),
    };

    applyVocabularyResolutions(full, vocabularyTerms);

    const updated: DebateSession = {
      ...activeDebate,
      updated_at: nowISO(),
      transcript: [...activeDebate.transcript, full],
    };
    set({ activeDebate: updated });

    if (full.type === 'opening' && full.speaker !== 'system') {
      const openingCount = updated.transcript.filter(e => e.type === 'opening' && e.speaker === full.speaker).length;
      getGlobalRecorder()?.record({
        type: 'debate.opening_added', component: 'debate-store', level: 'info',
        debate_id: activeDebate.id,
        message: `Opening added for ${full.speaker}`,
        data: { speaker: full.speaker, entryId, openingCount },
      });
    }

    return entryId;
  },

  // Slot-first opening lifecycle (t/2907). Insert a per-speaker opening slot when
  // generation begins, or return the existing slot's id if one is already present —
  // so retries mutate one card rather than appending panels. Idempotent by
  // (type:'opening', speaker); mirrors the addTranscriptEntry duplicate-opening guard,
  // which stays as the safety net (now ~unreachable since this is the primary path).
  upsertTranscriptEntry: (entry) => {
    const { activeDebate } = get();
    if (!activeDebate) return generateId();
    if (entry.type === 'opening' && entry.speaker !== 'system') {
      const existing = activeDebate.transcript.find(
        e => e.type === 'opening' && e.speaker === entry.speaker,
      );
      if (existing) return existing.id;
    }
    return get().addTranscriptEntry(entry);
  },

  // Shallow-merge a patch into the entry with `id` (t/2907) — the in-place slot
  // mutation for status/content/errorMessage transitions. No-op if the id is gone
  // (e.g. the debate was switched mid-generation).
  updateTranscriptEntry: (id, patch) => {
    const { activeDebate, vocabularyTerms } = get();
    if (!activeDebate) return;
    let found = false;
    const transcript = activeDebate.transcript.map(e => {
      if (e.id !== id) return e;
      found = true;
      const merged: TranscriptEntry = { ...e, ...patch };
      // Parity with addTranscriptEntry: when this update supplies the prose content
      // (the slot-completion path, t/2907), run the same opening/statement vocabulary
      // enrichment so slot-first openings don't lose vocabulary_resolutions.
      if (patch.content !== undefined && merged.content) applyVocabularyResolutions(merged, vocabularyTerms);
      return merged;
    });
    if (!found) return;
    set({ activeDebate: { ...activeDebate, transcript, updated_at: nowISO() } });
  },

  deleteTranscriptEntries: async (entryIds) => {
    const { activeDebate, saveDebate } = get();
    if (!activeDebate) return;
    const idsToRemove = new Set(entryIds);
    const filtered = activeDebate.transcript.filter(e => !idsToRemove.has(e.id));

    let diagnostics = activeDebate.diagnostics;
    if (diagnostics) {
      const cleanedEntries = { ...diagnostics.entries };
      for (const id of idsToRemove) {
        delete cleanedEntries[id];
      }
      diagnostics = { ...diagnostics, entries: cleanedEntries };
    }

    let an = activeDebate.argument_network;
    if (an) {
      const removedNodeIds = new Set<string>();
      const cleanedNodes = an.nodes.filter(n => {
        if (n.source_entry_id && idsToRemove.has(n.source_entry_id)) {
          removedNodeIds.add(n.id);
          return false;
        }
        return true;
      });
      const cleanedEdges = an.edges.filter(e =>
        !removedNodeIds.has(e.source) && !removedNodeIds.has(e.target),
      );
      an = { nodes: cleanedNodes, edges: cleanedEdges };
    }

    const freshDebate = get().activeDebate ?? activeDebate;
    const updated: DebateSession = {
      ...freshDebate,
      updated_at: nowISO(),
      transcript: filtered,
      ...(diagnostics ? { diagnostics } : {}),
      ...(an ? { argument_network: an } : {}),
    };
    set({ activeDebate: updated });
    await saveDebate('deleteTranscriptEntries');
  },

  togglePover: async (poverId) => {
    const { activeDebate, saveDebate } = get();
    if (!activeDebate) return;
    const current = activeDebate.active_povers;
    let updated: SpeakerId[];
    if (current.includes(poverId)) {
      updated = current.filter(p => p !== poverId);
      if (updated.filter(p => p !== 'user').length < 1) return;
    } else {
      updated = [...current, poverId];
    }
    const newDebate: DebateSession = {
      ...activeDebate,
      active_povers: updated,
      updated_at: nowISO(),
    };
    set({ activeDebate: newDebate });
    await saveDebate('togglePover');
  },

  updatePhase: (phase) => {
    const { activeDebate } = get();
    if (!activeDebate) return;
    set({ activeDebate: { ...activeDebate, phase, updated_at: nowISO() } });
    void get().saveDebate('updatePhase');
  },

  updateTopic: (topic) => {
    const { activeDebate } = get();
    if (!activeDebate) return;
    set({
      activeDebate: {
        ...activeDebate,
        topic: { ...activeDebate.topic, ...topic },
        updated_at: nowISO(),
      },
    });
    void get().saveDebate('updateTopic');
  },

  toggleStepMode: async () => {
    const { activeDebate, saveDebate } = get();
    if (!activeDebate?.adaptive_staging) return;
    const newMode = !activeDebate.adaptive_staging.step_mode;
    const newDebate = {
      ...activeDebate,
      adaptive_staging: { ...activeDebate.adaptive_staging, step_mode: newMode },
      updated_at: nowISO(),
    };
    set({ activeDebate: newDebate });
    await saveDebate('toggleStepMode');
  },

  setDebatePhase: async (phase) => {
    const { activeDebate, addTranscriptEntry, saveDebate } = get();
    if (!activeDebate?.adaptive_staging?.phase_state) return;
    const prev = activeDebate.adaptive_staging.phase_state.current_phase;
    if (prev === phase) return;
    const newPhaseState = { ...activeDebate.adaptive_staging.phase_state, current_phase: phase, rounds_in_phase: 0 };
    // `current_phase`/`rounds_in_phase` below are sibling copies of the same fields inside
    // `phase_state` above. getCurrentPhase(session) (lib/debate/phaseTransitions.ts) is the
    // authoritative read path and only looks at `phase_state`; these siblings are written
    // here but read nowhere (t/3761#8 condition 4) — forensics, not a second source of truth.
    const asObj = { ...activeDebate.adaptive_staging, phase_state: newPhaseState, current_phase: phase, rounds_in_phase: 0 };
    const newDebate = { ...activeDebate, adaptive_staging: asObj, updated_at: nowISO() };
    set({ activeDebate: newDebate });
    addTranscriptEntry({
      type: 'system', speaker: 'system',
      content: `[Manual phase change] ${prev} → ${phase}`,
      taxonomy_refs: [],
      metadata: { manual_phase_change: true, from_phase: prev, to_phase: phase },
    });
    await saveDebate('setDebatePhase');
  },

  saveDebate: async (caller: string) => {
    const { activeDebate, _saveInFlight, communityReadOnly } = get();
    if (!activeDebate) return;
    // t/2401: authoritative read-only guard for ALL callers. A read-only community debate
    // must never PUT to the personal endpoint. The store.ts auto-save subscriber has its own
    // guard, but component-level callers (the DebateWorkspace auto-save timer, ClarificationPanel)
    // bypass the subscriber — so the single source of truth lives here in the action.
    if (communityReadOnly) return;

    // t/3917: one writer per running debate. While another window holds this debate's run
    // lease, this window is a viewer whose copy trails the holder's, so its (auto-)save
    // would roll the file back. In the 09-30 dump a pop-out auto-save wrote phase=opening /
    // transcript 3 over the main window's debate / 6. The viewer refreshes from the holder's
    // saves instead.
    const runHolder = getRemoteRunLeaseHolder(activeDebate.id);
    if (runHolder) {
      const userEdit = !isBackgroundSave(caller);
      const key = `${activeDebate.id}:${runHolder.windowId}:${runHolder.startedAt}`;
      if (userEdit || !_viewerSaveSkipLogged.has(key)) {
        _viewerSaveSkipLogged.add(key);
        getGlobalRecorder()?.record({ type: 'state.save', component: 'debate-store', level: 'warn', debate_id: activeDebate.id, message: 'Save skipped — another window holds this debate\'s run lease (viewer)', data: { caller, user_edit: userEdit, holder: { window: runHolder.windowId, caller: runHolder.caller } } });
      }
      if (userEdit) set({ debateError: 'This debate is running in another window, so this change wasn\'t saved. Make it in that window, or after the run finishes.' });
      return;
    }

    if (_saveInFlight) {
      set({ _saveDirty: true });
      getGlobalRecorder()?.record({ type: 'state.save-coalesced', component: 'debate-store', level: 'info', debate_id: activeDebate.id, message: `Save coalesced (in-flight), caller: ${caller}` });
      return;
    }

    set({ _saveInFlight: true });
    try {
      const promptConfig = usePromptConfigStore.getState().exportSessionConfig();
      if (Object.keys(promptConfig).length > 0) {
        (activeDebate as unknown as Record<string, unknown>).prompt_config = promptConfig;
      }

      // Stamp doc_meta (t/1779), rebuild the diagnostics overview, and assemble
      // save diagnostics — see the phase helpers above. stampDocMeta only yields a
      // promise when there are cited docs; awaiting conditionally preserves the
      // original no-await-when-idle timing (coalescing / t/1637 snapshot invariants).
      const docMetaWork = stampDocMeta(activeDebate);
      if (docMetaWork) await docMetaWork;
      rebuildOverviewDiagnostics(activeDebate);
      const saveDiag = buildSaveDiag(activeDebate, caller);
      // Save-path selection + post-save bookkeeping (t/1637) — see persistDebateToServer.
      await persistDebateToServer(activeDebate, saveDiag, get, set);
      // Viewers of this run refresh from it; also a heartbeat (t/3917). No-op unless we hold the lease.
      notifyDebateSaved(activeDebate.id);
      // Save reached the server: clear any breaker-retry degradation left by prior
      // blocked attempts (t/3073). Only touch debateError when we were actually retrying,
      // so a successful save never clobbers an unrelated error.
      if (get()._breakerRetryCount > 0) {
        set({ _breakerRetryCount: 0, debateError: null });
      }
    } catch (err) {
      const errorCode = (err as Error & { errorCode?: string }).errorCode;
      if (errorCode === 'save_in_progress') {
        set({ _saveDirty: true });
        getGlobalRecorder()?.record({ type: 'state.save-coalesced', component: 'debate-store', level: 'info', debate_id: activeDebate.id, message: 'Server 409 save_in_progress — will retry via coalesced follow-up' });
      } else {
        // Distinguish durable-save loss, breaker-blocked (recoverable), and ordinary errors
        // (t/1639, t/3073) so the user is told their debate is at risk — see
        // computeSaveErrorState. record() stays inline here per ADR-003.
        const { isDurableSaveLoss, isBreakerBlocked, atRiskTurns, debateError } = computeSaveErrorState(err, activeDebate);
        if (isBreakerBlocked) {
          // Save never reached the server (save circuit OPEN). Flag degraded + queue a
          // cooldown retry — never a silent drop (t/3073).
          handleBreakerBlockedSave(activeDebate, caller, atRiskTurns, debateError, get, set);
        } else {
          getGlobalRecorder()?.record({ type: 'state.error', component: 'debate-store', level: 'error', debate_id: activeDebate.id, message: isDurableSaveLoss ? 'Durable debate save failed — recovery copy preserved' : 'Failed to save debate', error: { name: isDurableSaveLoss ? 'DurableSaveError' : 'SaveError', message: String(err), stack: (err as Error).stack }, data: { caller, payload_bytes: JSON.stringify(activeDebate).length, turn_count: activeDebate.transcript.length, save_degraded: isDurableSaveLoss, at_risk_turns: atRiskTurns } });
          set({ debateError });
        }
      }
    } finally {
      const wasDirty = get()._saveDirty;
      set({ _saveInFlight: false, _saveDirty: false });
      if (wasDirty) {
        void get().saveDebate('coalesced-followup');
      }
    }
  },
});
