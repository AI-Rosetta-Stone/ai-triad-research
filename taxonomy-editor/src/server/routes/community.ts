// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/1347 (route extraction, t/1295 follow-up): the /api/community route cluster,
// moved verbatim out of server.ts behind the registration seam. Handlers are
// byte-identical except the submit pre-check, which now reads the live GitHub
// backend through ctx.getGithubBackend() instead of the server.ts module-local
// `githubBackend` (same live value). The server-local respondRateLimited() helper
// (only callers were these two submit paths) moves in with the cluster as a
// closure over ctx. No new collision pairs — community route literals are all
// distinct (see routeTable.test.ts).

import type { Router } from '../httpKit.js';
import type { ServerCtx } from './context.js';
import { json, error, param } from '../httpKit.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { log } from '../logger.js';
import { getUserContentBackend } from '../storage/fileIO.js';
import { rateLimitResponseBody } from '../security/rateLimitResponse.js';
import * as rateLimiter from '../security/rateLimiter.js';
import { getStorageUserId, isAnonymousUser, getStableId } from '../security/userContext.js';
import * as community from '../community/community.js';
import { revokeCommunityOpedShare, getCommunityOpedShareEntry } from '../community/communityOpedShares.js';
import { deletePublicCommunityOpEd } from '../storage/communityOpedShareStore.js';

// Bounds the admin-supplied reason persisted into the rename audit record.
const RENAME_REASON_MAX = 1000;

function isCommunityType(type: string): type is community.CommunityType {
  return type === 'chats' || type === 'debates' || type === 'opeds' || type === 'inquiries';
}

/** Validates the admin rename body. Returns the fields, or a 400 message. */
function parseRenameBody(body: unknown): { title: string; reason?: string } | { invalid: string } {
  const { title, reason } = (body ?? {}) as { title?: unknown; reason?: unknown };
  const trimmedLength = typeof title === 'string' ? title.trim().length : 0;
  if (typeof title !== 'string' || trimmedLength === 0 || trimmedLength > 200) {
    return { invalid: 'title must be a string of 1-200 characters after trimming' };
  }
  if (reason !== undefined && (typeof reason !== 'string' || reason.length > RENAME_REASON_MAX)) {
    return { invalid: `reason must be a string of at most ${RENAME_REASON_MAX} characters` };
  }
  return { title, reason };
}

/**
 * t/172: an op-ed member's `stages` (every model call's raw prompt and output, t/171) is owner-only
 * observability. Community items are readable by every signed-in user, and sanitizeForCommunity's
 * key denylist doesn't cover it, so it's dropped here at the single submission ingress.
 */
export function withoutOpEdStages(type: string, data: unknown): unknown {
  if (type !== 'oped' || !data || typeof data !== 'object') return data;
  const set = data as { opeds?: unknown };
  if (!Array.isArray(set.opeds)) return data;
  let stripped = 0;
  const opeds = set.opeds.map((m: unknown) => {
    if (!m || typeof m !== 'object' || !('stages' in m)) return m;
    stripped++;
    const { stages: _stages, ...rest } = m as Record<string, unknown>;
    return rest;
  });
  if (stripped > 0) log.server.info({ component: 'community', stripped }, 'Dropped op-ed stages from a community submission (owner-only, t/172)');
  return { ...set, opeds };
}

export function registerCommunityRoutes(r: Router, ctx: ServerCtx): void {
  const { get, post, del, patch } = r;
  const { getGithubBackend } = ctx;

  // Structured 429 for GitHub-API rate-limit exhaustion (t/685). Surfaces seconds
  // until the limit resets via a `retryAfter` field and a Retry-After header, so
  // clients can back off instead of seeing an opaque 500.
  function respondRateLimited(res: import('http').ServerResponse): void {
    const gh = getGithubBackend();
    const resetsAt = gh ? new Date(gh.getRateLimitResetsAt()).getTime() : 0;
    const bodyResp = rateLimitResponseBody(resetsAt, Date.now());
    res.setHeader('Retry-After', String(bodyResp.retryAfter));
    json(res, bodyResp, 429);
  }

  // Admin hard-delete of a published community item, with an audit trail (t/748).
  // Renderer sends DELETE with an optional JSON body { reason }.
  del('/api/community/:type/:id', async (req, res, body) => {
    if (!community.isAdmin()) { json(res, { error: 'Forbidden' }, 403); return; }
    try {
      const type = param(req, 'type', '/api/community/:type/:id');
      if (type !== 'chats' && type !== 'debates' && type !== 'opeds' && type !== 'inquiries') { error(res, 'type must be "chats", "debates", "opeds", or "inquiries"', 400); return; }
      const id = param(req, 'id', '/api/community/:type/:id');
      const reason = (body as { reason?: string } | undefined)?.reason;
      await community.removeCommunityItem(type as 'chats' | 'debates' | 'opeds' | 'inquiries', id, typeof reason === 'string' ? reason : undefined);
      json(res, { ok: true });
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'server',
        level: 'error',
        message: 'Failed to remove community item',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, (err as Error).message ?? String(err), (err as { statusCode?: number }).statusCode ?? 500, err);
    }
  });

  // t/4897 (t/4885-C): admin rename of a published community item. renameCommunityItem
  // writes the audit record before mutating the file; `by` is the admin's stableId — the
  // same value isAdmin() just matched — never a display name or a client-supplied field.
  // Anonymous callers are normally stopped earlier by server.ts's auth gate (401 with no
  // session, 403 anon_route_blocked with an anonymous session); the 401 here is a backstop.
  patch('/api/community/:type/:id', async (req, res, body) => {
    if (isAnonymousUser()) { error(res, 'Sign in required', 401); return; }
    if (!community.isAdmin()) { json(res, { error: 'Forbidden' }, 403); return; }
    try {
      const type = param(req, 'type', '/api/community/:type/:id');
      if (!isCommunityType(type)) { error(res, 'type must be "chats", "debates", "opeds", or "inquiries"', 400); return; }
      const id = param(req, 'id', '/api/community/:type/:id');
      const parsed = parseRenameBody(body);
      if ('invalid' in parsed) { error(res, parsed.invalid, 400); return; }
      const by = getStableId();
      if (!by) { error(res, 'Admin identity unavailable', 403); return; }
      await community.renameCommunityItem(type, id, parsed.title, { by, reason: parsed.reason });
      json(res, { ok: true });
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'server',
        level: 'error',
        message: 'Failed to rename community item',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, (err as Error).message ?? String(err), (err as { statusCode?: number }).statusCode ?? 500, err);
    }
  });

  get('/api/community/chats', async (_req, res) => {
    try { json(res, await community.listCommunityChats()); }
    catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'server',
        level: 'error',
        message: 'Failed to list community chats',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, String(err), (err as { statusCode?: number }).statusCode ?? 500);
    }
  });

  get('/api/community/chats/:id', async (req, res) => {
    try {
      const id = param(req, 'id', '/api/community/chats/:id');
      const item = await community.loadCommunityItem('chats', id);
      if (!item) { json(res, { found: false }, 200); return; }
      json(res, item);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'server',
        level: 'error',
        message: 'Failed to load community chat item',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, String(err), 404);
    }
  });

  get('/api/community/debates', async (_req, res) => {
    try {
      const entries = await community.listCommunityDebates() as Record<string, unknown>[];
      json(res, entries.map(e => ({ ...e, source: 'community' })));
    }
    catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'server',
        level: 'error',
        message: 'Failed to list community debates',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, String(err), (err as { statusCode?: number }).statusCode ?? 500);
    }
  });

  get('/api/community/debates/:id', async (req, res) => {
    try {
      const id = param(req, 'id', '/api/community/debates/:id');
      const item = await community.loadCommunityItem('debates', id);
      if (!item) { json(res, { found: false }, 200); return; }
      json(res, item);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'server',
        level: 'error',
        message: 'Failed to load community debate item',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, String(err), 404);
    }
  });

  // t/2573: community op-ed reader surface (the module funcs landed with t/2574).
  // Mirrors the debates listing/detail handlers verbatim; `source: 'community'`
  // tags rows the same way the debate listing does.
  get('/api/community/opeds', async (_req, res) => {
    try {
      const entries = await community.listCommunityOpEds() as Record<string, unknown>[];
      json(res, entries.map(e => ({ ...e, source: 'community' })));
    }
    catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'server',
        level: 'error',
        message: 'Failed to list community opeds',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, String(err), (err as { statusCode?: number }).statusCode ?? 500);
    }
  });

  get('/api/community/opeds/:id', async (req, res) => {
    try {
      const id = param(req, 'id', '/api/community/opeds/:id');
      const item = await community.loadCommunityItem('opeds', id);
      if (!item) { json(res, { found: false }, 200); return; }
      json(res, item);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'server',
        level: 'error',
        message: 'Failed to load community oped item',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, String(err), 404);
    }
  });

  // t/3621: community inquiry reader surface (the module funcs landed with t/3621).
  // Mirrors the opeds listing/detail handlers verbatim; `source: 'community'`
  // tags rows the same way the oped/debate listings do.
  get('/api/community/inquiries', async (_req, res) => {
    try {
      const entries = await community.listCommunityInquiries() as Record<string, unknown>[];
      json(res, entries.map(e => ({ ...e, source: 'community' })));
    }
    catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'server',
        level: 'error',
        message: 'Failed to list community inquiries',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, String(err), (err as { statusCode?: number }).statusCode ?? 500);
    }
  });

  get('/api/community/inquiries/:id', async (req, res) => {
    try {
      const id = param(req, 'id', '/api/community/inquiries/:id');
      const item = await community.loadCommunityItem('inquiries', id);
      if (!item) { json(res, { found: false }, 200); return; }
      json(res, item);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'server',
        level: 'error',
        message: 'Failed to load community inquiry item',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, String(err), 404);
    }
  });

  // ── t/3315: public no-login share link for a COMMUNITY op-ed (Pattern-A publish-on-share). ──
  // Any authed user may mint (rate-limited); a community-scoped registry returns ONE stable shareId
  // per item to all callers. The public copy is the anonymous positive-allowlist projection served by
  // the existing GET /api/public/oped/:shareId + PublicOpEdView — zero new public surface. Consent:
  // PI ruled community = public (t/3315#7). TL GV conditions in t/3315#9.
  post('/api/community/opeds/:id/share', async (req, res) => {
    try {
      const id = param(req, 'id', '/api/community/opeds/:id/share');

      // Condition 3: mint = any authed user, RATE-LIMITED (per-user bucket; idempotent so repeats are cheap).
      const userId = getStorageUserId();
      const rate = rateLimiter.checkRate(`community-oped-share:${userId}`, 20, 60_000);
      if (!rate.allowed) {
        const retryAfter = Math.ceil((rate.retryAfterMs ?? 60_000) / 1000);
        res.setHeader('Retry-After', String(retryAfter));
        json(res, { error: 'rate_limited', retryAfter }, 429);
        return;
      }

      // t/3484: source submittedBy (the item's ORIGINAL submitter — tracked server-side ONLY for the
      // revoke-auth check; the PUBLIC copy stays anonymous, community_metadata stripped). This pre-read
      // is ONLY for submittedBy — the same pattern backfillCommunityOpedShares uses (it sources it from
      // the listing summary). mintAndProjectCommunityOpEd below re-validates + is the SINGLE mint+project
      // path (t/3483#2 — no dual mint paths; the manual mint+project that used to live here is gone).
      const pre = await community.getCommunityOpEd(id);
      const submittedBy = pre.found
        ? ((pre.item as { community_metadata?: { submitted_by_display?: string } }).community_metadata?.submitted_by_display ?? '')
        : '';

      const result = await community.mintAndProjectCommunityOpEd(id, submittedBy);
      if (result.outcome === 'skipped') {
        // Preserve the t/3334/t/3430 discrimination via the helper's `reason`:
        if (result.reason === 'malformed') {
          // found item but missing topic (opeds non-empty) = unambiguous corruption → always WARN→Log_s → 422.
          log.server.warn(
            { id, backend: getUserContentBackend().constructor.name, reason: 'malformed' },
            'Community op-ed share mint: item malformed (missing topic / empty opeds) — refusing to mint (corruption)',
          );
          error(res, 'Community op-ed is empty or malformed — cannot mint a public copy', 422);
          return;
        }
        if (result.reason === 'empty') {
          // ADR-001 silent-empty (blob present, zero voices) — GitHub-API silent-empty / corruption → WARN + 404.
          log.server.warn(
            { id, backend: getUserContentBackend().constructor.name, path: 'mint', reason: 'empty' },
            'Community op-ed share mint: getCommunityOpEd SILENT-EMPTY (blob present, zero voices) — possible corruption; refusing to mint',
          );
        }
        // 'absent' = wrong/missing id — ordinary, expected, never corruption → routine 404, NO operator WARN.
        error(res, 'not_found', 404);
        return;
      }

      // minted | already-shared → the stable community-scoped public shareId.
      json(res, { shareId: result.shareId, url: `/share/oped/${result.shareId}` });
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'server', level: 'error',
        message: 'Failed to mint community op-ed public share',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, String(err), (err as { statusCode?: number }).statusCode ?? 500);
    }
  });

  // Revoke a community op-ed's public link. Condition 3: admin (REQUIRED) OR the original submitter
  // (optional). Deletes the registry entry + the public projection → a leaked link is permanently
  // dead; re-share mints a fresh shareId. Idempotent: revoking an unshared item is a no-op 200.
  del('/api/community/opeds/:id/share', async (req, res) => {
    try {
      const id = param(req, 'id', '/api/community/opeds/:id/share');
      const entry = await getCommunityOpedShareEntry(id);
      const isSubmitter = !!entry && entry.submittedBy !== '' && getStorageUserId() === entry.submittedBy;
      if (!community.isAdmin() && !isSubmitter) { json(res, { error: 'Forbidden' }, 403); return; }

      const removed = await revokeCommunityOpedShare(id);
      if (!removed) { json(res, { revoked: false }); return; } // not shared — idempotent no-op
      await deletePublicCommunityOpEd(removed.shareId);
      json(res, { revoked: true });
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'server', level: 'error',
        message: 'Failed to revoke community op-ed public share',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, String(err), (err as { statusCode?: number }).statusCode ?? 500);
    }
  });

  post('/api/community/submit', async (_req, res, body) => {
    try {
      const { type, data, note } = body as { type: 'chat' | 'debate' | 'oped' | 'inquiry'; data: unknown; note?: string };
      if (!type || !data) { json(res, { error: 'type and data required' }, 400); return; }

      // Pre-flight: a community submission must reach GitHub (it's shared data on
      // main). If the API is exhausted, fail fast with a structured 429 instead of
      // attempting a write that 403s mid-flight and surfaces as a 500 — and never
      // leaves a half-written/uncommittable submission behind (t/685).
      const gh = getGithubBackend();
      if (gh && gh.getRateLimitRemaining() <= 0) {
        respondRateLimited(res);
        return;
      }

      // M6: per-user submission rate limit (5/hour) — throttles burst abuse of the
      // shared community queue (distinct from the 20-pending cap in community.ts).
      const submitRate = rateLimiter.checkRate(`community-submit:${getStorageUserId()}`, 5, 3_600_000);
      if (!submitRate.allowed) {
        const retryAfter = Math.max(1, Math.ceil((submitRate.retryAfterMs ?? 3_600_000) / 1000));
        res.setHeader('Retry-After', String(retryAfter));
        json(res, { error: 'rate_limited', message: 'Too many community submissions; please try again later.', retryAfter }, 429);
        return;
      }

      json(res, await community.submitToCommunity(type, withoutOpEdStages(type, data), note));
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'server',
        level: 'error',
        message: 'Community submission failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      // Map a rate-limit failure that slipped past the pre-check to 429, not 500.
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 429 || status === 403 || /rate.?limit/i.test(String(err))) {
        respondRateLimited(res);
        return;
      }
      json(res, { error: String(err) }, status ?? 500);
    }
  });

  post('/api/community/copy', async (_req, res, body) => {
    try {
      const { type, communityId } = body as { type: 'chats' | 'debates' | 'opeds' | 'inquiries'; communityId: string };
      if (!type || !communityId) { json(res, { error: 'type and communityId required' }, 400); return; }
      json(res, await community.copyFromCommunity(type, communityId));
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'server',
        level: 'error',
        message: 'Failed to copy from community',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      json(res, { error: String(err) }, status);
    }
  });
}
