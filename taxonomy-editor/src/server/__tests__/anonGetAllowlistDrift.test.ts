// @vitest-environment node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/590 / t/574: the anonymous-GET drift test. Fails when:
 *   - a GET route is registered that is neither a public path nor classified in ANON_GET_ROUTES (a new data route
 *     can't become anonymous-readable by default, the t/579 class);
 *   - ANON_GET_ROUTES names a route that no longer exists (a stale entry could later match a new route);
 *   - the allowlist matcher would decide a path differently from the route the ROUTER serves for it (first-match in
 *     registration order), so a literal 'deny' route can't be shadowed by a ':param' allow, or the reverse.
 * Plus the gate itself: report-only by default, enforced with ANON_GET_ALLOWLIST_ENFORCE=1.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { extractRoutes } from './extractRoutes.js';
import { computeIsPublicPath } from '../publicPaths.js';
import {
  ANON_GET_ROUTES, routePatternMatches, isAnonGetAllowlisted, anonGetDeniedCounts, resetAnonGetDeniedCounts,
} from '../security/anonGetAllowlist.js';
import { isAnonAllowedRoute } from '../security/accessControl.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const routes = extractRoutes(path.join(here, '..', 'server.ts'));
const getRoutes = routes.filter((r) => r.method === 'GET').map((r) => r.path);

/** A concrete request path for a route pattern (each ':param' becomes a plausible value). */
const sample = (pattern: string) => pattern.replace(/:[A-Za-z]+/g, 'x1');
/** The route the router serves for a path: first registered GET pattern that matches (server.ts matchRoute). */
const routerChoice = (p: string) => getRoutes.find((r) => routePatternMatches(r, p));

describe('t/590: every GET route is classified for anonymous callers', () => {
  it('the route table was read', () => {
    expect(getRoutes.length).toBeGreaterThan(100);
  });

  it('no GET route is unclassified (public path, or an entry in ANON_GET_ROUTES)', () => {
    const unclassified = getRoutes.filter((r) => !computeIsPublicPath(sample(r)) && r.startsWith('/api/') && !(r in ANON_GET_ROUTES));
    expect(unclassified, 'classify each new GET route in security/anonGetAllowlist.ts (Security review)').toEqual([]);
  });

  it('ANON_GET_ROUTES has no stale entries', () => {
    const stale = Object.keys(ANON_GET_ROUTES).filter((p) => !getRoutes.includes(p));
    expect(stale, 'remove entries for routes that no longer exist').toEqual([]);
  });

  it('no classified route is also a public path (the gate never sees those)', () => {
    const both = Object.keys(ANON_GET_ROUTES).filter((p) => computeIsPublicPath(sample(p)));
    expect(both).toEqual([]);
  });

  it('for every routed GET, the allowlist decision matches the class of the route the router serves', () => {
    const mismatches: string[] = [];
    for (const r of getRoutes) {
      const p = sample(r);
      if (!p.startsWith('/api/') || computeIsPublicPath(p)) continue;
      const served = routerChoice(p)!;
      const want = ANON_GET_ROUTES[served]?.class !== 'deny';
      const got = isAnonGetAllowlisted(p);
      if (got.allowed !== want) mismatches.push(`${p}: router serves ${served} (${ANON_GET_ROUTES[served]?.class}), allowlist says ${got.allowed} via ${got.pattern}`);
    }
    expect(mismatches).toEqual([]);
  });

  it('PI t/574#13: full source text and source files are sign-in only; source metadata and summaries stay anonymous', () => {
    expect(ANON_GET_ROUTES['/api/snapshots/:sourceId'].class).toBe('deny');
    expect(ANON_GET_ROUTES['/api/source-documents/:docId/file'].class).toBe('deny');
    expect(isAnonGetAllowlisted('/api/snapshots/src-1').allowed).toBe(false);
    expect(isAnonGetAllowlisted('/api/source-documents/doc-1/file').allowed).toBe(false);
    expect(isAnonGetAllowlisted('/api/source-documents/doc-1').allowed).toBe(true);
    expect(isAnonGetAllowlisted('/api/summaries/doc-1').allowed).toBe(true);
  });

  it('an unrouted /api/ path is denied; non-/api paths (SPA shell) are not gated here', () => {
    expect(isAnonGetAllowlisted('/api/nope/at/all').allowed).toBe(false);
    expect(isAnonGetAllowlisted('/').allowed).toBe(true);
    expect(isAnonGetAllowlisted('/third-party-notices').allowed).toBe(true);
  });
});

describe('t/574: the anonymous GET gate (report-only, then enforced)', () => {
  const saved = process.env.ANON_GET_ALLOWLIST_ENFORCE;
  beforeEach(() => { resetAnonGetDeniedCounts(); delete process.env.ANON_GET_ALLOWLIST_ENFORCE; });
  afterEach(() => { if (saved === undefined) delete process.env.ANON_GET_ALLOWLIST_ENFORCE; else process.env.ANON_GET_ALLOWLIST_ENFORCE = saved; });

  it('report-only (default): a denied route is allowed but counted by route pattern, never the URL', () => {
    expect(isAnonAllowedRoute('GET', '/api/sync/unsynced')).toBe(true);
    expect(isAnonAllowedRoute('GET', '/api/support/cases/abc-123')).toBe(true);
    expect(anonGetDeniedCounts()).toEqual({ '/api/sync/unsynced': 1, '/api/support/cases/:id': 1 });
  });

  it('enforced: a denied route is refused; allowlisted routes still pass and are not counted', () => {
    process.env.ANON_GET_ALLOWLIST_ENFORCE = '1';
    expect(isAnonAllowedRoute('GET', '/api/sync/unsynced')).toBe(false);
    expect(isAnonAllowedRoute('GET', '/api/admin/config')).toBe(false);
    expect(isAnonAllowedRoute('GET', '/api/nope')).toBe(false);
    expect(isAnonAllowedRoute('GET', '/api/taxonomy/accelerationist')).toBe(true);
    expect(isAnonAllowedRoute('GET', '/api/debates/d-1/comments')).toBe(true);
    expect(isAnonAllowedRoute('GET', '/api/oped-sets/quota-status')).toBe(true);
    expect(Object.keys(anonGetDeniedCounts()).sort()).toEqual(['/api/admin/config', '/api/sync/unsynced', '<unrouted>']);
  });

  it('enforced: a literal deny route is not shadowed by a :param allow of the same shape', () => {
    process.env.ANON_GET_ALLOWLIST_ENFORCE = '1';
    expect(isAnonAllowedRoute('GET', '/api/taxonomy/synthetic-embeddings')).toBe(false);
    expect(isAnonAllowedRoute('GET', '/api/keys/has')).toBe(false);
  });

  it('the existing t/579 blocks still hold in report-only mode', () => {
    for (const p of ['/api/admin/health', '/api/analytics/query', '/api/calibration/log', '/api/flight-recorder/list', '/api/taxonomy/synthetic-embeddings']) {
      expect(isAnonAllowedRoute('GET', p), p).toBe(false);
    }
  });

  it('logs the would-deny at the 1st and 10th hit only', async () => {
    const { log } = await import('../logger.js');
    const warn = vi.spyOn(log.security, 'warn').mockImplementation(() => undefined as never);
    for (let i = 0; i < 12; i++) isAnonAllowedRoute('GET', '/api/templates');
    expect(warn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(warn.mock.calls)).toContain('/api/templates');
    warn.mockRestore();
  });
});
