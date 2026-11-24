// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4105: the server's AI_API_KEY fallback is gemini-only. A set AI_API_KEY never reaches another provider.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { stored } = vi.hoisted(() => ({ stored: { keys: [] as string[] } }));
vi.mock('../security/keyStore.js', () => ({
  getKeyStore: () => ({ getKeys: async () => stored.keys }), // stored BYOK keys, [] unless a test sets them
}));
// t/501: config also reads isAnonymousRequest(); these tests are signed-in (not anonymous) by construction.
vi.mock('../security/userContext.js', () => ({ getCurrentUserId: () => 'test-user', isAnonymousRequest: () => false, isHostedAnonymousRequest: () => false }));

import { getApiKey, getApiKeys, getApiKeyForListing, hasApiKey } from '../config.js';

const KEYS = ['AI_API_KEY', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'GROQ_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY'];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  stored.keys = [];
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('server getApiKey / getApiKeys: AI_API_KEY is gemini-only (t/4105)', () => {
  it('gemini falls back to AI_API_KEY', async () => {
    process.env.AI_API_KEY = 'google-key';
    expect(await getApiKey('gemini')).toBe('google-key');
    expect(await getApiKeys('gemini')).toEqual(['google-key']);
  });

  it.each(['claude', 'groq', 'openai', 'xai'] as const)('%s refuses a set AI_API_KEY, naming its own variable', async (backend) => {
    process.env.AI_API_KEY = 'google-key';
    await expect(getApiKey(backend)).rejects.toThrow(/fallback for the gemini backend only/);
    await expect(getApiKeys(backend)).rejects.toThrow(/fallback for the gemini backend only/);
  });

  it('a backend with its own key is unaffected by a set AI_API_KEY', async () => {
    process.env.AI_API_KEY = 'google-key';
    process.env.ANTHROPIC_API_KEY = 'anthropic-key';
    expect(await getApiKey('claude')).toBe('anthropic-key');
  });

  it('with nothing set, a non-gemini backend still returns null / [] (no refusal)', async () => {
    expect(await getApiKey('claude')).toBeNull();
    expect(await getApiKeys('claude')).toEqual([]);
  });
});

describe('listing contexts never throw (SO e/284#2 cond 1)', () => {
  it('with only AI_API_KEY set: gemini is configured, every other backend reports not-configured without throwing', async () => {
    process.env.AI_API_KEY = 'google-key';
    expect(await hasApiKey('gemini')).toBe(true);
    expect(await getApiKeyForListing('gemini')).toBe('google-key');
    for (const backend of ['claude', 'groq', 'openai', 'xai'] as const) {
      await expect(hasApiKey(backend)).resolves.toBe(false);
      await expect(getApiKeyForListing(backend)).resolves.toBeNull();
    }
    // ...while the call path for the same backend still refuses
    await expect(getApiKey('claude')).rejects.toThrow(/fallback for the gemini backend only/);
  });

  it('a FOREIGN-credential refusal is not softened: listing surfaces it (SO e/284#10)', async () => {
    process.env.GROQ_API_KEY = 'groq-placeholder';
    stored.keys = ['groq-placeholder']; // a "claude" key that is really the groq credential
    await expect(hasApiKey('claude')).rejects.toThrow(/value of GROQ_API_KEY/);
    await expect(getApiKeyForListing('claude')).rejects.toThrow(/value of GROQ_API_KEY/);
    await expect(getApiKeys('claude')).rejects.toThrow(/value of GROQ_API_KEY/);
  });
});
