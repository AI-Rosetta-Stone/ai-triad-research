// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/574 / t/590 (design t/574#3, TL t/574#5): anonymous GETs are DENY BY DEFAULT.
 *
 * Every GET route the server registers is classified here, except the auth-exempt public paths (publicPaths.ts),
 * which never reach the anonymous gate. A drift test (anonGetAllowlistDrift.test.ts) fails when a GET route is
 * added without a classification, when a classification names a route that no longer exists, or when this
 * matcher would decide a path differently from the route the router actually serves.
 *
 *   shared       public taxonomy and corpus data, the same for every caller
 *   per-visitor  the caller's own data, keyed on getStorageUserId() (anon-<uuid>), never _local (t/500, t/574 §3)
 *   status       small status the SPA needs for an anonymous visitor (flags, tier, availability)
 *   deny         not for anonymous callers: admin, owner-keyed, server internals, sign-in-only features
 *
 * ROLLOUT (TL t/574#5): REPORT-ONLY by default. A GET that would be denied is logged (route PATTERN only, never the
 * URL) and counted, and is still allowed. Enforcement is ANON_GET_ALLOWLIST_ENFORCE=1, set per environment after
 * 48 h of prod with zero would-deny hits from the SPA's own calls.
 *
 * Changing a 'shared', 'per-visitor' or 'status' entry, or a handler it names, needs a Security review (t/574#5).
 */

import { log } from '../logger.js';

export type AnonGetClass = 'shared' | 'per-visitor' | 'status' | 'deny';

export interface AnonGetEntry {
  readonly class: AnonGetClass;
  readonly why: string;
}

/** Every non-public GET route, by its router pattern. Keep in route-table order of feature, not alphabetical. */
export const ANON_GET_ROUTES: Readonly<Record<string, AnonGetEntry>> = {
  // ── shared: taxonomy and corpus ──
  '/api/taxonomy/:pov': { class: 'shared', why: 'core taxonomy (t/574#3 §1)' },
  '/api/taxonomy/synthetic/:pov': { class: 'shared', why: 'synthetic phrases panel' },
  '/api/edges': { class: 'shared', why: 'taxonomy edges' },
  '/api/edges/:index': { class: 'shared', why: 'edge detail' },
  '/api/conflicts': { class: 'shared', why: 'taxonomy conflicts' },
  '/api/conflicts/clusters': { class: 'shared', why: 'conflict clusters' },
  '/api/cruxes': { class: 'shared', why: 'cruxes tab' },
  '/api/container-mentions/:containerId': { class: 'shared', why: 'mention field' },
  '/api/dictionary': { class: 'shared', why: 'vocabulary panel' },
  '/api/doc-titles': { class: 'shared', why: 'corpus titles' },
  '/api/entities': { class: 'shared', why: 'entity browser' },
  '/api/entity/:ref': { class: 'shared', why: 'entity detail' },
  '/api/greatest-hits': { class: 'shared', why: 'debate seeding node list' },
  '/api/lineage-categories': { class: 'shared', why: 'lineage panel' },
  '/api/lineage-info': { class: 'shared', why: 'lineage lookup' },
  '/api/node-source-index/:nodeId': { class: 'shared', why: 'per-node sources panel' },
  '/api/organizations': { class: 'shared', why: 'organization registry' },
  '/api/organizations/:id': { class: 'shared', why: 'organization detail' },
  '/api/organizations/:id/edges': { class: 'shared', why: 'organization edges' },
  '/api/organizations/by-policy/:policyId': { class: 'shared', why: 'organizations by policy' },
  '/api/organizations/by-pov/:pov': { class: 'shared', why: 'organizations by POV' },
  '/api/organizations/by-topic/:topicRef': { class: 'shared', why: 'organizations by topic' },
  '/api/policy-registry': { class: 'shared', why: 'policy registry' },
  '/api/policy-source-index': { class: 'shared', why: 'policy sources panel' },
  // TL t/574#5: whether anonymous visitors may read a source's full text or file is a PI decision (open; report-only
  // keeps today's behaviour until it is made).
  '/api/snapshots/:sourceId': { class: 'shared', why: 'source snapshot text (PI decision pending, t/574#5)' },
  '/api/source-documents/:docId': { class: 'shared', why: 'source metadata' },
  '/api/source-documents/:docId/file': { class: 'shared', why: 'source file (PI decision pending, t/574#5)' },
  '/api/source-evidence-index': { class: 'shared', why: 'evidence index' },
  '/api/sources': { class: 'shared', why: 'source list' },
  '/api/summaries/:docId': { class: 'shared', why: 'summaries tab' },
  '/api/ps-prompts/:name': { class: 'shared', why: 'prompt inspector (static prompt text, public repo)' },
  '/api/community/chats': { class: 'shared', why: 'published community content' },
  '/api/community/chats/:id': { class: 'shared', why: 'published community content' },
  '/api/community/debates': { class: 'shared', why: 'published community content' },
  '/api/community/debates/:id': { class: 'shared', why: 'published community content' },
  '/api/community/opeds': { class: 'shared', why: 'published community content' },
  '/api/community/opeds/:id': { class: 'shared', why: 'published community content' },
  '/api/community/inquiries': { class: 'shared', why: 'published community content' },
  '/api/community/inquiries/:id': { class: 'shared', why: 'published community content' },

  // ── per-visitor: the caller's own data (anon-<uuid> only; t/500 refuses _local before the handler) ──
  '/api/chats': { class: 'per-visitor', why: 'own chats' },
  '/api/chats/:id': { class: 'per-visitor', why: 'own chat' },
  '/api/debates': { class: 'per-visitor', why: 'own debates' },
  '/api/debates/list': { class: 'per-visitor', why: 'own debate index' },
  '/api/debates/quota-status': { class: 'per-visitor', why: 'own debate count' },
  '/api/debates/:id': { class: 'per-visitor', why: 'own debate' },
  '/api/debates/:id/comments': { class: 'per-visitor', why: 'own comments' },
  '/api/oped-sets': { class: 'per-visitor', why: 'own op-ed sets (t/500)' },
  '/api/oped-sets/quota-status': { class: 'per-visitor', why: 'own live-set count (t/500 opedQuotaStatus)' },
  '/api/oped-sets/:id': { class: 'per-visitor', why: 'own op-ed set' },
  '/api/oped-runs/:runId': { class: 'per-visitor', why: 'own op-ed run status (run.userId must match)' },
  '/api/preferences': { class: 'per-visitor', why: 'own preferences' },
  '/api/flight-recorder/download-merged/:dumpId': { class: 'per-visitor', why: 'own client dump (dumpId capability; no server half for anonymous)' },

  // ── status the SPA needs for an anonymous visitor ──
  '/api/flags': { class: 'status', why: 'resolved feature flags at boot' },
  '/api/backends/available': { class: 'status', why: 'model picker availability (anon-safe since t/516)' },
  '/api/proxy/tier': { class: 'status', why: 'tier display (useTierInfo)' },
  '/api/proxy/usage': { class: 'status', why: 'tier usage display (useTierInfo)' },
  '/api/sync/status': { class: 'status', why: 'fixed anonymous body (t/548)' },

  // ── deny: admin ──
  '/api/admin/allowlist': { class: 'deny', why: 'admin' },
  '/api/admin/calibration/pending': { class: 'deny', why: 'admin' },
  '/api/admin/config': { class: 'deny', why: 'admin' },
  '/api/admin/config/diff': { class: 'deny', why: 'admin' },
  '/api/admin/errors': { class: 'deny', why: 'admin' },
  '/api/admin/errors/:id': { class: 'deny', why: 'admin' },
  '/api/admin/errors/summary': { class: 'deny', why: 'admin' },
  '/api/admin/feedback': { class: 'deny', why: 'admin' },
  '/api/admin/flags': { class: 'deny', why: 'admin' },
  '/api/admin/health': { class: 'deny', why: 'admin (t/579)' },
  '/api/admin/paid-fallback-key': { class: 'deny', why: 'admin' },
  '/api/admin/review/detail/:groupId': { class: 'deny', why: 'admin' },
  '/api/admin/review/queue': { class: 'deny', why: 'admin' },
  '/api/admin/review/stats': { class: 'deny', why: 'admin' },
  '/api/admin/rollback/status': { class: 'deny', why: 'admin' },
  '/api/admin/submissions': { class: 'deny', why: 'admin' },
  '/api/admin/support/cases': { class: 'deny', why: 'admin' },
  '/api/admin/telemetry/summary': { class: 'deny', why: 'admin' },
  '/api/admin/usages': { class: 'deny', why: 'admin' },
  '/api/data/root': { class: 'deny', why: 'admin internals (data-root path)' },
  '/api/sync/diagnostics': { class: 'deny', why: 'admin internals' },
  '/api/diag/forwarded-headers': { class: 'deny', why: 'staging diagnostics' },

  // ── deny: site-wide analytics, diagnostics and server internals ──
  '/api/analytics/engagement': { class: 'deny', why: 'cross-user telemetry (t/579)' },
  '/api/analytics/query': { class: 'deny', why: 'site-wide analytics (t/579)' },
  '/api/analytics/internal': { class: 'deny', why: 'tester cookie toggle; testers sign in' },
  '/api/calibration/history': { class: 'deny', why: 'server diagnostics (t/579)' },
  '/api/calibration/log': { class: 'deny', why: 'cross-user diagnostics (t/579)' },
  '/api/flight-recorder/list': { class: 'deny', why: 'server dumps (t/579)' },
  '/api/flight-recorder/download/:filename': { class: 'deny', why: 'server dumps (t/579)' },
  '/api/flight-recorder/view/:filename': { class: 'deny', why: 'server dumps (t/579)' },
  '/api/taxonomy/synthetic-embeddings': { class: 'deny', why: 'corpus export, auth-only (t/3259)' },
  '/api/taxonomy/:pov/node/:nodeId/history': { class: 'deny', why: 'editor identities in edit history' },
  '/api/node-source-index': { class: 'deny', why: 'deprecated whole-corpus index, no caller' },
  '/api/taxonomy-dir/active': { class: 'deny', why: 'process-global dir, no caller' },
  '/api/taxonomy-dirs': { class: 'deny', why: 'no caller' },
  '/api/ps-prompts': { class: 'deny', why: 'no caller' },

  // ── deny: owner-keyed (getCurrentUserId is the owner's _local for an anonymous caller) ──
  '/api/sync/diff': { class: 'deny', why: 'owner session branch' },
  '/api/sync/node-conflicts': { class: 'deny', why: 'owner session branch' },
  '/api/sync/node-diff': { class: 'deny', why: 'owner session branch' },
  '/api/sync/unsynced': { class: 'deny', why: 'owner session branch' },
  '/api/sync/rebase-file': { class: 'deny', why: 'editor-only stub' },
  '/api/sync/rebase-state': { class: 'deny', why: 'editor-only stub' },
  '/api/keys/has': { class: 'deny', why: 'BYOK keys are sign-in only (t/501)' },
  '/api/keys/:backend': { class: 'deny', why: 'BYOK keys are sign-in only (t/501)' },

  // ── deny: sign-in-only features ──
  '/api/brief-exports/quota-status': { class: 'deny', why: 'export is sign-in only' },
  '/api/debates/:debateId/exports': { class: 'deny', why: 'export is sign-in only' },
  '/api/export-jobs/:jobId': { class: 'deny', why: 'export is sign-in only' },
  '/api/exports/:exportId/artifacts/:name': { class: 'deny', why: 'export is sign-in only' },
  '/api/templates': { class: 'deny', why: 'export is sign-in only' },
  '/api/inquiry': { class: 'deny', why: 'handler 401s anonymous' },
  '/api/inquiry/:jobId': { class: 'deny', why: 'handler 401s anonymous' },
  '/api/support/cases': { class: 'deny', why: 'handler 401s anonymous' },
  '/api/support/cases/:id': { class: 'deny', why: 'handler 401s anonymous' },
  '/api/support/cases/:id/attachments/:aid': { class: 'deny', why: 'handler 401s anonymous' },
  '/api/pov-tag-proposals': { class: 'deny', why: 'curation review tooling' },
  '/api/proposals': { class: 'deny', why: 'editor review tooling' },
  '/api/proposals/:filename': { class: 'deny', why: 'editor review tooling' },
};

/** Same rule as server.ts matchRoute: same segment count, ':param' matches any one segment, literals exact. */
export function routePatternMatches(pattern: string, pathname: string): boolean {
  const pp = pattern.split('/');
  const up = pathname.split('/');
  if (pp.length !== up.length) return false;
  for (let i = 0; i < pp.length; i++) {
    if (pp[i].startsWith(':')) continue;
    if (pp[i] !== up[i]) return false;
  }
  return true;
}

const paramCount = (p: string) => p.split('/').filter((s) => s.startsWith(':')).length;
/** Most specific first (fewest params), so a literal 'deny' route beats a ':param' 'shared' one of the same shape. */
const ORDERED = Object.entries(ANON_GET_ROUTES).sort((a, b) => paramCount(a[0]) - paramCount(b[0]));

/** The classification for a normalized /api/ pathname: the matching route pattern, or null when nothing matches. */
export function classifyAnonGet(pathname: string): { pattern: string; entry: AnonGetEntry } | null {
  for (const [pattern, entry] of ORDERED) if (routePatternMatches(pattern, pathname)) return { pattern, entry };
  return null;
}

/** Whether a GET is on the anonymous allowlist. Non-/api paths (SPA shell, static files) are not gated here. */
export function isAnonGetAllowlisted(pathname: string): { allowed: boolean; pattern: string } {
  if (!pathname.startsWith('/api/')) return { allowed: true, pattern: '<non-api>' };
  const c = classifyAnonGet(pathname);
  if (!c) return { allowed: false, pattern: '<unrouted>' };
  return { allowed: c.entry.class !== 'deny', pattern: c.pattern };
}

/** Enforcement is opt-in per environment (TL t/574#5): until then, report only. */
export function anonGetAllowlistEnforced(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ANON_GET_ALLOWLIST_ENFORCE === '1';
}

const wouldDeny = new Map<string, number>();

/**
 * Records a GET that the allowlist denies. Logs the route PATTERN, never the URL (ids and query strings stay out of
 * logs), at the 1st, 10th, 100th... hit per pattern. The gate can evaluate a request twice (both auth gates call
 * isAnonAllowedRoute), so counts are an upper bound; the enforcement exit criterion is zero vs non-zero.
 */
export function recordAnonGetDenied(pattern: string, enforced: boolean): void {
  const n = (wouldDeny.get(pattern) ?? 0) + 1;
  wouldDeny.set(pattern, n);
  if (Number.isInteger(Math.log10(n))) {
    log.security.warn({ component: 'anon-get-allowlist', pattern, count: n, enforced },
      enforced ? 'Anonymous GET denied by the allowlist (t/574)' : 'Anonymous GET WOULD be denied by the allowlist (report-only, t/574)');
  }
}

/** The would-deny counts since boot, by route pattern (for admin diagnostics and the rollout's exit criterion). */
export function anonGetDeniedCounts(): Record<string, number> {
  return Object.fromEntries(wouldDeny);
}

/** Test seam. */
export function resetAnonGetDeniedCounts(): void {
  wouldDeny.clear();
}
