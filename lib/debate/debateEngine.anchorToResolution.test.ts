// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/284 item 2 (ArCo): anchorToResolution runs resolution anchoring after scope extraction when
// clarification is off. Clarification-on runs keep their existing path; the default is unchanged.

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('./calibrationLogger.js', async (importOriginal) =>
  (await import('./__tests__/hermeticCalibration.js')).hermeticCalibrationLogger(importOriginal));

import { DebateEngine } from './debateEngine.js';
import { TopicPipeline } from './topicPipeline.js';
import { createMockAdapter, createMinimalTaxonomy, createDefaultConfig } from './debateEngine.testHelpers.js';

function mockResponses(): string[] {
  const responses: string[] = [];
  for (let i = 0; i < 200; i++) {
    responses.push(JSON.stringify({
      statement: 'Mock', my_claims: [], taxonomy_refs: [],
      move_types: [], claims: [],
      areas_of_agreement: [], areas_of_disagreement: [],
      cruxes: [], unresolved_questions: [], summary: 'Mock',
      responder: 'safetyist', addressing: 'accelerationist',
      focus_point: 'test', agreement_detected: false, intervene: false,
      suggested_move: 'PIN', target_debater: 'safetyist',
      trigger_reasoning: 'r', trigger_evidence: 'e',
      outcome: 'accept', score: 0.8, flags: [], clarifies_taxonomy: [],
    }));
  }
  return responses;
}

describe('DebateEngine: anchorToResolution (t/284 item 2)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs resolution anchoring when anchorToResolution is on and clarification is off', async () => {
    const spy = vi.spyOn(TopicPipeline.prototype, 'runResolutionAnchoring');
    const config = createDefaultConfig({ enableClarification: false, anchorToResolution: true, rounds: 1 });
    const engine = new DebateEngine(config, createMockAdapter(mockResponses()), createMinimalTaxonomy());
    await engine.run();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does not run resolution anchoring by default (flag off, clarification off)', async () => {
    const spy = vi.spyOn(TopicPipeline.prototype, 'runResolutionAnchoring');
    const config = createDefaultConfig({ enableClarification: false, rounds: 1 });
    const engine = new DebateEngine(config, createMockAdapter(mockResponses()), createMinimalTaxonomy());
    await engine.run();
    expect(spy).not.toHaveBeenCalled();
  });
});
