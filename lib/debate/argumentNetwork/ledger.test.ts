// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect } from 'vitest';
import { formatConcessionCandidatesHint } from './ledger.js';

function makeNode(id: string, speaker: string, strength: number, groundingStatement?: string) {
  return {
    id,
    text: `Claim ${id}`,
    speaker,
    computed_strength: strength,
    claim_taxonomy_attribution: groundingStatement
      ? { primary_ref: 'acc-B-001', grounding_statement: groundingStatement }
      : { primary_ref: 'acc-B-001' },
  };
}

describe('formatConcessionCandidatesHint — grounding line (t/4692)', () => {
  it('renders the stored grounding_statement for a candidate claim', () => {
    const nodes = [makeNode('an-1', 'accelerationist', 0.6, 'A synthetic statement for this node.')];
    const result = formatConcessionCandidatesHint(nodes, [], 'skeptic');
    expect(result).toContain('Taxonomy grounding [acc-B-001]: "A synthetic statement for this node."');
  });

  it('renders no grounding line when the candidate has no grounding_statement', () => {
    const nodes = [makeNode('an-1', 'accelerationist', 0.6)];
    const result = formatConcessionCandidatesHint(nodes, [], 'skeptic');
    expect(result).not.toContain('Taxonomy grounding');
  });
});
