// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Fetch guard for the headless chat replay (t/287).
 *
 * The replay runs the app's own web bridge and chat store in Node, pointed at a running
 * taxonomy-editor server. The store saves the chat after every answer, and a replay must never
 * write to that server's chat store: the regenerated chat goes to a candidate file, and only the
 * archive-before-replace step writes a store. This guard is the single place that enforces it.
 *
 *   - GET / HEAD                      sent to the server (reads)
 *   - POST /api/ai/chat-stream        sent to the server (the generation itself)
 *   - PUT  /api/chats                 NOT sent; the body is captured and a synthetic 200 returned
 *   - every other request             NOT sent; recorded in `blocked` and answered 403
 */

export interface ReplayFetchGuard {
  /** Drop-in `fetch` that resolves relative URLs against the server and applies the rules above. */
  readonly fetch: typeof fetch;
  /** Chat sessions the store tried to save, in order. The last one is the replayed chat. */
  readonly savedSessions: unknown[];
  /** Requests that were refused, as "METHOD /path". Empty after a clean replay. */
  readonly blocked: string[];
}

export interface ReplayFetchGuardOptions {
  /** Origin of the taxonomy-editor server, e.g. http://127.0.0.1:7862. */
  baseUrl: string;
  /** The real fetch. Injected so tests never touch the network. */
  fetchImpl?: typeof fetch;
  /** Called with a WARN line for each refused request. */
  warn?: (message: string) => void;
}

const CHAT_STREAM_PATH = '/api/ai/chat-stream';
const CHAT_SAVE_PATH = '/api/chats';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function readBody(input: RequestInfo | URL, init: RequestInit | undefined): Promise<string> {
  if (typeof init?.body === 'string') return init.body;
  if (input instanceof Request) return input.clone().text();
  return '';
}

export function createReplayFetchGuard(options: ReplayFetchGuardOptions): ReplayFetchGuard {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const warn = options.warn ?? ((message: string) => { console.warn(message); });
  const savedSessions: unknown[] = [];
  const blocked: string[] = [];

  const guarded = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(rawUrl, options.baseUrl);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const sameOrigin = url.origin === new URL(options.baseUrl).origin;

    if (sameOrigin && (method === 'GET' || method === 'HEAD')) return fetchImpl(url, init);
    if (sameOrigin && method === 'POST' && url.pathname === CHAT_STREAM_PATH) return fetchImpl(url, init);

    if (sameOrigin && method === 'PUT' && url.pathname === CHAT_SAVE_PATH) {
      const body = await readBody(input, init);
      savedSessions.push(body ? JSON.parse(body) : null);
      return jsonResponse(200, { ok: true });
    }

    const label = `${method} ${sameOrigin ? url.pathname : url.href}`;
    blocked.push(label);
    warn(`WARN: chat replay refused ${label}: only reads and ${CHAT_STREAM_PATH} are sent to the server`);
    return jsonResponse(403, { error: `chat replay does not send ${label}` });
  };

  return { fetch: guarded as typeof fetch, savedSessions, blocked };
}
