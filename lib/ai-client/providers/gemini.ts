// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { ActionableError } from '../../debate/errors.js';
import { makeFetchSignal } from '../retry.js';
import { fetchWithDiagnostics } from '../instrumentation.js';
import type { FetchFn, GenerateOptions, ProviderResult, ToolCall, UrlContextMetadata } from '../types.js';
import { DEFAULT_TEMPERATURE } from '../defaults.js';
import { normalizeStopReason } from './stopReason.js';

export const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Safety settings for all Gemini API calls. BLOCK_ONLY_HIGH allows legitimate
 * academic content about AI harm, risk, and weaponization while still blocking
 * clearly harmful content. Exported for use by consumer apps (t/208).
 */
export const GEMINI_SAFETY_SETTINGS = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
];

const GEMINI_TYPE_MAP: Record<string, string> = {
  string: 'STRING', number: 'NUMBER', integer: 'INTEGER',
  boolean: 'BOOLEAN', array: 'ARRAY', object: 'OBJECT',
};

export function toGeminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (typeof schema.type === 'string') result.type = GEMINI_TYPE_MAP[schema.type] ?? schema.type.toUpperCase();
  if (schema.description) result.description = schema.description;
  if (schema.enum) result.enum = schema.enum;
  if (schema.nullable) result.nullable = schema.nullable;
  if (schema.required) result.required = schema.required;
  if (schema.items && typeof schema.items === 'object') {
    result.items = toGeminiSchema(schema.items as Record<string, unknown>);
  }
  if (schema.properties && typeof schema.properties === 'object') {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema.properties as Record<string, unknown>)) {
      props[k] = typeof v === 'object' && v ? toGeminiSchema(v as Record<string, unknown>) : v;
    }
    result.properties = props;
  }
  return result;
}

function buildGeminiTools(opts: GenerateOptions): unknown[] | undefined {
  const tools: unknown[] = [];
  if (opts.tools?.length) {
    tools.push({
      functionDeclarations: opts.tools.map(t => ({
        name: t.name,
        description: t.description,
        parameters: toGeminiSchema(t.parameters),
      })),
    });
  }
  if (opts.urlContext) {
    tools.push({ url_context: {} });
  }
  return tools.length ? tools : undefined;
}

function parseUrlContextMetadata(candidate: Record<string, unknown>): UrlContextMetadata | undefined {
  const raw = candidate.urlContextMetadata as { urlMetadata?: { retrievedUrl?: string; urlRetrievalStatus?: string }[] } | undefined;
  if (!raw?.urlMetadata?.length) return undefined;
  return {
    urlMetadata: raw.urlMetadata.map(e => ({
      retrievedUrl: e.retrievedUrl ?? '',
      urlRetrievalStatus: e.urlRetrievalStatus ?? '',
    })),
  };
}

/** Gemini's usageMetadata as the API sends it (camelCase). Both the streaming and non-streaming paths read it. */
interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
  totalTokenCount?: number;
}

/** Maps Gemini's usageMetadata to the ProviderResult usage shape (t/494: shared by the streaming path). */
function toUsage(um: GeminiUsageMetadata | undefined): ProviderResult['usage'] {
  return um ? {
    promptTokens: um.promptTokenCount,
    completionTokens: um.candidatesTokenCount,
    cachedTokens: um.cachedContentTokenCount,
    totalTokens: um.totalTokenCount,
  } : undefined;
}

/** Requests JSON output when the caller asks for it (t/542: shared by the streaming and non-streaming paths). */
function applyJsonMode(genConfig: Record<string, unknown>, opts: GenerateOptions): void {
  if (!opts.jsonMode && !opts.responseSchema) return;
  genConfig.responseMimeType = 'application/json';
  if (opts.responseSchema) genConfig.responseSchema = toGeminiSchema(opts.responseSchema);
}

export async function generateViaGemini(
  fetchFn: FetchFn,
  prompt: string,
  apiModelId: string,
  apiKey: string,
  opts: GenerateOptions,
): Promise<ProviderResult> {
  const url = `${GEMINI_BASE}/${apiModelId}:generateContent`;
  const timeoutMs = opts.timeoutMs!;

  const genConfig: Record<string, unknown> = {
    temperature: opts.temperature ?? DEFAULT_TEMPERATURE,
    maxOutputTokens: opts.maxTokens ?? 16384,
  };
  applyJsonMode(genConfig, opts);

  const body: Record<string, unknown> = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: genConfig,
    safetySettings: GEMINI_SAFETY_SETTINGS,
  };
  if (opts.systemMessage) {
    body.systemInstruction = { parts: [{ text: opts.systemMessage }] };
  }
  const tools = buildGeminiTools(opts);
  if (tools) body.tools = tools;

  const { response, bodyText, diagnostics } = await fetchWithDiagnostics(fetchFn, url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body),
    signal: makeFetchSignal(timeoutMs, opts.signal),
  }, 60_000, 'Reading Gemini response');

  if (response.status === 429 || response.status === 503) {
    throw new ActionableError({
      goal: 'Generate text via Gemini',
      problem: `Gemini ${response.status}: ${bodyText.slice(0, 200)}`,
      location: 'ai-client.generateViaGemini',
      nextSteps: ['Wait a minute and retry', 'Switch to a different AI provider (Settings → AI Model)', 'Check API quota'],
    });
  }
  if (!response.ok) {
    throw mapGeminiError(response.status, bodyText);
  }

  let json: {
    candidates?: (Record<string, unknown> & { content: { parts: { text?: string; functionCall?: { name: string; args: Record<string, unknown> } }[] } })[];
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number; totalTokenCount?: number };
    modelVersion?: string; // provider-reported served identity (t/3677)
  };
  try {
    json = JSON.parse(bodyText);
  } catch {
    throw new ActionableError({
      goal: 'Parse Gemini API response',
      problem: `Gemini API returned invalid JSON (${bodyText.length} bytes). First 200 chars: ${bodyText.slice(0, 200)}`,
      location: 'ai-client.generateViaGemini',
      nextSteps: ['Retry the request', 'Check the API key and model ID'],
    });
  }
  if (!json.candidates?.length) {
    throw new ActionableError({
      goal: 'Generate text via Gemini',
      problem: `No candidates in Gemini response: ${bodyText.slice(0, 300)}`,
      location: 'ai-client.generateViaGemini',
      nextSteps: ['Retry the request', 'Try a different model'],
    });
  }
  const candidate = json.candidates[0];
  const parts = candidate.content.parts;
  const text = parts.filter(p => p.text).map(p => p.text).join('');
  const fnCalls = parts.filter(p => p.functionCall);
  const toolCalls: ToolCall[] | undefined = fnCalls.length > 0
    ? fnCalls.map((p, i) => ({
        name: p.functionCall!.name,
        arguments: p.functionCall!.args ?? {},
        id: `gemini-tc-${i}`,
      }))
    : undefined;
  const usage = toUsage(json.usageMetadata);
  const urlContextMetadata = parseUrlContextMetadata(candidate);
  // finishReason lives on the candidate (e.g. "STOP", "MAX_TOKENS", "SAFETY"); typed unknown here.
  const rawStopReason = typeof candidate.finishReason === 'string' ? candidate.finishReason : undefined;
  return { text, usage, toolCalls, urlContextMetadata, stopReason: normalizeStopReason(rawStopReason), rawStopReason, diagnostics, providerReportedModel: json.modelVersion };
}

export async function generateViaGeminiStream(
  fetchFn: FetchFn,
  prompt: string,
  apiModelId: string,
  apiKey: string,
  opts: GenerateOptions,
  onChunk?: (text: string) => void,
): Promise<ProviderResult> {
  const url = `${GEMINI_BASE}/${apiModelId}:streamGenerateContent?alt=sse`;
  const timeoutMs = opts.timeoutMs!;

  const genConfig: Record<string, unknown> = {
    temperature: opts.temperature ?? DEFAULT_TEMPERATURE,
    maxOutputTokens: opts.maxTokens ?? 16384,
  };
  // t/542: same JSON mode as generateViaGemini, so a streamed reply is valid JSON from the model.
  applyJsonMode(genConfig, opts);

  const contents = opts.geminiContents ?? [{ role: 'user', parts: [{ text: prompt }] }];
  const body: Record<string, unknown> = {
    contents,
    generationConfig: genConfig,
    safetySettings: GEMINI_SAFETY_SETTINGS,
  };
  if (opts.systemMessage) {
    body.systemInstruction = { parts: [{ text: opts.systemMessage }] };
  }
  const tools = buildGeminiTools(opts);
  if (tools) body.tools = tools;

  const response = await fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body),
    signal: makeFetchSignal(timeoutMs, opts.signal),
  });

  if (response.status === 429 || response.status === 503) {
    const errBody = await response.text().catch(() => '');
    throw new ActionableError({
      goal: 'Generate text via Gemini (streaming)',
      problem: `Gemini ${response.status}: ${errBody.slice(0, 200)}`,
      location: 'ai-client.generateViaGeminiStream',
      nextSteps: ['Wait a minute and retry', 'Switch to a different AI provider (Settings → AI Model)', 'Check API quota'],
    });
  }
  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw mapGeminiError(response.status, errBody);
  }
  if (!response.body) {
    throw new ActionableError({
      goal: 'Generate text via Gemini (streaming)',
      problem: 'Gemini streaming response has no body',
      location: 'ai-client.generateViaGeminiStream',
      nextSteps: ['Retry the request', 'Fall back to non-streaming generateViaGemini'],
    });
  }

  const chunks: string[] = [];
  let usageMeta: GeminiUsageMetadata | undefined;
  let urlContextMetadata: UrlContextMetadata | undefined;
  // The finishReason arrives on the FINAL SSE chunk (and Gemini can emit MAX_TOKENS with empty
  // parts), so track the last non-empty value seen across chunks rather than any single chunk's.
  let rawStopReason: string | undefined;
  const decoder = new TextDecoder();
  let buffer = '';

  const processPayload = (payload: string): void => {
    if (!payload || payload === '[DONE]') return;
    let parsed: {
      candidates?: (Record<string, unknown> & { content?: { parts?: { text?: string }[] } })[];
      usageMetadata?: GeminiUsageMetadata;
    };
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    // t/494: Gemini reports cumulative usageMetadata; the last one seen (the final chunk) is the call's usage.
    if (parsed.usageMetadata) usageMeta = parsed.usageMetadata;
    const candidate = parsed.candidates?.[0];
    if (!candidate) return;
    const text = candidate.content?.parts
      ?.filter((p): p is { text: string } => typeof p.text === 'string')
      .map(p => p.text)
      .join('') ?? '';
    if (text) {
      chunks.push(text);
      onChunk?.(text);
    }
    if (typeof candidate.finishReason === 'string' && candidate.finishReason) {
      rawStopReason = candidate.finishReason;
    }
    const meta = parseUrlContextMetadata(candidate);
    if (meta) urlContextMetadata = meta;
  };

  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('data: ')) processPayload(line.slice(6).trim());
      }
    }
    if (buffer.startsWith('data: ')) processPayload(buffer.slice(6).trim());
  } finally {
    reader.releaseLock();
  }

  return {
    text: chunks.join(''),
    usage: toUsage(usageMeta),
    urlContextMetadata,
    stopReason: normalizeStopReason(rawStopReason),
    rawStopReason,
  };
}

export function mapGeminiError(status: number, bodyText: string): ActionableError {
  let errorStatus: string | undefined;
  let reason: string | undefined;
  try {
    const parsed = JSON.parse(bodyText);
    const err = parsed?.error;
    errorStatus = err?.status;
    const details: unknown[] = err?.details ?? [];
    for (const d of details) {
      const r = (d as Record<string, unknown>)?.reason;
      if (typeof r === 'string') { reason = r; break; }
    }
  } catch { /* parse failed — fall through to generic */ }

  if (status === 401 || errorStatus === 'UNAUTHENTICATED') {
    if (reason === 'ACCESS_TOKEN_TYPE_UNSUPPORTED') {
      return new ActionableError({
        goal: 'Generate text via Gemini',
        problem: `Gemini 401 UNAUTHENTICATED: credential is an OAuth access token, not an API key. ${bodyText.slice(0, 300)}`,
        location: 'ai-client.generateViaGemini',
        nextSteps: [
          'Your Gemini credential looks like an OAuth access token, not an API key. Gemini API keys start with AIza or AQ. (t/3139).',
          'Re-register a valid key (Settings → API Keys, or Register-AIBackend)',
        ],
      });
    }
    return new ActionableError({
      goal: 'Generate text via Gemini',
      problem: `Gemini 401 UNAUTHENTICATED: ${bodyText.slice(0, 300)}`,
      location: 'ai-client.generateViaGemini',
      nextSteps: [
        'The Gemini API key is invalid or revoked',
        'Register a new key (Settings → API Keys, or Register-AIBackend)',
      ],
    });
  }

  if (status === 403 || errorStatus === 'PERMISSION_DENIED') {
    return new ActionableError({
      goal: 'Generate text via Gemini',
      problem: `Gemini 403 PERMISSION_DENIED: ${bodyText.slice(0, 300)}`,
      location: 'ai-client.generateViaGemini',
      nextSteps: [
        'Your API key does not have permission for this model or operation',
        'Check the API key permissions in Google AI Studio',
        'Try a different model',
      ],
    });
  }

  if (status === 404 || errorStatus === 'NOT_FOUND') {
    return new ActionableError({
      goal: 'Generate text via Gemini',
      problem: `Gemini 404 NOT_FOUND: ${bodyText.slice(0, 300)}`,
      location: 'ai-client.generateViaGemini',
      nextSteps: [
        'The model ID was not found — check spelling and availability',
        'Try a different model',
      ],
    });
  }

  return new ActionableError({
    goal: 'Generate text via Gemini',
    problem: `Gemini API error ${status}: ${bodyText.slice(0, 500)}`,
    location: 'ai-client.generateViaGemini',
    nextSteps: ['Check your API key', 'Verify the model ID', 'Try a different model'],
  });
}
