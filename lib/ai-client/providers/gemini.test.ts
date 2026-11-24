import { describe, it, expect } from 'vitest';
import { mapGeminiError, generateViaGemini, generateViaGeminiStream } from './gemini.js';
import { ActionableError } from '../../debate/errors.js';
import type { FetchFn } from '../types.js';

function geminiErrorBody(status: string, reason?: string): string {
  const details = reason ? [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason }] : [];
  return JSON.stringify({ error: { code: 401, message: 'Auth error', status, details } });
}

describe('mapGeminiError', () => {
  it('maps ACCESS_TOKEN_TYPE_UNSUPPORTED to OAuth-specific guidance', () => {
    const body = geminiErrorBody('UNAUTHENTICATED', 'ACCESS_TOKEN_TYPE_UNSUPPORTED');
    const err = mapGeminiError(401, body);
    expect(err).toBeInstanceOf(ActionableError);
    expect(err.message).toContain('OAuth access token');
    expect(err.nextSteps.join(' ')).toContain('AIza');
  });

  it('maps generic 401 UNAUTHENTICATED to invalid-key guidance', () => {
    const body = geminiErrorBody('UNAUTHENTICATED', 'API_KEY_INVALID');
    const err = mapGeminiError(401, body);
    expect(err).toBeInstanceOf(ActionableError);
    expect(err.message).toContain('UNAUTHENTICATED');
    expect(err.nextSteps.join(' ')).toContain('invalid or revoked');
  });

  it('maps 401 without parseable reason to invalid-key guidance', () => {
    const err = mapGeminiError(401, 'not json');
    expect(err).toBeInstanceOf(ActionableError);
    expect(err.nextSteps.join(' ')).toContain('invalid or revoked');
  });

  it('maps 403 PERMISSION_DENIED to permission guidance', () => {
    const body = geminiErrorBody('PERMISSION_DENIED');
    const err = mapGeminiError(403, body);
    expect(err).toBeInstanceOf(ActionableError);
    expect(err.message).toContain('PERMISSION_DENIED');
    expect(err.nextSteps.join(' ')).toContain('permission');
  });

  it('maps 404 NOT_FOUND to model-not-found guidance', () => {
    const body = JSON.stringify({ error: { code: 404, message: 'Model not found', status: 'NOT_FOUND', details: [] } });
    const err = mapGeminiError(404, body);
    expect(err).toBeInstanceOf(ActionableError);
    expect(err.message).toContain('NOT_FOUND');
    expect(err.nextSteps.join(' ')).toContain('model ID');
  });

  it('falls through to generic error for unknown status codes', () => {
    const body = JSON.stringify({ error: { code: 500, message: 'Internal', status: 'INTERNAL', details: [] } });
    const err = mapGeminiError(500, body);
    expect(err).toBeInstanceOf(ActionableError);
    expect(err.message).toContain('500');
    expect(err.nextSteps).toContain('Check your API key');
  });

  it('preserves raw body text in error message for flight recorder', () => {
    const body = geminiErrorBody('UNAUTHENTICATED', 'ACCESS_TOKEN_TYPE_UNSUPPORTED');
    const err = mapGeminiError(401, body);
    expect(err.message).toContain('ACCESS_TOKEN_TYPE_UNSUPPORTED');
  });

  it('handles error JSON with no details array', () => {
    const body = JSON.stringify({ error: { code: 401, message: 'Bad key', status: 'UNAUTHENTICATED' } });
    const err = mapGeminiError(401, body);
    expect(err.nextSteps.join(' ')).toContain('invalid or revoked');
  });

  it('detects UNAUTHENTICATED via errorStatus even when HTTP status is not 401', () => {
    const body = geminiErrorBody('UNAUTHENTICATED', 'ACCESS_TOKEN_TYPE_UNSUPPORTED');
    const err = mapGeminiError(400, body);
    expect(err.message).toContain('OAuth access token');
  });
});

// ── urlContext tool injection ────────────────────────────────────────────────

function makeFetch(responseBody: unknown, status = 200): FetchFn {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(responseBody),
    body: null,
  } as unknown as Response);
}

function geminiResponse(text: string, urlContextMetadata?: unknown) {
  const candidate: Record<string, unknown> = {
    content: { parts: [{ text }] },
  };
  if (urlContextMetadata !== undefined) candidate.urlContextMetadata = urlContextMetadata;
  return { candidates: [candidate], usageMetadata: {} };
}

describe('generateViaGemini — urlContext', () => {
  it('omits url_context tool when urlContext is not set', async () => {
    let capturedBody = '';
    const fetchFn: FetchFn = async (_url, init) => {
      capturedBody = init?.body as string;
      return { ok: true, status: 200, text: async () => JSON.stringify(geminiResponse('hello')), body: null } as unknown as Response;
    };
    await generateViaGemini(fetchFn, 'prompt', 'gemini-pro', 'key', { timeoutMs: 5000 });
    const parsed = JSON.parse(capturedBody);
    expect(parsed.tools).toBeUndefined();
  });

  it('includes url_context tool when urlContext is true', async () => {
    let capturedBody = '';
    const fetchFn: FetchFn = async (_url, init) => {
      capturedBody = init?.body as string;
      return { ok: true, status: 200, text: async () => JSON.stringify(geminiResponse('hello')), body: null } as unknown as Response;
    };
    await generateViaGemini(fetchFn, 'prompt', 'gemini-pro', 'key', { timeoutMs: 5000, urlContext: true });
    const parsed = JSON.parse(capturedBody);
    expect(parsed.tools).toEqual(expect.arrayContaining([{ url_context: {} }]));
  });

  it('parses urlContextMetadata when present in response', async () => {
    const meta = { urlMetadata: [{ retrievedUrl: 'https://example.com', urlRetrievalStatus: 'URL_RETRIEVAL_STATUS_SUCCESS' }] };
    const fetchFn = makeFetch(geminiResponse('hello', meta));
    const result = await generateViaGemini(fetchFn, 'prompt', 'gemini-pro', 'key', { timeoutMs: 5000, urlContext: true });
    expect(result.urlContextMetadata).toEqual({ urlMetadata: [{ retrievedUrl: 'https://example.com', urlRetrievalStatus: 'URL_RETRIEVAL_STATUS_SUCCESS' }] });
  });

  it('tolerates absent urlContextMetadata', async () => {
    const fetchFn = makeFetch(geminiResponse('hello'));
    const result = await generateViaGemini(fetchFn, 'prompt', 'gemini-pro', 'key', { timeoutMs: 5000, urlContext: true });
    expect(result.urlContextMetadata).toBeUndefined();
  });
});

// ── streaming path ───────────────────────────────────────────────────────────

function makeStreamFetch(chunks: unknown[]): FetchFn {
  return async () => {
    const encoder = new TextEncoder();
    const lines = chunks.map(c => `data: ${JSON.stringify(c)}\n`).join('\n');
    const encoded = encoder.encode(lines);
    let pos = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pos >= encoded.length) { controller.close(); return; }
        controller.enqueue(encoded.slice(pos, pos + 64));
        pos += 64;
      },
    });
    return { ok: true, status: 200, body: stream } as unknown as Response;
  };
}

function streamChunk(text: string, urlContextMetadata?: unknown) {
  const candidate: Record<string, unknown> = { content: { parts: [{ text }] } };
  if (urlContextMetadata !== undefined) candidate.urlContextMetadata = urlContextMetadata;
  return { candidates: [candidate] };
}

describe('generateViaGeminiStream — urlContext', () => {
  it('includes url_context tool in streaming request when urlContext is true', async () => {
    let capturedBody = '';
    const fetchFn: FetchFn = async (_url, init) => {
      capturedBody = init?.body as string;
      const encoder = new TextEncoder();
      const data = encoder.encode(`data: ${JSON.stringify(streamChunk('hi'))}\n`);
      const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(data); c.close(); } });
      return { ok: true, status: 200, body: stream } as unknown as Response;
    };
    await generateViaGeminiStream(fetchFn, 'prompt', 'gemini-pro', 'key', { timeoutMs: 5000, urlContext: true });
    const parsed = JSON.parse(capturedBody);
    expect(parsed.tools).toEqual(expect.arrayContaining([{ url_context: {} }]));
  });

  it('accumulates streamed text and surfaces urlContextMetadata from last chunk', async () => {
    const meta = { urlMetadata: [{ retrievedUrl: 'https://example.com', urlRetrievalStatus: 'URL_RETRIEVAL_STATUS_SUCCESS' }] };
    const fetchFn = makeStreamFetch([streamChunk('hel'), streamChunk('lo', meta)]);
    const chunks: string[] = [];
    const result = await generateViaGeminiStream(fetchFn, 'p', 'gemini-pro', 'key', { timeoutMs: 5000, urlContext: true }, c => chunks.push(c));
    expect(result.text).toBe('hello');
    expect(chunks).toEqual(['hel', 'lo']);
    expect(result.urlContextMetadata).toEqual({ urlMetadata: [{ retrievedUrl: 'https://example.com', urlRetrievalStatus: 'URL_RETRIEVAL_STATUS_SUCCESS' }] });
  });

  // t/494: the stream returns the call's usage, from the final chunk's cumulative usageMetadata.
  it('returns usage from the final stream chunk (cumulative usageMetadata)', async () => {
    const early = { ...streamChunk('hel'), usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 1 } };
    const last = {
      ...streamChunk('lo'),
      usageMetadata: { promptTokenCount: 150000, candidatesTokenCount: 42, cachedContentTokenCount: 0, totalTokenCount: 150042 },
    };
    const fetchFn = makeStreamFetch([early, last]);
    const result = await generateViaGeminiStream(fetchFn, 'p', 'gemini-pro', 'key', { timeoutMs: 5000 });
    expect(result.usage).toEqual({
      promptTokens: 150000, completionTokens: 42, cachedTokens: 0, totalTokens: 150042,
    });
  });

  it('leaves usage undefined when the stream carries no usageMetadata', async () => {
    const fetchFn = makeStreamFetch([streamChunk('ok')]);
    const result = await generateViaGeminiStream(fetchFn, 'p', 'gemini-pro', 'key', { timeoutMs: 5000 });
    expect(result.usage).toBeUndefined();
  });

  it('tolerates absent urlContextMetadata in streaming response', async () => {
    const fetchFn = makeStreamFetch([streamChunk('ok')]);
    const result = await generateViaGeminiStream(fetchFn, 'p', 'gemini-pro', 'key', { timeoutMs: 5000, urlContext: true });
    expect(result.text).toBe('ok');
    expect(result.urlContextMetadata).toBeUndefined();
  });

  it('sends geminiContents directly when provided, bypassing single-prompt construction', async () => {
    let capturedBody = '';
    const fetchFn: FetchFn = async (_url, init) => {
      capturedBody = init?.body as string;
      const encoder = new TextEncoder();
      const data = encoder.encode(`data: ${JSON.stringify(streamChunk('reply'))}\n`);
      const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(data); c.close(); } });
      return { ok: true, status: 200, body: stream } as unknown as Response;
    };
    const contents = [
      { role: 'user', parts: [{ text: 'hello' }] },
      { role: 'model', parts: [{ text: 'hi' }] },
      { role: 'user', parts: [{ text: 'what is 2+2?' }] },
    ];
    await generateViaGeminiStream(fetchFn, '', 'gemini-pro', 'key', { timeoutMs: 5000, geminiContents: contents });
    const parsed = JSON.parse(capturedBody);
    expect(parsed.contents).toEqual(contents);
  });
});
