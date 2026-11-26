// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/713 (t/693): a desktop admin approve must not publish the submitter's storage id (a full
 * email address for Google/Entra sign-ins) where anonymous visitors can read it. The published
 * blob's `submitted_by_display` is the fixed word `Contributor`; the id goes only in
 * `community_metadata.owner_storage_id`, which the server strips from every read. The removal
 * audit reads the owner key first, the display only for pre-t/693 items.
 *
 * Failing arm: restore `submitted_by_display: submittedBy` in sanitizeForCommunity and the first
 * test fails. Same in-memory Azure fake as communityReviewIO.promoteSubmission.test.ts.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const blobStore = new Map<string, string>();

function notFoundError(): Error & { statusCode: number } {
  return Object.assign(new Error('NotFound'), { statusCode: 404 });
}

vi.mock('@azure/identity', () => ({ DefaultAzureCredential: class {} }));
vi.mock('@azure/storage-blob', () => ({
  BlobServiceClient: class {
    getContainerClient() {
      return {
        getBlobClient: (name: string) => ({
          download: async () => {
            if (!blobStore.has(name)) throw notFoundError();
            const buf = Buffer.from(blobStore.get(name)!, 'utf-8');
            return { readableStreamBody: (async function* () { yield buf; })() };
          },
          delete: async () => {
            if (!blobStore.has(name)) throw notFoundError();
            blobStore.delete(name);
          },
        }),
        getBlockBlobClient: (name: string) => ({
          upload: async (data: Buffer | string) => {
            blobStore.set(name, typeof data === 'string' ? data : data.toString('utf-8'));
          },
        }),
      };
    }
  },
}));

process.env.AZURE_STORAGE_ACCOUNT_URL = 'https://fake.blob.core.windows.net';

import { adminReviewAction, adminRemoveCommunityItem, communityItemOwnerKey } from '../communityReviewIO.js';

const STORAGE_ID = 'alice.smith@contoso-example.com';

function published(prefix: string): Record<string, unknown> {
  const names = [...blobStore.keys()].filter(k => k.startsWith(prefix));
  expect(names).toHaveLength(1);
  return JSON.parse(blobStore.get(names[0])!);
}

function audits(): Record<string, unknown>[] {
  return [...blobStore].filter(([k]) => k.startsWith('community/_removals/')).map(([, v]) => JSON.parse(v));
}

describe('desktop community approve hides the submitter storage id (t/713)', () => {
  beforeEach(() => { blobStore.clear(); });

  it('the published display is "Contributor" and holds no part of the storage id; the id is in owner_storage_id', async () => {
    const submission = {
      id: 'sub-713', type: 'chat' as const, originalId: 'chat-713', submittedBy: STORAGE_ID,
      submittedAt: new Date().toISOString(), status: 'pending' as const,
      data: { id: 'chat-713', title: 'A chat', transcript: [{ speaker: 'A', content: 'hello' }] },
    };
    blobStore.set('community/_submissions/sub-sub-713.json', JSON.stringify(submission));

    await adminReviewAction({ groupId: 'g', action: 'promote', itemIds: ['sub-713'] });

    const item = published('community/chats/chat-');
    const meta = item.community_metadata as Record<string, unknown>;
    expect(meta.submitted_by_display).toBe('Contributor');
    expect(meta.owner_storage_id).toBe(STORAGE_ID);
    const display = String(meta.submitted_by_display).toLowerCase();
    for (const part of ['alice', 'smith', 'contoso', '@']) expect(display).not.toContain(part);
    // The id appears nowhere in the blob except the one stripped field.
    const { owner_storage_id: _owner, ...rest } = meta;
    expect(JSON.stringify({ ...item, community_metadata: rest })).not.toContain('alice');
  });

  it('the removal audit names the owner from owner_storage_id, not the display', async () => {
    blobStore.set('community/chats/chat-new.json', JSON.stringify({
      title: 'New', community_metadata: { submitted_by_display: 'Contributor', owner_storage_id: STORAGE_ID },
    }));
    await adminRemoveCommunityItem('chats', 'new', 'spam');
    expect(audits()[0].submitted_by).toBe(STORAGE_ID);
  });

  it('a pre-t/693 item (display only) still audits its display as the owner', async () => {
    blobStore.set('community/chats/chat-old.json', JSON.stringify({
      title: 'Old', community_metadata: { submitted_by_display: 'legacy-user' },
    }));
    await adminRemoveCommunityItem('chats', 'old', null as unknown as string);
    expect(audits()[0].submitted_by).toBe('legacy-user');
  });

  it('communityItemOwnerKey matches the server rule', () => {
    expect(communityItemOwnerKey({ community_metadata: { owner_storage_id: 'o', submitted_by_display: 'Contributor' } })).toBe('o');
    expect(communityItemOwnerKey({ community_metadata: { submitted_by_display: 'legacy' } })).toBe('legacy');
    expect(communityItemOwnerKey({ community_metadata: {} })).toBeNull();
    expect(communityItemOwnerKey({})).toBeNull();
    expect(communityItemOwnerKey(null)).toBeNull();
  });
});
