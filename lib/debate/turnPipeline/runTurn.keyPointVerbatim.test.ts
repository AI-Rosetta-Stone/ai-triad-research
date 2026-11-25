// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/296: the live evidence index stores keyPoints[].verbatim as a string array in some entries.
// Drives the real turn pipeline, with such an entry in the evidence index, and asserts it does not
// throw. The grounding loop in runTurn.ts called .toLowerCase() on that field and crashed the turn.

import { describe, it, expect } from 'vitest';
import { runTurnPipeline } from './runTurn.js';
import type { TurnPipelineInput } from './types.js';
import { POVER_INFO } from '../types.js';

const NODE_ID = 'acc-bel-001';

const TURN_STUB = JSON.stringify({
  situation_assessment: 'test', key_claims_to_address: [], relevant_commitments: [], edge_tensions: [], phase_considerations: 'test',
  strategic_goal: 'test', planned_moves: [], target_claims: [], target_nodes: [NODE_ID], argument_sketch: 'test', anticipated_responses: [],
  statement: 'Frontier developers should retain audit records for five years under a documented policy.',
  turn_symbols: [], claim_sketches: [], key_assumptions: [], disagreement_type: 'EMPIRICAL',
  taxonomy_refs: [], policy_refs: [], move_annotations: [], grounding_confidence: 0.9,
});

function makeInput(overrides: Partial<TurnPipelineInput> = {}): TurnPipelineInput {
  return {
    label: 'TestAgent', pov: 'acc', soul: POVER_INFO['accelerationist'], personality: 'test', topic: 'test topic',
    taxonomyContext: '', commitmentContext: '', establishedPoints: '', edgeContext: '',
    concessionHint: '', recentTranscript: '', focusPoint: '', addressing: '',
    phase: 'exploration', priorMoves: [], turnsSinceLastConcession: 0,
    priorRefs: [], availablePovNodeIds: [NODE_ID], model: 'test-model',
    skipPreCheck: true,
    // One key point whose verbatim is a string array, as stored in 319 live index entries.
    sourceEvidenceIndex: {
      [NODE_ID]: {
        facts: [],
        keyPoints: [{ doc_id: 'doc-1', point: 'Audit records are retained for five years.', verbatim: ['Retain records for five years', 'under a documented policy'] }],
      },
    } as never,
    ...overrides,
  };
}

describe('runTurnPipeline with an array-valued keyPoint verbatim (t/296)', () => {
  it('does not throw when an evidence keyPoint verbatim is a string array', async () => {
    const generate = async () => TURN_STUB;
    await expect(runTurnPipeline(makeInput(), generate as never)).resolves.toBeDefined();
  });
});
