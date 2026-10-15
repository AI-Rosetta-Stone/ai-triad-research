// @vitest-environment node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4105 SO cond 6 (e/284#12): when a call's primary backend is not gemini and only AI_API_KEY is set, the
// refusal naming that backend's own variable throws to the caller. The fallback chain must not treat it as a
// reason to fail over, or gemini would silently serve a request meant for another company. The control arm
// proves the exclusion is narrow: an ordinary transient failure on the same chain still fails over to gemini.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { providerCalls, claudeBehavior, storedKeys } = vi.hoisted(() => ({
  providerCalls: [] as string[],
  storedKeys: {} as Record<string, string[]>,
  claudeBehavior: { mode: 'transient' as 'transient' | 'foreign', geminiFails: false },
}));

vi.mock('../security/keyStore.js', () => ({ getKeyStore: () => ({ getKeys: async (backend: string) => storedKeys[backend] ?? [] }) }));
vi.mock('../security/userContext.js', () => ({ getCurrentUserId: () => 'test-user' }));
vi.mock('../../../../lib/ai-client/index.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../../lib/ai-client/index.js')>();
  const { KeyRoutingRefusal } = await import('../../../../lib/ai-client/apiKeyFallback.js');
  return {
    ...actual,
    withRetry: async <T>(fn: () => Promise<T>) => fn(), // one attempt: the chain decision is under test, not backoff
    callProvider: vi.fn(async (_f: unknown, backend: string) => {
      providerCalls.push(backend);
      if (backend === 'claude') {
        if (claudeBehavior.mode === 'foreign') {
          throw new KeyRoutingRefusal('AIApiKeyForeignCredentialRefused', { goal: 'g', problem: 'the provided key is the value of GROQ_API_KEY', location: 'test', nextSteps: [] });
        }
        throw new Error('HTTP 503 Service Unavailable');
      }
      if (backend === 'gemini' && claudeBehavior.geminiFails) throw new Error('HTTP 503 gemini Service Unavailable');
      return { text: `served by ${backend}`, usage: undefined, stopReason: 'stop' };
    }),
  };
});

import { generateText, buildModelsToTry, resolveBackend } from '../ai/aiBackends.js';

const PRIMARY = 'claude-haiku-4-5';
const KEYS = ['AI_API_KEY', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_API_KEY', 'GROQ_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY', 'DEEPSEEK_API_KEY', 'ZAI_API_KEY', 'MOONSHOT_API_KEY'];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  providerCalls.length = 0;
  claudeBehavior.mode = 'transient';
  claudeBehavior.geminiFails = false;
  for (const k of Object.keys(storedKeys)) delete storedKeys[k];
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

// t/4196 Stage 1: registry is `null` throughout — this suite fixtures PRIMARY/chain ids by their
// prefix on purpose (claude-/gemini-), so prefix-only resolution is exactly what's under test.
describe('generateText: a key-routing refusal never fails over (t/4105 C6)', () => {
  it('the fixture chain really is claude-primary with gemini later (a vacuous chain would pass anything)', () => {
    const chain = buildModelsToTry(PRIMARY, false, null);
    expect(resolveBackend(chain[0], null)).toBe('claude');
    expect(chain.slice(1).some((m) => resolveBackend(m, null) === 'gemini')).toBe(true);
  });

  it('primary claude, only AI_API_KEY set: the named-variable refusal throws and no provider is called', async () => {
    process.env.AI_API_KEY = 'google-placeholder';
    await expect(generateText('p', PRIMARY)).rejects.toThrow(/fallback for the gemini backend only/);
    await expect(generateText('p', PRIMARY)).rejects.toThrow(/ANTHROPIC_API_KEY/);
    expect(providerCalls).not.toContain('gemini');
    expect(providerCalls).toEqual([]);
  });

  it('a foreign-credential refusal from the primary send throws; gemini is never called', async () => {
    process.env.ANTHROPIC_API_KEY = 'claude-placeholder';
    process.env.AI_API_KEY = 'google-placeholder';
    claudeBehavior.mode = 'foreign';
    await expect(generateText('p', PRIMARY)).rejects.toThrow(/value of GROQ_API_KEY/);
    expect(providerCalls).toEqual(['claude']);
  });

  it('CONTROL: an ordinary transient failure on the same chain still fails over and gemini serves it', async () => {
    process.env.ANTHROPIC_API_KEY = 'claude-placeholder';
    process.env.AI_API_KEY = 'google-placeholder';
    const r = await generateText('p', PRIMARY);
    expect(r.text).toBe('served by gemini');
    expect(providerCalls).toEqual(['claude', 'gemini']);
  });

  it('a SECONDARY non-gemini link with only AI_API_KEY is skipped with a WARN, not thrown and never called', async () => {
    // gemini primary fails transiently; the later non-gemini links have no own key, only AI_API_KEY.
    process.env.AI_API_KEY = 'google-placeholder';
    const chain = buildModelsToTry('gemini-3.5-flash-lite', false, null);
    expect(chain.slice(1).some((m) => resolveBackend(m, null) !== 'gemini')).toBe(true); // fixture has a cross-provider link
    claudeBehavior.geminiFails = true;
    // The caller sees gemini's own failure, not the secondary's refusal, and no non-gemini provider is called.
    await expect(generateText('p', 'gemini-3.5-flash-lite')).rejects.toThrow(/gemini Service Unavailable/);
    expect(providerCalls.every((b) => b === 'gemini')).toBe(true);
  });

  it('a SECONDARY link whose key is FOREIGN still surfaces the refusal; only gemini-only is softened by kind', async () => {
    // gemini primary fails transiently; the cross-provider link's stored key is another backend's credential.
    process.env.AI_API_KEY = 'google-placeholder';
    process.env.ANTHROPIC_API_KEY = 'claude-placeholder';
    const chain = buildModelsToTry('gemini-3.5-flash-lite', false, null);
    const secondary = chain.slice(1).map((m) => resolveBackend(m, null)).find((b) => b !== 'gemini' && b !== 'claude');
    expect(secondary).toBeDefined(); // fixture has a non-gemini, non-claude link
    storedKeys[secondary!] = ['claude-placeholder'];
    claudeBehavior.geminiFails = true;
    await expect(generateText('p', 'gemini-3.5-flash-lite')).rejects.toThrow(/value of ANTHROPIC_API_KEY/);
    expect(providerCalls).not.toContain(secondary);
  });
});
