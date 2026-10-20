// @vitest-environment node

/**
 * t/4331 — layered concurrency check for debate/chat/comment full-PUT saves
 * and the delta merge path, closing the lost-update gap AzureBlobBackend's
 * atomic precondition (t/4191) exists to protect against.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { StorageBackend } from '../storage/storageBackend.js';
import { gitBlobSha } from '../storage/gitBlobSha.js';
import * as fileIO from '../storage/fileIO.js';
import * as userContext from '../security/userContext.js';
import { initAnonymousSessionStore } from '../storage/anonymousSessionStore.js';
import type { DebateDelta } from '../../../../lib/debate/types.js';

/** A MemoryBackend that implements `readFileWithVersion` (content-hash
 *  versioned, like FilesystemBackend/AzureBlobBackend) and supports injecting
 *  a concurrent write between a caller's read and its own write — the same
 *  deterministic-race pattern #3499 established for AzureBlobBackend, applied
 *  here to prove the domain layer actually passes `baseSha` through rather
 *  than just checking `_saveVersion` in memory. */
class VersionedMemoryBackend implements StorageBackend {
  readonly backendName = 'test-versioned-memory';
  files = new Map<string, string>();
  /** Set by a test to inject one write the instant a target path's content is read. */
  injectOnRead: { path: string; content: string } | null = null;

  private norm(p: string) { return p.replace(/\\/g, '/'); }

  async readFile(p: string): Promise<string | null> { return this.files.get(this.norm(p)) ?? null; }

  async readFileWithVersion(p: string): Promise<{ content: string; version: string } | null> {
    const key = this.norm(p);
    const content = this.files.get(key) ?? null;
    if (this.injectOnRead && this.norm(this.injectOnRead.path) === key) {
      const { content: injected } = this.injectOnRead;
      this.injectOnRead = null; // one-shot
      this.files.set(key, injected);
    }
    if (content === null) return null;
    return { content, version: gitBlobSha(content) };
  }

  async writeFile(p: string, c: string, opts?: { baseSha?: string }): Promise<{ version: string }> {
    const key = this.norm(p);
    if (opts?.baseSha !== undefined) {
      const current = this.files.get(key) ?? null;
      const currentSha = current === null ? '' : gitBlobSha(current);
      if (currentSha !== opts.baseSha) {
        const err = new Error('WRITE_CONFLICT') as Error & { code: string; httpStatus: number };
        err.code = 'WRITE_CONFLICT';
        err.httpStatus = 409;
        throw err;
      }
    }
    this.files.set(key, c);
    return { version: gitBlobSha(c) };
  }

  async listDirectory(d: string): Promise<string[]> {
    const prefix = this.norm(d) + '/';
    const out = new Set<string>();
    for (const k of this.files.keys()) if (k.startsWith(prefix)) out.add(k.slice(prefix.length).split('/')[0]);
    return [...out];
  }
  async deleteFile(p: string): Promise<void> { this.files.delete(this.norm(p)); }
  async fileExists(p: string): Promise<boolean> { return this.files.has(this.norm(p)); }
  async readBinaryFile(): Promise<Buffer | null> { return null; }
  async writeBinaryFile(): Promise<void> { /* stub */ }
  find(substr: string): string | undefined {
    const key = [...this.files.keys()].find(k => k.includes(substr));
    return key ? this.files.get(key) : undefined;
  }
}

const ctx = { principalName: 'alice', idp: 'github', storageUserId: 'alice', isAnonymous: false };

function makeDelta(over: Partial<DebateDelta> = {}): DebateDelta {
  return { debateId: 'd1', baseVersion: 0, newTranscriptEntries: [], changedNodes: [], changedEdges: [], newMutations: [], ...over };
}

let dataRoot: string;
let uc: VersionedMemoryBackend;

describe('debateStore save conflict handling (t/4331)', () => {
  beforeAll(() => {
    process.env.AI_TRIAD_DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 't4331-'));
    dataRoot = process.env.AI_TRIAD_DATA_ROOT;
    process.env.ANON_SESSION_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't4331-anon-'));
    initAnonymousSessionStore({ baseDir: process.env.ANON_SESSION_DIR });
  });
  afterAll(() => {
    fs.rmSync(dataRoot, { recursive: true, force: true });
    if (process.env.ANON_SESSION_DIR) fs.rmSync(process.env.ANON_SESSION_DIR, { recursive: true, force: true });
    delete process.env.AI_TRIAD_DATA_ROOT;
    delete process.env.ANON_SESSION_DIR;
  });
  beforeEach(() => {
    uc = new VersionedMemoryBackend();
    fileIO.setUserContentBackend(uc);
  });

  describe('saveDebateSession', () => {
    it('back-compat: opts omitted preserves the caller-supplied _saveVersion verbatim (regression guard)', async () => {
      await userContext.runWithUser(ctx, () => fileIO.saveDebateSession({ id: 'd1', title: 'D', _saveVersion: 7 }, 'test'));
      const stored = JSON.parse(uc.find('debate-d1.json') as string);
      expect(stored._saveVersion).toBe(7);
    });

    it('expectedVersion mismatch throws 409 version_conflict, no write attempted', async () => {
      await userContext.runWithUser(ctx, () => fileIO.saveDebateSession({ id: 'd1', title: 'D', _saveVersion: 3 }, 'test'));
      const before = uc.find('debate-d1.json');
      await expect(
        userContext.runWithUser(ctx, () => fileIO.saveDebateSession({ id: 'd1', title: 'stale edit' }, 'test', { expectedVersion: 0 })),
      ).rejects.toMatchObject({ statusCode: 409, code: 'version_conflict' });
      expect(uc.find('debate-d1.json')).toBe(before);
    });

    it('mustNotExist succeeds and stamps _saveVersion when absent', async () => {
      const result = await userContext.runWithUser(ctx, () =>
        fileIO.saveDebateSession({ id: 'd-new', title: 'New' }, 'test', { mustNotExist: true }));
      expect(result.newVersion).toBe(1);
      expect(JSON.parse(uc.find('debate-d-new.json') as string)._saveVersion).toBe(1);
    });

    it('mustNotExist throws 409 when the id already exists, without overwriting it', async () => {
      await userContext.runWithUser(ctx, () => fileIO.saveDebateSession({ id: 'd-taken', title: 'Original' }, 'test'));
      const before = uc.find('debate-d-taken.json');
      await expect(
        userContext.runWithUser(ctx, () => fileIO.saveDebateSession({ id: 'd-taken', title: 'Clobber attempt' }, 'test', { mustNotExist: true })),
      ).rejects.toMatchObject({ statusCode: 409, code: 'version_conflict' });
      expect(uc.find('debate-d-taken.json')).toBe(before);
    });

    // t/4331 condition 2 / the #3499 pattern: a write landing strictly BETWEEN
    // this backend's read and its own write must be caught, not silently
    // overwritten — proves the domain layer threads `baseSha` from the SAME
    // read used for the `_saveVersion` check, not just an in-memory compare.
    it('detects a write injected between its own read and its own write', async () => {
      await userContext.runWithUser(ctx, () => fileIO.saveDebateSession({ id: 'd-race', title: 'V0', _saveVersion: 0 }, 'test'));
      uc.injectOnRead = { path: uc.find('debate-d-race.json') ? [...uc.files.keys()].find(k => k.includes('debate-d-race.json'))! : '', content: JSON.stringify({ id: 'd-race', title: 'Other actor', _saveVersion: 1 }) };

      await expect(
        userContext.runWithUser(ctx, () =>
          fileIO.saveDebateSession({ id: 'd-race', title: 'Stale tab' }, 'test', { expectedVersion: 0 })),
      ).rejects.toMatchObject({ statusCode: 409, code: 'version_conflict' });

      // The injected write survived — the stale save never landed.
      expect(JSON.parse(uc.find('debate-d-race.json') as string).title).toBe('Other actor');
    });
  });

  describe('applyDebateDeltaToStorage', () => {
    it('detects a write injected between its own read and its own write (t/4331 condition 2)', async () => {
      await userContext.runWithUser(ctx, () => fileIO.saveDebateSession({ id: 'd-delta-race', title: 'V0', phase: 'rounds', _saveVersion: 0 }, 'test'));
      const key = [...uc.files.keys()].find(k => k.includes('debate-d-delta-race.json'))!;
      uc.injectOnRead = { path: key, content: JSON.stringify({ id: 'd-delta-race', title: 'V0', phase: 'rounds', _saveVersion: 1 }) };

      const delta = makeDelta({ debateId: 'd-delta-race', baseVersion: 0 });
      await expect(
        userContext.runWithUser(ctx, () => fileIO.applyDebateDeltaToStorage(delta)),
      ).rejects.toMatchObject({ statusCode: 409, code: 'version_conflict' });

      expect(JSON.parse(uc.find('debate-d-delta-race.json') as string)._saveVersion).toBe(1);
    });
  });

  describe('saveChatSession / saveDebateComments', () => {
    it('saveChatSession: expectedVersion mismatch throws 409, no write', async () => {
      await userContext.runWithUser(ctx, () => fileIO.saveChatSession({ id: 'c1', _saveVersion: 2 }));
      const before = uc.find('chat-c1.json');
      await expect(
        userContext.runWithUser(ctx, () => fileIO.saveChatSession({ id: 'c1' }, { expectedVersion: 0 })),
      ).rejects.toMatchObject({ statusCode: 409, code: 'version_conflict' });
      expect(uc.find('chat-c1.json')).toBe(before);
    });

    it('saveDebateComments: absent _saveVersion treated as 0, bumps to 1 under a versioned save', async () => {
      const result = await userContext.runWithUser(ctx, () =>
        fileIO.saveDebateComments('d1', { comments: [] }, { expectedVersion: 0 }));
      expect(result.newVersion).toBe(1);
    });
  });

  // t/4338 (CL review on #3511): saveDebateSession({ excludeFromQuota: true })
  // must not consume a debate slot or appear in the user's debate list, and
  // loadDebateSession must still resolve it by id.
  describe('saveDebateSession excludeFromQuota (t/4338)', () => {
    it('does not change the quota count or appear in the debate list', async () => {
      const before = await userContext.runWithUser(ctx, () => fileIO.getDebatesQuotaStatus());
      await userContext.runWithUser(ctx, () =>
        fileIO.saveDebateSession({ id: 'inq-1', title: 'Inquiry debate' }, 'inquiry', { mustNotExist: true, excludeFromQuota: true }));
      const after = await userContext.runWithUser(ctx, () => fileIO.getDebatesQuotaStatus());
      expect(after.current).toBe(before.current);

      const list = await userContext.runWithUser(ctx, () => fileIO.listDebateSessions()) as { id: string }[];
      expect(list.some(d => d.id === 'inq-1')).toBe(false);

      // Stored under the quota-exempt key, not the normal one (exact key
      // check — `find`'s substring match would false-positive against
      // "inquiry-debate-inq-1.json" containing "debate-inq-1.json").
      const exactKeys = [...uc.files.keys()];
      expect(exactKeys.some(k => k.endsWith('/debate-inq-1.json'))).toBe(false);
      expect(exactKeys.some(k => k.endsWith('/inquiry-debate-inq-1.json'))).toBe(true);
    });

    it('loadDebateSession still resolves a quota-exempt session by id', async () => {
      await userContext.runWithUser(ctx, () =>
        fileIO.saveDebateSession({ id: 'inq-2', title: 'Inquiry debate 2', origin: 'inquiry' }, 'inquiry', { mustNotExist: true, excludeFromQuota: true }));
      const loaded = await userContext.runWithUser(ctx, () => fileIO.loadDebateSession('inq-2')) as { id: string; origin?: string };
      expect(loaded.id).toBe('inq-2');
      expect(loaded.origin).toBe('inquiry');
    });

    it('a user already at the debate quota still gets the inquiry debate persisted', async () => {
      const status = await userContext.runWithUser(ctx, () => fileIO.getDebatesQuotaStatus());
      const debatesDir = path.join(dataRoot, 'users', 'alice', 'debates');
      for (let i = status.current; i < status.limit; i++) {
        uc.files.set(path.join(debatesDir, `debate-filler-${i}.json`).replace(/\\/g, '/'), '{}');
      }
      // Confirm quota is now exhausted for a normal save.
      const atLimit = await userContext.runWithUser(ctx, () => fileIO.getDebatesQuotaStatus());
      expect(atLimit.allowed).toBe(false);
      await expect(
        userContext.runWithUser(ctx, () => fileIO.saveDebateSession({ id: 'should-be-blocked', title: 'x' }, 'test')),
      ).rejects.toMatchObject({ statusCode: 429 });

      // The quota-exempt save still succeeds.
      const result = await userContext.runWithUser(ctx, () =>
        fileIO.saveDebateSession({ id: 'inq-3', title: 'Inquiry at quota' }, 'inquiry', { mustNotExist: true, excludeFromQuota: true }));
      expect(result.newVersion).toBe(1);
      expect(uc.find('inquiry-debate-inq-3.json')).toBeDefined();
    });
  });
});
