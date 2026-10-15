// @vitest-environment node
//
// t/2524 — a deliberate cancellation (AbortError) must not advance generateText's
// fallback chain, which would emit a spurious warn-level `ai.fallback` per remaining
// chain entry on every user cancel. Captures the flight-recorder events and asserts
// none is `ai.fallback` when a multi-entry chain is aborted.

import { describe, it, expect, vi } from 'vitest';

const rec = vi.hoisted(() => ({ events: [] as Array<{ type: string; message?: string }> }));

vi.mock('../../../../lib/flight-recorder/index.js', () => ({
  getGlobalRecorder: () => ({ record: (e: { type: string; message?: string }) => { rec.events.push(e); } }),
}));

// Provide a key for every backend so generateText reaches the retry layer (and thus
// the AbortError path) rather than the no-key skip branch. Keep all other config exports.
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return { ...actual, getApiKeys: vi.fn(async () => ['test-key']) };
});

import * as ai from '../ai/aiBackends.js';
import { buildModelsToTry } from '../ai/aiBackends.js';

describe('t/2524 — AbortError short-circuits the fallback chain', () => {
  it('a pre-aborted generateText rejects AbortError and emits NO ai.fallback events', async () => {
    rec.events = [];
    const model = 'gemini-flash-lite-latest';
    // Non-vacuous guard: this model expands to a multi-entry chain, so WITHOUT the
    // fix the catch would emit an ai.fallback for each remaining entry.
    expect(buildModelsToTry(model, false, null).length).toBeGreaterThan(1); // t/4196: prefix-only, model id is self-describing

    const c = new AbortController();
    c.abort();
    await expect(
      ai.generateText('prompt', model, undefined, undefined, undefined, { signal: c.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    // The per-chain-entry "failed after retries — falling back" warn is the spurious
    // event this fix suppresses. (Unrelated ai.fallback INFO events — e.g. the
    // "Auto-generated fallback chain" note during chain construction — are fine.)
    const fallbackWarns = rec.events.filter(
      e => e.type === 'ai.fallback' && /failed after retries/.test(e.message ?? ''),
    );
    expect(fallbackWarns).toHaveLength(0);
  });
});
