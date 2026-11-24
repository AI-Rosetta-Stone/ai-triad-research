// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi } from 'vitest';
import { createReplayFetchGuard } from '../replayFetchGuard.js';

const BASE = 'http://127.0.0.1:7862';

function setup() {
  const fetchImpl = vi.fn(async () => new Response('{"from":"server"}', { status: 200 }));
  const warn = vi.fn();
  const guard = createReplayFetchGuard({ baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch, warn });
  return { guard, fetchImpl, warn };
}

describe('createReplayFetchGuard (t/287)', () => {
  it('sends reads to the server, resolving relative paths against it', async () => {
    const { guard, fetchImpl } = setup();
    const res = await guard.fetch('/api/taxonomy/skeptic');
    expect(await res.json()).toEqual({ from: 'server' });
    expect(String(fetchImpl.mock.calls[0][0])).toBe(`${BASE}/api/taxonomy/skeptic`);
  });

  it('sends the chat-stream generation request to the server', async () => {
    const { guard, fetchImpl } = setup();
    await guard.fetch('/api/ai/chat-stream', { method: 'POST', body: '{}' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('captures a chat save instead of sending it', async () => {
    const { guard, fetchImpl } = setup();
    const res = await guard.fetch('/api/chats', { method: 'PUT', body: JSON.stringify({ id: 'c1' }) });
    expect(res.status).toBe(200);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(guard.savedSessions).toEqual([{ id: 'c1' }]);
    expect(guard.blocked).toEqual([]);
  });

  it.each([
    ['DELETE', '/api/chats/c1'],
    ['POST', '/api/chats/c1/share'],
    ['PUT', '/api/taxonomy/skeptic'],
    ['POST', '/api/ai/generate'],
  ])('refuses %s %s with a WARN and never sends it', async (method, path) => {
    const { guard, fetchImpl, warn } = setup();
    const res = await guard.fetch(path, { method, body: '{}' });
    expect(res.status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(guard.blocked).toEqual([`${method} ${path}`]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`WARN: chat replay refused ${method} ${path}`));
  });

  it('refuses any request to another origin, reads included', async () => {
    const { guard, fetchImpl } = setup();
    const res = await guard.fetch('https://example.invalid/api/taxonomy/skeptic');
    expect(res.status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(guard.blocked).toEqual(['GET https://example.invalid/api/taxonomy/skeptic']);
  });
});
