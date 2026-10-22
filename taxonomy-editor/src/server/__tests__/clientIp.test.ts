// @vitest-environment node
//
// t/4410 item 1 — getClientIp() must not let a caller choose its own rate-limit bucket.
// Fixtures are the exact shapes captured from staging (a481a474) via
// /api/diag/forwarded-headers: the socket peer is the Easy Auth sidecar on 127.0.0.1 and
// ACA ingress APPENDS the real client IP as the last X-Forwarded-For entry.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage } from 'http';

const { warnMock } = vi.hoisted(() => ({ warnMock: vi.fn() }));
vi.mock('../logger.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../logger.js')>();
  return { ...orig, log: { ...orig.log, security: { ...orig.log.security, warn: warnMock } } };
});

import { getClientIp, isPrivateOrLoopback, _resetClientIpWarningsForTest } from '../httpKit.js';

// The ingress-appended client address (TEST-NET-1; the staging capture is redacted to this).
const REAL = '192.0.2.10';

function req(peer: string | undefined, headers: Record<string, string | string[]> = {}): IncomingMessage {
  return { headers, socket: { remoteAddress: peer } } as unknown as IncomingMessage;
}

beforeEach(() => { warnMock.mockClear(); _resetClientIpWarningsForTest(); });

describe('t/4410 — getClientIp behind ACA ingress (captured shapes)', () => {
  it('no forged header: the single XFF entry is the client', () => {
    expect(getClientIp(req('127.0.0.1', { 'x-forwarded-for': REAL }))).toBe(REAL);
  });

  it('one forged entry: the forged left value is ignored, the appended right value wins', () => {
    expect(getClientIp(req('127.0.0.1', { 'x-forwarded-for': `203.0.113.7,${REAL}` }))).toBe(REAL);
  });

  it('two forged entries plus forged X-Real-IP and Forwarded: still the appended right value', () => {
    expect(getClientIp(req('127.0.0.1', {
      'x-forwarded-for': `198.51.100.9, 203.0.113.7,${REAL}`,
      'x-real-ip': '192.0.2.5',
      forwarded: 'for=192.0.2.6',
    }))).toBe(REAL);
  });

  it('rotating the forged value does not change the key (the bypass the probe demonstrated)', () => {
    const keys = new Set(['1.1.1.1', '2.2.2.2', '3.3.3.3'].map(f =>
      getClientIp(req('127.0.0.1', { 'x-forwarded-for': `${f},${REAL}` }))));
    expect([...keys]).toEqual([REAL]);
  });

  it('IPv4-mapped loopback peer is treated as the proxy', () => {
    expect(getClientIp(req('::ffff:127.0.0.1', { 'x-forwarded-for': `9.9.9.9,${REAL}` }))).toBe(REAL);
  });

  it('a duplicated header (array form) is joined, and the rightmost entry still wins', () => {
    expect(getClientIp(req('127.0.0.1', { 'x-forwarded-for': ['9.9.9.9', REAL] }))).toBe(REAL);
  });
});

describe('t/4410 — direct (non-proxy) peers', () => {
  it('a public peer is the client itself; its X-Forwarded-For is ignored', () => {
    expect(getClientIp(req('198.51.100.20', { 'x-forwarded-for': '203.0.113.7' }))).toBe('198.51.100.20');
  });

  it('no socket address → "unknown"', () => {
    expect(getClientIp(req(undefined))).toBe('unknown');
  });
});

describe('t/4410 — fallback is logged, not silent', () => {
  it('proxy peer with no X-Forwarded-For keys on the peer and WARNs once per process', () => {
    expect(getClientIp(req('127.0.0.1'))).toBe('127.0.0.1');
    expect(getClientIp(req('127.0.0.1', { 'x-forwarded-for': ' , ' }))).toBe('127.0.0.1');
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(warnMock.mock.calls[0][0]).toMatchObject({ component: 'client-ip', peer: '127.0.0.1' });
  });
});

describe('isPrivateOrLoopback', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '100.64.0.1', '100.127.255.255', '169.254.1.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1',
  ])('%s is private/loopback', a => expect(isPrivateOrLoopback(a)).toBe(true));

  it.each([
    '192.0.2.10', '8.8.8.8', '172.15.0.1', '172.32.0.1', '100.63.0.1', '100.128.0.1', '2001:4860::8888',
  ])('%s is public', a => expect(isPrivateOrLoopback(a)).toBe(false));
});
