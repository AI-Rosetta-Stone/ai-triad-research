// @vitest-environment node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/185: DraftStore must share the community queue with submitToCommunity.
// - B2: a draft count failure refuses (503), never admits past the cap.
// - B5: a finalized draft is written in the Submission shape (community.ts), so both paths count it.

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

const anonCtx = vi.hoisted(() => ({ anonymous: false }));
vi.mock('../security/userContext.js', () => ({ isAnonymousUser: () => anonCtx.anonymous }));
vi.mock('../config.js', () => ({ resolveDataPath: (p: string) => `/data/${p}` }));
// Community caps as the store reads them (getConfig().community). Old hard-coded values, so the existing cap tests keep their meaning.
vi.mock('../runtimeConfig.js', () => ({ getConfig: () => ({ community: { maxPendingPerUser: 50, globalPendingCap: 1000 } }) }));
vi.mock('../logger.js', () => ({
  log: { server: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } },
}));
vi.mock('../security/contentSanitizer.js', () => ({
  sanitizeUserText: (text: string) => text.trim().slice(0, 2000),
  withSanitizeBudget: (fn: () => any) => fn(),
}));

import { createDraftStore } from '../community/draftStore.js';
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

const basePayload = { result: communityResult(), note: 'Please review.' } as unknown as InquiryPayload;
const now = () => Date.now();

describe('DraftStore queue shape and count fail-closed (t/185 B2, B5)', () => {
  beforeEach(() => {
    anonCtx.anonymous = false;
    files.clear();
    vi.clearAllMocks();
    (mockBackend.listDirectory as any).mockImplementation(listDirectoryImpl);
  });

  it('B5: a finalized draft is written as a community Submission (string submittedBy, type, data)', async () => {
    const store = createDraftStore({ backend: mockBackend, now });
    const created = await store.createDraft(basePayload, { nodesById: FIXTURE_NODES, clientId: 'client-1' });
    expect(created.ok).toBe(true);
    const draftId = (created as { draftId: string }).draftId;

    const fin = await store.finalizeDraft(draftId, { storageUserId: 'user-42', displayName: 'Alice' } as any);
    expect(fin.ok).toBe(true);

    const sub = JSON.parse(files.get(normalize(`community/_submissions/sub-${draftId}.json`)) ?? 'null');
    expect(sub).not.toBeNull();
    expect(Object.keys(sub).sort()).toEqual(['data', 'id', 'note', 'originalId', 'status', 'submittedAt', 'submittedBy', 'type'].sort());
    expect(sub).toMatchObject({ id: draftId, type: 'inquiry', submittedBy: 'user-42', status: 'pending', note: 'Please review.' });
    expect(typeof sub.submittedAt).toBe('string');
    expect(typeof sub.data).toBe('object');
  });

  it('B5: a per-user count sees the finalized draft by its string submittedBy', async () => {
    const store = createDraftStore({ backend: mockBackend, now });
    const created = await store.createDraft(basePayload, { nodesById: FIXTURE_NODES, clientId: 'client-2' });
    const draftId = (created as { draftId: string }).draftId;
    await store.finalizeDraft(draftId, { storageUserId: 'user-7', displayName: 'Bob' } as any);

    const second = await store.createDraft(basePayload, { nodesById: FIXTURE_NODES, clientId: 'client-3' });
    const draft2 = (second as { draftId: string }).draftId;
    const fin2 = await store.finalizeDraft(draft2, { storageUserId: 'user-7', displayName: 'Bob' } as any);
    expect(fin2.ok).toBe(true);
    // Both finalized submissions carry the same string submittedBy, so both count toward user-7's cap.
    const submissions = [...files.entries()]
      .filter(([k]) => k.includes('/_submissions/'))
      .map(([, v]) => JSON.parse(v) as { submittedBy?: unknown });
    expect(submissions.filter(s => s.submittedBy === 'user-7').length).toBe(2);
  });

  it('B2: a failed draft count refuses the draft (503), never admits it past the cap', async () => {
    const store = createDraftStore({ backend: mockBackend, now });
    (mockBackend.listDirectory as any).mockImplementation(async (dir: string) => {
      if (normalize(dir).endsWith('community/_drafts')) throw new Error('storage down');
      return listDirectoryImpl(dir);
    });
    await expect(store.createDraft(basePayload, { nodesById: FIXTURE_NODES, clientId: 'client-4' }))
      .rejects.toMatchObject({ httpStatus: 503 });
    expect([...files.keys()].some(k => k.includes('/_drafts/'))).toBe(false);
  });

  it('getDraft reports a finalized draft as already_claimed (checks the submission path too)', async () => {
    const store = createDraftStore({ backend: mockBackend, now });
    const created = await store.createDraft(basePayload, { nodesById: FIXTURE_NODES, clientId: 'client-6' });
    const draftId = (created as { draftId: string }).draftId;
    expect((await store.getDraft(draftId)).ok).toBe(true);
    await store.finalizeDraft(draftId, { storageUserId: 'user-9', displayName: 'Cy' } as any);
    expect(await store.getDraft(draftId)).toEqual({ ok: false, reason: 'already_claimed' });
  });

  it('B6: a draft with no client id is refused (cap_reached) and nothing is written', async () => {
    const store = createDraftStore({ backend: mockBackend, now });
    const result = await store.createDraft(basePayload, { nodesById: FIXTURE_NODES });
    expect(result).toEqual({ ok: false, reason: 'cap_reached' });
    expect([...files.keys()].some(k => k.includes('/_drafts/'))).toBe(false);
  });

  it('B2: a corrupt draft record makes the count fail closed, not return a partial count', async () => {
    const store = createDraftStore({ backend: mockBackend, now });
    files.set(normalize('community/_drafts/drf_corrupt.json'), '{not json');
    await expect(store.createDraft(basePayload, { nodesById: FIXTURE_NODES, clientId: 'client-5' }))
      .rejects.toMatchObject({ httpStatus: 503 });
  });
});
