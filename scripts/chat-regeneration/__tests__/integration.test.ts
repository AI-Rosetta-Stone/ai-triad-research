// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import { archiveChat, listArchivedVersions, restoreChat, replaceChat, updateIndex, type StorageBackendAdapter } from '../archive.js';
import { createFilesystemBackend } from '../filesystemBackend.js';
import { analyzeChatSession, generateDryRunReport, formatDryRunReport } from '../dryRun.js';
import { replayChatSession, processChatBatch } from '../batchRunner.js';
import { oldChatFixture, newChatFixture } from '../fixtures/index.js';
import type { ChatSession } from '../types.js';

describe('Archive Module with Backend Adapter', () => {
  let tempDir: string;
  let backend: StorageBackendAdapter;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-regen-test-'));
    backend = createFilesystemBackend();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('archives a chat session to _archive directory', async () => {
    const archived = await archiveChat(oldChatFixture, tempDir, { backend });
    expect(archived).toContain('_archive');
    expect(archived).toContain(oldChatFixture.id);
    // Verify file exists
    const content = await backend.readFile(archived);
    expect(content).toBeTruthy();
  });

  it('dry-run does not create archive file', async () => {
    await archiveChat(oldChatFixture, tempDir, { dryRun: true, backend });
    const archiveDir = path.join(tempDir, '_archive');
    const files = await backend.listDir(archiveDir);
    expect(files.length).toBe(0);
  });

  it('lists archived versions in reverse chronological order', async () => {
    await archiveChat(oldChatFixture, tempDir, { backend });
    await new Promise(resolve => setTimeout(resolve, 100));
    await archiveChat(oldChatFixture, tempDir, { backend });

    const archived = await listArchivedVersions(oldChatFixture.id, tempDir, backend);
    expect(archived.length).toBe(2);
    expect(archived[0].timestamp).toBeGreaterThan(archived[1].timestamp);
  });

  it('restores most recent archived version', async () => {
    const modified = { ...oldChatFixture, title: 'Modified Title' };
    await archiveChat(oldChatFixture, tempDir, { backend });
    await backend.writeFile(path.join(tempDir, `${oldChatFixture.id}.json`), JSON.stringify(modified));

    const restored = await restoreChat(oldChatFixture.id, tempDir, backend, { dryRun: true });
    expect((restored as ChatSession).title).toBe(oldChatFixture.title);
  });

  it('replaces chat atomically: archive then write', async () => {
    const regenerated = { ...oldChatFixture, updated_at: '2026-11-15T00:00:00Z' };
    await replaceChat(oldChatFixture, regenerated, tempDir, backend, { dryRun: true, backend });
    // In dry-run mode, no files are created
  });

  it('updates index atomically', async () => {
    const indexPath = path.join(tempDir, '_index.json');
    const chatsToAdd = [oldChatFixture, newChatFixture];

    await updateIndex(indexPath, [], chatsToAdd, backend, { dryRun: false });

    const content = await backend.readFile(indexPath);
    expect(content).toBeTruthy();
    const index = JSON.parse(content!);
    expect(index[oldChatFixture.id]).toBeDefined();
    expect(index[newChatFixture.id]).toBeDefined();
  });
});

describe('Dry Run Module', () => {
  it('analyzes old chat: estimates calls correctly', () => {
    const plan = analyzeChatSession(oldChatFixture);
    expect(plan.id).toBe(oldChatFixture.id);
    expect(plan.userTurns).toBe(2);
    expect(plan.assistantTurns).toBe(2);
    expect(plan.estimatedCalls).toBe(2);
    expect(plan.alreadyRegenerated).toBe(false);
  });

  it('skips already-regenerated chats', () => {
    const regenerated = { ...oldChatFixture, regenerated_at: '2026-11-15T00:00:00Z' } as unknown as ChatSession;
    const plan = analyzeChatSession(regenerated);
    expect(plan.alreadyRegenerated).toBe(true);
    expect(plan.reason).toContain('Already regenerated');
  });

  it('regenerates already-regenerated chats with --force', () => {
    const regenerated = { ...oldChatFixture, regenerated_at: '2026-11-15T00:00:00Z' } as unknown as ChatSession;
    const plan = analyzeChatSession(regenerated, { force: true });
    expect(plan.alreadyRegenerated).toBe(false);
    expect(plan.estimatedCalls).toBe(2);
  });

  it('generates dry-run report with totals', () => {
    const chats = [oldChatFixture, newChatFixture];
    const report = generateDryRunReport(chats, 'both');
    expect(report.totalChats).toBe(2);
    expect(report.toRegenerate).toBeGreaterThan(0);
    expect(report.totalEstimatedCalls).toBeGreaterThan(0);
  });

  it('formats dry-run report as human-readable text', () => {
    const chats = [oldChatFixture];
    const report = generateDryRunReport(chats);
    const text = formatDryRunReport(report);
    expect(text).toContain('Batch Regeneration Dry Run');
    expect(text).toContain('Total chats: 1');
    expect(text).toContain(oldChatFixture.id);
  });

  it('handles chats with errors in report', () => {
    const malformed = { id: 'bad-chat', transcript: null } as unknown as ChatSession;
    const chats = [oldChatFixture, malformed];
    const report = generateDryRunReport(chats);
    expect(report.errors.length).toBeGreaterThan(0);
  });
});

describe('Batch Runner Module', () => {
  it('replay in dry-run mode works without pipeline', async () => {
    const regenerated = await replayChatSession(oldChatFixture, { dryRun: true });
    expect(regenerated.regenerated_at).toBeDefined();
    expect(regenerated.id).toBe(oldChatFixture.id);
  });

  it('replay in apply mode throws Phase 5 not-wired error', async () => {
    const error = await replayChatSession(oldChatFixture, { dryRun: false }).catch(e => e);
    expect(error).toBeTruthy();
    expect(error.message).toContain('Phase 5');
  });

  it('processes batch with rate limiting', async () => {
    const chats = [oldChatFixture, newChatFixture];
    const processor = async (s: ChatSession) => replayChatSession(s, { dryRun: true });

    const { results, report } = await processChatBatch(chats, processor, {
      dryRun: true,
      rateLimit: 10,
    });

    expect(report.succeeded).toBe(2);
    expect(report.failed).toBe(0);
    expect(results.length).toBe(2);
  });

  it('skips already-regenerated chats in batch', async () => {
    const regenerated = { ...oldChatFixture, regenerated_at: '2026-11-15T00:00:00Z' } as unknown as ChatSession;
    const processor = async (s: ChatSession) => replayChatSession(s, { dryRun: true });

    const { report } = await processChatBatch([regenerated], processor, { dryRun: true });
    expect(report.skipped).toBe(1);
    expect(report.succeeded).toBe(0);
  });

  it('continues on error with detailed report', async () => {
    const badChat = { id: 'bad', transcript: null } as unknown as ChatSession;
    const processor = async (s: ChatSession) => {
      if (!Array.isArray(s.transcript)) throw new Error('Invalid transcript');
      return replayChatSession(s, { dryRun: true });
    };

    const { report } = await processChatBatch([badChat], processor, { dryRun: true });
    expect(report.failed).toBe(1);
    expect(report.errors[0].chatId).toBe('bad');
  });

  it('respects limit option for batch size', async () => {
    const chats = [oldChatFixture, newChatFixture, oldChatFixture];
    const processor = async (s: ChatSession) => replayChatSession(s, { dryRun: true });

    const { results } = await processChatBatch(chats, processor, {
      dryRun: true,
      limit: 2,
    });

    expect(results.length).toBeLessThanOrEqual(2);
  });
});
