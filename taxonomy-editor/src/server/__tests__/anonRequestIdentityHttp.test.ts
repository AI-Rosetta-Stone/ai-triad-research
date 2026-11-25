// @vitest-environment node
// t/500 (t/666; Security p/93#110): through a real HTTP request, the anonymous identity server.ts builds
// (anonRequestIdentity, then runWithUser) gives getStorageUserId() === `anon-<uuid>` for a validly signed cookie and
// `_local` for a bare, forged or missing one. getAnonymousSessionId() holds only the verified uuid. Before the fix,
// a signed cookie also gave `_local` (the verified uuid was re-verified as if it were a cookie).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import type { AddressInfo } from 'net';
import { anonRequestIdentity } from '../anonRequestIdentity.js';
import { runWithUser, getStorageUserId, getAnonymousSessionId } from '../security/userContext.js';
import { setAnonSessionSecret, signAnonSessionId } from '../security/anonSessionSigning.js';

const UUID = '0f8fad5b-d9cb-469f-a165-8c7c0e2c1a11';
let server: http.Server;
let base: string;

beforeAll(async () => {
  setAnonSessionSecret(crypto.randomBytes(32));
  server = http.createServer((req, res) => {
    const anon = anonRequestIdentity(req);
    // As server.ts resolveRequestUserContext builds an anonymous UserContext.
    const ctx = { principalName: '_local', idp: '_local', branchName: undefined, storageUserId: anon.storageUserId, isAnonymous: true, anonymousSessionId: anon.anonymousSessionId, stableId: undefined };
    void runWithUser(ctx as never, async () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ storageUserId: getStorageUserId(), anonymousSessionId: getAnonymousSessionId() ?? null }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

const get = async (cookie?: string) => (await fetch(base, { headers: cookie ? { cookie } : {} })).json() as Promise<{ storageUserId: string; anonymousSessionId: string | null }>;

describe('t/666: anonymous request identity over HTTP', () => {
  it('a validly signed cookie gives anon-<uuid>, and the context holds the verified uuid', async () => {
    expect(await get(`anon_session_id=${signAnonSessionId(UUID)}`)).toEqual({ storageUserId: `anon-${UUID}`, anonymousSessionId: UUID });
  });

  it('a bare uuid gives _local and no session id', async () => {
    expect(await get(`anon_session_id=${UUID}`)).toEqual({ storageUserId: '_local', anonymousSessionId: null });
  });

  it('a forged signature gives _local', async () => {
    expect(await get(`anon_session_id=${UUID}.${'0'.repeat(64)}`)).toEqual({ storageUserId: '_local', anonymousSessionId: null });
  });

  it('no cookie gives _local', async () => {
    expect(await get()).toEqual({ storageUserId: '_local', anonymousSessionId: null });
  });
});
