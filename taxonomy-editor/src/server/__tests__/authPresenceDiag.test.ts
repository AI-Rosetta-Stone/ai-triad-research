// @vitest-environment node
//
// t/4406 (TEMPORARY) — presence-only auth diagnostic on /api/auth/me. The safety property under
// test is that no cookie VALUE and no principal NAME ever reaches the log line.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage } from 'http';

const { infoMock, warnMock } = vi.hoisted(() => ({ infoMock: vi.fn(), warnMock: vi.fn() }));
vi.mock('../logger.js', () => ({ log: { server: { info: infoMock, warn: warnMock, error: vi.fn() } } }));

import {
  authPresence, logAuthPresenceIfEnabled, isAuthPresenceDiagEnabled, AUTH_PRESENCE_DIAG_EXPIRES_AT,
} from '../authPresenceDiag.js';

// Pinned clocks so these tests don't change meaning once the real date passes the expiry.
const BEFORE = AUTH_PRESENCE_DIAG_EXPIRES_AT - 24 * 3600_000;
const AFTER = AUTH_PRESENCE_DIAG_EXPIRES_AT + 1;

const SECRET_COOKIE = 'SECRET-SESSION-VALUE-xyz';
const PRINCIPAL = 'someone@example.com';

function req(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

const prev = { diag: process.env.AUTH_PRESENCE_DIAG, auth: process.env.WEBSITE_AUTH_ENABLED };
beforeEach(() => {
  infoMock.mockClear(); warnMock.mockClear();
  delete process.env.AUTH_PRESENCE_DIAG; delete process.env.WEBSITE_AUTH_ENABLED;
});
afterEach(() => {
  if (prev.diag === undefined) delete process.env.AUTH_PRESENCE_DIAG; else process.env.AUTH_PRESENCE_DIAG = prev.diag;
  if (prev.auth === undefined) delete process.env.WEBSITE_AUTH_ENABLED; else process.env.WEBSITE_AUTH_ENABLED = prev.auth;
});

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

describe('t/4406 — isAuthPresenceDiagEnabled (TL decision (a): on by default while hosted)', () => {
  it('on when hosted (WEBSITE_AUTH_ENABLED true/True) with no flag', () => {
    expect(isAuthPresenceDiagEnabled({ WEBSITE_AUTH_ENABLED: 'true' }, BEFORE)).toBe(true);
    expect(isAuthPresenceDiagEnabled({ WEBSITE_AUTH_ENABLED: 'True' }, BEFORE)).toBe(true);
  });
  it('off when not hosted and no flag (local/Electron)', () => {
    expect(isAuthPresenceDiagEnabled({}, BEFORE)).toBe(false);
  });
  it('AUTH_PRESENCE_DIAG=0 is a kill switch even when hosted', () => {
    expect(isAuthPresenceDiagEnabled({ WEBSITE_AUTH_ENABLED: 'true', AUTH_PRESENCE_DIAG: '0' }, BEFORE)).toBe(false);
  });
  it('AUTH_PRESENCE_DIAG=1 forces it on when not hosted', () => {
    expect(isAuthPresenceDiagEnabled({ AUTH_PRESENCE_DIAG: '1' }, BEFORE)).toBe(true);
  });
  it('past the hard-coded expiry it is off no matter what — even forced on and hosted', () => {
    expect(isAuthPresenceDiagEnabled({ WEBSITE_AUTH_ENABLED: 'true', AUTH_PRESENCE_DIAG: '1' }, AFTER)).toBe(false);
  });
});

describe('t/4406 — logAuthPresenceIfEnabled', () => {
  const full = req({ cookie: `AppServiceAuthSession=${SECRET_COOKIE}`, 'x-ms-client-principal-name': PRINCIPAL });

  it('is silent when not enabled', () => {
    logAuthPresenceIfEnabled(full, BEFORE);
    expect(infoMock).not.toHaveBeenCalled();
  });

  it('after expiry: logs nothing, and WARNs exactly once across calls', () => {
    process.env.WEBSITE_AUTH_ENABLED = 'true';
    logAuthPresenceIfEnabled(full, AFTER);
    logAuthPresenceIfEnabled(full, AFTER);
    expect(infoMock).not.toHaveBeenCalled();
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(warnMock.mock.calls[0][1]).toContain('t/4409');
  });

  it('when enabled (hosted), logs presence booleans and never the cookie value or principal name', () => {
    process.env.WEBSITE_AUTH_ENABLED = 'true';
    logAuthPresenceIfEnabled(full, BEFORE);
    expect(infoMock).toHaveBeenCalledTimes(1);
    const [fields, msg] = infoMock.mock.calls[0];
    expect(fields).toMatchObject({ sessionCookie: true, sessionCookieChunks: 1, 'x-ms-client-principal-name': true });
    const serialized = JSON.stringify([fields, msg]);
    expect(serialized).not.toContain(SECRET_COOKIE);
    expect(serialized).not.toContain(PRINCIPAL);
  });
});
