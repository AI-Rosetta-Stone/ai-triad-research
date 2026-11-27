// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/802 (for t/724 check C): the server-owned counter for hosted ANONYMOUS debate AI calls.
//
// One record per (anonymous storage id, UTC day): `{ debates: { <debateId>: <calls> } }`, in the
// user-content container under `anon-debate-counter/<YYYY-MM-DD>/<sha256 hex of the lower-cased storage id>.json`. It is separate
// from the saved session, and the name holds only a hash of the id (JsonDocStore logs names on a failure), so a client PUT/PATCH, or deleting and recreating a debate, cannot reach or
// reset it. Every admission is ONE ETag compare-and-swap (`JsonDocStore.rmw`), so 50 parallel calls at
// count 199 admit exactly one, on any number of replicas, with no lease.
//
// Fail closed: a storage failure, an exhausted retry budget, a corrupt or malformed record, a
// malformed storage id or debate id, or bad limits THROW. Nothing here admits on error or treats an
// unreadable record as empty. A refusal never writes, so a refused call creates no record.
//
// Retention: a record is only useful on its own UTC day. Nothing in this module deletes old ones; the
// day-first layout lets a blob lifecycle rule on the `anon-debate-counter/` prefix (delete after
// 2 days since modification) do it. That rule is DeployAzure's, with an SO round (see t/802).

import { createHash } from 'crypto';
import { ActionableError } from '../../../../lib/debate/errors.js';
import { createJsonDocStore, type JsonDocStore } from './jsonDocStore.js';

export interface AnonDebateLimits { perDebateCalls: number; debatesPerDay: number }
export type AnonDebateAdmission =
  | { admitted: true; debateCalls: number; debatesToday: number }
  | { admitted: false; reason: 'budget' | 'daily'; limit: number };

export const ANON_DEBATE_COUNTER_INVALID_INPUT = 'ANON_DEBATE_COUNTER_INVALID_INPUT';
export const ANON_DEBATE_COUNTER_RECORD_INVALID = 'ANON_DEBATE_COUNTER_RECORD_INVALID';

const PREFIX = 'anon-debate-counter';
/** Parallel calls from one visitor contend on one record, and only admissions write, so allow more retries than the default 5. */
const MAX_CAS_RETRIES = 25;
const STORAGE_ID = /^anon-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEBATE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

interface CounterRecord { debates: Record<string, number> }

let store: JsonDocStore | null = null;

/** The store this module uses. Lazily built on first use (Blob when AZURE_STORAGE_ACCOUNT_URL is set, else in memory with a WARN). */
function getStore(): JsonDocStore {
  if (!store) store = createJsonDocStore({ prefix: PREFIX, maxCasRetries: MAX_CAS_RETRIES }).store;
  return store;
}

/** Inject a store (boot wiring or tests). Pass `null` to forget it. */
export function setAnonDebateCounterStore(next: JsonDocStore | null): void { store = next; }

function invalid(problem: string, code: string): ActionableError {
  return new ActionableError({
    goal: 'Count one anonymous debate AI call',
    problem,
    location: 'anonDebateCounter.admitAnonDebateCall',
    nextSteps: ['The caller must refuse the call (fail closed); do not retry with different input'],
    code,
  });
}

function positiveInt(n: unknown): n is number { return typeof n === 'number' && Number.isSafeInteger(n) && n > 0; }

/** A parsed record is trusted only if it has exactly the shape this module writes; anything else throws, never reads as empty. */
function checkRecord(doc: unknown): CounterRecord {
  const debates = (doc as { debates?: unknown } | null)?.debates;
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)
    || typeof debates !== 'object' || debates === null || Array.isArray(debates)) {
    throw invalid('The stored counter record is not { debates: {...} }; it was left as it is.', ANON_DEBATE_COUNTER_RECORD_INVALID);
  }
  for (const [id, calls] of Object.entries(debates)) {
    if (!DEBATE_ID.test(id) || !Number.isSafeInteger(calls) || (calls as number) < 1) {
      throw invalid('The stored counter record holds an entry that is not a debate id with a positive integer count; it was left as it is.', ANON_DEBATE_COUNTER_RECORD_INVALID);
    }
  }
  return doc as CounterRecord;
}

function recordName(storageUserId: string, now: Date): string {
  const day = now.toISOString().slice(0, 10);
  const hashed = createHash('sha256').update(storageUserId.toLowerCase()).digest('hex'); // never the raw id: names reach logs
  return `${PREFIX}/${day}/${hashed}.json`;
}

/**
 * Admit (and count) one AI call for an anonymous debate, or refuse it.
 * `budget`: this debate has used its `perDebateCalls`. `daily`: this is a new debate and the visitor already
 * has `debatesPerDay` debates today. `limit` is the number that was hit.
 */
export async function admitAnonDebateCall(
  storageUserId: string, debateId: string, limits: AnonDebateLimits, now: Date = new Date(),
): Promise<AnonDebateAdmission> {
  if (typeof storageUserId !== 'string' || !STORAGE_ID.test(storageUserId)) {
    throw invalid('The storage id is not "anon-" followed by a UUID.', ANON_DEBATE_COUNTER_INVALID_INPUT);
  }
  if (typeof debateId !== 'string' || !DEBATE_ID.test(debateId) || debateId === '__proto__') {
    throw invalid('The debate id is empty, too long, or has characters outside [A-Za-z0-9._:-].', ANON_DEBATE_COUNTER_INVALID_INPUT);
  }
  if (!limits || !positiveInt(limits.perDebateCalls) || !positiveInt(limits.debatesPerDay)) {
    throw invalid('The limits must both be positive integers.', ANON_DEBATE_COUNTER_INVALID_INPUT);
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw invalid('The clock value is not a valid date.', ANON_DEBATE_COUNTER_INVALID_INPUT);
  }

  // rmw re-runs this on a lost race with a freshly downloaded document, so it reads only `doc` and `limits`.
  return getStore().rmw<CounterRecord, AnonDebateAdmission>(
    recordName(storageUserId, now),
    () => ({ debates: {} }),
    (raw) => {
      const doc = checkRecord(raw);
      const seen = Object.hasOwn(doc.debates, debateId) ? doc.debates[debateId] : undefined;
      if (seen !== undefined) {
        if (seen >= limits.perDebateCalls) {
          return { result: { admitted: false, reason: 'budget', limit: limits.perDebateCalls }, skipWrite: true };
        }
        doc.debates[debateId] = seen + 1;
        return { result: { admitted: true, debateCalls: seen + 1, debatesToday: Object.keys(doc.debates).length } };
      }
      if (Object.keys(doc.debates).length >= limits.debatesPerDay) {
        return { result: { admitted: false, reason: 'daily', limit: limits.debatesPerDay }, skipWrite: true };
      }
      doc.debates[debateId] = 1;
      return { result: { admitted: true, debateCalls: 1, debatesToday: Object.keys(doc.debates).length } };
    },
  );
}
