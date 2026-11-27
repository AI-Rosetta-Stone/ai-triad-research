// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/835 (Design, spec §7): Next-moves titles are fixed phrases chosen by move type, with no text from any dispute.
// A title cut out of free text read as garbled on real debates ('Name the trade-off on above what trade size a
// separate model'), so the dispute's question goes in the card's context instead.

import { describe, it, expect } from 'vitest';
import { buildSynthesisView } from './synthesisView.js';
import { synthesisBrief } from './synthesisBrief.js';

const CAMPS = ['accelerationist', 'safetyist', 'skeptic'];
const dis = (point: string, type: string, extra: Record<string, unknown> = {}) => ({ point, type, positions: [], ...extra });

// The two garbled real-data cases (prod debate 'Legal personhood for fiduciary duty', accddd0c): points that are not
// 'Whether' questions, one of them cut at a dangling adverb.
const VALUES_POINT = 'Above what trade size a separate model of liability should replace the shared one';
const DEFINITIONAL_POINT = "How far a model maker's defense for truly independent agents extends";
const EMPIRICAL_POINT = 'Does compliance cost crush open source developers in practice today';

const synthesis = {
  areas_of_disagreement: [
    dis(VALUES_POINT, 'VALUES', { id: 'd1' }),
    dis(DEFINITIONAL_POINT, 'DEFINITIONAL', { id: 'd2', resolvability: 'requires_term_clarification' }),
    dis(EMPIRICAL_POINT, 'EMPIRICAL', { id: 'd3' }),
    dis('A second empirical question about audits', 'EMPIRICAL', { id: 'd4' }),
  ],
};

describe('Next-moves titles are fixed phrases (t/835)', () => {
  const view = buildSynthesisView({ synthesis, debaters: CAMPS });

  it('gives exactly the fixed title per type, with the chip naming every dispute of the type', () => {
    expect(view.nextMoves.map(m => [m.kind, m.title, m.chip])).toEqual([
      ['definitional', 'Define the key terms', 'Settles D2'],
      ['empirical', 'Find a way to measure it', 'Bears on D3, D4'],
      ['values', 'Name the trade-off', 'Answers D1'],
    ]);
  });

  it("the card's context is always the first dispute's full question of that type", () => {
    const ctx = Object.fromEntries(view.nextMoves.map(m => [m.kind, m.context]));
    expect(ctx).toEqual({ definitional: DEFINITIONAL_POINT, empirical: EMPIRICAL_POINT, values: VALUES_POINT });
  });

  it('no title contains any word of any dispute text', () => {
    // Distinctive tokens, so a stray ordinary word ('the', 'trade') in a fixed phrase can't count as a match.
    const odd = ['zorblax', 'quenthil', 'vamoora', 'plinth9'];
    const v = buildSynthesisView({
      debaters: CAMPS,
      synthesis: { areas_of_disagreement: [
        dis(`${odd[0]} ${odd[1]} whether exactly`, 'VALUES'),
        dis(`How far ${odd[2]} extends effectively`, 'DEFINITIONAL'),
        dis(`${odd[3]} and others, measured truly`, 'EMPIRICAL'),
      ] },
    });
    expect(v.nextMoves).toHaveLength(3);
    for (const m of v.nextMoves) {
      for (const token of odd) expect(m.title.toLowerCase()).not.toContain(token);
      expect(m.title).not.toMatch(/effectively|truly|exactly/i);
    }
  });

  it('every move still has its body from the dispute (would-change-if, else the resolvability)', () => {
    const withPref = buildSynthesisView({
      debaters: CAMPS,
      synthesis: { ...synthesis, preferences: [{ conflict: VALUES_POINT, disagreement_id: 'd1', prevails: 'undecidable', criterion: 'scope', rationale: 'r', what_would_change_this: 'A pilot.' }] },
    });
    expect(withPref.nextMoves.find(m => m.kind === 'values')?.body).toBe('A pilot.');
    expect(withPref.nextMoves.find(m => m.kind === 'definitional')?.body).toBe('requires term clarification');
  });

  it('a type with no dispute has no move', () => {
    const v = buildSynthesisView({ debaters: CAMPS, synthesis: { areas_of_disagreement: [dis(EMPIRICAL_POINT, 'EMPIRICAL')] } });
    expect(v.nextMoves.map(m => m.kind)).toEqual(['empirical']);
  });
});

describe('the Markdown brief prints the fixed titles (t/835)', () => {
  const md = synthesisBrief(synthesis, { debaters: CAMPS }).join('\n');

  it('prints the fixed phrases and the dispute as a nested line, never in the title', () => {
    expect(md).toContain('- **Define the key terms** (Settles D2)');
    expect(md).toContain('- **Find a way to measure it** (Bears on D3, D4)');
    expect(md).toContain('- **Name the trade-off** (Answers D1)');
    expect(md).toContain(`  - *The dispute in full:* ${VALUES_POINT}`);
    expect(md).not.toMatch(/\*\*Name the trade-off on /);
    expect(md).not.toMatch(/\*\*Define (how|above)/i);
  });
});
