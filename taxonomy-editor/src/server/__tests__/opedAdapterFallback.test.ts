// @vitest-environment node
// t/467 (SO, TL p/16#216 item 2): the op-ed adapter's fallback path. An anonymous run must (a) be served only by
// its requested, price-checked model (noFallback), and (b) be refused if the served model is unpriced, with
// nothing counted. A signed-in run is not priced or refused here.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { generateText, isAnonymousUser, recordAnonOpEdSpend, pricedModels } = vi.hoisted(() => ({
  generateText: vi.fn(),
  isAnonymousUser: vi.fn(() => true),
  recordAnonOpEdSpend: vi.fn(async () => undefined),
  pricedModels: new Set(['gemini-2.5-flash']),
}));
vi.mock('../ai/aiBackends.js', () => ({ generateText, getModelRegistry: () => ({}) }));
vi.mock('../security/userContext.js', () => ({ isAnonymousUser }));
vi.mock('../storage/anonOpEdSpend.js', () => ({ recordAnonOpEdSpend }));
vi.mock('../logger.js', () => ({ log: { server: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } } }));
vi.mock('../../../../lib/ai-client/registry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/ai-client/registry.js')>()),
  estimateCost: () => 0.25,
  resolvePricingKey: (_r: unknown, id: string) => (pricedModels.has(id) ? id : undefined),
}));

import { createWebOpEdAdapter } from '../ai/opedAdapter.js';

const usage = { inputTokens: 100, outputTokens: 50 };

beforeEach(() => {
  generateText.mockReset();
  recordAnonOpEdSpend.mockClear();
  isAnonymousUser.mockReturnValue(true);
});

describe('op-ed adapter fallback path (t/467, SO item 2)', () => {
  it('an anonymous run calls the backend with noFallback, so no fallback model can serve it', async () => {
    generateText.mockResolvedValue({ text: 'ok', tokenUsage: usage, servedModel: 'gemini-2.5-flash' });
    await createWebOpEdAdapter().generateText('p', 'gemini-2.5-flash');
    expect(generateText.mock.calls[0][5]).toMatchObject({ noFallback: true });
  });

  it('a served model with NO price is refused: the run fails, and no spend is counted', async () => {
    // The requested model is priced, but the call was served by an unpriced one (a reroute below this layer).
    generateText.mockResolvedValue({ text: 'from the cheap unpriced model', tokenUsage: usage, servedModel: 'ollama-local-unpriced' });
    await expect(createWebOpEdAdapter().generateText('p', 'gemini-2.5-flash')).rejects.toMatchObject({
      code: 'ANON_UNPRICED_SERVED_MODEL',
    });
    expect(recordAnonOpEdSpend).not.toHaveBeenCalled();
  });

  it('a priced served model is counted once, at its estimated cost', async () => {
    generateText.mockResolvedValue({ text: 'ok', tokenUsage: usage, servedModel: 'gemini-2.5-flash' });
    const text = await createWebOpEdAdapter().generateText('p', 'gemini-2.5-flash');
    expect(text).toBe('ok');
    expect(recordAnonOpEdSpend).toHaveBeenCalledTimes(1);
    expect(recordAnonOpEdSpend).toHaveBeenCalledWith(0.25);
  });

  it('a signed-in run is not priced, refused, or limited to the primary model here', async () => {
    isAnonymousUser.mockReturnValue(false);
    generateText.mockResolvedValue({ text: 'ok', tokenUsage: usage, servedModel: 'ollama-local-unpriced' });
    const text = await createWebOpEdAdapter().generateText('p', 'gemini-2.5-flash');
    expect(text).toBe('ok');
    expect(generateText.mock.calls[0][5]).toMatchObject({ noFallback: false });
    expect(recordAnonOpEdSpend).not.toHaveBeenCalled();
  });
});
