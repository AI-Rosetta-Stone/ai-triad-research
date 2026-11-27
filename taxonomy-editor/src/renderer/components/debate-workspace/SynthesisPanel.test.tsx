// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/809: the synthesis panel v2 renders the view-model: sections, nav, expanders, no raw tags,
// no controls without a backing action, saved checkbox state, and the default-off switch.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { SynthesisPanel, isSynthesisV2On } from './SynthesisPanel';

const ARGUMENT_MAP = [{ claim_id: 'C1', claimant: 'skeptic' }, { claim_id: 'C2', claimant: 'safetyist' }];

function synthesis(over: Record<string, unknown> = {}) {
  return {
    topic_resolution: { restated_question: 'Should we pause?', where_it_landed: 'It landed here.', what_would_resolve_it: 'Data.' },
    argument_map: ARGUMENT_MAP,
    areas_of_agreement: ['a1', 'a2', 'a3', 'a4', 'a5'].map(point => ({ point, povers: ['skeptic'] })),
    areas_of_disagreement: [
      { point: 'Does it work?', type: 'EMPIRICAL', bdi_layer: 'belief', positions: [{ pover: 'skeptic', stance: 'No.' }, { pover: 'safetyist', stance: 'Yes.' }] },
      { point: 'Is it fair?', type: 'VALUES', positions: [] },
    ],
    preferences: [{ conflict: 'Does it work?', prevails: 'C1', criterion: 'empirical_evidence', rationale: 'r' }],
    cruxes: ['c1', 'c2', 'c3', 'c4'].map(question => ({ question, type: 'EMPIRICAL' })),
    unresolved_questions: ['Who pays?', 'When?'],
    ...over,
  };
}

const mount = (s: unknown = synthesis()) =>
  render(<SynthesisPanel debateId="d1" input={{ synthesis: s, debaters: ['accelerationist', 'safetyist', 'skeptic'] }} />);

beforeEach(() => localStorage.clear());

describe('SynthesisPanel', () => {
  it('shows each dispute once with its verdict, translated labels, and no raw tags', () => {
    const { container } = mount();
    expect(screen.getByRole('heading', { name: 'Does it work?' })).toBeTruthy();
    expect(container.querySelectorAll('[data-dispute]')).toHaveLength(2);
    expect(screen.getByText('Skeptic stronger')).toBeTruthy();
    expect(screen.getAllByText('No verdict')).toHaveLength(2); // the card chip and the legend entry
    expect(screen.getByText("Why: the Skeptic's argument cited more or better evidence.")).toBeTruthy();
    expect(screen.getByText("· about what's true")).toBeTruthy();
    expect(container.textContent).not.toMatch(/\[EMPIRICAL\]|\{belief\}|D2-skeptic/);
  });

  it('the outcome strip names the heading as a model assessment and spells out each outcome', () => {
    mount();
    expect(screen.getByText(/Which camp made the stronger case \(model.s assessment\)/)).toBeTruthy();
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe('D1: Skeptic stronger. D2: no verdict.');
  });

  it('does not render Share, Export brief, Run another round or Debate this (no backing action)', () => {
    mount();
    for (const name of [/share/i, /export brief/i, /run another round/i, /debate this/i]) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
  });

  it('common ground shows 3 then Show all N points with aria-expanded', () => {
    mount();
    expect(screen.queryByText('a4')).toBeNull();
    const btn = screen.getByRole('button', { name: 'Show all 5 points' });
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(btn);
    expect(screen.getByText('a5')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Show fewer' }).getAttribute('aria-expanded')).toBe('true');
  });

  it('cruxes are numbered C1.. and capped at 3 with Show N more cruxes', () => {
    mount();
    expect(screen.getByText('C3')).toBeTruthy();
    expect(screen.queryByText('C4')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show 1 more cruxes' }));
    expect(screen.getByText('C4')).toBeTruthy();
  });

  it('Read both sides expands the positions in place', () => {
    mount();
    expect(screen.queryByText('Yes.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Read both sides' }));
    expect(screen.getByText('Yes.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Hide both sides' }).getAttribute('aria-expanded')).toBe('true');
  });

  it('nav lists only the sections with items and counts, and a jump moves focus to the heading', () => {
    mount();
    const nav = screen.getByRole('navigation', { name: 'Synthesis sections' });
    expect(within(nav).getAllByRole('link').map(a => a.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      'Common ground 5', 'Disputes 2', 'Cruxes 4', 'Open questions 2',
    ]);
    const scroll = vi.fn();
    HTMLElement.prototype.scrollIntoView = scroll;
    fireEvent.click(within(nav).getByRole('link', { name: /Disputes/ }));
    expect(document.activeElement?.textContent).toBe('Disputes');
    expect(scroll).toHaveBeenCalled();
  });

  it('omits a section and its nav link when it has no items', () => {
    mount(synthesis({ cruxes: [], unresolved_questions: [] }));
    expect(screen.queryByRole('heading', { name: 'Cruxes' })).toBeNull();
    expect(screen.queryByRole('link', { name: /Cruxes/ })).toBeNull();
  });

  it('shows the unreadable line in place of the agreements (t/774)', () => {
    mount(synthesis({ areas_of_agreement: [], unreadable_lists: ['areas_of_agreement'] }));
    expect(screen.getByText("Agreements couldn't be read for this synthesis.")).toBeTruthy();
  });

  it('open-question checkboxes are labelled and their state is saved by debate id', () => {
    const { unmount } = mount();
    const box = screen.getByLabelText('Who pays?') as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    expect(JSON.parse(localStorage.getItem('synthesisV2.questions.d1') as string)).toEqual(['Q1']);
    unmount();
    mount();
    expect((screen.getByLabelText('Who pays?') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('When?') as HTMLInputElement).checked).toBe(false);
  });

  it('Read more shows the rest of a long bottom line', () => {
    mount(synthesis({ topic_resolution: { where_it_landed: 'One. Two. Three. Four here.' } }));
    const more = screen.getByRole('button', { name: 'Read more' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(more);
    expect(screen.getByRole('button', { name: 'Read less' }).getAttribute('aria-expanded')).toBe('true');
  });
});

describe('isSynthesisV2On', () => {
  it('is off by default and on only for localStorage.synthesisV2 = "1"', () => {
    expect(isSynthesisV2On()).toBe(false);
    localStorage.setItem('synthesisV2', '1');
    expect(isSynthesisV2On()).toBe(true);
    localStorage.setItem('synthesisV2', 'true');
    expect(isSynthesisV2On()).toBe(false);
  });
});
