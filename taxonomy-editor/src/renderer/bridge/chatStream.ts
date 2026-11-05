// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Chat streaming (SSE) transport for the web bridge (t/2462). Extracted as a leaf module
 * (like httpErrorSteps.ts / resilience.ts) to keep web-bridge.ts under the max-lines cap and
 * to unit-test the SSE parsing/dispatch in isolation.
 *
 * Shape-identical to the Electron preload: startChatStream resolves with the accumulated
 * fullText or rejects with an ActionableError; onChatStream* callbacks fire as events arrive.
 *
 * Server contract (POST /api/ai/chat-stream, t/2457, t/4848):
 *   data: {type:'chunk',text}                              → chunk listeners
 *   data: {type:'chat-stream-url-metadata',urlContextMetadata} → url-metadata listeners
 *   data: {type:'done',fullText,raw_prompt?,raw_response?} → resolve + done listeners, generation context listeners
 *   data: {type:'error',message,code}                      → reject + error listeners
 * Pre-SSE failures (auth / rate limit / missing key) arrive instead as a non-200 JSON body.
 */

import { ActionableError } from '@lib/debate/errors';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { categorizeEndpoint, type ResilientFetchOptions } from './resilience';
import { nextStepsForStatus } from './httpErrorSteps';
import { onQuotaMilestone } from '../hooks/useQuotaWarning';

type ChatChunkCb = (chunk: string) => void;
type ChatDoneCb = (fullText: string) => void;
type ChatErrorCb = (error: string) => void;
type ChatUrlMetadataCb = (metadata: unknown) => void;
// t/4848: callback for raw prompt and response from generation
type ChatGenerationContextCb = (context: { raw_prompt?: string; raw_response?: string }) => void;

const chunkCbs = new Set<ChatChunkCb>();
const doneCbs = new Set<ChatDoneCb>();
const errorCbs = new Set<ChatErrorCb>();
const urlMetadataCbs = new Set<ChatUrlMetadataCb>();
const generationContextCbs = new Set<ChatGenerationContextCb>();

/** Subscription surface exposed via the bridge's onChatStream* methods. */
export const chatStreamBus = {
  onChunk: (cb: ChatChunkCb): (() => void) => { chunkCbs.add(cb); return () => { chunkCbs.delete(cb); }; },
  onDone: (cb: ChatDoneCb): (() => void) => { doneCbs.add(cb); return () => { doneCbs.delete(cb); }; },
  onError: (cb: ChatErrorCb): (() => void) => { errorCbs.add(cb); return () => { errorCbs.delete(cb); }; },
  onUrlMetadata: (cb: ChatUrlMetadataCb): (() => void) => { urlMetadataCbs.add(cb); return () => { urlMetadataCbs.delete(cb); }; },
  // t/4848: expose generation context callback
  onGenerationContext: (cb: ChatGenerationContextCb): (() => void) => { generationContextCbs.add(cb); return () => { generationContextCbs.delete(cb); }; },
};

const CHAT_STREAM_TIMEOUT_MS = 180_000;

function errShape(err: unknown): { name: string; message: string; stack?: string } {
  return { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack };
}

function emitError(message: string): void {
  for (const cb of errorCbs) {
    try { cb(message); } catch { /* telemetry — silent by design */ }
  }
}

/** Parse an SSE byte stream, invoking `onEvent` once per `data:` JSON payload. */
async function consumeSse(res: Response, onEvent: (evt: Record<string, unknown>) => void): Promise<void> {
  const reader = res.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const data = frame
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.replace(/^data:\s?/, ''))
        .join('\n');
      if (!data) continue;
      try {
        onEvent(JSON.parse(data) as Record<string, unknown>);
      } catch (err) {
        getGlobalRecorder()?.record({ type: 'system.error', component: 'web-bridge', level: 'warn', message: 'chat-stream: malformed SSE data frame', error: errShape(err) });
      }
    }
  }
}

/** Build a normalized ActionableError from a non-200 chat-stream response (JSON error emitted
 *  before SSE headers). Mirrors the AI-relevant branches of web-bridge `post()`. */
async function buildHttpError(res: Response): Promise<ActionableError> {
  const budgetWarning = res.headers.get('X-Token-Budget-Warning');
  if (budgetWarning) {
    const milestone = parseInt(budgetWarning, 10);
    if (!isNaN(milestone) && milestone >= 0 && milestone <= 100) {
      onQuotaMilestone(milestone, res.headers.get('X-Token-Budget-Resets') ?? undefined);
    }
  }
  if (res.status === 429) {
    const data = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (data.limitType === 'tokens_per_day' && !budgetWarning) onQuotaMilestone(100, data.resetsAt as string | undefined);
    const msg = data.limitType === 'tokens_per_day'
      ? 'Daily token limit exceeded. Try again tomorrow or use your own API key.'
      : `Rate limit exceeded. Retry in ${Math.ceil(((data.retryAfterMs as number) || 60_000) / 1000)}s.`;
    const err = new ActionableError({ goal: 'Stream chat response', problem: msg, location: 'chatStream.startChatStream', nextSteps: ['Wait for the rate limit to reset', 'Use your own API key to avoid shared limits'] });
    (err as ActionableError & { httpStatus: number; limitType: string }).httpStatus = 429;
    (err as ActionableError & { limitType: string }).limitType = String(data.limitType ?? '');
    return err;
  }
  if (res.status === 422) {
    const data = await res.json().catch(() => ({})) as Record<string, unknown>;
    const err = new ActionableError({ goal: 'Stream chat response', problem: (data.message as string) || 'No API key configured for the selected backend.', location: 'chatStream.startChatStream', nextSteps: ['Open Settings → API Keys and add a key for this backend', 'Switch to a backend that has a key configured'] });
    (err as ActionableError & { httpStatus: number }).httpStatus = 422;
    return err;
  }
  const text = await res.text().catch(() => '');
  const err = new ActionableError({ goal: 'Stream chat response', problem: `POST /api/ai/chat-stream failed with HTTP ${res.status}: ${text}`, location: 'chatStream.startChatStream', nextSteps: nextStepsForStatus(res.status, text) });
  (err as ActionableError & { httpStatus: number }).httpStatus = res.status;
  return err;
}

export interface ChatStreamArgs {
  systemInstruction: string;
  messages: { role: 'user' | 'model'; content: string }[];
  model?: string;
  temperature?: number;
  urlContext?: boolean;
  /** Chat/debate linkage for observability (t/2490 Gap 2): sent on the POST body so the
   *  server ai.request carries it (t/2494), and included on the client ai.request event.
   *  linkedDebateId has no source in the current chat model (POVer chats aren't
   *  debate-linked) — wired as a forward-compatible passthrough, absent for now. */
  chatSessionId?: string;
  linkedDebateId?: string;
}

/** The web bridge's session-recovering fetch (injected to avoid a circular import). */
type ChatFetch = (path: string, init: RequestInit, opts: ResilientFetchOptions) => Promise<Response>;

/** Drive one chat-stream request: POST → read SSE body → dispatch. Resolves the accumulated
 *  fullText, or rejects with an ActionableError (also surfaced to onChatStreamError listeners). */
export async function runChatStream(fetchFn: ChatFetch, args: ChatStreamArgs): Promise<string> {
  const { systemInstruction, messages, model, temperature, urlContext, chatSessionId, linkedDebateId } = args;
  const requestId = crypto.randomUUID();
  // Chat/debate linkage → server ai.request (t/2494). JSON.stringify drops undefined keys, so
  // absent chatSessionId/linkedDebateId simply don't appear on the wire (absent-tolerant).
  const body: Record<string, unknown> = { systemInstruction, messages, model, temperature, urlContext: !!urlContext, chatSessionId, linkedDebateId };
  const byokKey = sessionStorage.getItem('byok-api-key');
  if (byokKey) body.apiKey = byokKey;
  // t/2490 Gap 2: chat/debate linkage on the client ai.request makes the anon-chat-403 root
  // cause self-evident without cross-referencing the context block (undefined fields drop out).
  getGlobalRecorder()?.record({ type: 'ai.request', component: 'web-bridge', level: 'info', message: `chat-stream request: ${model ?? 'default'}`, data: { requestId, urlContext: !!urlContext, messageCount: messages.length, chatSessionId, linkedDebateId } });

  const path = '/api/ai/chat-stream';
  let res: Response;
  try {
    res = await fetchFn(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-request-id': requestId },
      body: JSON.stringify(body),
    }, {
      timeoutMs: CHAT_STREAM_TIMEOUT_MS,
      maxRetries: 0, // POST mutation — never auto-retry (Client Network Resilience rule 2)
      critical: true,
      category: categorizeEndpoint(path, 'POST'),
    });
  } catch (err) {
    getGlobalRecorder()?.record({ type: 'system.error', component: 'web-bridge', level: 'error', message: 'chat-stream network error', error: errShape(err) });
    const failure = (err instanceof DOMException && err.name === 'AbortError')
      ? new ActionableError({ goal: 'Stream chat response', problem: `chat-stream timed out after ${Math.round(CHAT_STREAM_TIMEOUT_MS / 1000)}s`, location: 'chatStream.startChatStream', nextSteps: ['The server may be overloaded — try again', 'Check server logs for errors'] })
      : (err as Error);
    emitError(failure.message ?? String(failure));
    throw failure;
  }

  // Non-200 responses are JSON errors (server writes them before committing SSE headers).
  if (!res.ok) {
    const err = await buildHttpError(res);
    emitError(err.message);
    throw err;
  }

  let fullText = '';
  let streamError: ActionableError | null = null;
  try {
    await consumeSse(res, (evt) => {
      switch (evt.type) {
        case 'chunk': {
          const text = typeof evt.text === 'string' ? evt.text : '';
          if (text) { fullText += text; for (const cb of chunkCbs) cb(text); }
          break;
        }
        case 'chat-stream-url-metadata':
          for (const cb of urlMetadataCbs) cb(evt.urlContextMetadata);
          break;
        case 'done':
          if (typeof evt.fullText === 'string') fullText = evt.fullText;
          // t/4848: dispatch generation context (raw prompt and response) for the How panel
          if (evt.raw_prompt !== undefined || evt.raw_response !== undefined) {
            for (const cb of generationContextCbs) cb({ raw_prompt: evt.raw_prompt as string | undefined, raw_response: evt.raw_response as string | undefined });
          }
          break;
        case 'error': {
          const evtProblem = typeof evt.problem === 'string' ? evt.problem : (typeof evt.message === 'string' ? evt.message : 'The chat stream failed on the server.');
          streamError = new ActionableError({ goal: 'Stream chat response', problem: evtProblem, location: 'chatStream.startChatStream', nextSteps: ['Try sending your message again', 'Check server logs for errors'] });
          break;
        }
      }
    });
  } catch (err) {
    getGlobalRecorder()?.record({ type: 'system.error', component: 'web-bridge', level: 'error', message: 'chat-stream: reading the SSE body failed', error: errShape(err) });
    const failure = new ActionableError({ goal: 'Stream chat response', problem: `The chat stream was interrupted: ${String(err)}`, location: 'chatStream.startChatStream', nextSteps: ['Check your network connection and try again'] });
    emitError(failure.message);
    throw failure;
  }

  if (streamError) {
    const e: ActionableError = streamError;
    emitError(e.message);
    throw e;
  }
  for (const cb of doneCbs) cb(fullText);
  return fullText;
}
