// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/1295 (route extraction seam, repo-review B-209): the request/response helpers
// that every route handler shares. Extracted verbatim from server.ts so route
// clusters can move to routes/*.ts and still call the same json/error/param/query
// contract. No module state lives here — these are pure over (req, res). The
// route registrar (Router) and per-request context (ServerCtx) build on this.

import type { IncomingMessage, ServerResponse } from 'http';
import { getGlobalRecorder } from '../../../lib/flight-recorder/index.js';
import { ActionableError } from '../../../lib/debate/errors.js';
import { log, getRequestId } from './logger.js';
import { clientSafeMessage } from './security/accessControl.js';

export type Handler = (req: IncomingMessage, res: ServerResponse, body: unknown) => Promise<void> | void;

export function json(res: ServerResponse, data: unknown, status = 200): void {
  // t/1515: idempotent write. A second response (a handler replying after a client
  // abort, or after the endpoint timeout guard already answered) would throw
  // ERR_STREAM_WRITE_AFTER_END and crash the request. No-op with a trace instead.
  if (res.writableEnded || res.headersSent) {
    log.server.warn({ component: 'httpKit', status }, 'json(): response already sent — skipping duplicate write');
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const OPEN_BRACKET = Buffer.from('[');
const CLOSE_BRACKET = Buffer.from(']');
const OPEN_BRACE = Buffer.from('{');
const CLOSE_BRACE = Buffer.from('}');
const COMMA = Buffer.from(',');
const COLON = Buffer.from(':');

/** t/3165/t/4286: serialize a large array or plain object to a JSON Buffer WITHOUT a single
 *  un-yielded JSON.stringify OR a single un-yielded string-join. A ~4144-entry synthetic-
 *  embeddings map (or a big number[][]) stringified at once blocked the prod event loop ~3s —
 *  t/3165 fixed that by chunk-yielding the per-item JSON.stringify calls, but still assembled
 *  the final payload with ONE synchronous `parts.join(',')` + string concatenation over the
 *  full ~400MB result. V8 string concatenation at that size is itself a multi-second, un-
 *  yieldable block (t/4286: canary found 1.7-3.8s depending on vCPU) — chunking the stringify
 *  loop did nothing to shrink it. Fix: convert each item straight to a UTF-8 Buffer as it's
 *  built (already inside the yielding loop) and assemble the result with `Buffer.concat` — a
 *  native byte copy, not a JS string operation, so there's no second un-yielded pass. Output is
 *  byte-identical to JSON.stringify for arrays / plain objects of JSON-safe values (same key
 *  order, no whitespace, undefined/function-valued keys omitted, array holes → null). Non-array/
 *  non-object values fall back to a direct stringify.
 *  CAVEAT (t/3237): assumes a PLAIN top-level array/object — a top-level `toJSON()` is NOT honored
 *  (the top level is iterated by entries/elements directly). Nested `toJSON()` IS honored (handled by
 *  the inner JSON.stringify of each value). Callers with a custom top-level toJSON should use json(). */
export async function jsonStringifyChunked(value: unknown, yieldEvery = 256): Promise<Buffer> {
  const yieldToLoop = (): Promise<void> => new Promise<void>((r) => setImmediate(r));
  if (Array.isArray(value)) {
    if (value.length === 0) return Buffer.from('[]');
    const chunks: Buffer[] = [OPEN_BRACKET];
    for (let i = 0; i < value.length; i++) {
      if (i > 0) chunks.push(COMMA);
      chunks.push(Buffer.from(JSON.stringify(value[i]) ?? 'null', 'utf-8')); // array slot of undefined/function → null
      if ((i + 1) % yieldEvery === 0) await yieldToLoop();
    }
    chunks.push(CLOSE_BRACKET);
    return Buffer.concat(chunks);
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    const chunks: Buffer[] = [OPEN_BRACE];
    let emitted = 0;
    for (let i = 0; i < entries.length; i++) {
      const sv = JSON.stringify(entries[i][1]);
      if (sv === undefined) continue; // undefined/function/symbol values are omitted, like JSON.stringify
      if (emitted > 0) chunks.push(COMMA);
      chunks.push(Buffer.from(JSON.stringify(entries[i][0]), 'utf-8'), COLON, Buffer.from(sv, 'utf-8'));
      emitted++;
      if ((i + 1) % yieldEvery === 0) await yieldToLoop();
    }
    chunks.push(CLOSE_BRACE);
    return Buffer.concat(chunks);
  }
  return Buffer.from(JSON.stringify(value) ?? 'null');
}

/** t/3165: send a pre-serialized JSON Buffer. Mirrors json()'s idempotent-write guard; use with a
 *  cached Buffer (e.g. the serialize-once synthetic-embeddings cache) to skip re-stringifying. */
export function sendJsonBuffer(res: ServerResponse, buffer: Buffer, status = 200): void {
  if (res.writableEnded || res.headersSent) {
    log.server.warn({ component: 'httpKit', status }, 'sendJsonBuffer(): response already sent — skipping duplicate write');
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(buffer);
}

// t/1379: record 4xx client errors to the flight recorder (warn — expected
// client errors, not server faults) so a client-side 4xx can be correlated with
// server state by requestId. Server-side dump only; never leaked to the client.
function recordClientError(res: ServerResponse, route: string, status: number, message: string): void {
  getGlobalRecorder()?.record({
    type: 'lifecycle', component: 'server', level: 'warn',
    message: `${route}: ${status} client error`,
    data: {
      method: (res as unknown as { req?: { method?: string } }).req?.method,
      path: route, status, requestId: getRequestId(), errorMessage: message,
    },
  });
}

// Prod 5xx: record the real detail server-side (withheld from the client body).
function recordServerError(route: string, status: number, message: string, cause: unknown): void {
  getGlobalRecorder()?.record({
    type: 'system.error',
    component: route,
    level: 'error',
    message: `${route}: server error (detail withheld from client)`,
    error: { name: (cause as Error)?.name ?? 'Error', message, stack: (cause as Error)?.stack },
    data: { response_status: status },
  });
}

/** t/4185: map a thrown ActionableError's `httpStatus` (e.g. 409 on a storage write conflict) to
 *  the HTTP response status, falling back when the error didn't set one (an ordinary unexpected
 *  failure stays a 500). Server-side counterpart to the renderer's existing bridge convention —
 *  chatStream.ts/electron-bridge.ts already set `err.httpStatus` from `res.status` on the client
 *  side; this makes the same field load-bearing end to end instead of server-only dead code. */
export function statusForError(err: unknown, fallback = 500): number {
  return err instanceof ActionableError && err.httpStatus ? err.httpStatus : fallback;
}

/** t/4185: pull a machine-readable `code` (e.g. 'WRITE_CONFLICT') off a thrown ActionableError for
 *  the `extra` param of `error()` below — the UI branches on `code`, never on the transport status,
 *  because the same HTTP status can mean different things across routes. Returns undefined when
 *  the error didn't set one, so callers can spread it without adding a stray `code: undefined` key. */
export function codeForError(err: unknown): { code: string } | undefined {
  return err instanceof ActionableError && err.code ? { code: err.code } : undefined;
}

/** t/4187/t/4189/t/4190/t/4192: the If-Match precondition shared by every GitHub-backed save
 *  route (taxonomy, edges, conflicts, proposals) — a missing header means the client loaded the
 *  file before this contract existed (or skipped the version-returning read), so there's no base
 *  version to protect against a lost update. Returns the unquoted baseSha on success, or
 *  undefined after already writing the 428 response. */
export function requireBaseVersion(req: IncomingMessage, res: ServerResponse): string | undefined {
  const ifMatch = req.headers?.['if-match'];
  // t/4184 GV (TL, p/775#56): strip a leading weak-validator `W/` marker before the quotes — a
  // client that forwards the GET's ETag verbatim (RFC 7232 allows either strength) must still
  // match, since this route compares the raw git blob SHA, not validator semantics.
  const baseSha = typeof ifMatch === 'string' ? ifMatch.replace(/^W\//, '').replace(/^"|"$/g, '') : undefined;
  if (!baseSha) {
    error(res, 'Save requires an If-Match header carrying the base version read before editing.', 428, undefined, { code: 'BASE_VERSION_REQUIRED' });
    return undefined;
  }
  return baseSha;
}

export function error(res: ServerResponse, message: string, status = 500, cause?: unknown, extra?: Record<string, unknown>): void {
  // M4: don't leak internal detail (file paths, stack) to clients on server
  // errors in production — record the real message server-side, return generic.
  const route: string = (res as unknown as { __routePath?: string }).__routePath ?? 'server';
  // t/1515: if the response already went out (client abort, or the endpoint timeout
  // guard answered first), skip — avoids a duplicate log/FR record and a crash.
  if (res.writableEnded || res.headersSent) {
    log.server.warn({ component: route, status }, `${route}: response already sent — skipping duplicate error(${status})`);
    return;
  }
  // t/1362: every 500 logs at error level to Pino — the always-on safety net so
  // server errors are visible in container logs (az containerapp logs show)
  // without a browser-triggered FR dump. The FR record below is prod+dump-gated;
  // this is not. Full message stays server-side (never leaked to the client body).
  if (status >= 500) {
    log.server.error({ component: route, status, err: cause }, `${route}: server error (${status}) — ${message}`);
  }
  if (status >= 400 && status < 500) {
    recordClientError(res, route, status, message);
  }
  if (status >= 500 && process.env.NODE_ENV === 'production') {
    recordServerError(route, status, message, cause);
    json(res, { error: 'Internal server error', requestId: getRequestId() }, status);
    return;
  }
  // t/853: strip ActionableError internals (location, resolve steps) from <500
  // responses in production; keep the user-actionable summary.
  // t/3261 (TL ruling t/3261#1, option B): CodeQL js/stack-trace-exposure here is a FALSE POSITIVE —
  // clientSafeMessage (security/accessControl.ts) NEVER returns cause.stack: in production it returns
  // only the ActionableError `goal: problem` or a Goal/Error-stripped summary; the prod 5xx branch above
  // returns a constant. The only uncurated path is DEV (!isProduction), which returns `message`
  // (= String(err), the message — not the stack). CodeQL taints the caught `cause` Error into the
  // response but can't see the sanitizer barrier. A true structural fix = modeling clientSafeMessage as a
  // CodeQL sanitizer (query-side, DevOps), not app code — so suppress with justification here.
  // REVISIT if that sanitizer model lands or clientSafeMessage's contract changes.
  json(res, { error: clientSafeMessage(message, cause), requestId: getRequestId(), ...extra }, status); // codeql[js/stack-trace-exposure]
}

/** t/1515/t/1516 — defense-in-depth wall-clock cap for handlers that call out to
 * slow subsystems (AI compute, subprocesses). The inner calls should self-bound;
 * set `ms` deliberately ABOVE the inner timeout so in normal operation the inner
 * answers first and this never fires. It only trips if the inner timeout fails to
 * bound the request, guaranteeing the HTTP layer still returns a structured 504 and
 * frees the socket instead of hanging until the client aborts. Relies on the
 * idempotent json()/error() above so a late inner response after the guard is a
 * no-op, not a write-after-end crash. */
export function withEndpointTimeout(
  res: ServerResponse, ms: number, label: string, fn: () => Promise<void>,
): Promise<void> {
  const timer = setTimeout(() => {
    if (res.writableEnded || res.headersSent) return;
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'server', level: 'error',
      message: `${label}: endpoint timeout guard fired after ${ms / 1000}s — inner timeout did not bound the request`,
    });
    error(res, `${label} timed out after ${ms / 1000}s`, 504);
  }, ms);
  return fn().finally(() => clearTimeout(timer));
}

export function param(req: IncomingMessage, name: string, routePath: string): string {
  // Simple :param extraction from URL
  const urlParts = new URL(req.url!, `http://localhost`).pathname.split('/');
  const routeParts = routePath.split('/');
  for (let i = 0; i < routeParts.length; i++) {
    if (routeParts[i] === `:${name}`) return decodeURIComponent(urlParts[i]);
  }
  return '';
}

export function query(req: IncomingMessage, name: string): string | null {
  const url = new URL(req.url!, `http://localhost`);
  return url.searchParams.get(name);
}

/** t/2019 (js/user-controlled-bypass) — the ONE canonical request-path parse shared
 *  by the auth gate and the router, so both make their allow/deny + routing decision
 *  on the *identical* normalized pathname. The gate previously derived its path from
 *  raw `req.url.split('?')` while the router used `new URL().pathname`: an
 *  encoded-traversal path (e.g. `/api/public/%2e%2e/admin`) read as a public prefix at
 *  the gate but resolved elsewhere (`/api/admin`) at the router — an auth bypass.
 *  Routing both through this helper makes "gate and router agree" structural, not two
 *  parses that happen to coincide. A malformed URL fails secure. */
export function normalizedRequestPath(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', `http://localhost`).pathname;
  } catch {
    // Malformed URL (bad percent-encoding, protocol-relative '//'): fail secure to a
    // sentinel that is never in the public allowlist and matches no route — the
    // request is gated, then 404s, and the gate never throws mid-decision. Logged (not
    // flight-recorder-recorded) so a hostile/garbled path is visible to ops without an
    // attacker-controlled dump-amplification vector; the raw URL is withheld because a
    // query string can carry a secret (no-secrets-in-logs rule).
    log.server.warn({ component: 'httpKit' }, 'normalizedRequestPath: unparseable req.url — failing secure to gated sentinel');
    return '/__malformed_url__';
  }
}

/** Best-effort client IP: first X-Forwarded-For hop (behind the Azure ingress
 *  proxy), else the raw socket address. Used for per-IP rate-limit keys. */
export function getClientIp(req: IncomingMessage): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) return xff.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

// ── Route registrar (t/1295) ──
// The surface extracted cluster modules (routes/*.ts) use to register routes into
// the server's shared table, so server.ts only wires the registrar.

type RouteRecord = { method: string; path: string; handler: Handler };

export interface Router {
  get(path: string, h: Handler): void;
  post(path: string, h: Handler): void;
  put(path: string, h: Handler): void;
  patch(path: string, h: Handler): void;
  del(path: string, h: Handler): void;
}

/** A Router that appends to the caller's existing `routes` array — same shape and
 *  order semantics as server.ts's local get/post/put/del helpers. */
export function createRouter(routes: RouteRecord[]): Router {
  return {
    get: (p, h) => { routes.push({ method: 'GET', path: p, handler: h }); },
    post: (p, h) => { routes.push({ method: 'POST', path: p, handler: h }); },
    put: (p, h) => { routes.push({ method: 'PUT', path: p, handler: h }); },
    patch: (p, h) => { routes.push({ method: 'PATCH', path: p, handler: h }); },
    del: (p, h) => { routes.push({ method: 'DELETE', path: p, handler: h }); },
  };
}
