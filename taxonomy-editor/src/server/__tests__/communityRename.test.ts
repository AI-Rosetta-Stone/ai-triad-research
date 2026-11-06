// @vitest-environment node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/4894 — admin rename of a published community item, with an audit record.
 *
 * Mirrors communityRemoval.test.ts's MemBackend pattern, extended with a version/baseSha
 * CAS so the retry-on-conflict path (TL t/4894#2 condition 3) can actually be exercised.
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

class CasMemBackend implements StorageBackend {
  files = new Map<string, string>();
  versions = new Map<string, string>();
  private seq = 0;
  private norm(p: string) { return p.replace(/\\/g, '/'); }

  async readFile(p: string): Promise<string | null> { return this.files.get(this.norm(p)) ?? null; }

  async readFileWithVersion(p: string): Promise<{ content: string; version: string } | null> {
    const k = this.norm(p);
    const content = this.files.get(k);
    if (content === undefined) return null;
    return { content, version: this.versions.get(k) ?? '' };
  }

  async writeFile(p: string, c: string, opts?: { baseSha?: string }): Promise<{ version: string }> {
    const k = this.norm(p);
    if (opts?.baseSha !== undefined && this.versions.get(k) !== opts.baseSha) {
      throw Object.assign(new Error('precondition failed'), { code: 'WRITE_CONFLICT', statusCode: 409 });
    }
    this.files.set(k, c);
    const v = String(++this.seq);
    this.versions.set(k, v);
    return { version: v };
  }

  async listDirectory(dirPath: string): Promise<string[]> {
    const pre = this.norm(dirPath).replace(/\/$/, '') + '/';
    const s = new Set<string>();
    for (const k of this.files.keys()) if (k.startsWith(pre)) s.add(k.slice(pre.length).split('/')[0]);
    return [...s];
  }
  async deleteFile(p: string): Promise<void> { this.files.delete(this.norm(p)); this.versions.delete(this.norm(p)); }
  async fileExists(p: string): Promise<boolean> { return this.files.has(this.norm(p)); }
  async readBinaryFile(): Promise<Buffer | null> { return null; }
  async writeBinaryFile(): Promise<void> { /* stub */ }
  // helpers
  normAbs(p: string) { return this.norm(p); }
  editRecords() { return [...this.files.keys()].filter(k => k.includes('/community/_edits/edit-')); }
  // Simulate a concurrent writer bumping the version without going through writeFile's CAS
  // (e.g. another admin's rename landing between this test's read and write).
  bumpOutOfBand(p: string, newContent: string) {
    const k = this.norm(p);
    this.files.set(k, newContent);
    this.versions.set(k, String(++this.seq));
  }
}

const adminCtx = { principalName: 'jpsnover', idp: 'github', storageUserId: 'jpsnover', isAnonymous: false };
let dataRoot: string;
let mem: CasMemBackend;

const chatsDir = () => resolveDataPath('community/chats');
const opedsDir = () => resolveDataPath('community/opeds');
const inquiriesDir = () => resolveDataPath('community/inquiries');

const rename = (type: community.CommunityType, id: string, title: string, by = 'github:12345', reason?: string) =>
  userContext.runWithUser(adminCtx, () => community.renameCommunityItem(type, id, title, { by, reason }));

describe('community item rename (t/4894)', () => {
  beforeAll(() => {
    process.env.AI_TRIAD_DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'commrn-'));
    dataRoot = process.env.AI_TRIAD_DATA_ROOT;
  });
  afterAll(() => {
    fs.rmSync(dataRoot, { recursive: true, force: true });
    delete process.env.AI_TRIAD_DATA_ROOT;
  });
  beforeEach(() => {
    mem = new CasMemBackend();
    fileIO.setBackend(mem);
  });

  it('renames a chat: updates the published file, clears the index, and writes an audit record', async () => {
    const filePath = mem.normAbs(path.join(chatsDir(), 'chat-c1.json'));
    const indexPath = mem.normAbs(path.join(chatsDir(), '_index.json'));
    await mem.writeFile(filePath, JSON.stringify({ id: 'c1', title: 'Old Title' }));
    mem.files.set(indexPath, '[{"id":"c1"}]');

    await rename('chats', 'c1', '  New Title  ', 'github:999', 'typo fix');

    expect(JSON.parse(mem.files.get(filePath)!).title).toBe('New Title'); // trimmed
    expect(mem.files.has(indexPath)).toBe(false); // listing invalidated

    const recs = mem.editRecords();
    expect(recs).toHaveLength(1);
    const audit = JSON.parse(mem.files.get(recs[0])!);
    expect(audit).toMatchObject({
      id: 'c1', type: 'chats', by: 'github:999', from: 'Old Title', to: 'New Title', reason: 'typo fix',
    });
    expect(audit.at).toBeTruthy();
  });

  it('renames a debate and an inquiry using `title`, and an op-ed using `topic`', async () => {
    const debatePath = mem.normAbs(path.join(resolveDataPath('community/debates'), 'debate-d1.json'));
    await mem.writeFile(debatePath, JSON.stringify({ id: 'd1', title: 'Old Debate Title' }));
    await rename('debates', 'd1', 'New Debate Title');
    expect(JSON.parse(mem.files.get(debatePath)!).title).toBe('New Debate Title');

    const inquiryPath = mem.normAbs(path.join(inquiriesDir(), 'inquiry-i1.json'));
    await mem.writeFile(inquiryPath, JSON.stringify({ id: 'i1', title: 'Old Inquiry Title', request: { question: 'Q?' } }));
    await rename('inquiries', 'i1', 'New Inquiry Title');
    expect(JSON.parse(mem.files.get(inquiryPath)!).title).toBe('New Inquiry Title');
    expect(JSON.parse(mem.files.get(inquiryPath)!).request.question).toBe('Q?'); // untouched

    const opedPath = mem.normAbs(path.join(opedsDir(), 'oped-o1.json'));
    await mem.writeFile(opedPath, JSON.stringify({ id: 'o1', topic: 'Old Topic' }));
    await rename('opeds', 'o1', 'New Topic');
    expect(JSON.parse(mem.files.get(opedPath)!).topic).toBe('New Topic');
  });

  it('requires a non-empty `by` (no audit record without an actor)', async () => {
    const filePath = mem.normAbs(path.join(chatsDir(), 'chat-c2.json'));
    await mem.writeFile(filePath, JSON.stringify({ id: 'c2', title: 'T' }));

    await expect(rename('chats', 'c2', 'New', '  ')).rejects.toThrow(/actor/i);
    expect(mem.editRecords()).toHaveLength(0);
    expect(JSON.parse(mem.files.get(filePath)!).title).toBe('T'); // unchanged
  });

  it('rejects an empty title and a title over 200 characters', async () => {
    const filePath = mem.normAbs(path.join(chatsDir(), 'chat-c3.json'));
    await mem.writeFile(filePath, JSON.stringify({ id: 'c3', title: 'T' }));

    await expect(rename('chats', 'c3', '   ')).rejects.toThrow(/1-200 characters/);
    await expect(rename('chats', 'c3', 'x'.repeat(201))).rejects.toThrow(/1-200 characters/);
    expect(mem.editRecords()).toHaveLength(0);
  });

  it('404s when the item does not exist', async () => {
    await expect(rename('chats', 'missing', 'New')).rejects.toMatchObject({ statusCode: 404 });
    expect(mem.editRecords()).toHaveLength(0);
  });

  it('400s on an unsafe id (path traversal) before touching storage', async () => {
    await expect(rename('chats', '../evil', 'New')).rejects.toMatchObject({ statusCode: 400 });
    expect(mem.editRecords()).toHaveLength(0);
  });

  it('a failed audit write means the published file is left unchanged', async () => {
    const filePath = mem.normAbs(path.join(chatsDir(), 'chat-c4.json'));
    await mem.writeFile(filePath, JSON.stringify({ id: 'c4', title: 'Unchanged' }));

    const originalWriteFile = mem.writeFile.bind(mem);
    mem.writeFile = (async (p: string, c: string, opts?: { baseSha?: string }) => {
      if (mem.normAbs(p).includes('/community/_edits/')) throw new Error('storage down');
      return originalWriteFile(p, c, opts);
    }) as typeof mem.writeFile;

    await expect(rename('chats', 'c4', 'New')).rejects.toThrow(/audit trail/);
    expect(JSON.parse(mem.files.get(filePath)!).title).toBe('Unchanged');
    expect(mem.editRecords()).toHaveLength(0);
  });

  it('retries on a lost CAS race and still lands the rename', async () => {
    const filePath = mem.normAbs(path.join(chatsDir(), 'chat-c5.json'));
    await mem.writeFile(filePath, JSON.stringify({ id: 'c5', title: 'Original' }));

    const originalWriteFile = mem.writeFile.bind(mem);
    let calls = 0;
    mem.writeFile = (async (p: string, c: string, opts?: { baseSha?: string }) => {
      if (mem.normAbs(p) === filePath) {
        calls++;
        if (calls === 1) {
          // Simulate another admin's write landing between our read and our write.
          mem.bumpOutOfBand(filePath, JSON.stringify({ id: 'c5', title: 'Concurrent Editor Won' }));
          throw Object.assign(new Error('precondition failed'), { code: 'WRITE_CONFLICT', statusCode: 409 });
        }
      }
      return originalWriteFile(p, c, opts);
    }) as typeof mem.writeFile;

    await rename('chats', 'c5', 'Our Rename');

    expect(JSON.parse(mem.files.get(filePath)!).title).toBe('Our Rename'); // last write wins
    expect(mem.editRecords()).toHaveLength(1); // one audit record (the attempt, not one per retry)
    const audit = JSON.parse(mem.files.get(mem.editRecords()[0])!);
    expect(audit.from).toBe('Original'); // captured at the first read, before the race
  });

  it('after exhausting CAS retries, writes a second audit record with outcome "failed"', async () => {
    const filePath = mem.normAbs(path.join(chatsDir(), 'chat-c6.json'));
    await mem.writeFile(filePath, JSON.stringify({ id: 'c6', title: 'Original' }));

    const originalWriteFile = mem.writeFile.bind(mem);
    mem.writeFile = (async (p: string, c: string, opts?: { baseSha?: string }) => {
      if (mem.normAbs(p) === filePath) {
        // Every attempt loses the race.
        mem.bumpOutOfBand(filePath, JSON.stringify({ id: 'c6', title: 'Always Moving Target' }));
        throw Object.assign(new Error('precondition failed'), { code: 'WRITE_CONFLICT', statusCode: 409 });
      }
      return originalWriteFile(p, c, opts);
    }) as typeof mem.writeFile;

    await expect(rename('chats', 'c6', 'Our Rename')).rejects.toThrow(/did not land/);

    const recs = mem.editRecords().map(k => JSON.parse(mem.files.get(k)!));
    expect(recs).toHaveLength(2);
    const [first, second] = recs.sort((a, b) => (a.outcome ? 1 : -1));
    expect(first.outcome).toBeUndefined(); // original attempt record, left in place
    expect(second.outcome).toBe('failed');
    expect(second.relatedEdit).toBeTruthy();
    // The file was never actually renamed to our title.
    expect(JSON.parse(mem.files.get(filePath)!).title).not.toBe('Our Rename');
  });
});
