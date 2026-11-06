// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi } from 'vitest';
import { runSynthesisPhases } from './synthesisPhases.js';
import type { SynthesisInput } from './synthesisPhases.js';

const INPUT: SynthesisInput = {
  topic: 'AI governance',
  transcript: 'ACC: We need speed. SAF: We need caution. SKP: Where is the evidence?',
};

function validPhase1Json(): string {
  return JSON.stringify({
    areas_of_agreement: [{ point: 'AI will transform society' }],
    areas_of_disagreement: [{ point: 'Speed of deployment' }],
    cruxes: [{ question: 'How fast is too fast?' }],
    unresolved_questions: [{ question: 'What metrics to use?' }],
  });
}

function validPhase2Json(): string {
  return JSON.stringify({
    argument_map: [{ claim: 'Speed matters', support: 'acc', oppose: 'saf' }],
    taxonomy_coverage: [{ node_id: 'acc-B-001', referenced: true }],
  });
}

function validPhase3Json(): string {
  return JSON.stringify({
    preferences: [{ dimension: 'Safety vs Speed', position: 'balanced' }],
    policy_implications: [{ policy: 'Require audits', impact: 'medium' }],
  });
}

describe('runSynthesisPhases', () => {
  it('merges all three phases into final data', async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce(validPhase1Json())
      .mockResolvedValueOnce(validPhase2Json())
      .mockResolvedValueOnce(validPhase3Json());

    const result = await runSynthesisPhases(INPUT, generate);

    expect(result.data.areas_of_agreement).toHaveLength(1);
    expect(result.data.areas_of_disagreement).toHaveLength(1);
    expect(result.data.cruxes).toHaveLength(1);
    expect(result.data.argument_map).toHaveLength(1);
    expect(result.data.preferences).toHaveLength(1);
    expect(result.data.policy_implications).toHaveLength(1);
  });

  it('Phase 3 fallback parsing does NOT clobber Phase 1/2 data', async () => {
    // Phase 3 returns malformed JSON that triggers extractArraysFromPartialJson,
    // which returns ALL 8 keys with empty arrays for keys not in the response.
    // Before the fix, Object.assign would overwrite Phase 1/2 populated data.
    const malformedPhase3 = '{"preferences": [{"dimension": "speed"}], "policy_implications": [{"pol": "audit"}]' +
      ' TRUNCATED HERE — this is not valid JSON';

    const generate = vi.fn()
      .mockResolvedValueOnce(validPhase1Json())
      .mockResolvedValueOnce(validPhase2Json())
      .mockResolvedValueOnce(malformedPhase3);

    const warn = vi.fn();
    const result = await runSynthesisPhases(INPUT, generate, undefined, warn);

    // Phase 1 data must survive
    expect(result.data.areas_of_agreement).toHaveLength(1);
    expect(result.data.areas_of_disagreement).toHaveLength(1);
    expect(result.data.cruxes).toHaveLength(1);

    // Phase 2 data must survive
    expect(result.data.argument_map).toHaveLength(1);

    // Phase 3 data should be present (extracted from partial JSON)
    expect(result.data.preferences).toHaveLength(1);
    expect(result.data.policy_implications).toHaveLength(1);
  });

  it('Phase 2 fallback parsing does NOT clobber Phase 1 data', async () => {
    const malformedPhase2 = '{"argument_map": [{"claim": "speed"}] NOT VALID JSON';

    const generate = vi.fn()
      .mockResolvedValueOnce(validPhase1Json())
      .mockResolvedValueOnce(malformedPhase2)
      .mockResolvedValueOnce(validPhase3Json());

    const warn = vi.fn();
    const result = await runSynthesisPhases(INPUT, generate, undefined, warn);

    // Phase 1 data must survive Phase 2 fallback
    expect(result.data.areas_of_agreement).toHaveLength(1);
    expect(result.data.areas_of_disagreement).toHaveLength(1);
    expect(result.data.cruxes).toHaveLength(1);
    expect(result.data.unresolved_questions).toHaveLength(1);

    // Phase 2 partial data
    expect(result.data.argument_map).toHaveLength(1);

    // Phase 3 data
    expect(result.data.preferences).toHaveLength(1);
  });

  it('all phases fallback — each only populates its own keys', async () => {
    const malformed1 = '{"areas_of_agreement": [{"p": "a"}], "cruxes": [{"q": "c"}] BROKEN';
    const malformed2 = '{"argument_map": [{"c": "x"}] BROKEN';
    const malformed3 = '{"preferences": [{"d": "y"}] BROKEN';

    const generate = vi.fn()
      .mockResolvedValueOnce(malformed1)
      .mockResolvedValueOnce(malformed2)
      .mockResolvedValueOnce(malformed3);

    const warn = vi.fn();
    const result = await runSynthesisPhases(INPUT, generate, undefined, warn);

    expect(result.data.areas_of_agreement).toHaveLength(1);
    expect(result.data.cruxes).toHaveLength(1);
    expect(result.data.argument_map).toHaveLength(1);
    expect(result.data.preferences).toHaveLength(1);
  });

  it('retries Phase 2 when argument_map is empty', async () => {
    const emptyMap = JSON.stringify({ argument_map: [], taxonomy_coverage: [] });
    const retryMap = JSON.stringify({ argument_map: [{ claim: 'retried' }], taxonomy_coverage: [] });

    const generate = vi.fn()
      .mockResolvedValueOnce(validPhase1Json())
      .mockResolvedValueOnce(emptyMap)
      .mockResolvedValueOnce(retryMap)       // retry for Phase 2
      .mockResolvedValueOnce(validPhase3Json());

    const warn = vi.fn();
    const result = await runSynthesisPhases(INPUT, generate, undefined, warn);

    expect(generate).toHaveBeenCalledTimes(4);
    expect(result.data.argument_map).toHaveLength(1);
    expect((result.data.argument_map as Array<{ claim: string }>)[0].claim).toBe('retried');
  });

  it('retries Phase 3 when preferences is empty', async () => {
    const emptyPrefs = JSON.stringify({ preferences: [], policy_implications: [] });
    const retryPrefs = JSON.stringify({ preferences: [{ dim: 'retried' }], policy_implications: [{ p: 'ok' }] });

    const generate = vi.fn()
      .mockResolvedValueOnce(validPhase1Json())
      .mockResolvedValueOnce(validPhase2Json())
      .mockResolvedValueOnce(emptyPrefs)
      .mockResolvedValueOnce(retryPrefs);     // retry for Phase 3

    const warn = vi.fn();
    const result = await runSynthesisPhases(INPUT, generate, undefined, warn);

    expect(generate).toHaveBeenCalledTimes(4);
    expect(result.data.preferences).toHaveLength(1);
    expect((result.data.preferences as Array<{ dim: string }>)[0].dim).toBe('retried');
  });

  it('stores raw responses for diagnostics', async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce(validPhase1Json())
      .mockResolvedValueOnce(validPhase2Json())
      .mockResolvedValueOnce(validPhase3Json());

    const result = await runSynthesisPhases(INPUT, generate);

    expect(result.rawResponses.extract).toBe(validPhase1Json());
    expect(result.rawResponses.map).toBe(validPhase2Json());
    expect(result.rawResponses.evaluate).toBe(validPhase3Json());
    expect(result.elapsed_ms).toBeGreaterThanOrEqual(0);
  });
});

// t/4929: partial-JSON recovery must persist a machine-readable marker, not just a WARN.
describe('runSynthesisPhases degraded marker', () => {
  it('clean synthesis carries no degraded marker', async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce(validPhase1Json())
      .mockResolvedValueOnce(validPhase2Json())
      .mockResolvedValueOnce(validPhase3Json());

    const result = await runSynthesisPhases(INPUT, generate);

    expect(result.data).not.toHaveProperty('degraded');
    expect(result.data).not.toHaveProperty('degraded_phases');
  });

  it('marks the synthesis degraded when a phase is partially recovered, and keeps the WARN', async () => {
    const malformedPhase3 = '{"preferences": [{"dimension": "speed"}] TRUNCATED';
    const generate = vi.fn()
      .mockResolvedValueOnce(validPhase1Json())
      .mockResolvedValueOnce(validPhase2Json())
      .mockResolvedValueOnce(malformedPhase3);
    const warn = vi.fn();

    const result = await runSynthesisPhases(INPUT, generate, undefined, warn);

    expect(result.data.degraded).toBe(true);
    expect(result.data.degraded_phases).toEqual(['evaluate']);
    expect(warn).toHaveBeenCalledWith(
      'Synthesis Phase 3 parse',
      'Primary JSON parse failed, recovered partial data via fallback',
      'Synthesis may be incomplete',
    );
  });

  it('lists every phase that fell back, in phase order', async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce('{"areas_of_agreement": [{"p": "a"}] BROKEN')
      .mockResolvedValueOnce('{"argument_map": [{"c": "x"}] BROKEN')
      .mockResolvedValueOnce('{"preferences": [{"d": "y"}] BROKEN');

    const result = await runSynthesisPhases(INPUT, generate, undefined, vi.fn());

    expect(result.data.degraded).toBe(true);
    expect(result.data.degraded_phases).toEqual(['extract', 'map', 'evaluate']);
  });

  it('does not mark a phase whose fallback data was replaced by a clean retry', async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce(validPhase1Json())
      .mockResolvedValueOnce('{"taxonomy_coverage": [{"node_id": "acc-B-001"}] BROKEN') // fallback, no argument_map → retry
      .mockResolvedValueOnce(validPhase2Json())                                          // clean retry replaces it
      .mockResolvedValueOnce(validPhase3Json());

    const result = await runSynthesisPhases(INPUT, generate, undefined, vi.fn());

    expect(generate).toHaveBeenCalledTimes(4);
    expect(result.data).not.toHaveProperty('degraded');
  });

  it('keeps the mark when the retry does not replace the recovered data', async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce(validPhase1Json())
      .mockResolvedValueOnce('{"taxonomy_coverage": [{"node_id": "acc-B-001"}] BROKEN')
      .mockResolvedValueOnce(JSON.stringify({ argument_map: [] }))                       // retry still empty
      .mockResolvedValueOnce(validPhase3Json());

    const result = await runSynthesisPhases(INPUT, generate, undefined, vi.fn());

    expect(result.data.degraded).toBe(true);
    expect(result.data.degraded_phases).toEqual(['map']);
  });

  it('applies the marker on the maxPhase early return', async () => {
    const generate = vi.fn().mockResolvedValueOnce('{"cruxes": [{"q": "c"}] BROKEN');

    const result = await runSynthesisPhases(INPUT, generate, undefined, vi.fn(), undefined, 1);

    expect(result.data.degraded).toBe(true);
    expect(result.data.degraded_phases).toEqual(['extract']);
  });
});
