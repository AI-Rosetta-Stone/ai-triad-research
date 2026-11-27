// @vitest-environment node

/**
 * t/802 (t/724 check C): the anonymous debate counter. Runs on InMemoryJsonDocStore, which shares
 * BlobJsonDocStore's compare-and-swap loop, so the concurrency below exercises the real retry logic.
 * "Two instances" are two stores over one shared backing map via a shared InMemory store object.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  admitAnonDebateCall, setAnonDebateCounterStore, ANON_DEBATE_COUNTER_INVALID_INPUT, ANON_DEBATE_COUNTER_RECORD_INVALID,
} from '../storage/anonDebateCounter.js';
import { InMemoryJsonDocStore } from '../storage/jsonDocStore.js';

const USER = 'anon-123e4567-e89b-12d3-a456-426614174000';
const OTHER = 'anon-223e4567-e89b-12d3-a456-426614174000';
const LIMITS = { perDebateCalls: 200, debatesPerDay: 2 };
const DAY1 = new Date('2026-11-27T10:00:00Z');
const DAY2 = new Date('2026-11-28T00:00:01Z');
const NAME1 = `anon-debate-counter/2026-11-27/${USER}.json`;

let store: InMemoryJsonDocStore;
beforeEach(() => {
  store = new InMemoryJsonDocStore({ prefix: 'anon-debate-counter', maxCasRetries: 25 });
  setAnonDebateCounterStore(store);
});
afterAll(() => setAnonDebateCounterStore(null));

/** Seed the day's record directly. */
async function seed(debates: Record<string, number>, user = USER, name?: string): Promise<void> {
  store._setRawForTest(name ?? `anon-debate-counter/2026-11-27/${user}.json`, JSON.stringify({ debates }));
}

describe('admitAnonDebateCall (t/802)', () => {
  it('first call admits with debateCalls 1 and debatesToday 1; later calls count up', async () => {
    expect(await admitAnonDebateCall(USER, 'd1', LIMITS, DAY1)).toEqual({ admitted: true, debateCalls: 1, debatesToday: 1 });
    expect(await admitAnonDebateCall(USER, 'd1', LIMITS, DAY1)).toEqual({ admitted: true, debateCalls: 2, debatesToday: 1 });
    expect(await admitAnonDebateCall(USER, 'd2', LIMITS, DAY1)).toEqual({ admitted: true, debateCalls: 1, debatesToday: 2 });
  });

  it('the ceiling: calls up to exactly the limit are admitted, the next is refused budget and not written', async () => {
    await seed({ d1: 198 });
    expect(await admitAnonDebateCall(USER, 'd1', LIMITS, DAY1)).toMatchObject({ admitted: true, debateCalls: 199 });
    expect(await admitAnonDebateCall(USER, 'd1', LIMITS, DAY1)).toMatchObject({ admitted: true, debateCalls: 200 });
    expect(await admitAnonDebateCall(USER, 'd1', LIMITS, DAY1)).toEqual({ admitted: false, reason: 'budget', limit: 200 });
    expect((await store.read<{ debates: Record<string, number> }>(NAME1))!.doc.debates.d1).toBe(200);
  });

  it('50 parallel calls at count 199 admit exactly one; the rest are refused budget (none throw)', async () => {
    await seed({ d1: 199 });
    const results = await Promise.all(Array.from({ length: 50 }, () => admitAnonDebateCall(USER, 'd1', LIMITS, DAY1)));
    expect(results.filter(r => r.admitted)).toHaveLength(1);
    expect(results.filter(r => !r.admitted && r.reason === 'budget')).toHaveLength(49);
    expect((await store.read<{ debates: Record<string, number> }>(NAME1))!.doc.debates.d1).toBe(200);
  });

  it('parallel calls from zero never lose a count', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => admitAnonDebateCall(USER, 'd1', LIMITS, DAY1)));
    expect(results.every(r => r.admitted)).toBe(true);
    expect(new Set(results.map(r => (r as { debateCalls: number }).debateCalls)).size).toBe(20); // each admission got its own count
    expect((await store.read<{ debates: Record<string, number> }>(NAME1))!.doc.debates.d1).toBe(20);
  });

  it('parallel NEW debates never exceed debatesPerDay', async () => {
    const results = await Promise.all(['a', 'b', 'c', 'd', 'e'].map(id => admitAnonDebateCall(USER, id, LIMITS, DAY1)));
    expect(results.filter(r => r.admitted)).toHaveLength(2);
    expect(results.filter(r => !r.admitted && r.reason === 'daily')).toHaveLength(3);
  });

  it('the (debatesPerDay+1)th id is refused daily, and the first id is still admitted', async () => {
    await admitAnonDebateCall(USER, 'd1', LIMITS, DAY1);
    await admitAnonDebateCall(USER, 'd2', LIMITS, DAY1);
    expect(await admitAnonDebateCall(USER, 'd3', LIMITS, DAY1)).toEqual({ admitted: false, reason: 'daily', limit: 2 });
    expect(await admitAnonDebateCall(USER, 'd1', LIMITS, DAY1)).toMatchObject({ admitted: true, debateCalls: 2 });
    expect((await store.read<{ debates: Record<string, number> }>(NAME1))!.doc.debates).not.toHaveProperty('d3');
  });

  it('a refused first call creates no record', async () => {
    const zero = { perDebateCalls: 5, debatesPerDay: 1 };
    await admitAnonDebateCall(USER, 'd1', zero, DAY1);
    const other = await admitAnonDebateCall(OTHER, 'x', { perDebateCalls: 5, debatesPerDay: 1 }, DAY1);
    expect(other.admitted).toBe(true);
    await admitAnonDebateCall(USER, 'd2', zero, DAY1); // refused daily
    expect(store._sizeForTest()).toBe(2); // USER and OTHER only
  });

  it('a new UTC day starts a fresh record', async () => {
    await admitAnonDebateCall(USER, 'd1', LIMITS, DAY1);
    await admitAnonDebateCall(USER, 'd2', LIMITS, DAY1);
    expect(await admitAnonDebateCall(USER, 'd3', LIMITS, DAY1)).toMatchObject({ admitted: false });
    expect(await admitAnonDebateCall(USER, 'd1', LIMITS, DAY2)).toEqual({ admitted: true, debateCalls: 1, debatesToday: 1 }); // counts as a new id on the new day
    expect(store._sizeForTest()).toBe(2);
  });

  it('visitors are independent', async () => {
    await admitAnonDebateCall(USER, 'd1', LIMITS, DAY1);
    await admitAnonDebateCall(USER, 'd2', LIMITS, DAY1);
    expect(await admitAnonDebateCall(OTHER, 'd1', LIMITS, DAY1)).toEqual({ admitted: true, debateCalls: 1, debatesToday: 1 });
  });

  it('delete-and-recreate keeps the count: same ids, no session involved, the count carries on', async () => {
    await admitAnonDebateCall(USER, 'd1', { perDebateCalls: 2, debatesPerDay: 2 }, DAY1);
    await admitAnonDebateCall(USER, 'd1', { perDebateCalls: 2, debatesPerDay: 2 }, DAY1);
    // The saved debate is deleted and recreated under the same id: the counter has no hook to reset.
    expect(await admitAnonDebateCall(USER, 'd1', { perDebateCalls: 2, debatesPerDay: 2 }, DAY1)).toMatchObject({ admitted: false, reason: 'budget' });
  });

  it('two instances sharing one backing store never jointly exceed the ceiling', async () => {
    // Two callers racing through the same shared store, as two replicas share one blob.
    await seed({ d1: 198 });
    const results = await Promise.all([
      ...Array.from({ length: 5 }, () => admitAnonDebateCall(USER, 'd1', LIMITS, DAY1)),
      ...Array.from({ length: 5 }, () => admitAnonDebateCall(USER, 'd1', LIMITS, DAY1)),
    ]);
    expect(results.filter(r => r.admitted)).toHaveLength(2);
  });

  it('survives lost races: forced conflicts are retried and the count is still correct', async () => {
    store.forceConflicts(3);
    expect(await admitAnonDebateCall(USER, 'd1', LIMITS, DAY1)).toEqual({ admitted: true, debateCalls: 1, debatesToday: 1 });
  });

  describe('fail closed', () => {
    it('a storage read failure throws, never admits', async () => {
      store.forceFailures('download', 1);
      await expect(admitAnonDebateCall(USER, 'd1', LIMITS, DAY1)).rejects.toMatchObject({ code: 'JSON_DOC_READ_FAILED' });
    });

    it('a storage write failure throws, and the count was not recorded', async () => {
      store.forceFailures('upload', 1);
      await expect(admitAnonDebateCall(USER, 'd1', LIMITS, DAY1)).rejects.toMatchObject({ code: 'JSON_DOC_WRITE_FAILED' });
      expect(await store.read(NAME1)).toBeNull();
    });

    it('retries used up throws, never admits', async () => {
      store.forceConflicts(1000);
      await expect(admitAnonDebateCall(USER, 'd1', LIMITS, DAY1)).rejects.toMatchObject({ code: 'JSON_DOC_CAS_EXHAUSTED' });
    });

    it('a record that is not JSON throws and is left as it is', async () => {
      store._setRawForTest(NAME1, '{not json');
      await expect(admitAnonDebateCall(USER, 'd1', LIMITS, DAY1)).rejects.toMatchObject({ code: 'JSON_DOC_CORRUPT' });
    });

    it.each([
      ['wrong shape', '{"debates":[]}'],
      ['no debates', '{}'],
      ['null', 'null'],
      ['negative count', '{"debates":{"d1":-1}}'],
      ['zero count', '{"debates":{"d1":0}}'],
      ['fractional count', '{"debates":{"d1":1.5}}'],
      ['string count', '{"debates":{"d1":"3"}}'],
      ['bad debate id key', '{"debates":{"a b":1}}'],
    ])('a record with %s throws and never reads as empty', async (_label, body) => {
      store._setRawForTest(NAME1, body);
      await expect(admitAnonDebateCall(USER, 'd1', LIMITS, DAY1)).rejects.toMatchObject({ code: ANON_DEBATE_COUNTER_RECORD_INVALID });
    });
  });

  describe('input validation (throws, nothing is written)', () => {
    it.each(['', 'anon-', 'anon-not-a-uuid', 'user-123e4567-e89b-12d3-a456-426614174000', '../anon-123e4567-e89b-12d3-a456-426614174000', `${USER}/x`, `${USER}\n`])(
      'rejects storage id %j', async (id) => {
        await expect(admitAnonDebateCall(id, 'd1', LIMITS, DAY1)).rejects.toMatchObject({ code: ANON_DEBATE_COUNTER_INVALID_INPUT });
        expect(store._sizeForTest()).toBe(0);
      });

    it.each(['', '__proto__', '../x', 'a/b', 'a b', 'x'.repeat(129)])('rejects debate id %j', async (id) => {
      await expect(admitAnonDebateCall(USER, id, LIMITS, DAY1)).rejects.toMatchObject({ code: ANON_DEBATE_COUNTER_INVALID_INPUT });
    });

    it.each([
      [{ perDebateCalls: 0, debatesPerDay: 2 }], [{ perDebateCalls: 200, debatesPerDay: 0 }], [{ perDebateCalls: -1, debatesPerDay: 2 }],
      [{ perDebateCalls: 1.5, debatesPerDay: 2 }], [{ perDebateCalls: NaN, debatesPerDay: 2 }],
    ])('rejects limits %j', async (limits) => {
      await expect(admitAnonDebateCall(USER, 'd1', limits, DAY1)).rejects.toMatchObject({ code: ANON_DEBATE_COUNTER_INVALID_INPUT });
    });

    it('rejects an invalid date', async () => {
      await expect(admitAnonDebateCall(USER, 'd1', LIMITS, new Date('nope'))).rejects.toMatchObject({ code: ANON_DEBATE_COUNTER_INVALID_INPUT });
    });

    it('the storage id is matched case-insensitively and stored lower-case, so one visitor has one record', async () => {
      await admitAnonDebateCall(USER.toUpperCase().replace('ANON-', 'anon-'), 'd1', LIMITS, DAY1);
      expect(await admitAnonDebateCall(USER, 'd1', LIMITS, DAY1)).toMatchObject({ debateCalls: 2 });
      expect(store._sizeForTest()).toBe(1);
    });
  });
});
