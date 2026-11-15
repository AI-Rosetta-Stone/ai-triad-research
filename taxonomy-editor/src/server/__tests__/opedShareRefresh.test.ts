// @vitest-environment node
//
// t/4927 — refreshOpedShareIfShared(): rename refreshes an existing public Op-Ed share's
// projection in place (same shareId), and NEVER mints a share when none exists.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockLoadOpedSet, serverWarn } = vi.hoisted(() => ({ mockLoadOpedSet: vi.fn(), serverWarn: vi.fn() }));

vi.mock('../logger.js', () => ({
  log: {
    api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    server: { info: vi.fn(), warn: serverWarn, error: vi.fn(), debug: vi.fn() },
  },
  getRequestId: () => 'req-test',
  LOG_MAX_LINE_BYTES: 65536,
  writeFramedNdjson: vi.fn(),
}));

vi.mock('../storage/opedStore.js', () => ({ loadOpedSet: mockLoadOpedSet }));

// In-memory fake backend keyed by absolute path — publish/refresh run real reads/writes.
// `hooks` let a race test run code just before a write/delete lands (t/4937).
const files = new Map<string, string>();
const hooks: { beforeWrite?: (p: string) => Promise<void>; beforeDelete?: (p: string) => Promise<void> } = {};
const fakeBackend = {
  backendName: 'fake',
  async readFile(p: string) { return files.has(p) ? files.get(p)! : null; },
  // t/117: versioned reads + `baseSha` enforcement, checked AFTER the hook so a hook can land a
  // concurrent write between a caller's read and its write.
  async readFileWithVersion(p: string) { return files.has(p) ? { content: files.get(p)!, version: gitBlobSha(files.get(p)!) } : null; },
  async writeFile(p: string, content: string, opts?: { baseSha?: string }) {
    await hooks.beforeWrite?.(p);
    if (opts?.baseSha !== undefined && (files.has(p) ? gitBlobSha(files.get(p)!) : '') !== opts.baseSha) {
      throw Object.assign(new Error('conflict'), { code: 'WRITE_CONFLICT' });
    }
    files.set(p, content);
  },
  async deleteFile(p: string) { await hooks.beforeDelete?.(p); files.delete(p); },
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
import { gitBlobSha } from '../storage/gitBlobSha.js';
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
    delete hooks.beforeWrite;
    delete hooks.beforeDelete;
    mockLoadOpedSet.mockReset();
    serverWarn.mockClear();
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

  // ─── unpublish racing a publish/refresh write (t/4937) ─────────────────────

  const registryPath = path.join(resolveDataPath('users/owner-1'), 'oped-shares.json');
  const raceCause = (c: [{ cause?: string }]) => c[0]?.cause === 'share-revoked-during-write';

  /** Run unpublish once, just before the next write to `target` lands. */
  function unpublishBeforeWriteTo(target: string): void {
    hooks.beforeWrite = async (p) => {
      if (p !== target) return;
      delete hooks.beforeWrite;
      expect(await runWithUser(OWNER, () => unpublishOpedShare('set-1'))).toBe(true);
    };
  }

  it('refresh racing an unpublish does not resurrect the revoked public copy', async () => {
    mockLoadOpedSet.mockResolvedValue(makeSet('Topic'));
    const { shareId } = (await runWithUser(OWNER, () => publishOpedShare('set-1')))!;

    unpublishBeforeWriteTo(publicOpedPath(shareId));
    expect(await runWithUser(OWNER, () => refreshOpedShareIfShared('set-1'))).toBe(false);

    expect(files.has(publicOpedPath(shareId))).toBe(false);
    expect(await loadPublicOpedShare(shareId)).toBeNull();
    expect(serverWarn.mock.calls.filter(raceCause)).toHaveLength(1);
  });

  it('re-publish racing an unpublish does not resurrect the revoked public copy', async () => {
    mockLoadOpedSet.mockResolvedValue(makeSet('Topic'));
    const { shareId } = (await runWithUser(OWNER, () => publishOpedShare('set-1')))!;

    unpublishBeforeWriteTo(publicOpedPath(shareId));
    expect(await runWithUser(OWNER, () => publishOpedShare('set-1'))).toBeNull();

    expect(files.has(publicOpedPath(shareId))).toBe(false);
    expect(serverWarn.mock.calls.filter(raceCause)).toHaveLength(1);
  });

  it('no race: publish and refresh keep the public copy and stay quiet', async () => {
    mockLoadOpedSet.mockResolvedValue(makeSet('Topic'));
    const { shareId } = (await runWithUser(OWNER, () => publishOpedShare('set-1')))!;
    expect(await runWithUser(OWNER, () => publishOpedShare('set-1'))).toEqual({ shareId });
    expect(await runWithUser(OWNER, () => refreshOpedShareIfShared('set-1'))).toBe(true);

    expect(files.has(publicOpedPath(shareId))).toBe(true);
    expect(serverWarn.mock.calls.filter(raceCause)).toHaveLength(0);
  });

  it('unpublish removes the registry entry before deleting the public copy', async () => {
    mockLoadOpedSet.mockResolvedValue(makeSet('Topic'));
    const { shareId } = (await runWithUser(OWNER, () => publishOpedShare('set-1')))!;

    let registryAtDelete: Record<string, string> | undefined;
    hooks.beforeDelete = async (p) => {
      if (p === publicOpedPath(shareId)) registryAtDelete = JSON.parse(files.get(registryPath)!);
    };
    await runWithUser(OWNER, () => unpublishOpedShare('set-1'));

    expect(registryAtDelete).toBeDefined();
    expect(registryAtDelete!['set-1']).toBeUndefined();
  });

  // ─── two concurrent share actions by one owner (t/117) ─────────────────────

  it('publish(B) overlapping unpublish(A) does not re-add A; a later refresh(A) stays revoked', async () => {
    mockLoadOpedSet.mockResolvedValue(makeSet('Topic'));
    const { shareId: sA } = (await runWithUser(OWNER, () => publishOpedShare('set-1')))!;

    // publish(B) reads the registry {A}, then unpublish(A) lands just before B's registry write.
    hooks.beforeWrite = async (p) => {
      if (p !== registryPath) return;
      delete hooks.beforeWrite;
      expect(await runWithUser(OWNER, () => unpublishOpedShare('set-1'))).toBe(true);
    };
    const b = await runWithUser(OWNER, () => publishOpedShare('set-2'));
    expect(b).not.toBeNull();

    const reg = JSON.parse(files.get(registryPath)!);
    expect(reg['set-1']).toBeUndefined();
    expect(reg['set-2']).toBe(b!.shareId);
    expect(await runWithUser(OWNER, () => refreshOpedShareIfShared('set-1'))).toBe(false);
    expect(files.has(publicOpedPath(sA))).toBe(false);
  });

  // ─── corrupt registry fails closed (t/126) ─────────────────────────────────

  it('publish against a corrupt registry is refused: registry preserved, no orphan public copy', async () => {
    const corrupt = '{"set-1":"11111111-1111-4111-8111-111111111111","set-3":"2222'; // truncated write
    files.set(registryPath, corrupt);
    mockLoadOpedSet.mockResolvedValue(makeSet('Topic'));

    await expect(runWithUser(OWNER, () => publishOpedShare('set-2'))).rejects.toMatchObject({ code: 'SHARE_REGISTRY_CORRUPT' });
    expect(files.get(registryPath)).toBe(corrupt);
    expect([...files.keys()].filter(k => k.startsWith(publicOpedPath('x').slice(0, -'x.json'.length)))).toEqual([]);
  });
});
