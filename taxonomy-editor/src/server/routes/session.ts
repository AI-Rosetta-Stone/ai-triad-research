// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/1687 (Phase 2 server.ts split, ADR-007): the auth-identity / analytics /
// diagnostics-beacon / focus-node / trace-channel route run, moved verbatim out
// of server.ts behind the registration seam. This run is the last route run,
// registered right after registerSyncRoutes (before the static-file pipeline),
// so registration order — and the routeTable snapshot — is preserved by placing
// registerSessionRoutes() at its former position.
//
// /focus-node broadcasts to connected WebSocket clients via broadcastEvent, which
// closes over the server's WebSocket client set and stays in server.ts; it is
// threaded in through the new ctx.broadcastEvent field. The trace-channel batch
// cap (TRACE_MAX_EVENTS_PER_BATCH) is used only by /debug/events, so it moves in
// as module-local state. All other helpers are pure module imports.

import type { IncomingMessage, ServerResponse } from 'http';
import type { Router } from '../httpKit.js';
import type { ServerCtx } from './context.js';
import { json, error, getClientIp } from '../httpKit.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { log } from '../logger.js';
import { deriveStorageUserId } from '../security/userContext.js';
import { isSafeId } from '../storage/fileIO.js';
import { getQuotaLimits } from '../security/quotas.js';
import { resolveReadOnlyFlag } from '../readOnlyGuard.js';
import { requireAdmin } from '../community/admin/reviewRegistry.js';
import { isAdmin } from '../community/community.js';
import * as analytics from '../community/analytics.js';
import { parseCookies } from '../httpCookies.js';
import { anonSessionCreatedCookie, readValidCreatedMs } from './anonSessionCreated.js';
import * as allowlistStore from '../storage/allowlistStore.js';
import type { UserSession } from '../../../../lib/allowlist/types.js';
// Re-exported so server.ts's pre-route anon mint sites import it here (keeps the
// server.ts import list flat / at its max-lines ceiling — t/2493).
export { anonSessionCookiesWithCreated } from './anonSessionCreated.js';

/** Resolve analytics user key for anonymous requests (t/2465).
 *  Returns 'anon:' + first 12 chars of anon_session_id (HttpOnly — server-reads only),
 *  or '_anonymous' when the cookie is absent (cookie-less fallback). */
export function resolveAnonSessionKey(req: IncomingMessage): string {
  const id = parseCookies(req).get('anon_session_id');
  return id ? `anon:${id.slice(0, 12)}` : '_anonymous';
}

const TRACE_MAX_EVENTS_PER_BATCH = 100;

/** Derive the analytics user id for a request from the Easy Auth principal headers
 *  (only when Azure auth is enabled), falling back to '_local'. */
function deriveRequestUserId(req: IncomingMessage): string {
  const azureAuth = process.env.WEBSITE_AUTH_ENABLED === 'True' || process.env.WEBSITE_AUTH_ENABLED === 'true';
  const principalName = azureAuth ? (req.headers['x-ms-client-principal-name'] as string) || '' : '';
  const idp = azureAuth ? (req.headers['x-ms-client-principal-idp'] as string) || '' : '';
  return deriveStorageUserId(principalName || '_local', idp || '_local');
}

/** §7.3 subject WHO breakdown — admin-only. Extracted so the engagement handler
 *  stays under the complexity ceiling (ADR-007). `subject` is already validated. */
async function serveSubjectBreakdown(
  res: ServerResponse, from: string, to: string,
  subject: string, groupBy: string | undefined, user: string | undefined,
): Promise<void> {
  if (!requireAdmin(res)) return;
  if (groupBy !== 'user' && groupBy !== 'session') { error(res, "groupBy must be 'user' or 'session'", 400); return; }
  json(res, await analytics.querySubjectBreakdown(from, to, subject, groupBy, user));
}

/** Engagement tree (+ §7.1 session scope, §7.2 sessions list). The session scope,
 *  other-user subtree, users table, and sessions list are all admin-only; non-admins
 *  receive only the anonymized aggregate. */
async function serveEngagementTree(
  res: ServerResponse, from: string, to: string,
  user: string | undefined, session: string | undefined,
  currentUserId: string, admin: boolean,
): Promise<void> {
  const needsAdmin = session !== undefined || (user !== undefined && user !== currentUserId);
  if (needsAdmin && !requireAdmin(res)) return;
  const { users, sessions, ...rest } = await analytics.queryEngagement(from, to, { user, session, includeSessions: admin });
  json(res, admin ? { ...rest, users, ...(sessions ? { sessions } : {}) } : rest);
}

export function registerSessionRoutes(r: Router, ctx: ServerCtx): void {
  const { get, post } = r;
  const { broadcastEvent } = ctx;

  // ── Analytics ──

  get('/api/auth/me', (req, res) => {
    const azureAuth = process.env.WEBSITE_AUTH_ENABLED === 'True'
      || process.env.WEBSITE_AUTH_ENABLED === 'true';
    const principalName = azureAuth
      ? (req.headers['x-ms-client-principal-name'] as string) || ''
      : '';
    const idp = azureAuth
      ? (req.headers['x-ms-client-principal-idp'] as string) || ''
      : '';
    const isAnon = !principalName;
    const authOpt = process.env.AUTH_OPTIONAL === '1';

    // t/2493: session_created_at = the anon session's mint time; for sessions
    // predating this feature (id cookie set, no created marker) it is the
    // first-seen time (this request), lazily backfilled server-side so the FR
    // field (t/2490 Gap 1) populates for the existing user base too. The created
    // cookie is untrusted client input — a bad/forged value is discarded and
    // re-backfilled with now; the raw cookie value is never echoed, only an ISO
    // string derived from a validated ms. Authenticated users: omitted (no
    // reliable account-creation source in Easy Auth headers).
    let sessionCreatedAt: string | undefined;
    if (isAnon && parseCookies(req).get('anon_session_id') !== undefined) {
      const now = Date.now();
      let createdMs = readValidCreatedMs(req, now);
      if (createdMs === null) {
        createdMs = now;
        res.setHeader('Set-Cookie', anonSessionCreatedCookie(createdMs)); // backfill / repair forged value
      }
      sessionCreatedAt = new Date(createdMs).toISOString();
    }

    // t/4296: a read-only account (e.g. ai-triad-smoke) still passes every other
    // capability check above — this is an orthogonal axis the smoke test asserts
    // directly. Shared with server.ts's enforceReadOnlyGuard (same fail-open+WARN default).
    const readOnly = resolveReadOnlyFlag(principalName, idp);

    json(res, {
      user: principalName || resolveAnonSessionKey(req),
      idp: idp || '',
      anonymous: isAnon,
      readOnly,
      ...(sessionCreatedAt ? { session_created_at: sessionCreatedAt } : {}),
      capabilities: {
        ai: !isAnon || !authOpt,
        write: (!isAnon || !authOpt) && !readOnly,
      },
    });
  });

  get('/api/user/profile', (req, res) => {
    const azureAuth = process.env.WEBSITE_AUTH_ENABLED === 'True'
      || process.env.WEBSITE_AUTH_ENABLED === 'true';
    const principalName = azureAuth
      ? (req.headers['x-ms-client-principal-name'] as string) || ''
      : '';
    const idp = azureAuth
      ? (req.headers['x-ms-client-principal-idp'] as string) || ''
      : '';
    const isAnon = !principalName;
    const userId = deriveStorageUserId(principalName || '_local', idp || '_local');
    const quotaLimits = isAnon ? null : getQuotaLimits(userId);
    // t/3498 (t/3495 epic, SO cond 5): ALWAYS a boolean — `false` for anonymous
    // callers and on any allowlist-read error, never absent/undefined (a client
    // reading `undefined` as falsy-but-ambiguous was the exact failure mode SO
    // cond 5 closes). allowlistStore.isAllowlisted already fails CLOSED to `[]`
    // internally (t/3497); the try/catch is a second, cheap belt-and-suspenders
    // layer against any other unexpected throw.
    let geminiAllowlisted = false;
    if (!isAnon) {
      try { geminiAllowlisted = allowlistStore.isAllowlisted(userId); }
      catch (err) {
        geminiAllowlisted = false;
        log.server.warn({ err, userId, cause: 'allowlist-check-unexpected-throw' },
          'geminiAllowlisted check failed unexpectedly — failing closed to false (t/3498)');
      }
    }
    const profile: UserSession = {
      userId,
      displayName: principalName || 'Anonymous',
      idp: idp || null,
      isAnonymous: isAnon,
      isAdmin: isAdmin(userId), // t/4229: use the shared helper, not an inline ADMIN_USERS re-parse — isAdmin() already excludes '_local'
      quotas: quotaLimits,
      geminiAllowlisted,
    };
    json(res, profile);
  });

  post('/api/analytics/event', (_req, res, body) => {
    const raw = (body as { events?: unknown[] }).events;
    if (!Array.isArray(raw)) { json(res, { error: 'events array required' }, 400); return; }
    // Sanitize: only keep events that have the required string fields
    const events: analytics.AnalyticsEvent[] = [];
    for (const e of raw) {
      if (typeof e !== 'object' || e === null) continue;
      const o = e as Record<string, unknown>;
      if (typeof o.user !== 'string' || typeof o.session_id !== 'string' ||
          typeof o.timestamp !== 'string' || typeof o.event_type !== 'string' ||
          typeof o.category !== 'string') continue;
      events.push({
        user: o.user.slice(0, 200),
        session_id: o.session_id.slice(0, 100),
        timestamp: o.timestamp.slice(0, 30),
        event_type: o.event_type.slice(0, 100),
        category: o.category.slice(0, 50),
        detail: (typeof o.detail === 'object' && o.detail !== null ? o.detail : {}) as Record<string, unknown>,
        duration_ms: typeof o.duration_ms === 'number' ? o.duration_ms : undefined,
      });
    }
    analytics.appendEvents(events).catch((e) => {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'analytics', level: 'error',
        message: 'Analytics append failed',
        error: { name: (e as Error).name ?? 'Error', message: String(e), stack: (e as Error).stack },
      });
    });
    json(res, { ok: true, count: events.length });
  });

  // t/1128: receives the login page's service-worker state beacon (stuck-SW
  // diagnosis, t/1126). Public — the login page is pre-auth. Best-effort: log the
  // reported SW registrations/controller (captured in server-log dumps), then 204
  // (sendBeacon ignores the response body).
  post('/api/diagnostics/sw-state', (req, res, body) => {
    try {
      const info = (body && typeof body === 'object') ? body as Record<string, unknown> : { raw: String(body).slice(0, 500) };
      log.server.info(
        { component: 'sw-diagnostics', sw: info, ip: getClientIp(req), ua: (req.headers['user-agent'] || '').slice(0, 200) },
        'Login-page service-worker state beacon (t/1128)',
      );
    } catch { /* telemetry — silent by design: never fail a diagnostics beacon */ }
    res.writeHead(204);
    res.end();
  });

  get('/api/analytics/query', async (req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    const from = url.searchParams.get('from') || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const to = url.searchParams.get('to') || new Date().toISOString().slice(0, 10);
    const user = url.searchParams.get('user') || undefined;
    const sessionId = url.searchParams.get('session_id') || undefined;

    if (user || sessionId) {
      // t/850: raw per-user/session events expose other users' telemetry — admin only.
      if (!requireAdmin(res)) return;
      json(res, { events: await analytics.queryRawEvents(from, to, user, sessionId) });
    } else {
      json(res, await analytics.queryAggregated(from, to));
    }
  });

  // t/2467: engagement tree (view.dwell roll-up — tool→camp→category→node).
  // Aggregate + daily open to any authenticated caller.
  // t/2559 (spec §7) — three admin-only extensions over the same single pass:
  //   ?session=<id>              → aggregate/daily recomputed for one session (§7.1)
  //   sessions[] (admin)         → per-session rollup for the session picker (§7.2)
  //   ?subject=<id>&groupBy=…     → WHO breakdown rows, optional &user= scope (§7.3)
  // The per-user subtree, users table, sessions list, and the session/subject
  // extensions are all admin-gated (TL p/333#89). `session`/`subject` are validated
  // with the shared safe-ID validator (t/2526) at the boundary. `user` is an in-memory
  // equality filter only (never a path) and can legitimately carry email-derived chars
  // (e.g. `+` from deriveStorageUserId), so it is deliberately NOT safe-ID-constrained.
  get('/api/analytics/engagement', async (req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    const from = url.searchParams.get('from') || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const to = url.searchParams.get('to') || new Date().toISOString().slice(0, 10);
    const user = url.searchParams.get('user') || undefined;
    const session = url.searchParams.get('session') || undefined;
    const subject = url.searchParams.get('subject') || undefined;
    const groupBy = url.searchParams.get('groupBy') || undefined;

    // t/2526 safe-ID validation at the boundary, before any query.
    if (session !== undefined && !isSafeId(session)) { error(res, 'Invalid session id', 400); return; }
    if (subject !== undefined && !isSafeId(subject)) { error(res, 'Invalid subject id', 400); return; }

    const currentUserId = deriveRequestUserId(req);
    if (subject !== undefined) { await serveSubjectBreakdown(res, from, to, subject, groupBy, user); return; }
    await serveEngagementTree(res, from, to, user, session, currentUserId, isAdmin(currentUserId));
  });

  // ── Focus node (inter-app communication) ──

  post('/focus-node', (_req, res, body) => {
    const { nodeId } = body as { nodeId: string };
    // Broadcast to connected WebSocket clients
    broadcastEvent('focus-node', { nodeId });
    json(res, { ok: true });
  });

  // ── Trace channel (observability) ──
  //
  // Accepts batched trace events from the renderer and emits each as a single
  // line of JSON on stdout. In the Azure Container Apps deployment, stdout is
  // ingested by Log Analytics via appLogsConfiguration (see deploy/azure/main.bicep)
  // which makes the events queryable with KQL:
  //
  //   ContainerAppConsoleLogs_CL
  //   | where Log_s startswith "[trace]"
  //   | extend ev = parse_json(substring(Log_s, 8))
  //   | where ev.debate_id == "<debate-id>"
  //
  // See docs/debate-observability-proposal.md for the full rationale.
  //
  // Events are intentionally not validated beyond basic shape — the renderer
  // owns the schema and we want to preserve unexpected fields for future use.
  // The per-batch cap prevents accidental payload bombs.

  post('/debug/events', (_req, res, body) => {
    try {
      const { events } = (body || {}) as { events?: unknown };
      if (!Array.isArray(events)) {
        error(res, 'events must be an array', 400);
        return;
      }
      const accepted = events.slice(0, TRACE_MAX_EVENTS_PER_BATCH);
      for (const ev of accepted) {
        // Single-line JSON so the log ingestion splits on newlines cleanly.
        log.trace.debug({ event: ev }, 'Client trace event');
      }
      json(res, { received: accepted.length, dropped: Math.max(0, events.length - accepted.length) });
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'server',
        level: 'error',
        message: 'Operation failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, String(err), (err as { statusCode?: number }).statusCode ?? 500);
    }
  });
}
