// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Main-thread manager for the off-thread embedding worker pool (t/3181 item A; K-slot pool t/3211).
 *
 * Owns a POOL of K persistent workers (default K=1 → the original single-worker behavior, byte-
 * identical and inert), a bounded SHARED FIFO queue, an id↔promise map, a per-slot heartbeat
 * watchdog, and per-slot respawn-with-backoff. Exposes the shared contract B (ServerAPI) and C
 * (ElectronMain) build against:
 *
 *     computeEmbeddingsOffThread(texts, opts?: { requester?: string }): Promise<Float32Array[]>
 *
 * Pool size is set ONCE at startup via {@link configureEmbeddingWorkerPool} (a startup-only mutator,
 * NOT a ctor — keeping the free-function contract B/C already build against). Default 1 → today's
 * exact behavior; ramp to K only behind the config knob + a multi-core SKU (t/3211).
 *
 * Cache RESOLVE stays on the caller's main thread — only miss-texts marshal IN (structured-clone of
 * strings), vectors marshal OUT via a TRANSFERRED ArrayBuffer (zero-copy). Each worker owns its own
 * ONNX session exclusively; this module NEVER computes embeddings in-thread — not even on worker
 * failure. A worker crash/wedge/queue-overflow fails LOUD (ActionableError → the server's t/3078
 * block-mode 503 load-shed); an in-thread fallback would reintroduce the exact t/3165 starvation it
 * prevents. Under partial failure the pool keeps serving on live slots and sheds only when EVERY slot
 * is down (t/3211 TL condition B); the queue-depth cap scales with LIVE slot count so a lone survivor
 * cannot accept a K× backlog that tail-latencies past the route timeout.
 */

import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { ActionableError, errorMessage } from '../debate/errors.js';
import { getGlobalRecorder } from '../flight-recorder/index.js';
import { assertEmbeddingTexts } from './embeddingInput.js';

// ── Tunable constants — Gate Co-Location (each states what it trades off; TL-accepted t/3181#2) ──

/**
 * Watchdog window. ARMED ON DISPATCH (not first heartbeat, TL Q1 refinement — so a hang *before*
 * the first chunk, e.g. a model-load stall, is still caught), RESET on each chunk heartbeat.
 * Must exceed cold model-load (~900ms/spike) + one chunk's compute with margin. Too low →
 * false-kills a healthy large batch mid-load; too high → slow wedge detection. (t/3181 Q2.)
 */
const HEARTBEAT_TIMEOUT_MS = 8000;

/**
 * Per-live-slot queue budget: each live slot admits 1 in-flight + (MAX_QUEUE_DEPTH − 1) queued. The
 * aggregate resident cap is `MAX_QUEUE_DEPTH * liveSlotCount()` — DYNAMIC (t/3211 TL condition B):
 * as slots go down the cap tightens, so a single survivor can never accept a K× backlog that drains
 * at 1/K rate and tail-latencies past the ~50s route wall. Enqueue past the cap → load-shed 503 +
 * WARN. Higher → more memory + longer tail latency under burst; lower → sheds sooner. (t/3181 Q2.)
 */
const MAX_QUEUE_DEPTH = 16;

/**
 * Respawn backoff after a worker crash/wedge: doubles per consecutive failure up to the cap, resets
 * on a clean task. Too short → tight crash→respawn spin burning CPU; too long → extended shed gap
 * where that slot's requests are rejected. New tasks arriving while ALL slots are down are shed.
 * (t/3181 Q2.)
 */
const BACKOFF_BASE_MS = 250;
const BACKOFF_CAP_MS = 5000;

/**
 * Cores kept for the main thread (event loop + cache resolve + request handling) when clamping the
 * configured pool size. K is capped at `availableParallelism() - POOL_CORE_HEADROOM` because the
 * bottleneck is op-thread compute: K worker op-threads beyond the available cores oversubscribe the
 * box and buy nothing (throughput stays flat — the finding this ticket is built on). (t/3211.)
 */
const POOL_CORE_HEADROOM = 1;

/**
 * Queue age-out budget (t/3275). A task that has waited longer than this in the SHARED queue is
 * rejected fail-loud at the moment a slot would dispatch it, instead of being computed for a caller
 * the route has already abandoned. Sized against the ~50s server route wall: must be `< 50s` with
 * headroom for one dispatch + a first-compute start (~10s, incl. a cold model-load spike) so a task
 * admitted at the budget still returns before the route times out. Too low → sheds tasks that could
 * still finish in budget; too high → burns a worker slot on doomed work behind the backlog. The
 * in-flight watchdog (HEARTBEAT_TIMEOUT_MS) guards tasks already dispatched; this guards the queue
 * wait the watchdog never sees. (t/3275; ~50s route wall / 512-batch storm.)
 */
const QUEUE_AGE_OUT_MS = 40_000;

// ── Types ─────────────────────────────────────────────

interface Task {
  id: number;
  texts: string[];
  requester: string;
  queuedAt: number; // Date.now() at enqueue — drives the QUEUE_AGE_OUT_MS dispatch-time age-out (t/3275)
  resolve: (vectors: Float32Array[]) => void;
  reject: (err: unknown) => void;
}

/**
 * One pool slot: a persistent worker plus the per-slot state the single-worker manager used to hold
 * at module scope. Watchdog, respawn/backoff, consecutive-failure count and the down-flag are ALL
 * per-slot so a crash/wedge on one slot rejects+respawns only its own worker — a healthy sibling's
 * concurrent in-flight task is untouched (the t/3181 identity-guard, now keyed on `slot.worker`).
 */
interface Slot {
  worker: EmbeddingWorkerLike | null;
  inFlight: Task | null;
  watchdog: ReturnType<typeof setTimeout> | null;
  lastChunkSeen: number;
  consecutiveFailures: number;
  down: boolean; // true during this slot's respawn-backoff gap
  respawnTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Minimal worker surface the manager depends on. `worker_threads.Worker` satisfies it; tests inject
 * a fake via {@link __setEmbeddingWorkerFactory} to deterministically drive crash/wedge/shed paths
 * without spawning a real thread (the injectable-factory testability pattern, TL-approved).
 */
export interface EmbeddingWorkerLike {
  postMessage(value: unknown, transferList?: readonly ArrayBuffer[]): void;
  on(event: 'message' | 'error' | 'exit', listener: (arg: never) => void): void;
  terminate(): void | Promise<number>;
}
export type EmbeddingWorkerFactory = () => EmbeddingWorkerLike;

type WorkerMessage =
  | { type: 'heartbeat'; id: number; chunk: number }
  | { type: 'result'; id: number; ok: true; buffer: ArrayBuffer; count: number; dim: number }
  | { type: 'result'; id: number; ok: false; error: string };

type DownCause = 'crash' | 'exit' | 'wedge';

// ── State (module-level — a shared queue feeding K slots) ──

let _workerFactory: EmbeddingWorkerFactory = defaultWorkerFactory;
let _slots: Slot[] = [];               // materialized lazily on first pump() (see ensureSlots)
let _desiredSize: number | null = null; // set by configureEmbeddingWorkerPool; null → unconfigured (K=1)
const _queue: Task[] = [];
let _nextId = 1;

function defaultWorkerFactory(): EmbeddingWorkerLike {
  // Node/dev-Electron resolution. Packaged-Electron asar worker-entry resolution is C's exit
  // criterion (t/3184), off A's critical path — A targets Node/server + dev-Electron.
  return new Worker(new URL('./embeddingWorker.js', import.meta.url)) as unknown as EmbeddingWorkerLike;
}

/** Effective pool size: the clamped configured value, or 1 when compute precedes configure. */
function poolSize(): number {
  return _desiredSize ?? 1;
}

/** Materialize the slot array on first use (compute-before-configure lands here → K=1). */
function ensureSlots(): void {
  if (_slots.length > 0) return;
  _slots = Array.from({ length: poolSize() }, () => ({
    worker: null, inFlight: null, watchdog: null,
    lastChunkSeen: -1, consecutiveFailures: 0, down: false, respawnTimer: null,
  }));
}

/** Live slots = those able to serve (not in a respawn-backoff gap). Nominal size before materialize. */
function liveSlotCount(): number {
  if (_slots.length === 0) return poolSize();
  return _slots.reduce((n, s) => n + (s.down ? 0 : 1), 0);
}

/** True only when the pool has slots AND every one of them is down (respawning) → hard shed. */
function allSlotsDown(): boolean {
  return _slots.length > 0 && _slots.every(s => s.down);
}

/** Current resident tasks: everything queued plus everything in flight across all slots. */
function queueLen(): number {
  return _queue.length + _slots.reduce((n, s) => n + (s.inFlight ? 1 : 0), 0);
}

/**
 * Read-only snapshot of the worker-pool queue state (t/3374, for ServerAPI's t/3373 non-silent shed
 * alert + pre-shed queue-depth gauge). Pure getters over module state — NO behavior change.
 * - `queueDepth`: current resident tasks (queued + in-flight) — the value compared against the cap.
 * - `cap`: the DYNAMIC admission cap = `MAX_QUEUE_DEPTH × liveSlots` (t/3211 condition B).
 * - `liveSlots`: slots currently able to serve (0 when every slot is respawning → hard shed).
 */
export function poolStats(): { queueDepth: number; cap: number; liveSlots: number } {
  const liveSlots = liveSlotCount();
  return { queueDepth: queueLen(), cap: MAX_QUEUE_DEPTH * liveSlots, liveSlots };
}

function warn(message: string, data: Record<string, unknown>): void {
  // Fallback-Path Logging: every shed / crash / wedge / clamp records WHAT degraded + WHY + WHO.
  getGlobalRecorder()?.record({ type: 'system.error', component: 'offThreadEmbedding', level: 'warn', message, data });
}

/** Terminate a worker, tolerating an already-dead one and voiding the (possibly async) result. */
function safeTerminate(w: EmbeddingWorkerLike | null): void {
  try {
    const r = w?.terminate();
    if (r && typeof (r as Promise<number>).then === 'function') {
      void (r as Promise<number>).catch(() => { /* terminate rejection is not actionable */ });
    }
  } catch { /* already dead */ }
}

// ── Startup configuration ─────────────────────────────

/**
 * Set the worker-pool size. **Startup-only** — call once before the first embedding request; ServerAPI
 * threads `EMBEDDING_WORKER_POOL_SIZE` (raw, default 1) here from config (t/3211). The RAW size is
 * self-clamped to `min(size, availableParallelism() − 1)` so a mis-set value can never oversubscribe
 * the box regardless of SKU (e.g. POOL_SIZE=8 on a 4-core box → K=3), and to a floor of 1.
 *
 * Ordering contract (t/3211 TL condition A):
 *  - Called AFTER the pool has materialized (any request already dispatched) → **no-op + WARN**; a
 *    live pool is never resized mid-flight.
 *  - {@link computeEmbeddingsOffThread} called BEFORE this → pool defaults to K=1 (never throws).
 */
export function configureEmbeddingWorkerPool(size: number): void {
  if (_slots.length > 0) {
    warn('configureEmbeddingWorkerPool ignored — pool already running (startup-only, cannot resize live)', {
      requestedSize: size, activeSize: _slots.length,
    });
    return;
  }
  const cores = availableParallelism();
  const cap = Math.max(1, cores - POOL_CORE_HEADROOM);
  const requested = Math.max(1, Math.floor(Number.isFinite(size) ? size : 1));
  const clamped = Math.min(requested, cap);
  if (clamped < requested) {
    warn('embedding pool size clamped to available cores', {
      requestedSize: requested, clampedSize: clamped, cores, headroom: POOL_CORE_HEADROOM,
    });
  }
  _desiredSize = clamped;
}

// ── Public contract ───────────────────────────────────

/**
 * Compute embeddings off the main thread. Resolves to one 384-dim `Float32Array` per input text
 * (views over a single transferred buffer — do not assume they are independently backed). Rejects
 * with an `ActionableError` when the request is shed (queue full, or every slot respawning) or the
 * serving worker crashes/wedges — the server maps that to a 503 load-shed. NEVER falls back to
 * in-thread compute.
 *
 * @param opts.requester short label for the caller (surfaced in the queue-full/shed WARN so a shed
 *   event names who was dropped — fallback-logging rule). Threaded from B/C.
 */
export function computeEmbeddingsOffThread(
  texts: string[],
  opts?: { requester?: string },
): Promise<Float32Array[]> {
  const requester = opts?.requester ?? 'unknown';

  // t/716: a non-string text would throw inside the worker's tokenizer and surface as an opaque compute
  // failure. Refuse it here, before the queue, naming the element. Not a shed and not a worker fault.
  try {
    assertEmbeddingTexts(texts, 'lib/embeddings/offThreadEmbedding.ts:computeEmbeddingsOffThread');
  } catch (err) {
    warn('embedding request refused — texts is not an array of strings', { requester, error: errorMessage(err) });
    return Promise.reject(err);
  }

  if (texts.length === 0) return Promise.resolve([]); // trivial — no worker round-trip

  // Shed while EVERY slot is down during a respawn-backoff gap (fail loud, no in-thread fallback).
  if (allSlotsDown()) {
    warn('embedding request shed — all workers respawning (backoff gap)', { requester, queueDepth: queueLen() });
    return Promise.reject(shedError(requester, 'all workers are respawning after a crash/wedge'));
  }

  // Bounded queue, cap scaled by LIVE slots (t/3211): K in-flight + (MAX_QUEUE_DEPTH−1)×live queued.
  // Overflow → load-shed 503 + WARN.
  const cap = MAX_QUEUE_DEPTH * liveSlotCount();
  if (queueLen() >= cap) {
    warn('embedding request shed — queue full', { requester, queueDepth: queueLen(), max: cap });
    return Promise.reject(shedError(requester, `queue full (max ${cap})`));
  }

  return new Promise<Float32Array[]>((resolve, reject) => {
    _queue.push({ id: _nextId++, texts, requester, queuedAt: Date.now(), resolve, reject });
    pump();
  });
}

/** Terminate all workers and drop pending work. Call on app shutdown. */
export function shutdownEmbeddingWorker(): void {
  for (const slot of _slots) {
    clearWatchdog(slot);
    if (slot.respawnTimer) { clearTimeout(slot.respawnTimer); slot.respawnTimer = null; }
    safeTerminate(slot.worker);
    slot.worker = null;
    slot.inFlight = null;
    slot.down = false;
  }
  _queue.length = 0;
}

// ── Scheduling ────────────────────────────────────────

/** Drain the shared queue onto any idle, up-and-serving slots (≤ liveSlotCount in flight at once). */
function pump(): void {
  ensureSlots();
  for (const slot of _slots) {
    if (slot.inFlight || slot.down) continue;         // busy or respawning → skip
    const task = takeNextServableTask();              // skips + rejects tasks aged past the budget
    if (!task) break;                                 // queue empty (or fully drained of stale tasks)
    if (!slot.worker) slot.worker = spawnWorker(slot); // lazily (re)spawn on demand
    slot.inFlight = task;
    slot.lastChunkSeen = -1;
    armWatchdog(slot); // ARM ON DISPATCH (TL Q1) — catches a hang before the first heartbeat too
    slot.worker.postMessage({ id: task.id, texts: task.texts });
  }
}

/**
 * Pop the next task that is still worth serving, age-out-rejecting any that waited past
 * `QUEUE_AGE_OUT_MS` (t/3275). The check runs at the DISPATCH decision — exactly when a slot would
 * take the task — so a doomed task never seizes a worker; the reject just fires at the moment
 * dispatch would have. Returns `null` when the queue is empty or every remaining task is stale (the
 * slot then stays idle). Each age-out is a fail-loud shed (ActionableError → 503) + a WARN naming the
 * requester and wait time (fallback-logging); there is NO in-thread fallback.
 */
function takeNextServableTask(): Task | null {
  while (_queue.length > 0) {
    const task = _queue.shift()!;
    const waitedMs = Date.now() - task.queuedAt;
    if (waitedMs > QUEUE_AGE_OUT_MS) {
      warn('embedding request shed — queued past age-out budget before dispatch', {
        requester: task.requester, waitedMs, budgetMs: QUEUE_AGE_OUT_MS, queueDepth: queueLen(),
      });
      task.reject(ageOutError(task.requester, waitedMs));
      continue; // drop this stale task, try the next one — do not consume the slot on it
    }
    return task;
  }
  return null;
}

function spawnWorker(slot: Slot): EmbeddingWorkerLike {
  const w = _workerFactory();
  // IDENTITY-GUARD every handler on the specific worker instance `w` AND its owning `slot`: after a
  // respawn the OLD (terminated) worker can still emit a late 'exit'/'error'/'message'. Without this
  // guard that stale event would act on the CURRENT slot state — e.g. an old worker's late 'exit'
  // would call onWorkerDown and tear down the HEALTHY new worker (reject its task, terminate, re-
  // respawn). `w !== slot.worker` means the event came from a superseded worker → drop it. Keying on
  // the slot (not a module singleton) is what isolates a fault to its own slot and leaves siblings
  // serving. (t/3181 GV required fix, generalized to the pool in t/3211.)
  w.on('message', ((msg: WorkerMessage) => { if (w === slot.worker) onWorkerMessage(slot, msg); }) as (arg: never) => void);
  w.on('error', ((err: Error) => {
    if (w === slot.worker) onWorkerDown(slot, 'crash', err instanceof Error ? err.message : String(err));
  }) as (arg: never) => void);
  w.on('exit', ((code: number) => {
    if (w === slot.worker && code !== 0) onWorkerDown(slot, 'exit', `worker exited with code ${code}`);
  }) as (arg: never) => void);
  return w;
}

function onWorkerMessage(slot: Slot, msg: WorkerMessage): void {
  if (msg.type === 'heartbeat') {
    if (slot.inFlight && msg.id === slot.inFlight.id) {
      slot.lastChunkSeen = msg.chunk;
      armWatchdog(slot); // forward progress → reset the wedge window
    }
    return;
  }

  // result — ignore stale messages from a terminated/superseded worker or a mismatched task.
  if (!slot.inFlight || msg.id !== slot.inFlight.id) return;
  clearWatchdog(slot);
  const task = slot.inFlight;
  slot.inFlight = null;

  if (msg.ok) {
    slot.consecutiveFailures = 0; // a clean task resets THIS slot's respawn backoff
    task.resolve(unpack(msg.buffer, msg.count, msg.dim));
  } else {
    // Worker is alive but the compute threw (e.g. model load) — reject this task, keep the worker.
    warn('embedding compute failed in worker', { requester: task.requester, taskId: task.id, error: msg.error });
    task.reject(computeFailedError(task.requester, msg.error));
  }
  pump();
}

function armWatchdog(slot: Slot): void {
  clearWatchdog(slot);
  slot.watchdog = setTimeout(() => onWedge(slot), HEARTBEAT_TIMEOUT_MS);
}

function clearWatchdog(slot: Slot): void {
  if (slot.watchdog) { clearTimeout(slot.watchdog); slot.watchdog = null; }
}

function onWedge(slot: Slot): void {
  if (!slot.inFlight) return; // result already handled — spurious fire
  onWorkerDown(slot, 'wedge', `no heartbeat within ${HEARTBEAT_TIMEOUT_MS}ms (last chunk seen: ${slot.lastChunkSeen})`);
}

/**
 * Unified per-slot crash / exit / wedge handler: terminate the faulted worker, reject the in-flight
 * task (never recompute in-thread), and respawn THIS slot with backoff. Sibling slots are untouched.
 * New tasks arriving while every slot is down are shed.
 */
function onWorkerDown(slot: Slot, cause: DownCause, detail: string): void {
  if (slot.down) return; // already handling this slot's outage (e.g. terminate() → 'exit' re-entry)
  slot.down = true;
  clearWatchdog(slot);

  safeTerminate(slot.worker);
  slot.worker = null;

  if (slot.inFlight) {
    const task = slot.inFlight;
    slot.inFlight = null;
    warn(`embedding worker ${cause} — terminating + respawning`, {
      requester: task.requester, taskId: task.id, cause, detail, lastChunkSeen: slot.lastChunkSeen,
    });
    task.reject(workerDownError(task.requester, cause, detail));
  } else {
    warn(`embedding worker ${cause} — terminating + respawning (no task in flight)`, { cause, detail });
  }

  // Respawn this slot after backoff; the worker is lazily re-spawned by the next pump() once its gap
  // clears. Backoff is per-slot so one slot's crash storm doesn't stall the others.
  slot.consecutiveFailures++;
  const delay = Math.min(BACKOFF_BASE_MS * 2 ** (slot.consecutiveFailures - 1), BACKOFF_CAP_MS);
  slot.respawnTimer = setTimeout(() => {
    slot.respawnTimer = null;
    slot.down = false;
    pump(); // resume any tasks still queued from before the outage
  }, delay);
}

/** Slice the transferred buffer into N zero-copy 384-wide views (cache RESOLVE stays caller-side). */
function unpack(buffer: ArrayBuffer, count: number, dim: number): Float32Array[] {
  const all = new Float32Array(buffer);
  const out: Float32Array[] = new Array(count);
  for (let i = 0; i < count; i++) out[i] = all.subarray(i * dim, (i + 1) * dim);
  return out;
}

// ── ActionableErrors (all fail-loud → server load-shed; NONE fall back to in-thread) ──

/**
 * Discriminable code stamped on the LOAD-SHED ActionableErrors (queue-full / all-respawning / age-out)
 * so consumers can branch on the shed class WITHOUT string-matching the formatted message — e.g.
 * ServerAPI emits a clean stdout shed token for the t/3373 non-silent alert. NOT stamped on
 * {@link workerDownError} (a fault, not a shed). The code lives on the error INSTANCE — `ActionableError`
 * itself is DebateTool scope (lib/debate/errors.ts), so this never touches the shared class (t/3374).
 */
export const WORKER_POOL_SHED_CODE = 'WORKER_POOL_SHED';

/** An {@link ActionableError} stamped with {@link WORKER_POOL_SHED_CODE}. */
export type WorkerPoolShedError = ActionableError & { code: typeof WORKER_POOL_SHED_CODE };

/** Stamp the shed code on a freshly-built shed error (instance property; class untouched). */
function markShed(err: ActionableError): WorkerPoolShedError {
  (err as WorkerPoolShedError).code = WORKER_POOL_SHED_CODE;
  return err as WorkerPoolShedError;
}

/** True when `err` is a worker-pool load-shed error (queue-full / all-respawning / age-out). */
export function isWorkerPoolShedError(err: unknown): err is WorkerPoolShedError {
  return err instanceof ActionableError && (err as { code?: unknown }).code === WORKER_POOL_SHED_CODE;
}

function shedError(requester: string, reason: string): WorkerPoolShedError {
  return markShed(new ActionableError({
    goal: 'Compute embeddings off the main thread without starving the event loop',
    problem: `Embedding request from "${requester}" was shed: ${reason}`,
    location: 'lib/embeddings/offThreadEmbedding.ts:computeEmbeddingsOffThread',
    nextSteps: [
      'Retry after backpressure clears — this maps to the existing t/3078 block-mode 503 load-shed',
      'Intentional load-shedding, not a fault: the worker queue is bounded to protect request handling',
    ],
  }));
}

function ageOutError(requester: string, waitedMs: number): WorkerPoolShedError {
  return markShed(new ActionableError({
    goal: 'Compute embeddings off the main thread within the request budget',
    problem: `Embedding request from "${requester}" was shed: waited ${waitedMs}ms in the queue, past `
      + `the ${QUEUE_AGE_OUT_MS}ms age-out budget, before a worker was free to serve it`,
    location: 'lib/embeddings/offThreadEmbedding.ts:takeNextServableTask',
    nextSteps: [
      'Retry after backpressure clears — this maps to the existing t/3078 block-mode 503 load-shed',
      'Intentional load-shedding, not a fault: a task queued past the budget would exceed the route '
        + 'timeout anyway, so it is rejected rather than dispatched to compute a now-abandoned result',
    ],
  }));
}

function workerDownError(requester: string, cause: DownCause, detail: string): ActionableError {
  return new ActionableError({
    goal: 'Compute embeddings off the main thread',
    problem: `Embedding request from "${requester}" failed — worker ${cause}: ${detail}`,
    location: 'lib/embeddings/offThreadEmbedding.ts:onWorkerDown',
    nextSteps: [
      'The worker was terminated and is respawning with backoff — retry shortly (server maps to a 503)',
      'By design there is NO in-thread fallback: running ONNX on the main thread on failure would '
        + 'reintroduce the t/3165 event-loop starvation. Fail loud → load-shed is the correct behavior.',
    ],
  });
}

function computeFailedError(requester: string, detail: string): ActionableError {
  return new ActionableError({
    goal: 'Compute embeddings off the main thread',
    problem: `Embedding compute failed in the worker for "${requester}": ${detail}`,
    location: 'lib/embeddings/offThreadEmbedding.ts:onWorkerMessage',
    nextSteps: [
      'Inspect the worker error above (commonly a missing/invalid ONNX model or tokenizer)',
      'The worker stays alive for subsequent tasks; this request load-sheds (no in-thread fallback)',
    ],
  });
}

// ── Test hooks (underscore-prefixed — not part of the consumer contract) ──

/** Inject a fake worker factory for tests; pass `null` to restore the real `worker_threads` factory. */
export function __setEmbeddingWorkerFactory(factory: EmbeddingWorkerFactory | null): void {
  _workerFactory = factory ?? defaultWorkerFactory;
}

/** Reset all manager state between tests (timers, queue, slots, counters, configured size). */
export function __resetEmbeddingWorkerForTests(): void {
  for (const slot of _slots) {
    clearWatchdog(slot);
    if (slot.respawnTimer) { clearTimeout(slot.respawnTimer); slot.respawnTimer = null; }
    safeTerminate(slot.worker);
  }
  _slots = [];
  _desiredSize = null;
  _queue.length = 0;
  _nextId = 1;
}

/** Introspection for tests: current queue depth (queued + in-flight across all slots). */
export function __queueDepthForTests(): number {
  return queueLen();
}

/** Introspection for tests: the effective (clamped) pool size. */
export function __poolSizeForTests(): number {
  return poolSize();
}
