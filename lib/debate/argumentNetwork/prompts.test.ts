// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect } from 'vitest';
import { formatEstablishedPoints } from './prompts.js';

describe('formatEstablishedPoints — steelman routing', () => {
  const steelmanNode = {
    id: 'an-10',
    text: 'AI systems require careful oversight to prevent misuse',
    speaker: 'accelerationist',
    steelman_of: 'skeptic',
  };
  const regularAccNode = {
    id: 'an-11',
    text: 'AI development should proceed rapidly to capture benefits',
    speaker: 'accelerationist',
  };
  const regularSkpNode = {
    id: 'an-12',
    text: 'Current AI capabilities are overhyped',
    speaker: 'skeptic',
  };

  it('steelman of skeptic appears in gift section (not opponent section) when skeptic is current speaker', () => {
    // t/3795: own-camp steelmans surface in the gift section, not as opponent claims.
    // effectiveCamp(steelmanNode) = 'skeptic' === currentSpeaker → ownSteelman, not otherClaims.
    const result = formatEstablishedPoints(
      [steelmanNode, regularAccNode],
      'skeptic',
    );
    // Gift section is present and contains the steelman with CL label
    expect(result).toContain('=== YOUR POSITION, AS CHARITABLY RESTATED BY ANOTHER DEBATER ===');
    expect(result).toContain('an-10');
    expect(result).toContain('Charitable restatement of the Skeptic position, authored by Accelerationist');
    // Gift section rendered BEFORE the opponent section (primacy)
    const giftIdx = result.indexOf('=== YOUR POSITION');
    const otherIdx = result.indexOf('=== POINTS ALREADY ESTABLISHED');
    expect(giftIdx).toBeGreaterThanOrEqual(0);
    expect(otherIdx).toBeGreaterThanOrEqual(0);
    expect(giftIdx).toBeLessThan(otherIdx);
    // an-10 appears before the opponent section header (i.e., in the gift section, not as opponent claim)
    expect(result.indexOf('an-10')).toBeLessThan(otherIdx);
    // Regular acc node still visible as opponent claim
    expect(result).toContain('an-11');
  });

  it('steelman of skeptic is included in otherClaims when accelerationist is current speaker', () => {
    // effectiveCamp(steelmanNode) = 'skeptic' !== 'accelerationist' → in otherClaims
    const result = formatEstablishedPoints(
      [steelmanNode, regularSkpNode],
      'accelerationist',
    );
    expect(result).toContain('an-10');
    expect(result).toContain('an-12');
  });

  it('steelman author does not see their own steelman in the gift section', () => {
    // The accelerationist authored steelmanNode — effectiveCamp = 'skeptic' !== 'accelerationist',
    // so it lands in otherClaims, not ownSteelmans. No gift section for the author.
    const result = formatEstablishedPoints(
      [steelmanNode, regularSkpNode],
      'accelerationist',
    );
    expect(result).not.toContain('=== YOUR POSITION, AS CHARITABLY RESTATED BY ANOTHER DEBATER ===');
    // Steelman still appears — as a skeptic-camp claim in the opponent section
    expect(result).toContain('an-10');
  });

  it('steelman node carries CL label — charitable restatement, authored by', () => {
    const result = formatEstablishedPoints(
      [steelmanNode, regularAccNode],
      'accelerationist',
    );
    expect(result).toContain('Charitable restatement of the Skeptic position, authored by Accelerationist');
  });

  it('regular node renders with camp label, not steelman label', () => {
    const result = formatEstablishedPoints(
      [regularAccNode],
      'skeptic',
    );
    expect(result).toContain('Accelerationist');
    expect(result).not.toContain('Charitable restatement');
  });
});

describe('formatEstablishedPoints — grounding line (t/4692)', () => {
  it('renders the stored grounding_statement for an attributed claim', () => {
    const node = {
      id: 'an-20',
      text: 'A claim already attributed to a taxonomy node',
      speaker: 'accelerationist',
      claim_taxonomy_attribution: { primary_ref: 'acc-B-001', grounding_statement: 'A synthetic statement for this node.' },
    };
    const result = formatEstablishedPoints([node], 'skeptic');
    expect(result).toContain('Taxonomy grounding [acc-B-001]: "A synthetic statement for this node."');
  });

  it('renders no grounding line when the attribution has no grounding_statement', () => {
    const node = {
      id: 'an-21',
      text: 'An attributed claim with no synthetic-corpus match',
      speaker: 'accelerationist',
      claim_taxonomy_attribution: { primary_ref: 'acc-B-001' },
    };
    const result = formatEstablishedPoints([node], 'skeptic');
    expect(result).not.toContain('Taxonomy grounding');
  });

  it('renders no grounding line for an unattributed claim', () => {
    const node = {
      id: 'an-22',
      text: 'An unattributed claim',
      speaker: 'accelerationist',
    };
    const result = formatEstablishedPoints([node], 'skeptic');
    expect(result).not.toContain('Taxonomy grounding');
  });
});
