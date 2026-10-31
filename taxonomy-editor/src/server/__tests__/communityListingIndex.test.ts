// @vitest-environment node

/**
 * t/726 — community chat/debate listings serve from a per-directory `_index.json`
 * instead of reading every file (N+1 GitHub API calls). The index is a cache:
 * cold start does a full scan + writes the index; subsequent calls serve from the
 * index (1 read) validated by a file-count staleness check; a count drift triggers
 * a background rebuild while the cached copy is returned immediately.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { StorageBackend } from '../storage/storageBackend.js';
import * as fileIO from '../storage/fileIO.js';
import * as community from '../community/community.js';
import * as userContext from '../security/userContext.js';
import { resolveDataPath } from '../config.js';

/** In-memory backend that actually persists writes, so the index hit-path is testable. */
class MemBackend implements StorageBackend {
  files = new Map<string, string>();
  reads: string[] = [];
  private norm(p: string) { return p.replace(/\\/g, '/'); }

  async readFile(filePath: string): Promise<string | null> {
    const k = this.norm(filePath);
    this.reads.push(k);
    return this.files.has(k) ? this.files.get(k)! : null;
  }
  async writeFile(filePath: string, content: string): Promise<void> {
    this.files.set(this.norm(filePath), content);
  }
  async listDirectory(dirPath: string): Promise<string[]> {
    const d = this.norm(dirPath).replace(/\/$/, '') + '/';
    const names = new Set<string>();
    for (const k of this.files.keys()) {
      if (k.startsWith(d)) names.add(k.slice(d.length).split('/')[0]);
    }
    return [...names];
  }
  async deleteFile(filePath: string): Promise<void> { this.files.delete(this.norm(filePath)); }
  async fileExists(filePath: string): Promise<boolean> { return this.files.has(this.norm(filePath)); }
  async readBinaryFile(): Promise<Buffer | null> { return null; }
  async writeBinaryFile(): Promise<void> { /* stub */ }

  // Test helpers
  put(absPath: string, content: string) { this.files.set(this.norm(absPath), content); }
  has(absPath: string) { return this.files.has(this.norm(absPath)); }
  itemReads(prefix: string) { return this.reads.filter(r => new RegExp(`${prefix}[^/]+\\.json$`).test(r)).length; }
  resetReads() { this.reads = []; }
}

const authedCtx = { principalName: 'alice', idp: 'github', storageUserId: 'alice', isAnonymous: false };

let dataRoot: string;
let mem: MemBackend;

const chatsDir = () => resolveDataPath('community/chats');
const debatesDir = () => resolveDataPath('community/debates');
const indexPath = (dir: string) => path.join(dir, '_index.json');

function chatFile(id: string, updated: string) {
  return JSON.stringify({ id, title: `Chat ${id}`, created_at: '2026-01-01', updated_at: updated, mode: 'brainstorm' });
}
function debateFile(id: string, updated: string) {
  return JSON.stringify({ id, title: `Debate ${id}`, created_at: '2026-01-01', updated_at: updated, phase: 'synthesis' });
}

const ids = (items: unknown[]) => items.map(c => (c as { id: string }).id);

describe('community listing index (t/726)', () => {
  beforeAll(() => {
    process.env.AI_TRIAD_DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'commidx-'));
    dataRoot = process.env.AI_TRIAD_DATA_ROOT;
  });
  afterAll(() => {
    fs.rmSync(dataRoot, { recursive: true, force: true });
    delete process.env.AI_TRIAD_DATA_ROOT;
  });
  beforeEach(() => {
    mem = new MemBackend();
    fileIO.setBackend(mem);
  });

  it('cold start builds the index from per-file reads, sorted by updated_at desc', async () => {
    mem.put(path.join(chatsDir(), 'chat-a.json'), chatFile('a', '2026-01-01'));
    mem.put(path.join(chatsDir(), 'chat-b.json'), chatFile('b', '2026-03-01'));
    mem.put(path.join(chatsDir(), 'chat-c.json'), chatFile('c', '2026-02-01'));

    const first = await userContext.runWithUser(authedCtx, () => community.listCommunityChats());

    expect(ids(first)).toEqual(['b', 'c', 'a']);       // newest updated_at first
    expect(mem.itemReads('chat-')).toBe(3);            // full scan happened
    expect(mem.has(indexPath(chatsDir()))).toBe(true); // index persisted
  });

  it('second call serves from the index without re-reading item files', async () => {
    mem.put(path.join(chatsDir(), 'chat-a.json'), chatFile('a', '2026-01-01'));
    mem.put(path.join(chatsDir(), 'chat-b.json'), chatFile('b', '2026-02-01'));
    await userContext.runWithUser(authedCtx, () => community.listCommunityChats()); // cold build

    mem.resetReads();
    const second = await userContext.runWithUser(authedCtx, () => community.listCommunityChats());

    expect(ids(second)).toEqual(['b', 'a']);
    expect(mem.itemReads('chat-')).toBe(0);                              // no per-file reads
    expect(mem.reads.some(r => r.endsWith('_index.json'))).toBe(true);  // served from index
  });

  it('a new file drifts the count → background rebuild picks it up', async () => {
    mem.put(path.join(chatsDir(), 'chat-a.json'), chatFile('a', '2026-01-01'));
    await userContext.runWithUser(authedCtx, () => community.listCommunityChats()); // build index (1 item)

    mem.put(path.join(chatsDir(), 'chat-z.json'), chatFile('z', '2026-09-01'));
    const stale = await userContext.runWithUser(authedCtx, () => community.listCommunityChats());
    expect(stale.length).toBe(1); // cached copy returned immediately

    await new Promise(r => setTimeout(r, 20)); // let the background rebuild finish
    const fresh = await userContext.runWithUser(authedCtx, () => community.listCommunityChats());
    expect(fresh.length).toBe(2);
    expect(ids(fresh)[0]).toBe('z');
  });

  it('skips a malformed file and still lists the valid ones', async () => {
    mem.put(path.join(chatsDir(), 'chat-good.json'), chatFile('good', '2026-01-01'));
    mem.put(path.join(chatsDir(), 'chat-bad.json'), '{ not valid json');

    const res = await userContext.runWithUser(authedCtx, () => community.listCommunityChats());

    expect(ids(res)).toEqual(['good']);
  });

  it('debate listing uses the same index pattern', async () => {
    mem.put(path.join(debatesDir(), 'debate-1.json'), debateFile('1', '2026-01-01'));
    mem.put(path.join(debatesDir(), 'debate-2.json'), debateFile('2', '2026-05-01'));

    const first = await userContext.runWithUser(authedCtx, () => community.listCommunityDebates());
    expect(ids(first)).toEqual(['2', '1']);
    expect(mem.has(indexPath(debatesDir()))).toBe(true);

    mem.resetReads();
    const second = await userContext.runWithUser(authedCtx, () => community.listCommunityDebates());
    expect(ids(second)).toEqual(['2', '1']);
    expect(mem.itemReads('debate-')).toBe(0); // served from index
  });

  // ── Index versioning (t/2384) ─────────────────────────────────────────────
  //
  // A toEntry schema change must bust the cached index so new fields appear
  // immediately — the count-only staleness check doesn't catch this.

  function debateFileWithModel(id: string) {
    return JSON.stringify({
      id, title: `Debate ${id}`, created_at: '2026-01-01', updated_at: '2026-06-01',
      phase: 'synthesis',
      debate_model: 'claude-sonnet-5',
      transcript: [{ type: 'opening' }, { type: 'statement' }, { type: 'statement' }],
    });
  }

  it('old bare-array index (pre-versioning) is ignored → fresh rebuild returns new fields', async () => {
    mem.put(path.join(debatesDir(), 'debate-m.json'), debateFileWithModel('m'));
    // Simulate the stale pre-t/2362 index: a raw array with no model/turn_count.
    mem.put(indexPath(debatesDir()), JSON.stringify([
      { id: 'm', title: 'Debate m', created_at: '2026-01-01', updated_at: '2026-06-01', phase: 'synthesis', community_metadata: null },
    ]));

    mem.resetReads();
    const result = await userContext.runWithUser(authedCtx, () => community.listCommunityDebates());

    expect(result.length).toBe(1);
    const entry = result[0] as { model?: string; turn_count?: number };
    expect(entry.model).toBe('claude-sonnet-5');
    expect(entry.turn_count).toBe(3); // opening + statement + statement
    expect(mem.itemReads('debate-')).toBeGreaterThan(0); // full scan ran — stale cache skipped
  });

  it('index with wrong schema version is ignored → fresh rebuild returns new fields', async () => {
    mem.put(path.join(debatesDir(), 'debate-m.json'), debateFileWithModel('m'));
    // Simulate a versioned index from a previous toEntry shape (debate-v1 → current is debate-v2).
    mem.put(indexPath(debatesDir()), JSON.stringify({
      version: 'debate-v1',
      entries: [{ id: 'm', title: 'Debate m', created_at: '2026-01-01', updated_at: '2026-06-01', phase: 'synthesis', community_metadata: null }],
    }));

    mem.resetReads();
    const result = await userContext.runWithUser(authedCtx, () => community.listCommunityDebates());

    expect(result.length).toBe(1);
    const entry = result[0] as { model?: string; turn_count?: number };
    expect(entry.model).toBe('claude-sonnet-5');
    expect(entry.turn_count).toBe(3);
    expect(mem.itemReads('debate-')).toBeGreaterThan(0); // full scan ran — stale version skipped
  });

  it('matching version index is served without per-file reads', async () => {
    mem.put(path.join(debatesDir(), 'debate-m.json'), debateFileWithModel('m'));
    // Build a valid current-version index.
    await userContext.runWithUser(authedCtx, () => community.listCommunityDebates());

    mem.resetReads();
    const result = await userContext.runWithUser(authedCtx, () => community.listCommunityDebates());

    expect((result[0] as { model?: string }).model).toBe('claude-sonnet-5');
    expect(mem.itemReads('debate-')).toBe(0); // served from valid versioned index
  });

  // ── Chat pover projection (t/4721) ────────────────────────────────────────

  function chatFileWithPover(id: string, pover: unknown) {
    return JSON.stringify({ id, title: `Chat ${id}`, created_at: '2026-01-01', updated_at: '2026-06-01', mode: 'inform', pover });
  }

  it('projects a known camp pover and drops unknown or non-camp values', async () => {
    mem.put(path.join(chatsDir(), 'chat-s.json'), chatFileWithPover('s', 'skeptic'));
    mem.put(path.join(chatsDir(), 'chat-u.json'), chatFileWithPover('u', 'user'));
    mem.put(path.join(chatsDir(), 'chat-x.json'), chatFileWithPover('x', '<script>'));
    mem.put(path.join(chatsDir(), 'chat-n.json'), chatFileWithPover('n', 42));

    const result = await userContext.runWithUser(authedCtx, () => community.listCommunityChats());
    const byId = new Map(result.map(c => [(c as { id: string }).id, c as { pover?: string }]));

    expect(byId.get('s')?.pover).toBe('skeptic');
    for (const id of ['u', 'x', 'n']) expect(byId.get(id)).not.toHaveProperty('pover');
  });

  it('a chat-v2 index (pre-pover) is ignored → fresh rebuild returns pover', async () => {
    mem.put(path.join(chatsDir(), 'chat-s.json'), chatFileWithPover('s', 'safetyist'));
    mem.put(indexPath(chatsDir()), JSON.stringify({
      version: 'chat-v2',
      entries: [{ id: 's', title: 'Chat s', created_at: '2026-01-01', updated_at: '2026-06-01', mode: 'inform', community_metadata: null }],
    }));

    mem.resetReads();
    const result = await userContext.runWithUser(authedCtx, () => community.listCommunityChats());

    expect((result[0] as { pover?: string }).pover).toBe('safetyist');
    expect(mem.itemReads('chat-')).toBeGreaterThan(0); // stale version skipped
  });
});
