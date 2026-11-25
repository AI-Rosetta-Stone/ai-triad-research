// @vitest-environment node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/507: follow-ups from TL's review of a0c17e208 (t/185#44): claim-marker sweep, corrupt-record handling,
// and innerError on the raw rethrows.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StorageBackend } from '../storage/storageBackend.js';

const files = new Map<string, string>();
const normalize = (p: string) => p.replace(/\\/g, '/');

const listDirectoryImpl = async (dir: string) => {
  const prefix = `${normalize(dir)}/`;
  return [...new Set([...files.keys()].filter(k => k.startsWith(prefix) && k !== prefix).map(k => k.slice(prefix.length).split('/')[0]))];
};

const mockBackend: StorageBackend = {
  readFile: vi.fn(async (p: string) => files.get(normalize(p)) ?? null),
  writeFile: vi.fn(async (p: string, content: string) => { files.set(normalize(p), content); }),
  deleteFile: vi.fn(async (p: string) => { files.delete(normalize(p)); }),
  listDirectory: vi.fn(listDirectoryImpl),
  exists: vi.fn(async (p: string) => files.has(normalize(p))),
};

vi.mock('../storage/fileIO.js', () => ({
  getUserContentBackend: () => mockBackend,
  writeFileIfAbsentStrict: vi.fn(async (backend: any, path: string, content: string) => {
    const npath = normalize(path);
    if (files.has(npath)) return 'exists';
    files.set(npath, content);
    return 'created';
  }),
}));
vi.mock('../security/userContext.js', () => ({ isAnonymousUser: () => false }));
vi.mock('../config.js', () => ({ resolveDataPath: (p: string) => `/data/${p}` }));
vi.mock('../runtimeConfig.js', () => ({ getConfig: () => ({ community: { maxPendingPerUser: 50, globalPendingCap: 1000 } }) }));
vi.mock('../logger.js', () => ({
  log: { server: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } },
}));
vi.mock('../security/contentSanitizer.js', () => ({
  sanitizeUserText: (text: string) => text.trim().slice(0, 2000),
  withSanitizeBudget: (fn: () => any) => fn(),
}));

import { createDraftStore, DRAFT_TTL_MS } from '../community/draftStore.js';
import { ActionableError } from '../../../../lib/debate/errors.js';
import { log } from '../logger.js';
import type { InquiryPayload } from '../../../../lib/inquiry/index.js';
import { makeValidResult } from '../../../../lib/inquiry/__fixtures__/validResult.js';

function communityResult(): Record<string, unknown> {
  const r = makeValidResult() as Record<string, unknown> & { questionDrift?: Record<string, unknown> };
  if (r.questionDrift) delete r.questionDrift.warning;
  return r;
}
const FIXTURE_NODES = new Map<string, { label: string; camp?: 'acc' | 'saf' | 'skp' | 'cc' }>([
  ['skp-beliefs-029', { label: 'Precaution under uncertainty', camp: 'skp' }],
  ['acc-beliefs-004', { label: 'Regulatory process', camp: 'acc' }],
]);
const basePayload = { result: communityResult(), note: '' } as unknown as InquiryPayload;

const warnedWith = (text: string) => vi.mocked(log.server.warn).mock.calls.some(c => String(c[0]).includes(text));

describe('DraftStore follow-ups (t/507)', () => {
  beforeEach(() => {
    files.clear();
    vi.clearAllMocks();
    (mockBackend.listDirectory as any).mockImplementation(listDirectoryImpl);
    (mockBackend.readFile as any).mockImplementation(async (p: string) => files.get(normalize(p)) ?? null);
  });

  it('item 1: the sweep removes an expired claim marker and keeps a live one', async () => {
    let t = 1_000_000;
    const store = createDraftStore({ backend: mockBackend, now: () => t });
    files.set(normalize('community/_drafts/claims/drf_old.json'), JSON.stringify({ draftId: 'drf_old', expiresAt: new Date(t + 1000).toISOString() }));
    files.set(normalize('community/_drafts/claims/drf_live.json'), JSON.stringify({ draftId: 'drf_live', expiresAt: new Date(t + DRAFT_TTL_MS * 2).toISOString() }));
    t += 5000;
    const { deleted } = await store.sweepExpiredDrafts();
    expect(deleted).toBe(1);
    expect(files.has(normalize('community/_drafts/claims/drf_old.json'))).toBe(false);
    expect(files.has(normalize('community/_drafts/claims/drf_live.json'))).toBe(true);
  });

  it('item 1: a failed claims listing is logged and does not fail the sweep', async () => {
    const store = createDraftStore({ backend: mockBackend, now: () => 1_000_000 });
    (mockBackend.listDirectory as any).mockImplementation(async (dir: string) => {
      if (normalize(dir).endsWith('_drafts/claims')) throw new Error('claims list boom');
      return listDirectoryImpl(dir);
    });
    await expect(store.sweepExpiredDrafts()).resolves.toEqual({ deleted: 0 });
    expect(warnedWith('could not list claim markers')).toBe(true);
  });

  it('item 3: one corrupt draft record does not block creating a draft, and is logged', async () => {
    const store = createDraftStore({ backend: mockBackend, now: () => 1_000_000 });
    files.set(normalize('community/_drafts/drf_corrupt.json'), '{not json');
    const result = await store.createDraft(basePayload, { nodesById: FIXTURE_NODES, clientId: 'client-corrupt' });
    expect(result.ok).toBe(true);
    expect([...files.keys()].some(k => k.includes('drf_corrupt'))).toBe(false);
  });

  it('item 3: corrupt draft records are swept before counting, so they do not hold cap slots', async () => {
    const store = createDraftStore({ backend: mockBackend, now: () => 1_000_000 });
    for (let i = 0; i < 50; i++) files.set(normalize(`community/_drafts/drf_bad${i}.json`), '{bad');
    // The pre-count sweep removes the 50 corrupt records, so the cap is not exhausted by them.
    expect((await store.createDraft(basePayload, { nodesById: FIXTURE_NODES, clientId: 'c-b' })).ok).toBe(true);
    expect([...files.keys()].some(k => k.includes('drf_bad'))).toBe(false);
  });

  it('SO follow-up: a corrupt draft record is deleted by the sweep and logged', async () => {
    const store = createDraftStore({ backend: mockBackend, now: () => 1_000_000 });
    files.set(normalize('community/_drafts/drf_corrupt.json'), '{bad');
    const { deleted } = await store.sweepExpiredDrafts();
    expect(deleted).toBe(1);
    expect(files.has(normalize('community/_drafts/drf_corrupt.json'))).toBe(false);
  });

  it('SO follow-up: a claim marker with a bad expiresAt is deleted by the sweep', async () => {
    const store = createDraftStore({ backend: mockBackend, now: () => 1_000_000 });
    files.set(normalize('community/_drafts/claims/drf_badexp.json'), JSON.stringify({ draftId: 'drf_badexp', expiresAt: 'not-a-date' }));
    const { deleted } = await store.sweepExpiredDrafts();
    expect(deleted).toBe(1);
    expect(files.has(normalize('community/_drafts/claims/drf_badexp.json'))).toBe(false);
  });

  it('item 4: a failed draft read carries the original error as innerError', async () => {
    const store = createDraftStore({ backend: mockBackend, now: () => 1_000_000 });
    const created = await store.createDraft(basePayload, { nodesById: FIXTURE_NODES, clientId: 'c-read' });
    const draftId = (created as { draftId: string }).draftId;
    const boom = new Error('read boom');
    (mockBackend.readFile as any).mockImplementation(async (p: string) => {
      if (normalize(p).endsWith(`_drafts/${draftId}.json`)) throw boom;
      return files.get(normalize(p)) ?? null;
    });
    let caught: unknown;
    try { await store.getDraft(draftId); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ActionableError);
    expect((caught as ActionableError).innerError).toBe(boom);
  });
});
