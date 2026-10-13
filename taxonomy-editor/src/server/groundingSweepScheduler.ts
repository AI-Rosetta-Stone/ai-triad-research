// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * G8b scheduled grounding sweep (t/3172, design e/131 + t/3163#1).
 *
 * A recurring, PATH-AGNOSTIC backstop for the G8a inline write-hook (groundingReconcileHook.ts):
 * batch / PowerShell / Python writes bypass `PUT /api/taxonomy/:pov` entirely, so G8a never fires
 * for them and their grounding silently goes stale. This timer shells out to CL's reconciler in
 * FULL-SWEEP mode (`reconcile_grounding.py --apply`, NO `--nodes`) on a configurable interval. The
 * reconciler is hash-gated (t/3160), so an up-to-date taxonomy does near-zero work — only nodes
 * whose text changed since the last run actually reconcile.
 *
 * SAFETY (mirrors eventLoopMonitor.ts + the G8a hook):
 *  - Non-overlapping: a `sweepInFlight` guard SKIPS (WARN) rather than stacking a 2nd child, so a
 *    slow sweep can never pile up children that all just block on the tool-lock (process churn).
 *  - Cross-process serialization is the reconciler's OWN `grounding_lock` (t/3194) — this module
 *    needs no cross-process mutex, exactly as G8a (t/3163#1 ruling).
 *  - Never crashes the host: a child failure is caught + FR/Pino logged and NEVER rethrown (a failed
 *    grounding refresh must not take down the server — the #1737 masked-error lesson).
 *  - `setInterval(...).unref()` — the timer never holds the process alive.
 *
 * ENABLE SEQUENCING: gated on `isGroundingSweepEnabled()` (env `GROUNDING_SWEEP_ENABLED`, default
 * OFF). Stays OFF until the reconciler tool-lock (t/3194, landed) AND the PS cmdlet lock-honoring
 * (t/3203) are confirmed with TL lock-symmetry sign-off — the SAME dependency as G8a's
 * `grounding_reconcile_inline` flag (t/3163#1). Flag-OFF → the timer is never armed → zero behavior.
 */

import { execFile } from 'child_process';
import { RECONCILE_SCRIPT, getProjectRoot, isGroundingSweepEnabled, STORAGE_MODE, getMaxReplicas } from './config.js';
import { getGlobalRecorder } from '../../../lib/flight-recorder/index.js';
import { ActionableError, errorMessage } from '../../../lib/debate/errors.js';
import { parseStats, type ReconcilerStats } from './groundingReconcileHook.js';
import { log } from './logger.js';

// Mirrors groundingReconcileHook.ts:35 / aiBackends.ts — the reconciler is a python3 script
// (win32 dev uses `python`).
const PYTHON = process.platform === 'win32' ? 'python' : 'python3';

// ── Tunable constants (co-located) ────────────────────────────────────────────
/** Default sweep cadence (min) per the t/3172 spec; overridable via GROUNDING_SWEEP_INTERVAL_MIN. */
export const DEFAULT_INTERVAL_MIN = 15;
/** A full sweep loads the dict+embeddings and walks the whole taxonomy — give it the same generous
 *  ceiling as a scoped reconcile; the hash gate keeps the real work bounded. */
const SWEEP_TIMEOUT_MS = 120_000;
const SWEEP_MAX_BUFFER = 10 * 1024 * 1024;

/** Resolve the configured interval (ms), floored at 1 min so a misconfig can't hot-loop the child. */
export function resolveIntervalMs(): number {
  const raw = parseInt(process.env.GROUNDING_SWEEP_INTERVAL_MIN || String(DEFAULT_INTERVAL_MIN), 10);
  const min = Number.isFinite(raw) && raw >= 1 ? raw : DEFAULT_INTERVAL_MIN;
  return min * 60_000;
}

// ── Injectable runner (testability — both GV arms drive changed/clean/failure without python) ──
export type SweepRunner = () => Promise<ReconcilerStats>;

/** Default runner: full-sweep child (`--apply`, no `--nodes` = whole taxonomy). Presence of NO
 *  `--nodes` selects the reconciler's full mode; `--apply` persists under its own grounding_lock. */
function defaultRunner(): Promise<ReconcilerStats> {
  return new Promise((resolve, reject) => {
    execFile(
      PYTHON,
      [RECONCILE_SCRIPT, '--apply'],
      { cwd: getProjectRoot(), timeout: SWEEP_TIMEOUT_MS, maxBuffer: SWEEP_MAX_BUFFER, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) { reject(new Error(`reconcile_grounding.py (full sweep) exited non-zero/timeout: ${err.message}\n${stderr}`)); return; }
        resolve(parseStats(stdout));
      },
    );
  });
}

let _runner: SweepRunner = defaultRunner;

// ── State (module singleton — one timer, at most one child in flight) ──────────
let timer: ReturnType<typeof setInterval> | null = null;
let sweepInFlight = false;

/** Sum the reconciler's stat arms into a nodes_checked total, treating a parse-miss null as 0. */
function checkedTotal(s: ReconcilerStats): number {
  return (s.changed ?? 0) + (s.skipped ?? 0) + (s.removed ?? 0);
}

/** One sweep tick: skip-if-overlapping, run the full reconcile, record the outcome. Never throws. */
async function runSweep(): Promise<void> {
  if (sweepInFlight) {
    // Overlap: a prior sweep is still running. Skip (do NOT stack) and make the skip visible — a
    // sweep that never completes would otherwise look identical to one that never ran.
    getGlobalRecorder()?.record({
      // FR EventType is a closed union (Shared Lib) — no 'grounding.sweep' member; mirror G8a's
      // grounding-reconcile precedent: system.info/system.error carry the level, `component`
      // ('grounding-sweep') is the greppable identity, `data.skipped` distinguishes the overlap case.
      type: 'system.error', component: 'grounding-sweep', level: 'warn',
      message: 'Grounding sweep skipped — prior run still in flight',
      data: { skipped: true, nodes_checked: 0, nodes_reconciled: 0, nodes_removed: 0, duration_ms: 0 },
    });
    log.server.warn({ component: 'grounding-sweep' }, 'Grounding sweep skipped — prior run in flight');
    return;
  }
  sweepInFlight = true;
  const startedMs = Date.now();
  // Routine start — Pino only; emitting a start event to the capacity-bounded FR ring every 15 min
  // would evict real events (same rationale as eventLoopMonitor's info gauge).
  log.server.info({ component: 'grounding-sweep' }, 'Grounding sweep started');
  try {
    const stats = await _runner();
    const duration_ms = Date.now() - startedMs;
    const nodes_reconciled = stats.changed ?? 0;
    getGlobalRecorder()?.record({
      type: 'system.info', component: 'grounding-sweep', level: 'info',
      message: `Grounding sweep: ${nodes_reconciled} reconciled, ${stats.skipped ?? '?'} skipped, ${stats.removed ?? 0} removed`,
      data: {
        skipped: false,
        nodes_checked: checkedTotal(stats),
        nodes_reconciled,
        nodes_removed: stats.removed ?? 0,
        duration_ms,
      },
    });
    log.server.info(
      { component: 'grounding-sweep', nodes_reconciled, skipped: stats.skipped, removed: stats.removed, duration_ms },
      'Grounding sweep complete',
    );
  } catch (err) {
    // Fallback-Path Logging: a failed sweep leaves grounding stale until the next tick — that must
    // be visible (silent degradation is invisible). WARN-level FR + Pino, but NEVER rethrow: this
    // runs on a bare setInterval, so an unhandled rejection here would crash the host process.
    const duration_ms = Date.now() - startedMs;
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'grounding-sweep', level: 'error',
      message: `Grounding sweep FAILED — grounding may be stale until the next sweep: ${errorMessage(err)}`,
      data: { skipped: false, nodes_checked: 0, nodes_reconciled: 0, nodes_removed: 0, duration_ms },
      error: { name: (err as Error)?.name ?? 'Error', message: errorMessage(err), stack: (err as Error)?.stack },
    });
    log.server.error({ component: 'grounding-sweep', err: errorMessage(err), duration_ms }, 'Grounding sweep failed (non-fatal)');
  } finally {
    sweepInFlight = false;
  }
}

/** t/3333/t/4177: arm-decision for the sweep. PURE (no I/O) so all arms are unit-tested without
 *  config/env mocking. The sweep's `--apply` writes the LOCAL filesystem; on the `github-api` read
 *  profile those writes are invisible to the read path, so arming it there would SILENTLY no-op
 *  (t/2648 class) — a hard architectural constraint, not the soft default-OFF.
 *  t/4177: the reconciler's `grounding_lock` (O_CREAT|O_EXCL) serializes within ONE host; it has no
 *  cross-replica lease. Arming the sweep on every one of N>1 replicas would run N concurrent full
 *  sweeps with no cross-process coordination between them (TL t/4177#3 — a single-holder lease, e.g.
 *  an Azure Blob lease, is the real fix and is not built yet). Refuse rather than silently risk it.
 *  Returns:
 *   - 'disabled'                  — flag OFF (inert by design; the default).
 *   - 'blocked-github-api'        — flag ON but STORAGE_MODE=github-api → refuse to arm + fail LOUD.
 *   - 'blocked-no-lease-multi-replica' — flag ON, filesystem-visible profile, but MAX_REPLICAS>1 and
 *     no cross-replica lease exists → refuse to arm + fail LOUD.
 *   - 'arm'                       — flag ON, filesystem-visible profile, MAX_REPLICAS<=1 → arm normally. */
export type SweepArmDecision = 'arm' | 'disabled' | 'blocked-github-api' | 'blocked-no-lease-multi-replica';
export function decideSweepArm(storageMode: string, enabled: boolean, maxReplicas: number = 1): SweepArmDecision {
  if (!enabled) return 'disabled';
  if (storageMode === 'github-api') return 'blocked-github-api';
  if (maxReplicas > 1) return 'blocked-no-lease-multi-replica';
  return 'arm';
}

/**
 * Start the recurring grounding sweep. Idempotent (a second call is a no-op while running). The
 * interval is `unref()`d so it never keeps the process alive. Returns the stop fn.
 *
 * Gated on `isGroundingSweepEnabled()`: when the flag is OFF the timer is NEVER armed — the sweep is
 * completely inert (this is the default, pending the sequenced enable). Returns a no-op stop fn in
 * that case so the caller contract is identical either way.
 *
 * t/3333 hard-guard: even when the flag is ON, on the `github-api` profile the timer is REFUSED (not
 * armed) with a loud ActionableError → Log_s, because the reconciler's local-FS writes are invisible
 * to the github-api read path (silent no-op / t/2648 class). Loud-and-refuse, never a throw — this is
 * called at boot and a misconfigured flag must not crash the host (the module's non-fatal contract).
 */
export function startGroundingSweep(intervalMs: number = resolveIntervalMs()): () => void {
  const maxReplicas = getMaxReplicas();
  const decision = decideSweepArm(STORAGE_MODE, isGroundingSweepEnabled(), maxReplicas);
  if (decision === 'disabled') {
    // Log-once so an operator can see the sweep is present-but-disabled (vs. silently absent).
    log.server.info({ component: 'grounding-sweep' }, 'Grounding sweep disabled (GROUNDING_SWEEP_ENABLED off) — timer not armed');
    return () => { /* no-op: nothing was armed */ };
  }
  if (decision === 'blocked-github-api') {
    const err = new ActionableError({
      goal: 'Run the scheduled grounding sweep so batch/PS/Python taxonomy writes stay grounded',
      problem: `GROUNDING_SWEEP_ENABLED is set but STORAGE_MODE=${STORAGE_MODE}. The sweep shells reconcile_grounding.py --apply, which writes the LOCAL filesystem — invisible to the github-api read path. Arming it here would SILENTLY no-op (t/2648 class), so the timer is refused.`,
      location: 'server/groundingSweepScheduler.ts → startGroundingSweep',
      nextSteps: [
        'Do NOT set GROUNDING_SWEEP_ENABLED on the hosted github-api profile.',
        'To keep hosted taxonomy grounded, run the sweep in the CI-commit model (a scheduled Action that commits to ai-triad-data) — see t/3333 Option A.',
        'Unset GROUNDING_SWEEP_ENABLED, or run the sweep only on a filesystem-backed profile.',
      ],
    });
    // Fail LOUD (not a silent no-op): both Log_s (Pino error) and the flight recorder name the refusal.
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'grounding-sweep', level: 'error',
      message: 'Grounding sweep refused to arm — GROUNDING_SWEEP_ENABLED set on the github-api profile (would silently no-op)',
      data: { storageMode: STORAGE_MODE, armed: false },
      error: { name: err.name, message: errorMessage(err) },
    });
    log.server.error({ component: 'grounding-sweep', storageMode: STORAGE_MODE }, errorMessage(err));
    return () => { /* no-op: refused to arm on the github-api profile */ };
  }
  if (decision === 'blocked-no-lease-multi-replica') {
    const err = new ActionableError({
      goal: 'Run the scheduled grounding sweep exactly once per tick, even with multiple replicas',
      problem: `GROUNDING_SWEEP_ENABLED is set and MAX_REPLICAS=${maxReplicas}, but the reconciler's grounding_lock (O_CREAT|O_EXCL) only serializes within one host — it has no cross-replica lease. Arming the sweep on every replica would run ${maxReplicas} concurrent full sweeps with no coordination between them, so the timer is refused.`,
      location: 'server/groundingSweepScheduler.ts → startGroundingSweep',
      nextSteps: [
        'Do NOT set GROUNDING_SWEEP_ENABLED when MAX_REPLICAS>1 until a single-holder lease exists (t/4177 — prefer an Azure Blob lease over O_EXCL on SMB).',
        'Keep GROUNDING_SWEEP_ENABLED off when scaling to N>1 replicas.',
        'Once a cross-replica lease lands, this guard can be relaxed — track it on t/4177.',
      ],
    });
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'grounding-sweep', level: 'error',
      message: 'Grounding sweep refused to arm — MAX_REPLICAS>1 with no cross-replica lease (would run N concurrent uncoordinated sweeps)',
      data: { storageMode: STORAGE_MODE, maxReplicas, armed: false },
      error: { name: err.name, message: errorMessage(err) },
    });
    log.server.error({ component: 'grounding-sweep', storageMode: STORAGE_MODE, maxReplicas }, errorMessage(err));
    return () => { /* no-op: refused to arm with MAX_REPLICAS>1 and no lease */ };
  }
  if (timer) return stopGroundingSweep;
  log.server.info({ component: 'grounding-sweep', intervalMs }, 'Grounding sweep enabled — arming timer');
  timer = setInterval(() => { void runSweep(); }, intervalMs);
  timer.unref();
  return stopGroundingSweep;
}

/** Stop the sweep timer (idempotent). Does not interrupt an in-flight child — it finishes and clears
 *  the sweepInFlight flag on its own. */
export function stopGroundingSweep(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

// ── Test hooks (underscore-prefixed — not part of the caller contract) ─────────
/** Inject a fake sweep runner; pass null to restore the real execFile-based runner. */
export function __setSweepRunnerForTest(r: SweepRunner | null): void { _runner = r ?? defaultRunner; }
/** Run a single sweep tick directly (bypasses the timer) so tests assert one run deterministically. */
export function __runSweepOnceForTest(): Promise<void> { return runSweep(); }
/** Reset module state between tests (timer, in-flight flag). */
export function __resetSweepForTest(): void {
  if (timer) { clearInterval(timer); timer = null; }
  sweepInFlight = false;
}
/** Introspection for tests. */
export function __stateForTest(): { armed: boolean; inFlight: boolean } {
  return { armed: timer !== null, inFlight: sweepInFlight };
}
