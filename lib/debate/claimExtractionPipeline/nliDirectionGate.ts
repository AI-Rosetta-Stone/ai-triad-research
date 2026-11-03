// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// ── V4 NLI direction gate (t/2746, t/2744#10) ────────────

import { spawnSync, type SpawnSyncReturns } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { getGlobalRecorder } from '../../flight-recorder/index.js';
import type { ArgumentNetworkNode } from '../types.js';

function warn(message: string): void {
  getGlobalRecorder()?.record({ type: 'system.error', component: 'nli-direction-gate', level: 'warn', message });
}

/**
 * Build the rich node proposition for NLI input (t/2744#7, TL ruling t/2746).
 * Matches V1 (PS2) format exactly: "label — Core" where Core = description with
 * Encompasses:/Excludes: tails stripped (they name sibling topics, not the asserted
 * proposition). Falls back to label-only when description is empty.
 */
export function buildNliNodeProp(label: string, description: string): string {
  const core = (description ?? '').replace(/\s*(Encompasses|Excludes)\s*:[\s\S]*$/, '').trim();
  return core ? `${label} — ${core}` : label;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Locate scripts/nli_classify.py by walking up from `startDir` to the filesystem root,
 * checking for the script's own presence at each level — never a fixed `../../..` depth
 * (t/4596, 2nd occurrence of the t/1721 class). This is depth-agnostic by construction, so
 * it's correct from source (lib/debate/claimExtractionPipeline), Electron's compiled
 * `dist/main`, and the server's compiled `dist/server` without knowing any of their exact
 * nesting. Returns undefined if the walk reaches the filesystem root without finding it —
 * e.g. a packaged Electron build, which never bundles `scripts/` at all (electron-builder.yml
 * `files` has no entry for it, so this isn't a resolution bug there, just real absence).
 */
export function resolveNliScriptPath(startDir: string): string | undefined {
  let dir = path.resolve(startDir);
  while (dir !== path.dirname(dir)) {
    const candidate = path.join(dir, 'scripts', 'nli_classify.py');
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  return undefined;
}

/**
 * Candidate interpreter names, in priority order (TL ruling t/4596#2, after Diagnostics found
 * the hosted gate ENOENT'ing on a hardcoded `'python'` — the container only has `python3`):
 * an explicit ops override (`NLI_PYTHON_INTERPRETER`) first, then `python3`, then `python`.
 * Never a platform-based guess — a fixed name is exactly the class of bug this ticket fixes.
 */
function resolvePythonCandidates(): string[] {
  const configured = process.env.NLI_PYTHON_INTERPRETER?.trim();
  return configured ? [configured] : ['python3', 'python'];
}

/** Try each interpreter candidate in order, only advancing past one that ENOENTs — any other
 *  outcome (success, or a real failure like bad deps) stops the loop so it isn't masked. */
function spawnNliClassifier(
  scriptPath: string,
  cwd: string,
  batch: NliInput[],
): { proc: SpawnSyncReturns<string>; tried: string[] } {
  const tried: string[] = [];
  let proc: SpawnSyncReturns<string> | undefined;
  for (const interpreter of resolvePythonCandidates()) {
    tried.push(interpreter);
    proc = spawnSync(interpreter, [scriptPath], {
      input: JSON.stringify(batch),
      encoding: 'utf8',
      cwd,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });
    const notFound = (proc.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
    if (!notFound) break;
  }
  return { proc: proc!, tried };
}

/**
 * Resolve the script path to actually use for this call: an explicit ops override
 * (`NLI_CLASSIFY_SCRIPT`) wins — set to a path to point elsewhere, or to an empty string to
 * explicitly disable the gate with a logged reason (t/4596 item 2 — pending the DevOps/CL
 * decision on whether it should run in hosted prod at all). Otherwise, walk the source tree.
 * Not cached at module load: resolution is cheap (a handful of `fs.existsSync` calls against
 * one subprocess spawn) and re-running it per call keeps this testable without import-time
 * filesystem coupling.
 */
function resolveActiveNliScriptPath(): { path: string | undefined; reason?: string } {
  const override = process.env.NLI_CLASSIFY_SCRIPT;
  if (override !== undefined) {
    if (override.trim() === '') {
      // Ops sets NLI_CLASSIFY_SCRIPT="" to disable explicitly (CL ruling t/4596#6: hosted stays
      // off pending recalibration). NLI_CLASSIFY_SCRIPT_DISABLED_REASON lets them name why in the
      // deployed env config, so the WARN reads as a decision, not a resolution failure.
      const reason = process.env.NLI_CLASSIFY_SCRIPT_DISABLED_REASON?.trim()
        || 'explicitly disabled via NLI_CLASSIFY_SCRIPT (ops decision, not a failure)';
      return { path: undefined, reason };
    }
    return { path: override };
  }
  const found = resolveNliScriptPath(__dirname);
  if (found === undefined) {
    return { path: undefined, reason: `not found walking up from ${__dirname} (packaged build without scripts/, or a layout change)` };
  }
  return { path: found };
}

/** Resolve the script path for this call, or WARN and signal "skip" (t/4596#5: keeping this
 *  decision+log out of runNliDirectionGate's own branch count). */
function resolveScriptOrSkip(): string | undefined {
  const { path: scriptPath, reason } = resolveActiveNliScriptPath();
  if (scriptPath === undefined) warn(`nli-direction-gate: gate skipped — script unavailable (${reason})`);
  return scriptPath;
}

/** Run the subprocess and parse its output, or WARN and signal "skip" (same reasoning as
 *  resolveScriptOrSkip — consolidates what were three separate branches in the caller into one). */
function runNliSubprocessOrSkip(scriptPath: string, cwd: string, batch: NliInput[]): NliOutput[] | undefined {
  const { proc, tried } = spawnNliClassifier(scriptPath, cwd, batch);
  if (proc.error || proc.status !== 0) {
    warn(
      `nli-direction-gate: gate skipped — subprocess failed (script=${scriptPath}, interpreters tried=${tried.join(',')}, status=${proc.status}): ` +
      (proc.stderr?.slice(0, 300) ?? proc.error?.message ?? 'unknown'),
    );
    return undefined;
  }
  try {
    const outputs = JSON.parse(proc.stdout);
    return Array.isArray(outputs) ? outputs : undefined;
  } catch {
    warn(`nli-direction-gate: gate skipped — failed to parse subprocess output (script=${scriptPath})`);
    return undefined;
  }
}

interface NliInput {
  id: string;
  claim_prop: string;
  node_prop: string;
  claim_pov?: string;
  node_pov?: string;
}

interface NliOutput {
  id: string;
  direction: 'agrees' | 'opposes' | 'unrelated' | 'unresolved';
  confidence: number;
  method: string;
}

export interface NliGateCounts {
  opposes: number;
  agrees: number;
  unrelated: number;
  unresolved: number;
}

export interface NliGateResult {
  opposingIds: Set<string>;
  counts: NliGateCounts;
}

const ZERO_COUNTS: NliGateCounts = { opposes: 0, agrees: 0, unrelated: 0, unresolved: 0 };

// Slot suffixes for the three claim-text fields (t/2744#10: run-all, opposes-if-ANY).
// Using short suffix strings that cannot collide with real claim IDs (which never end in __v/__c/__a).
const SLOT_V = '__v';
const SLOT_C = '__c';
const SLOT_A = '__a';
const SLOT_SUFFIXES = [SLOT_V, SLOT_C, SLOT_A] as const;

function baseClaimId(slotId: string): string {
  for (const s of SLOT_SUFFIXES) {
    if (slotId.endsWith(s)) return slotId.slice(0, -s.length);
  }
  return slotId;
}

/**
 * V4 NLI direction gate (t/2746, t/2744#10): subprocess-calls scripts/nli_classify.py with
 * up to THREE slots per claim — verbatim (text), canonical_proposition, attribution_text_genus —
 * and returns IDs of claims where ANY slot direction === 'opposes' (recall-safe OR rule).
 *
 * Rationale (t/2744#10–#11): no single claim field wins across cases. verbatim/canonical
 * catch the origin key-point inversion; attribution catches the #1184 org-stance case.
 * The OR rule never false-demotes under opposes-only + fail-safe: extra neutral/entailment
 * slots don't fire. Counts are claim-level (not slot-level).
 *
 * Opposition-only gate (CL ruling t/2751#3): callers demote 'opposes' claims to
 * direction_mismatch; all other directions keep their attribution unchanged.
 *
 * Fail-safe: any subprocess error or parse failure returns empty set + zero counts —
 * the gate never falsely demotes a claim.
 */
export function runNliDirectionGate(
  nodes: ArgumentNetworkNode[],
  nodeTextById: Map<string, string>,
  speakerPov: string,
): NliGateResult {
  const empty: NliGateResult = { opposingIds: new Set(), counts: { ...ZERO_COUNTS } };
  const attributed = nodes.filter(n => n.claim_taxonomy_attribution?.primary_ref);
  if (attributed.length === 0) return empty;

  // Build up to 3 slots per claim — skip unavailable fields.
  const batch: NliInput[] = [];
  const claimIds = new Set<string>(); // track which claims have at least one slot
  for (const n of attributed) {
    const nodeText = nodeTextById.get(n.claim_taxonomy_attribution!.primary_ref!);
    if (!nodeText) continue;
    const fields: Array<[string, string | undefined]> = [
      [SLOT_V, n.text],
      [SLOT_C, n.canonical_proposition],
      [SLOT_A, n.attribution_text_genus],
    ];
    let added = false;
    for (const [suffix, claimText] of fields) {
      if (!claimText) continue;
      batch.push({ id: `${n.id}${suffix}`, claim_prop: claimText, node_prop: nodeText, claim_pov: speakerPov, node_pov: speakerPov });
      added = true;
    }
    if (added) claimIds.add(n.id);
  }
  if (batch.length === 0) return empty;

  const scriptPath = resolveScriptOrSkip();
  if (scriptPath === undefined) return empty;

  // The script's own directory, not necessarily the repo root — nli_classify.py has no
  // cwd-relative file access (checked: no os.getcwd()/relative open() calls), and Python adds
  // a script's own directory to sys.path automatically, so this is sufficient for its sibling
  // import of embed_taxonomy.py regardless of how NLI_CLASSIFY_SCRIPT was resolved.
  const outputs = runNliSubprocessOrSkip(scriptPath, path.dirname(scriptPath), batch);
  if (outputs === undefined) return empty;

  // Group slot outputs by claim ID, then apply OR rule at claim level.
  const slotsByClaimId = new Map<string, NliOutput[]>();
  for (const o of outputs) {
    const cid = baseClaimId(o.id);
    const arr = slotsByClaimId.get(cid);
    if (arr) arr.push(o); else slotsByClaimId.set(cid, [o]);
  }

  const counts: NliGateCounts = { ...ZERO_COUNTS };
  const opposingIds = new Set<string>();
  for (const [claimId, slots] of slotsByClaimId) {
    const dirs = slots.map(s => s.direction);
    if (dirs.some(d => d === 'opposes')) {
      counts.opposes++;
      opposingIds.add(claimId);
    } else if (dirs.some(d => d === 'agrees')) {
      counts.agrees++;
    } else if (dirs.every(d => d === 'unresolved')) {
      counts.unresolved++;
    } else {
      counts.unrelated++;
    }
  }
  return { opposingIds, counts };
}
