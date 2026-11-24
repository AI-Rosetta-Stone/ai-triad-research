// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect } from 'vitest';
import {
  clarificationPrompt,
  concludingPrompt,
  userSeedClaimsPrompt,
  openingStatementPrompt,
  debateResponsePrompt,
  formatCriticalQuestions,
  selectReframingMetaphor,
  crossRespondSelectionPrompt,
  crossRespondPrompt,
  briefOpeningStagePrompt,
  planOpeningStagePrompt,
  draftOpeningStagePrompt,
  citeOpeningStagePrompt,
  briefStagePrompt,
  briefStagePromptV2,
  planStagePrompt,
  draftStagePrompt,
  citeStagePrompt,
  synthExtractPrompt,
  synthMapPrompt,
  synthEvaluatePrompt,
  debateSynthesisPrompt,
  probingQuestionsPrompt,
  factCheckPrompt,
  contextCompressionPrompt,
  formatSituationDebateContext,
  documentClarificationPrompt,
  situationClarificationPrompt,
  entrySummarizationPrompt,
  missingArgumentsPrompt,
  taxonomyRefinementPrompt,
  midDebateGapPrompt,
  crossCuttingNodePrompt,
  reflectionPrompt,
  moderatorSelectionPrompt,
  moderatorInterventionPrompt,
  entailmentRepairPrompt,
  elementDecompositionPrompt,
  coverageCheckPrompt,
  classifyOffScopeDrift,
  offScopeRepairHint,
  topicScopeExtractionPrompt,
  improveDebateTopicPrompt,
  draftQualityCheckPrompt,
  situationTopicSynthesisPrompt,
} from './prompts.js';
import type { OpeningStagePromptInput, StagePromptInput, SituationDebateInput, SituationTopicSynthesisInput } from './prompts.js';
import { POVER_INFO } from './types.js';
import type { BdiInterpretation } from './taxonomyTypes.js';
import type { TopicScope } from './types.js';
import type { TopicStructure } from './topicStructure.js';

// ── Shared test fixtures ──────────────────────────────────────

const TOPIC = 'Should AI be regulated at the federal level?';
const TAXONOMY_CONTEXT = `## EMPIRICAL GROUNDING\n★ [acc-beliefs-001] Rapid Innovation\n## NORMATIVE COMMITMENTS\n[acc-desires-001] Open Development\n## REASONING APPROACH\n[acc-intentions-001] Market-Led Governance`;
const TRANSCRIPT = 'Prometheus: AI will drive growth.\nSentinel: Safety must come first.\nCassandra: Both sides oversimplify.';
const DEBATER = { label: 'Prometheus', pov: 'accelerationist', personality: 'Bold optimist' };
const ACTIVE_POVERS = ['Prometheus', 'Sentinel', 'Cassandra'];

function makeOpeningInput(overrides: Partial<OpeningStagePromptInput> = {}): OpeningStagePromptInput {
  return {
    label: DEBATER.label,
    pov: DEBATER.pov,
    soul: POVER_INFO['accelerationist'],
    personality: DEBATER.personality,
    topic: TOPIC,
    taxonomyContext: TAXONOMY_CONTEXT,
    priorStatements: '',
    isFirst: true,
    ...overrides,
  };
}

function makeStageInput(overrides: Partial<StagePromptInput> = {}): StagePromptInput {
  return {
    label: DEBATER.label,
    pov: DEBATER.pov,
    soul: POVER_INFO['accelerationist'],
    personality: DEBATER.personality,
    topic: TOPIC,
    taxonomyContext: TAXONOMY_CONTEXT,
    recentTranscript: TRANSCRIPT,
    focusPoint: 'Address the innovation vs. safety tradeoff.',
    addressing: 'Sentinel',
    ...overrides,
  };
}

function makeSituationInput(): SituationDebateInput {
  return {
    id: 'sit-201',
    label: 'AI Labor Displacement',
    description: 'AI systems replacing human jobs at scale.',
    interpretations: {
      accelerationist: 'Creative destruction drives new markets.',
      safetyist: 'Workers need protection during transition.',
      skeptic: 'Displacement estimates are overblown.',
    },
  };
}

const BDI_ACC: BdiInterpretation = {
  belief: 'AI displaces routine tasks, not overall employment.',
  desire: 'Accelerate productivity gains across all sectors.',
  intention: 'Resist retraining mandates that slow adoption.',
};
const BDI_SAF: BdiInterpretation = {
  belief: 'Structural unemployment risk is empirically underestimated.',
  desire: 'Guarantee income security during economic transitions.',
  intention: 'Enact federal retraining and safety-net programs.',
};
const BDI_SKP: BdiInterpretation = {
  belief: 'Historical automation panics overstate displacement rates.',
  desire: 'Preserve market flexibility without pre-emptive intervention.',
  intention: 'Await evidence before committing to expensive policy.',
};

function makeSynthesisInput(overrides: Partial<SituationTopicSynthesisInput> = {}): SituationTopicSynthesisInput {
  return {
    label: 'AI Labor Displacement',
    description: 'AI systems replacing human jobs at scale.',
    interpretations: { accelerationist: BDI_ACC, safetyist: BDI_SAF, skeptic: BDI_SKP },
    ...overrides,
  };
}

// ── Helper: structural assertions ─────────────────────────────

/** Assert result is a non-empty string */
function expectNonEmpty(result: string): void {
  expect(typeof result).toBe('string');
  expect(result.length).toBeGreaterThan(0);
}

/** Assert result contains ALL of the given substrings */
function expectContains(result: string, ...substrings: string[]): void {
  for (const sub of substrings) {
    expect(result).toContain(sub);
  }
}

// ═══════════════════════════════════════════════════════════════
// T9: prompts.ts tests
// ═══════════════════════════════════════════════════════════════

describe('clarificationPrompt', () => {
  it('returns a non-empty string', () => {
    expectNonEmpty(clarificationPrompt(TOPIC));
  });

  it('includes the topic', () => {
    expectContains(clarificationPrompt(TOPIC), TOPIC);
  });

  it('includes JSON schema hints', () => {
    expectContains(clarificationPrompt(TOPIC), '"questions"', '"question"', '"options"');
  });

  it('incorporates source content when provided', () => {
    const result = clarificationPrompt(TOPIC, 'The paper argues AI is safe.');
    expectContains(result, 'SOURCE DOCUMENT', 'The paper argues AI is safe.');
  });

  it('includes audience reading level when audience is provided', () => {
    const result = clarificationPrompt(TOPIC, undefined, 'general_public');
    expectContains(result, 'informed citizen');
  });

  it('handles empty topic gracefully', () => {
    const result = clarificationPrompt('');
    expectNonEmpty(result);
    expectContains(result, '""');
  });

  it('includes lineage context when provided', () => {
    const lineage = '  - Rawlsian Justice (45%)\n  - Chicago School Economics (30%)';
    const result = clarificationPrompt(TOPIC, undefined, undefined, lineage);
    expectContains(result, 'INTELLECTUAL TRADITIONS IN PLAY', 'Rawlsian Justice', 'Chicago School Economics');
  });

  it('omits lineage block when lineageContext is undefined', () => {
    const result = clarificationPrompt(TOPIC);
    expect(result).not.toContain('INTELLECTUAL TRADITIONS IN PLAY');
  });
});

describe('concludingPrompt', () => {
  it('returns a non-empty string containing topic and Q&A', () => {
    const result = concludingPrompt(TOPIC, 'Q: scope? A: federal only');
    expectNonEmpty(result);
    expectContains(result, TOPIC, 'Q: scope? A: federal only', '"refined_topic"');
  });

  it('handles empty Q&A pairs', () => {
    const result = concludingPrompt(TOPIC, '');
    expectNonEmpty(result);
  });

  it('includes lineage context when provided', () => {
    const lineage = '  - Utilitarian Ethics (55%)';
    const result = concludingPrompt(TOPIC, 'Q: x? A: y', undefined, undefined, lineage);
    expectContains(result, 'INTELLECTUAL TRADITIONS IN PLAY', 'Utilitarian Ethics');
  });

  it('includes naturalness constraint', () => {
    const result = concludingPrompt(TOPIC, 'Q: x? A: y');
    expect(result).toContain('conversational and direct');
    expect(result).toContain('not a committee-drafted scope statement');
  });
});

describe('userSeedClaimsPrompt', () => {
  it('returns a non-empty string with JSON schema', () => {
    const result = userSeedClaimsPrompt(TOPIC, 'Q: type? A: federal');
    expectNonEmpty(result);
    expectContains(result, '"claims"', '"claim"', '"bdi_category"');
  });

  it('includes all three BDI categories in the schema description', () => {
    const result = userSeedClaimsPrompt(TOPIC, '');
    expectContains(result, 'belief', 'desire', 'intention');
  });
});

describe('openingStatementPrompt', () => {
  it('returns a non-empty string with debater identity and structural markers', () => {
    const result = openingStatementPrompt(
      DEBATER.label, DEBATER.pov, DEBATER.personality,
      TOPIC, TAXONOMY_CONTEXT, '', true,
      undefined, undefined, undefined, undefined, undefined, undefined,
      POVER_INFO['accelerationist'],
    );
    expectNonEmpty(result);
    expectContains(result, DEBATER.label, DEBATER.pov, '"statement"', '"taxonomy_refs"', '"my_claims"');
  });

  it('includes document instructions when source content is provided', () => {
    const result = openingStatementPrompt(
      DEBATER.label, DEBATER.pov, DEBATER.personality,
      TOPIC, TAXONOMY_CONTEXT, '', true, 'A paper about AI risk.',
      undefined, undefined, undefined, undefined, undefined,
      POVER_INFO['accelerationist'],
    );
    expectContains(result, 'document');
  });

  it('includes user seed claims when provided', () => {
    const result = openingStatementPrompt(
      DEBATER.label, DEBATER.pov, DEBATER.personality,
      TOPIC, TAXONOMY_CONTEXT, '', true, undefined, undefined, undefined, undefined,
      [{ id: 'UC-1', text: 'AI will be beneficial' }],
      undefined,
      POVER_INFO['accelerationist'],
    );
    expectContains(result, 'USER-STATED POSITIONS', 'UC-1', 'AI will be beneficial');
  });

  it('adjusts for non-first speaker', () => {
    const result = openingStatementPrompt(
      DEBATER.label, DEBATER.pov, DEBATER.personality,
      TOPIC, TAXONOMY_CONTEXT, 'Sentinel spoke first', false,
      undefined, undefined, undefined, undefined, undefined, undefined,
      POVER_INFO['accelerationist'],
    );
    expectContains(result, 'prior opening statements');
  });

  it('includes recall section for starred nodes', () => {
    const result = openingStatementPrompt(
      DEBATER.label, DEBATER.pov, DEBATER.personality,
      TOPIC, TAXONOMY_CONTEXT, '', true,
      undefined, undefined, undefined, undefined, undefined, undefined,
      POVER_INFO['accelerationist'],
    );
    expectContains(result, 'RECALL', 'acc-beliefs-001');
  });

  it('includes audience-specific directives', () => {
    const result = openingStatementPrompt(
      DEBATER.label, DEBATER.pov, DEBATER.personality,
      TOPIC, TAXONOMY_CONTEXT, '', true, undefined, undefined, undefined, 'technical_researchers',
      undefined, undefined,
      POVER_INFO['accelerationist'],
    );
    expectContains(result, 'senior ML researcher');
  });
});

describe('debateResponsePrompt', () => {
  it('returns a non-empty string with core structural markers', () => {
    const result = debateResponsePrompt(
      DEBATER.label, DEBATER.pov, DEBATER.personality,
      TOPIC, TAXONOMY_CONTEXT, TRANSCRIPT, 'What about safety?', 'Sentinel',
      undefined, undefined, undefined, undefined, undefined,
      POVER_INFO['accelerationist'],
    );
    expectNonEmpty(result);
    expectContains(result, DEBATER.label, '"statement"', '"taxonomy_refs"', '"move_types"', '"my_claims"');
  });

  it('includes the question', () => {
    const result = debateResponsePrompt(
      DEBATER.label, DEBATER.pov, DEBATER.personality,
      TOPIC, TAXONOMY_CONTEXT, TRANSCRIPT, 'What about safety?', 'Sentinel',
      undefined, undefined, undefined, undefined, undefined,
      POVER_INFO['accelerationist'],
    );
    expectContains(result, 'What about safety?');
  });

  it('supports panel-wide addressing', () => {
    const result = debateResponsePrompt(
      DEBATER.label, DEBATER.pov, DEBATER.personality,
      TOPIC, TAXONOMY_CONTEXT, TRANSCRIPT, 'Q?', 'all',
      undefined, undefined, undefined, undefined, undefined,
      POVER_INFO['accelerationist'],
    );
    expectContains(result, 'QUESTION TO THE PANEL');
  });
});

describe('formatCriticalQuestions', () => {
  it('returns a non-empty string for known schemes', () => {
    const result = formatCriticalQuestions('ARGUMENT_FROM_EVIDENCE');
    expectNonEmpty(result);
    expectContains(result, 'Critical questions', 'ARGUMENT_FROM_EVIDENCE');
  });

  it('returns empty string for unknown scheme', () => {
    expect(formatCriticalQuestions('NONEXISTENT_SCHEME')).toBe('');
  });

  it('includes numbered critical questions', () => {
    const result = formatCriticalQuestions('ARGUMENT_FROM_ANALOGY');
    expectContains(result, '1.', '2.', '3.', '4.');
  });

  it('returns a non-empty string for each valid scheme', () => {
    const schemes = [
      'ARGUMENT_FROM_EVIDENCE', 'ARGUMENT_FROM_EXPERT_OPINION',
      'ARGUMENT_FROM_PRECEDENT', 'ARGUMENT_FROM_CONSEQUENCES',
      'ARGUMENT_FROM_ANALOGY', 'PRACTICAL_REASONING',
      'ARGUMENT_FROM_DEFINITION', 'ARGUMENT_FROM_VALUES',
      'ARGUMENT_FROM_FAIRNESS', 'ARGUMENT_FROM_IGNORANCE',
      'SLIPPERY_SLOPE', 'ARGUMENT_FROM_RISK', 'ARGUMENT_FROM_METAPHOR',
    ];
    for (const s of schemes) {
      expectNonEmpty(formatCriticalQuestions(s));
    }
  });
});

describe('selectReframingMetaphor', () => {
  it('returns a metaphor object when no sources are used', () => {
    const result = selectReframingMetaphor([], 0);
    expect(result).not.toBeNull();
    expect(result!.source).toBeTruthy();
    expect(result!.prompt).toBeTruthy();
    expect(result!.reveals).toBeTruthy();
    expect(result!.challenges).toBeTruthy();
  });

  it('avoids used metaphor sources', () => {
    const result = selectReframingMetaphor(['garden', 'immune system', 'language', 'commons', 'adolescence', 'infrastructure', 'translation'], 0);
    expect(result).not.toBeNull();
    // Should pick 'ecosystem invasion' (the only one left)
    expect(result!.source).toBe('ecosystem invasion');
  });

  it('returns null when all sources are used', () => {
    const allSources = ['garden', 'immune system', 'language', 'commons', 'adolescence', 'infrastructure', 'translation', 'ecosystem invasion'];
    expect(selectReframingMetaphor(allSources, 0)).toBeNull();
  });

  it('is deterministic based on round number', () => {
    const r1 = selectReframingMetaphor([], 5);
    const r2 = selectReframingMetaphor([], 5);
    expect(r1!.source).toBe(r2!.source);
  });

  it('handles case-insensitive source matching', () => {
    const result = selectReframingMetaphor(['GARDEN', 'Immune System'], 0);
    expect(result).not.toBeNull();
    expect(result!.source).not.toBe('garden');
    expect(result!.source).not.toBe('immune system');
  });
});

describe('crossRespondSelectionPrompt', () => {
  it('returns a non-empty string with core structural markers', () => {
    const result = crossRespondSelectionPrompt(TRANSCRIPT, ACTIVE_POVERS);
    expectNonEmpty(result);
    expectContains(result, '"responder"', '"addressing"', '"focus_point"', '"agreement_detected"');
  });

  it('includes edge context when provided', () => {
    const result = crossRespondSelectionPrompt(TRANSCRIPT, ACTIVE_POVERS, 'AN-1 attacks AN-2');
    expectContains(result, 'AN-1 attacks AN-2');
  });

  it('includes scheme section when scheme is provided', () => {
    const result = crossRespondSelectionPrompt(TRANSCRIPT, ACTIVE_POVERS, '', 'ARGUMENT_FROM_ANALOGY');
    expectContains(result, 'ARGUMENTATION SCHEME ANALYSIS', 'ARGUMENT_FROM_ANALOGY');
  });

  it('includes metaphor section when metaphor is provided', () => {
    const metaphor = { source: 'garden', prompt: 'What if AI is a garden?', reveals: 'ecology', challenges: 'race framing' };
    const result = crossRespondSelectionPrompt(TRANSCRIPT, ACTIVE_POVERS, '', undefined, metaphor);
    expectContains(result, 'METAPHOR REFRAMING', 'garden');
  });

  it('includes phase objectives for each phase', () => {
    for (const phase of ['confrontation', 'argumentation', 'concluding'] as const) {
      const result = crossRespondSelectionPrompt(TRANSCRIPT, ACTIVE_POVERS, '', undefined, null, phase);
      expectContains(result, 'PHASE');
    }
  });

  it('includes audience context when provided', () => {
    const result = crossRespondSelectionPrompt(TRANSCRIPT, ACTIVE_POVERS, '', undefined, null, undefined, 'industry_leaders');
    expectContains(result, 'AUDIENCE CONTEXT', 'industry leaders');
  });
});

describe('crossRespondPrompt', () => {
  it('returns a non-empty string with output schema', () => {
    const result = crossRespondPrompt(
      DEBATER.label, DEBATER.pov, DEBATER.personality,
      TOPIC, TAXONOMY_CONTEXT, TRANSCRIPT, 'Focus on evidence.', 'Sentinel',
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      POVER_INFO['accelerationist'],
    );
    expectNonEmpty(result);
    expectContains(result, '"statement"', '"taxonomy_refs"', '"move_types"', '"my_claims"');
  });

  it('includes move history when provided', () => {
    const result = crossRespondPrompt(
      DEBATER.label, DEBATER.pov, DEBATER.personality,
      TOPIC, TAXONOMY_CONTEXT, TRANSCRIPT, 'Focus.', 'Sentinel',
      undefined, undefined, undefined,
      ['DISTINGUISH', 'COUNTEREXAMPLE'],
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      POVER_INFO['accelerationist'],
    );
    expectContains(result, 'YOUR RECENT MOVES', 'DISTINGUISH', 'COUNTEREXAMPLE');
  });

  it('includes refs history and uncited nodes when provided', () => {
    const result = crossRespondPrompt(
      DEBATER.label, DEBATER.pov, DEBATER.personality,
      TOPIC, TAXONOMY_CONTEXT, TRANSCRIPT, 'Focus.', 'Sentinel',
      undefined, undefined, undefined, undefined, undefined,
      ['acc-beliefs-001', 'acc-desires-001'],
      ['acc-beliefs-002', 'acc-desires-003', 'acc-intentions-001'],
      undefined, undefined, undefined, undefined,
      POVER_INFO['accelerationist'],
    );
    expectContains(result, 'RECENT CITATIONS', 'acc-beliefs-001');
    expectContains(result, 'actually drew from');
  });

  it('includes phase instructions for concluding', () => {
    const result = crossRespondPrompt(
      DEBATER.label, DEBATER.pov, DEBATER.personality,
      TOPIC, TAXONOMY_CONTEXT, TRANSCRIPT, 'Focus.', 'Sentinel',
      undefined, undefined, undefined, undefined, 'concluding',
      undefined, undefined, undefined, undefined, undefined, undefined,
      POVER_INFO['accelerationist'],
    );
    expectContains(result, 'CONCLUDING', 'position_update', 'convergence');
  });

  it('includes constructive moves for argumentation/concluding phases', () => {
    for (const phase of ['argumentation', 'concluding'] as const) {
      const result = crossRespondPrompt(
        DEBATER.label, DEBATER.pov, DEBATER.personality,
        TOPIC, TAXONOMY_CONTEXT, TRANSCRIPT, 'Focus.', 'Sentinel',
        undefined, undefined, undefined, undefined, phase,
        undefined, undefined, undefined, undefined, undefined, undefined,
        POVER_INFO['accelerationist'],
      );
      expectContains(result, 'INTEGRATE', 'CONCEDE-AND-PIVOT');
    }
  });

  it('includes flagged hints when provided', () => {
    const result = crossRespondPrompt(
      DEBATER.label, DEBATER.pov, DEBATER.personality,
      TOPIC, TAXONOMY_CONTEXT, TRANSCRIPT, 'Focus.', 'Sentinel',
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      ['Weak steelman', 'Missing evidence'],
      undefined, undefined, undefined,
      POVER_INFO['accelerationist'],
    );
    expectContains(result, 'PRIOR TURN FEEDBACK', 'Weak steelman', 'Missing evidence');
  });
});

describe('4-stage opening pipeline', () => {
  const input = makeOpeningInput();

  describe('briefOpeningStagePrompt', () => {
    it('returns a non-empty string with JSON schema', () => {
      const result = briefOpeningStagePrompt(input);
      expectNonEmpty(result);
      expectContains(result, '"situation_assessment"', '"strongest_angles"', '"grounding"', '"key_tensions"');
    });

    it('includes prior positions schema for non-first speakers', () => {
      const result = briefOpeningStagePrompt(makeOpeningInput({ isFirst: false, priorStatements: 'Sentinel spoke.' }));
      expectContains(result, '"prior_positions_to_address"');
    });

    it('omits prior positions schema for first speakers', () => {
      const result = briefOpeningStagePrompt(input);
      expect(result).not.toContain('"prior_positions_to_address"');
    });

    it('asks the opening to answer the literal question when anchorQuestion is set (t/284 item 3)', () => {
      const inp = makeOpeningInput({ anchorQuestion: 'Does regulation slow AI progress?' });
      const result = draftOpeningStagePrompt(inp, '{}', '{}');
      expectContains(result, 'The user asked: "Does regulation slow AI progress?"');
      expectContains(result, 'The first sentence of your statement must state your answer to that question.');
    });

    it('omits the question instruction when anchorQuestion is not set (normal debates)', () => {
      const result = draftOpeningStagePrompt(makeOpeningInput(), '{}', '{}');
      expect(result).not.toContain('=== THE QUESTION ===');
    });

    it('includes transcript-grounding constraint for non-first speakers', () => {
      const result = briefOpeningStagePrompt(makeOpeningInput({ isFirst: false, priorStatements: 'Skeptic spoke.' }));
      expectContains(result, 'Only speakers listed in the prior statements have actually spoken');
      expectContains(result, 'must reference ONLY speakers from the prior opening statements');
    });

    it('omits transcript-grounding constraint for first speaker', () => {
      const result = briefOpeningStagePrompt(input);
      expect(result).not.toContain('Only speakers listed in the prior statements have actually spoken');
    });

    it('includes source-fidelity constraint for all speakers', () => {
      const firstResult = briefOpeningStagePrompt(input);
      expectContains(firstResult, 'SOURCE FIDELITY');
      expectContains(firstResult, 'do not introduce concepts, framings, or policy domains');

      const nonFirstResult = briefOpeningStagePrompt(makeOpeningInput({ isFirst: false, priorStatements: 'Skeptic spoke.' }));
      expectContains(nonFirstResult, 'SOURCE FIDELITY');
    });

    it('includes source_fidelity_check field in output schema', () => {
      const result = briefOpeningStagePrompt(input);
      expectContains(result, '"source_fidelity_check"');
      expectContains(result, '"concept_used"');
      expectContains(result, '"source_quote"');
    });

    it('includes BACKGROUND CONTEXT block when background is provided', () => {
      const result = briefOpeningStagePrompt(makeOpeningInput({ background: 'Recent EU AI Act developments' }));
      expectContains(result, 'BACKGROUND CONTEXT', 'Recent EU AI Act developments');
    });

    it('omits BACKGROUND CONTEXT block when background is absent', () => {
      const result = briefOpeningStagePrompt(makeOpeningInput());
      expect(result).not.toContain('BACKGROUND CONTEXT');
    });
  });

  describe('planOpeningStagePrompt', () => {
    it('returns a non-empty string with plan schema', () => {
      const result = planOpeningStagePrompt(input, '{"brief": "test"}');
      expectNonEmpty(result);
      expectContains(result, '"strategic_goal"', '"core_thesis"', '"argument_structure"');
    });
  });

  describe('draftOpeningStagePrompt', () => {
    it('returns a non-empty string with output schema', () => {
      const result = draftOpeningStagePrompt(input, '{"brief": "test"}', '{"plan": "test"}');
      expectNonEmpty(result);
      expectContains(result, '"statement"', '"claim_sketches"', '"turn_symbols"');
    });

    it('includes document instructions when document analysis is present', () => {
      const inp = makeOpeningInput({
        documentAnalysis: { claims_summary: 'test', i_nodes: [], tension_points: [] },
      });
      const result = draftOpeningStagePrompt(inp, '{}', '{}');
      expectContains(result, 'pre-analyzed document');
    });

    it('includes transcript-grounding constraint for non-first speakers', () => {
      const inp = makeOpeningInput({ isFirst: false, priorStatements: 'Safetyist spoke.' });
      const result = draftOpeningStagePrompt(inp, '{}', '{}');
      expectContains(result, 'You may only attribute named positions to speakers whose openings appear');
      expectContains(result, 'Do not attribute positions to speakers who have not yet delivered their opening');
    });

    it('omits transcript-grounding constraint for first speaker', () => {
      const result = draftOpeningStagePrompt(input, '{}', '{}');
      expect(result).not.toContain('You may only attribute named positions');
    });
  });

  describe('citeOpeningStagePrompt', () => {
    it('returns a non-empty string with grounding schema', () => {
      const result = citeOpeningStagePrompt(input, '{}', '{}', 'draft text');
      expectNonEmpty(result);
      expectContains(result, '"taxonomy_refs"', '"policy_refs"', '"grounding_confidence"');
    });
  });
});

describe('4-stage turn pipeline', () => {
  const input = makeStageInput();

  describe('briefStagePrompt', () => {
    it('returns a non-empty string with situation brief schema', () => {
      const result = briefStagePrompt(input);
      expectNonEmpty(result);
      expectContains(result, '"situation_assessment"', '"key_claims_to_address"', '"grounding"');
    });

    it('includes phase instructions when phase is set', () => {
      const result = briefStagePrompt(makeStageInput({ phase: 'argumentation' }));
      expectContains(result, 'EXPLORATION');
    });

    it('injects currentCruxContext into brief when provided', () => {
      const result = briefStagePrompt(makeStageInput({
        currentCruxContext: 'ACTIVE CRUXES (still contested):\n- "Is regulation feasible?" (crux-1) — engaged, polarity 0.30',
      }));
      expectContains(result, 'IDENTIFIED CRUXES (THIS DEBATE)', 'Is regulation feasible?');
    });

    it('omits crux section when currentCruxContext is absent', () => {
      const result = briefStagePrompt(makeStageInput());
      expect(result).not.toContain('IDENTIFIED CRUXES (THIS DEBATE)');
    });

    it('includes BACKGROUND CONTEXT block when background is provided', () => {
      const result = briefStagePrompt(makeStageInput({ background: 'NIST AI RMF framework details' }));
      expectContains(result, 'BACKGROUND CONTEXT', 'NIST AI RMF framework details');
    });

    it('omits BACKGROUND CONTEXT block when background is absent', () => {
      const result = briefStagePrompt(makeStageInput());
      expect(result).not.toContain('BACKGROUND CONTEXT');
    });

    it('formats structured topic with premises and scope constraints', () => {
      const ts: TopicStructure = {
        core_proposition: 'Whether AI hiring tools should require bias audits',
        structural_premises: ['Audits must be annual', 'Results published publicly'],
        scope_constraints: ['Exemption for companies under 50 employees'],
      };
      const result = briefStagePrompt(makeStageInput({ topicStructure: ts }));
      expectContains(result, 'Whether AI hiring tools should require bias audits');
      expectContains(result, 'TOPIC PREMISES');
      expectContains(result, '- Audits must be annual');
      expectContains(result, '- Results published publicly');
      expectContains(result, 'TOPIC SCOPE CONSTRAINTS');
      expectContains(result, '- Exemption for companies under 50 employees');
    });

    it('uses dynamic TOPIC PREMISE FIDELITY when structure has premises', () => {
      const ts: TopicStructure = {
        core_proposition: 'Test',
        structural_premises: ['A premise'],
        scope_constraints: [],
      };
      const result = briefStagePrompt(makeStageInput({ topicStructure: ts }));
      expectContains(result, 'TOPIC PREMISES listed above are given conditions');
    });

    it('uses generic TOPIC PREMISE FIDELITY when no topicStructure', () => {
      const result = briefStagePrompt(makeStageInput());
      expectContains(result, 'TOPIC PREMISE FIDELITY');
      expectContains(result, 'structural feature of the proposal');
    });

    it('falls back to plain topic block when topicStructure matches topic', () => {
      const ts: TopicStructure = {
        core_proposition: TOPIC,
        structural_premises: [],
        scope_constraints: [],
      };
      const result = briefStagePrompt(makeStageInput({ topicStructure: ts }));
      expectContains(result, `=== DEBATE TOPIC ===\n"${TOPIC}"`);
      expect(result).not.toContain('TOPIC PREMISES');
    });
  });

  describe('briefStagePromptV2', () => {
    it('returns a non-empty string with the same JSON schema as V1', () => {
      const result = briefStagePromptV2(makeStageInput());
      expectNonEmpty(result);
      expectContains(result, '"situation_assessment"', '"key_claims_to_address"', '"grounding"');
    });

    it('places YOUR TASK section before REFERENCE MATERIAL and CURRENT STATE', () => {
      const result = briefStagePromptV2(makeStageInput());
      const taskIdx = result.indexOf('## YOUR TASK');
      const refIdx = result.indexOf('## REFERENCE MATERIAL');
      const stateIdx = result.indexOf('## CURRENT STATE');
      expect(taskIdx).toBeGreaterThanOrEqual(0);
      expect(refIdx).toBeGreaterThan(taskIdx);
      expect(stateIdx).toBeGreaterThan(refIdx);
    });

    it('places taxonomy context in REFERENCE MATERIAL, not YOUR TASK', () => {
      const result = briefStagePromptV2(makeStageInput());
      const refIdx = result.indexOf('## REFERENCE MATERIAL');
      const stateIdx = result.indexOf('## CURRENT STATE');
      const taxIdx = result.indexOf(TAXONOMY_CONTEXT);
      expect(taxIdx).toBeGreaterThan(refIdx);
      expect(taxIdx).toBeLessThan(stateIdx);
    });

    it('places transcript in CURRENT STATE section', () => {
      const result = briefStagePromptV2(makeStageInput());
      const stateIdx = result.indexOf('## CURRENT STATE');
      const transcriptIdx = result.indexOf(TRANSCRIPT);
      expect(transcriptIdx).toBeGreaterThan(stateIdx);
    });

    it('places role definition in YOUR TASK section', () => {
      const result = briefStagePromptV2(makeStageInput());
      const taskIdx = result.indexOf('## YOUR TASK');
      const refIdx = result.indexOf('## REFERENCE MATERIAL');
      const roleIdx = result.indexOf('situation brief');
      expect(roleIdx).toBeGreaterThan(taskIdx);
      expect(roleIdx).toBeLessThan(refIdx);
    });

    it('includes phase instructions in YOUR TASK when phase is set', () => {
      const result = briefStagePromptV2(makeStageInput({ phase: 'argumentation' }));
      const taskIdx = result.indexOf('## YOUR TASK');
      const refIdx = result.indexOf('## REFERENCE MATERIAL');
      const phaseIdx = result.indexOf('EXPLORATION');
      expect(phaseIdx).toBeGreaterThan(taskIdx);
      expect(phaseIdx).toBeLessThan(refIdx);
    });

    it('includes crux context in REFERENCE MATERIAL when provided', () => {
      const result = briefStagePromptV2(makeStageInput({
        currentCruxContext: 'ACTIVE CRUXES:\n- "Is regulation feasible?" (crux-1)',
      }));
      const refIdx = result.indexOf('## REFERENCE MATERIAL');
      const stateIdx = result.indexOf('## CURRENT STATE');
      const cruxIdx = result.indexOf('Is regulation feasible?');
      expect(cruxIdx).toBeGreaterThan(refIdx);
      expect(cruxIdx).toBeLessThan(stateIdx);
    });

    it('includes BACKGROUND CONTEXT in REFERENCE MATERIAL when provided', () => {
      const result = briefStagePromptV2(makeStageInput({ background: 'NIST AI RMF framework' }));
      const refIdx = result.indexOf('## REFERENCE MATERIAL');
      const stateIdx = result.indexOf('## CURRENT STATE');
      const bgIdx = result.indexOf('NIST AI RMF framework');
      expect(bgIdx).toBeGreaterThan(refIdx);
      expect(bgIdx).toBeLessThan(stateIdx);
    });

    it('contains same content elements as V1', () => {
      const v1 = briefStagePrompt(makeStageInput({ background: 'test-bg', currentCruxContext: 'crux-ctx' }));
      const v2 = briefStagePromptV2(makeStageInput({ background: 'test-bg', currentCruxContext: 'crux-ctx' }));
      const requiredElements = [
        '"situation_assessment"',
        '"key_claims_to_address"',
        '"relevant_commitments"',
        '"edge_tensions"',
        '"phase_considerations"',
        'ATTRIBUTION FIDELITY',
        'GROUNDING DEPTH',
        'NODE-ID ACCURACY',
        TAXONOMY_CONTEXT,
        TRANSCRIPT,
        'test-bg',
        'crux-ctx',
      ];
      for (const el of requiredElements) {
        expect(v1).toContain(el);
        expect(v2).toContain(el);
      }
    });

    it('includes exploration priming in REFERENCE MATERIAL when provided', () => {
      const result = briefStagePromptV2(makeStageInput({
        explorationPriming: '=== PRIOR ANALYSIS ===\nKey findings from exploration run',
      }));
      const refIdx = result.indexOf('## REFERENCE MATERIAL');
      const stateIdx = result.indexOf('## CURRENT STATE');
      const primIdx = result.indexOf('PRIOR ANALYSIS');
      expect(primIdx).toBeGreaterThan(refIdx);
      expect(primIdx).toBeLessThan(stateIdx);
    });

    it('includes topic in CURRENT STATE section', () => {
      const result = briefStagePromptV2(makeStageInput());
      const stateIdx = result.indexOf('## CURRENT STATE');
      const topicIdx = result.indexOf(TOPIC);
      expect(topicIdx).toBeGreaterThan(stateIdx);
    });

    it('includes edge context in REFERENCE MATERIAL when provided', () => {
      const result = briefStagePromptV2(makeStageInput({
        edgeContext: 'acc-beliefs-001 attacks saf-desires-002',
      }));
      const refIdx = result.indexOf('## REFERENCE MATERIAL');
      const stateIdx = result.indexOf('## CURRENT STATE');
      const edgeIdx = result.indexOf('CROSS-POV TENSIONS');
      expect(edgeIdx).toBeGreaterThan(refIdx);
      expect(edgeIdx).toBeLessThan(stateIdx);
    });

    it('formats structured topic in CURRENT STATE with premises', () => {
      const ts: TopicStructure = {
        core_proposition: 'Whether AI hiring tools should require bias audits',
        structural_premises: ['Audits must be annual', 'Results published publicly'],
        scope_constraints: ['Exemption for companies under 50 employees'],
      };
      const result = briefStagePromptV2(makeStageInput({ topicStructure: ts }));
      const stateIdx = result.indexOf('## CURRENT STATE');
      const premiseIdx = result.indexOf('=== TOPIC PREMISES (given');
      expect(premiseIdx).toBeGreaterThan(stateIdx);
      expectContains(result, '- Audits must be annual');
      expectContains(result, 'TOPIC SCOPE CONSTRAINTS');
    });

    it('uses dynamic TOPIC PREMISE FIDELITY in YOUR TASK when structure has premises', () => {
      const ts: TopicStructure = {
        core_proposition: 'Test',
        structural_premises: ['A premise'],
        scope_constraints: [],
      };
      const result = briefStagePromptV2(makeStageInput({ topicStructure: ts }));
      const taskIdx = result.indexOf('## YOUR TASK');
      const refIdx = result.indexOf('## REFERENCE MATERIAL');
      const fidelityIdx = result.indexOf('TOPIC PREMISES listed above are given conditions');
      expect(fidelityIdx).toBeGreaterThan(taskIdx);
      expect(fidelityIdx).toBeLessThan(refIdx);
    });
  });

  describe('planStagePrompt', () => {
    it('returns a non-empty string with plan schema', () => {
      const result = planStagePrompt(input, '{}');
      expectNonEmpty(result);
      expectContains(result, '"strategic_goal"', '"planned_moves"', '"argument_sketch"');
    });

    it('includes move history when provided', () => {
      const result = planStagePrompt(makeStageInput({ priorMoves: ['DISTINGUISH', 'EXTEND'] }), '{}');
      expectContains(result, 'YOUR RECENT MOVES', 'DISTINGUISH');
    });

    it('includes phase context when provided', () => {
      const result = planStagePrompt(
        makeStageInput({ phaseContext: { rationale: 'Moving to concluding', phase_progress: 0.8, approaching_transition: true } }),
        '{}',
      );
      expectContains(result, 'PHASE STATUS', '80%', 'Approaching phase transition');
    });
  });

  describe('draftStagePrompt', () => {
    it('returns a non-empty string with output schema', () => {
      const result = draftStagePrompt(input, '{}', '{}');
      expectNonEmpty(result);
      expectContains(result, '"statement"', '"claim_sketches"', '"turn_symbols"');
    });

    it('includes position_update for concluding phase', () => {
      const result = draftStagePrompt(makeStageInput({ phase: 'concluding' }), '{}', '{}');
      expectContains(result, '"position_update"');
    });

    it('omits position_update for non-concluding phases', () => {
      const result = draftStagePrompt(makeStageInput({ phase: 'argumentation' }), '{}', '{}');
      expect(result).not.toContain('"position_update"');
    });

    it('includes intervention block when targeted intervention is pending', () => {
      const result = draftStagePrompt(
        makeStageInput({
          pendingIntervention: {
            move: 'PIN',
            family: 'Elicitation',
            targetDebater: 'Prometheus',
            directResponsePattern: 'Do you agree with X?',
            isTargeted: true,
          },
        }),
        '{}',
        '{}',
      );
      expectContains(result, 'MODERATOR DIRECTIVE', 'YOU MUST RESPOND DIRECTLY', 'Do you agree with X?');
    });

    it('includes recency field reminder when targeted intervention has responseField', () => {
      const result = draftStagePrompt(
        makeStageInput({
          pendingIntervention: {
            move: 'COMMIT',
            family: 'Accountability',
            targetDebater: 'Prometheus',
            responseField: 'commitment',
            directResponsePattern: 'Commit to your position.',
            isTargeted: true,
          },
        }),
        '{}',
        '{}',
      );
      expectContains(result, 'ACTIVE INTERVENTION', '"commitment"', 'trigger a retry');
    });

    it('omits recency field reminder when not targeted', () => {
      const result = draftStagePrompt(
        makeStageInput({
          pendingIntervention: {
            move: 'PIN',
            family: 'Elicitation',
            targetDebater: 'Sentinel',
            responseField: 'pin_response',
            isTargeted: false,
          },
        }),
        '{}',
        '{}',
      );
      expect(result).not.toContain('ACTIVE INTERVENTION');
    });

    it('includes non-targeted intervention block when intervention targets another debater', () => {
      const result = draftStagePrompt(
        makeStageInput({
          pendingIntervention: {
            move: 'REDIRECT',
            family: 'Procedural',
            targetDebater: 'Sentinel',
            isTargeted: false,
          },
        }),
        '{}',
        '{}',
      );
      expectContains(result, 'DIRECTED AT SENTINEL');
    });
  });

  describe('citeStagePrompt', () => {
    it('returns a non-empty string with annotation schema', () => {
      const result = citeStagePrompt(input, '{}', 'draft');
      expectNonEmpty(result);
      expectContains(result, '"taxonomy_refs"', '"grounding_confidence"');
    });

    it('includes refs history block when priorRefs are provided', () => {
      const result = citeStagePrompt(
        makeStageInput({ priorRefs: ['acc-beliefs-001'], availablePovNodeIds: ['acc-beliefs-002', 'acc-desires-001'] }),
        '{}',
        'draft',
      );
      expectContains(result, 'RECENT CITATIONS', 'acc-beliefs-001', 'actually drew from');
    });
  });
});

describe('synthesis prompts', () => {
  describe('synthExtractPrompt', () => {
    it('returns a non-empty string with extraction schema', () => {
      const result = synthExtractPrompt(TOPIC, TRANSCRIPT);
      expectNonEmpty(result);
      expectContains(result, '"areas_of_agreement"', '"areas_of_disagreement"', '"cruxes"', '"unresolved_questions"');
    });

    it('includes crux resolution context when provided', () => {
      const result = synthExtractPrompt(TOPIC, TRANSCRIPT, undefined, 'Crux 1 is resolved.');
      expectContains(result, 'CRUX RESOLUTION STATUS', 'Crux 1 is resolved');
    });
  });

  describe('synthMapPrompt', () => {
    it('returns a non-empty string with argument map schema', () => {
      const result = synthMapPrompt(TOPIC, TRANSCRIPT, '[]');
      expectNonEmpty(result);
      expectContains(result, '"argument_map"', '"taxonomy_proposals"', '"taxonomy_modifications"');
    });

    it('includes document claims schema when hasSourceDocument is true', () => {
      const result = synthMapPrompt(TOPIC, TRANSCRIPT, '[]', true);
      expectContains(result, '"document_claims"');
    });

    it('omits document claims schema when hasSourceDocument is false', () => {
      const result = synthMapPrompt(TOPIC, TRANSCRIPT, '[]', false);
      expect(result).not.toContain('"document_claims"');
    });
  });

  describe('synthEvaluatePrompt', () => {
    it('returns a non-empty string with evaluation schema', () => {
      const result = synthEvaluatePrompt(TOPIC, '[]', '[]');
      expectNonEmpty(result);
      expectContains(result, '"preferences"', '"policy_implications"', '"topic_resolution"');
    });

    it('includes topic resolution instruction referencing the topic', () => {
      const result = synthEvaluatePrompt('Should AI be regulated?', '[]', '[]');
      expectContains(result, 'TOPIC RESOLUTION', 'restated_question', 'where_it_landed', 'what_would_resolve_it');
      expect(result).toContain('Should AI be regulated?');
    });
  });

  describe('debateSynthesisPrompt (deprecated)', () => {
    it('returns a non-empty string with comprehensive schema', () => {
      const result = debateSynthesisPrompt(TOPIC, TRANSCRIPT);
      expectNonEmpty(result);
      expectContains(
        result,
        '"areas_of_agreement"', '"areas_of_disagreement"',
        '"cruxes"', '"argument_map"', '"preferences"', '"policy_implications"',
      );
    });
  });
});

describe('probingQuestionsPrompt', () => {
  it('returns a non-empty string with questions schema', () => {
    const result = probingQuestionsPrompt(TOPIC, TRANSCRIPT, []);
    expectNonEmpty(result);
    expectContains(result, '"questions"', '"text"', '"targets"', '"threatens"');
  });

  it('includes unreferenced nodes when provided', () => {
    const result = probingQuestionsPrompt(TOPIC, TRANSCRIPT, ['[acc-beliefs-005] AI Capability Growth']);
    expectContains(result, 'TAXONOMY NODES NOT YET REFERENCED', 'acc-beliefs-005');
  });

  it('includes uncovered document claims when provided', () => {
    const result = probingQuestionsPrompt(TOPIC, TRANSCRIPT, [], true, ['D-1: AI needs oversight']);
    expectContains(result, 'UNCOVERED DOCUMENT CLAIMS', 'D-1: AI needs oversight');
  });

  it('handles empty unreferenced nodes and no uncovered claims', () => {
    const result = probingQuestionsPrompt(TOPIC, TRANSCRIPT, []);
    expect(result).not.toContain('TAXONOMY NODES NOT YET REFERENCED');
  });
});

describe('factCheckPrompt', () => {
  it('returns a non-empty string with verdict schema', () => {
    const result = factCheckPrompt('AI is safe', 'full statement', 'taxonomy nodes', '');
    expectNonEmpty(result);
    expectContains(result, '"verdict"', '"explanation"', '"points"', 'supported', 'disputed', 'false');
  });

  it('includes conflict data when provided', () => {
    const result = factCheckPrompt('claim', 'context', 'nodes', 'Conflict: study shows otherwise');
    expectContains(result, 'Conflict: study shows otherwise');
  });

  it('handles empty conflict data gracefully', () => {
    const result = factCheckPrompt('claim', 'context', 'nodes', '');
    expectContains(result, 'No relevant conflicts');
  });
});

describe('contextCompressionPrompt', () => {
  it('returns a non-empty string with summary schema', () => {
    const result = contextCompressionPrompt('Some debate entries.');
    expectNonEmpty(result);
    expectContains(result, '"summary"', 'Preserve');
  });
});

describe('formatSituationDebateContext', () => {
  it('returns a non-empty string with situation structure', () => {
    const result = formatSituationDebateContext(makeSituationInput());
    expectNonEmpty(result);
    expectContains(result, 'sit-201', 'AI Labor Displacement', 'SITUATION', 'POV INTERPRETATIONS');
  });

  it('includes optional sections when provided', () => {
    const cc = makeSituationInput();
    cc.assumes = ['Technology is neutral'];
    cc.steelmanVulnerability = 'Ignores structural power';
    cc.possibleFallacies = [{ fallacy: 'false_dilemma', confidence: 'high', explanation: 'Binary framing' }];
    cc.linkedNodeDescriptions = ['acc-beliefs-001: Innovation drives growth'];
    cc.conflictSummaries = ['Study A vs Study B on displacement'];

    const result = formatSituationDebateContext(cc);
    expectContains(
      result,
      'UNDERLYING ASSUMPTIONS', 'Technology is neutral',
      'STEELMAN VULNERABILITY', 'Ignores structural power',
      'IDENTIFIED FALLACIES', 'false dilemma',
      'LINKED TAXONOMY NODES',
      'DOCUMENTED CONFLICTS',
    );
  });

  it('omits optional sections when not provided', () => {
    const result = formatSituationDebateContext(makeSituationInput());
    expect(result).not.toContain('UNDERLYING ASSUMPTIONS');
    expect(result).not.toContain('STEELMAN VULNERABILITY');
    expect(result).not.toContain('IDENTIFIED FALLACIES');
  });
});

describe('documentClarificationPrompt', () => {
  it('returns a non-empty string with topic and source doc', () => {
    const result = documentClarificationPrompt(TOPIC, 'The paper says...');
    expectNonEmpty(result);
    expectContains(result, TOPIC, 'SOURCE DOCUMENT', '"questions"');
  });

  it('truncates very long source content', () => {
    const longContent = 'x'.repeat(60000);
    const result = documentClarificationPrompt(TOPIC, longContent);
    expectContains(result, 'truncated');
  });
});

describe('situationClarificationPrompt', () => {
  it('returns a non-empty string with topic and context', () => {
    const result = situationClarificationPrompt(TOPIC, 'cc context here');
    expectNonEmpty(result);
    expectContains(result, TOPIC, 'cc context here', '"questions"');
  });
});

describe('entrySummarizationPrompt', () => {
  it('returns a non-empty string with compression levels', () => {
    const result = entrySummarizationPrompt('AI will transform everything.', 'Prometheus');
    expectNonEmpty(result);
    expectContains(result, '"brief"', '"medium"', 'Prometheus', 'BRIEF', 'MEDIUM');
  });

  it('includes the statement text', () => {
    const result = entrySummarizationPrompt('Regulation stifles innovation.', 'Prometheus');
    expectContains(result, 'Regulation stifles innovation.');
  });
});

describe('missingArgumentsPrompt', () => {
  it('returns a non-empty string with missing arguments schema', () => {
    const result = missingArgumentsPrompt(TOPIC, 'taxonomy summary', 'synthesis text');
    expectNonEmpty(result);
    expectContains(result, '"missing_arguments"', '"argument"', '"side"', '"why_strong"', '"bdi_layer"');
  });
});

describe('taxonomyRefinementPrompt', () => {
  it('returns a non-empty string with taxonomy suggestions schema', () => {
    const result = taxonomyRefinementPrompt(TOPIC, 'concluding', [
      { id: 'acc-beliefs-001', label: 'Innovation', pov: 'accelerationist', category: 'Beliefs', description: 'desc' },
    ], 'arg map summary');
    expectNonEmpty(result);
    expectContains(result, '"taxonomy_suggestions"', '"suggestion_type"', '"proposed_description"');
  });

  it('includes all referenced nodes in the prompt', () => {
    const nodes = [
      { id: 'acc-beliefs-001', label: 'Innovation', pov: 'accelerationist', category: 'Beliefs', description: 'innovation desc' },
      { id: 'saf-desires-001', label: 'Safety', pov: 'safetyist', category: 'Desires', description: 'safety desc' },
    ];
    const result = taxonomyRefinementPrompt(TOPIC, 'synth', nodes, 'map');
    expectContains(result, 'acc-beliefs-001', 'saf-desires-001', 'innovation desc', 'safety desc');
  });
});

describe('midDebateGapPrompt', () => {
  it('returns a non-empty string with gap arguments schema', () => {
    const result = midDebateGapPrompt(TOPIC, TRANSCRIPT, 'taxonomy summary', ['arg1', 'arg2']);
    expectNonEmpty(result);
    expectContains(result, '"gap_arguments"', '"argument"', '"why_missing"', '"gap_type"');
  });

  it('includes focus nodes when provided', () => {
    const result = midDebateGapPrompt(TOPIC, TRANSCRIPT, 'taxonomy', [], [
      { id: 'acc-beliefs-005', label: 'Test Node', description: 'Test description for the node' },
    ]);
    expectContains(result, 'UNENGAGED HIGH-RELEVANCE NODES', 'acc-beliefs-005', 'Test Node');
  });

  it('handles empty arguments list', () => {
    const result = midDebateGapPrompt(TOPIC, TRANSCRIPT, 'taxonomy', []);
    expectContains(result, 'none extracted yet');
  });
});

describe('crossCuttingNodePrompt', () => {
  it('returns a non-empty string with proposals schema', () => {
    const result = crossCuttingNodePrompt(
      [{ point: 'AI needs oversight', povers: ['accelerationist', 'safetyist', 'skeptic'] }],
      ['Existing Situation'],
      TOPIC,
    );
    expectNonEmpty(result);
    expectContains(result, '"proposals"', '"proposed_label"', '"interpretations"');
  });

  it('includes existing situation labels', () => {
    const result = crossCuttingNodePrompt(
      [{ point: 'AI needs oversight', povers: ['accelerationist', 'safetyist'] }],
      ['AI Labor Displacement', 'Algorithmic Bias'],
      TOPIC,
    );
    expectContains(result, 'AI Labor Displacement', 'Algorithmic Bias');
  });

  it('handles empty existing labels', () => {
    const result = crossCuttingNodePrompt(
      [{ point: 'AI needs oversight', povers: ['accelerationist'] }],
      [],
      TOPIC,
    );
    expectContains(result, '(none)');
  });
});

describe('reflectionPrompt', () => {
  it('returns a non-empty string with reflection schema', () => {
    const result = reflectionPrompt(
      DEBATER.label, DEBATER.pov, DEBATER.personality,
      TOPIC,
      [{ id: 'acc-beliefs-001', category: 'Beliefs', label: 'Innovation', description: 'desc' }],
      TRANSCRIPT,
      undefined, undefined, undefined, undefined, undefined, undefined,
      POVER_INFO['accelerationist'],
    );
    expectNonEmpty(result);
    expectContains(result, '"reflection_summary"', '"edits"', '"edit_type"', '"proposed_description"');
  });

  it('includes optional argument network context', () => {
    const result = reflectionPrompt(
      DEBATER.label, DEBATER.pov, DEBATER.personality,
      TOPIC, [], TRANSCRIPT, 'AN-1 attacks AN-2',
      undefined, undefined, undefined, undefined, undefined,
      POVER_INFO['accelerationist'],
    );
    expectContains(result, 'ARGUMENT NETWORK', 'AN-1 attacks AN-2');
  });

  it('includes optional commitment store context', () => {
    const result = reflectionPrompt(
      DEBATER.label, DEBATER.pov, DEBATER.personality,
      TOPIC, [], TRANSCRIPT, undefined, 'Asserted: X, Conceded: Y',
      undefined, undefined, undefined, undefined,
      POVER_INFO['accelerationist'],
    );
    expectContains(result, 'COMMITMENT STORE', 'Asserted: X, Conceded: Y');
  });

  it('includes optional convergence signals context', () => {
    const result = reflectionPrompt(
      DEBATER.label, DEBATER.pov, DEBATER.personality,
      TOPIC, [], TRANSCRIPT, undefined, undefined, 'High convergence at 0.85',
      undefined, undefined, undefined,
      POVER_INFO['accelerationist'],
    );
    expectContains(result, 'CONVERGENCE SIGNALS', 'High convergence at 0.85');
  });

  it('does NOT offer edit_type "add" — new nodes go only through propose_new (t/1820, retires t/1564 ADD)', () => {
    // ADD was an edgeless new-node CREATE mis-homed under edit_existing; it reproduced the
    // t/1725 orphan bug. t/1820 RETIRED it (TL ruling t/1773#9): new-node creation is now
    // exclusively `disposition: "propose_new"` (always edged). edit_existing = revise/qualify/
    // deprecate only. Do NOT "restore" an ADD edit_type here — that reopens the orphan class
    // (this test exists precisely so such a restore reads as a deliberate regression, not a fix).
    const result = reflectionPrompt(
      DEBATER.label, DEBATER.pov, DEBATER.personality,
      TOPIC,
      [{ id: 'acc-beliefs-001', category: 'Beliefs', label: 'Innovation', description: 'desc' }],
      TRANSCRIPT,
      undefined, undefined, undefined, undefined, undefined, undefined,
      POVER_INFO['accelerationist'],
    );
    expect(result).not.toContain('For ADD, node_id MUST be null'); // old t/1564 rule retired
    expect(result).not.toContain('ADD: create a new node');        // old edit-type line retired
    expect(result).not.toContain('"edit_type": "add"');            // no add example in the schema
    expectContains(result, 'REVISE', 'QUALIFY', 'DEPRECATE', 'propose_new'); // the surviving paths
  });
});

describe('moderatorSelectionPrompt', () => {
  it('returns a non-empty string with selection schema', () => {
    const result = moderatorSelectionPrompt(TRANSCRIPT, ACTIVE_POVERS, '', 'trigger context');
    expectNonEmpty(result);
    expectContains(result, '"responder"', '"intervene"', '"suggested_move"', '"drift_detected"');
  });

  it('includes semantic drift detection section', () => {
    const result = moderatorSelectionPrompt(TRANSCRIPT, ACTIVE_POVERS, '', '');
    expectContains(result, 'SEMANTIC DRIFT DETECTION', 'METAPHOR LITERALIZATION', 'IMPLEMENTATION SPIRAL', 'SCOPE CREEP');
  });

  it('includes source document anchor when provided', () => {
    const result = moderatorSelectionPrompt(TRANSCRIPT, ACTIVE_POVERS, '', '', undefined, undefined, undefined, undefined, 'Paper summary');
    expectContains(result, 'SOURCE DOCUMENT ANCHOR', 'Paper summary');
  });

  it('keeps standard mode free of Talmudic instructions by default', () => {
    const result = moderatorSelectionPrompt(TRANSCRIPT, ACTIVE_POVERS, '', '');
    expect(result).not.toContain('TALMUDIC MODERATION MODE');
    expect(result).not.toContain('"dialectical_diagnostic"');
  });

  it('adds dialectical guidance without creating a Talmudic debater', () => {
    const result = moderatorSelectionPrompt(
      TRANSCRIPT,
      ACTIVE_POVERS,
      '',
      '',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'talmudic',
    );
    expectContains(
      result,
      'TALMUDIC MODERATION MODE',
      'not as a fourth debater',
      'Identify the exact crux',
      'preserving legitimate plurality',
      'Do not invent quotations',
      '"dialectical_diagnostic"',
      '"premise_under_examination"',
      '"distinction_or_analogy_tested"',
      '"unresolved_outcome"',
    );
  });

  it('socratic mode: shows INTERLOCUTOR section not ACTIVE DEBATERS', () => {
    const result = moderatorSelectionPrompt(TRANSCRIPT, ['Sentinel'], '', '', undefined, undefined, undefined, undefined, undefined, undefined, 'socratic');
    expect(result).toContain('=== INTERLOCUTOR ===');
    expect(result).toContain('Sentinel (sole interlocutor under examination; you are the questioner)');
    expect(result).not.toContain('=== ACTIVE DEBATERS ===');
  });

  it('socratic mode: SELECTION is deterministic naming the sole interlocutor', () => {
    const result = moderatorSelectionPrompt(TRANSCRIPT, ['Sentinel'], '', '', undefined, undefined, undefined, undefined, undefined, undefined, 'socratic');
    expect(result).toContain('Your SELECTION must name Sentinel as the responder every round');
    expect(result).not.toContain('Identify which debater should respond next');
  });

  it('non-socratic mode: ACTIVE DEBATERS section and generic SELECTION are unchanged', () => {
    const result = moderatorSelectionPrompt(TRANSCRIPT, ACTIVE_POVERS, '', '');
    expect(result).toContain('=== ACTIVE DEBATERS ===');
    expect(result).not.toContain('=== INTERLOCUTOR ===');
    expect(result).toContain('Identify which debater should respond next');
  });
});

describe('moderatorInterventionPrompt', () => {
  it('returns a non-empty string with text schema', () => {
    const result = moderatorInterventionPrompt(
      'PIN', 'Elicitation', 'Prometheus', 'Evasion detected', 'Claim X', TRANSCRIPT,
    );
    expectNonEmpty(result);
    expectContains(result, '"text"', 'PIN', 'Elicitation', 'Prometheus');
  });

  it('includes REVOICE-specific schema when move is REVOICE', () => {
    const result = moderatorInterventionPrompt(
      'REVOICE', 'Reconciliation', 'Sentinel', 'Jargon', undefined, TRANSCRIPT,
    );
    expectContains(result, '"original_claim_text"');
  });

  it('includes move-specific instructions for each move type', () => {
    const moves = ['REDIRECT', 'BALANCE', 'SEQUENCE', 'PIN', 'PROBE', 'CHALLENGE', 'CLARIFY', 'CHECK', 'SUMMARIZE', 'ACKNOWLEDGE', 'REVOICE', 'META-REFLECT', 'COMPRESS', 'COMMIT'] as const;
    for (const move of moves) {
      const result = moderatorInterventionPrompt(move, 'Procedural', 'Prometheus', 'reason', undefined, TRANSCRIPT);
      expectNonEmpty(result);
    }
  });
});

// ── entailmentRepairPrompt ──────────────────────────────────

describe('entailmentRepairPrompt', () => {
  it('includes STATEMENT and CLAIM in prompt', () => {
    const result = entailmentRepairPrompt('The sky is blue on clear days.', 'The sky is always blue.');
    expect(result).toContain('The sky is blue on clear days.');
    expect(result).toContain('The sky is always blue.');
  });

  it('includes verdict categories', () => {
    const result = entailmentRepairPrompt('stmt', 'claim');
    expect(result).toContain('"entailed"');
    expect(result).toContain('"partial"');
    expect(result).toContain('"not_entailed"');
  });

  it('requests minimal repair for non-entailed claims', () => {
    const result = entailmentRepairPrompt('stmt', 'claim');
    expect(result).toContain('MINIMAL repair');
    expect(result).toContain('repaired_claim');
  });

  it('requests JSON output format', () => {
    const result = entailmentRepairPrompt('stmt', 'claim');
    expect(result).toContain('JSON');
    expect(result).toContain('verdict');
    expect(result).toContain('explanation');
  });
});

// ── elementDecompositionPrompt ──────────────────────────────

describe('elementDecompositionPrompt', () => {
  it('includes statement and granularity guide', () => {
    const result = elementDecompositionPrompt('AI will transform education through personalized learning.');
    expect(result).toContain('AI will transform education through personalized learning.');
    expect(result).toContain('GRANULARITY GUIDE');
  });

  it('classifies into verifiable and normative', () => {
    const result = elementDecompositionPrompt('test');
    expect(result).toContain('"verifiable"');
    expect(result).toContain('"normative"');
  });

  it('requests JSON elements array', () => {
    const result = elementDecompositionPrompt('test');
    expect(result).toContain('"elements"');
    expect(result).toContain('"element_type"');
  });
});

// ── coverageCheckPrompt ─────────────────────────────────────

describe('coverageCheckPrompt', () => {
  it('formats elements with type labels and 1-indexed numbers', () => {
    const elements = [
      { text: 'AI improves efficiency', element_type: 'verifiable' },
      { text: 'We should regulate AI', element_type: 'normative' },
    ];
    const result = coverageCheckPrompt(elements, ['claim 1']);
    expect(result).toContain('1. [verifiable] AI improves efficiency');
    expect(result).toContain('2. [normative] We should regulate AI');
  });

  it('formats claims with 1-indexed numbers', () => {
    const result = coverageCheckPrompt([], ['First claim', 'Second claim']);
    expect(result).toContain('1. First claim');
    expect(result).toContain('2. Second claim');
  });

  it('requests JSON coverage array', () => {
    const result = coverageCheckPrompt([], []);
    expect(result).toContain('"coverage"');
    expect(result).toContain('"element_index"');
    expect(result).toContain('"covered"');
    expect(result).toContain('"covering_claim_index"');
  });
});

// ── classifyOffScopeDrift (t/394) ────────────────────────

function makeScope(overrides: Partial<TopicScope> = {}): TopicScope {
  return {
    core_proposition: 'US Congressional AI regulation',
    relevant_disciplines: ['policy', 'law'],
    on_scope_evidence: ['US legislative history'],
    key_tensions: ['innovation vs safety'],
    off_scope_topics: ['autonomous weapons', 'superintelligence'],
    drift_signatures: [],
    example_ceiling: 'Sector-specific regulatory failures (e.g., FDA device recalls, FAA certification gaps)',
    risk_level: 'medium',
    domain: 'US technology policy',
    product_type: null,
    time_horizon: '5 years',
    excluded_scenarios: ['AGI takeover'],
    explicit_qualifiers: [],
    constraint_confidence: 'explicit',
    ...overrides,
  };
}

describe('classifyOffScopeDrift', () => {
  it('classifies severity-level drift from catastrophic language', () => {
    const result = classifyOffScopeDrift(
      ['Statement frames consequences as civilizational collapse'],
      makeScope(),
    );
    expect(result).toBe('severity');
  });

  it('classifies severity-level drift from disproportionate/escalation language', () => {
    const result = classifyOffScopeDrift(
      ['Severity of claimed impacts is disproportionate to scope'],
      makeScope(),
    );
    expect(result).toBe('severity');
  });

  it('classifies domain drift from explicit domain language', () => {
    const result = classifyOffScopeDrift(
      ['Examples drawn from a different domain than the debate topic'],
      makeScope(),
    );
    expect(result).toBe('domain');
  });

  it('classifies domain drift when weakness matches off_scope_topics', () => {
    const result = classifyOffScopeDrift(
      ['Argument relies on autonomous weapons scenarios'],
      makeScope(),
    );
    expect(result).toBe('domain');
  });

  it('defaults to evidence drift when no severity or domain patterns match', () => {
    const result = classifyOffScopeDrift(
      ['Uses examples from healthcare instead of technology policy'],
      makeScope(),
    );
    expect(result).toBe('evidence');
  });

  it('does not classify as severity drift when risk_level is catastrophic', () => {
    const result = classifyOffScopeDrift(
      ['Magnitude of claimed impacts seems overstated'],
      makeScope({ risk_level: 'catastrophic' }),
    );
    expect(result).toBe('evidence');
  });
});

describe('offScopeRepairHint', () => {
  it('generates severity hint mentioning example_ceiling and proportionality', () => {
    const hint = offScopeRepairHint('severity', makeScope());
    expect(hint).toContain('severity level exceeding');
    expect(hint).toContain('Sector-specific regulatory failures');
    expect(hint).toContain('proportionate');
  });

  it('generates domain hint mentioning the debate domain', () => {
    const hint = offScopeRepairHint('domain', makeScope());
    expect(hint).toContain('US technology policy');
    expect(hint).toContain('autonomous weapons');
  });

  it('generates evidence hint with example_ceiling', () => {
    const hint = offScopeRepairHint('evidence', makeScope());
    expect(hint).toContain('Sector-specific regulatory failures');
    expect(hint).toContain('Keep your argument structure');
  });
});

describe('topicScopeExtractionPrompt', () => {
  it('includes topic in prompt without additions block when none provided', () => {
    const result = topicScopeExtractionPrompt('Should AI be regulated?');
    expect(result).toContain('Should AI be regulated?');
    expect(result).not.toContain('ADDITIONAL DIMENSIONAL CONTEXT');
  });

  it('includes scope_additions block when provided', () => {
    const additions = [
      { dimension: 'mechanism', detail: 'Liability frameworks for AI-generated content' },
      { dimension: 'stakeholder', detail: 'Include judiciary as institutional actor' },
    ];
    const result = topicScopeExtractionPrompt('Should AI be regulated?', additions);
    expect(result).toContain('ADDITIONAL DIMENSIONAL CONTEXT');
    expect(result).toContain('mechanism: Liability frameworks for AI-generated content');
    expect(result).toContain('stakeholder: Include judiciary as institutional actor');
    expect(result).toContain('Incorporate these into the appropriate scope fields');
  });

  it('omits additions block for empty array', () => {
    const result = topicScopeExtractionPrompt('Topic', []);
    expect(result).not.toContain('ADDITIONAL DIMENSIONAL CONTEXT');
  });
});

describe('improveDebateTopicPrompt', () => {
  it('returns a non-empty string containing the user topic', () => {
    const result = improveDebateTopicPrompt('AI regulation');
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain('AI regulation');
  });

  it('includes guidance for three-perspective debate framing', () => {
    const result = improveDebateTopicPrompt('Should we ban AI?');
    expect(result).toContain('accelerationist');
    expect(result).toContain('safetyist');
    expect(result).toContain('skeptic');
  });

  it('instructs plain-text response with no preamble', () => {
    const result = improveDebateTopicPrompt('test');
    expect(result).toContain('ONLY the improved topic');
    expect(result).toContain('no preamble');
  });
});

// ── draftQualityCheckPrompt — planned moves block ────────────────────────────

describe('draftQualityCheckPrompt — planned moves', () => {
  const DRAFT = 'The real issue is not speed of deployment but the framing of risk itself.';
  const SPEAKER = 'Prometheus';
  const POV = 'accelerationist';

  it('includes PLANNED MOVES block with "Do NOT flag" directive when plannedMoves provided', () => {
    const result = draftQualityCheckPrompt(
      DRAFT,
      undefined,
      SPEAKER,
      POV,
      'cross',
      3,
      [{ move: 'REFRAME', target: 'safetyist', detail: 'Reframe risk discourse from harm-prevention to opportunity cost' }],
    );
    expect(result).toContain('PLANNED MOVES');
    expect(result).toContain('REFRAME');
    expect(result).toContain('Do NOT flag');
    // Directive must orient corrections toward HOW, not WHETHER
    expect(result).toContain('HOW a move is executed');
  });

  it('omits PLANNED MOVES block when no plannedMoves supplied', () => {
    const result = draftQualityCheckPrompt(DRAFT, undefined, SPEAKER, POV, 'cross', 3);
    expect(result).not.toContain('PLANNED MOVES');
    expect(result).not.toContain('Do NOT flag');
  });
});

// ── situationTopicSynthesisPrompt (t/3636) ───────────────────────

describe('situationTopicSynthesisPrompt', () => {
  it('emits belief/desire/intention lines for BDI interpretations', () => {
    const result = situationTopicSynthesisPrompt(makeSynthesisInput());
    expectContains(result, 'belief:', 'desire:', 'intention:');
    expectContains(result, BDI_ACC.belief, BDI_SAF.desire, BDI_SKP.intention);
  });

  it('falls back to summary: for legacy string interpretations', () => {
    const result = situationTopicSynthesisPrompt(makeSynthesisInput({
      interpretations: {
        accelerationist: 'Creative destruction.',
        safetyist: 'Worker protection.',
        skeptic: 'Overblown.',
      },
    }));
    expectContains(result, 'summary: Creative destruction.', 'summary: Worker protection.');
    expect(result).not.toContain('belief:');
  });

  it('typeHint switches by disagreementType', () => {
    const def = situationTopicSynthesisPrompt(makeSynthesisInput({ disagreementType: 'definitional' }));
    const str = situationTopicSynthesisPrompt(makeSynthesisInput({ disagreementType: 'structural' }));
    const interp = situationTopicSynthesisPrompt(makeSynthesisInput({ disagreementType: 'interpretive' }));
    expect(def).toContain('DEFINITIONAL');
    expect(str).toContain('STRUCTURAL');
    expect(interp).toContain('INTERPRETIVE');
  });

  it('includes assumes block only when non-empty', () => {
    const with_ = situationTopicSynthesisPrompt(makeSynthesisInput({ assumes: ['AI replaces, not augments'] }));
    const without = situationTopicSynthesisPrompt(makeSynthesisInput({ assumes: [] }));
    expect(with_).toContain('CONTESTED ASSUMPTIONS');
    expect(with_).toContain('AI replaces, not augments');
    expect(without).not.toContain('CONTESTED ASSUMPTIONS');
  });

  it('includes conflictSummaries block only when non-empty', () => {
    const with_ = situationTopicSynthesisPrompt(makeSynthesisInput({ conflictSummaries: ['2025 UAW strike over automation'] }));
    const without = situationTopicSynthesisPrompt(makeSynthesisInput({ conflictSummaries: [] }));
    expect(with_).toContain('DOCUMENTED REAL-WORLD CONFLICTS');
    expect(without).not.toContain('DOCUMENTED REAL-WORLD CONFLICTS');
  });

  it('output-contract line is present', () => {
    const result = situationTopicSynthesisPrompt(makeSynthesisInput());
    expect(result).toContain('Respond ONLY with JSON');
  });
});

// ── formatSituationDebateContext — BDI enrichment (t/3636) ───────

describe('formatSituationDebateContext — BDI enrichment', () => {
  it('emits full BDI lines when interpretations are BdiInterpretation', () => {
    const result = formatSituationDebateContext({
      id: 'sit-201',
      label: 'AI Labor Displacement',
      description: 'AI replacing jobs.',
      interpretations: { accelerationist: BDI_ACC, safetyist: BDI_SAF, skeptic: BDI_SKP },
    });
    expectContains(result, 'belief:', 'desire:', 'intention:');
    expectContains(result, BDI_ACC.belief, BDI_SAF.desire, BDI_SKP.intention);
  });

  it('falls back to flat line for legacy string interpretations', () => {
    const input = makeSituationInput();
    const result = formatSituationDebateContext(input);
    expect(result).toContain('Accelerationist: Creative destruction drives new markets.');
    expect(result).not.toContain('belief:');
  });

  it('emits DISAGREEMENT TYPE block when disagreementType set', () => {
    const result = formatSituationDebateContext({
      id: 'sit-201',
      label: 'AI Labor Displacement',
      description: 'AI replacing jobs.',
      interpretations: { accelerationist: BDI_ACC, safetyist: BDI_SAF, skeptic: BDI_SKP },
      disagreementType: 'structural',
      interpretationDivergence: 0.72,
    });
    expect(result).toContain('DISAGREEMENT TYPE');
    expect(result).toContain('structural');
    expect(result).toContain('0.72');
  });

  it('omits DISAGREEMENT TYPE block when disagreementType absent', () => {
    const result = formatSituationDebateContext(makeSituationInput());
    expect(result).not.toContain('DISAGREEMENT TYPE');
  });
});
