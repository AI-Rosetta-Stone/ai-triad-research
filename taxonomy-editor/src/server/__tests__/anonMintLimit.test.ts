// @vitest-environment node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/818 (SO p/252#87): GET /.auth/anonymous and POST /api/auth/anonymous mint a fresh signed session for any request without
// a valid cookie. A per-IP limit (sessions.anonMintPerIpPerHour, default 60) now brakes minting; a request that carries a
// VALID cookie is not a mint and is never counted. Over real HTTP through the real handler, the real rate limiter and the
// real signer (each test uses its own address, so the in-process windows never overlap). The IP comes from X-Forwarded-For (the test server is on loopback, which getClientIp treats as a proxy).

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import type { AddressInfo } from 'net';

const { warnSpy } = vi.hoisted(() => ({ warnSpy: vi.fn() }));
vi.mock('../logger.js', () => {
  const l = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
  return { log: { server: { ...l(), warn: warnSpy }, api: l(), ai: l(), security: l() }, getRequestId: () => 'r' };
});
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));

import { handleAnonAuthEndpoints } from '../anonAuthEndpoints.js';
import { setAnonSessionSecret } from '../security/anonSessionSigning.js';
import { getConfig } from '../runtimeConfig.js';

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

let savedLimit: number;
beforeEach(() => {
  setAnonSessionSecret(crypto.randomBytes(32));
  warnSpy.mockClear();
  savedLimit = getConfig().sessions.anonMintPerIpPerHour;
});
afterEach(() => { getConfig().sessions.anonMintPerIpPerHour = savedLimit; });

const mint = (method: 'GET' | 'POST', ip: string, cookie?: string) =>
  fetch(`${base}${method === 'GET' ? '/.auth/anonymous' : '/api/auth/anonymous'}`, {
    method, redirect: 'manual', signal: AbortSignal.timeout(3000),
    headers: { 'x-forwarded-for': ip, ...(cookie ? { cookie } : {}) },
  });
const idCookie = (res: Response): string => (res.headers.get('set-cookie') ?? '').match(/anon_session_id=[^;]+/)?.[0] ?? '';

describe('t/818: per-IP limit on minting anonymous sessions', () => {
  it('the default is 60 an hour', () => {
    expect(savedLimit).toBe(60);
  });

  it('mints up to the limit, then 429 with Retry-After (JSON for the POST, HTML for the GET), no cookie set', async () => {
    getConfig().sessions.anonMintPerIpPerHour = 3;
    for (let i = 0; i < 3; i++) expect((await mint('POST', '198.51.100.7')).status).toBe(200);
    const post = await mint('POST', '198.51.100.7');
    expect(post.status).toBe(429);
    expect(Number(post.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await post.json()).toMatchObject({ error: 'anon_session_rate_limited' });
    expect(post.headers.get('set-cookie')).toBeNull();
    const get = await mint('GET', '198.51.100.7');
    expect(get.status).toBe(429);
    expect(get.headers.get('content-type')).toMatch(/text\/html/);
    expect(get.headers.get('set-cookie')).toBeNull();
  });

  it('is per address: another IP still mints', async () => {
    getConfig().sessions.anonMintPerIpPerHour = 1;
    expect((await mint('POST', '198.51.100.8')).status).toBe(200);
    expect((await mint('POST', '198.51.100.8')).status).toBe(429);
    expect((await mint('POST', '198.51.100.9')).status).toBe(200);
  });

  it('a request carrying a VALID cookie is not a mint: it is never counted and never refused, even over the limit', async () => {
    getConfig().sessions.anonMintPerIpPerHour = 1;
    const first = await mint('POST', '198.51.100.10');
    expect(first.status).toBe(200);
    const cookie = idCookie(first);
    expect(cookie).toMatch(/^anon_session_id=/);
    for (let i = 0; i < 5; i++) {
      const again = await mint('POST', '198.51.100.10', cookie); // the parallel 401-recovery POSTs of one page load
      expect(again.status).toBe(200);
      expect(idCookie(again)).toBe(cookie); // kept, not rotated
    }
    expect((await mint('POST', '198.51.100.10')).status).toBe(429); // a fresh mint from the same IP is still refused
  });

  it('a forged or unsigned cookie counts as a mint', async () => {
    getConfig().sessions.anonMintPerIpPerHour = 1;
    expect((await mint('POST', '198.51.100.11', 'anon_session_id=0f8fad5b-d9cb-469f-a165-8c7c0e2c1a11')).status).toBe(200);
    expect((await mint('POST', '198.51.100.11', 'anon_session_id=0f8fad5b-d9cb-469f-a165-8c7c0e2c1a11.deadbeef')).status).toBe(429);
  });

  it('the limit is read live (a config change applies to the next request) and the WARN never carries the address', async () => {
    getConfig().sessions.anonMintPerIpPerHour = 1;
    expect((await mint('POST', '198.51.100.12')).status).toBe(200);
    expect((await mint('POST', '198.51.100.12')).status).toBe(429);
    getConfig().sessions.anonMintPerIpPerHour = 100;
    expect((await mint('POST', '198.51.100.12')).status).toBe(200);
    expect(warnSpy.mock.calls.some((c) => JSON.stringify(c).includes('anon_mint_rate_limited'))).toBe(true);
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('198.51.100');
  });
});
