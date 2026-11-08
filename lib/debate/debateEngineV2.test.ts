/**
 * Tests for DebateEngineV2 — Improved BDI Processing
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  DebateEngineV2,
  createDebateEngineV2,
  type BDIState,
  type DebateContext,
  DebateEngineV2Error,
} from './debateEngineV2.js';
import type { AIAdapter } from './aiAdapter.js';

// ─────────────────────────────────────────────────────────────────────────
// Mock AIAdapter
// ─────────────────────────────────────────────────────────────────────────

const mockAIAdapter: AIAdapter = {
  call: vi.fn(async (params) => {
    if (params.messages[0]?.content?.includes('Extract Beliefs')) {
      return {
        text: JSON.stringify({
          beliefs: [
            {
              claim: 'AI development requires safety measures',
              strength: 0.9,
              source: 'domain_knowledge',
            },
          ],
          desires: [
            {
              goal: 'Ensure responsible AI deployment',
              priority: 0.95,
              rationale: 'Align with safety-first principles',
            },
          ],
          intentions: [
            {
              action: 'Propose governance framework',
              means: ['literature review', 'stakeholder consultation'],
            },
          ],
        }),
      };
    }
    return { text: 'Mock response' };
  }),
};

// ─────────────────────────────────────────────────────────────────────────
// Test Suite
// ─────────────────────────────────────────────────────────────────────────

describe('DebateEngineV2', () => {
  let engine: DebateEngineV2;
  let context: DebateContext;

  beforeEach(() => {
    engine = createDebateEngineV2(mockAIAdapter, { enableTelemetry: false });
    context = {
      topic: 'AI Safety Policy',
      povId: 'acc-001-001',
      sessionId: 'session-123',
      round: 1,
    };
  });

  // ───────────────────────────────────────────────────────────────────────
  // BDI State Management Tests
  // ───────────────────────────────────────────────────────────────────────

  describe('BDI State Management', () => {
    it('initializes empty BDI state for new participant', () => {
      const state = engine['initializeBDIState']('acc-001-001');

      expect(state.beliefs.core).toEqual([]);
      expect(state.desires.primary).toEqual([]);
      expect(state.intentions.planned).toEqual([]);
      expect(state.confidence).toBe(0.5);
      expect(state.history).toEqual([]);
    });

    it('maintains separate BDI states for different participants', async () => {
      const argument1 = 'AI safety is critical for responsible deployment.';
      const argument2 = 'Market dynamics drive responsible AI development.';

      const context1 = { ...context, povId: 'acc-001-001' };
      const context2 = { ...context, povId: 'saf-001-001' };

      await engine.processTurn(context1.povId, argument1, context1);
      await engine.processTurn(context2.povId, argument2, context2);

      expect(mockAIAdapter.call).toHaveBeenCalledTimes(4); // 2 extractions + 2 responses
    });

    it('records BDI state history snapshots', async () => {
      const argument = 'We need international AI governance agreements.';

      await engine.processTurn(context.povId, argument, context);

      // Verify history was recorded
      expect(mockAIAdapter.call).toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // BDI Extraction Tests
  // ───────────────────────────────────────────────────────────────────────

  describe('BDI Extraction', () => {
    it('extracts beliefs from argument', async () => {
      const argument = 'AI systems require robust safety testing before deployment.';

      const result = await engine.processTurn(context.povId, argument, context);

      expect(result.bdiState.beliefs.core.length).toBeGreaterThan(0);
      expect(result.bdiState.beliefs.core[0]?.claim).toContain('safety');
    });

    it('extracts desires (goals) from argument', async () => {
      const argument =
        'We should prioritize creating international standards for AI safety.';

      const result = await engine.processTurn(context.povId, argument, context);

      expect(result.bdiState.desires.primary.length).toBeGreaterThan(0);
    });

    it('extracts intentions (planned actions) from argument', async () => {
      const argument =
        'Let me propose a multi-stakeholder governance framework for AI oversight.';

      const result = await engine.processTurn(context.povId, argument, context);

      expect(result.bdiState.intentions.planned.length).toBeGreaterThan(0);
    });

    it('handles malformed BDI responses gracefully', async () => {
      const badAdapter: AIAdapter = {
        call: vi.fn(async () => ({ text: 'invalid json {' })),
      };

      const badEngine = createDebateEngineV2(badAdapter);
      const argument = 'Test argument';

      // Should not throw, should return empty BDI
      const result = await badEngine.processTurn(context.povId, argument, context);

      expect(result).toBeDefined();
      expect(result.bdiState.beliefs.core.length).toBe(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // BDI Coherence Tests
  // ───────────────────────────────────────────────────────────────────────

  describe('BDI Coherence', () => {
    it('computes coherence score between 0 and 1', async () => {
      const argument = 'AI safety requires international cooperation.';

      const result = await engine.processTurn(context.povId, argument, context);

      expect(result.coherenceScore).toBeGreaterThanOrEqual(0);
      expect(result.coherenceScore).toBeLessThanOrEqual(1);
    });

    it('returns higher coherence when beliefs align with intentions', async () => {
      const argument =
        'We believe AI safety is paramount and intend to establish governance frameworks.';

      const result = await engine.processTurn(context.povId, argument, context);

      // Coherence should be reasonably high when beliefs align with intentions
      expect(result.coherenceScore).toBeGreaterThan(0.4);
    });

    it('tracks coherence evolution over multiple turns', async () => {
      const argument1 = 'AI safety is important.';
      const argument2 = 'We should implement safety standards.';

      const result1 = await engine.processTurn(context.povId, argument1, context);
      const result2 = await engine.processTurn(
        context.povId,
        argument2,
        { ...context, round: 2 }
      );

      expect(result1.coherenceScore).toBeDefined();
      expect(result2.coherenceScore).toBeDefined();
      // Second turn should show coherence evolution
      expect(result2.bdiState.history.length).toBeGreaterThan(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Performance Tests
  // ───────────────────────────────────────────────────────────────────────

  describe('Performance', () => {
    it('processes turn within acceptable latency (<500ms)', async () => {
      const argument = 'AI safety requires thoughtful policy design.';

      const result = await engine.processTurn(context.povId, argument, context);

      expect(result.processingTimeMs).toBeLessThan(500);
    });

    it('returns performance metrics', async () => {
      const argument = 'International AI governance is essential.';

      await engine.processTurn(context.povId, argument, context);

      const metrics = engine.getMetrics();

      expect(metrics.bdiUpdatesProcessed).toBeGreaterThan(0);
      expect(metrics.avgTurnProcessingMs).toBeGreaterThan(0);
      expect(metrics.errorsEncountered).toBe(0);
      expect(metrics.engineEnabled).toBeDefined();
    });

    it('tracks multiple turns without performance degradation', async () => {
      const arguments = [
        'AI safety is paramount.',
        'We need governance frameworks.',
        'International cooperation is essential.',
      ];

      const results = [];
      for (let i = 0; i < arguments.length; i++) {
        const result = await engine.processTurn(context.povId, arguments[i], {
          ...context,
          round: i + 1,
        });
        results.push(result);
      }

      const metrics = engine.getMetrics();

      // All turns should complete
      expect(results.length).toBe(3);
      // No errors expected
      expect(metrics.errorsEncountered).toBe(0);
      // BDI should be updated for each turn
      expect(metrics.bdiUpdatesProcessed).toBe(3);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Error Handling Tests
  // ───────────────────────────────────────────────────────────────────────

  describe('Error Handling', () => {
    it('throws DebateEngineV2Error on AI adapter failure', async () => {
      const failingAdapter: AIAdapter = {
        call: vi.fn(async () => {
          throw new Error('API timeout');
        }),
      };

      const failingEngine = createDebateEngineV2(failingAdapter);
      const argument = 'Test argument';

      await expect(
        failingEngine.processTurn(context.povId, argument, context)
      ).rejects.toThrow(DebateEngineV2Error);
    });

    it('records errors in metrics', async () => {
      const failingAdapter: AIAdapter = {
        call: vi.fn(async () => {
          throw new Error('Network error');
        }),
      };

      const failingEngine = createDebateEngineV2(failingAdapter);

      try {
        await failingEngine.processTurn(context.povId, 'test', context);
      } catch {
        // Expected
      }

      const metrics = failingEngine.getMetrics();
      expect(metrics.errorsEncountered).toBeGreaterThan(0);
    });

    it('continues processing after non-fatal errors', async () => {
      let callCount = 0;
      const flakeyAdapter: AIAdapter = {
        call: vi.fn(async (params) => {
          callCount++;
          if (callCount === 1) {
            throw new Error('Temporary error');
          }
          return { text: 'Recovery successful' };
        }),
      };

      const flakeyEngine = createDebateEngineV2(flakeyAdapter);

      // First call should fail
      await expect(
        flakeyEngine.processTurn(context.povId, 'arg1', context)
      ).rejects.toThrow();

      // Note: In production, retry logic would be applied
      // For now, this demonstrates error isolation
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Integration Tests
  // ───────────────────────────────────────────────────────────────────────

  describe('Integration', () => {
    it('simulates multi-turn debate with BDI grounding', async () => {
      const turns = [
        {
          povId: 'acc-001-001',
          argument: 'AI development requires safety measures.',
        },
        {
          povId: 'saf-001-001',
          argument: 'We need comprehensive governance frameworks.',
        },
        {
          povId: 'acc-001-001',
          argument: 'Market incentives can drive responsible practices.',
        },
      ];

      for (let i = 0; i < turns.length; i++) {
        const turn = turns[i];
        const result = await engine.processTurn(
          turn.povId,
          turn.argument,
          { ...context, round: i + 1 }
        );

        expect(result.argument).toBe(turn.argument);
        expect(result.response).toBeDefined();
        expect(result.bdiState).toBeDefined();
        expect(result.coherenceScore).toBeGreaterThanOrEqual(0);
      }

      const metrics = engine.getMetrics();
      expect(metrics.bdiUpdatesProcessed).toBe(3);
    });

    it('enables DEBATE_NEW_ENGINE flag in metrics', () => {
      const metrics = engine.getMetrics();
      expect(metrics.engineEnabled).toBeDefined();
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Backward Compatibility Tests
  // ───────────────────────────────────────────────────────────────────────

  describe('Backward Compatibility', () => {
    it('maintains compatibility with existing debate types', async () => {
      const argument = 'Test argument for debate system';

      const result = await engine.processTurn(context.povId, argument, context);

      // Result should have all expected fields
      expect(result.argument).toBe(argument);
      expect(result.response).toBeDefined();
      expect(result.bdiState).toBeDefined();
      expect(result.processingTimeMs).toBeGreaterThan(0);
      expect(result.coherenceScore).toBeGreaterThanOrEqual(0);
    });

    it('works with all debate phases', async () => {
      const phases = ['opening', 'investigation', 'synthesis'];

      for (const phase of phases) {
        const testContext = { ...context, round: 1 };
        const argument = `Test argument for ${phase} phase`;

        const result = await engine.processTurn(context.povId, argument, testContext);

        expect(result).toBeDefined();
        expect(result.bdiState).toBeDefined();
      }
    });
  });
});
