// @vitest-environment node
// t/467 (PI, TL p/16#221): the per-run cost ceiling for anonymous op-ed runs, $5. Checked before every call, so no
// call that could take the run past $5 is sent to a provider. The worst case of a call is priced from its prompt
// size and its maxTokens; a call with no maxTokens, or on an unpriced model, is refused because it can't be bounded.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { generateText, isAnonymousUser, recordAnonOpEdSpend, state } = vi.hoisted(() => ({
  generateText: vi.fn(),
  isAnonymousUser: vi.fn(() => true),
  recordAnonOpEdSpend: vi.fn(async () => undefined),
  state: { callCostUsd: 2, perPromptTokenUsd: 0, pricedModels: new Set(['gemini-2.5-flash']) },
}));
vi.mock('../ai/aiBackends.js', () => ({ generateText, getModelRegistry: () => ({}) }));
vi.mock('../security/userContext.js', () => ({ isAnonymousUser }));
vi.mock('../storage/anonOpEdSpend.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../storage/anonOpEdSpend.js')>()),
  recordAnonOpEdSpend,
}));
vi.mock('../logger.js', () => ({ log: { server: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } } }));
vi.mock('../../../../lib/ai-client/registry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/ai-client/registry.js')>()),
  // A fixed cost plus a per-prompt-token cost, so a test can make the input size decide the estimate.
  estimateCost: (_r: unknown, id: string, usage?: { promptTokens?: number }) =>
    (state.pricedModels.has(id) ? state.callCostUsd + (usage?.promptTokens ?? 0) * state.perPromptTokenUsd : undefined),
  resolvePricingKey: (_r: unknown, id: string) => (state.pricedModels.has(id) ? id : undefined),
}));

import { createWebOpEdAdapter } from '../ai/opedAdapter.js';

const MODEL = 'gemini-2.5-flash';
const served = (text = 'ok') => ({ text, tokenUsage: { promptTokens: 10, completionTokens: 10 }, servedModel: MODEL });

beforeEach(() => {
  generateText.mockReset();
  recordAnonOpEdSpend.mockClear();
  isAnonymousUser.mockReturnValue(true);
  state.callCostUsd = 2;
  state.pricedModels = new Set([MODEL]);
});

describe('anonymous op-ed per-run ceiling, $5 (t/467, TL p/16#221)', () => {
  it('a run is allowed calls until the next one would take its total past $5, then the next call is refused before it is sent', async () => {
    generateText.mockResolvedValue(served());
    const adapter = createWebOpEdAdapter();
    // $2 each: totals 2, then 4 are fine. The third would be 4 + worst(2) = 6 > 5, so it is refused.
    await adapter.generateText('p', MODEL, { maxTokens: 100 });
    await adapter.generateText('p', MODEL, { maxTokens: 100 });
    await expect(adapter.generateText('p', MODEL, { maxTokens: 100 })).rejects.toMatchObject({ code: 'ANON_RUN_COST_CEILING' });
    expect(generateText).toHaveBeenCalledTimes(2); // the refused call never reached the provider
  });

  it('a single call whose worst case is over $5 is refused before it is sent', async () => {
    state.callCostUsd = 6;
    await expect(createWebOpEdAdapter().generateText('p', MODEL, { maxTokens: 100 })).rejects.toMatchObject({ code: 'ANON_RUN_COST_CEILING' });
    expect(generateText).not.toHaveBeenCalled();
  });

  it('a call with no output limit cannot be bounded, so it is refused before it is sent', async () => {
    await expect(createWebOpEdAdapter().generateText('p', MODEL, {})).rejects.toMatchObject({ code: 'ANON_UNBOUNDED_CALL' });
    expect(generateText).not.toHaveBeenCalled();
  });

  it('the input estimate uses UTF-8 bytes, not characters: multibyte text is refused when its bytes would breach $5', async () => {
    // 3000 characters of a 3-byte character = 9000 bytes. A character count would price it at 3000 tokens ($3, allowed);
    // the byte count prices it at 9000 tokens ($9, over the $5 ceiling), so it must be refused before it is sent.
    state.callCostUsd = 0;
    state.perPromptTokenUsd = 0.001;
    const prompt = 'あ'.repeat(3000);
    await expect(createWebOpEdAdapter().generateText(prompt, MODEL, { maxTokens: 100 })).rejects.toMatchObject({ code: 'ANON_RUN_COST_CEILING' });
    expect(generateText).not.toHaveBeenCalled();
    state.perPromptTokenUsd = 0;
  });

  it('a call on an unpriced model is refused before it is sent', async () => {
    state.pricedModels = new Set(); // no model has a price
    await expect(createWebOpEdAdapter().generateText('p', MODEL, { maxTokens: 100 })).rejects.toMatchObject({ code: 'ANON_UNPRICED_MODEL' });
    expect(generateText).not.toHaveBeenCalled();
  });

  it('each run has its own budget: a second run from a fresh adapter starts at $0', async () => {
    generateText.mockResolvedValue(served());
    await createWebOpEdAdapter().generateText('p', MODEL, { maxTokens: 100 });
    await createWebOpEdAdapter().generateText('p', MODEL, { maxTokens: 100 });
    expect(generateText).toHaveBeenCalledTimes(2);
  });

  it('a signed-in run is not held to the anonymous per-run ceiling', async () => {
    isAnonymousUser.mockReturnValue(false);
    state.callCostUsd = 6;
    generateText.mockResolvedValue(served());
    const text = await createWebOpEdAdapter().generateText('p', MODEL, { maxTokens: 100 });
    expect(text).toBe('ok');
    expect(generateText).toHaveBeenCalledTimes(1);
  });
});
