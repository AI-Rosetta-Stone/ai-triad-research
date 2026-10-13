// @vitest-environment node
//
// t/3497 — admin Gemini allowlist storage. Fail-CLOSED reads (SO cond 1, e/169#3):
// missing/corrupt/unreadable → [] + WARN, never fail-OPEN. Keyed on userId only
// (SO cond 4). Startup cache, invalidated on every write (single-replica — see
// the file header's load-bearing note, TL Quality review t/3497#2-4).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { serverWarn } = vi.hoisted(() => ({ serverWarn: vi.fn() }));
vi.mock('../logger.js', () => ({
  log: {
    api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    server: { info: vi.fn(), warn: serverWarn, error: vi.fn(), debug: vi.fn() },
  },
  getRequestId: () => 'req-test',
  LOG_MAX_LINE_BYTES: 65536,
  writeFramedNdjson: vi.fn(),
}));

import {
  getEntries, isAllowlisted, addEntry, removeEntry, _resetAllowlistCache, ALLOWLIST_CACHE_TTL_MS,
} from '../storage/allowlistStore.js';
import type { AllowlistEntry } from '../../../../lib/allowlist/types.js';

let dataRoot: string;
const SAVED_ENV: Record<string, string | undefined> = {};
const allowlistFile = () => path.join(dataRoot, 'admin', 'admin-allowlist.json');

function entry(userId: string, overrides: Partial<AllowlistEntry> = {}): AllowlistEntry {
  return { userId, email: `${userId}@example.com`, addedAt: '2026-09-16T00:00:00.000Z', ...overrides };
}

describe('allowlistStore (t/3497)', () => {
  beforeEach(() => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'allowlist-'));
    for (const k of ['AI_TRIAD_DATA_ROOT', 'AI_TRIAD_STATE_ROOT']) SAVED_ENV[k] = process.env[k];
    process.env.AI_TRIAD_DATA_ROOT = dataRoot;
    delete process.env.AI_TRIAD_STATE_ROOT; // fall back to data root, matching prod (stateRoot===dataRoot)
    _resetAllowlistCache();
    serverWarn.mockClear();
  });
  afterEach(() => {
    for (const k of ['AI_TRIAD_DATA_ROOT', 'AI_TRIAD_STATE_ROOT']) {
      if (SAVED_ENV[k] === undefined) delete process.env[k]; else process.env[k] = SAVED_ENV[k];
    }
    fs.rmSync(dataRoot, { recursive: true, force: true });
    _resetAllowlistCache();
  });

  // ─── Read success ─────────────────────────────────────────────────────────

  it('reads entries from an existing well-formed file', () => {
    fs.mkdirSync(path.dirname(allowlistFile()), { recursive: true });
    fs.writeFileSync(allowlistFile(), JSON.stringify({ version: 1, entries: [entry('alice')] }));
    expect(getEntries()).toEqual([entry('alice')]);
    expect(isAllowlisted('alice')).toBe(true);
    expect(isAllowlisted('bob')).toBe(false);
  });

  it('isAllowlisted keys on userId only — a matching email with a different userId is NOT allowlisted (SO cond 4)', () => {
    fs.mkdirSync(path.dirname(allowlistFile()), { recursive: true });
    fs.writeFileSync(allowlistFile(), JSON.stringify({ version: 1, entries: [entry('alice', { email: 'shared@example.com' })] }));
    expect(isAllowlisted('shared@example.com')).toBe(false);
    expect(isAllowlisted('alice')).toBe(true);
  });

  // ─── Fail-CLOSED read failures (SO cond 1) ────────────────────────────────

  it('missing file → fail-CLOSED to [] + WARN (ticket explicitly requires WARN even on missing)', () => {
    expect(getEntries()).toEqual([]);
    expect(isAllowlisted('anyone')).toBe(false);
    expect(serverWarn).toHaveBeenCalledWith(
      expect.objectContaining({ cause: 'admin-allowlist-unreadable' }),
      expect.any(String),
    );
  });

  it('corrupt JSON → fail-CLOSED to [] + WARN', () => {
    fs.mkdirSync(path.dirname(allowlistFile()), { recursive: true });
    fs.writeFileSync(allowlistFile(), '{not valid json');
    expect(getEntries()).toEqual([]);
    expect(serverWarn).toHaveBeenCalledWith(
      expect.objectContaining({ cause: 'admin-allowlist-unreadable' }),
      expect.any(String),
    );
  });

  it('non-array entries field → fail-CLOSED to [] + WARN', () => {
    fs.mkdirSync(path.dirname(allowlistFile()), { recursive: true });
    fs.writeFileSync(allowlistFile(), JSON.stringify({ version: 1, entries: 'not-an-array' }));
    expect(getEntries()).toEqual([]);
    expect(serverWarn).toHaveBeenCalled();
  });

  // ─── addEntry / removeEntry idempotency ───────────────────────────────────

  it('addEntry twice with the same userId upserts (no duplicate)', async () => {
    await addEntry(entry('alice', { email: 'old@example.com' }));
    await addEntry(entry('alice', { email: 'new@example.com' }));
    expect(getEntries()).toEqual([entry('alice', { email: 'new@example.com' })]);
  });

  it('removeEntry on an absent userId is a no-op (idempotent, no write)', async () => {
    await addEntry(entry('alice'));
    const before = fs.readFileSync(allowlistFile(), 'utf-8');
    await removeEntry('does-not-exist');
    expect(fs.readFileSync(allowlistFile(), 'utf-8')).toBe(before);
    expect(getEntries()).toEqual([entry('alice')]);
  });

  it('removeEntry removes exactly the matching entry, leaving others intact', async () => {
    await addEntry(entry('alice'));
    await addEntry(entry('bob'));
    await removeEntry('alice');
    expect(getEntries()).toEqual([entry('bob')]);
    expect(isAllowlisted('alice')).toBe(false);
    expect(isAllowlisted('bob')).toBe(true);
  });

  // ─── Cache invalidation on write ───────────────────────────────────────────

  it('a write is immediately visible to getEntries()/isAllowlisted() — no restart needed', async () => {
    expect(isAllowlisted('alice')).toBe(false); // populates the [] cache
    await addEntry(entry('alice'));
    expect(isAllowlisted('alice')).toBe(true); // cache invalidated by the write, not stale
  });

  it('persists to disk atomically (no stray .tmp file left behind)', async () => {
    await addEntry(entry('alice'));
    const files = fs.readdirSync(path.dirname(allowlistFile()));
    expect(files).toEqual(['admin-allowlist.json']);
  });

  it('writes { version: 1, entries } verbatim to disk', async () => {
    await addEntry(entry('alice'));
    expect(JSON.parse(fs.readFileSync(allowlistFile(), 'utf-8'))).toEqual({ version: 1, entries: [entry('alice')] });
  });

  // ─── Multi-replica revocation (t/4177) ─────────────────────────────────────
  // Another replica's removal is a rewrite of the shared file that THIS process never performed.

  it('a removal written by another replica takes effect here within the cache TTL', async () => {
    vi.useFakeTimers();
    try {
      await addEntry(entry('alice'));
      expect(isAllowlisted('alice')).toBe(true);
      // "Replica B" revokes alice by rewriting the shared file directly.
      fs.writeFileSync(allowlistFile(), JSON.stringify({ version: 1, entries: [] }));
      expect(isAllowlisted('alice')).toBe(true);            // still cached: within the TTL
      vi.advanceTimersByTime(ALLOWLIST_CACHE_TTL_MS + 1);
      expect(isAllowlisted('alice')).toBe(false);           // re-read: the revocation is visible
    } finally {
      vi.useRealTimers();
    }
  });

  it('the cross-replica revocation window is short (an ACL, not a feature flag)', () => {
    expect(ALLOWLIST_CACHE_TTL_MS).toBeLessThanOrEqual(60_000);
  });
});
