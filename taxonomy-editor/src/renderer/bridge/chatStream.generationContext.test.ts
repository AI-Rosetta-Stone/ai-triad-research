// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4848: the chat-stream 'done' event carries raw_prompt/raw_response for the How panel.
// The web transport must hand them to onGenerationContext listeners BEFORE the stream resolves
// (useChatStore reads them right after startChatStream returns), and must ignore non-strings.

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => null }));
vi.mock('../hooks/useQuotaWarning', () => ({ onQuotaMilestone: vi.fn() }));

import { runChatStream, chatStreamBus } from './chatStream';

function sseResponse(events: Record<string, unknown>[]): Response {
  const body = events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const ARGS = { systemInstruction: 'sys', messages: [{ role: 'user' as const, content: 'hi' }] };

describe('chatStream generation context (t/4848)', () => {
  const unsubs: (() => void)[] = [];
  afterEach(() => { while (unsubs.length) unsubs.pop()!(); });

  it('delivers raw_prompt/raw_response from the done event before the stream resolves', async () => {
    const order: string[] = [];
    unsubs.push(chatStreamBus.onGenerationContext(ctx => { order.push('context'); expect(ctx).toEqual({ raw_prompt: 'System: sys\n\nUser: hi', raw_response: 'hello' }); }));
    unsubs.push(chatStreamBus.onDone(() => order.push('done')));
    const fetchFn = vi.fn().mockResolvedValue(sseResponse([
      { type: 'chunk', text: 'hello' },
      { type: 'done', fullText: 'hello', raw_prompt: 'System: sys\n\nUser: hi', raw_response: 'hello' },
    ]));

    await expect(runChatStream(fetchFn, ARGS)).resolves.toBe('hello');
    expect(order).toEqual(['context', 'done']);
  });

  it('does not fire when the server sends no raw fields (older servers)', async () => {
    const cb = vi.fn();
    unsubs.push(chatStreamBus.onGenerationContext(cb));
    const fetchFn = vi.fn().mockResolvedValue(sseResponse([{ type: 'done', fullText: 'x' }]));
    await runChatStream(fetchFn, ARGS);
    expect(cb).not.toHaveBeenCalled();
  });

  it('drops non-string raw fields instead of passing them through', async () => {
    const cb = vi.fn();
    unsubs.push(chatStreamBus.onGenerationContext(cb));
    const fetchFn = vi.fn().mockResolvedValue(sseResponse([{ type: 'done', fullText: 'x', raw_prompt: 42, raw_response: 'ok' }]));
    await runChatStream(fetchFn, ARGS);
    expect(cb).toHaveBeenCalledWith({ raw_prompt: undefined, raw_response: 'ok' });
  });
});
