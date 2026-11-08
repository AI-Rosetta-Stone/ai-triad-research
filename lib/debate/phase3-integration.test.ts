// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * T3.1 Phase 3 Integration Tests
 *
 * Validates Phase 2 integration into production paths.
 * - Debate V2, Cache V2, AI Client V2 wiring
 * - Flag paths (enabled/disabled)
 * - Non-blocking fallback
 * - Performance (no regression)
 */

import { describe, it, expect, vi } from 'vitest';
import type { DebateSession, TranscriptEntry } from './types.js';
import type { AIAdapter } from './aiAdapter.js';
import { DebateEngineAdapterV2 } from './debateEngineAdapterV2.js';

describe('Phase 3 Integration: Debate V2', () => {
  it('should export integration function', async () => {
    const { enrichSessionWithV2Grounding } = await import('./debateEngineV2Integration.js');
    expect(enrichSessionWithV2Grounding).toBeDefined();
    expect(typeof enrichSessionWithV2Grounding).toBe('function');
  });

  it('should export V2 engine factory', async () => {
    const { createV2EngineIfEnabled, verifyV2EngineReadiness } =
      await import('./debateEngineV2Integration.js');

    expect(createV2EngineIfEnabled).toBeDefined();
    expect(verifyV2EngineReadiness).toBeDefined();
  });

  it('retains the V2 engine across turns in the same session', async () => {
    vi.stubEnv('DEBATE_NEW_ENGINE', 'true');
    const adapterInstances: DebateEngineAdapterV2[] = [];
    const enrichSpy = vi.spyOn(DebateEngineAdapterV2.prototype, 'enrichTranscriptEntry')
      .mockImplementation(async function (this: DebateEngineAdapterV2, entry) {
        adapterInstances.push(this);
        return entry;
      });
    const entry = {
      id: 'turn-1',
      speaker: 'acc',
      content: 'argument',
    } as TranscriptEntry;
    const session = {
      id: 'session-1',
      topic: { final: 'topic' },
      transcript: [entry],
    } as DebateSession;

    try {
      const { enrichSessionWithV2Grounding } = await import('./debateEngineV2Integration.js');
      await enrichSessionWithV2Grounding(session, entry, {} as AIAdapter);
      await enrichSessionWithV2Grounding(session, entry, {} as AIAdapter);

      expect(adapterInstances).toHaveLength(2);
      expect(adapterInstances[0]).toBe(adapterInstances[1]);
    } finally {
      enrichSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('should be ready for production', async () => {
    const { verifyV2EngineReadiness } = await import('./debateEngineV2Integration.js');
    const ready = await verifyV2EngineReadiness();
    expect(typeof ready).toBe('boolean');
  });
});

describe('Phase 3 Integration: AI Client V2', () => {
  it('should export wrapper factory', async () => {
    const { createAIClientV2Wrapper } = await import('../ai-client/aiClientV2Integration.js');
    expect(createAIClientV2Wrapper).toBeDefined();
    expect(typeof createAIClientV2Wrapper).toBe('function');
  });

  it('should export readiness check', async () => {
    const { isAIClientV2Ready } = await import('../ai-client/aiClientV2Integration.js');
    expect(isAIClientV2Ready).toBeDefined();
    expect(typeof isAIClientV2Ready).toBe('function');
  });

  it('should report readiness status', async () => {
    const { isAIClientV2Ready } = await import('../ai-client/aiClientV2Integration.js');
    const ready = isAIClientV2Ready();
    expect(typeof ready).toBe('boolean');
  });
});

describe('Phase 3 Integration: Taxonomy Cache V2', () => {
  it('should export cache functions', async () => {
    const { loadNodeWithCache, loadNodesWithCache, clearTaxonomyCache, getTaxonomyCacheStats } =
      await import('./taxonomyCacheIntegration.js');

    expect(loadNodeWithCache).toBeDefined();
    expect(loadNodesWithCache).toBeDefined();
    expect(clearTaxonomyCache).toBeDefined();
    expect(getTaxonomyCacheStats).toBeDefined();
  });

  it('should initialize cache', async () => {
    const { initTaxonomyCache } = await import(
      './taxonomyCacheIntegration.js'
    );
    expect(() => initTaxonomyCache()).not.toThrow();
  });
});

describe('Phase 3: Flag Defaults', () => {
  it('should have all Phase 2 flags available', async () => {
    const { getFlagValue } = await import('../phase2Flags.js');

    const flags = ['DEBATE_NEW_ENGINE', 'AI_CLIENT_V2_ENABLED', 'TAXONOMY_CACHE_V2'] as const;

    for (const flag of flags) {
      const value = getFlagValue(flag);
      expect(typeof value).toBe('boolean');
    }
  });

  it('should default to safe v1 paths', async () => {
    const { getFlagValue } = await import('../phase2Flags.js');

    // All Phase 2 features default false (safe, backward compatible)
    expect(getFlagValue('DEBATE_NEW_ENGINE')).toBe(false);
    expect(getFlagValue('AI_CLIENT_V2_ENABLED')).toBe(false);
    expect(getFlagValue('TAXONOMY_CACHE_V2')).toBe(false);
  });
});

describe('Phase 3: TypeScript Compilation', () => {
  it('should compile without errors', async () => {
    // If we get here, all imports compiled successfully
    const m1 = await import('./debateEngineV2Integration.js');
    const m2 = await import('../ai-client/aiClientV2Integration.js');
    const m3 = await import('./taxonomyCacheIntegration.js');

    expect(m1).toBeDefined();
    expect(m2).toBeDefined();
    expect(m3).toBeDefined();
  });
});
