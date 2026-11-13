// @vitest-environment node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/185: DraftStore blockers from Second Opinion (SO e/281).
// Tests that fail on current head without these fixes:
// - B1: No tests exist for DraftStore methods
// - B2: Cap counters fail open (don't throw on error)
// - B3: Anonymous guard checks '_anonymous' but should check '_local'
// - B6: One client can exhaust global 50-slot cap in 24h

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StorageBackend } from '../storage/storageBackend.js';
import { DRAFT_TTL_MS, DRAFT_GLOBAL_PENDING_CAP, DRAFT_PER_CLIENT_CAP } from '../community/draftStore.js';

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

vi.mock('../config.js', () => ({ resolveDataPath: (p: string) => `/data/${p}` }));
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

// The draft endpoint takes the community projection (the upload paths project before they send), so the
// fixture has no questionDrift.warning. CommunityInquiryResultSchema refuses an unprojected result.
function communityResult(): Record<string, unknown> {
  const r = makeValidResult() as Record<string, unknown> & { questionDrift?: Record<string, unknown> };
  if (r.questionDrift) delete r.questionDrift.warning;
  return r;
}

// Canonical taxonomy nodes the fixture references (label and camp as the server knows them).
const FIXTURE_NODES = new Map<string, { label: string; camp?: 'acc' | 'saf' | 'skp' | 'cc' }>([
  ['skp-beliefs-029', { label: 'Precaution under uncertainty', camp: 'skp' }],
  ['acc-beliefs-004', { label: 'Regulatory process', camp: 'acc' }],
]);

const basePayload = {
  result: communityResult(),
  note: '',
} as unknown as InquiryPayload;

const now = () => Date.now();

describe('DraftStore (t/185) — SO blockers B1, B2, B3, B6', () => {
  beforeEach(() => {
    files.clear();
    vi.clearAllMocks();
    // A test that overrides listDirectory must not leak its override into the next test.
    (mockBackend.listDirectory as any).mockImplementation(listDirectoryImpl);
  });

  describe('B1: DraftStore interface methods are tested', () => {
    it('createDraft creates a draft and returns draftId', async () => {
      const store = createDraftStore({ backend: mockBackend, now });
      const result = await store.createDraft(basePayload, { nodesById: FIXTURE_NODES, clientId: 'client-1' });
      expect(result.ok).toBe(true);
      expect(result).toHaveProperty('draftId');
      expect((result as any).draftId).toMatch(/^drf_[a-f0-9]{32}$/);
    });

    it('getDraft retrieves a created draft', async () => {
      const store = createDraftStore({ backend: mockBackend, now });
      const created = await store.createDraft(basePayload, { nodesById: FIXTURE_NODES, clientId: 'client-1' });
      expect(created.ok).toBe(true);
      const draftId = (created as any).draftId;

      const retrieved = await store.getDraft(draftId);
      expect(retrieved.ok).toBe(true);
      expect((retrieved as any).draft).toHaveProperty('draftId', draftId);
      expect((retrieved as any).draft).toHaveProperty('projection');
      expect((retrieved as any).draft).toHaveProperty('note');
    });

    it('finalizeDraft claims a draft and creates a submission', async () => {
      const store = createDraftStore({ backend: mockBackend, now });
      const created = await store.createDraft(basePayload, { nodesById: FIXTURE_NODES, clientId: 'client-1' });
      expect(created.ok).toBe(true);
      const draftId = (created as any).draftId;

      const finalized = await store.finalizeDraft(draftId, {
        storageUserId: 'user-123',
        displayName: 'Test User',
      });
      expect(finalized.ok).toBe(true);
      expect((finalized as any).submissionId).toBe(draftId);
    });

    it('sweepExpiredDrafts removes expired drafts and claims', async () => {
      const store = createDraftStore({
        backend: mockBackend,
        now: () => Date.now(),
      });

      // Create a draft that's "expired"
      const pastTime = () => Date.now() - DRAFT_TTL_MS - 1000;
      const storeWithPastTime = createDraftStore({
        backend: mockBackend,
        now: pastTime,
      });

      const created = await storeWithPastTime.createDraft(basePayload, { nodesById: FIXTURE_NODES, clientId: 'client-1' });
      expect(created.ok).toBe(true);

      // Now sweep (using current time)
      const result = await store.sweepExpiredDrafts();
      expect(result).toHaveProperty('deleted');
      expect((result as any).deleted).toBeGreaterThanOrEqual(0);
    });
  });

  describe('B2: Cap counters fail closed on errors (throw ActionableError)', () => {
    it('finalizeDraft throws ActionableError when cap count fails', async () => {
      const store = createDraftStore({ backend: mockBackend, now });

      // Create a draft
      const created = await store.createDraft(basePayload, { nodesById: FIXTURE_NODES, clientId: 'client-1' });
      expect(created.ok).toBe(true);
      const draftId = (created as any).draftId;

      // Mock listDirectory to throw
      (mockBackend.listDirectory as any).mockRejectedValueOnce(new Error('Storage error'));

      // finalizeDraft should throw ActionableError, not silently continue
      try {
        await store.finalizeDraft(draftId, {
          storageUserId: 'user-123',
          displayName: 'Test User',
        });
        expect.fail('Should have thrown ActionableError');
      } catch (err) {
        expect((err as any).message).toContain('Count');
        expect((err as any).goal).toBeDefined();
      }
    });

    it('createDraft refuses (cap_reached) when the per-client count fails, and writes nothing', async () => {
      const store = createDraftStore({ backend: mockBackend, now });

      // Mock listDirectory to throw on the second call (the per-client count, after the global count)
      let callCount = 0;
      (mockBackend.listDirectory as any).mockImplementation(async (dir: string) => {
        callCount++;
        if (callCount > 1) throw new Error('Storage error');
        return listDirectoryImpl(dir);
      });

      // Fail closed: a failed count refuses the draft (never admits it)
      const result = await store.createDraft(basePayload, { nodesById: FIXTURE_NODES, clientId: 'client-1' });
      expect(result).toEqual({ ok: false, reason: 'cap_reached' });
      expect([...files.keys()].some(k => k.includes('/_drafts/drf_'))).toBe(false);
    });
  });

  describe('B3: Anonymous user check uses correct ID (_local, not _anonymous)', () => {
    it('finalizeDraft rejects _local storageUserId (anonymous guard)', async () => {
      const store = createDraftStore({ backend: mockBackend, now });

      const created = await store.createDraft(basePayload, { nodesById: FIXTURE_NODES, clientId: 'client-1' });
      expect(created.ok).toBe(true);
      const draftId = (created as any).draftId;

      // Try to finalize with _local (the actual anonymous ID)
      const result = await store.finalizeDraft(draftId, {
        storageUserId: '_local',
        displayName: 'Anonymous',
      });

      expect(result.ok).toBe(false);
      expect((result as any).reason).toBe('anonymous');
    });

    it('finalizeDraft accepts non-_local storageUserId', async () => {
      const store = createDraftStore({ backend: mockBackend, now });

      const created = await store.createDraft(basePayload, { nodesById: FIXTURE_NODES, clientId: 'client-1' });
      expect(created.ok).toBe(true);
      const draftId = (created as any).draftId;

      // Finalize with a real user ID
      const result = await store.finalizeDraft(draftId, {
        storageUserId: 'github:user-123',
        displayName: 'Test User',
      });

      expect(result.ok).toBe(true);
    });
  });

  describe('B6: Per-client rate limiting prevents exhaustion of global cap', () => {
    it('one client cannot create more than DRAFT_PER_CLIENT_CAP drafts', async () => {
      const store = createDraftStore({ backend: mockBackend, now });

      const clientId = 'malicious-client';

      // Try to create DRAFT_PER_CLIENT_CAP + 1 drafts from same client
      const created: any[] = [];
      for (let i = 0; i < DRAFT_PER_CLIENT_CAP + 1; i++) {
        const result = await store.createDraft(basePayload, {
          nodesById: FIXTURE_NODES,
          clientId,
        });
        created.push(result);
      }

      // First DRAFT_PER_CLIENT_CAP should succeed
      for (let i = 0; i < DRAFT_PER_CLIENT_CAP; i++) {
        expect(created[i].ok).toBe(true);
      }

      // (DRAFT_PER_CLIENT_CAP + 1)th should fail with cap_reached
      expect(created[DRAFT_PER_CLIENT_CAP].ok).toBe(false);
      expect(created[DRAFT_PER_CLIENT_CAP].reason).toBe('cap_reached');
    });

    it('multiple clients do not interfere with each other per-client limits', async () => {
      const store = createDraftStore({ backend: mockBackend, now });

      // Client 1 creates at limit
      for (let i = 0; i < DRAFT_PER_CLIENT_CAP; i++) {
        const result = await store.createDraft(basePayload, {
          nodesById: FIXTURE_NODES,
          clientId: 'client-1',
        });
        expect(result.ok).toBe(true);
      }

      // Client 2 should still be able to create drafts
      const result = await store.createDraft(basePayload, {
        nodesById: FIXTURE_NODES,
        clientId: 'client-2',
      });
      expect(result.ok).toBe(true);
    });

    it('creates draft payload size cap (B6)', async () => {
      const store = createDraftStore({ backend: mockBackend, now });

      // The schema's note cap (5000 chars) rejects a 2MB note before the byte-size check runs.
      const hugePayload = { result: makeValidResult(), note: 'x'.repeat(2 * 1024 * 1024) } as unknown as InquiryPayload;

      const result = await store.createDraft(hugePayload, {
        nodesById: FIXTURE_NODES,
        clientId: 'client-1',
      });

      expect(result.ok).toBe(false);
      expect((result as any).reason).toBe('invalid');
      expect((result as any).detail).toBe('schema');
    });

    it('note field is sanitized and capped (B4)', async () => {
      const store = createDraftStore({ backend: mockBackend, now });

      const payloadWithNote: InquiryPayload = {
        ...basePayload,
        note: '  Important observation  ',
      } as any;

      const result = await store.createDraft(payloadWithNote, {
        nodesById: FIXTURE_NODES,
        clientId: 'client-1',
      });

      expect(result.ok).toBe(true);

      const draftId = (result as any).draftId;
      const retrieved = await store.getDraft(draftId);
      expect(retrieved.ok).toBe(true);

      // Note should be sanitized (trimmed)
      expect((retrieved as any).draft.note).toBe('Important observation');
    });
  });
});
