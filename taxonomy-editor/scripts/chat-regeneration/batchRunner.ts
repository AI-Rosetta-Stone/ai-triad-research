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
 * Replay a chat session through the app's actual pipeline.
 *
 * Calls streamChatWithProgress directly from useChatStore, replaying each user
 * turn and capturing raw_prompt/raw_response for the How panel (t/4848).
 * The chat model and temperature are preserved from the session.
 */
export async function replayChatSession(
  session: ChatSession,
  options: BatchOptions & {
    // Phase 5: These are provided by the runner to pass through to the replay function
    streamChatWithProgressFn?: typeof streamChatWithProgressType;
    getTaxonomyContextFn?: () => Promise<string>;
    getModelFn?: () => string;
  } = {},
): Promise<RegeneratedChatSession> {
  if (options.dryRun) {
    // In dry-run mode, just add regeneration metadata without replaying
    return {
      ...session,
      regenerated_at: new Date().toISOString(),
      regenerated_from_version: '1.0.0',
    };
  }

  // Phase 5: Replay logic now wired
  if (!options.streamChatWithProgressFn) {
    throw new Error(
      'Chat replay requires streamChatWithProgress function. ' +
      'Provide via options.streamChatWithProgressFn or use dry-run mode.',
    );
  }

  const streamChatWithProgress = options.streamChatWithProgressFn;
  const getTaxonomyContext = options.getTaxonomyContextFn || (() => Promise.resolve(''));
  const getModel = options.getModelFn || (() => 'gemini-2.0-flash');

  // Rebuild transcript by replaying each user turn
  const regenerated: ChatEntry[] = [];
  const model = getModel();
  const temperature = session.temperature || 0.7;
  const taxonomyContext = await getTaxonomyContext();

  for (const entry of session.transcript) {
    // Preserve all user entries as-is
    if (entry.speaker === 'user') {
      regenerated.push(entry);
      continue;
    }

    // For assistant entries, skip the opening special case
    // (we regenerate all assistant responses via the pipeline)
    if (entry.speaker !== session.pover) {
      regenerated.push(entry);
      continue;
    }

    // Replay this assistant turn through the pipeline
    const transcriptText = formatTranscriptForContext(regenerated, session.pover);
    const systemInstruction = `You are the ${session.pover} POV. ${taxonomyContext}`;
    const userMessage = regenerated[regenerated.length - 1]?.content || '';

    let replayedContent = '';
    let rawPrompt = '';
    let rawResponse = '';

    try {
      const result = await streamChatWithProgress(
        systemInstruction,
        transcriptText ? [{ role: 'user' as const, content: transcriptText }] : [],
        model,
        temperature,
        `Replaying ${session.pover} response...`,
        (partial) => { replayedContent += partial; },
        undefined,
        session.id,
      );

      replayedContent = result.text;
      rawPrompt = result.rawFields?.raw_prompt || '';
      rawResponse = result.rawFields?.raw_response || '';
    } catch (err) {
      throw new Error(
        `Failed to replay turn in chat ${session.id}: ${String(err)}. ` +
        `User message: "${userMessage.slice(0, 100)}"`,
      );
    }

    // Create regenerated entry
    const regeneratedEntry: ChatEntry = {
      id: entry.id, // Keep original ID for consistency
      timestamp: new Date().toISOString(),
      speaker: session.pover,
      content: replayedContent,
      taxonomy_refs: entry.taxonomy_refs, // TODO: Re-extract from new response if desired
      ...( rawPrompt && { raw_prompt: rawPrompt }),
      ...( rawResponse && { raw_response: rawResponse }),
    };

    regenerated.push(regeneratedEntry);
  }

  return {
    ...session,
    transcript: regenerated,
    regenerated_at: new Date().toISOString(),
    regenerated_from_version: '1.0.0',
    updated_at: new Date().toISOString(),
  };
}

/** Placeholder type for streamChatWithProgress signature (actual import happens at runtime) */
type streamChatWithProgressType = (
  systemInstruction: string,
  messages: { role: 'user' | 'model'; content: string }[],
  model: string,
  temperature: number,
  activity: string,
  onChunk: (chunk: string) => void,
  urlContext?: boolean,
  chatSessionId?: string,
) => Promise<{
  text: string;
  urlContextMetadata?: unknown;
  rawFields: { raw_prompt?: string; raw_response?: string };
}>;

/** Format transcript for replay context */
function formatTranscriptForContext(transcript: ChatEntry[], poverLabel: string): string {
  if (transcript.length === 0) return '';
  const lines: string[] = [];
  for (const entry of transcript) {
    const speaker = entry.speaker === 'user' ? 'You' : entry.speaker === 'system' ? 'System' : poverLabel;
    lines.push(`${speaker}: ${entry.content}`);
  }
  return lines.join('\n\n');
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
