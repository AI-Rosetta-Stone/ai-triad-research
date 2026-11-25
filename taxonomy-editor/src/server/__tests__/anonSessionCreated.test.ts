// @vitest-environment node
// t/2493 — anon session_created_at: the companion `anon_session_created` cookie
// (mint / first-seen marker) and its exposure as `session_created_at` on
// /api/auth/me for the flight-recorder auth snapshot (t/2490 Gap 1).

import { describe, it, expect, afterEach } from 'vitest';
import crypto from 'crypto';
import { setAnonSessionSecret, signAnonSessionId } from '../security/anonSessionSigning.js';
import type { IncomingMessage, ServerResponse } from 'http';
import type { Handler, Router } from '../httpKit.js';
import type { ServerCtx } from '../routes/context.js';
import { registerSessionRoutes } from '../routes/session.js';
import {
  ANON_SESSION_CREATED_COOKIE,
  anonSessionCreatedCookie,
  anonSessionCookiesWithCreated,
  readValidCreatedMs,
} from '../routes/anonSessionCreated.js';

// t/664: the anon_session_id cookie is <uuid>.<hmac>; a valid one is signed under this environment's secret.
setAnonSessionSecret(crypto.randomBytes(32));
const VALID_UUID = signAnonSessionId('11111111-2222-4333-8444-555555555555');
const FLOOR_MS = Date.parse('2025-01-01T00:00:00Z');

const reqWith = (cookie?: string, headers: Record<string, string> = {}): IncomingMessage =>
  ({ headers: { cookie, ...headers } } as unknown as IncomingMessage);

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe('anonSessionCreatedCookie (t/2493)', () => {
  it('carries HttpOnly + SameSite=Lax + Path=/ + 1yr Max-Age and the epoch-ms value', () => {
    const c = anonSessionCreatedCookie(1_700_000_000_000);
    expect(c).toMatch(/^anon_session_created=1700000000000;/);
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Lax');
    expect(c).toContain('Path=/');
    expect(c).toContain('Max-Age=31536000');
  });
});

describe('readValidCreatedMs (t/2493 cond. 1 — untrusted client cookie)', () => {
  const now = FLOOR_MS + 10_000_000;

  it('returns the ms for a sane in-range integer', () => {
    const ms = now - 5000;
    expect(readValidCreatedMs(reqWith(`${ANON_SESSION_CREATED_COOKIE}=${ms}`), now)).toBe(ms);
  });

  it('returns null when the cookie is absent', () => {
    expect(readValidCreatedMs(reqWith('other=1'), now)).toBeNull();
    expect(readValidCreatedMs(reqWith(undefined), now)).toBeNull();
  });

  it('rejects non-integer / garbage values', () => {
    expect(readValidCreatedMs(reqWith(`${ANON_SESSION_CREATED_COOKIE}=not-a-number`), now)).toBeNull();
    expect(readValidCreatedMs(reqWith(`${ANON_SESSION_CREATED_COOKIE}=17e11`), now)).toBeNull();
    expect(readValidCreatedMs(reqWith(`${ANON_SESSION_CREATED_COOKIE}=-1700000000000`), now)).toBeNull();
  });

  it('rejects a value earlier than the product-launch floor (forged past)', () => {
    expect(readValidCreatedMs(reqWith(`${ANON_SESSION_CREATED_COOKIE}=${FLOOR_MS - 1}`), now)).toBeNull();
  });

  it('rejects a future value beyond the clock-skew window (forged future)', () => {
    const future = now + 6 * 60 * 1000; // > 5min skew
    expect(readValidCreatedMs(reqWith(`${ANON_SESSION_CREATED_COOKIE}=${future}`), now)).toBeNull();
  });

  it('tolerates a small forward clock skew', () => {
    const skewed = now + 60 * 1000; // 1min < 5min skew
    expect(readValidCreatedMs(reqWith(`${ANON_SESSION_CREATED_COOKIE}=${skewed}`), now)).toBe(skewed);
  });
});

describe('anonSessionCookiesWithCreated (t/2493 cond. 2 — mint-site marker)', () => {
  const createdOf = (cookies: string[]) =>
    cookies.find(c => c.startsWith(`${ANON_SESSION_CREATED_COOKIE}=`));

  it('appends created=now when a fresh UUID is minted (no existing id)', () => {
    const now = FLOOR_MS + 1_000;
    const cookies = anonSessionCookiesWithCreated(reqWith(undefined), now);
    expect(cookies.some(c => c.startsWith('anon_session_id='))).toBe(true);
    expect(createdOf(cookies)).toBe(anonSessionCreatedCookie(now));
  });

  it('OVERWRITES a lingering stale created cookie on fresh mint (invalid id → new UUID)', () => {
    const now = FLOOR_MS + 2_000;
    // Old created marker present, but the id cookie is malformed → resolveAnonSessionId
    // mints a fresh UUID, so the new session must NOT inherit the old timestamp.
    const stale = FLOOR_MS + 1;
    const req = reqWith(`anon_session_id=not-a-uuid; ${ANON_SESSION_CREATED_COOKIE}=${stale}`);
    const cookies = anonSessionCookiesWithCreated(req, now);
    expect(createdOf(cookies)).toBe(anonSessionCreatedCookie(now));
    expect(createdOf(cookies)).not.toContain(String(stale));
  });

  it('does NOT append a created cookie when a valid id is reused (existing marker untouched)', () => {
    const now = FLOOR_MS + 3_000;
    const cookies = anonSessionCookiesWithCreated(reqWith(`anon_session_id=${VALID_UUID}`), now);
    expect(cookies.some(c => c.startsWith(`anon_session_id=${VALID_UUID}`))).toBe(true);
    expect(createdOf(cookies)).toBeUndefined();
  });
});

// ── /api/auth/me exposure ────────────────────────────────────────────────────

interface CapturedRes {
  status: number;
  headers: Record<string, string | string[]>;
  body: unknown;
}

function mockRes(): { res: ServerResponse; captured: CapturedRes } {
  const captured: CapturedRes = { status: 0, headers: {}, body: undefined };
  const res = {
    writableEnded: false,
    headersSent: false,
    setHeader(k: string, v: string | string[]) { captured.headers[k] = v; },
    writeHead(status: number, hdrs?: Record<string, string>) {
      captured.status = status;
      if (hdrs) Object.assign(captured.headers, hdrs);
      (this as unknown as { headersSent: boolean }).headersSent = true;
    },
    end(body?: string) {
      captured.body = body ? JSON.parse(body) : undefined;
      (this as unknown as { writableEnded: boolean }).writableEnded = true;
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

function authMeHandler(): Handler {
  let handler: Handler | undefined;
  const r = {
    get: (path: string, h: Handler) => { if (path === '/api/auth/me') handler = h; },
    post: () => {}, put: () => {}, patch: () => {}, del: () => {},
  } as unknown as Router;
  registerSessionRoutes(r, { broadcastEvent: () => {} } as unknown as ServerCtx);
  if (!handler) throw new Error('/api/auth/me handler not registered');
  return handler;
}

async function callAuthMe(req: IncomingMessage): Promise<CapturedRes> {
  const { res, captured } = mockRes();
  await authMeHandler()(req, res, undefined);
  return captured;
}

const setCookieHeader = (c: CapturedRes): string =>
  Array.isArray(c.headers['Set-Cookie']) ? (c.headers['Set-Cookie'] as string[]).join('\n') : String(c.headers['Set-Cookie'] ?? '');

describe('/api/auth/me session_created_at (t/2493)', () => {
  const savedAuthEnabled = process.env.WEBSITE_AUTH_ENABLED;
  afterEach(() => {
    if (savedAuthEnabled === undefined) delete process.env.WEBSITE_AUTH_ENABLED;
    else process.env.WEBSITE_AUTH_ENABLED = savedAuthEnabled;
  });

  it('returns session_created_at (from a valid created cookie) without re-backfilling', async () => {
    delete process.env.WEBSITE_AUTH_ENABLED;
    const ms = Date.now() - 60_000;
    const c = await callAuthMe(reqWith(`anon_session_id=${VALID_UUID}; ${ANON_SESSION_CREATED_COOKIE}=${ms}`));
    expect((c.body as { session_created_at?: string }).session_created_at).toBe(new Date(ms).toISOString());
    expect(setCookieHeader(c)).not.toContain(ANON_SESSION_CREATED_COOKIE); // no backfill needed
  });

  it('lazy-backfills (Set-Cookie + ~now) when id present but created cookie absent', async () => {
    delete process.env.WEBSITE_AUTH_ENABLED;
    const before = Date.now();
    const c = await callAuthMe(reqWith(`anon_session_id=${VALID_UUID}`));
    const iso = (c.body as { session_created_at?: string }).session_created_at;
    expect(iso).toBeDefined();
    expect(Date.parse(iso!)).toBeGreaterThanOrEqual(before);
    expect(setCookieHeader(c)).toContain(`${ANON_SESSION_CREATED_COOKIE}=`);
  });

  it('discards a forged created cookie and re-backfills with now (never echoes the raw value)', async () => {
    delete process.env.WEBSITE_AUTH_ENABLED;
    const forged = Date.now() + 10 * 60 * 1000; // future → invalid
    const before = Date.now();
    const c = await callAuthMe(reqWith(`anon_session_id=${VALID_UUID}; ${ANON_SESSION_CREATED_COOKIE}=${forged}`));
    const iso = (c.body as { session_created_at?: string }).session_created_at!;
    expect(Date.parse(iso)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(iso)).toBeLessThan(forged);            // not the forged value
    expect(setCookieHeader(c)).toContain(`${ANON_SESSION_CREATED_COOKIE}=`); // repaired
  });

  it('omits session_created_at when there is no anon_session_id cookie', async () => {
    delete process.env.WEBSITE_AUTH_ENABLED;
    const c = await callAuthMe(reqWith('other=1'));
    expect((c.body as { session_created_at?: string }).session_created_at).toBeUndefined();
    expect(setCookieHeader(c)).not.toContain(ANON_SESSION_CREATED_COOKIE);
  });

  it('omits session_created_at for authenticated users', async () => {
    process.env.WEBSITE_AUTH_ENABLED = 'true';
    const c = await callAuthMe(reqWith(
      `anon_session_id=${VALID_UUID}`,
      { 'x-ms-client-principal-name': 'alice@example.com' },
    ));
    expect((c.body as { anonymous: boolean }).anonymous).toBe(false);
    expect((c.body as { session_created_at?: string }).session_created_at).toBeUndefined();
  });
});
