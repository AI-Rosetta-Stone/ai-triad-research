// @vitest-environment node
// t/666 (SO p/252#59): GET /.auth/anonymous and POST /api/auth/anonymous over real HTTP. With no signing secret
// (t/664 fails closed), both must RESPOND 503 (HTML for the GET link, JSON anon_session_unavailable for the POST) and
// set no cookie. Before this fix the mint's throw escaped the handler and both requests hung. With the secret
// loaded, they set a signed anon_session_id (302 and 200 respectively).

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import type { AddressInfo } from 'net';

vi.mock('../logger.js', () => {
  const l = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
  return { log: { server: l(), api: l(), ai: l(), security: l() }, getRequestId: () => 'r' };
});
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));

import { handleAnonAuthEndpoints } from '../anonAuthEndpoints.js';
import { setAnonSessionSecret, clearAnonSessionSecret, verifyAnonSessionCookie } from '../security/anonSessionSigning.js';

let server: http.Server;
let base: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const urlPath = new URL(req.url ?? '/', 'http://x').pathname;
    if (!handleAnonAuthEndpoints(req, res, urlPath, true)) { res.writeHead(404); res.end(); }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

const req = (method: 'GET' | 'POST', path: string) =>
  fetch(`${base}${path}`, { method, redirect: 'manual', signal: AbortSignal.timeout(3000) }); // a hang fails, not waits
const sessionCookie = (res: Response) => (res.headers.get('set-cookie') ?? '').match(/anon_session_id=([^;]+)/)?.[1];

describe('t/666: anonymous session endpoints with no signing secret respond 503, never hang', () => {
  beforeEach(() => { clearAnonSessionSecret(); });

  it('GET /.auth/anonymous: 503 HTML, no cookie', async () => {
    const res = await req('GET', '/.auth/anonymous');
    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('POST /api/auth/anonymous: 503 JSON anon_session_unavailable, no cookie', async () => {
    const res = await req('POST', '/api/auth/anonymous');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'anon_session_unavailable' });
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});

describe('t/666: with the secret loaded, both mint a signed session', () => {
  beforeEach(() => { setAnonSessionSecret(crypto.randomBytes(32)); });

  it('GET /.auth/anonymous: 302 to / with a verifiable anon_session_id', async () => {
    const res = await req('GET', '/.auth/anonymous');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
    expect(verifyAnonSessionCookie(sessionCookie(res))).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('POST /api/auth/anonymous: 200 JSON with a verifiable anon_session_id', async () => {
    const res = await req('POST', '/api/auth/anonymous');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, anonymous: true });
    expect(verifyAnonSessionCookie(sessionCookie(res))).toMatch(/^[0-9a-f-]{36}$/);
  });
});
