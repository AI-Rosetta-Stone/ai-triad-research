// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Replay one chat through the app's own chat store (t/287).
 *
 * This module imports renderer code, so it only loads inside a Vite-transformed context: the
 * Vite SSR loader that replayRuntime.ts sets up, or vitest. It drives the store's real actions
 * (generateOpening, sendMessage), so the prompts, taxonomy block, parsing and raw_prompt /
 * raw_response capture are whatever the app does today, with no copy of that logic here.
 *
 * It writes nothing itself. The store saves through the bridge, and replayFetchGuard.ts keeps
 * those saves off the server.
 */

import { useChatStore } from '../../src/renderer/hooks/useChatStore';
import { useTaxonomyStore } from '../../src/renderer/hooks/useTaxonomyStore';
import type { ChatSession, ChatEntry } from '../../src/renderer/types/chat';
import { ActionableError } from '../../../lib/debate/errors';

export const REGENERATION_VERSION = '1.0.0';

export interface ReplayOptions {
  /** Model for a chat that recorded none. A chat's own chat_model wins over this. */
  fallbackModel?: string;
  /** Model to use whatever the chat recorded, e.g. when its own model has been retired. */
  overrideModel?: string;
  /** Called with a WARN line for every fallback taken. */
  warn?: (message: string) => void;
  /** How long to wait for the taxonomy to finish loading. */
  taxonomyTimeoutMs?: number;
}

export type ReplayedChatSession = ChatSession & { regenerated_at: string; regenerated_from_version: string };

type Step =
  | { kind: 'opening'; answer: ChatEntry }
  | { kind: 'exchange'; user: ChatEntry; answer: ChatEntry }
  | { kind: 'keep'; entry: ChatEntry };

function refuse(session: ChatSession, problem: string, nextSteps: string[]): ActionableError {
  return new ActionableError({
    goal: `Replay chat ${session.id} through the current chat pipeline`,
    problem,
    location: 'scripts/chat-regeneration/replayHarness.ts -> replaySessionThroughStore',
    nextSteps,
  });
}

/**
 * Turn the stored transcript into the store actions that reproduce it. The app only ever writes
 * an opening answer, then user message + answer pairs. Anything else is refused, not guessed at.
 */
export function planReplay(session: ChatSession): Step[] {
  const steps: Step[] = [];
  const entries = session.transcript;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.speaker === session.pover) {
      if (i !== 0) {
        throw refuse(session, `Entry ${i} is an answer with no user message before it, which the app never writes.`, [
          'Inspect the chat by hand; this tool does not replay it.',
        ]);
      }
      steps.push({ kind: 'opening', answer: entry });
    } else if (entry.speaker === 'user') {
      const next = entries[i + 1];
      if (next && next.speaker === session.pover) {
        steps.push({ kind: 'exchange', user: entry, answer: next });
        i++;
      } else {
        // A user message that never got an answer. Keep it; do not invent an answer for it.
        steps.push({ kind: 'keep', entry });
      }
    } else {
      throw refuse(session, `Entry ${i} has speaker "${entry.speaker}", which is neither the user nor this chat's POVer (${session.pover}).`, [
        'Inspect the chat by hand; this tool does not replay it.',
      ]);
    }
  }
  return steps;
}

async function ensureTaxonomyLoaded(timeoutMs: number): Promise<void> {
  const loaded = () => {
    const s = useTaxonomyStore.getState();
    return s.accelerationist !== null && s.safetyist !== null && s.skeptic !== null && s.situations !== null;
  };
  if (loaded()) return;
  await useTaxonomyStore.getState().loadAll();
  const deadline = Date.now() + timeoutMs;
  while (!loaded() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  if (!loaded()) {
    const loadError = (useTaxonomyStore.getState() as { loadError?: string | null }).loadError;
    throw new ActionableError({
      goal: 'Load the taxonomy before replaying a chat',
      problem: `The taxonomy did not finish loading within ${timeoutMs} ms${loadError ? `: ${loadError}` : ''}.`,
      location: 'scripts/chat-regeneration/replayHarness.ts -> ensureTaxonomyLoaded',
      nextSteps: ['Check that the server given with --server is running and serves /api/taxonomy/<pov>.'],
    });
  }
}

function lastEntry(session: ChatSession, context: string): ChatEntry {
  const chat = useChatStore.getState().activeChat;
  const entry = chat?.transcript[chat.transcript.length - 1];
  const chatError = useChatStore.getState().chatError;
  if (chatError || !entry || entry.speaker !== session.pover) {
    throw refuse(session, `${context} produced no answer${chatError ? `: ${chatError}` : '.'}`, [
      'Check the server log for the chat-stream request.',
      'Nothing was written to any store; the original chat is unchanged.',
    ]);
  }
  return entry;
}

/** The regenerated answer, in the original entry's place: same id and timestamp, new content. */
function inPlaceOf(original: ChatEntry, regenerated: ChatEntry): ChatEntry {
  return { ...regenerated, id: original.id, timestamp: original.timestamp };
}

/**
 * Replay `session` and return the regenerated chat. User messages are kept exactly as stored.
 * Each answer is generated again by the store and keeps the original entry's id and timestamp,
 * so anything that points at an entry (comments, links) still resolves.
 */
export async function replaySessionThroughStore(session: ChatSession, options: ReplayOptions = {}): Promise<ReplayedChatSession> {
  const warn = options.warn ?? ((message: string) => { console.warn(message); });
  const steps = planReplay(session);

  let model = session.chat_model;
  if (options.overrideModel) {
    if (model !== options.overrideModel) {
      warn(`WARN: chat ${session.id} recorded model ${model ?? '(none)'}; replaying with the override model ${options.overrideModel}`);
    }
    model = options.overrideModel;
  }
  if (!model) {
    if (!options.fallbackModel) {
      throw refuse(session, 'The chat records no chat_model and no fallback model was given.', [
        'Pass --model <id> to name the model for chats that recorded none.',
      ]);
    }
    model = options.fallbackModel;
    warn(`WARN: chat ${session.id} records no chat_model; replaying with the fallback model ${model}`);
  }

  await ensureTaxonomyLoaded(options.taxonomyTimeoutMs ?? 60_000);

  useChatStore.setState({
    activeChatId: session.id,
    activeChat: { ...session, transcript: [] },
    chatModel: model,
    chatGenerating: false,
    chatError: null,
    chatStreamingText: null,
  });

  const transcript: ChatEntry[] = [];
  const syncTranscript = () => {
    const chat = useChatStore.getState().activeChat;
    if (chat) useChatStore.setState({ activeChat: { ...chat, transcript: [...transcript] } });
  };

  for (const step of steps) {
    if (step.kind === 'keep') {
      transcript.push(step.entry);
    } else if (step.kind === 'opening') {
      await useChatStore.getState().generateOpening();
      transcript.push(inPlaceOf(step.answer, lastEntry(session, 'The opening')));
    } else {
      await useChatStore.getState().sendMessage(step.user.content);
      const answer = lastEntry(session, `The answer to user message ${step.user.id}`);
      transcript.push(step.user, inPlaceOf(step.answer, answer));
    }
    // The store appended its own entries (new ids). Put back the in-place transcript so the next
    // turn's prompt is built from the same entries the regenerated chat will hold.
    syncTranscript();
  }

  const now = new Date().toISOString();
  // The regenerated chat records the model that actually wrote its answers.
  return { ...session, chat_model: model, transcript, updated_at: now, regenerated_at: now, regenerated_from_version: REGENERATION_VERSION };
}
