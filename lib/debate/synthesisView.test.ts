// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect } from 'vitest';
import { buildSynthesisView, termOf, matchPointIndex } from './synthesisView.js';

const CAMPS = ['accelerationist', 'safetyist', 'skeptic'];

const argumentMap = [
  { claim_id: 'C1', claimant: 'accelerationist', attacked_by: [{ claim_id: 'C2', claimant: 'safetyist' }] },
  { claim_id: 'C3', claimant: 'skeptic' },
];

function dis(point: string, extra: Record<string, unknown> = {}) {
  return { point, type: 'EMPIRICAL', bdi_layer: 'belief', positions: [{ pover: 'safetyist', stance: 'yes' }], ...extra };
}
function pref(conflict: string, prevails: string, extra: Record<string, unknown> = {}) {
  return { conflict, prevails, criterion: 'specificity', rationale: 'because', ...extra };
}

describe('buildSynthesisView', () => {
  it('all resolved: each dispute carries its camp verdict and the strip counts match', () => {
    const v = buildSynthesisView({
      debaters: CAMPS,
      synthesis: {
        argument_map: argumentMap,
        areas_of_disagreement: [dis('Does a pause work?'), dis('Is compliance affordable?', { type: 'VALUES' })],
        preferences: [pref('Does a pause work?', 'C3'), pref('Is compliance affordable?', 'C2')],
      },
    });
    expect(v.disputes.map(d => [d.n, d.verdict.kind, d.verdict.camp?.id])).toEqual([
      ['D1', 'camp', 'skeptic'], ['D2', 'camp', 'safetyist'],
    ]);
    expect(Object.fromEntries(v.strip!.legend.map(l => [l.key, l.count]))).toEqual({
      accelerationist: 0, safetyist: 1, skeptic: 1, unresolved: 0,
    });
    expect(v.strip!.ariaLabel).toBe('D1: Skeptic stronger. D2: Safetyist stronger.');
    expect(v.disputes[0].why).toBe("Why: the Skeptic's argument was more specific and testable.");
  });

  it('all unresolved: undecidable verdicts are Unresolved with no why line', () => {
    const v = buildSynthesisView({
      debaters: CAMPS,
      synthesis: {
        areas_of_disagreement: [dis('A?'), dis('B?')],
        preferences: [pref('A?', 'undecidable'), pref('B?', 'undecidable')],
      },
    });
    expect(v.strip!.segments.every(s => s.outcome === 'unresolved')).toBe(true);
    expect(v.strip!.legend.find(l => l.key === 'unresolved')!.count).toBe(2);
    expect(v.disputes.every(d => d.why === null)).toBe(true);
    expect(v.bottomLine.paragraph).toBe('The camps stated a stronger case on 0 of 2 disputes; 2 are unresolved.');
  });

  it('two debaters: the camp that is not present is not listed; three debaters list a camp with 0 wins', () => {
    const synthesis = { areas_of_disagreement: [dis('A?')], preferences: [pref('A?', 'C1')], argument_map: argumentMap };
    const two = buildSynthesisView({ debaters: ['accelerationist', 'safetyist'], synthesis });
    expect(two.strip!.legend.map(l => l.key)).toEqual(['accelerationist', 'safetyist', 'unresolved']);
    const three = buildSynthesisView({ debaters: CAMPS, synthesis });
    expect(three.strip!.legend.map(l => [l.key, l.count])).toEqual([
      ['accelerationist', 1], ['safetyist', 0], ['skeptic', 0], ['unresolved', 0],
    ]);
  });

  it('an unknown type and criterion show their raw value; the type keeps its raw tag', () => {
    const v = buildSynthesisView({
      debaters: CAMPS,
      synthesis: {
        argument_map: argumentMap,
        areas_of_disagreement: [dis('A?', { type: 'MYSTERY' })],
        preferences: [pref('A?', 'C3', { criterion: 'vibes' })],
      },
    });
    expect(v.disputes[0].type).toMatchObject({ label: 'MYSTERY', raw: 'MYSTERY', known: false });
    expect(v.disputes[0].why).toBe('Why: vibes');
    expect(v.nextMoves).toEqual([]);
  });

  it('translates bdi_layer, and leaves an unknown layer out', () => {
    const v = buildSynthesisView({
      debaters: CAMPS,
      synthesis: { areas_of_disagreement: [dis('A?', { bdi_layer: 'desire' }), dis('B?', { bdi_layer: 'weird' })] },
    });
    expect(v.disputes.map(d => d.about)).toEqual(['about what matters more', null]);
  });

  it('empty sections are omitted, along with their nav links', () => {
    const v = buildSynthesisView({ debaters: CAMPS, synthesis: { cruxes: [{ question: 'Q?', type: 'VALUES' }] }, topic: 'T' });
    expect(v.nav).toEqual([{ key: 'cruxes', label: 'Cruxes', count: 1 }]);
    expect(v.strip).toBeNull();
    expect(v.title).toBe('T');
    expect(v.bottomLine.paragraph).toBeNull();
  });

  it('a preference matching no disagreement becomes its own card, never dropped', () => {
    const v = buildSynthesisView({
      debaters: CAMPS,
      synthesis: {
        argument_map: argumentMap,
        areas_of_disagreement: [dis('Does a pause work?')],
        preferences: [pref('Does a pause work?', 'C3'), pref('Totally different matter entirely', 'C1')],
      },
    });
    expect(v.disputes).toHaveLength(2);
    expect(v.disputes[1]).toMatchObject({ n: 'D2', unmatched: true, type: null, point: 'Totally different matter entirely' });
    expect(v.disputes[1].verdict.camp?.id).toBe('accelerationist');
  });

  it('old debate without ids: joins by normalised text; a dispute with no preference has no verdict', () => {
    const v = buildSynthesisView({
      debaters: CAMPS,
      synthesis: {
        argument_map: argumentMap,
        areas_of_disagreement: [dis('Whether a pause, works!'), dis('Unmatched dispute')],
        preferences: [pref('whether a pause works', 'C3')],
      },
    });
    expect(v.disputes[0].verdict.camp?.id).toBe('skeptic');
    expect(v.disputes[1].verdict.kind).toBe('none');
    expect(v.strip!.segments[1]).toMatchObject({ outcome: 'unresolved', noVerdict: true });
    expect(v.strip!.legend.find(l => l.key === 'none')!.count).toBe(1);
    expect(v.bottomLine.paragraph).toBe('The camps stated a stronger case on 1 of 2 disputes; 1 has no verdict.');
  });

  it('ids win over text: disagreement_id joins even when the wording differs', () => {
    const v = buildSynthesisView({
      debaters: CAMPS,
      synthesis: {
        argument_map: argumentMap,
        areas_of_disagreement: [dis('First wording', { id: 'dis-1' }), dis('Second wording', { id: 'dis-2' })],
        preferences: [pref('Second wording', 'C3', { disagreement_id: 'dis-1' })],
      },
    });
    expect(v.disputes[0].verdict.camp?.id).toBe('skeptic');
    expect(v.disputes[1].verdict.kind).toBe('none');
  });

  it('a verdict that names the camp directly resolves; an unreadable value stays Unresolved with the raw text', () => {
    const v = buildSynthesisView({
      debaters: CAMPS,
      synthesis: {
        areas_of_disagreement: [dis('A?'), dis('B?')],
        preferences: [pref('A?', 'Skeptic'), pref('B?', 'C9')],
      },
    });
    expect(v.disputes[0].verdict.camp?.id).toBe('skeptic');
    expect(v.disputes[1].verdict).toEqual({ kind: 'unresolved', raw: 'C9' });
  });

  it('pending: every segment is Unresolved and the heading says Verdicts pending', () => {
    const v = buildSynthesisView({
      debaters: CAMPS, pending: true,
      synthesis: { argument_map: argumentMap, areas_of_disagreement: [dis('A?')], preferences: [pref('A?', 'C3')] },
    });
    expect(v.strip!.heading).toBe('Verdicts pending');
    expect(v.strip!.segments[0].outcome).toBe('unresolved');
  });

  it('bottom line: where_it_landed is capped at 3 sentences with the rest behind Read more', () => {
    const v = buildSynthesisView({
      debaters: CAMPS,
      synthesis: { topic_resolution: { where_it_landed: 'One. Two. Three. Four.', what_would_resolve_it: 'X' } },
    });
    expect(v.bottomLine.paragraph).toBe('One. Two. Three.');
    expect(v.bottomLine.more).toBe('Four.');
    expect(v.bottomLine.fromTemplate).toBe(false);
    expect(v.bottomLine.decisiveCrux).toBe('X');
  });

  it('next moves come from the rule table, cheapest first, with no trade-off card without a Values dispute', () => {
    const v = buildSynthesisView({
      debaters: CAMPS,
      synthesis: {
        areas_of_disagreement: [
          dis('Does compliance cost crush open source developers in practice today', { type: 'EMPIRICAL' }),
          dis('What counts as frontier', { type: 'DEFINITIONAL', resolvability: 'resolvable_by_clarification' }),
          dis('Another measurable thing', { type: 'EMPIRICAL' }),
        ],
      },
    });
    expect(v.nextMoves.map(m => [m.kind, m.title, m.chip])).toEqual([
      ['definitional', 'Define what counts as frontier', 'Settles D2'],
      ['empirical', 'Find a way to measure does compliance cost crush open source developers', 'Bears on D1, D3'],
    ]);
    expect(v.nextMoves[0].body).toBe('resolvable by clarification');
    expect(v.nextMoves[0].context).toBeNull();
    expect(v.nextMoves[1].context).toBe('Does compliance cost crush open source developers in practice today');
    expect(v.bottomLine.settle.map(r => [r.type, r.action, r.ids])).toEqual([
      ['Definitional', 'Clearer terms', ['D2']], ['Empirical', 'New evidence', ['D1', 'D3']],
    ]);
  });

  it('keeps the engine order: swapping camp labels does not change the list order (t/769)', () => {
    const mk = (a: string, b: string) => buildSynthesisView({
      debaters: CAMPS,
      synthesis: { areas_of_agreement: [{ point: 'one', povers: [a] }, { point: 'two', povers: [b] }] },
    }).agreements.items;
    expect(mk('skeptic', 'safetyist')).toEqual(['one', 'two']);
    expect(mk('safetyist', 'skeptic')).toEqual(['one', 'two']);
  });

  it('an unreadable agreements list keeps its section and nav entry (t/774)', () => {
    const v = buildSynthesisView({ debaters: CAMPS, synthesis: { unreadable_lists: ['areas_of_agreement'] } });
    expect(v.agreements).toEqual({ items: [], unreadable: true });
    expect(v.nav[0]).toMatchObject({ key: 'common-ground', count: 0 });
  });

  it('survives a missing or malformed synthesis', () => {
    expect(buildSynthesisView({ debaters: CAMPS, synthesis: undefined }).nav).toEqual([]);
    expect(buildSynthesisView({ debaters: CAMPS, synthesis: { areas_of_disagreement: 'x', preferences: [null, 3] } }).disputes).toEqual([]);
  });

  it('numbers cruxes C1..Cn and open questions Q1..Qn, flat', () => {
    const v = buildSynthesisView({
      debaters: CAMPS,
      synthesis: { cruxes: [{ question: 'a?' }, { question: 'b?', type: 'Empirical' }], unresolved_questions: ['x', 'y'] },
    });
    expect(v.cruxes.map(c => [c.n, c.typeLabel])).toEqual([['C1', null], ['C2', 'Empirical']]);
    expect(v.openQuestions.map(q => q.id)).toEqual(['Q1', 'Q2']);
  });
});

describe('helpers', () => {
  it('termOf drops a trailing -ly word, but only when the title was already cut (t/822)', () => {
    expect(termOf('Whether a six-month pause and mandatory compliance thresholds effectively shift research incentives'))
      .toEqual({ term: 'a six-month pause and mandatory compliance thresholds', lost: true });
    // not cut: nothing is trimmed, even a word that looks like an adverb
    expect(termOf('Whether supply')).toEqual({ term: 'supply', lost: false });
    expect(termOf('Whether it works effectively')).toEqual({ term: 'it works effectively', lost: false });
    // cut, ending in a -ly noun: kept
    expect(termOf('Whether labs and firms and the whole larger family dispute pricing'))
      .toEqual({ term: 'labs and firms and the whole larger family', lost: true });
    // cut, ending in a -ly word shorter than 6 letters: kept
    expect(termOf('Whether labs and firms and the whole larger only dispute pricing'))
      .toEqual({ term: 'labs and firms and the whole larger only', lost: true });
  });

  it('termOf drops a leading Whether, lower-cases, cuts at a clause boundary and never adds an ellipsis', () => {
    expect(termOf('Whether protocol-level verification standards and insurance solvency floors can be enforced without entrenching industry monopolies.'))
      .toEqual({ term: 'protocol-level verification standards and insurance solvency floors', lost: true });
    expect(termOf('Whether a pause works, and who pays for it afterwards')).toEqual({ term: 'a pause works', lost: true });
    expect(termOf('Short one?')).toEqual({ term: 'short one', lost: false });
    expect(termOf('What counts as frontier')).toEqual({ term: 'what counts as frontier', lost: false });
    expect(termOf('Whether AI labs disclose compute use')).toEqual({ term: 'AI labs disclose compute use', lost: false });
  });
  it('matchPointIndex tolerates punctuation and case, never guesses between candidates', () => {
    expect(matchPointIndex('Is X fair?', ['is x fair', 'something else entirely'])).toBe(0);
    expect(matchPointIndex('apples and oranges', ['quantum chromodynamics'])).toBe(-1);
    // two identical points: the exact step must not pick the first
    expect(matchPointIndex('Who should bear liability for harm', ['Who should bear liability for harm', 'Who should bear liability for harm'])).toBe(-1);
    // a short conflict that is a substring of a longer point is not a match
    expect(matchPointIndex('audits', ['Whether audits can be enforced without entrenching incumbents'])).toBe(-1);
    // two equally close points: no match
    expect(matchPointIndex('liability for model', ['liability for model harm', 'liability for model misuse'])).toBe(-1);
  });

  it('matchPointIndex word-overlap boundary: exactly 0.5 matches, just under does not (t/822)', () => {
    // 2 shared of 4 distinct words = 0.5, and the texts are too short for the containment step
    expect(matchPointIndex('ab cd', ['ab cd ef gh'])).toBe(0);
    // 2 shared of 5 distinct words = 0.4
    expect(matchPointIndex('ab cd', ['ab cd ef gh ij'])).toBe(-1);
  });

  it('an unlinked preference stays unlinked: it gets its own card, never a dispute it only loosely resembles', () => {
    const v = buildSynthesisView({
      debaters: ['skeptic'],
      synthesis: {
        areas_of_disagreement: [
          { point: 'Whether audits can be enforced without entrenching incumbents', type: 'EMPIRICAL', positions: [] },
          { point: 'Whether a pause shifts research incentives toward safety', type: 'VALUES', positions: [] },
        ],
        preferences: [{ conflict: 'audits', prevails: 'undecidable', criterion: 'scope', rationale: 'r' }],
      },
    });
    expect(v.disputes.map(d => [d.n, d.verdict.kind, d.unmatched])).toEqual([['D1', 'none', false], ['D2', 'none', false], ['D3', 'unresolved', true]]);
  });

});

describe('open question grouping (spec §8, Design p/14#151)', () => {
  const qs = ['q1', 'q2', 'q3', 'q4'];
  const groups = (themes: unknown) => buildSynthesisView({
    debaters: CAMPS, synthesis: { unresolved_questions: qs, unresolved_question_themes: themes },
  }).openQuestionGroups.map(g => [g.theme, g.questions.map(q => q.id)]);

  it('groups by theme when at least one theme covers 2+ questions; no theme goes in a final untitled list', () => {
    expect(groups(['Funding', '', 'Funding', 'Staff'])).toEqual([
      ['Funding', ['Q1', 'Q3']], ['Staff', ['Q4']], [null, ['Q2']],
    ]);
  });

  it('renders one flat list when every question has its own theme (guards against per-question labels)', () => {
    expect(groups(['A', 'B', 'C', 'D'])).toEqual([[null, ['Q1', 'Q2', 'Q3', 'Q4']]]);
  });

  it('renders one flat list with no themes, or when the themes field is absent or malformed', () => {
    expect(groups(['', '', '', ''])).toEqual([[null, ['Q1', 'Q2', 'Q3', 'Q4']]]);
    expect(groups(undefined)).toEqual([[null, ['Q1', 'Q2', 'Q3', 'Q4']]]);
    expect(groups('nope')).toEqual([[null, ['Q1', 'Q2', 'Q3', 'Q4']]]);
  });

  it('has no groups without questions', () => {
    expect(buildSynthesisView({ debaters: CAMPS, synthesis: {} }).openQuestionGroups).toEqual([]);
  });
});
