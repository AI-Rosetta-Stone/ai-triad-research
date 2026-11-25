// @vitest-environment node
// t/500 (TL p/16#417): at the signed-cookie cutover, an existing visitor's bare-uuid cookie no longer verifies, so their
// storage id would be `_local`, the owner's store. Through real HTTP, with the real mint endpoint and the real
// refusal: a hosted anonymous /api/ request with no verified session is refused 401 no_session BEFORE any handler runs;
// the client's recovery (POST /api/auth/anonymous, then retry) then reaches the visitor's own anon-<uuid>. A per-visitor
// handler never sees `_local` (zero `_local` reads). Exemptions: signed in, local AUTH_DISABLED mode, /api/auth/me, non-API.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import type { AddressInfo } from 'net';

vi.mock('../logger.js', () => {
  const l = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
  return { log: { server: l(), api: l(), ai: l(), security: l() }, getRequestId: () => 'r' };
});
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));

import { anonRequestIdentity, refuseUnkeyedHostedAnonymous } from '../anonRequestIdentity.js';
import { handleAnonAuthEndpoints } from '../anonAuthEndpoints.js';
import { runWithUser, getStorageUserId } from '../security/userContext.js';
import { setAnonSessionSecret } from '../security/anonSessionSigning.js';

const UUID = '0f8fad5b-d9cb-469f-a165-8c7c0e2c1a11';
const handlerSaw: string[] = [];
let server: http.Server;
let base: string;
const ENV = ['AUTH_OPTIONAL', 'AUTH_DISABLED', 'NODE_ENV'];
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  setAnonSessionSecret(crypto.randomBytes(32));
  server = http.createServer((req, res) => {
    const urlPath = new URL(req.url ?? '/', 'http://x').pathname;
    const principalName = String(req.headers['x-test-principal'] ?? '');
    // As server.ts: the mint endpoints first, then the refusal, then the user context and the handler.
    if (handleAnonAuthEndpoints(req, res, urlPath, process.env.AUTH_OPTIONAL === '1')) return;
    if (refuseUnkeyedHostedAnonymous(req, res, { urlPath, isPublicPath: false, principalName, authOptional: process.env.AUTH_OPTIONAL === '1' })) return;
    const anon = principalName ? undefined : anonRequestIdentity(req);
    const ctx = { principalName: principalName || '_local', idp: '_local', branchName: undefined, storageUserId: anon ? anon.storageUserId : principalName, isAnonymous: !principalName, anonymousSessionId: anon?.anonymousSessionId, stableId: undefined };
    void runWithUser(ctx as never, async () => {
      handlerSaw.push(getStorageUserId()); // a per-visitor handler would read this store
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ storageUserId: getStorageUserId() }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });
beforeEach(() => { for (const n of ENV) { saved[n] = process.env[n]; delete process.env[n]; } process.env.AUTH_OPTIONAL = '1'; handlerSaw.length = 0; });
afterEach(() => { for (const n of ENV) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; } });

const call = (method: string, path: string, cookie?: string, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method, redirect: 'manual', headers: { ...(cookie ? { cookie } : {}), ...headers } });
const OLD_COOKIE = `auth_anonymous=1; anon_session_id=${UUID}`; // a pre-cutover bare uuid

describe('t/500: the cutover never reads `_local` for an anonymous visitor', () => {
  it('an old bare cookie: per-visitor GET is 401 no_session and no handler runs', async () => {
    for (const path of ['/api/chats', '/api/debates/list', '/api/oped-sets', '/api/preferences']) {
      const r = await call('GET', path, OLD_COOKIE);
      expect(`${path} ${r.status} ${r.headers.get('x-auth-reason')}`).toBe(`${path} 401 no_session`);
    }
    expect(handlerSaw).toEqual([]);
  });

  it('the recovery: POST /api/auth/anonymous mints a signed session, and the retry reaches anon-<uuid>, never _local', async () => {
    expect((await call('GET', '/api/chats', OLD_COOKIE)).status).toBe(401);
    const mint = await call('POST', '/api/auth/anonymous', OLD_COOKIE);
    expect(mint.status).toBe(200);
    const signed = (mint.headers.get('set-cookie') ?? '').match(/anon_session_id=([^;]+)/)?.[1];
    expect(signed).toBeTruthy();
    const retry = await call('GET', '/api/chats', `auth_anonymous=1; anon_session_id=${signed}`);
    expect(retry.status).toBe(200);
    expect((await retry.json()).storageUserId).toMatch(/^anon-[0-9a-f-]{36}$/);
    expect(handlerSaw.every(id => id !== '_local')).toBe(true);
    expect(handlerSaw).toHaveLength(1);
  });

  it('exempt: /api/auth/me (the identity probe) and non-API paths are served', async () => {
    expect((await call('GET', '/api/auth/me', OLD_COOKIE)).status).toBe(200);
    expect((await call('GET', '/share/pov/x', OLD_COOKIE)).status).toBe(200);
  });

  it('exempt: a signed-in request, and local AUTH_DISABLED mode where every request is _local by design', async () => {
    expect((await call('GET', '/api/chats', undefined, { 'x-test-principal': 'alice' })).status).toBe(200);
    process.env.AUTH_DISABLED = '1';
    expect((await call('GET', '/api/chats', OLD_COOKIE)).status).toBe(200);
  });
});
