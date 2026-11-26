// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/783 (amends t/701 §8): the 2 newest DEBATER statements start open; a fact check or moderator
// row starts collapsed unless it is the newest turn of all.

import { describe, it, expect } from 'vitest';
import { collapsedByDefault, turnsOf } from './turnCollapse';

/** A transcript from a type list: ids are the 1-based positions, `e1`, `e2`, … */
const tr = (...types: string[]) => types.map((type, i) => ({ id: `e${i + 1}`, type }));
const collapsed = (types: string[]): string[] => {
  const turns = turnsOf(tr(...types));
  return turns.filter(t => collapsedByDefault(turns, t.id)).map(t => t.id);
};

describe('collapsedByDefault (t/783)', () => {
  it('3 turns or fewer: everything is open', () => {
    expect(collapsed(['opening', 'statement', 'fact-check'])).toEqual([]);
  });

  it('ending statement, fact-check, statement, moderator: both statements and the moderator (newest) are open', () => {
    // e1 statement, e2 fact-check, e3 statement, e4 moderator → the older fact check and statement e1 collapse.
    expect(collapsed(['statement', 'fact-check', 'statement', 'intervention'])).toEqual(['e2']);
    // With one more older statement: the 2 newest statements are e2 and e4, and e5 is the newest turn.
    expect(collapsed(['statement', 'statement', 'fact-check', 'statement', 'intervention'])).toEqual(['e1', 'e3']);
  });

  it('ending statement, statement, fact-check: both statements and the fact check (newest) are open', () => {
    expect(collapsed(['opening', 'statement', 'statement', 'fact-check'])).toEqual(['e1']);
  });

  it('a fact check or moderator row that is not the newest turn is collapsed and takes no open slot', () => {
    // 3 statements, then a fact check, a moderator row and a fact check: the newest turn is the last fact check.
    const types = ['opening', 'statement', 'statement', 'fact-check', 'intervention', 'fact-check'];
    // statements e1, e2, e3 → the 2 newest are e2 and e3; the newest turn e6 is open; e1, e4, e5 collapse.
    expect(collapsed(types)).toEqual(['e1', 'e4', 'e5']);
  });

  it('a transcript like the human debate: two debater statements stay open between fact checks', () => {
    const types = ['opening', 'statement', 'fact-check', 'statement', 'fact-check', 'intervention', 'fact-check', 'statement', 'fact-check'];
    // statements: e1, e2, e4, e8 → open e4 and e8; newest turn e9 is open; the rest collapse.
    expect(collapsed(types)).toEqual(['e1', 'e2', 'e3', 'e5', 'e6', 'e7']);
  });

  it('response (cross_respond) counts as a debater statement; the synthesis does not', () => {
    expect(collapsed(['opening', 'cross_respond', 'cross_respond', 'concluding', 'question'])).toEqual(['e1', 'e4']);
  });

  it('an id that is not a turn is never collapsed', () => {
    expect(collapsedByDefault(turnsOf(tr('opening', 'statement', 'statement', 'statement')), 'nope')).toBe(false);
  });
});
