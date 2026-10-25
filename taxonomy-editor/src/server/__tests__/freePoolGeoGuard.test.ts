// @vitest-environment node
//
// t/4486 — the free-pool geo guard. Uses a tiny fixture country table (NOT the bundled
// ~3.6MB production DB) covering DE, FR, CH, GB, US and a gap, built the same way the real
// one is (sorted ascending by range start, DB-IP's own "start of the next range implies the
// end of this one" invariant).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { decodeGeoDb, checkFreePoolGeo, normalizeToIpv4, warnIfStale, _resetGeoIndexForTest } from '../ai/freePoolGeoGuard.js';
import { log } from '../logger.js';

function ipv4ToUint32(ip: string): number {
  const [a, b, c, d] = ip.split('.').map(Number);
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

function packFixture(rows: Array<{ start: string; country: string }>): string {
  return rows.map(r => ipv4ToUint32(r.start).toString(16).padStart(8, '0') + r.country).join('');
}

// Ranges (start inclusive, end = next start - 1):
//   0.0.0.0        - 9.255.255.255   -> US
//   10.0.0.0       - 49.255.255.255  -> DE
//   50.0.0.0       - 59.255.255.255  -> FR
//   60.0.0.0       - 69.255.255.255  -> CH
//   70.0.0.0       - 79.255.255.255  -> GB
//   80.0.0.0       - 255.255.255.255 -> US
// (no row covers 80.0.0.0+ as a gap in this fixture — see the "gap" test using a table that
//  omits it entirely)
const FIXTURE_ROWS = [
  { start: '0.0.0.0', country: 'US' },
  { start: '10.0.0.0', country: 'DE' },
  { start: '50.0.0.0', country: 'FR' },
  { start: '60.0.0.0', country: 'CH' },
  { start: '70.0.0.0', country: 'GB' },
  { start: '80.0.0.0', country: 'US' },
];

function fixtureDb() {
  return {
    sourceDate: new Date().toISOString().slice(0, 10), // fresh, no staleness WARN in these tests
    generatedAt: new Date().toISOString(),
    licence: 'CC-BY-4.0',
    attribution: 'test fixture',
    sha256: 'n/a',
    rowCount: FIXTURE_ROWS.length,
    packed: packFixture(FIXTURE_ROWS),
  };
}

describe('decodeGeoDb', () => {
  it('decodes the packed string back into sorted starts + countries', () => {
    const idx = decodeGeoDb(fixtureDb());
    expect(Array.from(idx.starts)).toEqual([0, ipv4ToUint32('10.0.0.0'), ipv4ToUint32('50.0.0.0'), ipv4ToUint32('60.0.0.0'), ipv4ToUint32('70.0.0.0'), ipv4ToUint32('80.0.0.0')]);
    expect(idx.countries).toEqual(['US', 'DE', 'FR', 'CH', 'GB', 'US']);
  });
});

describe('normalizeToIpv4 (t/4486#2 — IPv4-mapped IPv6 + port/zone-id handling)', () => {
  it('passes through a plain dotted-quad', () => {
    expect(normalizeToIpv4('10.1.2.3')).toBe('10.1.2.3');
  });
  it('extracts the v4 address from an IPv4-mapped IPv6 address', () => {
    expect(normalizeToIpv4('::ffff:10.1.2.3')).toBe('10.1.2.3');
  });
  it('strips a zone id before checking for a mapped address', () => {
    expect(normalizeToIpv4('::ffff:10.1.2.3%eth0')).toBe('10.1.2.3');
  });
  it('strips brackets + port', () => {
    expect(normalizeToIpv4('[::ffff:10.1.2.3]:443')).toBe('10.1.2.3');
  });
  it('returns null for a genuine (non-mapped) IPv6 address', () => {
    expect(normalizeToIpv4('2001:db8::1')).toBeNull();
  });
  it('returns null for the "unknown" sentinel getClientIp can return', () => {
    expect(normalizeToIpv4('unknown')).toBeNull();
  });
});

// These tests exercise checkFreePoolGeo's lazy loader, which does a dynamic import() of the
// real bundled data file — so they ARE hitting the production ~3.6MB table, not the fixture
// above (that fixture is for decodeGeoDb's pure decode logic only). That's fine: it's still a
// deterministic, offline, no-network lookup, and these specific IPs are stable test choices.
describe('warnIfStale (t/4486#2 AC — database-age observability)', () => {
  it('WARNs when the source date is more than 60 days old', () => {
    const warnSpy = vi.spyOn(log.api, 'warn').mockImplementation(() => undefined as never);
    const old = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
    warnIfStale(old);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('does not WARN when the source date is fresh', () => {
    const warnSpy = vi.spyOn(log.api, 'warn').mockImplementation(() => undefined as never);
    const fresh = new Date().toISOString().slice(0, 10);
    warnIfStale(fresh);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('checkFreePoolGeo (AC1 — region checks against the real bundled DB)', () => {
  beforeEach(() => { _resetGeoIndexForTest(); });

  it('refuses a German IP (EEA)', async () => {
    const result = await checkFreePoolGeo('5.9.0.1'); // Hetzner DE range
    expect(result.allowed).toBe(false);
    expect(result.country).toBe('DE');
    expect(result.reason).toBe('restricted_region');
  });

  it('refuses a French IP (EEA)', async () => {
    const result = await checkFreePoolGeo('5.135.0.1'); // OVH FR range
    expect(result.allowed).toBe(false);
    expect(result.country).toBe('FR');
  });

  it('refuses a Swiss IP', async () => {
    const result = await checkFreePoolGeo('5.144.0.1'); // CH range
    expect(result.allowed).toBe(false);
    expect(result.country).toBe('CH');
  });

  it('refuses a UK IP', async () => {
    const result = await checkFreePoolGeo('5.148.0.1'); // GB range
    expect(result.allowed).toBe(false);
    expect(result.country).toBe('GB');
  });

  it('allows a US IP', async () => {
    const result = await checkFreePoolGeo('8.8.8.8'); // Google DNS, US
    expect(result.allowed).toBe(true);
    expect(result.country).toBe('US');
  });

  it('refuses a genuine (non-mapped) IPv6 address with its OWN reason, ipv6-unsupported (t/4486#4)', async () => {
    const result = await checkFreePoolGeo('2001:db8::1');
    expect(result.allowed).toBe(false);
    expect(result.country).toBeNull();
    expect(result.reason).toBe('ipv6-unsupported'); // NOT no-public-ip — a different, less alarming signal
  });

  it('refuses the "unknown" sentinel with reason no-public-ip', async () => {
    const result = await checkFreePoolGeo('unknown');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('no-public-ip');
  });

  it('refuses a private IPv4 address with reason no-public-ip (t/4486#4)', async () => {
    const result = await checkFreePoolGeo('10.1.2.3');
    expect(result.allowed).toBe(false);
    expect(result.country).toBeNull();
    expect(result.reason).toBe('no-public-ip');
  });

  it('refuses a loopback IPv4 address with reason no-public-ip', async () => {
    const result = await checkFreePoolGeo('127.0.0.1');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('no-public-ip');
  });

  it('refuses a CGNAT IPv4 address (100.64.0.0/10) with reason no-public-ip', async () => {
    const result = await checkFreePoolGeo('100.70.0.1');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('no-public-ip');
  });

  it('allows a US IP arriving as an IPv4-mapped IPv6 address (common Node dual-stack shape)', async () => {
    const result = await checkFreePoolGeo('::ffff:8.8.8.8');
    expect(result.allowed).toBe(true);
    expect(result.country).toBe('US');
  });
});
