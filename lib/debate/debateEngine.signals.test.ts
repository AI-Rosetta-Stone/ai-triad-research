// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi } from 'vitest';

// t/57: keep engine.run() off the real ai-triad-data calibration log.
vi.mock('./calibrationLogger.js', async (importOriginal) =>
  (await import('./__tests__/hermeticCalibration.js')).hermeticCalibrationLogger(importOriginal));
import { DebateEngine } from './debateEngine.js';
import type { DebateConfig, LifecycleStage } from './debateEngine.js';
import type { ExtendedAIAdapter } from './aiAdapter.js';
import type { LoadedTaxonomy } from './taxonomyLoader.js';
import { createMockAdapter, createMinimalTaxonomy, createDefaultConfig } from './debateEngine.testHelpers.js';


// ── Adaptive situation re-scoring (t/455) ────────────────

describe('_rescoreSituations', () => {
  function makeEngine(taxonomyOverrides?: Partial<LoadedTaxonomy>) {
    const config = createDefaultConfig();
    const adapter = createMockAdapter();
    const taxonomy = { ...createMinimalTaxonomy(), ...taxonomyOverrides };
    const engine = new DebateEngine(config, adapter, taxonomy);
    (engine as any).initSession();
    return engine;
  }

  const MOCK_SITUATION: any = {
    id: 'sit-001', label: 'AI Risk Framing', description: 'A contested concept',
    interpretations: { accelerationist: 'opportunity', safetyist: 'threat', skeptic: 'hype' },
    linked_nodes: [], conflict_ids: [],
  };

  const MOCK_CRUX: any = {
    id: 'crux-001', description: 'Whether AI risk is existential',
    identified_turn: 1, state: 'active', history: [],
    attacking_claim_ids: ['AN-001'], speakers_involved: ['accelerationist', 'safetyist'],
    last_computed_strength: 0.6, support_polarity: -0.2,
  };

  const MOCK_AN_NODE: any = {
    id: 'AN-001', text: 'AI risk is existential', speaker: 'safetyist',
    bdi_category: 'belief', base_strength: 0.7,
  };

  it('computes situation score adjustments when crux_tracker and situations exist', () => {
    const engine = makeEngine({ situations: { nodes: [MOCK_SITUATION] } });
    const e = engine as any;

    e.session.crux_tracker = [MOCK_CRUX];
    e.session.argument_network = { nodes: [MOCK_AN_NODE], edges: [] };
    e.session.transcript = [
      { type: 'turn', speaker: 'safetyist', content: 'test', taxonomy_refs: [{ node_id: 'sit-001', relevance: 0.8 }] },
    ];
    e._contextManifests = [
      { round: 1, speaker: 'safetyist', pov: 'safetyist', injected_node_ids: ['sit-001', 'saf-B-001'], primary_node_ids: [], referenced_node_ids: [] },
    ];

    e._rescoreSituations();

    expect(e._situationScoreAdjustments).toBeInstanceOf(Map);
    expect(e._situationScoreAdjustments.size).toBeGreaterThanOrEqual(0);
  });

  it('skips re-scoring when crux_tracker is empty', () => {
    const engine = makeEngine({ situations: { nodes: [MOCK_SITUATION] } });
    const e = engine as any;

    e.session.crux_tracker = [];
    e.session.argument_network = { nodes: [MOCK_AN_NODE], edges: [] };
    e._situationScoreAdjustments = null;

    e._rescoreSituations();

    expect(e._situationScoreAdjustments).toBeNull();
  });

  it('skips re-scoring when no situation nodes exist', () => {
    const engine = makeEngine({ situations: { nodes: [] } });
    const e = engine as any;

    e.session.crux_tracker = [MOCK_CRUX];
    e.session.argument_network = { nodes: [MOCK_AN_NODE], edges: [] };
    e._situationScoreAdjustments = null;

    e._rescoreSituations();

    expect(e._situationScoreAdjustments).toBeNull();
  });

  it('skips re-scoring when argument_network is missing', () => {
    const engine = makeEngine({ situations: { nodes: [MOCK_SITUATION] } });
    const e = engine as any;

    e.session.crux_tracker = [MOCK_CRUX];
    e.session.argument_network = undefined;
    e._situationScoreAdjustments = null;

    e._rescoreSituations();

    expect(e._situationScoreAdjustments).toBeNull();
  });
});

// Helper: run engine and return session (may throw)
async function config_stamps_test(config: DebateConfig, adapter: ExtendedAIAdapter) {
  const engine = new DebateEngine(config, adapter, createMinimalTaxonomy());
  return engine.run();
}

// ── Duplicate opening guard (t/919) ─────────────────────

describe('Duplicate opening guard (t/919)', () => {
  function makeInitializedEngine() {
    const config = createDefaultConfig();
    const engine = new DebateEngine(config, createMockAdapter(), createMinimalTaxonomy());
    (engine as any).initSession();
    return engine as any;
  }

  it('addEntry blocks duplicate opening for the same speaker', () => {
    const e = makeInitializedEngine();

    const first = e.addEntry({ type: 'opening', speaker: 'safetyist', content: 'First opening', taxonomy_refs: [] });
    expect(first.id).toBeDefined();
    expect(e.session.transcript).toHaveLength(1);

    const duplicate = e.addEntry({ type: 'opening', speaker: 'safetyist', content: 'Duplicate opening', taxonomy_refs: [] });
    expect(duplicate.id).toBe(first.id);
    expect(e.session.transcript).toHaveLength(1);
    expect(e.session.transcript[0].content).toBe('First opening');
  });

  it('addEntry allows openings from different speakers', () => {
    const e = makeInitializedEngine();

    e.addEntry({ type: 'opening', speaker: 'safetyist', content: 'Safety opening', taxonomy_refs: [] });
    e.addEntry({ type: 'opening', speaker: 'accelerationist', content: 'Accel opening', taxonomy_refs: [] });
    e.addEntry({ type: 'opening', speaker: 'skeptic', content: 'Skeptic opening', taxonomy_refs: [] });

    expect(e.session.transcript).toHaveLength(3);
    const speakers = e.session.transcript.map((e: any) => e.speaker);
    expect(speakers).toEqual(['safetyist', 'accelerationist', 'skeptic']);
  });

  it('addEntry allows system entries alongside openings (no guard on type=system)', () => {
    const e = makeInitializedEngine();

    e.addEntry({ type: 'opening', speaker: 'safetyist', content: 'Opening', taxonomy_refs: [] });
    e.addEntry({ type: 'system', speaker: 'system', content: 'System message', taxonomy_refs: [] });
    e.addEntry({ type: 'statement', speaker: 'safetyist', content: 'Cross-respond', taxonomy_refs: [] });

    expect(e.session.transcript).toHaveLength(3);
  });

  it('runOpeningStatements skips speakers who already have an opening', async () => {
    const config = createDefaultConfig({ activePovers: ['accelerationist', 'safetyist'] });
    const responses = [
      // Only accelerationist should generate — 4 stages (brief, plan, draft, cite) + claim extraction
      JSON.stringify({ key_claims: [{ text: 'test', bdi_category: 'beliefs' }], strategy: 'explore' }),
      JSON.stringify({ plan: { strategy: 'test', key_claims: [] } }),
      JSON.stringify({ statement: 'Accelerationist opening.', my_claims: [], taxonomy_refs: [], policy_refs: [], turn_symbols: [], key_assumptions: [], move_types: [] }),
      JSON.stringify({ citations: [] }),
      JSON.stringify({ claims: [] }),
      // summary
      '{"summary": "test"}',
    ];
    const engine = new DebateEngine(config, createMockAdapter(responses), createMinimalTaxonomy());
    (engine as any).initSession();

    // Pre-populate safetyist opening
    (engine as any).session.transcript.push({
      id: 'pre-existing-opening',
      timestamp: new Date().toISOString(),
      type: 'opening',
      speaker: 'safetyist',
      content: 'Pre-existing safetyist opening statement.',
      taxonomy_refs: [],
    });

    await (engine as any).runOpeningStatements();

    const openings = (engine as any).session.transcript.filter((e: any) => e.type === 'opening');
    expect(openings).toHaveLength(2);

    const safetyistOpenings = openings.filter((e: any) => e.speaker === 'safetyist');
    expect(safetyistOpenings).toHaveLength(1);
    expect(safetyistOpenings[0].content).toBe('Pre-existing safetyist opening statement.');
  });
});

// ── Snapshot callback (t/932) ────────────────────────────

describe('Snapshot callback (t/932)', () => {
  it('emitSnapshot calls config.onSnapshot without throwing', () => {
    const onSnapshot = vi.fn();
    const config = createDefaultConfig({ onSnapshot });
    const adapter = createMockAdapter();
    const taxonomy = createMinimalTaxonomy();
    const engine = new DebateEngine(config, adapter, taxonomy);

    // Initialize the session so emitSnapshot has something to pass
    (engine as any).initSession();

    (engine as any).emitSnapshot('round_complete');
    expect(onSnapshot).toHaveBeenCalledOnce();
    expect(onSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ id: expect.any(String) }),
      'round_complete',
    );
  });

  it('emitSnapshot swallows callback errors without crashing', () => {
    const onSnapshot = vi.fn(() => { throw new Error('disk full'); });
    const config = createDefaultConfig({ onSnapshot });
    const adapter = createMockAdapter();
    const taxonomy = createMinimalTaxonomy();
    const engine = new DebateEngine(config, adapter, taxonomy);
    (engine as any).initSession();

    expect(() => (engine as any).emitSnapshot('error')).not.toThrow();
    expect(onSnapshot).toHaveBeenCalledOnce();
  });

  it('emitSnapshot is a no-op when onSnapshot is not configured', () => {
    const config = createDefaultConfig();
    const adapter = createMockAdapter();
    const taxonomy = createMinimalTaxonomy();
    const engine = new DebateEngine(config, adapter, taxonomy);
    (engine as any).initSession();

    expect(() => (engine as any).emitSnapshot('round_complete')).not.toThrow();
  });
});

// ── Rate-limit adaptive throttling (t/955) ───────────────

describe('rate-limit adaptive throttling', () => {
  it('recordRateLimit sets a 15s initial backoff', () => {
    const engine = new DebateEngine(createDefaultConfig(), createMockAdapter(), createMinimalTaxonomy());
    expect((engine as any)._rateLimitBackoffMs).toBe(0);

    (engine as any).recordRateLimit();

    expect((engine as any)._rateLimitBackoffMs).toBe(15_000);
    expect((engine as any)._lastRateLimitTime).toBeGreaterThan(0);
  });

  it('recordRateLimit doubles backoff on consecutive calls, capped at 120s', () => {
    const engine = new DebateEngine(createDefaultConfig(), createMockAdapter(), createMinimalTaxonomy());

    (engine as any).recordRateLimit(); // 15s
    (engine as any).recordRateLimit(); // 30s
    (engine as any).recordRateLimit(); // 60s
    (engine as any).recordRateLimit(); // 120s
    expect((engine as any)._rateLimitBackoffMs).toBe(120_000);

    (engine as any).recordRateLimit(); // still 120s (capped)
    expect((engine as any)._rateLimitBackoffMs).toBe(120_000);
  });

  it('clearRateLimitBackoff halves backoff and eventually resets to 0', () => {
    const engine = new DebateEngine(createDefaultConfig(), createMockAdapter(), createMinimalTaxonomy());

    (engine as any)._rateLimitBackoffMs = 16_000;
    (engine as any)._lastRateLimitTime = Date.now();

    (engine as any).clearRateLimitBackoff(); // 8000
    expect((engine as any)._rateLimitBackoffMs).toBe(8_000);

    (engine as any).clearRateLimitBackoff(); // 4000
    expect((engine as any)._rateLimitBackoffMs).toBe(4_000);

    (engine as any).clearRateLimitBackoff(); // 2000
    expect((engine as any)._rateLimitBackoffMs).toBe(2_000);

    (engine as any).clearRateLimitBackoff(); // <2000 → reset to 0
    expect((engine as any)._rateLimitBackoffMs).toBe(0);
    expect((engine as any)._lastRateLimitTime).toBe(0);
  });

  it('isRateLimitError detects 429 and rate limit patterns', () => {
    const engine = new DebateEngine(createDefaultConfig(), createMockAdapter(), createMinimalTaxonomy());
    const check = (err: unknown) => (engine as any).isRateLimitError(err);

    expect(check(new Error('HTTP 429: Too Many Requests'))).toBe(true);
    expect(check(new Error('Rate limited by API'))).toBe(true);
    expect(check(new Error('rate_limit exceeded'))).toBe(true);
    expect(check(new Error('rate-limit'))).toBe(true);
    expect(check(new Error('Server error 500'))).toBe(false);
    expect(check(new Error('Network timeout'))).toBe(false);
  });

  it('generate() records rate limit on 429 error and clears on success', async () => {
    let callCount = 0;
    const adapter: ExtendedAIAdapter = {
      async generateText() {
        callCount++;
        if (callCount === 1) throw new Error('429: Rate limited');
        return '{"text": "ok"}';
      },
    };

    const engine = new DebateEngine(createDefaultConfig(), adapter, createMinimalTaxonomy());
    (engine as any).initSession();

    // First call should throw and record rate limit
    await expect((engine as any).generate('prompt', 'test')).rejects.toThrow('429');
    expect((engine as any)._rateLimitBackoffMs).toBe(15_000);

    // Manually expire the backoff window so throttle doesn't actually wait
    (engine as any)._lastRateLimitTime = Date.now() - 20_000;

    // Second call succeeds and clears backoff
    await (engine as any).generate('prompt', 'test');
    expect((engine as any)._rateLimitBackoffMs).toBeLessThan(15_000);
  });

  it('throttle() waits when rate limit backoff is active', async () => {
    const engine = new DebateEngine(createDefaultConfig(), createMockAdapter(), createMinimalTaxonomy());
    (engine as any).onProgress = vi.fn();

    (engine as any)._rateLimitBackoffMs = 500;
    (engine as any)._lastRateLimitTime = Date.now();

    const start = Date.now();
    await (engine as any).throttle();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(400);
    expect((engine as any).onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('Rate-limited') }),
    );
  });

  it('throttle() skips wait when backoff window has elapsed', async () => {
    const engine = new DebateEngine(createDefaultConfig(), createMockAdapter(), createMinimalTaxonomy());

    (engine as any)._rateLimitBackoffMs = 1_000;
    (engine as any)._lastRateLimitTime = Date.now() - 2_000;

    const start = Date.now();
    await (engine as any).throttle();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(100);
  });
});

// ── Background field wiring (t/954) ──────────────────────

describe('background field in DebateConfig', () => {
  it('populates session.topic.background from config.background', () => {
    const config = createDefaultConfig({ background: 'Market concentration data and capex analysis' });
    const engine = new DebateEngine(config, createMockAdapter(), createMinimalTaxonomy());
    (engine as any).initSession();

    expect((engine as any).session.topic.background).toBe('Market concentration data and capex analysis');
  });

  it('omits session.topic.background when config.background is not set', () => {
    const config = createDefaultConfig();
    const engine = new DebateEngine(config, createMockAdapter(), createMinimalTaxonomy());
    (engine as any).initSession();

    expect((engine as any).session.topic.background).toBeUndefined();
  });

  it('omits session.topic.background when config.background is empty string', () => {
    const config = createDefaultConfig({ background: '' });
    const engine = new DebateEngine(config, createMockAdapter(), createMinimalTaxonomy());
    (engine as any).initSession();

    expect((engine as any).session.topic.background).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════
// stopAfterStage on resume() (t/1161)
// ══════════════════════════════════════════════════════════

describe('stopAfterStage on resume() (t/1161)', () => {
  function createCheckpoint(hasSynthesis = false) {
    const transcript: any[] = [
      { id: 'e1', timestamp: '2026-01-01T00:00:01Z', type: 'statement', speaker: 'accelerationist', content: 'AI accelerates progress', taxonomy_refs: [], metadata: {} },
      { id: 'e2', timestamp: '2026-01-01T00:00:02Z', type: 'statement', speaker: 'safetyist', content: 'AI poses risks', taxonomy_refs: [], metadata: {} },
      { id: 'e3', timestamp: '2026-01-01T00:00:03Z', type: 'statement', speaker: 'skeptic', content: 'AI hype is overblown', taxonomy_refs: [], metadata: {} },
    ];
    if (hasSynthesis) {
      transcript.push({
        id: 'e4', timestamp: '2026-01-01T00:00:04Z', type: 'concluding', speaker: 'system',
        content: 'Synthesis complete', taxonomy_refs: [],
        metadata: { synthesis: { areas_of_agreement: [], areas_of_disagreement: [] } },
      });
    }
    return {
      id: 'test-resume-stop',
      title: 'Test Resume',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      phase: 'debate' as const,
      topic: { original: 'Test topic', refined: null, final: 'Test topic' },
      source_type: 'topic' as const,
      source_ref: '',
      source_content: '',
      active_povers: ['accelerationist' as const, 'safetyist' as const, 'skeptic' as const],
      user_is_pover: false,
      transcript,
      context_summaries: [],
      diagnostics: {
        enabled: true,
        entries: {},
        overview: {
          total_ai_calls: 0,
          total_response_time_ms: 0,
          claims_accepted: 0,
          claims_rejected: 0,
          move_type_counts: {},
          disagreement_type_counts: {},
        },
      },
      argument_network: { nodes: [], edges: [] },
      commitments: {},
    };
  }

  function createCountingAdapter() {
    let callCount = 0;
    const adapter: ExtendedAIAdapter = {
      async generateText() {
        callCount++;
        return JSON.stringify({ areas_of_agreement: [], areas_of_disagreement: [], cruxes: [], argument_map: [{ id: 'a1', claim: 'test' }], preferences: [{ conflict: 'x', prevails: 'y', criterion: 'z', rationale: 'r' }] });
      },
    };
    return { adapter, getCallCount: () => callCount };
  }

  it('synthesis-p1 stop runs only Phase 1 and returns', async () => {
    const { adapter, getCallCount } = createCountingAdapter();
    const config = createDefaultConfig({ stopAfterStage: 'synthesis-p1' });
    const checkpoint = createCheckpoint(false);

    const session = await DebateEngine.resume(checkpoint as any, config, adapter, createMinimalTaxonomy());

    expect(getCallCount()).toBe(1);
    expect(session.diagnostics!.overview.total_ai_calls).toBe(1);
    expect(session.diagnostics!.overview.total_elapsed_ms).toBeGreaterThanOrEqual(0);
  });

  it('synthesis-p3 stop runs all 3 synthesis phases', async () => {
    const { adapter, getCallCount } = createCountingAdapter();
    const config = createDefaultConfig({ stopAfterStage: 'synthesis-p3' });
    const checkpoint = createCheckpoint(false);

    const session = await DebateEngine.resume(checkpoint as any, config, adapter, createMinimalTaxonomy());

    expect(getCallCount()).toBe(3);
    expect(session.diagnostics!.overview.total_ai_calls).toBe(3);
    expect(session.diagnostics!.overview.total_elapsed_ms).toBeGreaterThanOrEqual(0);
  });

  it('missing-arguments stop runs synthesis + missing-arguments pass', async () => {
    const { adapter, getCallCount } = createCountingAdapter();
    const config = createDefaultConfig({ stopAfterStage: 'missing-arguments' });
    const checkpoint = createCheckpoint(false);

    const session = await DebateEngine.resume(checkpoint as any, config, adapter, createMinimalTaxonomy());

    // 3 synthesis phases + 1 missing-arguments call
    expect(getCallCount()).toBeGreaterThanOrEqual(4);
    expect(session.diagnostics!.overview.total_elapsed_ms).toBeGreaterThanOrEqual(0);
  });

  it('taxonomy-refinement stop runs through taxonomy-refinement', async () => {
    const { adapter, getCallCount } = createCountingAdapter();
    const config = createDefaultConfig({ stopAfterStage: 'taxonomy-refinement' });
    const checkpoint = createCheckpoint(false);

    const session = await DebateEngine.resume(checkpoint as any, config, adapter, createMinimalTaxonomy());

    // 3 synthesis + missing-arguments + taxonomy-refinement
    expect(getCallCount()).toBeGreaterThanOrEqual(5);
    expect(session.diagnostics!.overview.total_elapsed_ms).toBeGreaterThanOrEqual(0);
  });

  it('omitting stopAfterStage runs full pipeline (regression)', async () => {
    const { adapter, getCallCount } = createCountingAdapter();
    const config = createDefaultConfig();
    const checkpoint = createCheckpoint(false);

    const session = await DebateEngine.resume(checkpoint as any, config, adapter, createMinimalTaxonomy());

    // Full pipeline: synthesis(3) + missing-args + taxonomy-ref + cross-cutting + extraction-coverage
    expect(getCallCount()).toBeGreaterThanOrEqual(5);
    expect(session.diagnostics!.overview.total_elapsed_ms).toBeGreaterThanOrEqual(0);
  });

  it('already-synthesized checkpoint with synthesis stop returns immediately', async () => {
    const { adapter, getCallCount } = createCountingAdapter();
    const config = createDefaultConfig({ stopAfterStage: 'synthesis-p1' });
    const checkpoint = createCheckpoint(true);

    const session = await DebateEngine.resume(checkpoint as any, config, adapter, createMinimalTaxonomy());

    expect(getCallCount()).toBe(0);
    expect(session.diagnostics!.overview.total_elapsed_ms).toBeGreaterThanOrEqual(0);
  });

  it('finalization stop runs the full pipeline (same as omitting)', async () => {
    const { adapter: adapterFull, getCallCount: getFullCount } = createCountingAdapter();
    const { adapter: adapterFin, getCallCount: getFinCount } = createCountingAdapter();
    const configFull = createDefaultConfig();
    const configFin = createDefaultConfig({ stopAfterStage: 'finalization' });

    await DebateEngine.resume(createCheckpoint(false) as any, configFull, adapterFull, createMinimalTaxonomy());
    await DebateEngine.resume(createCheckpoint(false) as any, configFin, adapterFin, createMinimalTaxonomy());

    expect(getFinCount()).toBe(getFullCount());
  });

  it('LifecycleStage type is importable', () => {
    const stage: LifecycleStage = 'synthesis-p1';
    expect(stage).toBe('synthesis-p1');
    const allStages: LifecycleStage[] = [
      'synthesis-p1', 'synthesis-p2', 'synthesis-p3',
      'missing-arguments', 'taxonomy-refinement',
      'extraction-coverage', 'finalization',
    ];
    expect(allStages).toHaveLength(7);
  });
});

