// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getModelCapabilities,
  filterByCapabilities,
  estimateCost,
  validateModelConfig,
  assertModelConfigValid,
  resolveBackend,
  inferBackend,
  resolveModel,
  getDefaultTimeout,
  getModelMinTimeout,
  resolveTimeout,
  buildModelEntryMap,
  buildModelIdMap,
} from './registry.js';
import type { ModelRegistry } from './registry.js';
import type { FlightRecorder, RecordInput } from '../flight-recorder/index.js';
import { setGlobalRecorder, clearGlobalRecorder } from '../flight-recorder/index.js';

const TEST_REGISTRY: ModelRegistry = {
  backends: [
    { id: 'gemini', label: 'Gemini' },
    { id: 'openai', label: 'OpenAI' },
    { id: 'ollama', label: 'Ollama' },
  ],
  models: [
    { id: 'gemini-2.5-flash', apiModelId: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', backend: 'gemini' },
    { id: 'openai-gpt-4o', apiModelId: 'gpt-4o', label: 'GPT-4o', backend: 'openai' },
    { id: 'openai-gpt-image-1', apiModelId: 'gpt-image-1', label: 'GPT Image 1', backend: 'openai' },
    { id: 'ollama-gemma', apiModelId: 'gemma:7b', label: 'Gemma 7B', backend: 'ollama' },
  ],
  capabilityDefaults: {
    gemini: { supportsTools: true, supportsVision: true, supportsStreaming: true, maxContextTokens: 1048576 },
    openai: { supportsTools: true, supportsVision: true, supportsStreaming: true, maxContextTokens: 128000 },
    ollama: { supportsTools: false, supportsVision: false, supportsStreaming: true, maxContextTokens: 131072 },
  },
  modelCapabilities: {
    'openai-gpt-image-1': { supportsTools: false, supportsVision: false, supportsStreaming: false },
  },
  pricing: {
    'gemini-2.5-flash': { inputPer1M: 0.3, outputPer1M: 2.5, cachedInputPer1M: 0.075 },
    'gpt-4o': { inputPer1M: 5, outputPer1M: 15 },
  },
};

describe('resolveModel — fixedTemperature (t/2068)', () => {
  const reg: ModelRegistry = {
    backends: [{ id: 'moonshot', label: 'Moonshot' }, { id: 'gemini', label: 'Gemini' }],
    models: [
      { id: 'moonshot-kimi-k3', apiModelId: 'kimi-k3', label: 'Kimi K3', backend: 'moonshot', fixedTemperature: 1 },
      { id: 'gemini-2.5-flash', apiModelId: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', backend: 'gemini' },
    ],
  };

  it('surfaces fixedTemperature from a registry entry', () => {
    expect(resolveModel(reg, 'moonshot-kimi-k3')).toMatchObject({
      apiModelId: 'kimi-k3', backend: 'moonshot', fixedTemperature: 1,
    });
  });

  it('leaves fixedTemperature undefined for an entry without it', () => {
    expect(resolveModel(reg, 'gemini-2.5-flash').fixedTemperature).toBeUndefined();
  });
});

describe('buildModelEntryMap (t/2107)', () => {
  const reg: ModelRegistry = {
    backends: [{ id: 'moonshot', label: 'Moonshot' }, { id: 'gemini', label: 'Gemini' }],
    models: [
      { id: 'moonshot-kimi-k3', apiModelId: 'kimi-k3', label: 'Kimi K3', backend: 'moonshot', fixedTemperature: 1 },
      { id: 'gemini-2.5-flash', apiModelId: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', backend: 'gemini' },
      { id: 'gemini-2.0-flash', apiModelId: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', backend: 'gemini' },
    ],
  };

  it('returns full ModelEntry including fixedTemperature', () => {
    const map = buildModelEntryMap(reg);
    expect(map['moonshot-kimi-k3']).toMatchObject({
      apiModelId: 'kimi-k3', backend: 'moonshot', fixedTemperature: 1,
    });
  });

  it('returns entry without fixedTemperature for standard models', () => {
    const map = buildModelEntryMap(reg);
    expect(map['gemini-2.5-flash']?.fixedTemperature).toBeUndefined();
    expect(map['gemini-2.5-flash']?.apiModelId).toBe('gemini-2.5-flash');
  });

  it('synthesized -latest alias points at the highest-versioned entry', () => {
    // gemini-2.5-flash and gemini-2.0-flash both parse to family gemini-flash;
    // 2.5 > 2.0, so gemini-flash-latest should point at the 2.5 entry.
    const map = buildModelEntryMap(reg);
    expect(map['gemini-flash-latest']?.apiModelId).toBe('gemini-2.5-flash');
    expect(map['gemini-flash-latest']?.id).toBe('gemini-2.5-flash');
  });

  it('synthesized -latest alias carries fixedTemperature from the source entry', () => {
    // Use gemini-format IDs which parseVersionedModelId matches.
    // gemini-2.5-flash (fixedTemperature: 1) wins over 2.0; alias must carry the constraint.
    const reg2: ModelRegistry = {
      backends: [{ id: 'gemini', label: 'Gemini' }],
      models: [
        { id: 'gemini-2.0-flash', apiModelId: 'gemini-2.0-flash', label: 'Flash 2.0', backend: 'gemini' },
        { id: 'gemini-2.5-flash', apiModelId: 'gemini-2.5-flash', label: 'Flash 2.5', backend: 'gemini', fixedTemperature: 1 },
      ],
    };
    const map = buildModelEntryMap(reg2);
    expect(map['gemini-flash-latest']?.apiModelId).toBe('gemini-2.5-flash');
    expect(map['gemini-flash-latest']?.fixedTemperature).toBe(1);
  });

  it('explicit *-latest in models[] wins over synthesized alias (collision guard)', () => {
    const reg3: ModelRegistry = {
      backends: [{ id: 'gemini', label: 'Gemini' }],
      models: [
        { id: 'gemini-flash-latest', apiModelId: 'gemini-2.5-flash-pinned', label: 'Pinned', backend: 'gemini' },
        { id: 'gemini-2.5-flash', apiModelId: 'gemini-2.5-flash', label: 'Flash 2.5', backend: 'gemini' },
        { id: 'gemini-2.0-flash', apiModelId: 'gemini-2.0-flash', label: 'Flash 2.0', backend: 'gemini' },
      ],
    };
    const map = buildModelEntryMap(reg3);
    expect(map['gemini-flash-latest']?.apiModelId).toBe('gemini-2.5-flash-pinned');
  });

  it.each([
    ['simple', reg],
    [
      'collision guard (explicit *-latest wins)',
      {
        backends: [{ id: 'gemini', label: 'Gemini' }],
        models: [
          { id: 'gemini-flash-latest', apiModelId: 'gemini-2.5-flash-pinned', label: 'Pinned', backend: 'gemini' },
          { id: 'gemini-2.5-flash', apiModelId: 'gemini-2.5-flash', label: 'Flash 2.5', backend: 'gemini' },
          { id: 'gemini-2.0-flash', apiModelId: 'gemini-2.0-flash', label: 'Flash 2.0', backend: 'gemini' },
        ],
      } as ModelRegistry,
    ],
    [
      'unparseable ids (no aliases synthesized)',
      {
        backends: [{ id: 'ollama', label: 'Ollama' }],
        models: [
          { id: 'ollama-gemma', apiModelId: 'gemma:7b', label: 'Gemma', backend: 'ollama' },
          { id: 'ollama-llama3', apiModelId: 'llama3:8b', label: 'Llama', backend: 'ollama' },
        ],
      } as ModelRegistry,
    ],
  ])('key set matches buildModelIdMap exactly — %s (parity contract)', (_name, r) => {
    expect(new Set(Object.keys(buildModelEntryMap(r)))).toEqual(new Set(Object.keys(buildModelIdMap(r))));
  });
});

describe('getModelCapabilities', () => {
  it('returns backend defaults for a model with no overrides', () => {
    const caps = getModelCapabilities(TEST_REGISTRY, 'gemini-2.5-flash');
    expect(caps.supportsTools).toBe(true);
    expect(caps.supportsVision).toBe(true);
    expect(caps.supportsStreaming).toBe(true);
    expect(caps.maxContextTokens).toBe(1048576);
  });

  it('applies model-specific overrides on top of backend defaults', () => {
    const caps = getModelCapabilities(TEST_REGISTRY, 'openai-gpt-image-1');
    expect(caps.supportsTools).toBe(false);
    expect(caps.supportsVision).toBe(false);
    expect(caps.supportsStreaming).toBe(false);
    expect(caps.maxContextTokens).toBe(128000);
  });

  it('gives an unknown model the plain system defaults, NOT gemini\'s (t/4101: no backend guess)', () => {
    const caps = getModelCapabilities(TEST_REGISTRY, 'unknown-model');
    expect(caps.supportsTools).toBe(true);
    expect(caps.supportsVision).toBe(false); // gemini would claim vision
    expect(caps.supportsStreaming).toBe(true);
    expect(caps.maxContextTokens).toBe(131072); // gemini would claim 1M
  });

  it('returns ollama defaults (no tools, no vision) for ollama models', () => {
    const caps = getModelCapabilities(TEST_REGISTRY, 'ollama-gemma');
    expect(caps.supportsTools).toBe(false);
    expect(caps.supportsVision).toBe(false);
    expect(caps.supportsStreaming).toBe(true);
  });
});

describe('filterByCapabilities', () => {
  const ALL_MODELS = ['gemini-2.5-flash', 'openai-gpt-4o', 'openai-gpt-image-1', 'ollama-gemma'];

  it('filters out models that lack supportsTools', () => {
    const result = filterByCapabilities(TEST_REGISTRY, ALL_MODELS, { supportsTools: true });
    expect(result).toContain('gemini-2.5-flash');
    expect(result).toContain('openai-gpt-4o');
    expect(result).not.toContain('openai-gpt-image-1');
    expect(result).not.toContain('ollama-gemma');
  });

  it('filters out models that lack supportsStreaming', () => {
    const result = filterByCapabilities(TEST_REGISTRY, ALL_MODELS, { supportsStreaming: true });
    expect(result).toContain('gemini-2.5-flash');
    expect(result).toContain('openai-gpt-4o');
    expect(result).toContain('ollama-gemma');
    expect(result).not.toContain('openai-gpt-image-1');
  });

  it('filters by multiple capabilities at once', () => {
    const result = filterByCapabilities(TEST_REGISTRY, ALL_MODELS, {
      supportsTools: true,
      supportsVision: true,
    });
    expect(result).toContain('gemini-2.5-flash');
    expect(result).toContain('openai-gpt-4o');
    expect(result).not.toContain('openai-gpt-image-1');
    expect(result).not.toContain('ollama-gemma');
  });

  it('returns all models when no capabilities are required', () => {
    const result = filterByCapabilities(TEST_REGISTRY, ALL_MODELS, {});
    expect(result).toEqual(ALL_MODELS);
  });

  it('returns empty array when no models match', () => {
    const result = filterByCapabilities(TEST_REGISTRY, ['ollama-gemma'], { supportsTools: true });
    expect(result).toEqual([]);
  });
});

describe('estimateCost', () => {
  it('calculates cost from input and output tokens', () => {
    const cost = estimateCost(TEST_REGISTRY, 'gpt-4o', {
      promptTokens: 1000,
      completionTokens: 500,
    });
    // (1000/1M)*5 + (500/1M)*15 = 0.005 + 0.0075 = 0.0125
    expect(cost).toBeCloseTo(0.0125, 6);
  });

  it('uses cachedInputPer1M rate for cached tokens when available', () => {
    const cost = estimateCost(TEST_REGISTRY, 'gemini-2.5-flash', {
      promptTokens: 10000,
      completionTokens: 2000,
      cachedTokens: 8000,
    });
    // nonCached: (2000/1M)*0.3 = 0.0006
    // cached: (8000/1M)*0.075 = 0.0006
    // output: (2000/1M)*2.5 = 0.005
    // total = 0.0062
    expect(cost).toBeCloseTo(0.0062, 6);
  });

  it('uses full input rate for cached tokens when cachedInputPer1M is absent', () => {
    const cost = estimateCost(TEST_REGISTRY, 'gpt-4o', {
      promptTokens: 1000,
      completionTokens: 0,
      cachedTokens: 500,
    });
    // nonCached: (500/1M)*5 = 0.0025
    // cached: (500/1M)*5 = 0.0025 (no cachedInputPer1M, uses inputPer1M)
    // output: 0
    // total = 0.005
    expect(cost).toBeCloseTo(0.005, 6);
  });

  it('returns undefined for unknown model', () => {
    const cost = estimateCost(TEST_REGISTRY, 'unknown-model', {
      promptTokens: 1000,
      completionTokens: 500,
    });
    expect(cost).toBeUndefined();
  });

  it('returns undefined when registry has no pricing', () => {
    const noPricingRegistry: ModelRegistry = { ...TEST_REGISTRY, pricing: undefined };
    const cost = estimateCost(noPricingRegistry, 'gpt-4o', {
      promptTokens: 1000,
      completionTokens: 500,
    });
    expect(cost).toBeUndefined();
  });

  it('handles zero tokens gracefully', () => {
    const cost = estimateCost(TEST_REGISTRY, 'gpt-4o', {
      promptTokens: 0,
      completionTokens: 0,
    });
    expect(cost).toBe(0);
  });

  it('handles missing token counts as zero', () => {
    const cost = estimateCost(TEST_REGISTRY, 'gpt-4o', {});
    expect(cost).toBe(0);
  });
});

describe('validateModelConfig', () => {
  // Base registry whose models[] synthesizes a `gemini-flash-latest` alias
  // (via buildModelIdMap parsing `gemini-2.5-flash` → family gemini-flash, v2.5).
  const BASE: ModelRegistry = {
    backends: [
      { id: 'gemini', label: 'Gemini' },
      { id: 'openai', label: 'OpenAI' },
    ],
    models: [
      { id: 'gemini-2.5-flash', apiModelId: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', backend: 'gemini' },
      { id: 'openai-gpt-4o', apiModelId: 'gpt-4o', label: 'GPT-4o', backend: 'openai' },
    ],
  };

  it('flags a typo\'d defaults value as a warning naming the id and site', () => {
    const registry: ModelRegistry = { ...BASE, defaults: { gemini: 'gemini-2.5-flahs' } };
    const issues = validateModelConfig(registry);
    const warnings = issues.filter(i => i.severity === 'warning');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].modelId).toBe('gemini-2.5-flahs');
    expect(warnings[0].referenceSite).toBe('defaults.gemini');
    expect(warnings[0].message).toContain('gemini-2.5-flahs');
  });

  it('does not warn on a synthesized -latest alias in defaults', () => {
    const registry: ModelRegistry = { ...BASE, defaults: { gemini: 'gemini-flash-latest' } };
    expect(validateModelConfig(registry).filter(i => i.severity === 'warning')).toHaveLength(0);
  });

  it('does not warn on a real model id in defaults', () => {
    const registry: ModelRegistry = { ...BASE, defaults: { openai: 'openai-gpt-4o' } };
    expect(validateModelConfig(registry).filter(i => i.severity === 'warning')).toHaveLength(0);
  });

  it('returns no warnings for a coherent config (defaults + debateTiers)', () => {
    const registry: ModelRegistry = {
      ...BASE,
      defaults: { gemini: 'gemini-2.5-flash', openai: 'openai-gpt-4o' },
      debateTiers: {
        basic: { gemini: 'gemini-2.5-flash' },
        advanced: { openai: 'openai-gpt-4o' },
      },
    };
    expect(validateModelConfig(registry).filter(i => i.severity === 'warning')).toHaveLength(0);
  });

  it('flags an unmapped debateTiers value with the dotted tier.backend site', () => {
    const registry: ModelRegistry = {
      ...BASE,
      debateTiers: { advanced: { openai: 'openai-gpt-4o-does-not-exist' } },
    };
    const warnings = validateModelConfig(registry).filter(i => i.severity === 'warning');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].referenceSite).toBe('debateTiers.advanced.openai');
  });

  it('flags a pricing key that is not a models[].id as info, including an apiModelId key (t/3946)', () => {
    const registry: ModelRegistry = {
      ...BASE,
      pricing: {
        'openai-gpt-4o': { inputPer1M: 5, outputPer1M: 15 },  // a models[].id: the contract (t/3946)
        'gpt-4o': { inputPer1M: 5, outputPer1M: 15 },         // an apiModelId: no longer a valid key
        'gemini-2.5-pro': { inputPer1M: 1.25, outputPer1M: 10 }, // no matching model at all
      },
    };
    const issues = validateModelConfig(registry);
    expect(issues.filter(i => i.severity === 'warning')).toHaveLength(0);
    const infos = issues.filter(i => i.severity === 'info');
    expect(infos.map(i => i.modelId).sort()).toEqual(['gemini-2.5-pro', 'gpt-4o']);
    expect(infos.every(i => /models\[\]\.id/.test(i.message))).toBe(true);
  });

  it('skips underscore-prefixed keys (_comment) in defaults, tiers, and pricing', () => {
    const registry: ModelRegistry = {
      ...BASE,
      defaults: { _comment: 'a note', gemini: 'gemini-2.5-flash' } as Record<string, string>,
      debateTiers: {
        _comment: 'tier note' as unknown as Record<string, string>,
        advanced: { _comment: 'inner note', openai: 'openai-gpt-4o' } as Record<string, string>,
      },
      pricing: { _comment: { inputPer1M: 0, outputPer1M: 0 } },
    };
    expect(validateModelConfig(registry)).toHaveLength(0);
  });
});

describe('assertModelConfigValid', () => {
  const BASE: ModelRegistry = {
    backends: [{ id: 'openai', label: 'OpenAI' }],
    models: [{ id: 'openai-gpt-4o', apiModelId: 'gpt-4o', label: 'GPT-4o', backend: 'openai' }],
  };

  it('throws when a warning-severity issue exists', () => {
    const registry: ModelRegistry = { ...BASE, defaults: { openai: 'openai-typo' } };
    expect(() => assertModelConfigValid(registry)).toThrow(/openai-typo/);
  });

  it('does not throw for info-only issues (pricing superset)', () => {
    const registry: ModelRegistry = {
      ...BASE,
      pricing: { 'unmatched-model': { inputPer1M: 1, outputPer1M: 1 } },
    };
    expect(() => assertModelConfigValid(registry)).not.toThrow();
  });

  it('does not throw for a coherent config', () => {
    const registry: ModelRegistry = { ...BASE, defaults: { openai: 'openai-gpt-4o' } };
    expect(() => assertModelConfigValid(registry)).not.toThrow();
  });
});

describe('resolveModel fallback WARN (t/3675)', () => {
  const record = vi.fn<(e: RecordInput) => void>();
  beforeEach(() => { record.mockClear(); setGlobalRecorder({ record } as unknown as FlightRecorder); });
  afterEach(() => { clearGlobalRecorder(); });

  const empty: ModelRegistry = { backends: [], models: [] };

  it('an exact registry match does NOT warn', () => {
    const reg: ModelRegistry = { backends: [], models: [{ id: 'gemini-3.5-flash-lite', apiModelId: 'gemini-3.5-flash-lite', label: 'x', backend: 'gemini' }] };
    expect(resolveModel(reg, 'gemini-3.5-flash-lite')).toMatchObject({ apiModelId: 'gemini-3.5-flash-lite', backend: 'gemini' });
    expect(record).not.toHaveBeenCalled();
  });

  it('unregistered gemini-prefixed id (the gemini-flash-lite-latest alias case) → prefix passthrough + WARN', () => {
    // Behaviour is unchanged (verbatim passthrough, gemini backend); the WARN is the only addition.
    expect(resolveModel(empty, 'gemini-flash-lite-latest')).toEqual({ apiModelId: 'gemini-flash-lite-latest', backend: 'gemini' });
    expect(record).toHaveBeenCalledTimes(1);
    const ev = record.mock.calls[0][0];
    expect(ev.level).toBe('warn');
    expect(ev.component).toBe('ai-client');
    expect(ev.message).toContain('gemini-flash-lite-latest');
    expect(ev.data).toMatchObject({ friendlyId: 'gemini-flash-lite-latest', branch: 'prefix', backend: 'gemini' });
  });

  it('unregistered non-gemini prefix → prefix branch with the correct backend', () => {
    expect(resolveModel(empty, 'xai-grok-9')).toEqual({ apiModelId: 'xai-grok-9', backend: 'xai' });
    expect(record.mock.calls[0][0].data).toMatchObject({ branch: 'prefix', backend: 'xai' });
  });

  it('unrecognized prefix → THROWS, never a silent gemini call (t/4101 replaced the old default branch)', () => {
    expect(() => resolveModel(empty, 'totally-made-up-7')).toThrow(/refusing to guess/);
    expect(record).not.toHaveBeenCalled(); // no fallback WARN: nothing was resolved
  });
});

describe('resolveBackend fails closed; no gemini default (t/4101)', () => {
  it('an id whose prefix names no backend THROWS an ActionableError instead of becoming a gemini call', () => {
    expect(() => resolveBackend('learnlm-1.5-pro', null)).toThrow(/refusing to guess/);
    expect(() => resolveBackend('unknown-model', null)).toThrow(/not in ai-models.json/);
    expect(() => resolveModel(TEST_REGISTRY, 'unknown-model')).toThrow(/refusing to guess/);
  });

  it('gemini ids still resolve to gemini: they arrived via the old default, now via an explicit prefix', () => {
    expect(resolveBackend('gemini-2.5-flash', null)).toBe('gemini');
    expect(resolveBackend('gemini-flash-lite-latest', null)).toBe('gemini');
  });

  it('PARITY: for every id in the real ai-models.json the PREFIX names its registry backend (cond 3)', async () => {
    const { readFileSync } = await import('fs');
    const { fileURLToPath } = await import('url');
    const path = (await import('path')).default;
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../');
    const real = JSON.parse(readFileSync(path.join(root, 'ai-models.json'), 'utf-8')) as { models: { id: string; backend: string }[] };
    expect(real.models.length).toBeGreaterThan(10);
    // inferBackend, not resolveBackend(id, registry): the registry-first path would agree by construction.
    const wrong = real.models.filter((m) => inferBackend(m.id) !== m.backend).map((m) => `${m.id} -> ${inferBackend(m.id)} (registry: ${m.backend})`);
    expect(wrong).toEqual([]);
  });

  it("REGISTRY FIRST: a registered id resolves to its entry's backend even when its prefix says otherwise", () => {
    const reg = { models: [{ id: 'gemini-but-served-by-groq', apiModelId: 'x', label: 'x', backend: 'groq' }] };
    expect(resolveBackend('gemini-but-served-by-groq', reg)).toBe('groq');
    expect(resolveBackend('gemini-but-served-by-groq', null)).toBe('gemini'); // null registry: the prefix
    expect(() => resolveBackend('learnlm-1.5-pro', reg)).toThrow(/refusing to guess/); // unregistered + unprefixed
  });

  it('estimates degrade instead of throwing: an unknown id gets the neutral base timeout', () => {
    expect(getDefaultTimeout('unknown-model', TEST_REGISTRY)).toBe(120_000);
  });
});

describe('moonshot backend routing (t/1945)', () => {
  // The server path (aiBackends.ts generateText) uses the prefix-based
  // resolveBackend(model); without the moonshot branch it fell through to gemini.
  it('resolveBackend maps the moonshot prefix to moonshot, not gemini', () => {
    expect(resolveBackend('moonshot-kimi-k3', null)).toBe('moonshot');
    expect(resolveBackend('moonshot', null)).toBe('moonshot');
  });

  it('resolveModel resolves the moonshot prefix as a verbatim passthrough', () => {
    const registry: ModelRegistry = { ...TEST_REGISTRY, models: [] };
    expect(resolveModel(registry, 'moonshot-kimi-k3')).toEqual({
      apiModelId: 'moonshot-kimi-k3',
      backend: 'moonshot',
    });
  });

  it('getDefaultTimeout uses the moonshot (240s) budget, mirroring zai', () => {
    expect(getDefaultTimeout('moonshot-kimi-k3', TEST_REGISTRY)).toBe(240_000);
  });

  // Frontier-tier 2× tests (t/2495)
  const tierRegistry = {
    backends: [],
    models: [],
    debateTiers: {
      basic:    { claude: 'claude-haiku-4-5',       gemini: 'gemini-3.5-flash-lite', ollama: 'ollama-llama3', zai: 'zai-model' },
      advanced: { claude: 'claude-sonnet-4-6',      gemini: 'gemini-3.1-pro-preview', ollama: 'ollama-llama3', zai: 'zai-model' },
    },
  };

  it('getDefaultTimeout doubles for frontier claude (advanced ≠ basic)', () => {
    expect(getDefaultTimeout('claude-sonnet-4-6', tierRegistry)).toBe(360_000); // 2× 180_000
  });

  it('getDefaultTimeout stays at base for basic claude', () => {
    expect(getDefaultTimeout('claude-haiku-4-5', tierRegistry)).toBe(180_000);
  });

  it('getDefaultTimeout doubles for frontier gemini (advanced ≠ basic)', () => {
    expect(getDefaultTimeout('gemini-3.1-pro-preview', tierRegistry)).toBe(240_000); // 2× 120_000
  });

  it('getDefaultTimeout stays at base for basic gemini', () => {
    expect(getDefaultTimeout('gemini-3.5-flash-lite', tierRegistry)).toBe(120_000);
  });

  it('getDefaultTimeout stays at base for ollama/zai (same model in both tiers)', () => {
    expect(getDefaultTimeout('ollama-llama3', tierRegistry)).toBe(300_000); // 1× — no frontier distinction
    expect(getDefaultTimeout('zai-model',     tierRegistry)).toBe(300_000); // 1× — no frontier distinction
  });

  it('getDefaultTimeout returns base when registry is omitted at runtime (untyped caller → backstop, t/3614)', () => {
    // registry is now a REQUIRED param (t/3614); this exercises the runtime backstop for a JS/untyped
    // caller that still omits it — the floor is disabled but the tiered/base value is preserved.
    expect(getDefaultTimeout('claude-sonnet-4-6', undefined as unknown as ModelRegistry)).toBe(180_000);
    expect(getDefaultTimeout('gemini-3.1-pro-preview', undefined as unknown as ModelRegistry)).toBe(120_000);
  });
});

// Per-model minTimeoutMs floor (t/3518 Phase 2, SO e/184). Registry-driven timeout floor replaces
// the model-substring checks. Floor semantics = Math.max(tiered, floor): it can raise, never shorten.
describe('getDefaultTimeout — minTimeoutMs floor (t/3518 Phase 2)', () => {
  const floorRegistry: ModelRegistry = {
    backends: [],
    models: [
      { id: 'claude-opus-5',   apiModelId: 'claude-opus-5',   label: 'Opus 5',   backend: 'claude', minTimeoutMs: 300_000 },
      { id: 'claude-sonnet-5', apiModelId: 'claude-sonnet-5', label: 'Sonnet 5', backend: 'claude', minTimeoutMs: 300_000 },
      { id: 'claude-fable-5',  apiModelId: 'claude-fable-5',  label: 'Fable 5',  backend: 'claude', minTimeoutMs: 300_000 },
      { id: 'claude-haiku-4-5', apiModelId: 'claude-haiku-4-5', label: 'Haiku', backend: 'claude' }, // no floor
    ],
    debateTiers: {
      basic:    { claude: 'claude-haiku-4-5' },
      advanced: { claude: 'claude-fable-5' }, // fable is the advanced-tier claude (Phase 1)
    },
  };

  const record = vi.fn<(e: RecordInput) => void>();
  beforeEach(() => { record.mockClear(); setGlobalRecorder({ record } as unknown as FlightRecorder); });
  afterEach(() => { clearGlobalRecorder(); });

  it('applies the floor when it exceeds the tiered value (sonnet-5: base 180s → floored to 300s)', () => {
    // sonnet-5 is NOT the advanced-tier model → tiered = base 180s; the 300s floor wins.
    expect(getDefaultTimeout('claude-sonnet-5', floorRegistry)).toBe(300_000);
    expect(record).not.toHaveBeenCalled(); // entry found → no WARN
  });

  it('composes with the ×2 tier bump — floor never SHORTENS a larger tiered value (fable-5: 360s wins over 300s floor)', () => {
    // fable-5 is advanced.claude → tiered = 2×180s = 360s; Math.max(360s, 300s floor) = 360s.
    expect(getDefaultTimeout('claude-fable-5', floorRegistry)).toBe(360_000);
  });

  it('a model without a floor is unchanged — pure tiered/base (haiku: basic → 180s)', () => {
    expect(getDefaultTimeout('claude-haiku-4-5', floorRegistry)).toBe(180_000);
    expect(record).not.toHaveBeenCalled();
  });

  it('ALIAS ARM (regression guard, TL AC): claude-opus-latest resolves to opus-5 via the entry map → floor applied', () => {
    // buildModelEntryMap synthesizes `claude-opus-latest` → the opus-5 entry (with its floor). A plain
    // models.find() would MISS this alias and silently drop the floor — the exact t/3518 re-open the
    // SO condition exists to prevent. opus-latest is not the advanced model → tiered 180s, floor 300s.
    expect(getDefaultTimeout('claude-opus-latest', floorRegistry)).toBe(300_000);
    expect(record).not.toHaveBeenCalled(); // alias IS in the entry map → no WARN
  });

  it('unknown/non-registry model → current behavior (base), NOT silently degraded, and emits a WARN', () => {
    // Not in the entry map (a dated variant or typo). Floor can't be read → falls back to base; the
    // miss is surfaced via a system.error WARN rather than a silent `?? 0` (SO condition 2).
    const backend_base = getDefaultTimeout('claude-made-up-9', floorRegistry);
    expect(backend_base).toBe(180_000); // claude base, unchanged from pre-Phase-2 behavior
    expect(record).toHaveBeenCalledTimes(1);
    const ev = record.mock.calls[0][0];
    expect(ev.type).toBe('system.error');
    expect(ev.level).toBe('warn');
    expect(ev.message).toContain('claude-made-up-9');
    expect(ev.message).toContain('minTimeoutMs floor not applied');
  });

  it('WARN path is null-safe when no recorder is wired (never throws)', () => {
    clearGlobalRecorder();
    expect(() => getDefaultTimeout('claude-made-up-9', floorRegistry)).not.toThrow();
  });

  it('applies the floor even when the registry has no debateTiers (no default/explicit asymmetry — TL e/185#8)', () => {
    // Pre-fix, getDefaultTimeout early-returned base before consulting the floor when debateTiers was
    // absent; now the floor is applied on every path, so a registry with models+floor but no tiers
    // still floors. (Unreachable with the real registry, which has debateTiers — guards the invariant.)
    const noTiers: ModelRegistry = {
      backends: [],
      models: [{ id: 'claude-sonnet-5', apiModelId: 'claude-sonnet-5', label: 'Sonnet 5', backend: 'claude', minTimeoutMs: 300_000 }],
    };
    expect(getDefaultTimeout('claude-sonnet-5', noTiers)).toBe(300_000); // floor, not base 180_000
  });

  // getModelMinTimeout — the shared floor primitive. Exposed so explicit-timeout call sites (the
  // opening-brief stage) can enforce the floor themselves, since a `?? explicit` short-circuits
  // getDefaultTimeout (TL e/185#6 item 1). This is what DebateTool's retirement of
  // openingBriefTimeoutFloor consumes: Math.max(explicitTimeout, getModelMinTimeout(model, reg)).
  describe('getModelMinTimeout (explicit-timeout floor primitive)', () => {
    it('returns the concrete floor for a registry id', () => {
      expect(getModelMinTimeout('claude-fable-5', floorRegistry)).toBe(300_000);
    });

    it('returns the floor for a synthesized -latest alias (not just bare ids)', () => {
      expect(getModelMinTimeout('claude-opus-latest', floorRegistry)).toBe(300_000);
      expect(record).not.toHaveBeenCalled();
    });

    it('returns 0 for a model with no floor (no WARN — it IS in the registry)', () => {
      expect(getModelMinTimeout('claude-haiku-4-5', floorRegistry)).toBe(0);
      expect(record).not.toHaveBeenCalled();
    });

    it('returns 0 + WARN for a model absent from the registry map', () => {
      expect(getModelMinTimeout('claude-made-up-9', floorRegistry)).toBe(0);
      expect(record).toHaveBeenCalledTimes(1);
      expect(record.mock.calls[0][0].message).toContain('claude-made-up-9');
    });

    it('returns 0 + WARN when no registry is supplied (t/3612: this path was silent, dropping every floor)', () => {
      // registry is REQUIRED (t/3614); the cast reaches the runtime backstop an untyped caller would hit.
      expect(getModelMinTimeout('claude-fable-5', undefined as unknown as ModelRegistry)).toBe(0);
      expect(record).toHaveBeenCalledTimes(1);
      expect(record.mock.calls[0][0].message).toContain('claude-fable-5');
      expect(record.mock.calls[0][0].message).toContain('no registry');
    });

    it('enforces the floor on an explicit below-floor timeout via Math.max (the opening-brief pattern)', () => {
      // The exact narrowing TL flagged: an explicit 60s on a floored model must not undercut 300s.
      const explicit = 60_000;
      expect(Math.max(explicit, getModelMinTimeout('claude-fable-5', floorRegistry))).toBe(300_000);
    });
  });
});

// t/3644: resolveTimeout makes the per-model floor UNBYPASSABLE — closes the `explicit ?? getDefaultTimeout`
// bypass where an explicit value skipped the floor entirely (same failure shape as t/3612, one layer up).
describe('resolveTimeout — floor is unbypassable (t/3644)', () => {
  const floorRegistry: ModelRegistry = {
    backends: [],
    models: [
      { id: 'claude-fable-5', apiModelId: 'claude-fable-5', label: 'Fable 5', backend: 'claude', minTimeoutMs: 300_000 },
      { id: 'claude-haiku-4-5', apiModelId: 'claude-haiku-4-5', label: 'Haiku', backend: 'claude' }, // no floor
    ],
  };
  const record = vi.fn<(e: RecordInput) => void>();
  beforeEach(() => { record.mockClear(); setGlobalRecorder({ record } as unknown as FlightRecorder); });
  afterEach(() => { clearGlobalRecorder(); });

  it('raises an explicit timeout BELOW a model floor up to the floor (the bypass, closed)', () => {
    // fable-5 floor = 300s; a caller passing 60s is raised to 300s, not run at 60s. This is the AC.
    expect(resolveTimeout(60_000, 'claude-fable-5', floorRegistry)).toBe(300_000);
  });

  it('honours an explicit timeout ABOVE the floor (a caller can still raise)', () => {
    expect(resolveTimeout(500_000, 'claude-fable-5', floorRegistry)).toBe(500_000);
  });

  it('preserves a legitimate sub-default explicit timeout on an UNFLOORED model (why we floor against getModelMinTimeout, not getDefaultTimeout)', () => {
    // haiku has no floor; base 180s. An explicit 60s is honoured as-is — the floor doesn't over-reach to
    // force the default. Flooring against getDefaultTimeout (per the ticket's literal snippet) would wrongly raise this to 180s.
    expect(resolveTimeout(60_000, 'claude-haiku-4-5', floorRegistry)).toBe(60_000);
  });

  it('no explicit timeout → the (already-floored) default', () => {
    expect(resolveTimeout(undefined, 'claude-fable-5', floorRegistry)).toBe(300_000); // base 180s → floor 300s
  });

  it('empty-but-typed registry: a floored model emits the not-found WARN, not a silent 0 (SO observability AC)', () => {
    // {} models[] has no entry, so the floor is unknown → getModelMinTimeout WARNs + returns 0, and the
    // timeout falls back to the (unfloored) base rather than a silent 0. Pins the observability the type can't give.
    const empty: ModelRegistry = { backends: [], models: [] };
    expect(resolveTimeout(undefined, 'claude-fable-5', empty)).toBe(180_000); // claude base; floor not applied (empty)
    expect(record).toHaveBeenCalled();
    expect(record.mock.calls.some(c => String((c[0] as RecordInput).message).includes('no registry entry'))).toBe(true);
  });
});
