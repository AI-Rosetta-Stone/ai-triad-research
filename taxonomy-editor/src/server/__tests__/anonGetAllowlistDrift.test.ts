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
  ANON_GET_ROUTES, routePatternMatches, isAnonGetAllowlisted, classifyAnonGet, anonGetDeniedCounts, resetAnonGetDeniedCounts,
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

  // Quality t/658#16.2: a path that TWO patterns both match (e.g. /api/organizations/by-pov/edges matches
  // 'by-pov/:pov' and ':id/edges'). The router serves the first registered; the allowlist picks by parameter
  // count, then table order. sample() never builds such a path, so every unifiable pair is built here.
  it('for every path two GET patterns both match, the allowlist decision matches the route the router serves', () => {
    const api = getRoutes.filter((r) => r.startsWith('/api/') && !computeIsPublicPath(sample(r)));
    const unify = (a: string, b: string): string | null => {
      const as = a.split('/'); const bs = b.split('/');
      if (as.length !== bs.length) return null;
      const out: string[] = [];
      for (let i = 0; i < as.length; i++) {
        const ap = as[i].startsWith(':'); const bp = bs[i].startsWith(':');
        if (!ap && !bp && as[i] !== bs[i]) return null;
        out.push(!ap ? as[i] : !bp ? bs[i] : 'x1');
      }
      return out.join('/');
    };
    const overlaps: string[] = [];
    const mismatches: string[] = [];
    for (let i = 0; i < api.length; i++) {
      for (let j = i + 1; j < api.length; j++) {
        const p = unify(api[i], api[j]);
        if (p === null) continue;
        overlaps.push(p);
        const served = routerChoice(p)!;
        const want = ANON_GET_ROUTES[served]?.class !== 'deny';
        const got = isAnonGetAllowlisted(p);
        if (got.allowed !== want) mismatches.push(`${p}: router serves ${served} (${ANON_GET_ROUTES[served]?.class}), allowlist says ${got.allowed} via ${got.pattern}`);
      }
    }
    expect(overlaps.length, 'the overlap builder found no overlapping patterns; it is not exercising anything').toBeGreaterThan(0);
    expect(overlaps).toContain('/api/organizations/by-pov/edges');
    expect(mismatches).toEqual([]);
  });

  // Quality t/658#16.3: the gate passes every non-/api path, so a data route registered outside /api/ would be
  // anonymous-readable without ever being classified. Every such GET route must be a declared public path.
  // The reviewed exceptions are pinned by name, each with what it serves; the list changes only with Security review.
  const NON_API_ANON_OK: Record<string, string> = {
    '/third-party-notices': 'static open-source licence text shipped with the app; no user or corpus data',
  };
  it('every GET route outside /api/ is a public path or a reviewed static page', () => {
    const outside = getRoutes.filter((r) => !r.startsWith('/api/'));
    expect(outside.length).toBeGreaterThan(0);
    const unclassified = outside.filter((r) => !computeIsPublicPath(sample(r)) && !(r in NON_API_ANON_OK));
    expect(unclassified, 'a GET route outside /api/ must be a public path (publicPaths.ts), a reviewed entry in NON_API_ANON_OK, or move under /api/ and be classified').toEqual([]);
    const stale = Object.keys(NON_API_ANON_OK).filter((r) => !outside.includes(r) || computeIsPublicPath(sample(r)));
    expect(stale, 'remove NON_API_ANON_OK entries that are no longer routed or are now public paths').toEqual([]);
  });

  it('PI t/574#13: full source text and source files are sign-in only; source metadata and summaries stay anonymous', () => {
    expect(ANON_GET_ROUTES['/api/snapshots/:sourceId'].class).toBe('deny');
    expect(ANON_GET_ROUTES['/api/source-documents/:docId/file'].class).toBe('deny');
    expect(isAnonGetAllowlisted('/api/snapshots/src-1').allowed).toBe(false);
    expect(isAnonGetAllowlisted('/api/source-documents/doc-1/file').allowed).toBe(false);
    expect(isAnonGetAllowlisted('/api/source-documents/doc-1').allowed).toBe(true);
    expect(ANON_GET_ROUTES['/api/source-documents/:docId'].class).toBe('metadata'); // t/677: no text for anonymous
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

  // Asserted on the allowlist itself (Quality t/658#16.1): through isAnonAllowedRoute both paths are refused by
  // earlier checks (the /api/keys prefix, SYNTHETIC_EMBEDDINGS_PATH), so that call never reaches the allowlist.
  it('a literal deny route is not shadowed by a :param allow of the same shape', () => {
    for (const p of ['/api/taxonomy/synthetic-embeddings', '/api/keys/has']) {
      expect(classifyAnonGet(p)?.pattern, p).toBe(p);
      expect(classifyAnonGet(p)?.entry.class, p).toBe('deny');
      expect(isAnonGetAllowlisted(p), p).toEqual({ allowed: false, pattern: p });
    }
    // The shadowing candidate exists: without the literal entry, the path would match an allowed ':param' route.
    expect(routePatternMatches('/api/taxonomy/:pov', '/api/taxonomy/synthetic-embeddings')).toBe(true);
    expect(ANON_GET_ROUTES['/api/taxonomy/:pov'].class).not.toBe('deny');
  });

  it('every literal deny route classifies as itself and is not allowlisted', () => {
    const literalDeny = Object.entries(ANON_GET_ROUTES).filter(([p, e]) => e.class === 'deny' && !p.includes(':')).map(([p]) => p);
    expect(literalDeny.length).toBeGreaterThan(10);
    const wrong = literalDeny.filter((p) => { const g = isAnonGetAllowlisted(p); return g.allowed || g.pattern !== p; });
    expect(wrong).toEqual([]);
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
