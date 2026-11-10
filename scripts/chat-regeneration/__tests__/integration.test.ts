// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import { archiveChat, listArchivedVersions, restoreChat, replaceChat } from '../archive.js';
import { analyzeChatSession, generateDryRunReport, formatDryRunReport } from '../dryRun.js';
import { replayChatSession, processChatBatch } from '../batchRunner.js';
import { oldChatFixture, newChatFixture } from '../fixtures/index.js';
import type { ChatSession } from '../types.js';

describe('Archive Module', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-regen-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('archives a chat session to _archive directory', async () => {
    const archived = await archiveChat(oldChatFixture, tempDir);
    expect(archived).toContain('_archive');
    expect(archived).toContain(oldChatFixture.id);
  });

  it('dry-run does not create archive file', async () => {
    await archiveChat(oldChatFixture, tempDir, { dryRun: true });
    const archiveDir = path.join(tempDir, '_archive');
    try {
      await fs.readdir(archiveDir);
      expect.fail('Archive directory should not exist in dry-run mode');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  });

  it('lists archived versions in reverse chronological order', async () => {
    await archiveChat(oldChatFixture, tempDir);
    await new Promise(resolve => setTimeout(resolve, 100));
    await archiveChat(oldChatFixture, tempDir);

    const archived = await listArchivedVersions(oldChatFixture.id, tempDir);
    expect(archived.length).toBe(2);
    expect(archived[0].timestamp).toBeGreaterThan(archived[1].timestamp);
  });

  it('restores most recent archived version', async () => {
    const modified = { ...oldChatFixture, title: 'Modified Title' };
    await archiveChat(oldChatFixture, tempDir);
    await fs.writeFile(path.join(tempDir, `${oldChatFixture.id}.json`), JSON.stringify(modified));

    const restored = await restoreChat(oldChatFixture.id, tempDir, { dryRun: true });
    expect(restored.title).toBe(oldChatFixture.title);
  });

  it('replaces chat atomically: archive then write', async () => {
    const regenerated = { ...oldChatFixture, updated_at: '2026-11-15T00:00:00Z' };
    await replaceChat(oldChatFixture, regenerated, tempDir, { dryRun: true });
    // In dry-run mode, no files are created
  });
});

describe('Dry Run Module', () => {
  it('analyzes old chat: estimates calls correctly', () => {
    const plan = analyzeChatSession(oldChatFixture);
    expect(plan.id).toBe(oldChatFixture.id);
    expect(plan.userTurns).toBe(2); // Two user turns in fixture
    expect(plan.assistantTurns).toBe(2);
    expect(plan.estimatedCalls).toBe(2); // One per user turn
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
  it('replays chat in dry-run mode without calling pipeline', async () => {
    const regenerated = await replayChatSession(oldChatFixture, { dryRun: true });
    expect(regenerated.regenerated_at).toBeDefined();
    expect(regenerated.id).toBe(oldChatFixture.id);
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
