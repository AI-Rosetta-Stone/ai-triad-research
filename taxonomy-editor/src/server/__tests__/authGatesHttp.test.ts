// @vitest-environment node
// t/616 (closes t/489's gap; TL p/16#376, Security p/93#69): the REAL auth gate and anonymous route guard, driven over
// real HTTP. server.ts listens on import, so the two gates moved verbatim into authGates.ts; this harness builds the
// gate context exactly as server.ts handleRequestInner does (normalizedRequestPath, computeIsPublicPath, the two env
// switches) and runs enforceAuthGate then enforceAnonRouteGuard. A request that passes both reaches a stub dispatcher
// that answers 200 "reached".
// Asserts: anonymous POST /api/oped-sets passes with the free tier on and is refused with it off; share, PUT and
// DELETE stay refused; the t/579 refusals stay (anonymous GET of the flight-recorder list, admin health, analytics).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

vi.mock('../logger.js', () => {
  const l = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
  return { log: { server: l(), api: l(), ai: l(), security: l() } };
});
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));

import { enforceAuthGate, enforceAnonRouteGuard, type AuthGateCtx, type AuthGateDeps } from '../authGates.js';
import { normalizedRequestPath } from '../httpKit.js';
import { computeIsPublicPath } from '../publicPaths.js';

const DEPS: AuthGateDeps = { getAuthorizedUsers: () => null, isUserAuthorized: () => true };
const ENV = ['AUTH_OPTIONAL', 'AUTH_DISABLED', 'FREE_TIER_GEMINI_KEY'];
const saved: Record<string, string | undefined> = {};
let server: http.Server;
let base: string;

beforeEach(async () => {
  for (const n of ENV) { saved[n] = process.env[n]; delete process.env[n]; }
  process.env.AUTH_OPTIONAL = '1'; // the hosted mode: sign-in optional, anonymous sessions allowed
  server = http.createServer((req, res) => {
    // As server.ts: one normalized path for the gate and the router; no EasyAuth principal (anonymous).
    const urlPath = normalizedRequestPath(req);
    const ctx: AuthGateCtx = {
      urlPath, isPublicPath: computeIsPublicPath(urlPath),
      authDisabled: process.env.AUTH_DISABLED === '1', authOptional: process.env.AUTH_OPTIONAL === '1',
      principalName: '', idp: '',
    };
    if (enforceAuthGate(req, res, ctx, DEPS)) return;
    if (enforceAnonRouteGuard(req, res, ctx)) return;
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('reached');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  for (const n of ENV) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; }
});

const freeTier = (on: boolean) => { if (on) process.env.FREE_TIER_GEMINI_KEY = 'AIzaFAKE-NOT-A-KEY'; else delete process.env.FREE_TIER_GEMINI_KEY; };

async function anon(method: string, path: string): Promise<{ status: number; reason: string | null; body: string }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { cookie: 'auth_anonymous=1; anon_session_id=0f8fad5b-d9cb-469f-a165-8c7c0e2c1a11', 'content-type': 'application/json' },
    body: method === 'GET' || method === 'DELETE' ? undefined : '{}',
  });
  return { status: res.status, reason: res.headers.get('x-auth-reason'), body: await res.text() };
}

describe('t/616: the real gates over HTTP for anonymous op-ed create', () => {
  it('anonymous POST /api/oped-sets reaches the handler with the free tier on', async () => {
    freeTier(true);
    const r = await anon('POST', '/api/oped-sets');
    expect(r).toMatchObject({ status: 200, body: 'reached' });
  });

  it('with the free tier off it is refused 403 anon_route_blocked', async () => {
    freeTier(false);
    const r = await anon('POST', '/api/oped-sets');
    expect(r.status).toBe(403);
    expect(r.reason).toBe('anon_route_blocked');
  });

  it('only the exact POST is opened: share, rename and delete stay refused, and a trailing segment does not match', async () => {
    freeTier(true);
    for (const [m, p] of [
      ['POST', '/api/oped-sets/abc/share'], ['DELETE', '/api/oped-sets/abc/share'],
      ['PUT', '/api/oped-sets/abc'], ['DELETE', '/api/oped-sets/abc'], ['POST', '/api/oped-sets/abc'],
    ] as const) {
      const r = await anon(m, p);
      expect(`${m} ${p} ${r.status} ${r.reason}`).toBe(`${m} ${p} 403 anon_route_blocked`);
    }
  });

  it('Security p/93#69: the t/579 refusals stay (anonymous flight-recorder list, admin health, analytics query)', async () => {
    for (const on of [true, false]) {
      freeTier(on);
      for (const p of ['/api/flight-recorder/list', '/api/admin/health', '/api/analytics/query']) {
        const r = await anon('GET', p);
        expect(`${on} GET ${p} ${r.status} ${r.reason}`).toBe(`${on} GET ${p} 403 anon_route_blocked`);
        expect(r.body).not.toContain('reached');
      }
    }
  });

  it('other anonymous AI POSTs keep their free-tier behaviour (chat-stream open with the tier on, closed with it off)', async () => {
    freeTier(true);
    expect((await anon('POST', '/api/ai/chat-stream')).status).toBe(200);
    freeTier(false);
    expect((await anon('POST', '/api/ai/chat-stream')).status).toBe(403);
  });

  it('a cookie-less /api/ call to a route that needs a session gets 401 no_session (the optional-auth gate)', async () => {
    freeTier(true);
    const res = await fetch(`${base}/api/admin/health`);
    expect(res.status).toBe(401);
    expect(res.headers.get('x-auth-reason')).toBe('no_session');
  });
});
