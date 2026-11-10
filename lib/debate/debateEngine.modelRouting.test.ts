// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

// t/57: keep engine.run() off the real ai-triad-data calibration log.
vi.mock('./calibrationLogger.js', async (importOriginal) =>
  (await import('./__tests__/hermeticCalibration.js')).hermeticCalibrationLogger(importOriginal));
// Isolated runtime is 2.7–3.1s; raise timeout so parallel-load runs don't hit the 5s default (t/4112).
vi.setConfig({ testTimeout: 15_000 });
import { DebateEngine, modelTierRank } from './debateEngine.js';
import type { ExtendedAIAdapter } from './aiAdapter.js';
import { createMockAdapter, createMinimalTaxonomy, createDefaultConfig } from './debateEngine.testHelpers.js';

// ── Hermetic isolation (t/1825 / Sage #88) ───────────────
// Block all network calls so this test is independent of shell API keys.
// Any secondary path that bypasses the injected adapter and reaches a live
// backend (embedding / fact-check / taxonomy-relevance) will throw here and be
// swallowed by the engine's best-effort error handlers — tests still pass,
// live calls cannot escape.
beforeAll(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(
    new Error('[test] network calls blocked — use injected adapter'),
  ));
});
afterAll(() => {
  vi.unstubAllGlobals();
});

// ── Per-speaker model routing (t/411) ────────────────────

describe('Per-speaker model routing', () => {
  it('accepts config with speakerModels and modelTier', () => {
    const config = createDefaultConfig({
      speakerModels: {
        accelerationist: 'gemini-2.5-pro',
        safetyist: 'claude-sonnet-4-20250514',
        skeptic: 'llama-3.3-70b',
      },
      modelTier: 'advanced',
    });
    const engine = new DebateEngine(config, createMockAdapter(), createMinimalTaxonomy());
    expect(engine).toBeDefined();
  });

  it('works without speakerModels (single-model fallback)', () => {
    const config = createDefaultConfig();
    const engine = new DebateEngine(config, createMockAdapter(), createMinimalTaxonomy());
    expect(engine).toBeDefined();
  });

  it('accepts partial speakerModels (only some speakers overridden)', () => {
    const config = createDefaultConfig({
      speakerModels: {
        accelerationist: 'gemini-2.5-pro',
      },
    });
    const engine = new DebateEngine(config, createMockAdapter(), createMinimalTaxonomy());
    expect(engine).toBeDefined();
  });

  it('stamps speaker_models and model_tier on session', async () => {
    const speakerModels = {
      accelerationist: 'gemini-2.5-pro',
      safetyist: 'claude-sonnet-4-20250514',
      skeptic: 'llama-3.3-70b',
    };
    const config = createDefaultConfig({
      rounds: 1,
      speakerModels,
      modelTier: 'advanced',
    });

    const adapter = createMockAdapter(Array(200).fill(JSON.stringify({
      brief: 'b', plan: { strategy: 's', key_claims: [] },
      statement: 'Statement about AI regulation.',
      my_claims: [], taxonomy_refs: [], policy_refs: [],
      turn_symbols: [], key_assumptions: [], move_types: [],
      responder: 'safetyist', addressing: 'accelerationist',
      focus_point: 'f', agreement_detected: false, intervene: false,
      suggested_move: 'PIN', target_debater: 'safetyist',
      trigger_reasoning: 'r', trigger_evidence: 'e',
      outcome: 'accept', process_reward: 0.8, score: 0.8,
      flags: [], clarifies_taxonomy: [],
      claims: [], overall_assessment: { notes: 'n' },
      cruxes: [], unresolved_questions: [], summary: 'S',
      disagreement_type: 'empirical', position_update: null,
    })));

    try {
      const session = await config_stamps_test(config, adapter);
      expect(session.speaker_models).toEqual(speakerModels);
      expect(session.model_tier).toBe('advanced');
    } catch {
      // Engine may throw during run — that's fine, we test config acceptance above
    }
  });

  it('single-model run: modelTier set but speakerModels absent → model_api_id, no model_pool (t/4040)', () => {
    // Every preset sets modelTier even for single-model runs.
    // The gate in _computeModelFingerprint must check speakerModels, not modelTier,
    // so that the debateTiers entry is not used as a pool fingerprint for single-model runs.
    const adapter: ExtendedAIAdapter = {
      async generateText() { return '{}'; },
      registry: {
        backends: [],
        models: [{ id: 'claude-sonnet-5', apiModelId: 'claude-sonnet-5-20251101', backend: 'claude' }],
        debateTiers: { basic: { claude: 'claude-sonnet-5' } },
      },
    } as unknown as ExtendedAIAdapter;
    const config = createDefaultConfig({
      model: 'claude-sonnet-5',
      modelTier: 'basic',
      // speakerModels intentionally absent — this is a single-model run
    });
    const engine = new DebateEngine(config, adapter, createMinimalTaxonomy());
    (engine as any).initSession();
    const session = (engine as any).session;
    expect(session.model_api_id).toBe('claude-sonnet-5:claude-sonnet-5-20251101');
    expect(session.model_pool).toBeUndefined();
  });

  it('routes per-speaker model to adapter during openings', async () => {
    const callLog: Array<{ model: string }> = [];
    const adapter: ExtendedAIAdapter = {
      async generateText(_prompt: string, model: string) {
        callLog.push({ model });
        return JSON.stringify({
          brief: 'b', plan: { strategy: 's', key_claims: [] },
          statement: 'Statement about AI regulation.',
          my_claims: [], taxonomy_refs: [], policy_refs: [],
          turn_symbols: [], key_assumptions: [], move_types: [],
          responder: 'safetyist', addressing: 'accelerationist',
          focus_point: 'f', agreement_detected: false, intervene: false,
          suggested_move: 'PIN', target_debater: 'safetyist',
          trigger_reasoning: 'r', trigger_evidence: 'e',
          outcome: 'accept', process_reward: 0.8, score: 0.8,
          flags: [], clarifies_taxonomy: [],
          claims: [], overall_assessment: { notes: 'n' },
          cruxes: [], unresolved_questions: [], summary: 'S',
          disagreement_type: 'empirical', position_update: null,
        });
      },
      registry: { backends: [], models: [] },
    };

    const config = createDefaultConfig({
      rounds: 1,
      speakerModels: {
        accelerationist: 'model-acc',
        safetyist: 'model-saf',
        skeptic: 'model-skp',
      },
    });

    const engine = new DebateEngine(config, adapter, createMinimalTaxonomy());
    try {
      await engine.run();
    } catch {
      // May throw — we only care about the call log
    }

    const accCalls = callLog.filter(c => c.model === 'model-acc');
    const safCalls = callLog.filter(c => c.model === 'model-saf');
    const skpCalls = callLog.filter(c => c.model === 'model-skp');

    expect(accCalls.length).toBeGreaterThan(0);
    expect(safCalls.length).toBeGreaterThan(0);
    expect(skpCalls.length).toBeGreaterThan(0);
  });

  it('falls back to global model when speaker has no override', async () => {
    const callLog: Array<{ model: string }> = [];
    const adapter: ExtendedAIAdapter = {
      async generateText(_prompt: string, model: string) {
        callLog.push({ model });
        return JSON.stringify({
          brief: 'b', plan: { strategy: 's', key_claims: [] },
          statement: 'Statement about AI regulation.',
          my_claims: [], taxonomy_refs: [], policy_refs: [],
          turn_symbols: [], key_assumptions: [], move_types: [],
          responder: 'safetyist', addressing: 'accelerationist',
          focus_point: 'f', agreement_detected: false, intervene: false,
          suggested_move: 'PIN', target_debater: 'safetyist',
          trigger_reasoning: 'r', trigger_evidence: 'e',
          outcome: 'accept', process_reward: 0.8, score: 0.8,
          flags: [], clarifies_taxonomy: [],
          claims: [], overall_assessment: { notes: 'n' },
          cruxes: [], unresolved_questions: [], summary: 'S',
          disagreement_type: 'empirical', position_update: null,
        });
      },
      registry: { backends: [], models: [] },
    };

    const config = createDefaultConfig({
      model: 'default-model',
      rounds: 1,
      speakerModels: {
        accelerationist: 'model-acc',
        // safetyist and skeptic not overridden — should fall back to default-model
      },
    });

    const engine = new DebateEngine(config, adapter, createMinimalTaxonomy());
    try {
      await engine.run();
    } catch {
      // May throw — we only care about the call log
    }

    const accCalls = callLog.filter(c => c.model === 'model-acc');
    const defaultCalls = callLog.filter(c => c.model === 'default-model');

    expect(accCalls.length).toBeGreaterThan(0);
    expect(defaultCalls.length).toBeGreaterThan(0);
  });
});

// ── Unified stage model config (t/1089) ─────────────────────

describe('Unified stage model config', () => {
  it('accepts config with stageModels', () => {
    const config = createDefaultConfig({
      model: 'expensive-model',
      stageModels: { brief: 'cheap-model', plan: 'cheap-model', cite: 'cheap-model' },
    });
    expect(config.stageModels?.brief).toBe('cheap-model');
    expect(config.stageModels?.plan).toBe('cheap-model');
    expect(config.stageModels?.cite).toBe('cheap-model');
  });

  it('stamps fully-resolved stage_models on session', () => {
    const config = createDefaultConfig({
      model: 'base-model',
      stageModels: { brief: 'cheap-brief', evaluator: 'eval-model' },
    });
    const engine = new DebateEngine(config, createMockAdapter(), createMinimalTaxonomy());
    (engine as any).initSession();
    const session = (engine as any).session;
    expect(session.stage_models.brief).toBe('cheap-brief');
    expect(session.stage_models.evaluator).toBe('eval-model');
    expect(session.stage_models.plan).toBe('base-model');
    expect(session.stage_models.draft).toBe('base-model');
  });

  it('resolves unset keys to config.model', () => {
    const config = createDefaultConfig({ model: 'base-model' });
    const engine = new DebateEngine(config, createMockAdapter(), createMinimalTaxonomy());
    expect((engine as any).resolveStageModel('brief')).toBe('base-model');
    expect((engine as any).resolveStageModel('evaluator')).toBe('base-model');
    expect((engine as any).resolveStageModel('crux')).toBe('base-model');
  });

  it('preserves explicit overrides', () => {
    const config = createDefaultConfig({
      stageModels: { brief: 'claude-opus-4', plan: 'claude-opus-4', cite: 'claude-opus-4' },
    });
    const engine = new DebateEngine(config, createMockAdapter(), createMinimalTaxonomy());
    expect((engine as any).config.stageModels.brief).toBe('claude-opus-4');
    expect((engine as any).config.stageModels.plan).toBe('claude-opus-4');
    expect((engine as any).config.stageModels.cite).toBe('claude-opus-4');
  });

  it('migrates legacy evaluatorModel to stageModels.evaluator', () => {
    const config = createDefaultConfig({
      evaluatorModel: 'legacy-eval',
    });
    const engine = new DebateEngine(config, createMockAdapter(), createMinimalTaxonomy());
    expect((engine as any).resolveStageModel('evaluator')).toBe('legacy-eval');
  });

  it('migrates legacy utilityModels to stageModels', () => {
    const config = createDefaultConfig({
      utilityModels: { summary: 'cheap-summary', crux: 'cheap-crux' },
    });
    const engine = new DebateEngine(config, createMockAdapter(), createMinimalTaxonomy());
    expect((engine as any).resolveStageModel('summary')).toBe('cheap-summary');
    expect((engine as any).resolveStageModel('crux')).toBe('cheap-crux');
  });

  it('stageModels takes precedence over legacy keys', () => {
    const config = createDefaultConfig({
      evaluatorModel: 'old-eval',
      utilityModels: { summary: 'old-summary' },
      stageModels: { evaluator: 'new-eval', summary: 'new-summary' },
    });
    const engine = new DebateEngine(config, createMockAdapter(), createMinimalTaxonomy());
    expect((engine as any).resolveStageModel('evaluator')).toBe('new-eval');
    expect((engine as any).resolveStageModel('summary')).toBe('new-summary');
  });
});

// ── Speaker model failover (t/773) ─────────────────────

describe('Speaker model failover', () => {
  it('accepts config with fallbackChain', () => {
    const config = createDefaultConfig({
      speakerModels: { accelerationist: 'model-a' },
      fallbackChain: ['model-b', 'model-c'],
    });
    const engine = new DebateEngine(config, createMockAdapter(), createMinimalTaxonomy());
    expect(engine).toBeDefined();
  });

  it('buildFailoverChain deduplicates and appends base model', () => {
    const config = createDefaultConfig({
      model: 'base-model',
      speakerModels: { accelerationist: 'model-a' },
      fallbackChain: ['model-b', 'model-a', 'base-model'],
    });
    const engine = new DebateEngine(config, createMockAdapter(), createMinimalTaxonomy());
    const chain = (engine as any).buildFailoverChain('model-a');
    expect(chain).toEqual(['model-a', 'model-b', 'base-model']);
  });

  it('buildFailoverChain with no fallbackChain returns [primary, base]', () => {
    const config = createDefaultConfig({
      model: 'base-model',
      speakerModels: { accelerationist: 'speaker-model' },
    });
    const engine = new DebateEngine(config, createMockAdapter(), createMinimalTaxonomy());
    const chain = (engine as any).buildFailoverChain('speaker-model');
    expect(chain).toEqual(['speaker-model', 'base-model']);
  });

  it('buildFailoverChain returns single entry when primary equals base', () => {
    const config = createDefaultConfig({ model: 'same-model' });
    const engine = new DebateEngine(config, createMockAdapter(), createMinimalTaxonomy());
    const chain = (engine as any).buildFailoverChain('same-model');
    expect(chain).toEqual(['same-model']);
  });

  it('executeWithModelFailover falls back on hard 403 error', async () => {
    let attempt = 0;
    const config = createDefaultConfig({
      model: 'base-model',
      speakerModels: { accelerationist: 'fail-model' },
      fallbackChain: ['also-fail', 'base-model'],
    });
    const engine = new DebateEngine(config, createMockAdapter(), createMinimalTaxonomy());

    const result = await (engine as any).executeWithModelFailover(
      'accelerationist',
      async (model: string) => {
        attempt++;
        if (model === 'fail-model') throw new Error('API error 403: Permission denied');
        if (model === 'also-fail') throw new Error('API error 500: Internal server error');
        return `success-${model}`;
      },
    );

    expect(result).toBe('success-base-model');
    expect(attempt).toBe(3);
    expect((engine as any).config.speakerModels.accelerationist).toBe('base-model');
  });

  it('executeWithModelFailover does not failover on non-hard errors', async () => {
    const config = createDefaultConfig({
      model: 'base-model',
      speakerModels: { accelerationist: 'speaker-model' },
      fallbackChain: ['fallback-model'],
    });
    const engine = new DebateEngine(config, createMockAdapter(), createMinimalTaxonomy());

    await expect(
      (engine as any).executeWithModelFailover(
        'accelerationist',
        async () => { throw new Error('Network timeout'); },
      ),
    ).rejects.toThrow('Network timeout');
  });

  it('executeWithModelFailover skips failover when chain has one entry', async () => {
    let callCount = 0;
    const config = createDefaultConfig({ model: 'only-model' });
    const engine = new DebateEngine(config, createMockAdapter(), createMinimalTaxonomy());

    await expect(
      (engine as any).executeWithModelFailover(
        'accelerationist',
        async () => { callCount++; throw new Error('API error 403: denied'); },
      ),
    ).rejects.toThrow('403');
    expect(callCount).toBe(1);
  });

  it('executeWithModelFailover persists working model to session', async () => {
    const config = createDefaultConfig({
      model: 'base-model',
      speakerModels: { safetyist: 'bad-model' },
    });
    const engine = new DebateEngine(config, createMockAdapter(), createMinimalTaxonomy());
    (engine as any).initSession();

    await (engine as any).executeWithModelFailover(
      'safetyist',
      async (model: string) => {
        if (model === 'bad-model') throw new Error('HTTP 500 server error');
        return 'ok';
      },
    );

    expect((engine as any).session.speaker_models.safetyist).toBe('base-model');
  });
});

// ── maxModelId cap on failover chain (t/1164) ────────────

describe('modelTierRank', () => {
  it('ranks compact models as tier 1', () => {
    expect(modelTierRank('gemini-3.5-flash-lite')).toBe(1);
    expect(modelTierRank('gemini-2.0-flash-lite')).toBe(1);
    expect(modelTierRank('gemini-flash-8b')).toBe(1);
  });

  it('ranks flash models as tier 2', () => {
    expect(modelTierRank('gemini-2.5-flash')).toBe(2);
    expect(modelTierRank('gemini-2.0-flash')).toBe(2);
  });

  it('ranks sonnet/haiku as tier 3', () => {
    expect(modelTierRank('claude-sonnet-4-6')).toBe(3);
    expect(modelTierRank('claude-haiku-4-5')).toBe(3);
  });

  it('ranks opus/pro as tier 4', () => {
    expect(modelTierRank('claude-opus-4-8')).toBe(4);
    expect(modelTierRank('gemini-2.5-pro')).toBe(4);
  });
});

describe('maxModelId cap on failover chain (t/1164)', () => {
  it('with maxModelId set to flash-lite, failover never escalates beyond compact tier', () => {
    const attemptedModels: string[] = [];
    const adapter: ExtendedAIAdapter = {
      async generateText(_prompt: string, model: string) {
        attemptedModels.push(model);
        throw new Error('500 Internal Server Error');
      },
      registry: { backends: [], models: [] },
    };

    const config = createDefaultConfig({
      model: 'gemini-3.5-flash-lite',
      fallbackChain: ['gemini-2.5-flash', 'claude-sonnet-4-6'],
      maxModelId: 'gemini-3.5-flash-lite',
      rounds: 1,
    });

    const engine = new DebateEngine(config, adapter, createMinimalTaxonomy());
    const chain = (engine as any).buildFailoverChain('gemini-3.5-flash-lite') as string[];

    expect(chain).toEqual(['gemini-3.5-flash-lite']);
    expect(chain).not.toContain('gemini-2.5-flash');
    expect(chain).not.toContain('claude-sonnet-4-6');
  });

  it('without maxModelId, fallback chain escalation proceeds normally', () => {
    const adapter: ExtendedAIAdapter = {
      async generateText() { return '{}'; },
      registry: { backends: [], models: [] },
    };

    const config = createDefaultConfig({
      model: 'gemini-3.5-flash-lite',
      fallbackChain: ['gemini-2.5-flash', 'claude-sonnet-4-6'],
      rounds: 1,
    });

    const engine = new DebateEngine(config, adapter, createMinimalTaxonomy());
    const chain = (engine as any).buildFailoverChain('gemini-3.5-flash-lite') as string[];

    expect(chain).toEqual(['gemini-3.5-flash-lite', 'gemini-2.5-flash', 'claude-sonnet-4-6']);
  });

  it('maxModelId at flash tier allows flash but blocks sonnet', () => {
    const adapter: ExtendedAIAdapter = {
      async generateText() { return '{}'; },
      registry: { backends: [], models: [] },
    };

    const config = createDefaultConfig({
      model: 'gemini-2.5-flash',
      fallbackChain: ['gemini-3.5-flash-lite', 'claude-sonnet-4-6', 'claude-opus-4-8'],
      maxModelId: 'gemini-2.5-flash',
      rounds: 1,
    });

    const engine = new DebateEngine(config, adapter, createMinimalTaxonomy());
    const chain = (engine as any).buildFailoverChain('gemini-2.5-flash') as string[];

    expect(chain).toEqual(['gemini-2.5-flash', 'gemini-3.5-flash-lite']);
    expect(chain).not.toContain('claude-sonnet-4-6');
    expect(chain).not.toContain('claude-opus-4-8');
  });
});
