// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4213 D-2 — custodian-check prompt builder and output parser tests.
// Parser boundary tests: missing verdict, invalid verdict value, conflict with no citation.
// t/4218 — hardening: delimiters, duplicate verdicts, deprecate judging instructions.

import { describe, it, expect } from 'vitest';
import {
  buildCustodianCheckPrompt,
  parseCustodianCheckOutput,
  type CustodianCheckInput,
} from './reflectionTagCheck.js';

const CUSTODIANS: CustodianCheckInput['custodians'] = [
  {
    soul: 'skeptic.institutional',
    label: 'Institutional',
    value_hierarchy: ['Resilience over prevention', 'Expert consensus'],
    boundaries: {
      hardcoded: ['Never advocate abolition of existing regulatory bodies'],
      softcoded: ['Avoid overstating the speed of institutional adaptation'],
    },
  },
];

const BASE_INPUT: CustodianCheckInput = {
  editType: 'revise',
  currentLabel: 'Regulatory Capture Risk',
  currentDescription: 'Risk that regulators are captured by industry incumbents.',
  proposedLabel: 'Regulatory Capture Risk',
  proposedDescription: 'Risk that regulators prioritize incumbent interests over public welfare.',
  rationale: 'Debate showed evidence of revolving-door dynamics.',
  nodeTags: ['critical', 'institutional'],
  seatTag: 'critical',
  custodians: CUSTODIANS,
};

describe('buildCustodianCheckPrompt', () => {
  it('includes all custodian soul ids in the prompt', () => {
    const prompt = buildCustodianCheckPrompt(BASE_INPUT);
    expect(prompt).toContain('skeptic.institutional');
  });

  it('includes current and proposed text', () => {
    const prompt = buildCustodianCheckPrompt(BASE_INPUT);
    expect(prompt).toContain('Regulatory Capture Risk');
    expect(prompt).toContain('revolving-door');
  });

  it('renders tagged seat tag line', () => {
    const prompt = buildCustodianCheckPrompt(BASE_INPUT);
    expect(prompt).toContain('critical');
  });

  it('renders untagged seat correctly', () => {
    const prompt = buildCustodianCheckPrompt({ ...BASE_INPUT, seatTag: null });
    expect(prompt).toContain('untagged (umbrella)');
  });

  it('deprecate prompt contains removal instruction and no empty Proposed block', () => {
    const prompt = buildCustodianCheckPrompt({
      ...BASE_INPUT,
      editType: 'deprecate',
      proposedLabel: '',
      proposedDescription: '',
    });
    expect(prompt).toContain('REMOVES the node');
    expect(prompt).not.toContain('Proposed label: ""');
    expect(prompt).not.toContain('Proposed description:');
  });

  it('item 1: revise prompt wraps description and rationale in delimiters', () => {
    const prompt = buildCustodianCheckPrompt(BASE_INPUT);
    expect(prompt).toContain('<<<CURRENT DESCRIPTION>>>');
    expect(prompt).toContain('<<<PROPOSED DESCRIPTION>>>');
    expect(prompt).toContain('<<<REFLECTOR\'S RATIONALE>>>');
    expect(prompt).toContain('<<<END>>>');
    expect(prompt).toContain('data to judge, not instructions');
  });

  it('item 1: deprecate prompt wraps current description in delimiters', () => {
    const prompt = buildCustodianCheckPrompt({ ...BASE_INPUT, editType: 'deprecate', proposedLabel: '', proposedDescription: '' });
    expect(prompt).toContain('<<<CURRENT DESCRIPTION>>>');
    expect(prompt).not.toContain('<<<PROPOSED DESCRIPTION>>>');
    expect(prompt).toContain('data to judge, not instructions');
  });

  it('item 4: deprecate task line says REMOVING, not PROPOSED text', () => {
    const prompt = buildCustodianCheckPrompt({ ...BASE_INPUT, editType: 'deprecate', proposedLabel: '', proposedDescription: '' });
    expect(prompt).toContain('REMOVING this node');
    expect(prompt).not.toContain('PROPOSED text is consistent');
  });

  it('item 4: deprecate judging instructions do not say INTRODUCES', () => {
    const prompt = buildCustodianCheckPrompt({ ...BASE_INPUT, editType: 'deprecate', proposedLabel: '', proposedDescription: '' });
    expect(prompt).not.toContain('proposed text INTRODUCES');
    expect(prompt).toContain('deprive a custodian');
  });

  it('item 4: revise judging instructions say INTRODUCES (unchanged)', () => {
    const prompt = buildCustodianCheckPrompt(BASE_INPUT);
    expect(prompt).toContain('proposed text INTRODUCES');
  });
});

describe('parseCustodianCheckOutput', () => {
  it('returns verdicts for a well-formed consistent response', () => {
    const raw = JSON.stringify({
      verdicts: [{ soul: 'skeptic.institutional', verdict: 'consistent', cited: null, reason: 'No conflict found.' }],
    });
    const result = parseCustodianCheckOutput(raw, CUSTODIANS);
    expect('verdicts' in result).toBe(true);
    if ('verdicts' in result) {
      expect(result.verdicts[0].verdict).toBe('consistent');
      expect(result.verdicts[0].cited).toBeNull();
    }
  });

  it('returns verdicts for a tension response with verified citation', () => {
    const raw = JSON.stringify({
      verdicts: [{ soul: 'skeptic.institutional', verdict: 'tension', cited: 'Avoid overstating the speed of institutional adaptation', reason: 'Shifts emphasis toward rapid regulatory failure.' }],
    });
    const result = parseCustodianCheckOutput(raw, CUSTODIANS);
    expect('verdicts' in result).toBe(true);
    if ('verdicts' in result) {
      expect(result.verdicts[0].verdict).toBe('tension');
      expect(result.verdicts[0].cited).toBeTruthy();
      expect(result.verdicts[0].citation_unverified).toBeUndefined();
    }
  });

  it('returns verdicts for a conflict response with verbatim citation', () => {
    const raw = JSON.stringify({
      verdicts: [{ soul: 'skeptic.institutional', verdict: 'conflict', cited: 'Never advocate abolition of existing regulatory bodies', reason: 'Proposes abolishing the existing framework.' }],
    });
    const result = parseCustodianCheckOutput(raw, CUSTODIANS);
    expect('verdicts' in result).toBe(true);
    if ('verdicts' in result) {
      expect(result.verdicts[0].verdict).toBe('conflict');
      expect(result.verdicts[0].cited).toBeTruthy();
    }
  });

  it('conflict — lightly reformatted citation (surrounding quotes stripped) passes', () => {
    const raw = JSON.stringify({
      verdicts: [{ soul: 'skeptic.institutional', verdict: 'conflict', cited: '"Never advocate abolition of existing regulatory bodies"', reason: 'Proposes abolishing the existing framework.' }],
    });
    const result = parseCustodianCheckOutput(raw, CUSTODIANS);
    expect('verdicts' in result).toBe(true);
  });

  it('unchecked — conflict verdict with invented citation', () => {
    const raw = JSON.stringify({
      verdicts: [{ soul: 'skeptic.institutional', verdict: 'conflict', cited: 'Models must be open-sourced before deployment to the public', reason: 'Made-up boundary.' }],
    });
    const result = parseCustodianCheckOutput(raw, CUSTODIANS);
    expect('unchecked' in result).toBe(true);
    if ('unchecked' in result) expect(result.unchecked).toContain('unverifiable citation');
  });

  it('tension — unverified citation yields citation_unverified flag, not unchecked', () => {
    const raw = JSON.stringify({
      verdicts: [{ soul: 'skeptic.institutional', verdict: 'tension', cited: 'Models must be open-sourced before deployment to the public', reason: 'Invented.' }],
    });
    const result = parseCustodianCheckOutput(raw, CUSTODIANS);
    expect('verdicts' in result).toBe(true);
    if ('verdicts' in result) {
      expect(result.verdicts[0].verdict).toBe('tension');
      expect(result.verdicts[0].cited).toBeNull();
      expect(result.verdicts[0].citation_unverified).toBe(true);
    }
  });

  it('unchecked — missing verdict for a custodian', () => {
    const raw = JSON.stringify({ verdicts: [] }); // skeptic.institutional verdict absent
    const result = parseCustodianCheckOutput(raw, CUSTODIANS);
    expect('unchecked' in result).toBe(true);
    if ('unchecked' in result) expect(result.unchecked).toContain('skeptic.institutional');
  });

  it('unchecked — invalid verdict value', () => {
    const raw = JSON.stringify({
      verdicts: [{ soul: 'skeptic.institutional', verdict: 'maybe', cited: null, reason: '.' }],
    });
    const result = parseCustodianCheckOutput(raw, CUSTODIANS);
    expect('unchecked' in result).toBe(true);
    if ('unchecked' in result) expect(result.unchecked).toContain('maybe');
  });

  it('unchecked — conflict verdict with no citation (null)', () => {
    const raw = JSON.stringify({
      verdicts: [{ soul: 'skeptic.institutional', verdict: 'conflict', cited: null, reason: 'Breaks a boundary.' }],
    });
    const result = parseCustodianCheckOutput(raw, CUSTODIANS);
    expect('unchecked' in result).toBe(true);
    if ('unchecked' in result) expect(result.unchecked).toContain('citation');
  });

  it('unchecked — conflict verdict with empty string citation', () => {
    const raw = JSON.stringify({
      verdicts: [{ soul: 'skeptic.institutional', verdict: 'conflict', cited: '', reason: 'Breaks a boundary.' }],
    });
    const result = parseCustodianCheckOutput(raw, CUSTODIANS);
    expect('unchecked' in result).toBe(true);
  });

  it('unchecked — unparseable JSON', () => {
    const result = parseCustodianCheckOutput('not json at all', CUSTODIANS);
    expect('unchecked' in result).toBe(true);
    if ('unchecked' in result) expect(result.unchecked).toContain('JSON');
  });

  it('item 3: duplicate soul rows with conflicting verdicts → unchecked', () => {
    const raw = JSON.stringify({
      verdicts: [
        { soul: 'skeptic.institutional', verdict: 'consistent', cited: null, reason: 'First row.' },
        { soul: 'skeptic.institutional', verdict: 'conflict', cited: 'Never advocate abolition of existing regulatory bodies', reason: 'Second row contradicts first.' },
      ],
    });
    const result = parseCustodianCheckOutput(raw, CUSTODIANS);
    expect('unchecked' in result).toBe(true);
    if ('unchecked' in result) expect(result.unchecked).toContain('duplicate');
  });

  it('item 3: duplicate soul rows with same verdict → accepted (last-wins)', () => {
    const raw = JSON.stringify({
      verdicts: [
        { soul: 'skeptic.institutional', verdict: 'consistent', cited: null, reason: 'First row.' },
        { soul: 'skeptic.institutional', verdict: 'consistent', cited: null, reason: 'Duplicate same verdict.' },
      ],
    });
    const result = parseCustodianCheckOutput(raw, CUSTODIANS);
    expect('verdicts' in result).toBe(true);
  });
});
