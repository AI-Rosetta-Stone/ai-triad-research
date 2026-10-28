// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Flight recorder initialization for the renderer process.
 *
 * Creates the global FlightRecorder instance, registers known dictionary
 * entries, wires auto-dump triggers (uncaught errors, unhandled rejections),
 * exposes window.__flightRecorder for dev console access, and registers
 * the Ctrl+Shift+D manual dump shortcut.
 */

import { FlightRecorder, setGlobalRecorder, getGlobalRecorder } from '@lib/flight-recorder/index';
import { RECORDER_CAPACITY_DEFAULT } from '@lib/flight-recorder/constants';
import type { RecordInput, TriggerType } from '@lib/flight-recorder/types';
import { api } from '@bridge';
import { getClientConfig } from './clientConfig';
import { getResilienceState } from '../bridge/resilience';
import { showDumpToast, showDumpErrorToast, showDumpPendingToast } from './dumpToast';
import { getCurrentPhase } from '@lib/debate/phaseTransitions';

declare const __APP_VERSION__: string;
declare const __BUILD_DATE__: string;
declare const __BUILD_SHA__: string;
declare const __COMPONENT_VERSIONS__: Record<string, string>;

function getDeploymentMode(): string {
  const target = import.meta.env.VITE_TARGET;
  if (target === 'web') return 'web-container';
  if (import.meta.env.DEV) return 'electron-dev';
  return 'electron-prod';
}

function getElectronAPI(): {
  processVersions?: Record<string, string | undefined>;
  osRelease?: string;
  osPlatform?: string;
  osArch?: string;
  getEmbeddingInfo?: () => Promise<{ backend: string; execution_provider?: string; calibration_version?: number }>;
} | undefined {
  return (window as unknown as { electronAPI?: ReturnType<typeof getElectronAPI> }).electronAPI;
}

// ── Cached embedding info (fetched once, used synchronously in context) ──
let _embeddingInfo: { backend: string; execution_provider?: string; calibration_version?: number } | null = null;
void getElectronAPI()?.getEmbeddingInfo?.().then(info => { _embeddingInfo = info; }).catch(() => {});

// ── Cached auth state (fetched once, used synchronously in context) ──
let _authState: { mode: string; user_type: string; session_created_at?: string } | null = null;
if (getElectronAPI()) {
  _authState = { mode: 'local', user_type: 'authenticated' };
} else {
  void fetch('/api/auth/me').then(r => r.ok ? r.json() : null).then(data => {
    if (!data) return;
    const isAnon = !!(data as { anonymous?: boolean }).anonymous;
    // session_created_at: server-provided anon-session mint time (first-seen for legacy sessions),
    // exposed on /api/auth/me per t/2493. Absent for authenticated/Electron. Session age explains
    // stale debate references in dumps (t/2490 Gap 1).
    const createdAt = (data as { session_created_at?: unknown }).session_created_at;
    _authState = {
      mode: isAnon ? 'optional' : 'required',
      user_type: isAnon ? 'anonymous' : 'authenticated',
      ...(typeof createdAt === 'string' ? { session_created_at: createdAt } : {}),
    };
  }).catch(() => { /* flight recorder init — silent by design */ });
}

// ── Auth flow redirect tracking (sessionStorage-based) ──────────────────

const AUTH_REDIRECT_KEY = 'auth-redirect-tracking';
const AUTH_LOOP_THRESHOLD = 3;
const AUTH_LOOP_WINDOW_MS = 30_000;

interface AuthRedirectTracking {
  provider: string;
  timestamp: number;
  redirectCount: number;
}

function getAuthTracking(): AuthRedirectTracking | null {
  try {
    const raw = sessionStorage.getItem(AUTH_REDIRECT_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as AuthRedirectTracking;
  // eslint-disable-next-line local/require-flight-recorder-in-catch -- flight recorder init code cannot record to itself
  } catch { return null; }
}

function setAuthTracking(state: AuthRedirectTracking): void {
  try { sessionStorage.setItem(AUTH_REDIRECT_KEY, JSON.stringify(state)); }
  catch { /* flight recorder init — silent by design */ }
}

function clearAuthTracking(): void {
  try { sessionStorage.removeItem(AUTH_REDIRECT_KEY); }
  catch { /* flight recorder init — silent by design */ }
}

// ── Dump throttle state ──────────────────────────────────────────────────

let lastDumpTime = 0;
let dumpCountInWindow = 0;
let windowStart = 0;
let autoDumpDisabled = false;

function dumpCfg() { return getClientConfig().flightRecorder; }

function canAutoDump(): boolean {
  if (autoDumpDisabled) return false;
  const now = Date.now();

  // Reset window if expired
  if (now - windowStart > dumpCfg().dumpWindowMs) {
    windowStart = now;
    dumpCountInWindow = 0;
  }

  // Check min interval
  if (now - lastDumpTime < dumpCfg().minDumpIntervalMs) return false;

  // Check circuit breaker
  if (dumpCountInWindow >= dumpCfg().maxDumpsPerWindow) {
    autoDumpDisabled = true;
    console.warn('[flight-recorder] Auto-dump disabled: too many dumps in 60s window');
    return false;
  }

  return true;
}

function recordDump(): void {
  lastDumpTime = Date.now();
  dumpCountInWindow++;
}

// ── Dump persistence ─────────────────────────────────────────────────────

const isWeb = typeof window !== 'undefined' && !(window as unknown as { electronAPI?: unknown }).electronAPI;

async function persistDump(
  recorder: FlightRecorder,
  triggerType: TriggerType,
  error?: { name: string; message: string; stack?: string },
  context?: Record<string, unknown>,
): Promise<void> {
  let ndjson: string;
  try {
    ({ ndjson } = recorder.buildDump(triggerType, error, context));
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'flight-recorder',
      level: 'warn',
      message: 'Failed to build flight recorder dump',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    showDumpErrorToast({
      errorMessage: `Failed to build dump: ${String(err)}`,
      isWeb,
      ndjson: '',
      onRetry: () => { void persistDump(recorder, triggerType, error, context); },
    });
    return;
  }

  const dumpId = crypto.randomUUID();

  try {
    const result = await api.dumpFlightRecorder(ndjson, dumpId);
    console.log(`[flight-recorder] Dump saved: ${result.filePath} (dumpId=${dumpId})`);

    // In web mode the server writes its own dump correlated by dumpId inside the dump POST
    // (t/3049); the merged download (t/3068) serves both client + server by dumpId. No
    // separate server-dump call or admin trigger is needed here:
    //   - the fire-and-forget POST /api/admin/flight-recorder/dump was redundant since t/3049
    //     and only produced 403 noise for non-admins;
    //   - the uncorrelated POST /api/flight-recorder/server-dump call only fed the removed
    //     Server: link (its output was never part of the merged file).

    showDumpToast({
      filename: result.filename,
      filePath: result.filePath,
      isWeb,
      onCopy: () => { void api.clipboardWriteText(result.filePath); },
      onOpen: () => { void api.openFlightRecorderViewer(result.filePath); },
      dumpId: isWeb ? dumpId : undefined,
    });
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'flight-recorder',
      level: 'error',
      message: 'Failed to persist flight recorder dump',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    showDumpErrorToast({
      errorMessage: String(err),
      isWeb,
      ndjson,
      onRetry: () => { void persistDump(recorder, triggerType, error, context); },
    });
  }
}

// ── Popup shim ──────────────────────────────────────────────────────────

/**
 * Creates a thin flight recorder shim for popup windows.
 * Stamps _origin on each event and forwards to the main window's recorder via IPC.
 * No local ring buffer or dump logic.
 */
function createPopupShim(origin: string): FlightRecorder {
  // Create a minimal recorder (capacity 1 — we don't buffer locally)
  const shim = new FlightRecorder({ capacity: 1, dumpOnError: false, shim: true }); // t/2691: mark dumps as popup-shim in the FR header

  const electronAPI = (window as unknown as { electronAPI: { forwardFlightEvent: (event: RecordInput) => void } }).electronAPI;

  // Override record to forward via IPC instead of buffering locally
  shim.record = (input: RecordInput) => {
    const stamped: RecordInput = {
      ...input,
      data: { ...input.data, _origin: origin },
    };
    try {
      electronAPI.forwardFlightEvent(stamped);
    } catch {
      /* flight recorder init — silent by design (main window may have closed) */
    }
  };

  // Forward dictionary registrations to main recorder (deduped to reduce noise)
  const originalIntern = shim.intern.bind(shim);
  const _forwardedDictEntries = new Set<string>();
  shim.intern = (category: string, value: string) => {
    const handle = originalIntern(category, value);
    const key = `${category}/${value}`;
    const verbose = (window as unknown as { __FLIGHT_RECORDER_VERBOSE_DICT__?: boolean }).__FLIGHT_RECORDER_VERBOSE_DICT__;
    if (!verbose && _forwardedDictEntries.has(key)) return handle;
    _forwardedDictEntries.add(key);
    try {
      electronAPI.forwardFlightEvent({
        type: 'lifecycle',
        component: 'flight-recorder',
        level: 'debug',
        message: `Dictionary registration from ${origin}`,
        data: { _origin: origin, _dict_category: category, _dict_value: `${origin}/${value}` },
      });
    } catch { /* flight recorder init — silent by design */ }
    return handle;
  };

  shim.record({
    type: 'lifecycle',
    component: 'flight-recorder',
    level: 'info',
    message: `Popup shim initialized (forwarding to main)`,
    data: { origin },
  });

  return shim;
}

/**
 * BroadcastChannel-based shim for web-container popup windows.
 * Mirrors createPopupShim but uses BroadcastChannel instead of Electron IPC.
 */
function createWebPopupShim(origin: string): FlightRecorder {
  const shim = new FlightRecorder({ capacity: 1, dumpOnError: false, shim: true }); // t/2691: mark dumps as popup-shim in the FR header
  const channel = new BroadcastChannel('aitriad-flight-recorder');

  shim.record = (input: RecordInput) => {
    const stamped: RecordInput = {
      ...input,
      data: { ...input.data, _origin: origin },
    };
    try {
      channel.postMessage({ type: 'event', payload: stamped });
    } catch {
      /* flight recorder init — silent by design (main tab may have closed) */
    }
  };

  const originalIntern = shim.intern.bind(shim);
  const _forwardedDictEntries = new Set<string>();
  shim.intern = (category: string, value: string) => {
    const handle = originalIntern(category, value);
    const key = `${category}/${value}`;
    if (_forwardedDictEntries.has(key)) return handle;
    _forwardedDictEntries.add(key);
    try {
      channel.postMessage({
        type: 'event',
        payload: {
          type: 'lifecycle',
          component: 'flight-recorder',
          level: 'debug',
          message: `Dictionary registration from ${origin}`,
          data: { _origin: origin, _dict_category: category, _dict_value: `${origin}/${value}` },
        } satisfies RecordInput,
      });
    } catch { /* flight recorder init — silent by design */ }
    return handle;
  };

  shim.record({
    type: 'lifecycle',
    component: 'flight-recorder',
    level: 'info',
    message: 'Web popup shim initialized (forwarding via BroadcastChannel)',
    data: { origin },
  });

  return shim;
}

// ── Initialization ───────────────────────────────────────────────────────

let initialized = false;

// In a popup window, the real (capacity-5000) recorder lives in the MAIN window;
// this window holds only a capacity-1 forwarding shim. Set in the popup init path
// below to the popup's dump handler (IPC / BroadcastChannel → main window) so that
// triggerManualDump() — imported directly by the "Dump Log" UI buttons — delegates
// to it instead of persisting the empty local shim buffer (t/2690). null in the
// main window, where triggerManualDump persists the real recorder directly.
let _popupDumpHandler: (() => void) | null = null;

// Defer store import to avoid circular dependency — resolved on first context/dump call.
// Module-scoped so both initFlightRecorder and dumpOnReactError can access it.
let _stores: { useDebateStore: unknown; useTaxonomyStore: unknown } | null = null;
function getStores() {
  if (!_stores) {
    try {
      const debateMod = (window as unknown as Record<string, unknown>).__ZUSTAND_STORES__ as Record<string, unknown> | undefined;
      const d = debateMod?.debate;
      const t = debateMod?.taxonomy;
      if (d && t) _stores = { useDebateStore: d, useTaxonomyStore: t };
    } catch { /* flight recorder init — silent by design (stores not ready yet) */ }
  }
  return _stores;
}

// ── Source-map resolution for component_stack (DEV-only) ──────────────────
// Inline VLQ decoder avoids bundling source-map-js into the renderer.
// Only runs in import.meta.env.DEV — stripped from prod builds by Vite tree-shaking.

const _SM_B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function _vlqDecode(str: string): number[] {
  const out: number[] = [];
  let v = 0, s = 0;
  for (const ch of str) {
    const d = _SM_B64.indexOf(ch);
    if (d < 0) break;
    v += (d & 31) << s; s += 5;
    if (!(d & 32)) { out.push(v & 1 ? -(v >> 1) : v >> 1); v = 0; s = 0; }
  }
  return out;
}

interface _SM { sources: string[]; mappings: string }
const _smCache = new Map<string, _SM | null>();

async function _fetchSM(url: string): Promise<_SM | null> {
  if (!import.meta.env.DEV) return null; // tree-shaking backup — callers already guard, but belt-and-suspenders
  const parsed = new URL(url, location.href);
  if (parsed.origin !== location.origin) return null; // same-origin only: prevents outbound fetches in Electron dev
  const key = parsed.pathname; // pathname as cache key — matches u.path from vite:beforeUpdate for invalidation
  if (_smCache.has(key)) return _smCache.get(key) ?? null;
  try {
    const r = await fetch(`${key}.map`); // bare fetch approved: flightRecorderInit must work when bridge is broken
    if (!r.ok) { _smCache.set(key, null); return null; }
    const sm = await r.json() as _SM;
    _smCache.set(key, sm); return sm;
    // eslint-disable-next-line local/require-warn-on-degraded-catch-return -- benign dev-only source-map fetch (import.meta.env.DEV-gated); failure caches null + returns null, callers guard; must not affect app (t/3222)
  } catch { /* telemetry — silent by design: source map fetch failures must not affect app */ _smCache.set(key, null); return null; }
}

function _smResolve(sm: _SM, gl: number, gc: number): string | null {
  const segs = sm.mappings.split(';')[gl]?.split(',') ?? [];
  let si = 0, sl = 0, sc = 0, col = 0;
  let best: { si: number; sl: number; sc: number } | null = null;
  for (const seg of segs) {
    if (!seg) continue;
    const f = _vlqDecode(seg);
    if (f.length < 4) continue;
    col += f[0]; si += f[1]; sl += f[2]; sc += f[3];
    if (col <= gc) best = { si, sl, sc };
    if (col > gc) break;
  }
  if (!best) return null;
  const raw = sm.sources[best.si];
  if (!raw) return null;
  const src = raw.replace(/^.*?[/\\]src[/\\]/, 'src/').replace(/\\/g, '/');
  return `${src}:${best.sl + 1}:${best.sc + 1}`;
}

async function _resolveStack(stack: string): Promise<string> {
  const lines = stack.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    const m = line.match(/at\s+(\S+)\s+\(?(https?:\/\/[^)\s]+):(\d+):(\d+)\)?/);
    if (!m) { out.push(line); continue; }
    const sm = await _fetchSM(m[2]).catch(() => null);
    if (!sm) { out.push(line); continue; }
    const pos = _smResolve(sm, +m[3] - 1, +m[4] - 1);
    out.push(pos ? `    at ${m[1]} (${pos})` : line);
  }
  return out.join('\n');
}

// ── initFlightRecorder helpers ───────────────────────────────────────────

/** Derives window identity (isPopup + windowId) from the URL hash. */
function resolveWindowId(hash: string): { isPopup: boolean; windowId: string } {
  const isPopup =
    hash.startsWith('#debate-window') ||
    hash === '#diagnostics-window' ||
    hash === '#pov-progression-window' ||
    hash === '#chat-window';
  let windowId = 'main';
  if (hash.startsWith('#debate-window')) {
    windowId = `debate:${new URLSearchParams(hash.split('?')[1] || '').get('id')?.slice(0, 8) || 'unknown'}`;
  } else if (hash === '#diagnostics-window') {
    windowId = 'diagnostics';
  } else if (hash === '#pov-progression-window') {
    windowId = 'pov-progression';
  } else if (hash === '#chat-window') {
    windowId = 'chat';
  }
  return { isPopup, windowId };
}

/** Wires __onErrorBoundaryCatch on a popup shim to forward the crash synchronously. */
function registerPopupErrorBoundary(shim: FlightRecorder, error: Error, componentStack?: string): void {
  shim.record({
    type: 'system.error',
    component: 'react-error-boundary',
    level: 'fatal',
    message: error.message,
    error: { name: error.name, message: error.message, stack: error.stack?.slice(0, 500) },
    data: componentStack ? { component_stack: componentStack.slice(0, 1000) } : undefined,
  });
  // DEV-only: resolve bundle positions to source coordinates and forward as a
  // follow-up enrichment (lifecycle, not a second crash) once resolution completes.
  if (import.meta.env.DEV && componentStack) {
    void _resolveStack(componentStack).then(resolved => {
      shim.record({
        type: 'lifecycle',
        component: 'react-error-boundary',
        level: 'debug',
        message: `Resolved component stack for: ${error.message}`,
        data: { component_stack_resolved: resolved.slice(0, 1000) },
      });
    }).catch(() => { /* source-map resolution is best-effort */ });
  }
}

/** Sets up the popup dump handler (IPC or BroadcastChannel → main) and stores it module-level. */
function registerPopupDumpHandler(
  shim: FlightRecorder,
  windowId: string,
  hasElectronIPC: boolean,
  hasBroadcastChannel: boolean,
): void {
  const popupDumpHandler = () => {
    shim.record({ type: 'lifecycle', component: 'flight-recorder', level: 'info', message: 'Manual dump requested from popup' });
    if (hasElectronIPC) {
      try {
        const eApi = (window as unknown as { electronAPI: { triggerMainDump?: () => Promise<{ filePath: string }> } }).electronAPI;
        if (eApi.triggerMainDump) {
          void eApi.triggerMainDump().then(result => {
            console.log(`[flight-recorder] Dump saved: ${result.filePath}`);
            void api.clipboardWriteText(result.filePath);
          });
        }
      } catch { /* flight recorder init — silent by design (dump request forwarded as event) */ }
    } else if (hasBroadcastChannel) {
      const ch = new BroadcastChannel('aitriad-flight-recorder');
      ch.postMessage({ type: 'dump-request', origin: windowId });
      ch.close();
    }
  };
  _popupDumpHandler = popupDumpHandler;
  (globalThis as unknown as { __triggerManualDump: () => Promise<void> | void }).__triggerManualDump = popupDumpHandler;
}

/**
 * Initializes a popup shim recorder (IPC or BroadcastChannel forwarding to main).
 * Returns the shim if the window has a forwarding transport, null otherwise.
 */
function initPopupRecorder(windowId: string): FlightRecorder | null {
  const hasElectronIPC = typeof (window as unknown as { electronAPI?: { forwardFlightEvent?: unknown } }).electronAPI?.forwardFlightEvent === 'function';
  const hasBroadcastChannel = typeof BroadcastChannel !== 'undefined';

  if (!hasElectronIPC && !hasBroadcastChannel) return null;

  const shim = hasElectronIPC
    ? createPopupShim(windowId)
    : createWebPopupShim(windowId);
  setGlobalRecorder(shim);

  // Set up error boundary hook for popup — forward crash event to main window's recorder
  // Forward the crash SYNCHRONOUSLY first (t/2297) so it reaches the main
  // recorder before the user can click "Dump Log".
  (globalThis as unknown as { __onErrorBoundaryCatch: (err: Error, stack?: string) => void }).__onErrorBoundaryCatch = (error, componentStack) => {
    registerPopupErrorBoundary(shim, error, componentStack);
  };

  // Set up manual dump trigger for popup — request main window to dump.
  // Stored in module-level _popupDumpHandler AND on globalThis so both the
  // error-boundary hook (globalThis) and the "Dump Log" UI buttons (which
  // import triggerManualDump directly) route through this IPC/BroadcastChannel
  // forwarder instead of persisting the empty local shim buffer (t/2690).
  registerPopupDumpHandler(shim, windowId, hasElectronIPC, hasBroadcastChannel);

  return shim;
}

/** Registers all known dictionary entries into the recorder. */
function registerDictionary(recorder: FlightRecorder): void {
  recorder.intern('component', 'debate-engine');
  recorder.intern('component', 'turn-pipeline');
  recorder.intern('component', 'qbaf');
  recorder.intern('component', 'moderator');
  recorder.intern('component', 'ai-adapter');
  recorder.intern('component', 'argument-network-extraction');
  recorder.intern('component', 'debate-store');
  recorder.intern('component', 'convergence-signals');
  recorder.intern('component', 'phase-transitions');
  recorder.intern('component', 'flight-recorder');
  recorder.intern('component', 'bridge');
  recorder.intern('component', 'taxonomy-store');
  recorder.intern('component', 'reflection-edit');
  recorder.intern('component', 'hmr');

  recorder.intern('pov', 'accelerationist');
  recorder.intern('pov', 'safetyist');
  recorder.intern('pov', 'skeptic');
}

/** Wraps recorder.record to stamp _origin on all events from this window. */
function wrapRecordWithOrigin(recorder: FlightRecorder, windowId: string): void {
  const originalRecord = recorder.record.bind(recorder);
  recorder.record = (input: RecordInput) => {
    originalRecord({
      ...input,
      data: { ...input.data, _origin: input.data?._origin ?? windowId },
    });
  };
}

/** Reads/increments the sessionStorage load-generation counter. Returns the current generation. */
function loadLoadGeneration(): number {
  let loadGeneration = 0;
  try {
    const prev = sessionStorage.getItem('flight-recorder-load-gen');
    loadGeneration = prev ? (parseInt(prev, 10) || 0) + 1 : 0;
    sessionStorage.setItem('flight-recorder-load-gen', String(loadGeneration));
  } catch { /* flight recorder init — silent by design (sessionStorage may be unavailable) */ }
  return loadGeneration;
}

/** Records the lifecycle:initialized startup event. */
function recordInitEvent(recorder: FlightRecorder, windowId: string, loadGeneration: number): void {
  recorder.record({
    type: 'lifecycle',
    component: recorder.intern('component', 'flight-recorder') as string | number,
    level: 'info',
    message: 'Flight recorder initialized',
    data: { capacity: RECORDER_CAPACITY_DEFAULT, window: windowId, load_generation: loadGeneration },
  });
}

/** Wires HMR lifecycle events into the recorder (dev-only, no-op in prod). */
function registerHmrListeners(recorder: FlightRecorder, loadGeneration: number): void {
  if (!import.meta.hot) return;
  import.meta.hot.on('vite:beforeUpdate', (payload: { type: string; updates: Array<{ type: string; path: string; acceptedPath: string; timestamp: number }> }) => {
    // Invalidate cached source maps for updated files so next resolution fetches fresh maps
    for (const u of payload.updates) _smCache.delete(u.path.replace(/\?.*$/, ''));
    recorder.record({
      type: 'lifecycle',
      component: 'hmr',
      level: 'info',
      message: `HMR update: ${payload.updates.map(u => u.path).join(', ')}`,
      data: { update_count: payload.updates.length, paths: payload.updates.map(u => u.path), load_generation: loadGeneration },
    });
  });

  import.meta.hot.on('vite:beforeFullReload', () => {
    recorder.record({
      type: 'lifecycle',
      component: 'hmr',
      level: 'warn',
      message: 'Full page reload triggered by HMR',
      data: { load_generation: loadGeneration },
    });
  });

  import.meta.hot.on('vite:error', (payload: { err: { message: string; stack: string } }) => {
    recorder.record({
      type: 'system.error',
      component: 'hmr',
      level: 'error',
      message: `HMR error: ${payload.err.message}`,
      error: { name: 'HMRError', message: payload.err.message, stack: payload.err.stack?.slice(0, 500) },
      data: { load_generation: loadGeneration },
    });
  });
}

/** Records the auth callback landing event for loop detection. */
function recordAuthCallbackLanding(
  recorder: FlightRecorder,
  tracking: AuthRedirectTracking,
  elapsed: number,
): void {
  // NOTE (t/2024, CodeQL js/user-controlled-bypass #5314 — dismissed as false
  // positive, TL-approved p/56#192): this cookie read is DIAGNOSTIC ONLY. It
  // populates the `has_session_cookie` telemetry field below and gates NO security
  // decision — the auth-loop branch keys on redirectCount/elapsed, never on this
  // value. Do not treat `hasSession` as an authorization signal.
  const hasSession = document.cookie.includes('AppServiceAuthSession');
  recorder.record({
    type: 'auth.callback_landing',
    component: 'auth',
    level: 'info',
    message: `OAuth callback: provider=${tracking.provider}, redirects=${tracking.redirectCount}`,
    data: {
      provider: tracking.provider,
      principal: (_authState as { principalName?: string } | null)?.principalName ?? null,
      has_session_cookie: hasSession,
      redirect_count: tracking.redirectCount,
      elapsed_ms: elapsed,
    },
  });
}

/** Handles an auth redirect loop: records the loop event and triggers a dump. */
function handleAuthRedirectLoop(
  recorder: FlightRecorder,
  tracking: AuthRedirectTracking,
  elapsed: number,
): void {
  recorder.record({
    type: 'auth.loop_detected',
    component: 'auth',
    level: 'error',
    message: `Auth redirect loop detected: ${tracking.redirectCount} redirects in ${elapsed}ms`,
    data: {
      provider: tracking.provider,
      redirect_count: tracking.redirectCount,
      elapsed_ms: elapsed,
      threshold: AUTH_LOOP_THRESHOLD,
      window_ms: AUTH_LOOP_WINDOW_MS,
    },
  });
  clearAuthTracking();
  void persistDump(recorder, 'explicit', undefined, { reason: 'auth_loop_detected', provider: tracking.provider });
}

/** Wires auth flow instrumentation (web main window only): redirect tracking + loop detection. */
function initAuthInstrumentation(recorder: FlightRecorder): void {
  // On init: detect if we just returned from an OAuth redirect
  const tracking = getAuthTracking();
  if (tracking) {
    const elapsed = Date.now() - tracking.timestamp;
    if (elapsed > 60_000) {
      clearAuthTracking();
    } else {
      recordAuthCallbackLanding(recorder, tracking, elapsed);
      if (tracking.redirectCount >= AUTH_LOOP_THRESHOLD && elapsed < AUTH_LOOP_WINDOW_MS) {
        handleAuthRedirectLoop(recorder, tracking, elapsed);
      } else {
        clearAuthTracking();
      }
    }
  }

  // Delegated click handler: capture auth login link clicks
  document.addEventListener('click', (e) => {
    const anchor = (e.target as HTMLElement).closest?.('a[href*="/api/auth/fresh-login/"]') as HTMLAnchorElement | null;
    if (!anchor) return;
    const href = anchor.getAttribute('href') ?? '';
    const providerMatch = href.match(/\/api\/auth\/fresh-login\/([^/?#]+)/);
    const provider = providerMatch?.[1] ?? 'unknown';

    const existing = getAuthTracking();
    const now = Date.now();
    const count = (existing && existing.provider === provider && (now - existing.timestamp) < AUTH_LOOP_WINDOW_MS)
      ? existing.redirectCount + 1
      : 1;
    setAuthTracking({ provider, timestamp: now, redirectCount: count });

    recorder.record({
      type: 'auth.login_attempt',
      component: 'auth',
      level: 'info',
      message: `Auth login initiated: provider=${provider}`,
      data: { provider, redirect_count: count, href },
    });
  }, true);
}

/** Detects the device form factor from the user agent. */
function detectDevicePlatform(): string {
  if (/iPad|Macintosh.*Mobile/i.test(navigator.userAgent)) return 'ipad';
  if (/iPhone/i.test(navigator.userAgent)) return 'iphone';
  if (/Android/i.test(navigator.userAgent)) return 'android';
  return 'desktop';
}

/** Builds the open-circuit snapshot for the network resilience context field. */
function getOpenCircuits(): Record<string, { state: string; failures: number; recent?: string[] }> | undefined {
  const rs = getResilienceState();
  const out: Record<string, { state: string; failures: number; recent?: string[] }> = {};
  for (const [cat, c] of Object.entries(rs.circuits)) {
    if (c.state !== 'CLOSED' || c.consecutiveFailures > 0) {
      out[cat] = { state: c.state, failures: c.consecutiveFailures, ...(c.recentFailures.length > 0 ? { recent: c.recentFailures } : {}) };
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Returns the context provider callback for recorder.setContextProvider.
 * See operations/diagnostics/flight-recorder-context-spec.md for field descriptions.
 * MUST be synchronous, handle uninitialized stores, no secrets, target <2KB.
 */
function buildContextProvider(recorder: FlightRecorder): () => Record<string, unknown> {
  return () => {
    try {
      const stores = getStores();
      if (!stores) return {};
      const useDebateStore = stores.useDebateStore as { getState: () => any };
      const useTaxonomyStore = stores.useTaxonomyStore as { getState: () => any };

      const taxState = useTaxonomyStore.getState();
      const debateState = useDebateStore.getState();
      const debate = debateState.activeDebate;
      const mem = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory;
      const eApi = getElectronAPI();
      const pv = eApi?.processVersions;

      return {
        app: {
          version: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : undefined,
          build_date: typeof __BUILD_DATE__ !== 'undefined' ? __BUILD_DATE__ : undefined,
          build_commit_sha: typeof __BUILD_SHA__ !== 'undefined' ? __BUILD_SHA__ : undefined,
          build_fingerprint: `build-${(window as unknown as { __BUILD_FINGERPRINT?: string }).__BUILD_FINGERPRINT ?? 'unknown'}`,
          deployment_mode: getDeploymentMode(),
          vite_target: import.meta.env.VITE_TARGET ?? 'electron',
          platform: eApi?.osPlatform ?? navigator.platform,
          arch: eApi?.osArch ?? (navigator.userAgent.includes('arm64') ? 'arm64' : 'x64'),
          os: eApi?.osPlatform ?? navigator.platform,
          os_version: eApi?.osRelease ?? undefined,
        },
        device: {
          platform: detectDevicePlatform(),
          touchPoints: navigator.maxTouchPoints,
          standalone: window.matchMedia('(display-mode: standalone)').matches,
        },
        windows: {
          main: {
            active_tab: taxState.activeTab,
            toolbar_panel: taxState.toolbarPanel ?? null,
            selected_node_id: taxState.selectedNodeId ?? null,
          },
        },
        debate: debate ? {
          id: debate.id,
          // Community (read-only, viewing a shared debate) vs personal (editable). Lets
          // triage read the source directly instead of inferring it from a comments-404
          // error chain (t/2435). communityReadOnly is the store's durable representation
          // of the `source=community` load path.
          source: (debateState.communityReadOnly ? 'community' : 'personal') as 'community' | 'personal' | null,
          phase: debate.phase,
          adaptive_phase: getCurrentPhase(debate),
          transcript_length: debate.transcript?.length ?? 0,
          an_nodes: debate.argument_network?.nodes?.length ?? 0,
          model: debateState.debateModel,
          temperature: debateState.debateTemperature,
          is_generating: !!debateState.debateGenerating,
          convergence_signals_count: debate.convergence_signals?.length ?? 0,
          protocol: debate.protocol_id ?? null,
          calibration_version: _embeddingInfo?.calibration_version ?? undefined,
        } : null,
        taxonomy: {
          loaded: {
            accelerationist: taxState.accelerationist?.nodes?.length ?? 0,
            safetyist: taxState.safetyist?.nodes?.length ?? 0,
            skeptic: taxState.skeptic?.nodes?.length ?? 0,
            situations: taxState.situations?.nodes?.length ?? 0,
          },
          dirty_files: [...(taxState.dirty ?? [])],
          save_error: taxState.saveError ?? null,
          edges_count: taxState.edgesFile?.edges?.length ?? 0,
        },
        ai: {
          backend: taxState.aiBackend,
          model: taxState.geminiModel,
        },
        embeddings: _embeddingInfo ? {
          backend: _embeddingInfo.backend,
          execution_provider: _embeddingInfo.execution_provider,
        } : undefined,
        diagnostics: {
          enabled: !!debateState.diagnosticsEnabled,
          selected_entry: debateState.selectedDiagEntry ?? null,
        },
        auth: _authState ?? { mode: 'unknown', user_type: 'unknown' },
        network: {
          online: navigator.onLine,
          deployment_mode: getDeploymentMode(),
          resilience: getOpenCircuits(),
        },
        performance: {
          uptime_s: Math.round(performance.now() / 1000),
          heap_used_mb: mem ? Math.round(mem.usedJSHeapSize / 1048576) : undefined,
          heap_total_mb: mem ? Math.round(mem.totalJSHeapSize / 1048576) : undefined,
          ring_buffer_utilization_pct: Math.round((recorder.buffer.retained / recorder.buffer.capacity) * 100),
        },
        sbom: {
          node: pv?.node ?? undefined,
          electron: pv?.electron ?? undefined,
          chrome: pv?.chrome ?? undefined,
          v8: pv?.v8 ?? undefined,
          ...(typeof __COMPONENT_VERSIONS__ !== 'undefined' ? __COMPONENT_VERSIONS__ : {}),
        },
      };
      // eslint-disable-next-line local/require-warn-on-degraded-catch-return -- flight-recorder init assembling its own dump metadata; cannot record to the recorder it is bootstrapping (self-reference) — Error Recording Rule FR-init exception (t/3222)
    } catch {
      /* flight recorder init — silent by design (can't log to itself) */
      return {};
    }
  };
}

/** Wires the main window to receive forwarded events from popup windows. */
function initPopupForwarding(recorder: FlightRecorder): void {
  // Electron: receive via IPC
  const electronAPI = (window as unknown as { electronAPI?: { onFlightEventFromPopup?: (cb: (_e: unknown, payload: unknown) => void) => void } }).electronAPI;
  if (electronAPI?.onFlightEventFromPopup) {
    electronAPI.onFlightEventFromPopup((_e, payload) => {
      const event = payload as RecordInput;
      if (event.data?._dict_category && event.data?._dict_value) {
        recorder.intern(event.data._dict_category as string, event.data._dict_value as string);
      }
      recorder.record(event);
    });
  }

  // Web: receive via BroadcastChannel (mirrors IPC path for web-container popups)
  if (typeof BroadcastChannel !== 'undefined') {
    const frChannel = new BroadcastChannel('aitriad-flight-recorder');
    frChannel.onmessage = (msg: MessageEvent<{ type: string; payload?: RecordInput; origin?: string }>) => {
      if (msg.data.type === 'event' && msg.data.payload) {
        const event = msg.data.payload;
        if (event.data?._dict_category && event.data?._dict_value) {
          recorder.intern(event.data._dict_category as string, event.data._dict_value as string);
        }
        recorder.record(event);
      } else if (msg.data.type === 'dump-request') {
        void persistDump(recorder, 'manual');
      }
    };
    if (import.meta.hot) {
      import.meta.hot.dispose(() => frChannel.close());
    }
  }
}

/** Extracts HMR module timestamps from an error stack (dev-only). */
function extractHmrTimestamps(stack?: string): Record<string, number> | undefined {
  if (!stack || !import.meta.env.DEV) return undefined;
  const matches: Record<string, number> = {};
  for (const m of stack.matchAll(/([^\s(]+)\?t=(\d+)/g)) {
    matches[m[1]] = Number(m[2]);
  }
  return Object.keys(matches).length > 0 ? matches : undefined;
}

/** Records and dumps an uncaught error event. */
function handleUncaughtError(recorder: FlightRecorder, err: Error, loadGeneration: number): void {
  const externalizedModule = extractExternalizedModule(err);
  recorder.record({
    type: 'system.error',
    component: 'unknown',
    level: 'fatal',
    message: err.message,
    error: { name: err.name, message: err.message, stack: err.stack?.slice(0, 500) },
    data: { hmr_timestamps: extractHmrTimestamps(err.stack), load_generation: loadGeneration, ...(externalizedModule ? { externalized_module: externalizedModule } : {}) },
  });
  if (canAutoDump()) {
    recordDump();
    void persistDump(recorder, 'uncaught_error', {
      name: err.name, message: err.message, stack: err.stack?.slice(0, 500),
    });
  }
  api.reportError(
    { name: err.name, message: err.message, stack: err.stack?.slice(0, 2000) },
    { trigger: 'uncaught_error', url: location.href, deploymentMode: getDeploymentMode() },
  ).catch(() => { /* telemetry — silent by design: error reporting failures must not cascade */ });
}

/** Records and dumps an unhandled promise rejection event. */
function handleUnhandledRejection(recorder: FlightRecorder, err: Error, loadGeneration: number): void {
  recorder.record({
    type: 'system.error',
    component: 'unknown',
    level: 'fatal',
    message: err.message,
    error: { name: err.name, message: err.message, stack: err.stack?.slice(0, 500) },
    data: { hmr_timestamps: extractHmrTimestamps(err.stack), load_generation: loadGeneration },
  });
  if (canAutoDump()) {
    recordDump();
    void persistDump(recorder, 'unhandled_rejection', {
      name: err.name, message: err.message, stack: err.stack?.slice(0, 500),
    });
  }
  api.reportError(
    { name: err.name, message: err.message, stack: err.stack?.slice(0, 2000) },
    { trigger: 'unhandled_rejection', url: location.href, deploymentMode: getDeploymentMode() },
  ).catch(() => { /* telemetry — silent by design: error reporting failures must not cascade */ });
}

/** Registers window error, unhandledrejection, and keyboard dump-trigger listeners. */
function initAutoDumpTriggers(recorder: FlightRecorder, loadGeneration: number): void {
  window.addEventListener('error', (event) => {
    const err = event.error instanceof Error ? event.error : new Error(String(event.error ?? event.message));
    // An externalized-builtin link failure can throw at module eval, before React
    // mounts — so it surfaces here rather than via the error boundary. Name the
    // module in the dump either way (t/2551 observability arm).
    handleUncaughtError(recorder, err, loadGeneration);
  });

  window.addEventListener('unhandledrejection', (event) => {
    const err = event.reason instanceof Error ? event.reason : new Error(String(event.reason));
    handleUnhandledRejection(recorder, err, loadGeneration);
  });

  // ── Keyboard shortcut: Ctrl+Alt+D for manual dump ──
  // (Ctrl+Shift+D is consumed by Chrome's "Bookmark all tabs")
  document.addEventListener('keydown', (event) => {
    if (event.ctrlKey && event.altKey && event.key === 'd') {
      event.preventDefault();
      void triggerManualDump();
      console.log('[flight-recorder] Manual dump triggered via Ctrl+Alt+D');
    }
  });
}

/** Wires the Electron IPC listener that lets popup windows trigger a main-window dump. */
function initPopupDumpRelay(recorder: FlightRecorder): void {
  const eApi = (window as unknown as { electronAPI?: { onTriggerDump?: (cb: () => void) => () => void; sendDumpResult?: (r: { filePath: string }) => void } }).electronAPI;
  if (!eApi?.onTriggerDump || !eApi?.sendDumpResult) return;
  eApi.onTriggerDump(() => {
    const { ndjson } = recorder.buildDump('manual');
    void api.dumpFlightRecorder(ndjson).then(result => {
      eApi.sendDumpResult!({ filePath: result.filePath });
      console.log(`[flight-recorder] Dump triggered by popup, saved: ${result.filePath}`);
    }).catch(err => {
      console.warn('[flight-recorder] Popup-triggered dump failed:', err);
      eApi.sendDumpResult!({ filePath: '' });
    });
  });
}

// ── Public API ───────────────────────────────────────────────────────────

export function initFlightRecorder(): FlightRecorder {
  if (initialized) return getGlobalRecorder()!;
  initialized = true;

  const { isPopup, windowId } = resolveWindowId(window.location.hash);

  // Popup windows use a thin shim — no local buffer, forward everything to main.
  // Electron: IPC via electronAPI. Web: BroadcastChannel.
  if (isPopup) {
    const shim = initPopupRecorder(windowId);
    if (shim) return shim;
  }

  const recorder = new FlightRecorder({ capacity: RECORDER_CAPACITY_DEFAULT, dumpOnError: true });
  setGlobalRecorder(recorder);

  registerDictionary(recorder);
  wrapRecordWithOrigin(recorder, windowId);

  // Compute load_generation: increments on each page load/HMR within the same window tab
  const loadGeneration = loadLoadGeneration();

  // Set ambient window identity on all events
  recorder.setEventContext({ window_id: windowId, load_generation: loadGeneration });
  recordInitEvent(recorder, windowId, loadGeneration);

  // ── HMR lifecycle events (dev-only) ──
  registerHmrListeners(recorder, loadGeneration);

  // ── Auth flow instrumentation (web only, main window only) ──
  if (!isPopup && isWeb) {
    initAuthInstrumentation(recorder);
  }

  // ── Context provider (full app state snapshot for dump) ──
  recorder.setContextProvider(buildContextProvider(recorder));

  // ── Receive forwarded events from popup windows (main window only) ──
  if (!isPopup) {
    initPopupForwarding(recorder);
  }

  // ── Auto-dump triggers ──
  initAutoDumpTriggers(recorder, loadGeneration);

  // ── Dev console access ──
  (window as unknown as { __flightRecorder: FlightRecorder }).__flightRecorder = recorder;

  // ── ErrorBoundary hook (shared lib uses globalThis to avoid cross-app imports) ──
  (globalThis as unknown as { __onErrorBoundaryCatch: (err: Error, stack?: string) => void }).__onErrorBoundaryCatch = dumpOnReactError;

  // ── ErrorBoundary "Dump Log" button hook ──
  (globalThis as unknown as { __triggerManualDump: () => Promise<void> }).__triggerManualDump = triggerManualDump;

  // ── Listen for dump requests from popup windows (via main process relay) ──
  initPopupDumpRelay(recorder);

  return recorder;
}

let _dumpInFlight = false;

/** Whether a flight recorder dump is currently in progress. */
export function isDumpInProgress(): boolean { return _dumpInFlight; }

/**
 * Trigger a manual flight recorder dump from any UI component.
 * Shows an immediate pending toast, guards against overlapping dumps.
 */
export async function triggerManualDump(): Promise<void> {
  // In a popup window the real recorder lives in the MAIN window; the local
  // recorder is a capacity-1 forwarding shim. Delegate to the popup's dump handler
  // (IPC / BroadcastChannel → main window) instead of persisting the empty shim.
  // The "Dump Log" buttons import this function directly, bypassing the
  // globalThis.__triggerManualDump hook, so the popup check must live here (t/2690).
  if (_popupDumpHandler) {
    _popupDumpHandler();
    return;
  }
  const recorder = getGlobalRecorder();
  if (!recorder || _dumpInFlight) return;
  _dumpInFlight = true;
  const dismissPending = showDumpPendingToast();
  try {
    await persistDump(recorder, 'manual');
  } finally {
    _dumpInFlight = false;
    dismissPending();
  }
}

/**
 * Snapshot store state for crash diagnosis. Synchronous getState reads only, so
 * safe to run inline in the error path; only runs on error, no perf impact on
 * normal renders. Returns undefined if stores are unavailable or corrupted.
 */
function snapshotStoresForCrash(): Record<string, unknown> | undefined {
  try {
    const stores = getStores();
    if (!stores) return undefined;
    const taxState = (stores.useTaxonomyStore as { getState: () => Record<string, unknown> }).getState();
    const debateState = (stores.useDebateStore as { getState: () => Record<string, unknown> }).getState();
    const debate = debateState.activeDebate as Record<string, unknown> | null;
    // Session index-shape audit (t/2732): a session whose `title` is not a string
    // is the class of bad index entry that crashed BulkDeleteDialog (t/2729 —
    // rendered `{final, original}` as a React child). Surfacing the offending
    // session ids here cuts diagnosis from reading `listDebateSessionsIndexed`
    // end-to-end to a glance at the dump. Empty when every title is well-typed.
    const sessions = debateState.sessions as Array<{ id?: string; title?: unknown }> | undefined;
    const badSessionTitleIds = (sessions ?? [])
      .filter(s => typeof s?.title !== 'string')
      .map(s => s?.id)
      .filter((id): id is string => typeof id === 'string');
    return {
      active_tab: taxState.activeTab ?? null,
      toolbar_panel: taxState.toolbarPanel ?? null,
      selected_node_id: taxState.selectedNodeId ?? null,
      search_mode: taxState.findMode ?? null,
      search_query: (taxState.findQuery as string)?.slice(0, 200) || null,
      debate_phase: debate?.phase ?? null,
      debate_generating: !!debateState.debateGenerating,
      dirty_files: [...((taxState.dirty as Set<string>) ?? [])],
      // t/2732: surface sessions with non-string titles so index-shape bugs name the
      // offending session IDs immediately rather than after reading the full call path.
      debate_sessions_non_string_title_ids: badSessionTitleIds.length > 0 ? badSessionTitleIds : undefined,
    };
  } catch {
    /* flight recorder init — silent by design (store may be corrupted) */
    return undefined;
  }
}

/**
 * When a renderer-reachable module imports a Node built-in that Vite externalized
 * for the browser, accessing a named binding throws at bundle eval with a message
 * that names the module — e.g. `Module "child_process" has been externalized for
 * browser compatibility. Cannot access "child_process.execFileSync" in client code.`
 * (t/2550's crash). Surface that module id as a first-class dump field so the NEXT
 * such crash names its failing built-in / import chain instead of leaving triage to
 * a human repro (t/2551 observability arm; the vite.config.ts build gate is the
 * prevention arm). Returns undefined for ordinary errors.
 */
function extractExternalizedModule(error: Error): { module: string; accessed?: string } | undefined {
  const msg = String(error?.message ?? '');
  const mod = /Module "([^"]+)" has been externalized for browser compatibility/.exec(msg);
  if (!mod) return undefined;
  const accessed = /Cannot access "([^"]+)" in client code/.exec(msg)?.[1];
  return { module: mod[1], ...(accessed ? { accessed } : {}) };
}

/**
 * A React "invalid child" crash — rendering a non-primitive where a child is
 * expected — throws with a message like `Objects are not valid as a React child
 * (found: object with keys {final, original})`. Surface those keys as a first-class
 * dump field so the NEXT such crash names the offending shape instead of requiring a
 * human to read the producing code path (t/2732; the BulkDeleteDialog index-shape
 * crash, t/2729). Mirrors the extractExternalizedModule pattern above. Returns
 * undefined for ordinary errors.
 */
function extractInvalidReactChildKeys(error: Error): string[] | undefined {
  const m = /found: object with keys \{([^}]+)\}/.exec(String(error?.message ?? ''));
  return m ? m[1].split(',').map(k => k.trim()).filter(Boolean) : undefined;
}

/**
 * Called from ErrorBoundary.componentDidCatch to dump on React render errors.
 */
export function dumpOnReactError(
  error: Error,
  componentStack?: string,
): void {
  const recorder = getGlobalRecorder();
  if (!recorder) return;

  // Track immediately — error boundary dumps bypass cooldown
  recordDump();

  const stateSnapshot = snapshotStoresForCrash();
  const externalizedModule = extractExternalizedModule(error);
  const invalidReactChildKeys = extractInvalidReactChildKeys(error);
  const baseData: Record<string, unknown> = {
    ...(componentStack ? { component_stack: componentStack.slice(0, 1000) } : {}),
    ...(stateSnapshot ? { state_snapshot: stateSnapshot } : {}),
    ...(externalizedModule ? { externalized_module: externalizedModule } : {}),
    ...(invalidReactChildKeys ? { invalid_react_child_keys: invalidReactChildKeys } : {}),
  };

  // Record the crash SYNCHRONOUSLY, before any async work (t/2297). This guarantees
  // the crash lands in the ring buffer the instant the boundary fires — so a dump
  // that follows (auto or via the "Dump Log" button) can never be missing the very
  // error that triggered it. The DEV-only source-map resolution below is best-effort
  // enrichment for the dump's trigger context; it must not gate the buffered event.
  recorder.record({
    type: 'system.error',
    component: 'react-error-boundary',
    level: 'fatal',
    message: error.message,
    error: { name: error.name, message: error.message, stack: error.stack?.slice(0, 500) },
    data: Object.keys(baseData).length > 0 ? baseData : undefined,
  });

  void (async () => {
    // DEV-only: resolve bundle positions in component_stack to source coordinates
    // for the dump's trigger context (the buffered event above already stands alone).
    const resolvedStack = import.meta.env.DEV && componentStack
      ? await _resolveStack(componentStack).catch(() => undefined)
      : undefined;

    const dumpContext: Record<string, unknown> = {
      ...baseData,
      ...(resolvedStack !== undefined ? { component_stack_resolved: resolvedStack.slice(0, 1000) } : {}),
    };

    void persistDump(recorder, 'error_boundary', {
      name: error.name, message: error.message, stack: error.stack?.slice(0, 500),
    }, Object.keys(dumpContext).length > 0 ? dumpContext : undefined);

    // Report to server for aggregation
    api.reportError(
      { name: error.name, message: error.message, stack: error.stack?.slice(0, 2000), componentStack: componentStack?.slice(0, 1000) },
      { trigger: 'error_boundary', url: location.href, deploymentMode: getDeploymentMode() },
    ).catch(() => { /* telemetry — silent by design: error reporting failures must not cascade */ });
  })();
}
