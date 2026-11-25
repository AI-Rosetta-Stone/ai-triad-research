// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Pure access-control decisions extracted from server.ts so they can be unit
// tested (server.ts calls server.listen() at import time and isn't import-safe).
// See t/720 (L1, L3, L6).

import path from 'path';
import crypto from 'crypto';
import type { IncomingHttpHeaders } from 'http';
import { isSafeId, isSafePov, isSafeFilename } from '../storage/fileIO.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { isAnonGetAllowlisted, anonGetAllowlistEnforced, recordAnonGetDenied } from './anonGetAllowlist.js';

// Review group ids are "domain:id" (e.g. "calibration:jpsnover") — allow the
// colon, still block path separators / dots / encoded sequences.
const GROUP_ID_RE = /^[a-zA-Z0-9_:-]+$/;

// Container ids are "type:id" (e.g. "node:sit-021", "sei:abc") — the colon is
// structural, so isSafeId (which rejects ':') would 400 every one (t/2930). Same
// anchored + character-classed safe set as GROUP_ID_RE: permits ':' but still
// rejects '.', '/', '\', null bytes, and thus '..'/%2e%2e traversal.
const CONTAINER_ID_RE = /^[a-zA-Z0-9_:-]+$/;

/**
 * t/810: routing-layer path-param validation. Given a matched route pattern and
 * the request pathname, return the name of the first user-provided `:param`
 * whose (decoded) value fails its whitelist, or null if all pass. Validating the
 * decoded value mirrors param() (which decodes) and catches encoded traversal
 * (%2e%2e → ".."), while allowing legit encoded chars (e.g. ":" in group ids).
 * Per-param classes mirror the handlers' own assert* checks (defense-in-depth).
 */
export function invalidRouteParam(routePath: string, pathname: string): string | null {
  const patternParts = routePath.split('/');
  const pathParts = pathname.split('/');
  for (let i = 0; i < patternParts.length; i++) {
    const seg = patternParts[i];
    if (!seg.startsWith(':')) continue;
    const name = seg.slice(1);
    let value: string;
    try { value = decodeURIComponent(pathParts[i] ?? ''); }
    catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'server', level: 'warn',
        message: `Malformed percent-encoding in path param '${name}'`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      return name; // malformed percent-encoding — reject
    }
    const validator =
      name === 'pov' ? 'isSafePov'
        : (name === 'filename' || name === 'name') ? 'isSafeFilename'
          : name === 'groupId' ? 'GROUP_ID_RE'
            : name === 'containerId' ? 'CONTAINER_ID_RE'
              : 'isSafeId';
    const ok =
      name === 'pov' ? isSafePov(value)
        : (name === 'filename' || name === 'name') ? isSafeFilename(value)
          : name === 'groupId' ? GROUP_ID_RE.test(value)
            : name === 'containerId' ? CONTAINER_ID_RE.test(value)
              : isSafeId(value);
    if (!ok) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'server', level: 'warn',
        message: `invalidRouteParam: rejected '${name}' value=${JSON.stringify(value)} validator=${validator}`,
        data: { param: name, value, validator },
      });
      return name;
    }
  }
  return null;
}

/**
 * t/897: Set-Cookie values that expire the Easy Auth session cookies. Azure's
 * /.auth/logout doesn't reliably clear AppServiceAuthSession (it can be chunked
 * into AppServiceAuthSession, AppServiceAuthSession1, …), leaving the session
 * valid after "Sign Out". The logout endpoint expires every such cookie present
 * on the request (plus the canonical name) before handing off to /.auth/logout.
 * Deletion only requires matching name + Path, so the fixed attributes are safe.
 */
export function expiredAuthCookies(presentCookieNames: string[]): string[] {
  const names = new Set(presentCookieNames.filter(n => /^AppServiceAuthSession/i.test(n)));
  names.add('AppServiceAuthSession');
  return [...names].map(n =>
    `${n}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax`);
}

// UUID v4: version bit = 4, variant bits = [89ab]. Matches exactly
// crypto.randomUUID() output — length and charset are checked simultaneously.
const ANON_SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** t/2464: true iff `id` has the exact shape produced by crypto.randomUUID(). */
export function isValidAnonSessionId(id: string): boolean {
  return ANON_SESSION_UUID_RE.test(id);
}

/**
 * t/2464: reuse-not-rotate. Returns `existing` when it is a well-formed UUID v4
 * (the only shape this server ever mints), otherwise mints a fresh one.
 *
 * INVARIANT: `existing` MUST come from parseCookies(req) — never from a query
 * parameter, request body, or header. The HttpOnly flag prevents JS from forging
 * the cookie; query/body/header inputs are untrusted and must never reach here.
 */
export function resolveAnonSessionId(existing: string | undefined): string {
  return (existing !== undefined && isValidAnonSessionId(existing))
    ? existing
    : crypto.randomUUID();
}

/**
 * Mint the two anonymous-session cookies: the `auth_anonymous=1` flag the auth
 * gate reads and the `anon_session_id` pseudonymous identifier. Shared by
 * GET /.auth/anonymous (302) and POST /api/auth/anonymous (JSON, t/1483) so
 * the Secure-flag gating can't drift between the two mint sites.
 * HttpOnly (never read by JS) and SameSite=Lax. Secure is added in production
 * or whenever cross-origin is configured. Max-Age=1yr on anon_session_id makes
 * it persistent across browser sessions (t/2464); auth_anonymous stays session-
 * scoped so it acts as a "logged in anonymously" signal only while the tab is open.
 */
export function anonymousSessionCookies(sessionId: string): string[] {
  const secureSuffix = process.env.NODE_ENV === 'production' || process.env.ALLOWED_ORIGINS ? '; Secure' : '';
  return [
    `auth_anonymous=1; Path=/; HttpOnly; SameSite=Lax${secureSuffix}`,
    `anon_session_id=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secureSuffix}`,
  ];
}

/**
 * t/940: true when the request carries an Easy Auth session cookie
 * (AppServiceAuthSession, possibly chunked). When this is present but the request
 * is unauthenticated (no principal), the session is stale and loops the OAuth
 * redirect — the login gate expires the cookie before serving the page.
 */
export function hasEasyAuthSessionCookie(cookieNames: string[]): boolean {
  return cookieNames.some(n => /^AppServiceAuthSession/i.test(n));
}

export type TestPersona = 'anonymous' | 'authenticated' | 'admin';
/** Fixed non-admin principal for the `authenticated` persona (must not be an ADMIN_USERS entry). */
const TEST_PERSONA_AUTH_USER = 'test-persona-user';

/** Constant-time string compare (equal-length only; length mismatch → false). */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * t/1125: dev/staging-only short-circuit of Azure Easy Auth for the persona test
 * matrix (Test-PersonaEndpoints, t/1103). Lets a CLI regression net exercise the
 * `authenticated`/`admin` rows without a real browser OAuth round-trip.
 *
 * PRODUCTION-INERT by construction: the whole path is unreachable unless the
 * deployment sets `ENABLE_TEST_PERSONA_HEADER=1` AND a matching `TEST_PERSONA_SECRET`.
 * With the env var unset (the prod default) this returns null immediately, so the
 * `X-Test-Persona` header is completely ignored — Easy Auth handling is untouched.
 *
 * Returns:
 *  - `null` — feature disabled, or no `X-Test-Persona` header (normal Easy Auth path).
 *  - `{ error }` — enabled + persona header present but the shared secret is
 *    missing/wrong, or the persona value is invalid (caller responds 401).
 *  - `{ principalName, idp, persona }` — the override identity to use for the
 *    rest of the request. Admin/tier resolution then flows normally from there.
 *
 * The `admin` persona uses idp `github`, for which deriveStorageUserId is just a
 * lowercase identity — so `adminUsers[0]` (already in its derived form) resolves
 * back to itself and lands in ADMIN_USERS for whatever the deployment configures.
 */
export function resolveTestPersonaOverride(
  headers: IncomingHttpHeaders,
  adminUsers: string[],
): { principalName: string; idp: string; persona: TestPersona } | { error: 'test_persona_bad_secret' | 'test_persona_invalid' } | null {
  if (process.env.ENABLE_TEST_PERSONA_HEADER !== '1') return null; // disabled (prod default)

  const persona = headers['x-test-persona'];
  if (typeof persona !== 'string' || persona === '') return null; // no override requested

  // Shared-secret gate: a non-empty TEST_PERSONA_SECRET must be configured AND match.
  const expected = process.env.TEST_PERSONA_SECRET ?? '';
  const provided = typeof headers['x-test-persona-secret'] === 'string' ? headers['x-test-persona-secret'] as string : '';
  if (!expected || !timingSafeEqualStr(provided, expected)) {
    return { error: 'test_persona_bad_secret' };
  }

  switch (persona) {
    case 'anonymous':
      return { principalName: '', idp: '', persona };
    case 'authenticated':
      return { principalName: TEST_PERSONA_AUTH_USER, idp: 'github', persona };
    case 'admin':
      return { principalName: adminUsers[0] ?? '', idp: 'github', persona };
    default:
      return { error: 'test_persona_invalid' };
  }
}

/**
 * t/896: structured fast-fail when the caller has no usable API key for the
 * target backend — returned as a 422 before the request reaches the AI adapter
 * (which would otherwise surface an opaque upstream 401/403). Returns null (=
 * proceed) when the free tier provides the key, the caller supplied one, or a
 * stored/env key resolves.
 */
export function missingApiKeyError(opts: {
  backend: string;
  displayName: string;
  serverProvidedKey: boolean;
  haveExplicitKey: boolean;
  hasResolvedKey: boolean;
}): { error: 'missing_api_key'; backend: string; message: string } | null {
  if (opts.serverProvidedKey || opts.haveExplicitKey || opts.hasResolvedKey) return null;
  return {
    error: 'missing_api_key',
    backend: opts.backend,
    message: `No API key configured for ${opts.displayName}. Add one in Settings → API Keys.`,
  };
}

/** Duck-typed ActionableError (avoids importing across the lib boundary). */
function isActionableErrorLike(e: unknown): e is { goal: string; problem: string } {
  return !!e && typeof e === 'object' && 'goal' in e && 'problem' in e && 'nextSteps' in e;
}

/**
 * t/3515 (CodeQL js/stack-trace-exposure #5707): remove V8 stack-frame lines from a string.
 * A frame is `    at <site> (path:line:col)` or `    at path:line:col` — keyed on the
 * `:line:col` numeric signature, NOT a bare `at ` prefix, so legitimate prose that merely
 * starts with "at " ("at least 3 nodes required") survives untouched (TL t/3515#2).
 * This is the sanitizer barrier on the client-error path: even if a stack ever leaked into
 * an error `message` (e.g. a caller passing `String(err)` where err.stack bled into it), it
 * is scrubbed before `clientSafeMessage` returns it toward an HTTP response body.
 */
export function stripStackFrames(s: string): string {
  const stripped = s
    .split('\n')
    .filter(line => !/\bat\s+.*:\d+:\d+\)?\s*$/.test(line))
    .join('\n')
    .trimEnd();
  // If the input was nothing but frames, don't return an empty body — give a generic floor.
  return stripped.trim() ? stripped : 'Request failed';
}

/**
 * t/853: produce a client-safe error string for production. ActionableError
 * carries `location`, `Resolve:` steps, and stacks that reveal server internals
 * (source paths, function names) — in production keep only the user-actionable
 * `goal: problem`. Handles an ActionableError `cause` and a message that is
 * already a serialized ActionableError dump. Outside production the full message
 * is returned unchanged (dev/debug ergonomics).
 *
 * t/3515: every return is routed through `stripStackFrames` — a single, CodeQL-visible
 * sanitizer barrier on the flow from the caught error toward the response body, so
 * js/stack-trace-exposure (#5707) closes structurally rather than via per-line suppression.
 */
export function clientSafeMessage(message: string, cause?: unknown, isProduction = process.env.NODE_ENV === 'production'): string {
  return stripStackFrames(rawClientMessage(message, cause, isProduction));
}

function rawClientMessage(message: string, cause: unknown, isProduction: boolean): string {
  if (!isProduction) return message;
  if (isActionableErrorLike(cause)) return `${cause.goal}: ${cause.problem}`;
  if (/\n\s*Location:/.test(message)) {
    const goal = message.match(/Goal:\s*(.+)/)?.[1]?.trim();
    const prob = message.match(/Error:\s*(.+)/)?.[1]?.trim();
    return goal && prob ? `${goal}: ${prob}` : 'Request failed';
  }
  return message;
}

/**
 * t/848: the identity to feed proxyTiers.resolveTier, sourced from the verified
 * ALS user context (populated once by the S9 middleware from
 * AZURE_AUTH_ENABLED-guarded headers) — never from raw request headers. An
 * anonymous caller (or no context) maps to an empty principal so resolveTier
 * yields the free/anonymous tier, never platform — even if a spoofed
 * x-ms-client-principal-* header is present when Easy Auth isn't in front.
 */
export function callerTierIdentity(
  user: { principalName: string; idp: string; isAnonymous: boolean } | null,
): { principalName: string; idp: string } {
  if (!user || user.isAnonymous) return { principalName: '', idp: '' };
  return { principalName: user.principalName, idp: user.idp };
}

/**
 * L1: whether an AUTH_DISABLED=1 setting should be honored. AUTH_DISABLED makes
 * every request an anonymous user with full access — acceptable for local/dev
 * single-operator use, never in production. Honored only outside production.
 */
export function isAuthDisabledAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AUTH_DISABLED === '1' && env.NODE_ENV !== 'production';
}

/**
 * L3: whether `target` resolves to `base` itself or a path nested under it.
 * Used to confine the /api/data/clone target to the configured data directory
 * (an arbitrary path there is an admin-only arbitrary-write primitive).
 */
export function isPathWithinDir(target: string, base: string): boolean {
  const resolvedTarget = path.resolve(target);
  const resolvedBase = path.resolve(base);
  return resolvedTarget === resolvedBase || resolvedTarget.startsWith(resolvedBase + path.sep);
}

/**
 * L6: whether a caller may open the terminal WebSocket (which spawns a
 * server-side shell). AUTH_DISABLED is single-operator local/dev mode (L1
 * forbids it in production), so the local operator keeps access; every
 * authenticated deployment requires an admin user with a resolved principal.
 */
export function isTerminalAccessAllowed(opts: {
  authDisabled: boolean;
  principalName: string;
  isAdmin: boolean;
}): boolean {
  if (opts.authDisabled) return true;
  if (!opts.principalName) return false;
  return opts.isAdmin;
}

// AI/inference routes anonymous users can never reach (keys, AI, embeddings, NLI).
const AI_ROUTE_PREFIXES = ['/api/keys', '/api/ai/', '/api/embeddings/', '/api/nli/'];

// AI-prefixed routes that are nonetheless safe for anonymous callers: local
// server-side config with no key, no cost, and no abuse vector (t/811). Checked
// before the blanket AI block so chat/debates can set temperature pre-generation.
const ANON_SAFE_AI_ROUTES = ['/api/ai/temperature'];

// Routes blocked for anonymous callers regardless of HTTP method: the blanket AI
// block plus specific non-AI routes with cost/abuse potential. The ANON_SAFE_AI_ROUTES
// exemption is checked by the caller BEFORE this, so a temperature-style local-config
// route escapes the AI-prefix block. Fail-closed: any listed match blocks the request.
function isAnonBlockedRoute(urlPath: string): boolean {
  // Block all AI-related routes regardless of method
  if (AI_ROUTE_PREFIXES.some(p => urlPath.startsWith(p))) return true;
  if (urlPath === '/api/evidence-qbaf') return true;
  if (urlPath === '/api/models/refresh') return true;
  if (urlPath.startsWith('/api/harvest/')) return true;
  return /^\/api\/debates\/[^/]+\/news-report$/.test(urlPath);
}

// Anonymous users can save/delete their own ephemeral chats and debates.
// Matches both '/api/debates' (create/save) and '/api/debates/{id}' (update/delete).
// NOTE: this is used only for POST/PUT/DELETE — PATCH has its own narrow check below
// (t/2230) to prevent future sub-paths from silently inheriting anon write access.
function isAnonUserContentRoute(urlPath: string): boolean {
  return urlPath === '/api/chats' || urlPath.startsWith('/api/chats/')
    || urlPath === '/api/debates' || urlPath.startsWith('/api/debates/');
}

// POST routes anonymous callers may reach: read-like operations only, everything
// else blocked. Exact-match allowlist (no prefixes).
const ANON_SAFE_POST_PATHS = [
  '/api/flight-recorder/dump',
  // t/579 (incident): '/api/flight-recorder/server-dump' removed. It writes the unfiltered server
  // event buffer plus the drained server logs to a file that the GET routes below served to anyone.
  '/api/debates/export',
  '/api/source-evidence',
  '/api/analytics/event',
  '/api/admin/telemetry',
  '/api/admin/errors',
  '/api/data/check-updates',
  '/api/community/submit',
  '/focus-node',
  '/debug/events',
];

// t/3480: anon POST for the community op-ed public-link mint. Parameterized path
// (per-id), so it can't live in the exact-match ANON_SAFE_POST_PATHS above — a
// dedicated regex list instead. Mint only — DELETE (revoke) stays authed via the
// existing `method === 'DELETE' → false` branch below; no regex check runs for
// DELETE, so revoke on the same path is unaffected by this list. TL auth ruling
// (t/3479): mint is idempotent (one stable shareId per item, repeat calls are
// cheap), rate-limited, and the public copy strips community_metadata.
//
// Rate-bucket note (t/3480, TL-confirmed p/602#6): `community-oped-share:<userId>`
// collapses to ONE shared 20/min bucket across all anon callers (getStorageUserId()
// returns '_local' for every anonymous request — see userContext.ts). Accepted as
// documented rather than IP-keyed: mint is idempotent so the failure mode of the
// shared cap is "anon minting pauses briefly," not data exposure or per-caller
// unfairness with lasting effect. Revisit (switch to IP-keying in community.ts,
// Server Community's scope) if telemetry shows the shared bucket actually
// exhausting under real anon traffic — i.e. anon callers observing 429s on
// /api/community/opeds/*/share in production, not merely a theoretical shared-cap
// concern.
const ANON_SAFE_POST_REGEXES = [
  /^\/api\/community\/opeds\/[^/]+\/share$/,
];

/** t/579: flight-recorder GET routes refused to anonymous callers: the folder listing and the
 *  per-file download and viewer (they serve server dumps). Matched on the lower-cased path so
 *  '/api/flight-recorder/list/', '/API/Flight-Recorder/download/x' and similar are caught too. */
const ANON_BLOCKED_FLIGHT_RECORDER_GET_RE = /^\/api\/flight-recorder\/(?:list(?:\/|$)|download\/|view\/)/;

function isAnonBlockedFlightRecorderGet(urlPath: string): boolean {
  return ANON_BLOCKED_FLIGHT_RECORDER_GET_RE.test(urlPath.toLowerCase());
}

/** t/3259: the debate-only ~400MB synthetic-embeddings corpus GET — anon access is gated on the
 *  anon-debates flag rather than the blanket GET-allow below. */
const SYNTHETIC_EMBEDDINGS_PATH = '/api/taxonomy/synthetic-embeddings';

/** t/579 (incident, second containment): GETs that returned personal or cross-user data to anonymous
 *  callers on prod. admin/health has recent feedback keyed by an email address and recent errors;
 *  analytics/query lists site-wide user identifiers with activity; analytics/engagement has site-wide
 *  usage; calibration/log and /history hold cross-user calibration metrics. Compared on the lower-cased
 *  path without a trailing slash. Root fixes (auth in the handlers) belong to the route owners. */
const ANON_BLOCKED_DATA_GETS: readonly string[] = [
  '/api/admin/health',
  '/api/analytics/query',
  '/api/analytics/engagement',
  '/api/calibration/log',
  '/api/calibration/history',
];

/** The anonymous GET decision (t/579 blocks, then t/574 deny-by-default). Split out of isAnonAllowedRoute for its complexity budget. */
function isAnonGetAllowed(urlPath: string): boolean {
  // t/579 (incident): no anonymous read of admin health, site-wide analytics or calibration data.
  if (ANON_BLOCKED_DATA_GETS.includes(urlPath.toLowerCase().replace(/\/+$/, ''))) return false;
  // t/3259 + t/3260 (PM ruling, TL-confirmed p/522#192): the ~400MB synthetic-embeddings corpus export
  // is AUTH-ONLY — never anon-reachable, independent of any flag. This is the SOLE always-on protection:
  // anon debates, when later enabled, MUST route through the tiny /relevant-nodes endpoint (T2/t/3257),
  // never the corpus. Bypass-safe: server.ts feeds BOTH this gate and the router (matchRoute) the
  // identical normalizedRequestPath (new URL().pathname), so a `?query` is stripped for both (=== matches
  // → blocked) and a trailing slash makes matchRoute's exact segment-count match 404 (nothing served);
  // the trailing-slash strip here blocks `/synth/` at the gate too.
  if (urlPath.replace(/\/+$/, '') === SYNTHETIC_EMBEDDINGS_PATH) return false;
  // t/579 (incident): the flight-recorder file routes (list, download, view) serve the shared dump
  // folder, including server dumps with every user's server events and log lines. Anonymous callers
  // get none of them. Prefix match, case-insensitive, so no trailing slash, encoding or case variant
  // of these paths gets through. download-merged/:dumpId stays: it omits the server side for
  // anonymous sessions (diagnostics.ts, includeServer).
  if (isAnonBlockedFlightRecorderGet(urlPath)) return false;
  // t/574 / t/590: deny by default. Only classified anonymous GETs pass (anonGetAllowlist.ts). Report-only until
  // ANON_GET_ALLOWLIST_ENFORCE=1: a would-deny is logged by route pattern and still allowed.
  const verdict = isAnonGetAllowlisted(urlPath);
  if (verdict.allowed) return true;
  const enforced = anonGetAllowlistEnforced();
  recordAnonGetDenied(verdict.pattern, enforced);
  return !enforced;
}

/**
 * Whether an anonymous (signed-out) user may call `method urlPath` in
 * AUTH_OPTIONAL mode. Anonymous users get read-only, non-AI access plus
 * save/delete of their own ephemeral chats/debates. Returning false drives the
 * `anon_route_blocked` 403 in the auth gate (t/763).
 */
export function isAnonAllowedRoute(method: string, urlPath: string): boolean {
  // Local-config AI routes (e.g. temperature) are exempt from the blanket AI
  // block — no key, no cost, no abuse vector (t/811). Must precede the block.
  if (ANON_SAFE_AI_ROUTES.includes(urlPath)) return true;
  if (isAnonBlockedRoute(urlPath)) return false;

  if (method === 'GET') return isAnonGetAllowed(urlPath);

  const isMutation = method === 'POST' || method === 'PUT' || method === 'DELETE';
  if (isMutation && isAnonUserContentRoute(urlPath)) return true;

  // PATCH is allowed only for debate delta saves on a specific debate id (t/2230).
  // Deliberately not routed through isAnonUserContentRoute — that prefix match would
  // silently grant anon PATCH to /api/chats/:id and future debate sub-paths.
  if (method === 'PATCH') return /^\/api\/debates\/[^/]+$/.test(urlPath);

  if (method === 'PUT' || method === 'DELETE') return false;

  // POST: allowlist read-like operations, block everything else
  return ANON_SAFE_POST_PATHS.some(p => urlPath === p)
    || ANON_SAFE_POST_REGEXES.some(r => r.test(urlPath));
}
