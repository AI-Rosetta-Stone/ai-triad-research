// @vitest-environment node
// t/467 (SO, TL p/16#216 item 2): with noFallback, a call's chain is its primary model only. This is what stops
// a fallback model (which may be unpriced) from serving an anonymous run.

import { describe, it, expect } from 'vitest';
import { chainModelsToTry, buildModelsToTry, getModelRegistry } from '../ai/aiBackends.js';

describe('chainModelsToTry (t/467, SO item 2)', () => {
  it('noFallback keeps only the primary model, which is the first entry of the normal chain', () => {
    const registry = getModelRegistry();
    const primary = 'gemini-2.5-flash';
    const normal = buildModelsToTry(primary, false, registry);
    const restricted = chainModelsToTry(primary, false, registry, { noFallback: true });
    expect(restricted).toEqual(normal.slice(0, 1));
    expect(restricted.length).toBeLessThanOrEqual(1);
  });

  it('without noFallback the chain is unchanged, so signed-in runs keep their fallbacks', () => {
    const registry = getModelRegistry();
    const primary = 'gemini-2.5-flash';
    expect(chainModelsToTry(primary, false, registry, {})).toEqual(buildModelsToTry(primary, false, registry));
    expect(chainModelsToTry(primary, false, registry, undefined)).toEqual(buildModelsToTry(primary, false, registry));
  });
});
