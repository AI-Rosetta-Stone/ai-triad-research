// @vitest-environment node
// t/520 (TL p/16#437): when no link of the fallback chain has a key, the error names the CHOSEN model's backend in its
// goal and first fix step, with the fallbacks as a secondary line. The PI chose Gemini on staging and was told to set a
// Groq key, because the message named the chain's last link.

import { describe, it, expect, vi } from 'vitest';
import { ActionableError } from '../../../../lib/debate/errors.js';

vi.mock('../logger.js', () => ({
  log: { api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }, server: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
  getRequestId: () => 'req-test',
  LOG_MAX_LINE_BYTES: 65536,
}));
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));
vi.mock('../config.js', async (importActual) => ({
  ...(await importActual<typeof import('../config.js')>()),
  getApiKeys: vi.fn(async () => [] as string[]),
}));

import { generateText } from '../ai/aiBackends.js';
import { throwNoApiKeyError } from '../ai/chainLinkKeys.js';

function caught(fn: () => unknown): ActionableError {
  try { fn(); } catch (err) { return err as ActionableError; }
  throw new Error('expected a throw');
}

describe('t/520: the no-key error names the chosen backend', () => {
  it('a Gemini primary with a Groq last link: Gemini in the goal and first step, the fallbacks second', () => {
    const err = caught(() => throwNoApiKeyError(
      ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'groq-openai-gpt-oss-20b'], ['gemini', 'gemini', 'groq']));
    expect(err).toBeInstanceOf(ActionableError);
    expect(err.goal).toBe('Generate text with gemini-3.5-flash-lite via Gemini');
    expect(err.goal).not.toMatch(/Groq/);
    expect(err.problem).toMatch(/^No Gemini API key is configured for gemini-3\.5-flash-lite\./);
    expect(err.problem).toContain('gemini-3.1-flash-lite (Gemini), groq-openai-gpt-oss-20b (Groq)');
    expect(err.nextSteps[0]).toBe('Set your Gemini API key in Settings');
    expect(err.nextSteps[1]).toBe('Or add a key for a fallback: Groq');
  });

  it('a single-model chain: no fallback line', () => {
    const err = caught(() => throwNoApiKeyError(['claude-3-5-haiku'], ['claude']));
    expect(err.goal).toBe('Generate text with claude-3-5-haiku via Claude');
    expect(err.problem).toBe('No Claude API key is configured for claude-3-5-haiku.');
    expect(err.nextSteps).toEqual(['Set your Claude API key in Settings', 'Or choose a model whose backend has a key configured']);
  });

  it('through generateText with every link keyless: the chosen model and its backend lead the error', async () => {
    const err = await generateText('p', 'gemini-3.5-flash-lite').then(() => null, (e: unknown) => e as ActionableError);
    expect(err).toBeInstanceOf(ActionableError);
    expect(err!.goal).toBe('Generate text with gemini-3.5-flash-lite via Gemini');
    expect(err!.nextSteps[0]).toBe('Set your Gemini API key in Settings');
  });
});
