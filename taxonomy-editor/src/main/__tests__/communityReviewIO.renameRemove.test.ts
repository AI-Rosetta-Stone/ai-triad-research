// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4895/t/4894: desktop admin remove/rename for all 4 community types (chats, debates, opeds,
// inquiries) — mirrors the server's community.ts removeCommunityItem/renameCommunityItem.
// communityReviewIO.ts has no static electron import (see communityReviewIO.test.ts), so the
// real adminRemoveCommunityItem/adminRenameCommunityItem are exercised directly against an
// in-memory fake of the Azure Blob SDK (the only electron-adjacent dependency here is none —
// this module talks to Azure, not Electron — the fake just avoids a real network call).

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
          upload: async (data: Buffer) => { blobStore.set(name, data.toString('utf-8')); },
        }),
      };
    }
  },
}));

process.env.AZURE_STORAGE_ACCOUNT_URL = 'https://fake.blob.core.windows.net';

import { adminRemoveCommunityItem, adminRenameCommunityItem } from '../communityReviewIO.js';

function auditRecordsUnder(prefix: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const [name, content] of blobStore) {
    if (name.startsWith(prefix)) out.push(JSON.parse(content));
  }
  return out;
}

const TYPES: { type: 'chats' | 'debates' | 'opeds' | 'inquiries'; prefix: string; field: 'title' | 'topic' }[] = [
  { type: 'chats', prefix: 'chat-', field: 'title' },
  { type: 'debates', prefix: 'debate-', field: 'title' },
  { type: 'opeds', prefix: 'oped-', field: 'topic' },
  { type: 'inquiries', prefix: 'inquiry-', field: 'title' },
];

describe('adminRemoveCommunityItem — all 4 types (t/4895)', () => {
  beforeEach(() => { blobStore.clear(); });

  for (const { type, prefix, field } of TYPES) {
    it(`removes a ${type} item at its correct prefix and writes an audit record`, async () => {
      const blobName = `community/${type}/${prefix}abc123.json`;
      blobStore.set(blobName, JSON.stringify({ [field]: 'Some title' }));

      await adminRemoveCommunityItem(type, 'abc123', 'spam');

      expect(blobStore.has(blobName)).toBe(false);
      const audits = auditRecordsUnder('community/_removals/');
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ id: 'abc123', type, reason: 'spam' });
    });
  }

  it('404s on an unknown id — regression: existing chats/debates removal is unchanged', async () => {
    await expect(adminRemoveCommunityItem('chats', 'never-existed')).rejects.toThrow(/not found/i);
    await expect(adminRemoveCommunityItem('debates', 'never-existed')).rejects.toThrow(/not found/i);
  });

  it('a wrong-type lookup (e.g. an oped id under chats) still 404s rather than misfiling (t/4895 regression guard)', async () => {
    blobStore.set('community/opeds/oped-xyz.json', JSON.stringify({ topic: 'x' }));
    await expect(adminRemoveCommunityItem('chats', 'xyz')).rejects.toThrow(/not found/i);
    expect(blobStore.has('community/opeds/oped-xyz.json')).toBe(true); // untouched
  });
});

describe('adminRenameCommunityItem — all 4 types (t/4895/t/4894)', () => {
  beforeEach(() => { blobStore.clear(); });

  for (const { type, prefix, field } of TYPES) {
    it(`renames a ${type} item's ${field} field, trims the title, and writes an audit record first`, async () => {
      const blobName = `community/${type}/${prefix}abc123.json`;
      blobStore.set(blobName, JSON.stringify({ [field]: 'Old title' }));

      await adminRenameCommunityItem(type, 'abc123', '  New Title  ', 'cleanup');

      const updated = JSON.parse(blobStore.get(blobName)!);
      expect(updated[field]).toBe('New Title'); // trimmed

      const audits = auditRecordsUnder('community/_edits/');
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        id: 'abc123', type, from: 'Old title', to: 'New Title', reason: 'cleanup',
      });
    });
  }

  it('rejects an empty or whitespace-only title — no write, no audit record', async () => {
    blobStore.set('community/chats/chat-abc.json', JSON.stringify({ title: 'Old' }));
    await expect(adminRenameCommunityItem('chats', 'abc', '   ')).rejects.toThrow(/1-200 characters/);
    expect(JSON.parse(blobStore.get('community/chats/chat-abc.json')!).title).toBe('Old');
    expect(auditRecordsUnder('community/_edits/')).toHaveLength(0);
  });

  it('rejects a title over 200 characters', async () => {
    blobStore.set('community/chats/chat-abc.json', JSON.stringify({ title: 'Old' }));
    await expect(adminRenameCommunityItem('chats', 'abc', 'x'.repeat(201))).rejects.toThrow(/1-200 characters/);
  });

  it('404s on an unknown id — no audit record written', async () => {
    await expect(adminRenameCommunityItem('opeds', 'never-existed', 'New')).rejects.toThrow(/not found/i);
    expect(auditRecordsUnder('community/_edits/')).toHaveLength(0);
  });

  it('opeds rename writes topic, not title — regression guard for the per-type field mapping', async () => {
    blobStore.set('community/opeds/oped-abc.json', JSON.stringify({ topic: 'Old topic', title: 'should-not-be-touched' }));
    await adminRenameCommunityItem('opeds', 'abc', 'New topic');
    const updated = JSON.parse(blobStore.get('community/opeds/oped-abc.json')!);
    expect(updated.topic).toBe('New topic');
    expect(updated.title).toBe('should-not-be-touched');
  });
});
