// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Shared 3-phase synthesis pipeline: Extract → Map → Evaluate.
 * Decoupled from DebateEngine — usable from both CLI engine and GUI store.
 */

import type { DebateAudience, TrackedCrux } from './types.js';
import {
  synthExtractPrompt,
  synthMapPrompt,
  synthEvaluatePrompt,
} from './prompts.js';
import { formatCruxResolutionContext } from './cruxResolution.js';
import { parseJsonRobust, stripCodeFences, extractArraysFromPartialJson } from './helpers.js';
import type { UsageCallDeps } from '../ai-client/usageRegistry.js';
import { callByUsage } from '../ai-client/usageRegistry.js';

// ── Types ────────────────────────────────────────────────

export interface SynthesisInput {
  topic: string;
  transcript: string;
  audience?: DebateAudience;
  cruxTracker?: TrackedCrux[];
  /** Policy lines like "pol-001: Ban autonomous weapons". Max 10. */
  policyLines?: string[];
  /** Whether the debate was sourced from a document/URL. */
  hasSourceDoc?: boolean;
}

export type SynthesisGenerateFn = (prompt: string, label: string) => Promise<string>;

export type SynthesisProgressFn = (phase: 1 | 2 | 3, label: string) => void;

export type SynthesisWarnFn = (context: string, problem: string, nextStep: string) => void;

export interface SynthesisPhaseResult {
  /** Merged data from all three phases. */
  data: Record<string, unknown>;
  /** Raw responses keyed by phase for diagnostics. */
  rawResponses: { extract: string; map: string; evaluate: string };
  elapsed_ms: number;
}

export type SynthesisPhaseName = 'extract' | 'map' | 'evaluate';

// ── Phase key scoping ───────────────────────────────────
// Each phase only owns specific keys. Without scoping, fallback parsing
// via extractArraysFromPartialJson returns ALL 8 keys with empty arrays,
// and Object.assign clobbers earlier phases' populated data.
const PHASE_KEYS = {
  extract: ['areas_of_agreement', 'areas_of_disagreement', 'cruxes', 'unresolved_questions'],
  map: ['taxonomy_coverage', 'argument_map', 'taxonomy_proposals', 'taxonomy_modifications'],
  evaluate: ['preferences', 'policy_implications', 'topic_resolution'],
} as const;

/**
 * Phase payloads produced by partial-JSON recovery rather than a clean parse.
 * Tracked by identity so a clean retry that replaces the payload clears it.
 */
const recoveredPayloads = new WeakSet<object>();

function noteRecoveredPhase(
  degradedPhases: SynthesisPhaseName[],
  mergedPayload: Record<string, unknown>,
  phase: SynthesisPhaseName,
): void {
  if (recoveredPayloads.has(mergedPayload)) degradedPhases.push(phase);
}

/**
 * Stamp the merged synthesis with a machine-readable degraded marker when any
 * phase's merged data came from partial-JSON recovery (t/4929). Consumers
 * persist `data` as `metadata.synthesis`, so the marker lands at
 * `metadata.synthesis.degraded` / `.degraded_phases`. Clean runs carry neither key.
 */
function applyDegradedMarker(data: Record<string, unknown>, degradedPhases: SynthesisPhaseName[]): void {
  if (degradedPhases.length === 0) return;
  data.degraded = true;
  data.degraded_phases = [...degradedPhases];
}

function mergePhaseData(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  phaseKeys: readonly string[],
): void {
  for (const key of phaseKeys) {
    if (key in source) target[key] = source[key];
  }
}

// ── Phase runner ─────────────────────────────────────────

function parsePhaseResponse(
  raw: string,
  phaseName: string,
  warn?: SynthesisWarnFn,
): Record<string, unknown> {
  try {
    return parseJsonRobust(raw) as Record<string, unknown>;
  } catch {
    const fallback = extractArraysFromPartialJson(stripCodeFences(raw));
    if (Object.keys(fallback).length === 0) {
      warn?.(
        `Synthesis ${phaseName} parse`,
        `Both JSON parsers returned empty — ${phaseName.toLowerCase()} data will be incomplete`,
        'Proceeding with partial synthesis',
      );
    } else {
      warn?.(
        `Synthesis ${phaseName} parse`,
        'Primary JSON parse failed, recovered partial data via fallback',
        'Synthesis may be incomplete',
      );
    }
    recoveredPayloads.add(fallback);
    return fallback;
  }
}

/**
 * Run the 3-phase synthesis pipeline: Extract → Map → Evaluate.
 * Pure orchestration — no DebateEngine coupling.
 *
 * @param input - Synthesis context (topic, transcript, audience, etc.)
 * @param generate - LLM call function (prompt, label) → response text
 * @param onProgress - Optional progress callback per phase
 * @param warn - Optional warning callback for parse failures
 * @param checkAborted - Optional abort check (throw to cancel)
 */
export async function runSynthesisPhases(
  input: SynthesisInput,
  generate: SynthesisGenerateFn,
  onProgress?: SynthesisProgressFn,
  warn?: SynthesisWarnFn,
  checkAborted?: () => void,
  maxPhase?: number,
  usageDeps?: UsageCallDeps,
): Promise<SynthesisPhaseResult> {
  const start = Date.now();
  const data: Record<string, unknown> = {};
  const degradedPhases: SynthesisPhaseName[] = [];

  const synthGenerate = usageDeps
    ? async (usageId: string, prompt: string, label: string) =>
        (await callByUsage(usageId, { prompt }, usageDeps)).text
    : async (_usageId: string, prompt: string, label: string) =>
        generate(prompt, label);

  const policyContext = input.policyLines?.length
    ? `\n\n=== POLICY REGISTRY (reference pol-NNN IDs for policy implications) ===\n${input.policyLines.slice(0, 10).join('\n')}`
    : '';

  const cruxContext = (input.cruxTracker?.length ?? 0) > 0
    ? formatCruxResolutionContext(input.cruxTracker!)
    : undefined;

  // Phase 1: Extract core synthesis
  checkAborted?.();
  onProgress?.(1, 'Phase 1/3: Extracting agreements and disagreements');
  const extractRaw = await synthGenerate(
    'synthesis.extract',
    synthExtractPrompt(input.topic, input.transcript, input.audience, cruxContext),
    'Synthesis Phase 1: Extract',
  );
  const extractData = parsePhaseResponse(extractRaw, 'Phase 1', warn);
  if (Object.keys(extractData).length === 0) {
    warn?.('Synthesis Phase 1', 'AI returned empty or unparseable output — synthesis data will be incomplete', 'Proceeding with partial synthesis');
  }
  mergePhaseData(data, extractData, PHASE_KEYS.extract);
  noteRecoveredPhase(degradedPhases, extractData, 'extract');

  if (maxPhase === 1) {
    applyDegradedMarker(data, degradedPhases);
    return {
      data,
      rawResponses: { extract: extractRaw, map: '', evaluate: '' },
      elapsed_ms: Date.now() - start,
    };
  }

  // Phase 2: Build argument map
  checkAborted?.();
  onProgress?.(2, 'Phase 2/3: Building argument map');
  const disagreementsSummary = JSON.stringify(extractData.areas_of_disagreement ?? []);
  const mapRaw = await synthGenerate(
    'synthesis.map',
    synthMapPrompt(input.topic, input.transcript, disagreementsSummary, input.hasSourceDoc ?? false, input.audience),
    'Synthesis Phase 2: Map',
  );
  let mapData = parsePhaseResponse(mapRaw, 'Phase 2', warn);
  if (Object.keys(mapData).length === 0) {
    warn?.('Synthesis Phase 2', 'AI returned empty or unparseable output — argument map will be incomplete', 'Proceeding with partial synthesis');
  }
  const argMapArr = mapData.argument_map;
  if (!Array.isArray(argMapArr) || argMapArr.length === 0) {
    warn?.('Synthesis Phase 2', 'argument_map is empty — retrying with focused extraction', 'One retry attempt');
    checkAborted?.();
    const retryRaw = await synthGenerate(
      'synthesis.map',
      synthMapPrompt(input.topic, input.transcript, disagreementsSummary, input.hasSourceDoc ?? false, input.audience),
      'Synthesis Phase 2: Map (retry)',
    );
    const retryData = parsePhaseResponse(retryRaw, 'Phase 2 retry', warn);
    const retryArr = retryData.argument_map;
    if (Array.isArray(retryArr) && retryArr.length > 0) {
      mapData = retryData;
    } else {
      warn?.('Synthesis Phase 2', 'argument_map still empty after retry — structured synthesis will be incomplete', 'Proceeding without argument map');
    }
  }
  mergePhaseData(data, mapData, PHASE_KEYS.map);
  noteRecoveredPhase(degradedPhases, mapData, 'map');

  if (maxPhase === 2) {
    applyDegradedMarker(data, degradedPhases);
    return {
      data,
      rawResponses: { extract: extractRaw, map: mapRaw, evaluate: '' },
      elapsed_ms: Date.now() - start,
    };
  }

  // Phase 3: Evaluate preferences + policy implications
  checkAborted?.();
  onProgress?.(3, 'Phase 3/3: Evaluating preferences');
  const argMapSummary = JSON.stringify(mapData.argument_map ?? []);
  const evalRaw = await synthGenerate(
    'synthesis.evaluate',
    synthEvaluatePrompt(input.topic, disagreementsSummary, argMapSummary, policyContext, input.audience),
    'Synthesis Phase 3: Evaluate',
  );
  let evalData = parsePhaseResponse(evalRaw, 'Phase 3', warn);
  if (Object.keys(evalData).length === 0) {
    warn?.('Synthesis Phase 3', 'AI returned empty or unparseable output — evaluation data will be incomplete', 'Proceeding with partial synthesis');
  }
  const prefsArr = evalData.preferences;
  if (!Array.isArray(prefsArr) || prefsArr.length === 0) {
    warn?.('Synthesis Phase 3', 'preferences is empty — retrying with focused evaluation', 'One retry attempt');
    checkAborted?.();
    const retryRaw = await synthGenerate(
      'synthesis.evaluate',
      synthEvaluatePrompt(input.topic, disagreementsSummary, argMapSummary, policyContext, input.audience),
      'Synthesis Phase 3: Evaluate (retry)',
    );
    const retryData = parsePhaseResponse(retryRaw, 'Phase 3 retry', warn);
    const retryPrefs = retryData.preferences;
    if (Array.isArray(retryPrefs) && retryPrefs.length > 0) {
      evalData = retryData;
    } else {
      warn?.('Synthesis Phase 3', 'preferences still empty after retry — preference data will be incomplete', 'Proceeding without preferences');
    }
  }
  mergePhaseData(data, evalData, PHASE_KEYS.evaluate);
  noteRecoveredPhase(degradedPhases, evalData, 'evaluate');
  applyDegradedMarker(data, degradedPhases);

  return {
    data,
    rawResponses: { extract: extractRaw, map: mapRaw, evaluate: evalRaw },
    elapsed_ms: Date.now() - start,
  };
}
