// @vitest-environment node
// t/723 / t/724: the anonymous Quick Take limits, in the REAL request context (runWithUser, no mocked predicate):
// the shape check (a positive allow-list), the '_local' refusal, the save and delta checks, and the rule that a
// debate AI call must belong to the caller's own saved Quick Take.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ServerResponse } from 'http';

vi.mock('../logger.js', () => {
  const l = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
  return { log: { server: l(), api: l(), ai: l(), security: l() }, getRequestId: () => 'r' };
});
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));

import { runWithUser } from '../security/userContext.js';
import {
  anonDebateShapeViolation, anonDebateMaxDebaterEntries, ANON_DEBATE_MAX_TOTAL_ENTRIES,
  refuseAnonDebateSave, refuseAnonDebatePatch, refuseAnonDebateCall, invalidateAnonDebateShape,
  _resetAnonDebateShapeCacheForTest, stripAnonDiagnostics,
} from '../routes/anonDebateLimits.js';
import type { DebateDelta } from '../../../../lib/debate/types/session.js';

type Res = ServerResponse & { status: number; body: string; headers: Record<string, string> };
function fakeRes(): Res {
  const r = { status: 200, body: '', headers: {} as Record<string, string>, headersSent: false, writableEnded: false,
    writeHead(s: number, h?: Record<string, string>) { r.status = s; r.headers = h ?? {}; return r; },
    end(b?: string) { r.body = b ?? ''; r.writableEnded = true; } };
  return r as unknown as Res;
}

const DEBATERS = ['accelerationist', 'safetyist', 'skeptic'];
const entry = (type: string, speaker: string) => ({ id: `${type}-${Math.random()}`, type, speaker, content: 'x', taxonomy_refs: [] });
function quick(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'd1', protocol_id: 'structured', active_povers: DEBATERS, user_is_pover: false, _saveVersion: 1,
    adaptive_staging: { enabled: true, pacing: 'moderate', step_mode: false, phase_bounds_override: { maxConfrontationRounds: 1, maxArgumentationRounds: 1, maxConcludingRounds: 1 } },
    transcript: [...DEBATERS.map(d => entry('opening', d)), entry('system', 'system'), entry('intervention', 'moderator')],
    ...over,
  };
}
const rounds = (c: number, a: number, k: number, step = false) => ({ adaptive_staging: { enabled: true, step_mode: step, phase_bounds_override: { maxConfrontationRounds: c, maxArgumentationRounds: a, maxConcludingRounds: k } } });
const turns = (n: number, type = 'statement') => Array.from({ length: n }, (_, i) => entry(type, DEBATERS[i % 3]));

// The hosted anonymous visitor, as server.ts builds it: positively anonymous, own 'anon-<uuid>' storage key.
const ANON = { userId: 'anonymous', storageUserId: 'anon-0f8fad5b-d9cb-469f-a165-8c7c0e2c1a11', isAnonymous: true, anonymousSessionId: '0f8fad5b-d9cb-469f-a165-8c7c0e2c1a11' };
const ANON_B = { ...ANON, storageUserId: 'anon-7c9e6679-7425-40de-944b-e07fc1f90ae7', anonymousSessionId: '7c9e6679-7425-40de-944b-e07fc1f90ae7' };
const UNKEYED = { userId: 'anonymous', storageUserId: '_local', isAnonymous: true };
const SIGNED_IN = { userId: 'github:1', storageUserId: 'github-1', isAnonymous: false };
const as = <T>(ctx: object, fn: () => T): T => runWithUser(ctx as never, fn);

const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const n of ['AUTH_DISABLED', 'AUTH_OPTIONAL']) { savedEnv[n] = process.env[n]; delete process.env[n]; }
  process.env.AUTH_OPTIONAL = '1'; // hosted: sign-in optional
  _resetAnonDebateShapeCacheForTest();
});
afterEach(() => { for (const [n, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[n]; else process.env[n] = v; } });

describe('t/724 check A: the Quick Take shape (pure)', () => {
  it('accepts a Quick Take, with two debaters too, and with the visitor in a seat', () => {
    expect(anonDebateShapeViolation(quick())).toBeNull();
    expect(anonDebateShapeViolation(quick({ active_povers: ['safetyist', 'skeptic'], transcript: [entry('opening', 'safetyist'), entry('opening', 'skeptic')] }))).toBeNull();
    // An AI speaker who has no seat in this debate is an unknown speaker.
    expect(anonDebateShapeViolation(quick({ active_povers: ['safetyist', 'skeptic'] }))?.code).toBe('anon_debate_kind');
    expect(anonDebateShapeViolation(quick({ active_povers: ['user', 'safetyist', 'skeptic'], user_is_pover: true, transcript: [entry('opening', 'user')] }))).toBeNull();
  });

  it.each([
    ['protocol deliberation', { protocol_id: 'deliberation' }],
    ['protocol socratic', { protocol_id: 'socratic' }],
    ['a missing protocol', { protocol_id: undefined }],
    ['Deep dive rounds 1/3/1', rounds(1, 3, 1)],
    ['step mode', rounds(1, 1, 1, true)],
    ['missing rounds', { adaptive_staging: { enabled: true } }],
    ['no adaptive_staging at all', { adaptive_staging: undefined }],
    ['a fractional round', rounds(1, 0.5, 1)],
    ['an unknown debater', { active_povers: ['accelerationist', 'centrist'] }],
    ['a repeated debater', { active_povers: ['skeptic', 'skeptic'] }],
    ['no AI debater', { active_povers: ['user'] }],
    ['an unknown entry type', { transcript: [entry('monologue', 'skeptic')] }],
    ['an entry with no type', { transcript: [{ speaker: 'skeptic', content: 'x' }] }],
    ['an unknown speaker', { transcript: [entry('statement', 'narrator')] }],
    ['a transcript that is not an array', { transcript: {} }],
  ])('refuses %s as anon_debate_kind', (_name, over) => {
    expect(anonDebateShapeViolation(quick(over as Record<string, unknown>))?.code).toBe('anon_debate_kind');
  });

  // The limit is the observed maximum of a finished Quick Take per debater count (13, 10; 7 extrapolated).
  it.each([[3, 13], [2, 10], [1, 7]])('%i debaters: %i debater entries pass and one more is refused', (n, max) => {
    const seats = DEBATERS.slice(0, n);
    const fill = (count: number) => Array.from({ length: count }, (_, i) => entry(i < n ? 'opening' : 'statement', seats[i % n]));
    expect(anonDebateMaxDebaterEntries(n)).toBe(max);
    expect(anonDebateShapeViolation(quick({ active_povers: seats, transcript: fill(max) }))).toBeNull();
    expect(anonDebateShapeViolation(quick({ active_povers: seats, transcript: fill(max + 1) }))).toMatchObject({ code: 'anon_debate_turns', limit: max });
  });

  it('counts every debater entry as a turn, whatever its type, so a mislabelled extra turn is refused', () => {
    const max = anonDebateMaxDebaterEntries(3);
    expect(anonDebateShapeViolation(quick({ transcript: [...turns(max), entry('fact-check', 'skeptic')] }))).toMatchObject({ code: 'anon_debate_turns', limit: max });
    // The same entry from the system is not a debater turn.
    expect(anonDebateShapeViolation(quick({ transcript: [...turns(max), entry('fact-check', 'system')] }))).toBeNull();
  });

  it('caps total entries', () => {
    const filler = Array.from({ length: ANON_DEBATE_MAX_TOTAL_ENTRIES + 1 }, () => entry('system', 'system'));
    expect(anonDebateShapeViolation(quick({ transcript: filler }))).toMatchObject({ code: 'anon_debate_turns', limit: ANON_DEBATE_MAX_TOTAL_ENTRIES });
  });
});

describe('t/724: saves (PUT and PATCH) in the real anonymous request context', () => {
  it('PUT: a Quick Take passes; a Deep dive is 403 anon_limit with the sign-in shape', () => {
    expect(as(ANON, () => refuseAnonDebateSave(fakeRes(), quick()))).toBe(false);
    const res = fakeRes();
    expect(as(ANON, () => refuseAnonDebateSave(res, quick({ protocol_id: 'deliberation', ...rounds(1, 3, 1) })))).toBe(true);
    expect(res.status).toBe(403);
    expect(res.headers['X-Auth-Reason']).toBe('anon_limit');
    expect(JSON.parse(res.body)).toMatchObject({ reason: 'anon_limit', code: 'anon_debate_kind', signInRequired: true, retryable: false });
  });

  it('B1: the shared _local arm is 401 no_session for PUT, PATCH and an AI call, before any read', async () => {
    const load = vi.fn(async () => quick());
    const put = fakeRes();
    expect(as(UNKEYED, () => refuseAnonDebateSave(put, quick()))).toBe(true);
    const patch = fakeRes();
    expect(await as(UNKEYED, () => refuseAnonDebatePatch(patch, { debateId: 'd1', baseVersion: 1 } as DebateDelta, load))).toBe(true);
    const call = fakeRes();
    expect(await as(UNKEYED, () => refuseAnonDebateCall(call, 'd1', load))).toBe(true);
    for (const r of [put, patch, call]) { expect(r.status).toBe(401); expect(JSON.parse(r.body).reason).toBe('no_session'); }
    expect(load).not.toHaveBeenCalled();
  });

  it('signed-in users and the desktop (auth disabled) are never checked', async () => {
    const deep = quick({ protocol_id: 'socratic' });
    const load = vi.fn(async () => deep);
    expect(as(SIGNED_IN, () => refuseAnonDebateSave(fakeRes(), deep))).toBe(false);
    expect(await as(SIGNED_IN, () => refuseAnonDebateCall(fakeRes(), 'd1', load))).toBe(false);
    process.env.AUTH_DISABLED = '1';
    expect(as(UNKEYED, () => refuseAnonDebateSave(fakeRes(), deep))).toBe(false);
    expect(await as(UNKEYED, () => refuseAnonDebateCall(fakeRes(), 'd1', load))).toBe(false);
    expect(load).not.toHaveBeenCalled();
  });

  const delta = (over: Partial<DebateDelta>): DebateDelta => ({
    debateId: 'd1', baseVersion: 1, newTranscriptEntries: [], changedNodes: [], changedEdges: [], newMutations: [], ...over,
  } as DebateDelta);

  it('PATCH: a turn within the limit passes; the turn that makes it 14 is refused on the merged session', async () => {
    const stored = quick({ transcript: turns(12) });
    const load = async () => stored;
    expect(await as(ANON, () => refuseAnonDebatePatch(fakeRes(), delta({ newTranscriptEntries: turns(1) as never }), load))).toBe(false);
    const res = fakeRes();
    expect(await as(ANON, () => refuseAnonDebatePatch(res, delta({ newTranscriptEntries: turns(2) as never }), load))).toBe(true);
    expect(JSON.parse(res.body)).toMatchObject({ code: 'anon_debate_turns', limit: 13 });
  });

  it('PATCH: a delta that turns a Quick Take into a Deep dive through changedFields is refused', async () => {
    const res = fakeRes();
    const d = delta({ changedFields: { protocol_id: 'deliberation' } as never });
    expect(await as(ANON, () => refuseAnonDebatePatch(res, d, async () => quick()))).toBe(true);
    expect(JSON.parse(res.body).code).toBe('anon_debate_kind');
  });

  it('PATCH on an existing Deep dive: a title-only delta passes, any other change is refused', async () => {
    const deep = quick({ protocol_id: 'deliberation', ...rounds(1, 3, 1) });
    const load = async () => deep;
    expect(await as(ANON, () => refuseAnonDebatePatch(fakeRes(), delta({ meta: { title: 'Renamed' } }), load))).toBe(false);
    expect(await as(ANON, () => refuseAnonDebatePatch(fakeRes(), delta({ meta: { title: 'Renamed', phase: 'closed' } as never }), load))).toBe(true);
    expect(await as(ANON, () => refuseAnonDebatePatch(fakeRes(), delta({ meta: { title: 'Renamed' }, changedFields: { protocol_id: 'structured' } as never }), load))).toBe(true);
    expect(await as(ANON, () => refuseAnonDebatePatch(fakeRes(), delta({ newTranscriptEntries: turns(1) as never }), load))).toBe(true);
  });

  it('PATCH: a missing session or a stale base version is left to the storage layer (409 there)', async () => {
    expect(await as(ANON, () => refuseAnonDebatePatch(fakeRes(), delta({}), async () => null))).toBe(false);
    expect(await as(ANON, () => refuseAnonDebatePatch(fakeRes(), delta({ baseVersion: 7 }), async () => quick({ protocol_id: 'socratic' })))).toBe(false);
  });
});

describe('t/724 check B: a debate AI call belongs to the caller\'s own saved Quick Take', () => {
  // A store keyed by storage id, read through the request context like fileIO.loadDebateSession.
  const store = new Map<string, Map<string, unknown>>();
  const loads: string[] = [];
  let currentKey = '';
  const load = async (id: string): Promise<unknown> => {
    loads.push(`${currentKey}:${id}`);
    const own = store.get(currentKey)?.get(id);
    if (own === undefined) throw new Error(`Debate session not found: ${id}`);
    return own;
  };
  const call = async (ctx: { storageUserId: string }, id: string | undefined, now?: number): Promise<Res> => {
    currentKey = ctx.storageUserId;
    const res = fakeRes();
    await as(ctx, () => refuseAnonDebateCall(res, id, load, now));
    return res;
  };
  beforeEach(() => { store.clear(); loads.length = 0; store.set(ANON.storageUserId, new Map([['d1', quick()], ['deep', quick({ protocol_id: 'deliberation' })]])); });

  it('passes for the caller\'s own saved Quick Take, and for a call with no debate id', async () => {
    expect((await call(ANON, 'd1')).status).toBe(200);
    expect((await call(ANON, undefined)).status).toBe(200);
  });

  it('refuses a missing id, another visitor\'s id and an own Deep dive; the first two are indistinguishable', async () => {
    const missing = await call(ANON, 'nope');
    const others = await call(ANON_B, 'd1'); // B asks for A's debate id: looked up under B's own key only
    expect(missing.status).toBe(403);
    expect(JSON.parse(missing.body).code).toBe('anon_debate_unsaved');
    expect(others.body).toBe(missing.body);
    expect(others.headers).toEqual(missing.headers);
    expect(loads).toContain(`${ANON_B.storageUserId}:d1`);
    expect(loads).not.toContain(`${ANON.storageUserId}:d1`);
    expect(JSON.parse((await call(ANON, 'deep')).body).code).toBe('anon_debate_kind');
  });

  it('caches per caller: a pass for 60 s at most, a refusal for 2 s, and an invalidation drops it', async () => {
    const t0 = 1_000_000;
    await call(ANON, 'd1', t0);
    await call(ANON, 'd1', t0 + 59_000);
    expect(loads.filter(l => l === `${ANON.storageUserId}:d1`)).toHaveLength(1);
    await call(ANON, 'd1', t0 + 61_000);
    expect(loads.filter(l => l === `${ANON.storageUserId}:d1`)).toHaveLength(2);
    // A's pass is never B's pass.
    expect((await call(ANON_B, 'd1', t0 + 61_500)).status).toBe(403);
    // A refusal is re-read after 2 s, so the first call after the first save is not refused for long.
    expect((await call(ANON, 'new', t0)).status).toBe(403);
    store.get(ANON.storageUserId)!.set('new', quick());
    expect((await call(ANON, 'new', t0 + 1_000)).status).toBe(403);
    expect((await call(ANON, 'new', t0 + 2_500)).status).toBe(200);
    // The caller's own save invalidates at once.
    store.get(ANON.storageUserId)!.set('d1', quick({ protocol_id: 'socratic' }));
    currentKey = ANON.storageUserId;
    as(ANON, () => invalidateAnonDebateShape('d1'));
    expect((await call(ANON, 'd1', t0 + 62_000)).status).toBe(403);
  });
});

describe('Security p/93#142: moderator mode and dialectical diagnostics', () => {
  it.each(['talmudic', 'socratic', 'anything'])('check A refuses protocol structured with moderator_mode %s', (mode) => {
    expect(anonDebateShapeViolation(quick({ moderator_mode: mode }))).toMatchObject({ code: 'anon_debate_kind', detail: 'moderator_mode' });
  });
  it('accepts moderator_mode absent or standard', () => {
    expect(anonDebateShapeViolation(quick({ moderator_mode: 'standard' }))).toBeNull();
    expect(anonDebateShapeViolation(quick())).toBeNull();
  });
  it('strips dialectical_diagnostics from a PUT, a PATCH meta and a PATCH changedFields', () => {
    const dd = [{ round: 1, response: { card_id: 'c', limiting_difference: 'PROSE' } }];
    const put = { id: 'd', dialectical_diagnostics: dd };
    expect(as(ANON, () => stripAnonDiagnostics(put, 'PUT /api/debates'))).toBe(Buffer.byteLength(JSON.stringify(dd)));
    expect(put).toEqual({ id: 'd' });
    const d = { debateId: 'd', baseVersion: 1, meta: { dialectical_diagnostics: dd }, changedFields: { dialectical_diagnostics: dd } };
    as(ANON, () => stripAnonDiagnostics(d, 'PATCH /api/debates/:id'));
    expect(d).toEqual({ debateId: 'd', baseVersion: 1, meta: {}, changedFields: {} });
  });
});

describe('TL p/16#477: an anonymous save keeps no turn_validations stage_diagnostics', () => {
  const sd = { prompt: 'SECRET-PROMPT', taxonomy_context: 'SECRET-CONTEXT' };
  const trails = () => ({ e1: { attempts: [{ attempt: 1, raw_response: 'kept', stage_diagnostics: sd }, { attempt: 2, stage_diagnostics: sd }], final: { outcome: 'pass' } }, e2: { attempts: [] , final: {} } });
  it('drops stage_diagnostics from every attempt, keeping the rest of the trail, in a PUT, PATCH meta and PATCH changedFields', () => {
    const put = { id: 'd', turn_validations: trails() };
    const bytes = as(ANON, () => stripAnonDiagnostics(put, 'PUT /api/debates'));
    expect(bytes).toBe(2 * Buffer.byteLength(JSON.stringify(sd)));
    expect(put.turn_validations.e1.attempts).toEqual([{ attempt: 1, raw_response: 'kept' }, { attempt: 2 }]);
    expect(put.turn_validations.e1.final).toEqual({ outcome: 'pass' });
    const d = { debateId: 'd', baseVersion: 1, meta: { turn_validations: trails() }, changedFields: { turn_validations: trails() } };
    as(ANON, () => stripAnonDiagnostics(d, 'PATCH /api/debates/:id'));
    expect(JSON.stringify(d)).not.toContain('SECRET');
  });
  it('is a no-op for a signed-in save and for malformed trails (no throw)', () => {
    const put = { id: 'd', turn_validations: trails() };
    expect(as(SIGNED_IN, () => stripAnonDiagnostics(put, 'PUT /api/debates'))).toBe(0);
    expect(JSON.stringify(put)).toContain('SECRET');
    expect(() => as(ANON, () => stripAnonDiagnostics({ turn_validations: { a: null, b: { attempts: 'x' }, c: 5 } }, 'PUT /api/debates'))).not.toThrow();
  });
});

describe('TL p/16#466: an anonymous save keeps no diagnostics', () => {
  const diag = { entries: { e1: { prompt: 'SECRET-PROMPT', raw_response: 'SECRET-RESPONSE' } }, enabled: true };
  it('strips diagnostics from a PUT body, a PATCH meta and a PATCH changedFields, and reports the bytes', () => {
    const put = { id: 'd', diagnostics: diag, topic: { final: 'x' } };
    const bytes = as(ANON, () => stripAnonDiagnostics(put, 'PUT /api/debates'));
    expect(bytes).toBe(Buffer.byteLength(JSON.stringify(diag)));
    expect(put).toEqual({ id: 'd', topic: { final: 'x' } });
    const d = { debateId: 'd', baseVersion: 1, meta: { title: 't', diagnostics: diag }, changedFields: { diagnostics: diag, convergence_tracker: { a: 1 } } };
    as(ANON, () => stripAnonDiagnostics(d, 'PATCH /api/debates/:id'));
    expect(d).toEqual({ debateId: 'd', baseVersion: 1, meta: { title: 't' }, changedFields: { convergence_tracker: { a: 1 } } });
  });
  it('leaves a signed-in save and an unrelated field untouched, and does nothing when there is no diagnostics', () => {
    const put = { id: 'd', diagnostics: diag };
    expect(as(SIGNED_IN, () => stripAnonDiagnostics(put, 'PUT /api/debates'))).toBe(0);
    expect(put.diagnostics).toBe(diag);
    const clean = { id: 'd', adaptive_staging_diagnostics: { x: 1 } };
    expect(as(ANON, () => stripAnonDiagnostics(clean, 'PUT /api/debates'))).toBe(0);
    expect(clean).toEqual({ id: 'd', adaptive_staging_diagnostics: { x: 1 } });
  });
  it('never logs the content (DEBUG line carries the byte count only)', async () => {
    const { log } = await import('../logger.js');
    const spy = vi.spyOn(log.api, 'debug');
    as(ANON, () => stripAnonDiagnostics({ id: 'd', diagnostics: diag }, 'PUT /api/debates'));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(spy.mock.calls)).not.toContain('SECRET');
    expect(spy.mock.calls[0][0]).toMatchObject({ stripped_bytes: expect.any(Number) });
    spy.mockRestore();
  });
});
