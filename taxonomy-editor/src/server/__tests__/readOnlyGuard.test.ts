// @vitest-environment node
//
// t/4296 — read-only access tier for the ai-triad-smoke test identity.
//
// Three layers, per the TL's approval conditions (t/4296#1 / p/522#416):
//   1. isMutatingApiRoute enumeration — every mutating /api/* route in the REAL,
//      full route table (extractRoutes.ts, the same table routeTable.test.ts pins)
//      is caught; every GET/HEAD and non-/api/* route is not. A new mutating route
//      is covered automatically because this iterates the live table, not a fixture.
//   2. resolveReadOnlyFlag — true for a configured read-only user, false otherwise,
//      and fails open (false) with a WARN + flight-recorder entry when resolveTier throws.
//   3. enforceReadOnlyGuard — writes the 403 only when both (1) and (2) hold; a fake
//      req/res stands in for http.IncomingMessage/ServerResponse (server.ts itself
//      cannot be imported — it boots an HTTP server at import).
//   4. Wiring (condition 1): a static source check on server.ts — fails if the call
//      to enforceReadOnlyGuard is removed from the dispatch sequence, independent of
//      whether the function itself still passes its own unit tests.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { extractRoutes } from './extractRoutes.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const { resolveTierMock, warnMock, recordMock } = vi.hoisted(() => ({
  resolveTierMock: vi.fn(), warnMock: vi.fn(), recordMock: vi.fn(),
}));
vi.mock('../ai/proxyTiers.js', () => ({ resolveTier: resolveTierMock }));
vi.mock('../logger.js', () => ({ log: { server: { warn: warnMock, info: vi.fn(), error: vi.fn(), debug: vi.fn() } } }));
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: recordMock }) }));

import { isMutatingApiRoute, resolveReadOnlyFlag, enforceReadOnlyGuard } from '../readOnlyGuard.js';

beforeEach(() => { resolveTierMock.mockReset(); warnMock.mockClear(); recordMock.mockClear(); });

describe('t/4296 — isMutatingApiRoute (full route-table enumeration)', () => {
  const serverEntry = path.join(here, '..', 'server.ts');
  const routes = extractRoutes(serverEntry);

  it('every mutating /api/* route in the live table is caught', () => {
    const mutating = routes.filter(r => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method) && r.path.startsWith('/api/'));
    expect(mutating.length).toBeGreaterThan(0); // sanity — the table isn't empty
    for (const r of mutating) {
      expect(isMutatingApiRoute(r.method, r.path, true)).toBe(true);
    }
  });

  it('no GET/HEAD route, and no non-/api/* route, is caught (fault arm)', () => {
    const reads = routes.filter(r => r.method === 'GET');
    for (const r of reads) {
      expect(isMutatingApiRoute(r.method, r.path, true)).toBe(false);
    }
    expect(isMutatingApiRoute('POST', '/healthz', true)).toBe(false);
    expect(isMutatingApiRoute('POST', '/api/anything', false)).toBe(false); // unmatched route (404) — never gated on tier
  });
});

describe('t/4296 — resolveReadOnlyFlag', () => {
  it('returns true for a configured read-only user', () => {
    resolveTierMock.mockReturnValue({ level: 'byok', limits: {}, allowedBackends: [], readOnly: true });
    expect(resolveReadOnlyFlag('ai-triad-smoke', 'github')).toBe(true);
  });

  it('returns false for an ordinary user', () => {
    resolveTierMock.mockReturnValue({ level: 'byok', limits: {}, allowedBackends: [], readOnly: false });
    expect(resolveReadOnlyFlag('jpsnover', 'github')).toBe(false);
  });

  it('defaults to false with a WARN + flight-recorder entry when resolveTier throws', () => {
    resolveTierMock.mockImplementation(() => { throw new Error('proxy-tiers.json unreadable'); });
    expect(resolveReadOnlyFlag('anyone', 'github')).toBe(false);
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(recordMock).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn' }));
  });
});

describe('t/4296 — enforceReadOnlyGuard', () => {
  function fakeReqRes(method: string) {
    const headers: Record<string, string> = {};
    let body = '';
    let statusCode = 0;
    const res = {
      writeHead: vi.fn((code: number, h: Record<string, string>) => { statusCode = code; Object.assign(headers, h); }),
      end: vi.fn((b: string) => { body = b; }),
    };
    return { req: { method } as any, res: res as any, get statusCode() { return statusCode; }, get body() { return body; }, get headers() { return headers; } };
  }

  it('blocks a read-only user on a mutating /api/* route with a 403', () => {
    resolveTierMock.mockReturnValue({ level: 'byok', limits: {}, allowedBackends: [], readOnly: true });
    const h = fakeReqRes('POST');
    const blocked = enforceReadOnlyGuard(h.req, h.res, true, '/api/cruxes/crux-001/evidence', 'ai-triad-smoke', 'github');
    expect(blocked).toBe(true);
    expect(h.statusCode).toBe(403);
    expect(JSON.parse(h.body)).toEqual({ error: 'read_only', message: 'This account is read-only and cannot write.' });
  });

  it('does not block a non-read-only user on the same route', () => {
    resolveTierMock.mockReturnValue({ level: 'byok', limits: {}, allowedBackends: [], readOnly: false });
    const h = fakeReqRes('POST');
    expect(enforceReadOnlyGuard(h.req, h.res, true, '/api/cruxes/crux-001/evidence', 'jpsnover', 'github')).toBe(false);
    expect(h.res.writeHead).not.toHaveBeenCalled();
  });

  it('does not block a read-only user on a GET route (never calls resolveTier)', () => {
    const h = fakeReqRes('GET');
    expect(enforceReadOnlyGuard(h.req, h.res, true, '/api/cruxes', 'ai-triad-smoke', 'github')).toBe(false);
    expect(resolveTierMock).not.toHaveBeenCalled();
  });
});

describe('t/4296 — wiring (TL condition 1): server.ts still calls enforceReadOnlyGuard', () => {
  const serverSrc = fs.readFileSync(path.join(here, '..', 'server.ts'), 'utf-8');

  it('imports enforceReadOnlyGuard from readOnlyGuard.js', () => {
    expect(serverSrc).toMatch(/import\s*\{\s*enforceReadOnlyGuard\s*\}\s*from\s*'\.\/readOnlyGuard\.js'/);
  });

  it('calls enforceReadOnlyGuard in the dispatch sequence, after the route is matched and before it is dispatched', () => {
    const matchIdx = serverSrc.indexOf('const route = matchRoute(');
    const guardIdx = serverSrc.indexOf('enforceReadOnlyGuard(req, res,');
    const dispatchIdx = serverSrc.indexOf('await dispatchMatchedRoute(req, res, route, reqPath)');
    expect(matchIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(matchIdx);
    expect(dispatchIdx).toBeGreaterThan(guardIdx);
  });
});
