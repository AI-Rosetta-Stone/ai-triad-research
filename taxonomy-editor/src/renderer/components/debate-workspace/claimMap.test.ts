import { describe, it, expect } from 'vitest';
import { parseWorkProduct, normalizeAnticipatedItem, stripLeadingVerb } from './claimMap';

const claims = [
  { point: 'Labs self-regulate', evidence: 'Ev 1', taxonomy_anchor: 'acc-saf-001' },
  { point: 'Audits work', evidence: 'Ev 2', taxonomy_anchor: 'skp-beliefs-004' },
];

describe('parseWorkProduct', () => {
  it('returns empty data for an empty work product', () => {
    expect(parseWorkProduct({})).toEqual({ claims: [], unmappedAttacks: [], assumptions: [], verifiedAttacks: 0 });
  });

  it('numbers claims from 1 and keeps their evidence and anchors', () => {
    const { claims: parsed } = parseWorkProduct({ argument_structure: claims });
    expect(parsed.map(c => c.index)).toEqual([1, 2]);
    expect(parsed[0]).toMatchObject({ point: 'Labs self-regulate', evidence: 'Ev 1', taxonomy_anchor: 'acc-saf-001' });
  });

  it('routes an ATTACK to the claim named by its "targeting node" phrase and strips that phrase', () => {
    const { claims: parsed, unmappedAttacks } = parseWorkProduct({
      argument_structure: claims,
      anticipated_challenges: ['ATTACK: Self-regulation fails under pressure targeting node skp-beliefs-004'],
    });
    expect(unmappedAttacks).toEqual([]);
    expect(parsed[1].attack).toMatchObject({
      text: 'Self-regulation fails under pressure',
      targetAnchor: 'skp-beliefs-004',
      annotationId: 'AN-0',
    });
    expect(parsed[0].attack).toBeUndefined();
  });

  it('routes by whole token in the text when there is no target phrase', () => {
    const { claims: parsed } = parseWorkProduct({
      argument_structure: claims,
      anticipated_challenges: ['ATTACK: The acc-saf-001 premise is weak.'],
    });
    expect(parsed[0].attack?.text).toBe('The acc-saf-001 premise is weak.');
  });

  it('does not misattach on a substring of an anchor', () => {
    const { claims: parsed, unmappedAttacks } = parseWorkProduct({
      argument_structure: claims,
      anticipated_challenges: ['ATTACK: See acc-saf-0019 for the counterexample'],
    });
    expect(parsed.every(c => c.attack === undefined)).toBe(true);
    expect(unmappedAttacks).toHaveLength(1);
  });

  it('keeps a second attack on the same claim as unmapped instead of overwriting the first', () => {
    const { claims: parsed, unmappedAttacks } = parseWorkProduct({
      argument_structure: claims,
      anticipated_challenges: [
        'ATTACK: First objection targeting node acc-saf-001',
        'ATTACK: Second objection targeting node acc-saf-001',
      ],
    });
    expect(parsed[0].attack?.text).toBe('First objection');
    expect(parsed[0].attack?.annotationId).toBe('AN-0');
    expect(unmappedAttacks.map(a => a.text)).toEqual(['Second objection']);
  });

  it('puts an attack that names no claim into unmappedAttacks', () => {
    const { unmappedAttacks } = parseWorkProduct({
      argument_structure: claims,
      anticipated_challenges: ['ATTACK: A point about funding targeting node pol-xyz-009'],
    });
    expect(unmappedAttacks).toEqual([
      { text: 'A point about funding', targetAnchor: 'pol-xyz-009', annotationId: 'AN-0' },
    ]);
  });

  it('separates tagged assumptions from untagged challenges', () => {
    const { assumptions } = parseWorkProduct({
      anticipated_challenges: ['ASSUMPTION: Regulators act within a year', 'Plain challenge text'],
    });
    expect(assumptions).toEqual([
      { text: 'Regulators act within a year', tagged: true },
      { text: 'Plain challenge text', tagged: false },
    ]);
  });

  it('counts no attack as verified while no NLI status is present', () => {
    const { verifiedAttacks } = parseWorkProduct({
      argument_structure: claims,
      anticipated_challenges: ['ATTACK: Objection targeting node acc-saf-001'],
    });
    expect(verifiedAttacks).toBe(0);
  });
});

describe('normalizeAnticipatedItem', () => {
  it('reads legacy {challenge, type} objects without throwing', () => {
    expect(normalizeAnticipatedItem({ challenge: 'Too slow', type: 'ATTACK' })).toBe('ATTACK: Too slow');
  });
});

describe('stripLeadingVerb', () => {
  it('strips a leading "Establish that " only at the start', () => {
    expect(stripLeadingVerb('Establish that labs fail')).toBe('labs fail');
    expect(stripLeadingVerb('Labs should establish that')).toBe('Labs should establish that');
  });
});
