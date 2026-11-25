// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const bridge = vi.hoisted(() => {
  const generationContextCbs = new Set<(c: { raw_prompt?: string; raw_response?: string }) => void>();
  const streamCalls: { system: string; user: string; model: string }[] = [];
  const api = {
    onChatStreamChunk: () => () => undefined,
    onChatStreamUrlMetadata: () => () => undefined,
    onChatStreamGenerationContext: (cb: (c: { raw_prompt?: string; raw_response?: string }) => void) => {
      generationContextCbs.add(cb);
      return () => { generationContextCbs.delete(cb); };
    },
    startChatStream: async (system: string, messages: { content: string }[], model: string) => {
      streamCalls.push({ system, user: messages[0].content, model });
      const n = streamCalls.length;
      for (const cb of generationContextCbs) cb({ raw_prompt: `RP${n}`, raw_response: `RR${n}` });
      return JSON.stringify({ response: `NEW ${n}`, taxonomy_refs: [] });
    },
    saveChatSession: async () => undefined,
    listChatSessions: async () => [],
    deleteChatSession: async () => undefined,
  };
  return { api, streamCalls };
});

vi.mock('@bridge', () => ({ api: bridge.api, setActiveDebateId: () => undefined, isElectronMode: () => false }));

import { planReplay, replaySessionThroughStore } from '../replayHarness';
import { useTaxonomyStore } from '../../../src/renderer/hooks/useTaxonomyStore';
import type { ChatSession, ChatEntry } from '../../../src/renderer/types/chat';

const entry = (id: string, speaker: ChatEntry['speaker'], content: string): ChatEntry => ({
  id, speaker, content, timestamp: `2026-01-01T00:00:0${id.slice(-1)}.000Z`, taxonomy_refs: [],
});

const session = (transcript: ChatEntry[], extra: Partial<ChatSession> = {}): ChatSession => ({
  id: 'chat-1', title: 't', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:09:00.000Z',
  mode: 'inform', topic: 'compute governance', pover: 'accelerationist', chat_model: 'gemini-2.5-flash', transcript, ...extra,
});

describe('planReplay (t/287)', () => {
  it('maps opening, exchanges and an unanswered user message to store steps', () => {
    const steps = planReplay(session([
      entry('a0', 'accelerationist', 'old opening'), entry('u1', 'user', 'q1'), entry('a2', 'accelerationist', 'old a'), entry('u3', 'user', 'q2'),
    ]));
    expect(steps.map((s) => s.kind)).toEqual(['opening', 'exchange', 'keep']);
  });

  it('refuses an answer with no user message before it', () => {
    expect(() => planReplay(session([entry('u0', 'user', 'q'), entry('a1', 'accelerationist', 'a'), entry('a2', 'accelerationist', 'b')])))
      .toThrow(expect.objectContaining({ problem: expect.stringContaining('Entry 2 is an answer with no user message') }));
  });

  it('refuses an entry from another speaker', () => {
    expect(() => planReplay(session([entry('s0', 'system', 'note')])))
      .toThrow(expect.objectContaining({ problem: expect.stringContaining('speaker "system"') }));
  });
});

describe('replaySessionThroughStore (t/287)', () => {
  beforeEach(() => {
    bridge.streamCalls.length = 0;
    const file = { nodes: [] };
    useTaxonomyStore.setState({ accelerationist: file, safetyist: file, skeptic: file, situations: file } as never);
  });

  it('regenerates each answer in place and keeps user messages untouched', async () => {
    const original = session([
      entry('a0', 'accelerationist', 'old opening'), entry('u1', 'user', 'What about compute limits?'), entry('a2', 'accelerationist', 'old answer'),
    ]);
    const result = await replaySessionThroughStore(original);

    expect(result.transcript.map((e) => [e.id, e.speaker, e.content])).toEqual([
      ['a0', 'accelerationist', 'NEW 1'], ['u1', 'user', 'What about compute limits?'], ['a2', 'accelerationist', 'NEW 2'],
    ]);
    expect(result.transcript[1]).toBe(original.transcript[1]);
    expect(result.transcript[0].timestamp).toBe(original.transcript[0].timestamp);
    expect(result.transcript[2]).toMatchObject({ raw_prompt: 'RP2', raw_response: 'RR2' });
    expect(result.regenerated_at).toBeTruthy();
    // The second turn's prompt is built from the regenerated opening, never the old one.
    expect(bridge.streamCalls[1].user).toContain('NEW 1');
    expect(bridge.streamCalls[1].user).not.toContain('old opening');
    expect(bridge.streamCalls.map((c) => c.model)).toEqual(['gemini-2.5-flash', 'gemini-2.5-flash']);
    expect(original.transcript[0].content).toBe('old opening');
  });

  it('refuses a chat with no recorded model when no fallback is given', async () => {
    await expect(replaySessionThroughStore(session([entry('a0', 'accelerationist', 'x')], { chat_model: undefined })))
      .rejects.toMatchObject({ problem: expect.stringContaining('no chat_model') });
    expect(bridge.streamCalls).toHaveLength(0);
  });

  it('uses the fallback model with a WARN when the chat recorded none', async () => {
    const warn = vi.fn();
    await replaySessionThroughStore(session([entry('a0', 'accelerationist', 'x')], { chat_model: undefined }), { fallbackModel: 'gemini-2.5-pro', warn });
    expect(bridge.streamCalls[0].model).toBe('gemini-2.5-pro');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('WARN: chat chat-1 records no chat_model'));
  });

  it('an override model replaces the recorded one, with a WARN, and is recorded on the result', async () => {
    const warn = vi.fn();
    const result = await replaySessionThroughStore(session([entry('a0', 'accelerationist', 'x')], { chat_model: 'claude-opus-4' }), { overrideModel: 'claude-sonnet-5-5', warn });
    expect(bridge.streamCalls[0].model).toBe('claude-sonnet-5-5');
    expect(result.chat_model).toBe('claude-sonnet-5-5');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('recorded model claude-opus-4; replaying with the override model claude-sonnet-5-5'));
  });

  it('fails the replay when the pipeline produces no answer', async () => {
    const failing = vi.spyOn(bridge.api, 'startChatStream').mockRejectedValueOnce(new Error('boom'));
    await expect(replaySessionThroughStore(session([entry('u0', 'user', 'q'), entry('a1', 'accelerationist', 'a')])))
      .rejects.toMatchObject({ problem: expect.stringContaining('produced no answer') });
    failing.mockRestore();
  });
});
