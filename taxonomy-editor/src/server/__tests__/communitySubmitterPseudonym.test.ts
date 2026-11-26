// @vitest-environment node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/693 — a published community item never shows the submitter's storage id (a full email address for
// Google and Entra sign-ins). The display is a keyed pseudonym; the storage id stays in the stored
// file as community_metadata.owner_storage_id, is stripped from every read, and remains the owner key
// for op-ed shares and the removal audit.
//
// Real implementations end to end over an in-memory backend: approveSubmission, the four list and
// load readers, the share registry and the backfill.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const files = new Map<string, string>();

function normalize(p: string): string {
  return p.replace(/\\/g, '/');
}

vi.mock('../storage/fileIO.js', () => ({
  getUserContentBackend: () => ({
    readFile: vi.fn(async (p: string) => files.get(normalize(p)) ?? null),
    writeFile: vi.fn(async (p: string, content: string) => { files.set(normalize(p), content); }),
    deleteFile: vi.fn(async (p: string) => { files.delete(normalize(p)); }),
    listDirectory: vi.fn(async (dir: string) => {
      const prefix = `${normalize(dir)}/`;
      const names = new Set<string>();
      for (const key of files.keys()) {
        if (key.startsWith(prefix)) names.add(key.slice(prefix.length));
      }
      return [...names];
    }),
  }),
  assertSafeId: (id: string, label: string) => {
    if (!id || id.includes('..') || id.includes('/')) {
      throw new Error(`Unsafe ${label}: ${id}`);
    }
  },
}));

vi.mock('../config.js', () => ({
  resolveDataPath: (p: string) => `/data/${p}`,
}));

import {
  approveSubmission, backfillCommunityOpedShares, mintAndProjectCommunityOpEd,
  listCommunityChats, listCommunityDebates, listCommunityOpEds, listCommunityInquiries, loadCommunityItem,
} from '../community/community.js';
import { getCommunityOpedShareEntry } from '../community/communityOpedShares.js';
import { communityPseudonym, communityItemOwnerKey, PSEUDONYM_FALLBACK } from '../community/submitterPseudonym.js';
import { setAnonSessionSecret, clearAnonSessionSecret, deriveCommunityPseudonymKey } from '../security/anonSessionSigning.js';

/** What deriveStorageUserId makes of a Google or Entra address: the whole address, `@` and `.` replaced. */
const EMAIL_ID = 'jane-doe-at-example-com';
const KEY_A = Buffer.alloc(32, 7);
const KEY_B = Buffer.alloc(32, 9);
const PSEUDONYM_RE = /^Contributor-[0-9a-f]{8}$/;

type SubType = 'chat' | 'debate' | 'oped' | 'inquiry';
const PLURAL = { chat: 'chats', debate: 'debates', oped: 'opeds', inquiry: 'inquiries' } as const;
const PREFIX = { chat: 'chat-', debate: 'debate-', oped: 'oped-', inquiry: 'inquiry-' } as const;

const DATA: Record<SubType, Record<string, unknown>> = {
  chat: { id: 'orig-chat', title: 'A chat', mode: 'chat', messages: [] },
  debate: { id: 'orig-debate', title: 'A debate', phase: 'complete', transcript: [] },
  oped: { id: 'orig-oped', topic: 'A topic', opeds: [{ pov: 'acc', headline: 'h', status: 'complete', body: 'text' }] },
  inquiry: { id: 'orig-inquiry', created_at: '2026-11-01T00:00:00.000Z' },
};

function seedSubmission(id: string, type: SubType, submittedBy = EMAIL_ID) {
  files.set(normalize(`/data/community/_submissions/sub-${id}.json`), JSON.stringify({
    id, type, status: 'pending', submittedBy, data: DATA[type],
  }));
}

function storedItem(type: SubType, communityId: string): { community_metadata: Record<string, unknown> } {
  const raw = files.get(normalize(`/data/community/${PLURAL[type]}/${PREFIX[type]}${communityId}.json`));
  if (!raw) throw new Error(`no stored ${type} ${communityId}`);
  return JSON.parse(raw);
}

function expectNoStorageId(value: unknown) {
  const text = JSON.stringify(value);
  expect(text).not.toContain('-at-');
  expect(text).not.toContain('@');
  expect(text).not.toContain(EMAIL_ID);
  expect(text).not.toContain('owner_storage_id');
}

beforeEach(() => { files.clear(); setAnonSessionSecret(KEY_A); });
afterEach(() => { clearAnonSessionSecret(); });

describe('communityPseudonym (t/693)', () => {
  it('is Contributor plus 8 hex, stable for one id and key, and holds no part of the storage id', () => {
    const p = communityPseudonym(EMAIL_ID);
    expect(p).toMatch(PSEUDONYM_RE);
    expect(communityPseudonym(EMAIL_ID)).toBe(p);
    expectNoStorageId(p);
  });

  it('differs by storage id and by secret (a rotation changes new pseudonyms)', () => {
    const p = communityPseudonym(EMAIL_ID);
    expect(communityPseudonym('someone-else-at-example-com')).not.toBe(p);
    setAnonSessionSecret(KEY_B);
    expect(communityPseudonym(EMAIL_ID)).not.toBe(p);
  });

  it('fails closed with no secret: the fixed word, never the storage id', () => {
    clearAnonSessionSecret();
    expect(deriveCommunityPseudonymKey()).toBeNull();
    expect(communityPseudonym(EMAIL_ID)).toBe(PSEUDONYM_FALLBACK);
  });

  it('gives the fixed word for an empty storage id', () => {
    expect(communityPseudonym('')).toBe(PSEUDONYM_FALLBACK);
  });
});

describe('published items (t/693)', () => {
  const types: SubType[] = ['chat', 'debate', 'oped', 'inquiry'];

  it.each(types)('%s: the stored file keeps the owner key and a pseudonym display', async (type) => {
    seedSubmission(`s-${type}`, type);
    const { communityId } = await approveSubmission(`s-${type}`);
    const meta = storedItem(type, communityId).community_metadata;
    expect(meta.owner_storage_id).toBe(EMAIL_ID);
    expect(meta.submitted_by_display).toMatch(PSEUDONYM_RE);
    expectNoStorageId(meta.submitted_by_display);
  });

  it('no list or item read contains -at-, @, the storage id or the owner key', async () => {
    const ids = {} as Record<SubType, string>;
    for (const type of types) {
      seedSubmission(`s-${type}`, type);
      ids[type] = (await approveSubmission(`s-${type}`)).communityId;
    }
    const lists = [await listCommunityChats(), await listCommunityDebates(), await listCommunityOpEds(), await listCommunityInquiries()];
    for (const list of lists) {
      expect(list).toHaveLength(1);
      expectNoStorageId(list);
      const meta = (list[0] as { community_metadata: { submitted_by_display: string } }).community_metadata;
      expect(meta.submitted_by_display).toMatch(PSEUDONYM_RE);
    }
    for (const type of types) {
      const item = await loadCommunityItem(PLURAL[type], ids[type]);
      expect(item).not.toBeNull();
      expectNoStorageId(item);
    }
  });

  it('with no secret the display is the fixed word and the owner key is still kept', async () => {
    clearAnonSessionSecret();
    seedSubmission('s-nokey', 'chat');
    const { communityId } = await approveSubmission('s-nokey');
    const meta = storedItem('chat', communityId).community_metadata;
    expect(meta.submitted_by_display).toBe(PSEUDONYM_FALLBACK);
    expect(meta.owner_storage_id).toBe(EMAIL_ID);
  });
});

describe('the op-ed share owner (t/693)', () => {
  it('approve registers the share under the storage id, not the pseudonym', async () => {
    seedSubmission('s-oped', 'oped');
    const { communityId } = await approveSubmission('s-oped');
    expect((await getCommunityOpedShareEntry(communityId))!.submittedBy).toBe(EMAIL_ID);
  });

  it('a re-share resolves the same owner even when the caller passes the public pseudonym', async () => {
    seedSubmission('s-oped', 'oped');
    const { communityId } = await approveSubmission('s-oped');
    for (const key of [...files.keys()]) if (key.endsWith('/oped-shares.json') || key.includes('/public/')) files.delete(key);
    expect(await getCommunityOpedShareEntry(communityId)).toBeNull();

    const display = storedItem('oped', communityId).community_metadata.submitted_by_display as string;
    const result = await mintAndProjectCommunityOpEd(communityId, display);
    expect(result.outcome).toBe('minted');
    expect((await getCommunityOpedShareEntry(communityId))!.submittedBy).toBe(EMAIL_ID);
  });

  it('the backfill registers the storage id for new items and for items published before t/693', async () => {
    seedSubmission('s-oped', 'oped');
    const { communityId } = await approveSubmission('s-oped');
    for (const key of [...files.keys()]) if (key.endsWith('/oped-shares.json') || key.includes('/public/')) files.delete(key);
    files.set(normalize('/data/community/opeds/oped-legacy-1.json'), JSON.stringify({
      id: 'legacy-1', topic: 'Old', opeds: [{ pov: 'acc', headline: 'h', status: 'complete', body: 'text' }],
      community_metadata: { submitted_by_display: 'legacy-owner' },
    }));
    files.delete(normalize('/data/community/opeds/_index.json'));

    const result = await backfillCommunityOpedShares();
    expect(result.minted).toBe(2);
    expect((await getCommunityOpedShareEntry(communityId))!.submittedBy).toBe(EMAIL_ID);
    expect((await getCommunityOpedShareEntry('legacy-1'))!.submittedBy).toBe('legacy-owner');
  });
});

describe('items published before t/693 are masked at read (no data write)', () => {
  const LEGACY: Record<SubType, Record<string, unknown>> = {
    chat: { id: 'old', title: 'Old chat', mode: 'chat' },
    debate: { id: 'old', title: 'Old debate', phase: 'complete' },
    oped: { id: 'old', topic: 'Old', opeds: [{ pov: 'acc', headline: 'h', status: 'complete', body: 'text' }] },
    inquiry: { id: 'old', request: { question: 'Old?' } },
  };
  const legacyPath = (type: SubType) => normalize(`/data/community/${PLURAL[type]}/${PREFIX[type]}old.json`);
  const seedLegacy = (type: SubType) => {
    const stored = JSON.stringify({ ...LEGACY[type], community_metadata: { submitted_by_display: EMAIL_ID, submitted_at: 's', approved_at: 'a', original_id: 'private' } });
    files.set(legacyPath(type), stored);
    return stored;
  };
  const types: SubType[] = ['chat', 'debate', 'oped', 'inquiry'];
  const LISTS = { chat: listCommunityChats, debate: listCommunityDebates, oped: listCommunityOpEds, inquiry: listCommunityInquiries };

  it.each(types)('%s: list and item show the pseudonym, not the storage id, and the stored file is untouched', async (type) => {
    const stored = seedLegacy(type);
    const list = await LISTS[type]();
    expect(list).toHaveLength(1);
    expectNoStorageId(list);
    const item = await loadCommunityItem(PLURAL[type], 'old') as { community_metadata: Record<string, unknown> };
    expectNoStorageId(item);
    for (const meta of [(list[0] as typeof item).community_metadata, item.community_metadata]) {
      expect(meta.submitted_by_display).toBe(communityPseudonym(EMAIL_ID));
      expect(meta.submitted_at).toBe('s');
      expect(meta.original_id).toBeUndefined();
    }
    expect(files.get(legacyPath(type))).toBe(stored);
  });

  it('a listing index cached by the previous version (with the storage id in it) is not served', async () => {
    seedLegacy('chat');
    files.set(normalize('/data/community/chats/_index.json'), JSON.stringify({
      version: 'chat-v3',
      entries: [{ id: 'old', title: 'Old chat', created_at: '', updated_at: '', mode: 'chat', community_metadata: { submitted_by_display: EMAIL_ID } }],
    }));
    const list = await listCommunityChats();
    expect(list).toHaveLength(1);
    expectNoStorageId(list);
  });

  it('with no secret a legacy item shows the fixed word, never the storage id', async () => {
    clearAnonSessionSecret();
    seedLegacy('debate');
    const list = await listCommunityDebates() as { community_metadata: { submitted_by_display: string } }[];
    expect(list[0].community_metadata.submitted_by_display).toBe(PSEUDONYM_FALLBACK);
    expectNoStorageId(await loadCommunityItem('debates', 'old'));
  });

  it('the owner key of a legacy item is still its stored display (the mask is read-side only)', async () => {
    seedLegacy('oped');
    const result = await mintAndProjectCommunityOpEd('old', '');
    expect(result.outcome).toBe('minted');
    expect((await getCommunityOpedShareEntry('old'))!.submittedBy).toBe(EMAIL_ID);
  });

  it('an item written since t/693 keeps its stored display as it is', async () => {
    files.set(legacyPath('chat'), JSON.stringify({ ...LEGACY.chat, community_metadata: { submitted_by_display: 'Contributor-0a1b2c3d', owner_storage_id: EMAIL_ID } }));
    const item = await loadCommunityItem('chats', 'old') as { community_metadata: Record<string, unknown> };
    expect(item.community_metadata.submitted_by_display).toBe('Contributor-0a1b2c3d');
    expectNoStorageId(item);
  });
});

describe('communityItemOwnerKey (t/693)', () => {
  it('prefers owner_storage_id, falls back to the display of a pre-t/693 item, else null', () => {
    expect(communityItemOwnerKey({ community_metadata: { owner_storage_id: 'o', submitted_by_display: 'Contributor-00000000' } })).toBe('o');
    expect(communityItemOwnerKey({ community_metadata: { submitted_by_display: 'legacy' } })).toBe('legacy');
    expect(communityItemOwnerKey({ community_metadata: {} })).toBeNull();
    expect(communityItemOwnerKey({})).toBeNull();
    expect(communityItemOwnerKey(null)).toBeNull();
  });
});
