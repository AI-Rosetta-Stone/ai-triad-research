// @vitest-environment node
// t/500 (t/666): the anonymous op-ed byte cap. Admission refuses a run whose worst-case stored size can't fit the cap
// (so a finished, paid run is never discarded), and a saved set over two thirds of the cap logs a WARN with its size and
// voice count only (TL t/500#61).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ServerResponse } from 'http';

const h = vi.hoisted(() => ({ warn: vi.fn(), anon: true, cap: 106_496 }));
vi.mock('../logger.js', () => ({ log: { server: { info: vi.fn(), warn: h.warn, error: vi.fn(), debug: vi.fn() } }, getRequestId: () => 'r' }));
vi.mock('../security/userContext.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../security/userContext.js')>()),
  isAnonymousUser: () => h.anon,
}));
vi.mock('../runtimeConfig.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../runtimeConfig.js')>();
  return { ...real, getConfig: () => { const c = real.getConfig(); return { ...c, sessions: { ...c.sessions, anonOpEdByteCap: h.cap } }; } };
});

import { refuseAnonOpEdShape, warnIfNearAnonByteCap, anonOpEdWorstCaseBytes } from '../routes/opedAnonLimits.js';

function fakeRes(): ServerResponse & { status: number; body: string } {
  const r = { status: 200, body: '', headersSent: false, writableEnded: false, setHeader() {}, getHeader() { return undefined; },
    writeHead(s: number) { r.status = s; return r; }, end(b?: string) { r.body = b ?? ''; r.writableEnded = true; } };
  return r as unknown as ServerResponse & { status: number; body: string };
}

beforeEach(() => { h.warn.mockClear(); h.anon = true; h.cap = 106_496; });

describe('t/500: anonymous op-ed byte cap', () => {
  it('at the defaults (3 voices x 1,500 words) the worst case fits the 106,496 B cap', () => {
    expect(anonOpEdWorstCaseBytes(3, 1500)).toBeLessThanOrEqual(106_496);
    expect(refuseAnonOpEdShape(fakeRes(), 3, 1500, undefined)).toBe(false);
  });

  it('a lower cap refuses at admission (400) a run whose worst case cannot fit', () => {
    h.cap = 20_000;
    const res = fakeRes();
    expect(refuseAnonOpEdShape(res, 3, 1500, undefined)).toBe(true);
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ code: 'anon_oped_too_large' });
  });

  // Rosetta Stone p/74#36: the client maps on a stable code, never on the sentence.
  it('the voice and word refusals carry a stable code and the limit', () => {
    const voices = fakeRes();
    expect(refuseAnonOpEdShape(voices, 4, 800, undefined)).toBe(true);
    expect(voices.status).toBe(400);
    expect(JSON.parse(voices.body)).toMatchObject({ code: 'anon_oped_too_many_voices', limit: 3 });
    const words = fakeRes();
    expect(refuseAnonOpEdShape(words, 1, 1501, undefined)).toBe(true);
    expect(words.status).toBe(400);
    expect(JSON.parse(words.body)).toMatchObject({ code: 'anon_oped_too_many_words', limit: 1500 });
  });

  it('the default outlet with no word count is not refused (its target is the 1,500 cap, not above it)', () => {
    expect(refuseAnonOpEdShape(fakeRes(), 1, 0, undefined)).toBe(false);
    expect(refuseAnonOpEdShape(fakeRes(), 3, 0, 'TechPolicyPress')).toBe(false);
  });

  it('a saved set over two thirds of the cap logs a WARN with size and voice count, no content', () => {
    const set = { opeds: [{ body: 'SECRET-BODY ' + 'x'.repeat(80_000) }, {}] };
    warnIfNearAnonByteCap(set);
    expect(h.warn).toHaveBeenCalledTimes(1);
    const [fields] = h.warn.mock.calls[0] as [Record<string, unknown>];
    expect(fields).toMatchObject({ voices: 2, cap: 106_496 });
    expect(fields.bytes as number).toBeGreaterThan(70_997);
    expect(JSON.stringify(h.warn.mock.calls)).not.toContain('SECRET-BODY');
  });

  it('a set under two thirds logs nothing; a signed-in set is never checked', () => {
    warnIfNearAnonByteCap({ opeds: [{ body: 'short' }] });
    h.anon = false;
    warnIfNearAnonByteCap({ opeds: [{ body: 'x'.repeat(90_000) }] });
    expect(h.warn).not.toHaveBeenCalled();
  });
});
