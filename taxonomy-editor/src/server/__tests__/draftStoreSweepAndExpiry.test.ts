// @vitest-environment node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/185 (TL t/185#44): expiry, sweep and logging. Mock backend; the real-filesystem finalize test is in
// draftStoreFsFinalize.test.ts because these mocks apply to the whole file.

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
vi.mock('../runtimeConfig.js', () => ({ getConfig: () => ({ community: { maxPendingPerUser: 50, globalPendingCap: 1000 } }) }));
vi.mock('../logger.js', () => ({
  log: { server: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } },
}));
vi.mock('../security/contentSanitizer.js', () => ({
  sanitizeUserText: (text: string) => text.trim().slice(0, 2000),
  withSanitizeBudget: (fn: () => any) => fn(),
}));

import { createDraftStore, DRAFT_TTL_MS, DRAFT_PER_CLIENT_CAP } from '../community/draftStore.js';
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
const PRINCIPAL = { storageUserId: 'user-1', displayName: 'Ann' } as any;

describe('DraftStore expiry, sweep and logging (t/185 TL t/185#44)', () => {
  beforeEach(() => {
    anonCtx.anonymous = false;
    files.clear();
    // A test that overrides readFile must not leak its override into the next test.
    (mockBackend.readFile as any).mockImplementation(async (p: string) => files.get(normalize(p)) ?? null);
    vi.clearAllMocks();
    (mockBackend.listDirectory as any).mockImplementation(listDirectoryImpl);
  });

  it('sweep deletes the expired draft and keeps the live one', async () => {
    let t = 1_000_000;
    const store = createDraftStore({ backend: mockBackend, now: () => t });
    const expired = await store.createDraft(basePayload, { nodesById: FIXTURE_NODES, clientId: 'c-1' });
    // Created half a TTL later, so it is still live when the first one has expired.
    t += DRAFT_TTL_MS / 2;
    const live = await store.createDraft(basePayload, { nodesById: FIXTURE_NODES, clientId: 'c-2' });
    t += DRAFT_TTL_MS / 2 + 1; // first expires at +TTL; second expires at +1.5 TTL
    const expiredId = (expired as { draftId: string }).draftId;
    const liveId = (live as { draftId: string }).draftId;

    const { deleted } = await store.sweepExpiredDrafts();
    expect(deleted).toBe(1);
    expect(files.has(`community/_drafts/${expiredId}.json`)).toBe(false);
    expect(files.has(`community/_drafts/${liveId}.json`)).toBe(true);
  });

  it('createDraft sweeps before counting, so a stuck per-client count clears on the write path', async () => {
    let t = 1_000_000;
    const store = createDraftStore({ backend: mockBackend, now: () => t });
    for (let i = 0; i < DRAFT_PER_CLIENT_CAP; i++) {
      expect((await store.createDraft(basePayload, { nodesById: FIXTURE_NODES, clientId: 'c-x' })).ok).toBe(true);
    }
    t += DRAFT_TTL_MS + 1;
    const fresh = await store.createDraft(basePayload, { nodesById: FIXTURE_NODES, clientId: 'c-x' });
    expect(fresh.ok).toBe(true);
  });

  it('the per-client cap ignores expired drafts', async () => {
    let t = 1_000_000;
    const store = createDraftStore({ backend: mockBackend, now: () => t });
    for (let i = 0; i < DRAFT_PER_CLIENT_CAP; i++) {
      await store.createDraft(basePayload, { nodesById: FIXTURE_NODES, clientId: 'c-y' });
    }
    // Expire them in place without sweeping: the count alone must ignore them.
    t += DRAFT_TTL_MS + 1;
    const r = await store.createDraft(basePayload, { nodesById: FIXTURE_NODES, clientId: 'c-y' });
    expect(r.ok).toBe(true);
  });

  it('getDraft reports an expired draft as expired', async () => {
    let t = 1_000_000;
    const store = createDraftStore({ backend: mockBackend, now: () => t });
    const created = await store.createDraft(basePayload, { nodesById: FIXTURE_NODES, clientId: 'c-3' });
    const draftId = (created as { draftId: string }).draftId;
    t += DRAFT_TTL_MS + 1;
    expect(await store.getDraft(draftId)).toEqual({ ok: false, reason: 'expired' });
  });

  it('finalizeDraft reports an expired draft as expired and writes nothing', async () => {
    let t = 1_000_000;
    const store = createDraftStore({ backend: mockBackend, now: () => t });
    const created = await store.createDraft(basePayload, { nodesById: FIXTURE_NODES, clientId: 'c-4' });
    const draftId = (created as { draftId: string }).draftId;
    t += DRAFT_TTL_MS + 1;
    expect(await store.finalizeDraft(draftId, PRINCIPAL)).toEqual({ ok: false, reason: 'expired' });
    expect([...files.keys()].some(k => k.includes('/_submissions/'))).toBe(false);
  });

  it('a second finalize of the same draft returns already_claimed and writes one submission', async () => {
    const store = createDraftStore({ backend: mockBackend, now: () => 1_000_000 });
    const created = await store.createDraft(basePayload, { nodesById: FIXTURE_NODES, clientId: 'c-5' });
    const draftId = (created as { draftId: string }).draftId;
    expect((await store.finalizeDraft(draftId, PRINCIPAL)).ok).toBe(true);
    expect(await store.finalizeDraft(draftId, PRINCIPAL)).toEqual({ ok: false, reason: 'already_claimed' });
    expect([...files.keys()].filter(k => k.includes('/_submissions/')).length).toBe(1);
  });

  it('a failed claim-state read fails closed and is logged (checkAlreadyClaimed)', async () => {
    const store = createDraftStore({ backend: mockBackend, now: () => 1_000_000 });
    const created = await store.createDraft(basePayload, { nodesById: FIXTURE_NODES, clientId: 'c-6' });
    const draftId = (created as { draftId: string }).draftId;
    (mockBackend.readFile as any).mockImplementation(async (p: string) => {
      if (normalize(p).includes('/claims/')) throw new Error('claim read boom');
      return files.get(normalize(p)) ?? null;
    });
    // Fail closed: an unreadable claim state refuses the finalize, and nothing is written (Security, t/185).
    expect(await store.finalizeDraft(draftId, PRINCIPAL)).toEqual({ ok: false, reason: 'already_claimed' });
    expect([...files.keys()].some(k => k.includes('/_submissions/'))).toBe(false);
    expect(vi.mocked(log.server.warn).mock.calls.some(c => String(c[0]).includes('checkAlreadyClaimed'))).toBe(true);
  });

  it('a failed sweep delete is logged with the path, and the sweep continues', async () => {
    let t = 1_000_000;
    const store = createDraftStore({ backend: mockBackend, now: () => t });
    await store.createDraft(basePayload, { nodesById: FIXTURE_NODES, clientId: 'c-7' });
    t += DRAFT_TTL_MS + 1;
    (mockBackend.deleteFile as any).mockImplementationOnce(async () => { throw new Error('delete boom'); });
    const { deleted } = await store.sweepExpiredDrafts();
    expect(deleted).toBe(0);
    expect(vi.mocked(log.server.warn).mock.calls.some(c => String(c[0]).includes('could not sweep draft community/_drafts/') && String(c[0]).includes('delete boom'))).toBe(true);
  });

  it('an unparseable record is swept as dead, not left in place', async () => {
    const store = createDraftStore({ backend: mockBackend, now: () => 1_000_000 });
    files.set(normalize('community/_drafts/drf_bad.json'), '{not json');
    await store.sweepExpiredDrafts();
    expect(files.has(normalize('community/_drafts/drf_bad.json'))).toBe(false);
  });
  it('finalizeDraft refuses an anonymous cookie holder (anon-<uuid>) when isAnonymous is set, and writes nothing (Second-Opinion, t/185)', async () => {
    const store = createDraftStore({ backend: mockBackend, now: () => 1_000_000 });
    const created = await store.createDraft(basePayload, { nodesById: FIXTURE_NODES, clientId: 'c-anon' });
    const draftId = (created as { draftId: string }).draftId;
    anonCtx.anonymous = true; // the request is an anonymous cookie holder (isAnonymousUser() true)
    const anon = { storageUserId: 'anon-3f1c2b7e-8a4d-4c1e-9b2a-0d5e6f7a8b9c', displayName: 'Anon' };
    expect(await store.finalizeDraft(draftId, anon)).toEqual({ ok: false, reason: 'anonymous' });
    expect([...files.keys()].some(k => k.includes('/_submissions/'))).toBe(false);
  });

  it('finalizeDraft accepts a signed-in login whose id starts with anon- (the prefix is not the test) (Second-Opinion, t/185)', async () => {
    const store = createDraftStore({ backend: mockBackend, now: () => 1_000_000 });
    const created = await store.createDraft(basePayload, { nodesById: FIXTURE_NODES, clientId: 'c-login' });
    const draftId = (created as { draftId: string }).draftId;
    const login = { storageUserId: 'anon-smith', displayName: 'Smith' };
    expect((await store.finalizeDraft(draftId, login)).ok).toBe(true);
  });
});
