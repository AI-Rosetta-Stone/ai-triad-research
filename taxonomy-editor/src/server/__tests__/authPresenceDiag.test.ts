// @vitest-environment node
//
// t/4406 (TEMPORARY) — presence-only auth diagnostic on /api/auth/me. The safety property under
// test is that no cookie VALUE and no principal NAME ever reaches the log line.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage } from 'http';

const { infoMock } = vi.hoisted(() => ({ infoMock: vi.fn() }));
vi.mock('../logger.js', () => ({ log: { server: { info: infoMock, warn: vi.fn(), error: vi.fn() } } }));

import { authPresence, logAuthPresenceIfEnabled } from '../authPresenceDiag.js';

const SECRET_COOKIE = 'SECRET-SESSION-VALUE-xyz';
const PRINCIPAL = 'someone@example.com';

function req(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

const prev = process.env.AUTH_PRESENCE_DIAG;
beforeEach(() => { infoMock.mockClear(); });
afterEach(() => { if (prev === undefined) delete process.env.AUTH_PRESENCE_DIAG; else process.env.AUTH_PRESENCE_DIAG = prev; });

describe('t/4406 — authPresence', () => {
  it('counts chunked AppServiceAuthSession cookies and reports principal headers as booleans', () => {
    const p = authPresence(req({
      cookie: `AppServiceAuthSession=${SECRET_COOKIE}; AppServiceAuthSession1=more; other=x`,
      'x-ms-client-principal-name': PRINCIPAL,
      'x-ms-client-principal-idp': 'github',
    }));
    expect(p.sessionCookieChunks).toBe(2);
    expect(p.principalHeaders).toEqual({
      'x-ms-client-principal': false,
      'x-ms-client-principal-name': true,
      'x-ms-client-principal-id': false,
      'x-ms-client-principal-idp': true,
    });
  });

  it('cookie present but no principal headers — the "sidecar is dropping it" shape', () => {
    const p = authPresence(req({ cookie: `AppServiceAuthSession=${SECRET_COOKIE}` }));
    expect(p.sessionCookieChunks).toBe(1);
    expect(Object.values(p.principalHeaders).every(v => v === false)).toBe(true);
  });

  it('no cookie header at all — the "not persisting" shape', () => {
    expect(authPresence(req({})).sessionCookieChunks).toBe(0);
  });
});

describe('t/4406 — logAuthPresenceIfEnabled', () => {
  const full = req({ cookie: `AppServiceAuthSession=${SECRET_COOKIE}`, 'x-ms-client-principal-name': PRINCIPAL });

  it('is silent unless AUTH_PRESENCE_DIAG=1', () => {
    delete process.env.AUTH_PRESENCE_DIAG;
    logAuthPresenceIfEnabled(full);
    expect(infoMock).not.toHaveBeenCalled();
  });

  it('when enabled, logs presence booleans and never the cookie value or principal name', () => {
    process.env.AUTH_PRESENCE_DIAG = '1';
    logAuthPresenceIfEnabled(full);
    expect(infoMock).toHaveBeenCalledTimes(1);
    const [fields, msg] = infoMock.mock.calls[0];
    expect(fields).toMatchObject({ sessionCookie: true, sessionCookieChunks: 1, 'x-ms-client-principal-name': true });
    const serialized = JSON.stringify([fields, msg]);
    expect(serialized).not.toContain(SECRET_COOKIE);
    expect(serialized).not.toContain(PRINCIPAL);
  });
});
