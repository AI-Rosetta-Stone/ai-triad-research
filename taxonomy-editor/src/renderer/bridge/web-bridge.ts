// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Web bridge — implements AppAPI via REST and WebSocket calls to the server.
 * Used when the app runs in a browser served by the container.
 */
import type { AppAPI, SourceDocumentResolution, DebateDelta, UserPreferences, BriefExportJobView, BriefExportRecord, StartInquiryRequest, InquiryStatusResponse, InquiryResultSummary, InquiryResult } from './types';
import { pullDataUpdatesRest } from './dataUpdatesPull';
import { exportInquiryToFileWeb } from './inquiryExportWeb';
import { instrumentBridge } from './instrumentBridge';
import { makeCancellationError } from './cancellation';
import { ActionableError } from '@lib/debate/errors';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { ALL_API_KEY_BACKENDS } from '@lib/ai-client/types';
import type { OpEdSet, OpEdSetSummary } from '../../../../lib/oped/types';
import type { RefreshResult } from '@lib/electron-shared/modelDiscovery';
import { encryptKeysForSharing, decryptKeysFromSharing } from '../utils/keyShareCrypto';
import { resilientFetch, categorizeEndpoint, registerConnectionPoolProvider, type EndpointCategory } from './resilience';
import { nextStepsForStatus } from './httpErrorSteps';
import { computeEmbeddingsChunked } from './embeddingsBatch';
import { runChatStream, chatStreamBus } from './chatStream';
import { runOpEdCreate, cancelActiveOpEdRun, opedProgressBus } from './opedStream';
import { readByokKeys, maskByokKey } from './byokKeys';
import { onQuotaMilestone } from '../hooks/useQuotaWarning';
export { getResilienceState, subscribeResilience, resetResilience } from './resilience';
export type { ResilienceStatus, CircuitState, ThrottleState, EndpointCategory } from './resilience';

let _activeDebateId: string | null = null;
export function setActiveDebateId(id: string | null): void { _activeDebateId = id; }

function isMobilePlatform(): boolean {
  return /iPad|iPhone|iPod|Android/i.test(navigator.userAgent)
    || (navigator.maxTouchPoints > 1 && /Macintosh/i.test(navigator.userAgent));
}

function openAppWindow(hash: string): void {
  if (isMobilePlatform()) {
    window.location.hash = hash;
  } else {
    window.open(`${location.origin}/#${hash}`, '_blank');
  }
}

function throwHttpError(status: number, err: ActionableError): never {
  (err as ActionableError & { httpStatus: number }).httpStatus = status;
  throw err;
}

// nextStepsForStatus moved to ./httpErrorSteps (leaf module, unit-tested) — t/2366.

// ── Resilient fetch options for callers ──

interface FetchOptions {
  timeoutMs?: number;
  maxRetries?: number;
  idempotent?: boolean;
  critical?: boolean;
  /** Caller abort signal (t/2508) — threaded to the fetch so a deliberate cancel
   *  tears down the request; on abort `post` throws a tagged cancellation error. */
  signal?: AbortSignal;
}

const DEFAULT_READ_TIMEOUT_MS = 30_000;
const DEFAULT_MUTATION_TIMEOUT_MS = 180_000;
const DEBATE_SAVE_TIMEOUT_MS = 300_000;

function defaultMaxRetries(cat: EndpointCategory, method: string, idempotent?: boolean): number {
  if (cat === 'telemetry') return 0;
  if (method === 'GET') return 3;
  // AI mutations get 0 retries: the server already retries 5× per backend + model fallback chain (t/878)
  return idempotent ? 1 : 0;
}

function throwTimeoutError(method: string, path: string, timeoutMs: number): never {
  throw new ActionableError({
    goal: 'Call server API',
    problem: `${method} ${path} timed out after ${Math.round(timeoutMs / 1000)}s`,
    location: `web-bridge.${method.toLowerCase()}`,
    nextSteps: ['The server may be overloaded — try again', 'Check server logs for errors'],
  });
}

// ── Anonymous session recovery ──

let _sessionRecoveryInFlight: Promise<boolean> | null = null;

async function recoverAnonymousSession(): Promise<boolean> {
  if (_sessionRecoveryInFlight) return _sessionRecoveryInFlight;
  _sessionRecoveryInFlight = (async () => {
    try {
      getGlobalRecorder()?.record({
        type: 'auth.session-recovery',
        component: 'web-bridge',
        level: 'info',
        message: 'Attempting anonymous session recovery via POST /api/auth/anonymous',
      });
      // bare fetch: this IS the recovery path that post() calls on 401 — using post() here would loop
      const res = await fetch('/api/auth/anonymous', {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
      });
      return res.ok;
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'auth.session-recovery',
        component: 'web-bridge',
        level: 'error',
        message: 'Anonymous session recovery failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      return false;
    } finally {
      _sessionRecoveryInFlight = null;
    }
  })();
  return _sessionRecoveryInFlight;
}

async function isNoSessionResponse(res: Response): Promise<boolean> {
  if (res.status !== 401) return false;
  try {
    const data = await res.clone().json() as Record<string, unknown>;
    return data.reason === 'no_session';
  } catch { /* telemetry — silent by design: non-JSON 401 is simply not a no_session response */ }
  return false;
}

// ── Auth state cache ──

let _authAnonymous: boolean | null = null;

// An auth-wall failure can surface two ways: a 401 { reason: 'no_session' }
// (JSON) or an HTTP 200 whose body is the login page (Content-Type: text/html).
// isNoSessionResponse only sees the former; isHtmlLoginPage covers the latter.
function isHtmlLoginPage(res: Response): boolean {
  return (res.headers.get('content-type') ?? '').includes('text/html');
}

async function fetchWithSessionRecovery(
  path: string,
  init: RequestInit,
  opts: import('./resilience').ResilientFetchOptions,
): Promise<Response> {
  let res = await resilientFetch(path, init, opts);
  if (await isNoSessionResponse(res) || isHtmlLoginPage(res)) {
    const recovered = await recoverAnonymousSession();
    if (recovered) {
      _authAnonymous = true;
      res = await resilientFetch(path, init, opts);
    }
  }
  return res;
}

async function isAnonymous(): Promise<boolean> {
  if (_authAnonymous !== null) return _authAnonymous;
  try {
    const res = await fetch('/api/auth/me');
    if (res.ok) {
      const data = await res.json();
      _authAnonymous = !!data.anonymous;
    } else {
      _authAnonymous = true;
    }
  } catch (err) {
    getGlobalRecorder()?.record({ type: 'system.error', component: 'web-bridge', level: 'warn', message: 'Auth check failed', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
    _authAnonymous = true;
  }
  return _authAnonymous;
}

// ── HTTP helpers ──

async function get<T = unknown>(path: string, opts?: FetchOptions): Promise<T> {
  const cat = categorizeEndpoint(path, 'GET');
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
  let res: Response;
  try {
    res = await fetchWithSessionRecovery(path, {}, {
      timeoutMs,
      maxRetries: opts?.maxRetries ?? defaultMaxRetries(cat, 'GET'),
      critical: opts?.critical ?? true,
      category: cat,
    });
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'web-bridge',
      level: 'error',
      message: `GET ${path} network error`,
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    if (err instanceof DOMException && err.name === 'AbortError') {
      throwTimeoutError('GET', path, timeoutMs);
    }
    throw err;
  }
  if (!res.ok) {
    const text = await res.text();
    throwHttpError(res.status, new ActionableError({
      goal: 'Fetch data from server',
      problem: `GET ${path} failed with HTTP ${res.status}: ${text}`,
      location: 'web-bridge.get',
      nextSteps: nextStepsForStatus(res.status, text),
    }));
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('text/html')) {
    throw new ActionableError({
      goal: 'Load data from server',
      problem: 'Server returned a login page instead of JSON data — authentication may be required',
      location: `web-bridge.get ${path}`,
      nextSteps: ['Sign in or navigate to /.auth/anonymous to start an anonymous session'],
    });
  }
  return res.json();
}

async function post<T = unknown>(path: string, body?: unknown, opts?: FetchOptions, extraHeaders?: Record<string, string>): Promise<T> {
  const cat = categorizeEndpoint(path, 'POST');
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_MUTATION_TIMEOUT_MS;
  let res: Response;
  try {
    res = await fetchWithSessionRecovery(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...extraHeaders },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }, {
      timeoutMs,
      maxRetries: opts?.maxRetries ?? defaultMaxRetries(cat, 'POST', opts?.idempotent),
      critical: opts?.critical ?? (cat !== 'telemetry'),
      category: cat,
      signal: opts?.signal,
    });
  } catch (err) {
    // Caller-initiated cancel (t/2508: Switch model / Cancel debate) — not a network
    // error and not a timeout. Skip the scary system.error and propagate a distinguishable
    // tagged cancellation so pipeline catches bail quietly (no toast, no retry).
    if (opts?.signal?.aborted) {
      throw makeCancellationError(`POST ${path} cancelled by caller`);
    }
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'web-bridge',
      level: 'error',
      message: `POST ${path} network error`,
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    if (err instanceof DOMException && err.name === 'AbortError') {
      throwTimeoutError('POST', path, timeoutMs);
    }
    throw err;
  }
  const budgetWarning = res.headers.get('X-Token-Budget-Warning');
  if (budgetWarning) {
    const milestone = parseInt(budgetWarning, 10);
    if (!isNaN(milestone) && milestone >= 0 && milestone <= 100) {
      onQuotaMilestone(milestone, res.headers.get('X-Token-Budget-Resets') ?? undefined);
    }
  }
  if (res.status === 429) {
    const data = await res.json().catch(bridgeWarn('Failed to parse rate-limit response body', {})) as Record<string, unknown>;
    if (data.limitType === 'tokens_per_day' && !budgetWarning) {
      onQuotaMilestone(100, (data.resetsAt as string | undefined));
    }
    const msg = data.limitType === 'tokens_per_day'
      ? 'Daily token limit exceeded. Try again tomorrow or use your own API key.'
      : `Rate limit exceeded. Retry in ${Math.ceil((data.retryAfterMs as number || 60000) / 1000)}s.`;
    const err = new ActionableError({
      goal: 'Call AI backend',
      problem: msg,
      location: 'web-bridge.post',
      nextSteps: ['Wait for the rate limit to reset', 'Use your own API key to avoid shared limits'],
    });
    Object.assign(err, { limitType: String(data.limitType ?? ''), retryAfterS: Math.ceil((data.retryAfterMs as number || 60000) / 1000), rateLimitSource: data.rate_limit_source, limit: data.limit, current: data.current }); // 429 retry_after_s (t/3054) + rate_limit_source/limit/current for anon client-only FR (t/3107)
    throwHttpError(429, err);
  }
  if (res.status === 400 && (path === '/api/ai/generate' || path === '/api/ai/search')) {
    const data = await res.json().catch(bridgeWarn('Failed to parse 400 response body', {})) as Record<string, unknown>;
    if (data.error === 'context_too_long') {
      const err = new ActionableError({
        goal: 'Generate AI response',
        problem: (data.message as string) || 'Input exceeds the model context window.',
        location: 'web-bridge.post',
        nextSteps: ['Try a shorter prompt or fewer debate rounds', 'Switch to a model with a larger context window in Settings'],
      });
      (err as ActionableError & { errorCode: string }).errorCode = 'context_too_long';
      throwHttpError(400, err);
    }
    if (data.limitType === 'max_prompt_chars') {
      throwHttpError(400, new ActionableError({
        goal: 'Generate AI response',
        problem: `Prompt exceeds the ${(data.limit as number)?.toLocaleString() ?? ''} character limit for the free tier.`,
        location: 'web-bridge.post',
        nextSteps: ['Shorten your prompt or debate topic', 'Use your own API key to remove the limit'],
      }));
    }
  }
  if (res.status === 422 && path === '/api/ai/generate') {
    const data = await res.json().catch(bridgeWarn('Failed to parse 422 response body', {})) as Record<string, unknown>;
    if (data.error === 'missing_api_key') {
      throwHttpError(422, new ActionableError({
        goal: 'Generate AI response',
        problem: (data.message as string) || `No API key configured for ${(data.backend as string) || 'the selected backend'}.`,
        location: 'web-bridge.post',
        nextSteps: ['Open Settings → API Keys and add a key for this backend', 'Switch to a backend that has a key configured'],
      }));
    }
  }
  // t/4186: a concurrent GitHub write conflict on commit. Discriminated by body `code`
  // (TL contract, p/772#1), not the bare 409 — other 409s on this path (e.g. save_in_progress)
  // must keep their existing generic handling.
  if (res.status === 409 && path === '/api/sync/commit') {
    const data = await res.json().catch(bridgeWarn('Failed to parse 409 response body', {})) as Record<string, unknown>;
    if (data.code === 'WRITE_CONFLICT') {
      const err = new ActionableError({
        goal: 'Commit taxonomy changes',
        problem: 'Someone else changed this file. Reload to see their version.',
        location: 'web-bridge.post',
        nextSteps: ['Reload to see the other writer’s change', 'Reapply your edit after reloading'],
      });
      (err as ActionableError & { code: string }).code = 'WRITE_CONFLICT';
      throwHttpError(409, err);
    }
  }
  if (!res.ok) {
    const text = await res.text();
    throwHttpError(res.status, new ActionableError({
      goal: 'Send data to server',
      problem: `POST ${path} failed with HTTP ${res.status}: ${text}`,
      location: 'web-bridge.post',
      nextSteps: nextStepsForStatus(res.status, text),
    }));
  }
  const postCt = res.headers.get('content-type') || '';
  if (postCt.includes('text/html')) {
    throw new ActionableError({
      goal: 'Send data to server',
      problem: 'Server returned a login page instead of JSON data — authentication may be required',
      location: `web-bridge.post ${path}`,
      nextSteps: ['Sign in or navigate to /.auth/anonymous to start an anonymous session'],
    });
  }
  return res.json();
}

async function put<T = unknown>(path: string, body?: unknown, opts?: FetchOptions): Promise<T> {
  const cat = categorizeEndpoint(path, 'PUT');
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_MUTATION_TIMEOUT_MS;
  let res: Response;
  try {
    res = await fetchWithSessionRecovery(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }, {
      timeoutMs,
      maxRetries: opts?.maxRetries ?? defaultMaxRetries(cat, 'PUT', opts?.idempotent),
      critical: opts?.critical ?? true,
      category: cat,
    });
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'web-bridge',
      level: 'error',
      message: `PUT ${path} network error`,
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    if (err instanceof DOMException && err.name === 'AbortError') {
      throwTimeoutError('PUT', path, timeoutMs);
    }
    throw err;
  }
  if (res.status === 409 && path === '/api/debates') {
    const data = await res.json().catch(bridgeWarn('Failed to parse 409 response body', {})) as Record<string, unknown>;
    if (data.error === 'save_in_progress') {
      const err = new ActionableError({
        goal: 'Save debate session',
        problem: 'Another save is already in progress for this debate.',
        location: 'web-bridge.put',
        nextSteps: ['The save will be retried automatically'],
      });
      (err as ActionableError & { errorCode: string }).errorCode = 'save_in_progress';
      throwHttpError(409, err);
    }
  }
  if (!res.ok) {
    const text = await res.text();
    throwHttpError(res.status, new ActionableError({
      goal: 'Update data on server',
      problem: `PUT ${path} failed with HTTP ${res.status}: ${text}`,
      location: 'web-bridge.put',
      nextSteps: nextStepsForStatus(res.status, text),
    }));
  }
  const putCt = res.headers.get('content-type') || '';
  if (putCt.includes('text/html')) {
    throw new ActionableError({
      goal: 'Update data on server',
      problem: 'Server returned a login page instead of JSON data — authentication may be required',
      location: `web-bridge.put ${path}`,
      nextSteps: ['Sign in or navigate to /.auth/anonymous to start an anonymous session'],
    });
  }
  return res.status === 204 ? (undefined as T) : res.json(); // 204 No Content has no body — res.json() would throw (t/2980)
}

async function del<T = unknown>(path: string, opts?: FetchOptions): Promise<T> {
  const cat = categorizeEndpoint(path, 'DELETE');
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_MUTATION_TIMEOUT_MS;
  let res: Response;
  try {
    res = await fetchWithSessionRecovery(path, { method: 'DELETE' }, {
      timeoutMs,
      maxRetries: opts?.maxRetries ?? defaultMaxRetries(cat, 'DELETE', opts?.idempotent),
      critical: opts?.critical ?? true,
      category: cat,
    });
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'web-bridge',
      level: 'error',
      message: `DELETE ${path} network error`,
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    if (err instanceof DOMException && err.name === 'AbortError') {
      throwTimeoutError('DELETE', path, timeoutMs);
    }
    throw err;
  }
  if (!res.ok) {
    const text = await res.text();
    throwHttpError(res.status, new ActionableError({
      goal: 'Delete data on server',
      problem: `DELETE ${path} failed with HTTP ${res.status}: ${text}`,
      location: 'web-bridge.del',
      nextSteps: nextStepsForStatus(res.status, text),
    }));
  }
  const delCt = res.headers.get('content-type') || '';
  if (delCt.includes('text/html')) {
    throw new ActionableError({
      goal: 'Delete data on server',
      problem: 'Server returned a login page instead of JSON data — authentication may be required',
      location: `web-bridge.del ${path}`,
      nextSteps: ['Sign in or navigate to /.auth/anonymous to start an anonymous session'],
    });
  }
  return res.status === 204 ? (undefined as T) : res.json(); // 204 No Content has no body (standard for DELETE) — res.json() would throw (t/2980)
}

/**
 * Incremental debate save (web-only). Sends only the changed surfaces as a PATCH.
 *
 * Non-idempotent — `maxRetries: 0` (renderer resilience rule 2: never auto-retry a
 * mutation; surface the error for an explicit, caller-driven fallback instead). The
 * server returns two distinct 409s, discriminated by different body fields:
 *   - `code === 'version_conflict'`  → the stored version moved past `delta.baseVersion`;
 *     the caller must fall back to a full `saveDebateSession` PUT and re-sync.
 *   - `error === 'save_in_progress'` → an in-flight save is holding the debate; the
 *     store coalesces and retries the same delta later (existing behavior).
 * Both are surfaced as an `ActionableError` carrying `errorCode` so the store can branch.
 */
async function patchDebateDelta(delta: DebateDelta): Promise<{ newVersion: number }> {
  const path = `/api/debates/${delta.debateId}`;
  const cat = categorizeEndpoint(path, 'PATCH');
  const timeoutMs = DEBATE_SAVE_TIMEOUT_MS;
  let res: Response;
  try {
    res = await fetchWithSessionRecovery(path, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(delta),
    }, {
      timeoutMs,
      maxRetries: 0,
      critical: true,
      category: cat,
    });
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'web-bridge',
      level: 'error',
      message: `PATCH ${path} network error`,
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    if (err instanceof DOMException && err.name === 'AbortError') {
      throwTimeoutError('PATCH', path, timeoutMs);
    }
    throw err;
  }
  if (res.status === 409) {
    const data = await res.json().catch(bridgeWarn('Failed to parse 409 response body', {})) as Record<string, unknown>;
    if (data.code === 'version_conflict') {
      const err = new ActionableError({
        goal: 'Incrementally save debate session',
        problem: 'The stored debate version has advanced past the delta base version.',
        location: 'web-bridge.patchDebateDelta',
        nextSteps: ['A full save will be issued to reconcile the divergence'],
      });
      (err as ActionableError & { errorCode: string }).errorCode = 'version_conflict';
      // Carry the server's authoritative currentVersion so the store can stamp a
      // monotonic version on its full-PUT fallback (t/1637).
      if (typeof data.currentVersion === 'number') {
        (err as ActionableError & { currentVersion: number }).currentVersion = data.currentVersion;
      }
      throwHttpError(409, err);
    }
    if (data.error === 'save_in_progress') {
      const err = new ActionableError({
        goal: 'Incrementally save debate session',
        problem: 'Another save is already in progress for this debate.',
        location: 'web-bridge.patchDebateDelta',
        nextSteps: ['The save will be retried automatically'],
      });
      (err as ActionableError & { errorCode: string }).errorCode = 'save_in_progress';
      throwHttpError(409, err);
    }
  }
  if (!res.ok) {
    const text = await res.text();
    throwHttpError(res.status, new ActionableError({
      goal: 'Incrementally save debate session',
      problem: `PATCH ${path} failed with HTTP ${res.status}: ${text}`,
      location: 'web-bridge.patchDebateDelta',
      nextSteps: nextStepsForStatus(res.status, text),
    }));
  }
  const patchCt = res.headers.get('content-type') || '';
  if (patchCt.includes('text/html')) {
    throw new ActionableError({
      goal: 'Incrementally save debate session',
      problem: 'Server returned a login page instead of JSON data — authentication may be required',
      location: `web-bridge.patchDebateDelta ${path}`,
      nextSteps: ['Sign in or navigate to /.auth/anonymous to start an anonymous session'],
    });
  }
  const body = await res.json() as { newVersion?: number };
  if (typeof body.newVersion !== 'number') {
    throw new ActionableError({
      goal: 'Incrementally save debate session',
      problem: 'Server accepted the delta but did not return a numeric newVersion.',
      location: 'web-bridge.patchDebateDelta',
      nextSteps: ['Retry the save; if it persists, fall back to a full save'],
    });
  }
  return { newVersion: body.newVersion };
}

export { get as bridgeGet, post as bridgePost, put as bridgePut, del as bridgeDel };

function bridgeWarn<T>(message: string, fallback: T) {
  return (err: unknown) => {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'web-bridge',
      level: 'warn',
      message,
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return fallback;
  };
}

// ── WebSocket event bus ──

const WS_HANDSHAKE_TIMEOUT_MS = 10_000;
const WS_RECONNECT_BASE_MS = 2_000;
const WS_RECONNECT_MAX_MS = 60_000;
const WS_MAX_RECONNECT_ATTEMPTS = 10;

type EventCallback = (data: unknown) => void;
const eventListeners = new Map<string, Set<EventCallback>>();
let eventWs: WebSocket | null = null;
let eventWsReconnectAttempts = 0;

function ensureEventSocket(): void {
  if (eventWs && (eventWs.readyState === WebSocket.OPEN || eventWs.readyState === WebSocket.CONNECTING)) return;

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  eventWs = new WebSocket(`${protocol}//${location.host}/ws/events`);
  const ws = eventWs;

  const handshakeTimer = setTimeout(() => {
    if (ws.readyState === WebSocket.CONNECTING) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'web-bridge', level: 'warn',
        message: `WebSocket /ws/events handshake timed out after ${WS_HANDSHAKE_TIMEOUT_MS / 1000}s`,
      });
      ws.close();
    }
  }, WS_HANDSHAKE_TIMEOUT_MS);

  eventWs.onopen = () => {
    clearTimeout(handshakeTimer);
    eventWsReconnectAttempts = 0;
  };

  eventWs.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data) as { type: string; data: unknown };
      const listeners = eventListeners.get(msg.type);
      if (listeners) {
        for (const cb of listeners) cb(msg.data);
      }
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'web-bridge',
        level: 'debug',
        message: 'Failed to parse WebSocket event message',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
    }
  };

  eventWs.onclose = () => {
    clearTimeout(handshakeTimer);
    eventWs = null;
    if (eventWsReconnectAttempts >= WS_MAX_RECONNECT_ATTEMPTS) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'web-bridge', level: 'error',
        message: `WebSocket /ws/events reconnect limit reached (${WS_MAX_RECONNECT_ATTEMPTS} attempts), giving up`,
      });
      return;
    }
    const delay = Math.min(WS_RECONNECT_BASE_MS * Math.pow(2, eventWsReconnectAttempts), WS_RECONNECT_MAX_MS);
    eventWsReconnectAttempts++;
    setTimeout(ensureEventSocket, delay);
  };
}

function addEventListener(type: string, callback: EventCallback): () => void {
  ensureEventSocket();
  if (!eventListeners.has(type)) eventListeners.set(type, new Set());
  eventListeners.get(type)!.add(callback);
  return () => { eventListeners.get(type)?.delete(callback); };
}

// ── Terminal WebSocket ──

let terminalWs: WebSocket | null = null;
const terminalDataCallbacks = new Set<(data: string) => void>();
const terminalExitCallbacks = new Set<() => void>();

registerConnectionPoolProvider(() => ({
  activeWebSockets: [eventWs, terminalWs].filter(ws => ws?.readyState === WebSocket.OPEN).length,
  connectingWebSockets: [eventWs, terminalWs].filter(ws => ws?.readyState === WebSocket.CONNECTING).length,
}));

function ensureTerminalSocket(): WebSocket {
  if (terminalWs && terminalWs.readyState === WebSocket.OPEN) return terminalWs;

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  terminalWs = new WebSocket(`${protocol}//${location.host}/ws/terminal`);
  const ws = terminalWs;

  const handshakeTimer = setTimeout(() => {
    if (ws.readyState === WebSocket.CONNECTING) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'web-bridge', level: 'warn',
        message: `WebSocket /ws/terminal handshake timed out after ${WS_HANDSHAKE_TIMEOUT_MS / 1000}s`,
      });
      ws.close();
    }
  }, WS_HANDSHAKE_TIMEOUT_MS);

  terminalWs.onopen = () => {
    clearTimeout(handshakeTimer);
  };

  terminalWs.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data) as { type: string; data?: string };
      if (msg.type === 'data' && msg.data) {
        for (const cb of terminalDataCallbacks) cb(msg.data);
      } else if (msg.type === 'exit') {
        for (const cb of terminalExitCallbacks) cb();
      }
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'web-bridge',
        level: 'debug',
        message: 'Failed to parse WebSocket terminal message',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
    }
  };

  terminalWs.onclose = () => {
    clearTimeout(handshakeTimer);
    terminalWs = null;
    for (const cb of terminalExitCallbacks) cb();
  };

  return terminalWs;
}

// ── Diagnostics state (cross-tab via BroadcastChannel) ──

const diagChannel = typeof BroadcastChannel !== 'undefined'
  ? new BroadcastChannel('aitriad-diagnostics')
  : null;

const diagCallbacks = new Set<(state: unknown) => void>();
const diagClosedCallbacks = new Set<() => void>();
const reExtractCallbacks = new Set<(entryId: string) => void>();

// Brief-timeout browser-local event bus (web-only; Electron path uses IPC from ElectronMain).
// Types mirror AppAPI inline shapes in types.ts — NOT imported from useBriefTimeoutEvents.ts
// (that file imports @bridge, which would create a circular dep). (t/2218)
type BriefTimeoutPayload = { debateId: string; speaker: string; attempt: number; maxAttempts: number; currentModel: string };
type BriefExhaustedPayload = { debateId: string; speaker: string; totalAttempts: number; currentModel: string };
const briefTimeoutCbs = new Set<(e: BriefTimeoutPayload) => void>();
const briefExhaustedCbs = new Set<(e: BriefExhaustedPayload) => void>();
export function emitBriefTimeout(e: BriefTimeoutPayload): void { briefTimeoutCbs.forEach(cb => cb(e)); }
export function emitBriefRetriesExhausted(e: BriefExhaustedPayload): void { briefExhaustedCbs.forEach(cb => cb(e)); }

// Receive diagnostics state from the main tab (or from this tab if inline)
const diagChannelHandler = (event: MessageEvent) => {
  const msg = event.data as { type: string; payload?: unknown; entryId?: string };
  if (msg.type === 'diagnostics-state' && msg.payload) {
    for (const cb of diagCallbacks) cb(msg.payload);
  } else if (msg.type === 'diagnostics-closed') {
    for (const cb of diagClosedCallbacks) cb();
  } else if (msg.type === 're-extract-claims' && msg.entryId) {
    for (const cb of reExtractCallbacks) cb(msg.entryId);
  }
};
diagChannel?.addEventListener('message', diagChannelHandler);
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    diagChannel?.close();
    eventWs?.close();
    eventWs = null;
    terminalWs?.close();
    terminalWs = null;
  });
}

// ── The bridge ──

const rawApi: AppAPI = {
  // User preferences
  getPreferences: () => get<UserPreferences | null>('/api/preferences').catch(() => null),
  setPreferences: (prefs: UserPreferences) => put('/api/preferences', prefs, { idempotent: true }).then(() => {}),

  // Taxonomy directories
  getTaxonomyDirs: () => get('/api/taxonomy-dirs'),
  getActiveTaxonomyDir: () => get('/api/taxonomy-dir/active'),
  setTaxonomyDir: (dirName) => put('/api/taxonomy-dir/active', { dirName }).then(() => {}),

  // Taxonomy CRUD
  loadTaxonomyFile: (pov) => get(`/api/taxonomy/${encodeURIComponent(pov)}`),
  saveTaxonomyFile: (pov, data) => put(`/api/taxonomy/${encodeURIComponent(pov)}`, data).then(() => {}),
  loadPolicyRegistry: () => get('/api/policy-registry'),
  // t/4034: recount member_count / source_povs for these ids after a save (lib/policy/registryRecount.ts).
  recountPolicyMembers: (ids) => post('/api/policy-registry/recount', { ids }),
  loadLineageCategories: () => get('/api/lineage-categories'),
  // t/3852: durable delete-audit log; WARN+swallow on failure (never block the delete it records).
  logNodeDeletion: (entry) => post('/api/node-delete-log', entry).then(() => {}).catch((err) =>
    getGlobalRecorder()?.record({ type: 'system.error', component: 'bridge', level: 'warn',
      message: 'logNodeDeletion endpoint unavailable (t/3860) or failed', data: { nodeId: entry.nodeId },
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } })),
  loadLineageInfo: () => get<Record<string, unknown>>('/api/lineage-info'),
  loadEdges: () => get('/api/edges?include=rationale'), // t/2949: load the FULL set (rationale) so a whole-file save can't drop it; server strips by default
  getEdgeDetail: (index) => get(`/api/edges/${index}`),
  updateEdgeStatus: (index, status) => put('/api/edges/status', { index, status }),
  swapEdgeDirection: (index) => put('/api/edges/swap', { index }),
  bulkUpdateEdges: (indices, status) => put('/api/edges/bulk-status', { indices, status }),
  // New-edge persistence (t/1816). Whole-file atomic replace — PUT the resource, mirroring
  // saveTaxonomyFile's PUT convention (idempotent), NOT the by-index status/swap/bulk ops above.
  saveEdges: (data) => put('/api/edges', data).then(() => {}),
  buildNodeSourceIndex: () => get('/api/node-source-index'),
  buildPolicySourceIndex: () => get('/api/policy-source-index'),

  // Conflict CRUD
  loadConflictFiles: () => get('/api/conflicts'),
  loadConflictClusters: () => get('/api/conflicts/clusters'),
  loadAggregatedCruxes: () => get('/api/cruxes'),
  addCruxEvidence: (cruxId, entry) => post(`/api/cruxes/${encodeURIComponent(cruxId)}/evidence`, entry).then(() => {}),
  removeCruxEvidence: (cruxId, entryIndex) => del(`/api/cruxes/${encodeURIComponent(cruxId)}/evidence/${entryIndex}`).then(() => {}),
  saveConflictFile: (id, data) => put(`/api/conflicts/${encodeURIComponent(id)}`, data).then(() => {}),
  createConflictFile: (id, data) => post(`/api/conflicts/${encodeURIComponent(id)}`, data).then(() => {}),
  deleteConflictFile: (id) => del(`/api/conflicts/${encodeURIComponent(id)}`).then(() => {}),

  // Summaries & Sources
  discoverSources: () => get('/api/sources'),
  loadSummary: (docId) => get(`/api/summaries/${encodeURIComponent(docId)}`).catch(bridgeWarn('loadSummary failed', null)),
  loadSnapshot: (sourceId) => get(`/api/snapshots/${encodeURIComponent(sourceId)}`).then(r => r as { content: string } | null).catch(bridgeWarn('loadSnapshot failed', null)),
  resolveSourceDocument: (docId) => get(`/api/source-documents/${encodeURIComponent(docId)}`).then(r => r as SourceDocumentResolution).catch(bridgeWarn('resolveSourceDocument failed', { available: false, type: null })),

  // Data management
  isDataAvailable: () => get('/api/data/available'),
  getDataRoot: () => get('/api/data/root'),
  getCopyStatus: () => get<{ state: string; dir?: string; copied?: number; total?: number }>('/status').catch(bridgeWarn('getCopyStatus failed', { state: 'unknown' })),
  cloneDataRepo: (targetPath) => post('/api/data/clone', { targetPath }),
  setDataRoot: (newRoot) => post('/api/data/set-root', { newRoot }),
  pickDirectory: () => Promise.resolve({ cancelled: true }),
  checkDataUpdates: () => post('/api/data/check-updates'),
  pullDataUpdates: () => pullDataUpdatesRest(), // extracted (ADR-007) — see dataUpdatesPull.ts

  getChangedFiles: () => post<{ path: string; status: string }[]>('/api/data/changed-files').catch(bridgeWarn('getChangedFiles failed', [])),
  // t/4052: read everywhere; review is desktop-only (hosted answers 405), so the web queue disables it.
  loadPovTagProposals: () => get('/api/pov-tag-proposals'),
  reviewPovTagProposal: (nodeId, decision, expectedStatus) => post('/api/pov-tag-proposals/review', { nodeId, decision, expectedStatus }),
  getFileDiff: (filePath) => post<string>('/api/data/file-diff', { filePath }).catch(bridgeWarn('getFileDiff failed', '')),

  // AI models & keys
  loadAIModels: () => get('/api/models'),
  // t/4031: opts travel as the POST body; a plain refresh still sends none. Not retried (a mutation).
  refreshAIModels: (opts) => post<RefreshResult>('/api/models/refresh', opts),
  validateApiKey: (key, backend) => post('/api/keys/validate', { key, backend }),
  verifyStoredKeys: (backend) => post('/api/keys/verify-stored', { backend }),
  setApiKey: async (key, backend) => {
    const storageKey = backend ? `byok-${backend}` : 'byok-api-key';
    sessionStorage.setItem(storageKey, JSON.stringify([key]));
    if (!(await isAnonymous())) {
      await post('/api/keys', { key, backend });
    }
  },
  addApiKey: async (key, backend) => {
    if (await isAnonymous()) {
      const keys = readByokKeys(backend);
      if (!keys.includes(key)) keys.push(key);
      sessionStorage.setItem(`byok-${backend}`, JSON.stringify(keys));
      return { count: keys.length };
    }
    const res = await post<{ keys: { index: number; masked: string }[] }>(`/api/keys/${backend}/add`, { key });
    return { count: res.keys.length };
  },
  removeApiKey: async (index, backend) => {
    if (await isAnonymous()) {
      const keys = readByokKeys(backend);
      if (index >= 0 && index < keys.length) keys.splice(index, 1);
      sessionStorage.setItem(`byok-${backend}`, JSON.stringify(keys));
      return;
    }
    await del(`/api/keys/${backend}/${index}`);
  },
  getApiKeys: async (backend) => {
    if (await isAnonymous()) {
      return readByokKeys(backend).map((k, i) => ({ index: i, masked: maskByokKey(k) }));
    }
    const res = await get<{ keys: { index: number; masked: string }[] }>(`/api/keys/${backend}`);
    return res.keys;
  },
  deleteApiKey: async (backend) => {
    const storageKey = backend ? `byok-${backend}` : 'byok-api-key';
    sessionStorage.removeItem(storageKey);
    if (!(await isAnonymous())) {
      await post('/api/keys/delete', { backend });
    }
  },
  deleteAllApiKeys: async () => {
    // Must cover every backend or "delete all" silently leaves keys behind (t/1958).
    for (const b of ALL_API_KEY_BACKENDS) {
      sessionStorage.removeItem(`byok-${b}`);
    }
    sessionStorage.removeItem('byok-api-key');
    if (!(await isAnonymous())) {
      await post('/api/keys/delete-all');
    }
  },
  hasApiKey: async (backend) => {
    if (await isAnonymous()) {
      const storageKey = backend ? `byok-${backend}` : 'byok-api-key';
      return !!sessionStorage.getItem(storageKey);
    }
    return get(`/api/keys/has${backend ? `?backend=${backend}` : ''}`);
  },
  getAvailableBackends: async () => {
    // The server computes the authoritative per-backend `reason` (tier_restricted vs
    // no_key) from the caller's resolved tier — including for an anonymous caller
    // (`/api/backends/available` has no auth gate; resolveTier('') → anonymous/free).
    const res = await get<{ backends: { id: string; available: boolean; models?: string[]; reason?: 'tier_restricted' | 'no_key' }[] }>('/api/backends/available')
      .catch(bridgeWarn('getAvailableBackends failed', { backends: [] }));
    if (!(await isAnonymous())) return res.backends;
    // Anonymous (BYOK) keys live in sessionStorage — the server can't see them, so it
    // reports every in-tier backend as `no_key`. Overlay local key presence to flip
    // those to available. Keep `tier_restricted` as-is: the server 403s those even with
    // a key, so the honest unlock is signing in, not entering a key (t/2036, #3).
    return res.backends.map((b) => {
      if (b.reason === 'tier_restricted') return b;
      const hasLocal = !!sessionStorage.getItem(`byok-${b.id}`);
      return hasLocal
        ? { id: b.id, available: true, models: b.models }
        : { id: b.id, available: false, reason: 'no_key' as const };
    });
  },
  getApiKeySummary: async () => {
    return ALL_API_KEY_BACKENDS.map((b) => {
      const keys = readByokKeys(b);
      return {
        backend: b,
        hasKey: keys.length > 0,
        maskedKey: keys.length > 0 ? maskByokKey(keys[0]) : null,
      };
    });
  },
  exportKeysForSharing: async (passphrase) => {
    const keys: Record<string, string> = {};
    for (const b of ALL_API_KEY_BACKENDS) {
      const stored = sessionStorage.getItem(`byok-${b}`);
      if (stored) keys[b] = stored;
    }
    const byok = sessionStorage.getItem('byok-api-key');
    if (byok && Object.keys(keys).length === 0) keys['default'] = byok;
    if (Object.keys(keys).length === 0) throw new Error('No API keys to export — save at least one key first');
    const encrypted = await encryptKeysForSharing(keys, passphrase);
    const payloadStr = JSON.stringify(encrypted);
    const { default: QRCode } = await import('qrcode');
    const dataUrl = await QRCode.toDataURL(payloadStr, { errorCorrectionLevel: 'M', width: 400 });
    return { dataUrl, payloadText: payloadStr };
  },
  importKeysFromSharing: async (payload, passphrase) => {
    const keys = await decryptKeysFromSharing(payload as { v: 1; salt: string; iv: string; data: string; tag: string }, passphrase);
    const imported: string[] = [];
    for (const [backend, key] of Object.entries(keys)) {
      await post('/api/keys', { key, backend });
      imported.push(backend);
    }
    return imported;
  },

  // AI generation
  generateText: (prompt, model, timeout, temperature, opts) => {
    const requestId = opts?.requestId ?? crypto.randomUUID();
    const body: Record<string, unknown> = { prompt, model, timeout, temperature };
    const byokKey = sessionStorage.getItem('byok-api-key');
    if (byokKey) body.apiKey = byokKey;
    if (_activeDebateId) body.debateId = _activeDebateId;
    getGlobalRecorder()?.record({
      type: 'ai.request',
      component: 'web-bridge',
      level: 'info',
      message: `AI generate request: ${model ?? 'default'}`,
      data: { requestId, ..._activeDebateId ? { debateId: _activeDebateId } : {} },
    });
    // Thread the abort signal (t/2508) into the fetch so cancel physically tears down
    // the request; the server also aborts the provider call on client disconnect (t/2510).
    return post('/api/ai/generate', body, { signal: opts?.signal }, { 'x-request-id': requestId });
  },
  generateTextWithSearch: (prompt, model) => {
    const requestId = crypto.randomUUID();
    const body: Record<string, unknown> = { prompt, model, search: true };
    const byokKey = sessionStorage.getItem('byok-api-key');
    if (byokKey) body.apiKey = byokKey;
    if (_activeDebateId) body.debateId = _activeDebateId;
    getGlobalRecorder()?.record({
      type: 'ai.request',
      component: 'web-bridge',
      level: 'info',
      message: `AI generate+search request: ${model ?? 'default'}`,
      data: { requestId, ..._activeDebateId ? { debateId: _activeDebateId } : {} },
    });
    return post('/api/ai/generate', body, undefined, { 'x-request-id': requestId });
  },
  // Chat streaming (SSE) — transport lives in ./chatStream (leaf module, t/2462). Shape-identical
  // to the Electron preload so useChatStore consumes one contract from both bridges.
  startChatStream: (systemInstruction, messages, model, temperature, urlContext, context) =>
    runChatStream(fetchWithSessionRecovery, { systemInstruction, messages, model, temperature, urlContext, chatSessionId: context?.chatSessionId, linkedDebateId: context?.linkedDebateId }),
  onChatStreamChunk: (cb) => chatStreamBus.onChunk(cb),
  onChatStreamDone: (cb) => chatStreamBus.onDone(cb),
  onChatStreamError: (cb) => chatStreamBus.onError(cb),
  onChatStreamUrlMetadata: (cb) => chatStreamBus.onUrlMetadata(cb),
  setDebateTemperature: (temp) => post('/api/ai/temperature', { temp }).then(() => {}),

  // Proxy tier & usage
  getProxyTier: () => get('/api/proxy/tier'),
  getProxyUsage: () => get('/api/proxy/usage'),

  // Embeddings & NLI
  computeEmbeddings: (texts, ids) => computeEmbeddingsChunked(post, texts, ids), // ≤EMBEDDINGS_MAX_BATCH sequential chunks so an oversized batch can't blow the 50s server timeout (t/3072)
  updateNodeEmbeddings: (nodes) => post('/api/embeddings/update-nodes', { nodes }).then(() => ({ staleNodeIds: [] as string[] })), // Web: server embed backend has no GPU-OOM mode → nothing stale → always [] (t/2060).
  computeQueryEmbedding: (text) => post('/api/embeddings/query', { text }),
  fetchRelevantNodes: (payload) => post('/api/taxonomy/relevant-nodes', payload), // t/3258 (T3): EXACT path — anon free-tier gate is exact-match (TL t/3284#2)
  fetchClaimAttribution: (payload) => post('/api/argument-network/attribution', payload), // t/3316 (t/3297 client half): server-side per-claim attribution
  nliClassify: (pairs) => post('/api/nli/classify', { pairs }),

  // Source evidence
  loadSourceEvidenceIndex: () => get<Record<string, unknown> | null>('/api/source-evidence-index').catch(bridgeWarn('loadSourceEvidenceIndex failed', null)),
  loadDocTitles: () => get<Record<string, string> | null>('/api/doc-titles').catch(bridgeWarn('loadDocTitles failed', null)),
  loadGreatestHits: () => get<{ node_ids: string[] } | null>('/api/greatest-hits').catch(bridgeWarn('loadGreatestHits failed', null)),
  getSourceEvidence: (nodeIds, pov) => post('/api/source-evidence', { nodeIds, pov }),
  runEvidenceQbaf: (claimText, claimId, model) => post<{ computed_strength: number; qbaf_iterations: number; evidence_items: Array<{ id: string; source_doc_id: string; text: string; relation: 'support' | 'contradict'; similarity: number }>; claim_id: string } | null>('/api/evidence-qbaf', { claimText, claimId, model }).catch(bridgeWarn('runEvidenceQbaf failed', null)),

  // Debate sessions
  getDebateQuotaStatus: () => get('/api/debates/quota-status'),
  listDebateSessions: () => get('/api/debates'),
  listDebateSessionsMeta: () => get('/api/debates/list'),
  loadDebateSession: (id) => get(`/api/debates/${encodeURIComponent(id)}`),
  saveDebateSession: (session, _caller) => put('/api/debates', session, { timeoutMs: DEBATE_SAVE_TIMEOUT_MS }).then(() => {}),
  saveDebateDelta: (delta) => patchDebateDelta(delta),
  deleteDebateSession: (id) => del(`/api/debates/${encodeURIComponent(id)}`).then(() => {}),
  loadDebateComments: (id) => get(`/api/debates/${encodeURIComponent(id)}/comments`),
  saveDebateComments: (id, data) => put(`/api/debates/${encodeURIComponent(id)}/comments`, data).then(() => {}),

  // Inquiry (t/3582) — client of routes/inquiry.ts (t/3581); idempotency key rides a header, never the body.
  startInquiry: (request: StartInquiryRequest, idempotencyKey?: string) => post<{ jobId: string }>('/api/inquiry', request, undefined, idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined),
  getInquiry: (jobId: string) => get<InquiryStatusResponse>(`/api/inquiry/${encodeURIComponent(jobId)}`),
  listInquiries: () => get<InquiryResultSummary[]>('/api/inquiry'),
  exportInquiryToFile: (result: InquiryResult, title: string, format: 'json' | 'markdown' | 'pdf') => exportInquiryToFileWeb(result, title, format),
  shareInquiry: (jobId) => post<{ shareId: string; url: string }>(`/api/inquiry/${encodeURIComponent(jobId)}/share`, {}),
  unshareInquiry: (jobId) => del<{ ok: boolean }>(`/api/inquiry/${encodeURIComponent(jobId)}/share`),

  // Brief Export (t/2805, T7) — client of the T6 REST API (server: routes/briefExports.ts).
  createBriefExport: (debateId, body) => post<{ jobId: string }>(`/api/debates/${encodeURIComponent(debateId)}/exports`, body),
  getBriefExportJob: (jobId) => get<BriefExportJobView>(`/api/export-jobs/${encodeURIComponent(jobId)}`),
  listBriefExports: (debateId) => get<BriefExportRecord[]>(`/api/debates/${encodeURIComponent(debateId)}/exports`),
  downloadBriefArtifact: async (exportId, name) => {
    // Binary-capable read (pptx is bytes; json artifacts also come back as a Blob) — mirrors
    // downloadCaseAttachment. The route validates the artifact name; we encode defensively.
    const res = await resilientFetch(
      `/api/exports/${encodeURIComponent(exportId)}/artifacts/${encodeURIComponent(name)}`,
      {}, { timeoutMs: 30_000, maxRetries: 1, critical: true, category: 'read' as EndpointCategory },
    );
    if (!res.ok) throw new Error(`Artifact download failed: ${res.status}`);
    return res.blob();
  },
  deleteBriefExport: (exportId) => del(`/api/exports/${encodeURIComponent(exportId)}`).then(() => {}),
  printBriefToPdf: async (html) => {
    const win = window.open('about:blank', '_blank');
    if (!win) throw new ActionableError({ goal: 'Print brief to PDF', problem: 'Pop-up was blocked.', location: 'web-bridge · printBriefToPdf', nextSteps: ['Allow pop-ups for this site and try again.'] });
    win.document.open(); win.document.write(html); win.document.close(); win.focus(); win.print(); return { cancelled: false };
  },

  uploadBriefTemplate: async (file) => { const r = await fetchWithSessionRecovery('/api/templates', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'x-filename': file.name }, body: await file.arrayBuffer() }, { timeoutMs: 30_000, maxRetries: 1, critical: true, category: 'mutation' as EndpointCategory }); if (!r.ok) { const m = await r.text().catch(() => String(r.status)); throw new Error(`Template upload failed: ${m}`); } return r.json(); },
  listBriefTemplates: () => get('/api/templates'),
  deleteBriefTemplate: (templateId) => del(`/api/templates/${encodeURIComponent(templateId)}`).then(() => {}),

  // Op-Ed Studio (t/2576) — real routes against t/2573's server API (on main). The
  // personal-library path is /api/oped-sets (t/2599 live-smoke found the bridge had
  // assumed /api/opeds). Rename persists topic-only via PUT /api/oped-sets/:id (t/2594).
  listOpEdSets: () => get<OpEdSetSummary[]>('/api/oped-sets'),
  loadOpEdSet: (id) => get<OpEdSet>(`/api/oped-sets/${encodeURIComponent(id)}`),
  saveOpEdSet: (set) => put(`/api/oped-sets/${encodeURIComponent(set.set_id)}`, set).then(() => {}),
  deleteOpEdSet: (id) => del(`/api/oped-sets/${encodeURIComponent(id)}`).then(() => {}),
  // Web op-ed create (t/2614) — POST /api/oped-sets opens an SSE run driven by the shared
  // lib/oped core server-side (t/2610). Topic-only on web (the URL toggle is hidden). The
  // SSE parse/dispatch + run-status recovery live in opedStream.ts (leaf, like chatStream).
  createOpEdSet: (payload) => runOpEdCreate(fetchWithSessionRecovery, payload),
  cancelOpEdSet: () => cancelActiveOpEdRun(), // aborts the in-flight POST → server cancels voices
  onOpEdProgress: (cb) => opedProgressBus.onProgress(cb),
  shareOpEdSet: (id) => post<{ shareId: string; url: string }>(`/api/oped-sets/${encodeURIComponent(id)}/share`, {}), // t/2728: publish/revoke a public share link (routes/oped.ts)
  unshareOpEdSet: (id) => del<{ ok: boolean }>(`/api/oped-sets/${encodeURIComponent(id)}/share`),
  shareCommunityOpEd: (id) => post<{ shareId: string; url: string }>(`/api/community/opeds/${encodeURIComponent(id)}/share`, {}), // t/3315: public link for a community op-ed
  exportDebateToFile: async (session, format = 'json', exportOptions) => {
    const { debateToText, debateToMarkdown, debateToHtml, debateToPackage, debateExportFilename } = await import('@lib/debate/debateExport');
    const debate = session as Parameters<typeof debateToText>[0] & { diagnostics?: unknown };
    let content: string;
    let mimeType: string;
    let ext: string;

    switch (format) {
      case 'markdown':
        content = debateToMarkdown(debate, exportOptions);
        mimeType = 'text/markdown';
        ext = 'md';
        break;
      case 'text':
        content = debateToText(debate, exportOptions);
        mimeType = 'text/plain';
        ext = 'txt';
        break;
      case 'pdf': {
        // Open styled HTML in a new tab and trigger browser print dialog
        const html = debateToHtml(debate, exportOptions);
        const printWindow = window.open('', '_blank');
        if (printWindow) {
          printWindow.document.write(html);
          printWindow.document.close();
          printWindow.addEventListener('load', () => printWindow.print());
        }
        return { cancelled: false, filePath: debateExportFilename(debate.title, 'pdf') };
      }
      case 'package': {
        // ZIP package — no PDF generator in browser, so HTML fallback is included
        const zipBytes = await debateToPackage(debate, exportOptions);
        const filename = debateExportFilename(debate.title, 'zip');
        const blob = new Blob([zipBytes.buffer as ArrayBuffer], { type: 'application/zip' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        URL.revokeObjectURL(a.href);
        return { cancelled: false, filePath: filename };
      }
      default:
        content = JSON.stringify(debate, null, 2);
        mimeType = 'application/json';
        ext = 'json';
        break;
    }

    const filename = debateExportFilename(debate.title, ext);
    const blob = new Blob([content], { type: mimeType });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
    return { cancelled: false, filePath: filename };
  },

  // News Report
  generateNewsReport: (debateId) => post(`/api/debates/${encodeURIComponent(debateId)}/news-report`, {}),

  // Chat sessions
  listChatSessions: () => get('/api/chats'),
  loadChatSession: (id) => get(`/api/chats/${encodeURIComponent(id)}`),
  saveChatSession: (session) => put('/api/chats', session).then(() => {}),
  deleteChatSession: (id) => del(`/api/chats/${encodeURIComponent(id)}`).then(() => {}),
  exportChatToFile: async (entries, format, options) => {
    const { chatToMarkdown, chatToText, chatToPrintHtml, chatToJson, chatExportFilename } = await import('@lib/chat/chatExportFormatters');
    const exportOpts = { title: options.title, mode: options.mode, pov: options.pov };

    switch (format) {
      case 'pdf': {
        const html = chatToPrintHtml(entries, exportOpts);
        const printWindow = window.open('', '_blank');
        if (printWindow) {
          printWindow.document.write(html);
          printWindow.document.close();
          printWindow.addEventListener('load', () => printWindow.print());
        }
        return { cancelled: false, filePath: chatExportFilename(options.title, 'pdf') };
      }
      case 'markdown': {
        const content = chatToMarkdown(entries, exportOpts);
        const filename = chatExportFilename(options.title, 'md');
        const blob = new Blob([content], { type: 'text/markdown' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        URL.revokeObjectURL(a.href);
        return { cancelled: false, filePath: filename };
      }
      case 'text': {
        const content = chatToText(entries, exportOpts);
        const filename = chatExportFilename(options.title, 'txt');
        const blob = new Blob([content], { type: 'text/plain' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        URL.revokeObjectURL(a.href);
        return { cancelled: false, filePath: filename };
      }
      case 'json': {
        const content = chatToJson(entries, exportOpts);
        const filename = chatExportFilename(options.title, 'json');
        const blob = new Blob([content], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        URL.revokeObjectURL(a.href);
        return { cancelled: false, filePath: filename };
      }
    }
  },

  // Harvest
  harvestCreateConflict: (conflict) => post('/api/harvest/conflict', conflict),
  harvestAddDebateRef: (nodeId, debateId) => post('/api/harvest/debate-ref', { nodeId, debateId }),
  harvestUpdateSteelman: (nodeId, attackerPov, newText) => post('/api/harvest/steelman', { nodeId, attackerPov, newText }),
  harvestAddVerdict: (conflictId, verdict) => post('/api/harvest/verdict', { conflictId, verdict }),
  harvestQueueConcept: (concept) => post('/api/harvest/concept', concept),
  harvestSaveManifest: (manifest) => post('/api/harvest/manifest', manifest),

  // Dictionary
  loadDictionary: () => get('/api/dictionary'),

  // Proposals
  listProposals: () => get('/api/proposals'),
  saveProposal: (filename, data) => put(`/api/proposals/${encodeURIComponent(filename)}`, data),

  // PowerShell prompts
  readPsPrompt: (name, dir = 'ps') => get(`/api/ps-prompts/${encodeURIComponent(name)}?dir=${encodeURIComponent(dir)}`),
  listPsPrompts: () => get('/api/ps-prompts'),

  // Feedback & error reporting
  submitFeedback: (rating, text, category, context) => post('/api/admin/feedback', { rating, text, category: category ?? 'general', context: { ...context, url: location.href, userAgent: navigator.userAgent } }),
  reportError: (err, context) => post<{ ok: boolean }>('/api/admin/errors', { error: err, context: { ...context, url: location.href, userAgent: navigator.userAgent } }).catch(bridgeWarn('Error report submission failed', { ok: false })),

  // Telemetry
  trackEvent: (type, view, metadata) => { void post('/api/admin/telemetry', { type, view, metadata }).catch(bridgeWarn('Telemetry event failed', undefined)); },

  // Research file access
  readResearchFile: (relativePath) => get(`/api/research/${encodeURIComponent(relativePath)}`).catch(bridgeWarn('readResearchFile failed', null)),
  writeResearchFile: (relativePath, data) => put(`/api/research/${encodeURIComponent(relativePath)}`, data).then(() => {}),

  // Synthetic corpus
  loadSyntheticCorpus: (pov) => get(`/api/taxonomy/synthetic/${encodeURIComponent(pov)}`).catch(bridgeWarn('loadSyntheticCorpus failed', null)),
  loadSyntheticEmbeddings: () => get<Record<string, { pov: string; vectors: number[][] }> | null>('/api/taxonomy/synthetic-embeddings').catch(bridgeWarn('loadSyntheticEmbeddings failed', null)),
  updateSyntheticEmbeddings: (nodeId, pov, vectors) => post('/api/taxonomy/synthetic-embeddings', { nodeId, pov, vectors }).then(() => {}),

  // Community Library
  listCommunityChats: () => get<unknown[]>('/api/community/chats').catch(bridgeWarn('listCommunityChats failed', [])),
  listCommunityDebates: () => get<unknown[]>('/api/community/debates').catch(bridgeWarn('listCommunityDebates failed', [])),
  submitToCommunity: (type, itemData, note) => post('/api/community/submit', { type, data: itemData, note }),
  copyFromCommunity: (type, communityId) => post('/api/community/copy', { type, communityId }),
  loadCommunityDebateSession: (id) => get(`/api/community/debates/${encodeURIComponent(id)}`),
  loadCommunityOpEd: (id) => get<OpEdSet>(`/api/community/opeds/${encodeURIComponent(id)}`),
  loadCommunityChatSession: (id) => get(`/api/community/chats/${encodeURIComponent(id)}`),
  // Web mode is same-origin; baseUrl is ignored and the relative path is used.
  communitySubmit: (_baseUrl, payload) => post('/api/community/submit', payload),

  // Support cases
  createSupportCase: (payload) => post('/api/support/cases', payload),
  listSupportCases: () => get('/api/support/cases'),
  getSupportCaseDetail: (caseId) => get(`/api/support/cases/${encodeURIComponent(caseId)}`),
  uploadCaseAttachment: async (caseId, file) => {
    const form = new FormData();
    form.append('file', file);
    const res = await resilientFetch(`/api/support/cases/${encodeURIComponent(caseId)}/attachments`, {
      method: 'POST',
      body: form,
    }, { timeoutMs: 60_000, maxRetries: 0, critical: true, category: 'mutation' as EndpointCategory });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error((err as { error?: string }).error ?? `Upload failed: ${res.status}`);
    }
    return res.json() as Promise<{ id: string; filename: string }>;
  },
  downloadCaseAttachment: async (caseId, attachmentId) => {
    const res = await resilientFetch(
      `/api/support/cases/${encodeURIComponent(caseId)}/attachments/${encodeURIComponent(attachmentId)}`,
      {}, { timeoutMs: 30_000, maxRetries: 1, critical: true, category: 'read' as EndpointCategory },
    );
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    return res.blob();
  },
  listAdminSupportCases: () => get('/api/admin/support/cases'),
  respondToSupportCase: (caseId, body) => post(`/api/admin/support/cases/${encodeURIComponent(caseId)}/respond`, { body }),
  updateSupportCaseStatus: (caseId, status) => put(`/api/admin/support/cases/${encodeURIComponent(caseId)}/status`, { status }),

  // Organizations
  listOrganizations: (filters) => {
    const params = new URLSearchParams();
    if (filters?.type) params.set('type', filters.type);
    if (filters?.pov) params.set('pov', filters.pov);
    const qs = params.toString();
    return get(`/api/organizations${qs ? `?${qs}` : ''}`);
  },
  getOrganization: (id) => get(`/api/organizations/${encodeURIComponent(id)}`),
  getOrganizationsByPov: (pov) => get(`/api/organizations/by-pov/${encodeURIComponent(pov)}`),
  getOrganizationsByTopic: (topicRef) => get(`/api/organizations/by-topic/${encodeURIComponent(topicRef)}`),
  getOrganizationsByPolicy: (policyId) => get(`/api/organizations/by-policy/${encodeURIComponent(policyId)}`),
  getOrganizationEdges: (orgId) => get(`/api/organizations/${encodeURIComponent(orgId)}/edges`),

  // Entity / ref resolution (t/1775)
  getEntity: (ref) => get(`/api/entity/${encodeURIComponent(ref)}`),

  // Entity list/browser (t/1883). v1 sends search/sort/type/status as query params
  // (URL-encoded, undefined keys omitted); the server currently returns the full list.
  listEntities: (query) => {
    const params = new URLSearchParams();
    if (query?.search) params.set('search', query.search);
    if (query?.sort) params.set('sort', query.sort);
    if (query?.type) params.set('type', query.type);
    if (query?.status) params.set('status', query.status);
    const qs = params.toString();
    return get(`/api/entities${qs ? `?${qs}` : ''}`);
  },

  // Container mentions (t/1901). Container ids carry a `:` prefix (sei:/node:) → URL-encode.
  // Server route t/1902 returns 200 with a null body for an absent container (derived
  // artifact — absence is "no links", not 404), so this resolves null rather than throwing.
  getContainerMentions: (containerId) => get(`/api/container-mentions/${encodeURIComponent(containerId)}`),

  // Calibration
  getCalibrationHistory: () => get<{ current: unknown; history: unknown[] }>('/api/calibration/history').catch(bridgeWarn('getCalibrationHistory failed', { current: null, history: [] })),
  getCalibrationLog: () => get<{ entries: unknown[]; validationReport: unknown }>('/api/calibration/log').catch(bridgeWarn('getCalibrationLog failed', { entries: [], validationReport: null })),

  // Sync
  syncCommit: (message) => post('/api/sync/commit', message ? { message } : undefined),

  // Flight recorder
  dumpFlightRecorder: (ndjson, dumpId) => post('/api/flight-recorder/dump', { ndjson, dumpId }),
  openFile: async () => {}, // No local file access in web mode
  openFlightRecorderViewer: async (dumpPath) => {
    const filename = dumpPath.split('/').pop() ?? dumpPath;
    if (isMobilePlatform()) {
      window.location.href = `/api/flight-recorder/view/${encodeURIComponent(filename)}`;
    } else {
      window.open(`/api/flight-recorder/view/${encodeURIComponent(filename)}`, '_blank');
    }
  },

  // Diagnostics — in web mode, communicate cross-tab via BroadcastChannel
  openDiagnosticsWindow: async () => {
    const isPopout = window.location.hash.includes('debate-window');
    const width = window.innerWidth;
    console.log(`[diagnostics] openDiagnosticsWindow: width=${width}, isPopout=${isPopout}, hash=${window.location.hash}`);
    if (!isPopout && width <= 1023) {
      console.log('[diagnostics] Using drawer path (narrow main window)');
      window.dispatchEvent(new CustomEvent('open-diagnostics-drawer'));
      return;
    }
    console.log('[diagnostics] Using new-tab path (popout or wide window)');
    openAppWindow('diagnostics-window');
  },
  openPovProgressionWindow: async () => {
    openAppWindow('pov-progression-window');
  },
  closeDiagnosticsWindow: async () => {
    diagChannel?.postMessage({ type: 'diagnostics-closed' });
  },
  sendDiagnosticsState: (state) => {
    // Broadcast to same-window listeners AND cross-tab via BroadcastChannel
    for (const cb of diagCallbacks) cb(state);
    diagChannel?.postMessage({ type: 'diagnostics-state', payload: state });
  },
  // Data file diff popout
  openDiffWindow: async (filePath) => {
    openAppWindow(`diff-window?file=${encodeURIComponent(filePath)}`);
  },
  // Prompt Diff popout
  openPromptDiffWindow: async (debateId, entryId) => {
    openAppWindow(`prompt-diff-window?debateId=${encodeURIComponent(debateId)}&entryId=${encodeURIComponent(entryId)}`);
  },
  // Debate popout — in web mode, open in a new browser tab (mobile: in-page navigation)
  openDebateWindow: async (debateId, source) => {
    openAppWindow(`debate-window?id=${encodeURIComponent(debateId)}${source ? `&source=${encodeURIComponent(source)}` : ''}`);
  },
  closeDebateWindow: async (_debateId: string) => { /* no-op in web mode */ },

  getCliFileArg: async () => null, // No CLI mode in browser

  // Terminal — via WebSocket
  terminalSpawn: async () => { ensureTerminalSocket(); },
  terminalWrite: async (data) => {
    if (terminalWs?.readyState === WebSocket.OPEN) {
      terminalWs.send(JSON.stringify({ type: 'write', data }));
    }
  },
  terminalResize: async (cols, rows) => {
    if (terminalWs?.readyState === WebSocket.OPEN) {
      terminalWs.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
  },
  terminalKill: async () => {
    if (terminalWs?.readyState === WebSocket.OPEN) {
      terminalWs.send(JSON.stringify({ type: 'kill' }));
    }
    terminalWs?.close();
    terminalWs = null;
  },

  // File operations
  fetchUrlContent: (url) => post('/api/fetch-url', { url }),
  pickDocumentFile: async () => {
    // Use browser file picker
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.pdf,.docx,.html,.htm,.txt,.md';
      input.onchange = async () => {
        if (!input.files?.length) { resolve({ cancelled: true }); return; }
        const file = input.files[0];
        const content = await file.text();
        resolve({ cancelled: false, filePath: file.name, content });
      };
      input.oncancel = () => resolve({ cancelled: true });
      input.click();
    });
  },
  clipboardWriteText: async (text) => {
    await navigator.clipboard.writeText(text);
  },

  // Window control — no-ops in browser
  growWindow: async () => {},
  shrinkWindow: async () => {},
  isMaximized: async () => false,
  openExternal: async (url) => { if (/^https?:\/\//i.test(url)) window.open(url, '_blank'); },

  // Event listeners
  onDiagnosticsStateUpdate: (cb) => {
    diagCallbacks.add(cb);
    return () => { diagCallbacks.delete(cb); };
  },
  onDiagnosticsPopoutClosed: (cb) => {
    diagClosedCallbacks.add(cb);
    return () => { diagClosedCallbacks.delete(cb); };
  },
  openChatWindow: async (chatId, source) => {
    openAppWindow(`chat-window?id=${encodeURIComponent(chatId)}${source ? `&source=${encodeURIComponent(source)}` : ''}`);
  },
  onChatPopoutClosed: () => () => {},
  onChatWindowLoad: () => () => {},
  requestReExtractClaims: (entryId) => {
    diagChannel?.postMessage({ type: 're-extract-claims', entryId });
  },
  onReExtractClaims: (cb) => {
    reExtractCallbacks.add(cb);
    return () => { reExtractCallbacks.delete(cb); };
  },
  onDebateWindowLoad: () => () => {}, // Web mode: debate ID comes via URL hash
  onDebatePopoutClosed: () => () => {},
  onGenerateTextProgress: (cb) => addEventListener('generate-text-progress', cb as EventCallback),
  onReloadTaxonomy: (cb) => addEventListener('reload-taxonomy', cb as EventCallback),
  onFocusNode: (cb) => addEventListener('focus-node', (d) => cb((d as { nodeId: string }).nodeId)),
  onTaxonomyUpdated: (cb) => addEventListener('taxonomy-updated', (d) => cb(d as { user: string; nodeCount: number; povs: string[] })),
  focusNodeInMainWindow: (nodeId) => { void post('/api/focus-node', { nodeId }); },
  onTerminalData: (cb) => {
    terminalDataCallbacks.add(cb);
    return () => { terminalDataCallbacks.delete(cb); };
  },
  onTerminalExit: (cb) => {
    terminalExitCallbacks.add(cb);
    return () => { terminalExitCallbacks.delete(cb); };
  },
  captureScreenshot: () => Promise.resolve({ cancelled: true }),

  // Feature flags
  getFlags: () => get<Record<string, boolean>>('/api/flags').catch(bridgeWarn('getFlags failed', {})),

  // UsageID registry
  getUsageRegistry: () => get<{ usages: Record<string, unknown> }>('/api/admin/usages').then(r => r.usages) as ReturnType<AppAPI['getUsageRegistry']>,

  // Admin Error Dashboard
  getErrorSummary: () => get('/api/admin/errors/summary'),
  listErrors: (opts) => {
    const params = new URLSearchParams();
    if (opts?.since) params.set('since', opts.since);
    if (opts?.until) params.set('until', opts.until);
    if (opts?.userId) params.set('userId', opts.userId);
    if (opts?.errorName) params.set('errorName', opts.errorName);
    if (opts?.limit) params.set('limit', String(opts.limit));
    if (opts?.offset) params.set('offset', String(opts.offset));
    const qs = params.toString();
    return get(`/api/admin/errors${qs ? `?${qs}` : ''}`);
  },
  getErrorDetail: (id) => get(`/api/admin/errors/${encodeURIComponent(id)}`),

  // Deep-link URL — web builds use the current origin
  getWebAppUrl: () => Promise.resolve(window.location.origin),

  // Admin Review (HTTP to server)
  adminReviewConfigured: () => Promise.resolve(true),
  adminReviewQueue: async () => {
    const res = await fetch('/api/admin/review/queue');
    if (!res.ok) throw new Error(`GET queue failed: HTTP ${res.status}`);
    const body = await res.json();
    return { items: body.items ?? body };
  },
  adminReviewStats: async () => {
    const res = await fetch('/api/admin/review/stats');
    if (!res.ok) throw new Error(`GET stats failed: HTTP ${res.status}`);
    return res.json();
  },
  adminReviewDetail: async (groupId: string) => {
    const res = await fetch(`/api/admin/review/detail/${encodeURIComponent(groupId)}`);
    if (!res.ok) throw new Error(`GET detail failed: HTTP ${res.status}`);
    return res.json();
  },
  adminReviewAction: async (action: unknown) => {
    const res = await fetch('/api/admin/review/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(action),
    });
    if (!res.ok) throwHttpError(res.status, new ActionableError({ goal: 'Perform admin review action', problem: `POST /api/admin/review/action failed with HTTP ${res.status}`, location: 'web-bridge.adminReviewAction', nextSteps: ['Retry the action', 'Check the admin review server logs if it persists'] }));
  },
  adminRemoveCommunityItem: async (type, id, reason) => {
    const res = await fetch(`/api/community/${encodeURIComponent(type)}/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    });
    if (!res.ok) throw new Error(`DELETE community item failed: HTTP ${res.status}`);
  },

  // Brief-timeout browser-local subscriptions (t/2218). Electron path goes via IPC in preload.
  onBriefTimeout: (cb) => { briefTimeoutCbs.add(cb); return () => briefTimeoutCbs.delete(cb); },
  onBriefRetriesExhausted: (cb) => { briefExhaustedCbs.add(cb); return () => briefExhaustedCbs.delete(cb); },
};

export const api = instrumentBridge(rawApi);

export function isElectronMode(): boolean {
  return typeof window !== 'undefined' && 'electronAPI' in window;
}
