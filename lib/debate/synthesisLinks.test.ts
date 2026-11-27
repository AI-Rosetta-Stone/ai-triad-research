// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi } from 'vitest';
import { assignDisagreementIds, linkPreferencesToDisagreements, splitUnresolvedQuestions } from './synthesisLinks.js';
import { prepareSynthesisLists } from './synthesisOrder.js';

const dis = (point: string, extra: Record<string, unknown> = {}) => ({ point, positions: [], ...extra });

describe('assignDisagreementIds (t/808)', () => {
  it('assigns d1..dn in model order', () => {
    const ds = [dis('a'), dis('b'), dis('c')];
    expect(assignDisagreementIds(ds)).toBe(3);
    expect(ds.map(d => (d as { id: string }).id)).toEqual(['d1', 'd2', 'd3']);
  });

  it('keeps a valid unique id, replaces blank/duplicate/non-string ones without colliding', () => {
    const ds = [dis('a', { id: 'x' }), dis('b', { id: 'x' }), dis('c', { id: '' }), dis('d', { id: 7 }), dis('e')];
    expect(assignDisagreementIds(ds)).toBe(4);
    const ids = ds.map(d => (d as { id: string }).id);
    expect(ids[0]).toBe('x');
    expect(new Set(ids).size).toBe(5);
    expect(ids.every(i => typeof i === 'string' && i !== '')).toBe(true);
  });

  it('survives ordering: the id stays on its item when decisive moves it first', () => {
    const data = { areas_of_disagreement: [dis('first'), dis('second', { decisive: true })] } as Record<string, unknown>;
    assignDisagreementIds(data.areas_of_disagreement);
    const ordered = prepareSynthesisLists(data).areas_of_disagreement as { id: string; point: string }[];
    expect(ordered.map(d => [d.point, d.id])).toEqual([['second', 'd2'], ['first', 'd1']]);
  });

  it('ignores a missing or non-array list', () => {
    expect(assignDisagreementIds(undefined)).toBe(0);
    expect(assignDisagreementIds('nope')).toBe(0);
  });
});

describe('linkPreferencesToDisagreements (t/808)', () => {
  const ds = () => {
    const x = [
      dis('Whether open-weight release raises the risk of misuse more than it speeds up defence'),
      dis('Who should bear liability when a deployed model causes harm'),
    ];
    assignDisagreementIds(x);
    return x;
  };

  it('keeps a model-given id that exists, with no WARN', () => {
    const warn = vi.fn();
    const prefs = [{ conflict: 'anything', disagreement_id: 'd2' }];
    const c = linkPreferencesToDisagreements(prefs, ds(), warn);
    expect(prefs[0].disagreement_id).toBe('d2');
    expect(c).toEqual({ total: 1, kept: 1, matched: 0, unmatched: 0 });
    expect(warn).not.toHaveBeenCalled();
  });

  it('falls back to a text match when the id is missing or unknown, and WARNs once with the counts', () => {
    const warn = vi.fn();
    const prefs = [
      { conflict: 'Who should bear liability when a deployed model causes harm.' },
      { conflict: 'open-weight release misuse risk vs defence speed', disagreement_id: 'd9' },
      { conflict: 'Whether open-weight release raises the risk of misuse more than it speeds up defence' },
    ];
    const c = linkPreferencesToDisagreements(prefs, ds(), warn);
    expect(prefs.map(p => (p as { disagreement_id?: string }).disagreement_id)).toEqual(['d2', undefined, 'd1']);
    expect(c).toEqual({ total: 3, kept: 0, matched: 2, unmatched: 1 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toContain('3 preferences');
  });

  it('never drops an unmatched preference and removes an unknown id', () => {
    const prefs = [{ conflict: 'something unrelated entirely', disagreement_id: 'zzz', prevails: 'undecidable' }];
    linkPreferencesToDisagreements(prefs, ds());
    expect(prefs).toHaveLength(1);
    expect('disagreement_id' in prefs[0]).toBe(false);
  });

  it('does not guess between two equally close disagreements', () => {
    const x = [dis('liability for model harm'), dis('liability for model misuse')];
    assignDisagreementIds(x);
    const prefs = [{ conflict: 'liability for model' }];
    linkPreferencesToDisagreements(prefs, x);
    expect('disagreement_id' in prefs[0]).toBe(false);
  });

  it('two disagreements with identical points: a preference with that text stays unlinked, not linked to the first (t/822)', () => {
    const x = [dis('Who should bear liability when a deployed model causes harm'), dis('Who should bear liability when a deployed model causes harm')];
    assignDisagreementIds(x);
    const prefs = [{ conflict: 'Who should bear liability when a deployed model causes harm' }];
    linkPreferencesToDisagreements(prefs, x);
    expect('disagreement_id' in prefs[0]).toBe(false);
    // but a model-given id still picks the right one of the twins
    const given = [{ conflict: 'Who should bear liability when a deployed model causes harm', disagreement_id: 'd2' }];
    linkPreferencesToDisagreements(given, x);
    expect(given[0].disagreement_id).toBe('d2');
  });

  it('handles an old debate with no ids, no preferences, or malformed entries', () => {
    expect(linkPreferencesToDisagreements(undefined, undefined)).toEqual({ total: 0, kept: 0, matched: 0, unmatched: 0 });
    const prefs = [null, 'x', { conflict: 5 }] as unknown[];
    expect(linkPreferencesToDisagreements(prefs, [dis('no id here')]).total).toBe(1);
  });
});

describe('splitUnresolvedQuestions (t/808)', () => {
  it('splits {question, theme} into string[] plus a parallel themes array', () => {
    const data: Record<string, unknown> = {
      unresolved_questions: [{ question: 'Q1', theme: ' Funding ' }, { question: 'Q2' }, 'Q3'],
    };
    expect(splitUnresolvedQuestions(data)).toBe(1);
    expect(data.unresolved_questions).toEqual(['Q1', 'Q2', 'Q3']);
    expect(data.unresolved_question_themes).toEqual(['Funding', '', '']);
  });

  it('leaves a plain string[] untouched and adds no themes key (old shape, old debates)', () => {
    const data: Record<string, unknown> = { unresolved_questions: ['a', 'b'] };
    expect(splitUnresolvedQuestions(data)).toBe(0);
    expect(data.unresolved_questions).toEqual(['a', 'b']);
    expect('unresolved_question_themes' in data).toBe(false);
  });

  it('keeps an entry in neither shape, with no theme, rather than dropping it', () => {
    const data: Record<string, unknown> = { unresolved_questions: [{ text: 'odd' }, { question: 'Q', theme: 'T' }] };
    splitUnresolvedQuestions(data);
    expect(data.unresolved_questions).toEqual([{ text: 'odd' }, 'Q']);
    expect(data.unresolved_question_themes).toEqual(['', 'T']);
  });

  it('is a no-op when the list is absent', () => {
    const data: Record<string, unknown> = {};
    expect(splitUnresolvedQuestions(data)).toBe(0);
    expect(data).toEqual({});
  });
});
