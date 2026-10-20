import { describe, it, expect } from 'vitest';
import {
  confidenceUpdatesToProposals,
  priorityUpdatesToProposals,
  newItemSuggestionsToProposals,
  filterNoOpReflectionEdits,
} from './confidenceEvolution.js';
import type { ConfidenceUpdate, PriorityUpdate, RawNewItemSuggestion } from './confidenceEvolution.js';
import { operationalityUpdatesToProposals } from './operationalityEvolution.js';
import type { OperationalityUpdate } from './operationalityEvolution.js';
import { weightAdjustmentsToProposals } from './cruxTaxonomyFeedback.js';
import type { WeightAdjustment } from './cruxTaxonomyFeedback.js';
import { computeInterpretationRevisionProposals } from './situationInterpretationEvolution.js';
import type { ReflectionProposal, WeightChangeProposal, InterpretationRevisionProposal, ArgumentNetworkNode, ArgumentNetworkEdge } from './types.js';
import type { SituationNode } from './taxonomyTypes.js';

describe('confidenceUpdatesToProposals', () => {
  it('maps ConfidenceUpdate fields to ReflectionProposal shape', () => {
    const update: ConfidenceUpdate = {
      belief_id: 'acc-beliefs-001',
      reason: 'undermined',
      delta: -0.08,
      new_value: 0.42,
      debate_id: 'test-debate-1',
      claim_id: 'c1',
      attack_claim: 'Counter-evidence from study X',
      requires_human_review: false,
      gate: { passed: true, conditions_met: ['attribution', 'undermine_type', 'attack_strength'], conditions_missed: [] },
    };

    const proposals = confidenceUpdatesToProposals([update]);
    expect(proposals).toHaveLength(1);
    const p = proposals[0];
    expect(p.source).toBe('confidence_evolution');
    expect(p.node_id).toBe('acc-beliefs-001');
    expect(p.field).toBe('confidence');
    expect(p.delta).toBe(-0.08);
    expect(p.new_value).toBe(0.42);
    expect(p.debate_id).toBe('test-debate-1');
    expect(p.requires_human_review).toBe(false);
    expect(p.floor_violation).toBeNull();
    expect(p.reason).toContain('Counter-evidence from study X');
    expect(p.gate).toBeDefined();
  });

  it('sets requires_human_review from source update', () => {
    const update: ConfidenceUpdate = {
      belief_id: 'saf-beliefs-010',
      reason: 'undermined',
      delta: -0.25,
      new_value: 0.25,
      debate_id: 'd2',
      requires_human_review: true,
    };

    const [p] = confidenceUpdatesToProposals([update]);
    expect(p.requires_human_review).toBe(true);
  });

  it('handles empty input', () => {
    expect(confidenceUpdatesToProposals([])).toEqual([]);
  });
});

describe('priorityUpdatesToProposals', () => {
  it('maps PriorityUpdate to proposal with no floor violation', () => {
    const update: PriorityUpdate = {
      desire_id: 'acc-desires-003',
      reason: 'crux_of_disagreement',
      delta: 1,
      new_value: 4,
      debate_id: 'd1',
    };

    const [p] = priorityUpdatesToProposals([update]);
    expect(p.source).toBe('priority_evolution');
    expect(p.node_id).toBe('acc-desires-003');
    expect(p.field).toBe('priority');
    expect(p.delta).toBe(1);
    expect(p.new_value).toBe(4);
    expect(p.requires_human_review).toBe(false);
    expect(p.floor_violation).toBeNull();
  });

  it('flags floor violation without capping new_value', () => {
    const update: PriorityUpdate = {
      desire_id: 'saf-desires-007',
      reason: 'reflection_concession',
      delta: -1,
      new_value: 2,
      debate_id: 'd3',
    };

    const floors = new Map([['saf-desires-007', 3]]);
    const [p] = priorityUpdatesToProposals([update], floors);
    expect(p.requires_human_review).toBe(true);
    expect(p.new_value).toBe(2);
    expect(p.floor_violation).toEqual({ floor: 3, raw_value: 2 });
  });

  it('no floor violation when new_value is above floor', () => {
    const update: PriorityUpdate = {
      desire_id: 'acc-desires-001',
      reason: 'crux_of_disagreement',
      delta: 1,
      new_value: 4,
      debate_id: 'd4',
    };

    const floors = new Map([['acc-desires-001', 3]]);
    const [p] = priorityUpdatesToProposals([update], floors);
    expect(p.requires_human_review).toBe(false);
    expect(p.floor_violation).toBeNull();
  });
});

describe('operationalityUpdatesToProposals', () => {
  it('maps OperationalityUpdate to proposal', () => {
    const update: OperationalityUpdate = {
      intention_id: 'skp-intentions-002',
      reason: 'survived_specify',
      delta: 1,
      new_value: 4,
      debate_id: 'd5',
      claim_id: 'c10',
      attack_claim: 'How would you implement that?',
      gate: { passed: true, direction: 'up', conditions_met: ['attribution', 'specify_challenge', 'decisive_outcome'], conditions_missed: [] },
    };

    const [p] = operationalityUpdatesToProposals([update]);
    expect(p.source).toBe('operationality_evolution');
    expect(p.node_id).toBe('skp-intentions-002');
    expect(p.field).toBe('operationality');
    expect(p.delta).toBe(1);
    expect(p.new_value).toBe(4);
    expect(p.requires_human_review).toBe(false);
    expect(p.floor_violation).toBeNull();
    expect(p.reason).toContain('How would you implement that?');
  });

  it('handles update without attack_claim', () => {
    const update: OperationalityUpdate = {
      intention_id: 'acc-intentions-001',
      reason: 'productive_strategy',
      delta: 1,
      new_value: 4,
      debate_id: 'd6',
    };

    const [p] = operationalityUpdatesToProposals([update]);
    expect(p.reason).toBe('productive_strategy');
  });
});

describe('weightAdjustmentsToProposals', () => {
  it('maps confidence WeightAdjustment with current value', () => {
    const adj: WeightAdjustment = {
      node_id: 'acc-beliefs-005',
      type: 'confidence',
      delta: -0.05,
      reason: "Cross-debate empirical crux 'AI alignment difficulty' irreducible in 3 debates",
      crux_description: 'AI alignment difficulty',
      irreducible_count: 3,
    };

    const currentValues = new Map([['acc-beliefs-005', 0.7]]);
    const [p] = weightAdjustmentsToProposals([adj], 'debate-x', currentValues);
    expect(p.source).toBe('crux_weight_adjustment');
    expect(p.field).toBe('confidence');
    expect(p.new_value).toBeCloseTo(0.65, 10);
    expect(p.delta).toBe(-0.05);
    expect(p.floor_violation).toBeNull();
  });

  it('maps priority WeightAdjustment and flags floor violation', () => {
    const adj: WeightAdjustment = {
      node_id: 'saf-desires-002',
      type: 'priority',
      delta: 1,
      reason: 'Cross-debate values crux',
      crux_description: 'Precautionary principle scope',
      irreducible_count: 4,
    };

    const currentValues = new Map([['saf-desires-002', 4]]);
    const [p] = weightAdjustmentsToProposals([adj], 'd7', currentValues);
    expect(p.field).toBe('priority');
    expect(p.new_value).toBe(5);
    expect(p.floor_violation).toBeNull();
  });

  it('flags floor violation on priority decrease', () => {
    const adj: WeightAdjustment = {
      node_id: 'acc-desires-010',
      type: 'priority',
      delta: -1,
      reason: 'Test reason',
      crux_description: 'Test crux',
      irreducible_count: 2,
    };

    const currentValues = new Map([['acc-desires-010', 3]]);
    const floors = new Map([['acc-desires-010', 3]]);
    const [p] = weightAdjustmentsToProposals([adj], 'd8', currentValues, floors);
    expect(p.requires_human_review).toBe(true);
    expect(p.floor_violation).toEqual({ floor: 3, raw_value: 2 });
    expect(p.new_value).toBe(2);
  });

  it('uses default value when node not in currentValues map', () => {
    const adj: WeightAdjustment = {
      node_id: 'unknown-node',
      type: 'confidence',
      delta: -0.05,
      reason: 'Test',
      crux_description: 'Test',
      irreducible_count: 2,
    };

    const [p] = weightAdjustmentsToProposals([adj], 'd9', new Map());
    expect(p.new_value).toBe(0.45);
  });
});

describe('ReflectionProposal type shape', () => {
  it('weight change sources produce valid WeightChangeProposal objects', () => {
    const confUpdate: ConfidenceUpdate = {
      belief_id: 'b1', reason: 'survived', delta: 0.05, new_value: 0.55,
      debate_id: 'd1', requires_human_review: false,
    };
    const priUpdate: PriorityUpdate = {
      desire_id: 'd1', reason: 'crux_of_disagreement', delta: 1, new_value: 4, debate_id: 'd1',
    };
    const opUpdate: OperationalityUpdate = {
      intention_id: 'i1', reason: 'productive_strategy', delta: 1, new_value: 4, debate_id: 'd1',
    };
    const wAdj: WeightAdjustment = {
      node_id: 'n1', type: 'confidence', delta: -0.05,
      reason: 'test', crux_description: 'test', irreducible_count: 2,
    };

    const all: WeightChangeProposal[] = [
      ...confidenceUpdatesToProposals([confUpdate]),
      ...priorityUpdatesToProposals([priUpdate]),
      ...operationalityUpdatesToProposals([opUpdate]),
      ...weightAdjustmentsToProposals([wAdj], 'd1', new Map([['n1', 0.6]])),
    ];

    expect(all).toHaveLength(4);
    for (const p of all) {
      expect(p).toHaveProperty('source');
      expect(p).toHaveProperty('node_id');
      expect(p).toHaveProperty('field');
      expect(p).toHaveProperty('delta');
      expect(p).toHaveProperty('new_value');
      expect(p).toHaveProperty('reason');
      expect(p).toHaveProperty('debate_id');
      expect(p).toHaveProperty('requires_human_review');
      expect(p).toHaveProperty('floor_violation');
      expect(typeof p.new_value).toBe('number');
      expect(Number.isNaN(p.new_value)).toBe(false);
    }

    const sources = all.map(p => p.source);
    expect(sources).toContain('confidence_evolution');
    expect(sources).toContain('priority_evolution');
    expect(sources).toContain('operationality_evolution');
    expect(sources).toContain('crux_weight_adjustment');
  });

  it('weight and interpretation proposals coexist in ReflectionProposal[]', () => {
    const weightProposal: WeightChangeProposal = {
      kind: 'edit_existing',
      source: 'confidence_evolution',
      node_id: 'acc-beliefs-001',
      field: 'confidence',
      delta: -0.05,
      new_value: 0.45,
      reason: 'test',
      debate_id: 'd1',
      requires_human_review: false,
      floor_violation: null,
    };
    const interpProposal: InterpretationRevisionProposal = {
      kind: 'edit_existing',
      source: 'situation_interpretation',
      node_id: 'sit-001',
      camp: 'accelerationist',
      current_interpretation: 'AI progress is inevitable',
      attacking_claims: [{ claim_id: 'c1', speaker: 'safetyist', strength: 0.7 }],
      reason: 'test',
      debate_id: 'd1',
      requires_human_review: true,
      post_approval_action: 'regenerate_debate_register',
    };

    const mixed: ReflectionProposal[] = [weightProposal, interpProposal];
    expect(mixed).toHaveLength(2);
    expect(mixed[0].source).toBe('confidence_evolution');
    expect(mixed[1].source).toBe('situation_interpretation');
    expect(mixed[0].kind).toBe('edit_existing');
    expect(mixed[1].kind).toBe('edit_existing');
  });

  it('every weight/interp adapter stamps kind: edit_existing (no regression)', () => {
    const confUpdate: ConfidenceUpdate = {
      belief_id: 'b1', reason: 'survived', delta: 0.05, new_value: 0.55,
      debate_id: 'd1', requires_human_review: false,
    };
    const priUpdate: PriorityUpdate = {
      desire_id: 'd1', reason: 'crux_of_disagreement', delta: 1, new_value: 4, debate_id: 'd1',
    };
    const opUpdate: OperationalityUpdate = {
      intention_id: 'i1', reason: 'productive_strategy', delta: 1, new_value: 4, debate_id: 'd1',
    };
    const wAdj: WeightAdjustment = {
      node_id: 'n1', type: 'confidence', delta: -0.05,
      reason: 'test', crux_description: 'test', irreducible_count: 2,
    };

    const all: ReflectionProposal[] = [
      ...confidenceUpdatesToProposals([confUpdate]),
      ...priorityUpdatesToProposals([priUpdate]),
      ...operationalityUpdatesToProposals([opUpdate]),
      ...weightAdjustmentsToProposals([wAdj], 'd1', new Map([['n1', 0.6]])),
    ];
    for (const p of all) {
      expect(p.kind).toBe('edit_existing');
    }
  });
});

// ── propose_new reflection proposals (t/1772) ──────────────

describe('newItemSuggestionsToProposals', () => {
  const knownNodeIds = new Set(['saf-beliefs-002', 'saf-desires-003', 'sit-014', 'cc-042']);

  function proposeNew(overrides: Partial<RawNewItemSuggestion> = {}): RawNewItemSuggestion {
    return {
      disposition: 'propose_new',
      pov: 'safetyist',
      category: 'Beliefs',
      label: 'Epistemic Asymmetry',
      proposed_description: 'A Belief within safetyist discourse that oversight lags capability.',
      rationale: 'Turns S8 and S12 surfaced a distinct position with no existing node.',
      proposed_edges: [
        {
          target_node_id: 'saf-beliefs-002',
          edge_type: 'SUPPORTS',
          new_node_role: 'source',
          rationale: 'Reinforces saf-beliefs-002 per turn S8.',
          confidence: 0.75,
        },
      ],
      ...overrides,
    };
  }

  it('generates a propose_new proposal carrying >=1 valid edge', () => {
    const proposals = newItemSuggestionsToProposals({
      suggestions: [proposeNew()],
      pov: 'safetyist',
      debateId: 'd1',
      knownNodeIds,
    });

    expect(proposals).toHaveLength(1);
    const p = proposals[0];
    expect(p.kind).toBe('propose_new');
    expect(p.source).toBe('reflection_new_item');
    expect(p.pov).toBe('safetyist');
    expect(p.category).toBe('Beliefs');
    expect(p.label).toBe('Epistemic Asymmetry');
    expect(p.description).toBeTruthy();
    expect(p.rationale).toBeTruthy();
    expect(p.requires_human_review).toBe(true);
    expect(p.proposed_edges.length).toBeGreaterThanOrEqual(1);
    const edge = p.proposed_edges[0];
    expect(edge.target_node_id).toBe('saf-beliefs-002');
    expect(edge.edge_type).toBe('SUPPORTS');
    expect(edge.new_node_role).toBe('source');
    expect(edge.rationale).toBeTruthy();
  });

  it('emits nothing for a stray edit_existing/"add" suggestion — no edgeless new-node path (t/1820 Gate-Verification)', () => {
    // ADD was retired in t/1820 (TL ruling t/1773#9): the reflection prompt no longer offers it.
    // But even if a model hallucinates a `disposition:'edit_existing', edit_type:'add'` suggestion,
    // it must NEVER become an edgeless new node here — newItemSuggestionsToProposals only emits
    // `propose_new` (always edged). This locks the buggy door shut rather than assuming it.
    const stray = {
      disposition: 'edit_existing',
      edit_type: 'add',
      category: 'Beliefs',
      proposed_label: 'Phantom Orphan',
      proposed_description: 'A Belief within safetyist discourse that should never be created edgeless.',
      rationale: 'Model hallucinated an add despite the prompt no longer offering it.',
    } as unknown as RawNewItemSuggestion;
    const proposals = newItemSuggestionsToProposals({
      suggestions: [stray],
      pov: 'safetyist', debateId: 'd-stray-add', knownNodeIds,
    });
    expect(proposals).toHaveLength(0);
  });

  it('resolves a situation-node target (sit-*/cc-*) and accepts lowercase edge_type', () => {
    const proposals = newItemSuggestionsToProposals({
      suggestions: [proposeNew({
        proposed_edges: [
          { target_node_id: 'cc-042', edge_type: 'interprets', new_node_role: 'target', rationale: 'r' },
        ],
      })],
      pov: 'safetyist', debateId: 'd2', knownNodeIds,
    });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].proposed_edges[0].target_node_id).toBe('cc-042');
    expect(proposals[0].proposed_edges[0].edge_type).toBe('INTERPRETS');
  });

  it('rejects an ephemeral AN-* claim id as an edge target (drops the orphaned proposal)', () => {
    const proposals = newItemSuggestionsToProposals({
      suggestions: [proposeNew({
        proposed_edges: [
          { target_node_id: 'AN-7', edge_type: 'SUPPORTS', new_node_role: 'source', rationale: 'r' },
        ],
      })],
      pov: 'safetyist', debateId: 'd3', knownNodeIds,
    });
    expect(proposals).toHaveLength(0);
  });

  it('rejects a crux-registry id and an unknown/hallucinated node id', () => {
    const proposals = newItemSuggestionsToProposals({
      suggestions: [proposeNew({
        proposed_edges: [
          { target_node_id: 'crux-001', edge_type: 'SUPPORTS', new_node_role: 'source', rationale: 'r' },
          { target_node_id: 'saf-beliefs-999', edge_type: 'SUPPORTS', new_node_role: 'source', rationale: 'r' },
        ],
      })],
      pov: 'safetyist', debateId: 'd4', knownNodeIds,
    });
    expect(proposals).toHaveLength(0);
  });

  it('drops edges with an invalid edge_type but keeps valid ones', () => {
    const proposals = newItemSuggestionsToProposals({
      suggestions: [proposeNew({
        proposed_edges: [
          { target_node_id: 'saf-beliefs-002', edge_type: 'ENDORSES', new_node_role: 'source', rationale: 'r' },
          { target_node_id: 'sit-014', edge_type: 'TENSION_WITH', new_node_role: 'target', rationale: 'r2' },
        ],
      })],
      pov: 'safetyist', debateId: 'd5', knownNodeIds,
    });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].proposed_edges).toHaveLength(1);
    expect(proposals[0].proposed_edges[0].target_node_id).toBe('sit-014');
  });

  it('drops a propose_new with zero valid edges rather than emit an orphan', () => {
    const proposals = newItemSuggestionsToProposals({
      suggestions: [proposeNew({ proposed_edges: [] })],
      pov: 'safetyist', debateId: 'd6', knownNodeIds,
    });
    expect(proposals).toHaveLength(0);
  });

  it('requires a substantive rationale (no lazy default)', () => {
    const proposals = newItemSuggestionsToProposals({
      suggestions: [proposeNew({ rationale: '   ' })],
      pov: 'safetyist', debateId: 'd7', knownNodeIds,
    });
    expect(proposals).toHaveLength(0);
  });

  it('drops an edge missing its per-edge rationale', () => {
    const proposals = newItemSuggestionsToProposals({
      suggestions: [proposeNew({
        proposed_edges: [
          { target_node_id: 'saf-beliefs-002', edge_type: 'SUPPORTS', new_node_role: 'source' },
        ],
      })],
      pov: 'safetyist', debateId: 'd8', knownNodeIds,
    });
    expect(proposals).toHaveLength(0);
  });

  it('ignores edit_existing suggestions (disposition is exclusive)', () => {
    const proposals = newItemSuggestionsToProposals({
      suggestions: [{ disposition: 'edit_existing', edit_type: 'revise', node_id: 'saf-beliefs-002' } as RawNewItemSuggestion],
      pov: 'safetyist', debateId: 'd9', knownNodeIds,
    });
    expect(proposals).toHaveLength(0);
  });

  it('falls back to the caller pov when the suggested pov is invalid', () => {
    const proposals = newItemSuggestionsToProposals({
      suggestions: [proposeNew({ pov: 'not-a-pov' })],
      pov: 'skeptic', debateId: 'd10', knownNodeIds,
    });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].pov).toBe('skeptic');
  });

  it('superseded edge target: accepted by full-set knownNodeIds, resolved to survivor via resolveRef (t/4354)', () => {
    // 'saf-beliefs-OLD' is superseded by 'saf-beliefs-002'. Full-set knownNodeIds includes it so
    // fuzzyCorrectNodeId never gets a chance to misattribute it to a different node.
    const fullKnownNodeIds = new Set([...knownNodeIds, 'saf-beliefs-OLD']);
    const resolveRef = (id: string) => id === 'saf-beliefs-OLD' ? 'saf-beliefs-002' : id;
    const proposals = newItemSuggestionsToProposals({
      suggestions: [proposeNew({
        proposed_edges: [
          { target_node_id: 'saf-beliefs-OLD', edge_type: 'SUPPORTS', new_node_role: 'source', rationale: 'citing retired node' },
        ],
      })],
      pov: 'safetyist', debateId: 'd-superseded', knownNodeIds: fullKnownNodeIds, resolveRef,
    });
    expect(proposals).toHaveLength(1);
    // Edge target must be the survivor, not the superseded node
    expect(proposals[0].proposed_edges[0].target_node_id).toBe('saf-beliefs-002');
  });
});

// ── Situation interpretation materiality gate ──────────────

function makeNode(overrides: Partial<ArgumentNetworkNode> & { id: string; speaker: string }): ArgumentNetworkNode {
  return {
    text: 'test claim',
    source_entry_id: 'e1',
    taxonomy_refs: [],
    turn_number: 1,
    ...overrides,
  };
}

function makeEdge(overrides: Partial<ArgumentNetworkEdge> & { id: string; source: string; target: string }): ArgumentNetworkEdge {
  return {
    type: 'attacks',
    ...overrides,
  };
}

function makeSituation(overrides: Partial<SituationNode> & { id: string }): SituationNode {
  return {
    label: 'Test situation',
    description: 'A test situation',
    interpretations: {
      accelerationist: 'Acc interpretation',
      safetyist: 'Saf interpretation',
      skeptic: 'Skp interpretation',
    },
    linked_nodes: [],
    conflict_ids: [],
    ...overrides,
  };
}

describe('computeInterpretationRevisionProposals', () => {
  it('emits proposal when material engagement is present', () => {
    const targetNode = makeNode({
      id: 'n1', speaker: 'accelerationist',
      claim_taxonomy_attribution: {
        primary_ref: 'sit-001',
        attribution_confidence: 0.80,
      },
    });
    const attackerNode = makeNode({
      id: 'n2', speaker: 'safetyist', computed_strength: 0.7,
    });
    const edge = makeEdge({ id: 'e1', source: 'n2', target: 'n1', type: 'attacks', attack_type: 'rebut' });
    const sit = makeSituation({ id: 'sit-001', label: 'AI development pace' });

    const proposals = computeInterpretationRevisionProposals({
      nodes: [targetNode, attackerNode],
      edges: [edge],
      situations: [sit],
      debateId: 'test-debate',
    });

    expect(proposals).toHaveLength(1);
    const p = proposals[0];
    expect(p.source).toBe('situation_interpretation');
    expect(p.node_id).toBe('sit-001');
    expect(p.camp).toBe('accelerationist');
    expect(p.current_interpretation).toBe('Acc interpretation');
    expect(p.attacking_claims).toHaveLength(1);
    expect(p.attacking_claims[0]).toEqual({ claim_id: 'n2', speaker: 'safetyist', strength: 0.7 });
    expect(p.requires_human_review).toBe(true);
    expect(p.post_approval_action).toBe('regenerate_debate_register');
    expect(p.debate_id).toBe('test-debate');
  });

  it('does not emit proposal for mere reference (no attacks)', () => {
    const refNode = makeNode({
      id: 'n1', speaker: 'accelerationist',
      claim_taxonomy_attribution: {
        primary_ref: 'sit-001',
        attribution_confidence: 0.85,
      },
    });
    const sit = makeSituation({ id: 'sit-001' });

    const proposals = computeInterpretationRevisionProposals({
      nodes: [refNode],
      edges: [],
      situations: [sit],
      debateId: 'd1',
    });

    expect(proposals).toHaveLength(0);
  });

  it('does not emit proposal for weak attack (below strength threshold)', () => {
    const targetNode = makeNode({
      id: 'n1', speaker: 'safetyist',
      claim_taxonomy_attribution: {
        primary_ref: 'sit-002',
        attribution_confidence: 0.75,
      },
    });
    const weakAttacker = makeNode({
      id: 'n2', speaker: 'skeptic', computed_strength: 0.3,
    });
    const edge = makeEdge({ id: 'e1', source: 'n2', target: 'n1' });
    const sit = makeSituation({ id: 'sit-002' });

    const proposals = computeInterpretationRevisionProposals({
      nodes: [targetNode, weakAttacker],
      edges: [edge],
      situations: [sit],
      debateId: 'd2',
    });

    expect(proposals).toHaveLength(0);
  });

  it('does not emit proposal for low attribution confidence', () => {
    const targetNode = makeNode({
      id: 'n1', speaker: 'accelerationist',
      claim_taxonomy_attribution: {
        primary_ref: 'sit-003',
        attribution_confidence: 0.40,
      },
    });
    const attacker = makeNode({
      id: 'n2', speaker: 'safetyist', computed_strength: 0.8,
    });
    const edge = makeEdge({ id: 'e1', source: 'n2', target: 'n1' });
    const sit = makeSituation({ id: 'sit-003' });

    const proposals = computeInterpretationRevisionProposals({
      nodes: [targetNode, attacker],
      edges: [edge],
      situations: [sit],
      debateId: 'd3',
    });

    expect(proposals).toHaveLength(0);
  });

  it('emits two proposals when two camps are materially attacked for the same situation', () => {
    const accNode = makeNode({
      id: 'n1', speaker: 'accelerationist',
      claim_taxonomy_attribution: { primary_ref: 'sit-001', attribution_confidence: 0.70 },
    });
    const safNode = makeNode({
      id: 'n2', speaker: 'safetyist',
      claim_taxonomy_attribution: { primary_ref: 'sit-001', attribution_confidence: 0.75 },
    });
    const attacker1 = makeNode({ id: 'a1', speaker: 'skeptic', computed_strength: 0.6 });
    const attacker2 = makeNode({ id: 'a2', speaker: 'skeptic', computed_strength: 0.7 });
    const edge1 = makeEdge({ id: 'e1', source: 'a1', target: 'n1' });
    const edge2 = makeEdge({ id: 'e2', source: 'a2', target: 'n2' });
    const sit = makeSituation({ id: 'sit-001' });

    const proposals = computeInterpretationRevisionProposals({
      nodes: [accNode, safNode, attacker1, attacker2],
      edges: [edge1, edge2],
      situations: [sit],
      debateId: 'd4',
    });

    expect(proposals).toHaveLength(2);
    const camps = proposals.map(p => p.camp).sort();
    expect(camps).toEqual(['accelerationist', 'safetyist']);
  });

  it('deduplicates: multiple attacks on same (sit, camp) produce one proposal with multiple attacking_claims', () => {
    const targetNode1 = makeNode({
      id: 'n1', speaker: 'accelerationist',
      claim_taxonomy_attribution: { primary_ref: 'sit-001', attribution_confidence: 0.80 },
    });
    const targetNode2 = makeNode({
      id: 'n3', speaker: 'accelerationist',
      claim_taxonomy_attribution: { primary_ref: 'sit-001', attribution_confidence: 0.65 },
    });
    const attacker1 = makeNode({ id: 'a1', speaker: 'safetyist', computed_strength: 0.6 });
    const attacker2 = makeNode({ id: 'a2', speaker: 'skeptic', computed_strength: 0.8 });
    const edge1 = makeEdge({ id: 'e1', source: 'a1', target: 'n1' });
    const edge2 = makeEdge({ id: 'e2', source: 'a2', target: 'n3' });
    const sit = makeSituation({ id: 'sit-001' });

    const proposals = computeInterpretationRevisionProposals({
      nodes: [targetNode1, targetNode2, attacker1, attacker2],
      edges: [edge1, edge2],
      situations: [sit],
      debateId: 'd5',
    });

    expect(proposals).toHaveLength(1);
    expect(proposals[0].camp).toBe('accelerationist');
    expect(proposals[0].attacking_claims).toHaveLength(2);
    const claimIds = proposals[0].attacking_claims.map(c => c.claim_id).sort();
    expect(claimIds).toEqual(['a1', 'a2']);
  });

  it('handles legacy cc-* situation IDs', () => {
    const targetNode = makeNode({
      id: 'n1', speaker: 'skeptic',
      claim_taxonomy_attribution: { primary_ref: 'cc-042', attribution_confidence: 0.70 },
    });
    const attacker = makeNode({ id: 'a1', speaker: 'accelerationist', computed_strength: 0.55 });
    const edge = makeEdge({ id: 'e1', source: 'a1', target: 'n1' });
    const sit = makeSituation({ id: 'cc-042', label: 'Legacy situation' });

    const proposals = computeInterpretationRevisionProposals({
      nodes: [targetNode, attacker],
      edges: [edge],
      situations: [sit],
      debateId: 'd6',
    });

    expect(proposals).toHaveLength(1);
    expect(proposals[0].node_id).toBe('cc-042');
  });

  it('skips non-POV speakers (system, document, user)', () => {
    const systemNode = makeNode({
      id: 'n1', speaker: 'system',
      claim_taxonomy_attribution: { primary_ref: 'sit-001', attribution_confidence: 0.90 },
    });
    const attacker = makeNode({ id: 'a1', speaker: 'safetyist', computed_strength: 0.8 });
    const edge = makeEdge({ id: 'e1', source: 'a1', target: 'n1' });
    const sit = makeSituation({ id: 'sit-001' });

    const proposals = computeInterpretationRevisionProposals({
      nodes: [systemNode, attacker],
      edges: [edge],
      situations: [sit],
      debateId: 'd7',
    });

    expect(proposals).toHaveLength(0);
  });

  it('skips situations with no interpretations', () => {
    const targetNode = makeNode({
      id: 'n1', speaker: 'accelerationist',
      claim_taxonomy_attribution: { primary_ref: 'sit-empty', attribution_confidence: 0.80 },
    });
    const attacker = makeNode({ id: 'a1', speaker: 'safetyist', computed_strength: 0.7 });
    const edge = makeEdge({ id: 'e1', source: 'a1', target: 'n1' });
    const sit = makeSituation({
      id: 'sit-empty',
      interpretations: { accelerationist: '', safetyist: '', skeptic: '' },
    });

    const proposals = computeInterpretationRevisionProposals({
      nodes: [targetNode, attacker],
      edges: [edge],
      situations: [sit],
      debateId: 'd8',
    });

    // Empty interpretations have nothing to revise — skipped
    expect(proposals).toHaveLength(0);
  });

  it('handles secondary_refs pointing to situations', () => {
    const targetNode = makeNode({
      id: 'n1', speaker: 'safetyist',
      claim_taxonomy_attribution: {
        primary_ref: 'saf-beliefs-005',
        attribution_confidence: 0.85,
        secondary_refs: [
          { node_id: 'sit-010', similarity: 0.70 },
          { node_id: 'acc-beliefs-001', similarity: 0.65 },
        ],
      },
    });
    const attacker = makeNode({ id: 'a1', speaker: 'accelerationist', computed_strength: 0.6 });
    const edge = makeEdge({ id: 'e1', source: 'a1', target: 'n1' });
    const sit = makeSituation({ id: 'sit-010', label: 'Regulation timing' });

    const proposals = computeInterpretationRevisionProposals({
      nodes: [targetNode, attacker],
      edges: [edge],
      situations: [sit],
      debateId: 'd9',
    });

    expect(proposals).toHaveLength(1);
    expect(proposals[0].node_id).toBe('sit-010');
    expect(proposals[0].camp).toBe('safetyist');
  });

  it('handles BDI-decomposed interpretations via interpretationText()', () => {
    const targetNode = makeNode({
      id: 'n1', speaker: 'accelerationist',
      claim_taxonomy_attribution: { primary_ref: 'sit-bdi', attribution_confidence: 0.80 },
    });
    const attacker = makeNode({ id: 'a1', speaker: 'safetyist', computed_strength: 0.7 });
    const edge = makeEdge({ id: 'e1', source: 'a1', target: 'n1' });
    const sit = makeSituation({
      id: 'sit-bdi',
      interpretations: {
        accelerationist: {
          belief: 'AI will surpass human intelligence',
          desire: 'Maximize AI capability development',
          intention: 'Remove regulatory barriers',
          summary: 'AI progress should be maximized',
        },
        safetyist: 'Safety first',
        skeptic: 'Need more evidence',
      },
    });

    const proposals = computeInterpretationRevisionProposals({
      nodes: [targetNode, attacker],
      edges: [edge],
      situations: [sit],
      debateId: 'd10',
    });

    expect(proposals).toHaveLength(1);
    expect(proposals[0].current_interpretation).toBe('AI progress should be maximized');
  });

  it('returns empty array when no AN nodes exist', () => {
    const sit = makeSituation({ id: 'sit-001' });
    const proposals = computeInterpretationRevisionProposals({
      nodes: [], edges: [], situations: [sit], debateId: 'd11',
    });
    expect(proposals).toEqual([]);
  });

  it('ignores support edges (only attacks trigger proposals)', () => {
    const targetNode = makeNode({
      id: 'n1', speaker: 'accelerationist',
      claim_taxonomy_attribution: { primary_ref: 'sit-001', attribution_confidence: 0.80 },
    });
    const supporter = makeNode({ id: 'n2', speaker: 'accelerationist', computed_strength: 0.9 });
    const supportEdge = makeEdge({ id: 'e1', source: 'n2', target: 'n1', type: 'supports' });
    const sit = makeSituation({ id: 'sit-001' });

    const proposals = computeInterpretationRevisionProposals({
      nodes: [targetNode, supporter],
      edges: [supportEdge],
      situations: [sit],
      debateId: 'd12',
    });

    expect(proposals).toHaveLength(0);
  });
});

describe('filterNoOpReflectionEdits', () => {
  const desc = 'A Belief within safetyist discourse that oversight gaps compound.\nEncompasses: regulatory lag, self-certification, delegation.\nExcludes: intentional evasion, post-deployment monitoring.';

  it('passes through an edit where proposed description differs from current', () => {
    const edit = {
      disposition: 'edit_existing',
      node_id: 'saf-beliefs-001',
      edit_type: 'qualify',
      current_description: desc,
      proposed_description: desc + ' Qualified by recent empirical evidence.',
    };
    expect(filterNoOpReflectionEdits([edit], 'd1')).toHaveLength(1);
  });

  it('drops edit_existing where proposed_description is byte-identical to current', () => {
    const edit = {
      disposition: 'edit_existing',
      node_id: 'saf-beliefs-001',
      edit_type: 'qualify',
      current_description: desc,
      proposed_description: desc,
    };
    expect(filterNoOpReflectionEdits([edit], 'd1')).toHaveLength(0);
  });

  it('drops edit_existing where proposed_description differs only in whitespace', () => {
    const edit = {
      disposition: 'edit_existing',
      node_id: 'saf-beliefs-001',
      edit_type: 'revise',
      current_description: desc,
      proposed_description: '  ' + desc.replace(/\n/g, '  \n  ') + '  ',
    };
    expect(filterNoOpReflectionEdits([edit], 'd1')).toHaveLength(0);
  });

  it('passes through propose_new entries regardless of description match', () => {
    const edit = {
      disposition: 'propose_new',
      node_id: undefined,
      edit_type: 'new_node',
      current_description: desc,
      proposed_description: desc,
    };
    expect(filterNoOpReflectionEdits([edit], 'd1')).toHaveLength(1);
  });

  it('passes through when current_description is empty (cannot confirm no-op)', () => {
    const edit = {
      disposition: 'edit_existing',
      node_id: 'saf-beliefs-001',
      edit_type: 'qualify',
      current_description: '',
      proposed_description: desc,
    };
    expect(filterNoOpReflectionEdits([edit], 'd1')).toHaveLength(1);
  });

  it('filters multiple no-ops while keeping valid edits', () => {
    const noop = { disposition: 'edit_existing', node_id: 'acc-beliefs-001', edit_type: 'qualify', current_description: desc, proposed_description: desc };
    const valid = { disposition: 'edit_existing', node_id: 'acc-beliefs-002', edit_type: 'revise', current_description: desc, proposed_description: desc + ' Updated.' };
    const result = filterNoOpReflectionEdits([noop, valid, noop], 'd2');
    expect(result).toHaveLength(1);
    expect(result[0].node_id).toBe('acc-beliefs-002');
  });
});
