// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Batch runner for chat regeneration with rate limiting and error handling.
 */

import type { ChatSession, RegeneratedChatSession } from './types.js';

export interface BatchOptions {
  dryRun?: boolean;
  force?: boolean;
  limit?: number; // Max chats to process (for testing)
  rateLimit?: number; // ms between API calls
}

export interface BatchResult {
  succeeded: number;
  failed: number;
  skipped: number;
  errors: Array<{ chatId: string; error: string }>;
}

/**
 * Placeholder for chat replay logic (Phase 5 - to be implemented).
 * This would call the actual app's chat pipeline.
 */
export async function replayChatSession(
  session: ChatSession,
  options: BatchOptions = {},
): Promise<RegeneratedChatSession> {
  if (options.dryRun) {
    // In dry-run mode, just add regeneration metadata without replaying
    return {
      ...session,
      regenerated_at: new Date().toISOString(),
      regenerated_from_version: '1.0.0',
    };
  }

  // Phase 5: Wire in actual chat pipeline here
  // For now, placeholder that marks as regenerated
  return {
    ...session,
    regenerated_at: new Date().toISOString(),
    regenerated_from_version: '1.0.0',
    updated_at: new Date().toISOString(),
  };
}

/**
 * Rate-limited processing of multiple chats.
 * Honors API limits with backoff, continues on errors.
 */
export async function processChatBatch(
  chats: ChatSession[],
  processor: (session: ChatSession) => Promise<RegeneratedChatSession>,
  options: BatchOptions = {},
): Promise<{
  results: RegeneratedChatSession[];
  report: BatchResult;
}> {
  const results: RegeneratedChatSession[] = [];
  const report: BatchResult = {
    succeeded: 0,
    failed: 0,
    skipped: 0,
    errors: [],
  };

  const toProcess = options.limit ? chats.slice(0, options.limit) : chats;
  const rateLimit = options.rateLimit || 100; // 100ms between calls

  for (let i = 0; i < toProcess.length; i++) {
    const chat = toProcess[i];

    // Check if already regenerated
    const regenerated = (chat as Record<string, unknown>).regenerated_at !== undefined;
    if (regenerated && !options.force) {
      report.skipped++;
      continue;
    }

    try {
      const result = await processor(chat);
      results.push(result);
      report.succeeded++;

      // Rate limiting: wait before next request
      if (i < toProcess.length - 1) {
        await new Promise(resolve => setTimeout(resolve, rateLimit));
      }
    } catch (err) {
      report.failed++;
      report.errors.push({
        chatId: chat.id,
        error: String(err),
      });
      // Continue processing despite error
    }
  }

  return { results, report };
}

/**
 * Idempotent batch runner: skips already-regenerated chats unless --force.
 */
export async function runBatch(
  chats: ChatSession[],
  processor: (session: ChatSession) => Promise<RegeneratedChatSession>,
  options: BatchOptions = {},
): Promise<BatchResult> {
  const { results, report } = await processChatBatch(chats, processor, options);

  if (!options.dryRun && results.length > 0) {
    // Here: would write results to storage
    // For now, results are computed but not persisted
  }

  return report;
}
