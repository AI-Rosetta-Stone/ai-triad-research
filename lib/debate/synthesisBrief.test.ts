// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect } from 'vitest';
import { synthesisBrief, hasStructuredSynthesis } from './synthesisBrief.js';
import { debateToMarkdown, debateToText, debateToHtml, type ExportableDebateSession } from './debateExport.js';

const DEBATERS = ['accelerationist', 'safetyist', 'skeptic'];

const synth = () => ({
  topic_resolution: {
    restated_question: 'Should frontier AI development pause for six months?',
    where_it_landed: 'The camps agree on audits. They split on enforcement. The pause itself is contested. A fourth sentence.',
    what_would_resolve_it: 'Evidence that audits change lab behaviour.',
  },
  areas_of_agreement: [{ point: 'Audits help', povers: ['safetyist', 'skeptic'] }, { point: 'Evidence is thin', povers: DEBATERS }],
  areas_of_disagreement: [
    { id: 'd1', point: 'Whether a pause shifts incentives', type: 'VALUES', bdi_layer: 'desire', decisive: true,
      positions: [{ pover: 'safetyist', stance: 'It buys time.' }, { pover: 'skeptic', stance: 'It cedes ground.' }] },
    { id: 'd2', point: 'Whether audits can be enforced', type: 'EMPIRICAL', bdi_layer: 'belief', resolvability: 'resolvable_by_evidence', positions: [] },
    { id: 'd3', point: 'What counts as a frontier model', type: 'DEFINITIONAL', positions: [] },
  ],
  preferences: [
    { conflict: 'Whether a pause shifts incentives', disagreement_id: 'd1', prevails: 'undecidable', criterion: 'scope', rationale: 'Both have a case.' },
    { conflict: 'Whether audits can be enforced', disagreement_id: 'd2', prevails: 'C2', criterion: 'empirical_evidence', rationale: 'Better cited.', what_would_change_this: 'A failed audit.' },
    { conflict: 'A conflict that matches nothing at all', prevails: 'C1', criterion: 'mystery_code', rationale: 'x' },
  ],
  argument_map: [{ claim_id: 'C1', claim: 'a', claimant: 'accelerationist' }, { claim_id: 'C2', claim: 'b', claimant: 'skeptic' }],
  cruxes: [{ question: 'Does a pause slow rivals too?', type: 'EMPIRICAL', if_yes: 'The skeptic concedes.', if_no: 'The safetyist concedes.' }],
  unresolved_questions: ['Who pays?', 'Who audits?', 'When?'],
  unresolved_question_themes: ['Funding', 'Funding', ''],
});

const at = (md: string, heading: string) => md.indexOf(heading);

describe('synthesisBrief (t/810)', () => {
  const md = synthesisBrief(synth(), { debaters: DEBATERS }).join('\n');

  it("has the panel's sections in the panel's order", () => {
    const order = ['Motion:', '### Bottom line', '### Next moves', '### Common ground', '### Disputes', '### Cruxes', '### Open questions', 'Synthesis of the full debate transcript.'].map(h => at(md, h));
    expect(order.every(i => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('puts each dispute once with its verdict and the model-assessment label', () => {
    for (const n of ['D1', 'D2', 'D3', 'D4']) expect(md.split(`**${n}`).length - 1).toBe(1);
    expect(md).toContain("Verdict**: Unresolved (model's assessment)");
    expect(md).toContain("Verdict**: Skeptic stronger (model's assessment). Why: the Skeptic's argument cited more or better evidence.");
    expect(md).toContain('Which camp made the stronger case');
    expect(md).toContain('D3: no verdict');
  });

  it('keeps a preference that matches no dispute as its own entry, with no type', () => {
    expect(md).toContain('**D4**\n\nA conflict that matches nothing at all');
    expect(md).toContain('Accelerationist stronger');
    expect(md).toContain('Why: mystery_code');
  });

  it('shows no raw tags or ids', () => {
    expect(md).not.toMatch(/\[(EMPIRICAL|VALUES|DEFINITIONAL)\]|\{(belief|desire|intention)\}|d[123]-/);
    expect(md).toContain('**D1 · Values · about what matters more**');
    expect(md).toContain("**D2 · Empirical · about what's true**");
  });

  it('writes next moves and what settles each from the rule table', () => {
    expect(md).toContain('Definitional → Clearer terms (D3)');
    expect(md).toContain('**Find a way to measure it** (Bears on D2)');
    expect(md).toContain('**Name the trade-off** (Answers D1)');
  });

  it('keeps each crux if-yes and if-no as nested lines', () => {
    expect(md).toContain('- **C1** (Empirical) Does a pause slow rivals too?\n  - **If yes:** The skeptic concedes.\n  - **If no:** The safetyist concedes.');
  });

  it('two cruxes with identical text each keep their own if-yes/if-no (t/822)', () => {
    const twin = { ...synth(), cruxes: [
      { question: 'Same question?', type: 'EMPIRICAL', if_yes: 'first yes', if_no: 'first no' },
      { question: 'Same question?', type: 'VALUES', if_yes: 'second yes', if_no: 'second no' },
    ] };
    const out = synthesisBrief(twin, { debaters: DEBATERS }).join('\n');
    expect(out).toContain('**C1** (Empirical) Same question?\n  - **If yes:** first yes\n  - **If no:** first no');
    expect(out).toContain('**C2** (Values) Same question?\n  - **If yes:** second yes\n  - **If no:** second no');
  });

  it('nests the full dispute under its next move, not as a sibling bullet', () => {
    const long = { areas_of_disagreement: [{ point: 'Whether a six-month pause and mandatory compliance thresholds effectively shift research incentives toward safety without ceding advantage', type: 'VALUES', positions: [] }] };
    const out = synthesisBrief(long, { debaters: DEBATERS }).join('\n');
    expect(out).toMatch(/\n- \*\*Name the trade-off[^\n]*\n  - \*The dispute in full:\*/);
  });

  it('groups open questions by theme only when a theme covers 2+ questions', () => {
    expect(md).toContain('**Funding**\n\n- Who pays?\n- Who audits?');
    const flat = synthesisBrief({ ...synth(), unresolved_question_themes: ['A', 'B', 'C'] }, { debaters: DEBATERS }).join('\n');
    expect(flat).not.toContain('**A**');
    expect(flat).toContain('- Who pays?');
  });

  it('works on an old synthesis: no ids, no themes, no where_it_landed, string-only lists', () => {
    const old = {
      areas_of_agreement: [{ point: 'P', povers: ['skeptic'] }],
      areas_of_disagreement: [{ point: 'Old dispute', positions: [] }],
      preferences: [{ conflict: 'Old dispute', prevails: 'undecidable', criterion: 'scope', rationale: 'r' }],
      unresolved_questions: ['Old question?'],
    };
    const out = synthesisBrief(old, { debaters: DEBATERS, topic: 'The topic' }).join('\n');
    expect(out).toContain('Motion:** The topic');
    expect(out).toContain('The camps stated a stronger case on 0 of 1 disputes');
    expect(out).toContain("Verdict**: Unresolved (model's assessment)");
    expect(out).not.toContain('Next moves');
    expect(out).not.toContain('### Cruxes');
  });

  it('omits empty sections and their headings', () => {
    const out = synthesisBrief({ areas_of_agreement: [{ point: 'Only this', povers: [] }] }, { debaters: DEBATERS }).join('\n');
    expect(out).toContain('### Common ground');
    for (const h of ['Bottom line', 'Next moves', 'Disputes', 'Cruxes', 'Open questions']) expect(out).not.toContain(h);
  });

  it('renders plain text with no markup', () => {
    const txt = synthesisBrief(synth(), { debaters: DEBATERS }, { format: 'text' }).join('\n');
    expect(txt).toContain('BOTTOM LINE');
    expect(txt).not.toMatch(/\*\*|^#/m);
  });

  it('does not rank by camp: swapping camp labels changes no section order', () => {
    const swapped = JSON.parse(JSON.stringify(synth()).replace(/accelerationist/g, 'TMP').replace(/skeptic/g, 'accelerationist').replace(/TMP/g, 'skeptic'));
    const heads = (s: string) => s.split('\n').filter(l => l.startsWith('### '));
    expect(heads(synthesisBrief(swapped, { debaters: DEBATERS }).join('\n'))).toEqual(heads(md));
  });
});

describe('hasStructuredSynthesis', () => {
  it('is true for any known list or paragraph, false for nothing', () => {
    expect(hasStructuredSynthesis(synth())).toBe(true);
    expect(hasStructuredSynthesis({})).toBe(false);
    expect(hasStructuredSynthesis(undefined)).toBe(false);
    expect(hasStructuredSynthesis([])).toBe(false);
  });
});

function session(meta: Record<string, unknown> | undefined): ExportableDebateSession {
  return {
    id: 'x', title: 'T', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', phase: 'complete',
    topic: { original: 'o', final: 'The final topic' }, active_povers: DEBATERS, user_is_pover: false,
    transcript: [
      { id: '1', timestamp: '2026-01-01T00:00:00Z', speaker: 'skeptic', type: 'opening', content: 'Opening text', taxonomy_refs: [] },
      { id: '2', timestamp: '2026-01-01T00:01:00Z', speaker: 'system', type: 'concluding', content: 'OLD STORED CONTENT', taxonomy_refs: [], ...(meta ? { metadata: meta } : {}) },
    ],
  } as ExportableDebateSession;
}

describe('exports render the brief (t/810)', () => {
  it("labels the engine's concluding entry Synthesis, not the raw type", () => {
    expect(debateToMarkdown(session({ synthesis: synth() }))).toContain('### Synthesis');
    expect(debateToMarkdown(session(undefined))).not.toContain('### concluding');
  });

  it('markdown, text and html (PDF) use the brief when the synthesis entry is structured', () => {
    const s = session({ synthesis: synth() });
    const md = debateToMarkdown(s);
    expect(md).toContain('#### Bottom line');
    expect(md).toContain("Verdict**: Unresolved (model's assessment)");
    expect(md).not.toContain('OLD STORED CONTENT');
    expect(debateToText(s)).toContain('BOTTOM LINE');
    expect(debateToHtml(s)).toContain('<h4>Bottom line</h4>');
  });

  it('an old synthesis entry with no structured data exports its stored content, as before', () => {
    for (const s of [session(undefined), session({}), session({ synthesis: {} })]) {
      expect(debateToMarkdown(s)).toContain('OLD STORED CONTENT');
      expect(debateToText(s)).toContain('OLD STORED CONTENT');
    }
  });
});
