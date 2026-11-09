// @vitest-environment node
//
// t/4927 — refreshOpedShareIfShared(): rename refreshes an existing public Op-Ed share's
// projection in place (same shareId), and NEVER mints a share when none exists.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockLoadOpedSet } = vi.hoisted(() => ({ mockLoadOpedSet: vi.fn() }));

vi.mock('../logger.js', () => ({
  log: {
    api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    server: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  },
  getRequestId: () => 'req-test',
  LOG_MAX_LINE_BYTES: 65536,
  writeFramedNdjson: vi.fn(),
}));

vi.mock('../storage/opedStore.js', () => ({ loadOpedSet: mockLoadOpedSet }));

// In-memory fake backend keyed by absolute path — publish/refresh run real reads/writes.
const files = new Map<string, string>();
const fakeBackend = {
  backendName: 'fake',
  async readFile(p: string) { return files.has(p) ? files.get(p)! : null; },
  async writeFile(p: string, content: string) { files.set(p, content); },
  async deleteFile(p: string) { files.delete(p); },
  async listDirectory() { return []; },
  async fileExists(p: string) { return files.has(p); },
  async readBinaryFile() { return null; },
  async writeBinaryFile() { /* unused */ },
};
vi.mock('../storage/fileIO.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getUserContentBackend: () => fakeBackend };
});

import path from 'path';
import { runWithUser, type UserContext } from '../security/userContext.js';
import { publishOpedShare, unpublishOpedShare, refreshOpedShareIfShared, loadPublicOpedShare } from '../storage/opedShareStore.js';
import { resolveDataPath } from '../config.js';
import type { OpEdSet } from '../../../../lib/oped/types.js';

function publicOpedPath(shareId: string): string {
  return path.join(resolveDataPath('public/opeds'), `${shareId}.json`);
}

const OWNER: UserContext = { principalName: 'owner-1', idp: 'github', storageUserId: 'owner-1', isAnonymous: false };
const ANON: UserContext = { principalName: '', idp: 'anon', storageUserId: '_local', isAnonymous: true };

function makeSet(topic: string): OpEdSet {
  return {
    schema_version: 1,
    set_id: 'set-1',
    topic,
    params: { outlet: null, model: 'claude-sonnet-5', wordCount: 800 },
    created_at: '2026-08-17T00:00:00Z',
    opeds: [],
  } as unknown as OpEdSet;
}

describe('refreshOpedShareIfShared (t/4927)', () => {
  beforeEach(() => {
    files.clear();
    mockLoadOpedSet.mockReset();
  });

  it('refreshes an existing share in place — same shareId, new topic in the projection', async () => {
    mockLoadOpedSet.mockResolvedValue(makeSet('Original topic'));
    const { shareId } = (await runWithUser(OWNER, () => publishOpedShare('set-1')))!;

    mockLoadOpedSet.mockResolvedValue(makeSet('Renamed topic'));
    const refreshed = await runWithUser(OWNER, () => refreshOpedShareIfShared('set-1'));
    expect(refreshed).toBe(true);

    const pub = await loadPublicOpedShare(shareId);
    expect(pub!.topic).toBe('Renamed topic');
    expect(pub!.shareId).toBe(shareId); // same URL
  });

  it('never creates a share — returns false and writes nothing for an unshared setId', async () => {
    const before = files.size;
    const refreshed = await runWithUser(OWNER, () => refreshOpedShareIfShared('never-shared'));
    expect(refreshed).toBe(false);
    expect(mockLoadOpedSet).not.toHaveBeenCalled();
    expect(files.size).toBe(before);
  });

  it('returns false after unpublish — a revoked share stays revoked, not resurrected', async () => {
    mockLoadOpedSet.mockResolvedValue(makeSet('Topic'));
    await runWithUser(OWNER, () => publishOpedShare('set-1'));
    await runWithUser(OWNER, () => unpublishOpedShare('set-1'));

    const refreshed = await runWithUser(OWNER, () => refreshOpedShareIfShared('set-1'));
    expect(refreshed).toBe(false);
  });

  it('returns false for anonymous callers without touching the registry', async () => {
    expect(await runWithUser(ANON, () => refreshOpedShareIfShared('set-1'))).toBe(false);
    expect(mockLoadOpedSet).not.toHaveBeenCalled();
  });

  it('returns false if the set is gone despite a registry entry (defensive)', async () => {
    mockLoadOpedSet.mockResolvedValue(makeSet('Topic'));
    await runWithUser(OWNER, () => publishOpedShare('set-1'));
    mockLoadOpedSet.mockResolvedValue(null);
    expect(await runWithUser(OWNER, () => refreshOpedShareIfShared('set-1'))).toBe(false);
  });
});
