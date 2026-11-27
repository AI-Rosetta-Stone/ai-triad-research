// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/809: the synthesis panel v2 renders the view-model: sections, nav, expanders, no raw tags,
// no controls without a backing action, saved checkbox state, collapse, skip link, find, the
// top-of-page pointer row and the default-off switch (spec §3-§8, §12).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, renderHook } from '@testing-library/react';
import { SynthesisPanelView, type PanelFind } from './SynthesisPanel';
import { SynthesisTop, SynthesisPointerRow, useSynthesisTop, findSynthesisEntry, panelFindOffsets } from './SynthesisTop';
import { buildSynthesisView } from './synthesisView';
import { synthesisFindOffsets } from './synthesisFind';
import { isSynthesisV2On } from './synthesisStorage';

const ARGUMENT_MAP = [{ claim_id: 'C1', claimant: 'skeptic' }, { claim_id: 'C2', claimant: 'safetyist' }];
const CAMPS = ['accelerationist', 'safetyist', 'skeptic'];

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

const viewOf = (s: unknown = synthesis()) => buildSynthesisView({ synthesis: s, debaters: CAMPS });
const mount = (s: unknown = synthesis(), props: Partial<React.ComponentProps<typeof SynthesisPanelView>> = {}) =>
  render(<SynthesisPanelView debateId="d1" view={viewOf(s)} {...props} />);

beforeEach(() => localStorage.clear());

describe('SynthesisPanelView', () => {
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

  it('does not render Share, Run another round or Debate this (no backing action), nor Export brief without a handler', () => {
    mount();
    for (const name of [/share/i, /export brief/i, /run another round/i, /debate this/i]) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
  });

  it('Export brief shows in the header and the footer when there is a handler, and calls it', () => {
    const onExportBrief = vi.fn();
    mount(synthesis(), { onExportBrief });
    const buttons = screen.getAllByRole('button', { name: 'Export brief' });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[1]);
    expect(onExportBrief).toHaveBeenCalledOnce();
  });

  it('a next-move title that lost text keeps the full dispute in the card', () => {
    mount(synthesis({ areas_of_disagreement: [{ point: 'Whether a pause works, and who pays for it afterwards', type: 'EMPIRICAL', positions: [] }], preferences: [] }));
    expect(screen.getByText('Find a way to measure a pause works')).toBeTruthy();
    expect(screen.getAllByText('Whether a pause works, and who pays for it afterwards').length).toBeGreaterThan(1);
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

  it('collapsed shows the header, title and bottom-line paragraph only', () => {
    mount(synthesis(), { collapsed: true, onToggleCollapsed: vi.fn() });
    expect(screen.getByRole('heading', { level: 2, name: 'Debate synthesis' })).toBeTruthy();
    expect(screen.queryByText('Should we pause?')).toBeNull(); // the page header above already shows the motion and the debaters
    expect(screen.getByText('It landed here.')).toBeTruthy();
    for (const h of ['Disputes', 'Cruxes', 'Common ground', 'Open questions', 'Next moves']) {
      expect(screen.queryByRole('heading', { name: h })).toBeNull();
    }
    expect(screen.getByRole('button', { name: 'Expand synthesis ▾' }).getAttribute('aria-expanded')).toBe('false');
  });

  it('a find in progress shows the panel fully expanded even when collapsed', () => {
    const view = viewOf();
    const find: PanelFind = { query: 'fair', current: 0, offsets: synthesisFindOffsets(view, 'fair').offsets };
    render(<SynthesisPanelView debateId="d1" view={view} collapsed onToggleCollapsed={vi.fn()} find={find} />);
    expect(screen.getByRole('heading', { name: /Is it fair/ })).toBeTruthy();
    expect(document.querySelectorAll('mark[data-find-index]')).toHaveLength(2) // the dispute and its next-move title;
  });

  it('Skip to transcript is the first link and calls onSkip', () => {
    const onSkip = vi.fn();
    mount(synthesis(), { onSkip });
    const nav = screen.getByRole('navigation', { name: 'Synthesis sections' });
    const links = within(nav).getAllByRole('link');
    expect(links[0].textContent).toBe('Skip to transcript');
    fireEvent.click(links[0]);
    expect(onSkip).toHaveBeenCalledOnce();
  });
});

describe('outline link (spec §12)', () => {
  it('the outline SYNTHESIS item scrolls to the panel, not to the pointer row', async () => {
    const { TranscriptOutline } = await import('./TranscriptOutline');
    const scroll = vi.fn();
    render(
      <>
        <div id="synthesis-v2-top" />
        <div id="debate-entry-c1"><div className="syn-pointer" /></div>
        <TranscriptOutline transcript={[{ id: 'c1', type: 'concluding', speaker: 'system', content: 'x' }] as never} />
      </>,
    );
    HTMLElement.prototype.scrollIntoView = function () { scroll(this.id); };
    fireEvent.click(screen.getByText('Synthesis'));
    expect(scroll).toHaveBeenCalledWith('synthesis-v2-top');
  });
});

describe('SynthesisTop placement (spec §12)', () => {
  const entry = (type: string, extra: Record<string, unknown> = {}) => ({ id: type, type, speaker: 'system', content: 'x', ...extra });
  const debate = (transcript: unknown[]) => ({ id: 'd1', active_povers: CAMPS, topic: { final: 'T' }, transcript }) as never;

  it('collapse is remembered per debate and defaults to expanded', () => {
    const top = { entry: entry('concluding') as never, view: viewOf() };
    const { unmount } = render(<SynthesisTop top={top} debateId="d1" findQuery="" findCurrentIndex={0} />);
    expect(screen.getByRole('heading', { name: 'Disputes' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse synthesis ▴' }));
    expect(screen.queryByRole('heading', { name: 'Disputes' })).toBeNull();
    unmount();
    render(<SynthesisTop top={top} debateId="d1" findQuery="" findCurrentIndex={0} />);
    expect(screen.queryByRole('heading', { name: 'Disputes' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Expand synthesis ▾' }));
    expect(screen.getByRole('heading', { name: 'Disputes' })).toBeTruthy();
  });

  it('Skip to transcript moves focus to the first transcript entry', () => {
    const top = { entry: entry('concluding') as never, view: viewOf() };
    render(
      <>
        <SynthesisTop top={top} debateId="d1" findQuery="" findCurrentIndex={0} />
        <div className="debate-transcript-column"><div id="debate-entry-e1">first</div></div>
      </>,
    );
    HTMLElement.prototype.scrollIntoView = vi.fn();
    fireEvent.click(screen.getByRole('link', { name: 'Skip to transcript' }));
    expect(document.activeElement?.id).toBe('debate-entry-e1');
  });

  it('the pointer row is one line and Back to top focuses the panel', () => {
    const top = { entry: entry('concluding') as never, view: viewOf() };
    render(<><SynthesisTop top={top} debateId="d1" findQuery="" findCurrentIndex={0} /><SynthesisPointerRow /></>);
    expect(screen.getByText('Synthesis · shown at the top of this page')).toBeTruthy();
    HTMLElement.prototype.scrollIntoView = vi.fn();
    fireEvent.click(screen.getByRole('link', { name: 'Back to top' }));
    expect(document.activeElement?.id).toBe('synthesis-v2-top');
  });

  it('nothing is built until the switch is on and a concluding entry with a synthesis exists', () => {
    const concluded = debate([entry('statement'), entry('concluding', { metadata: { synthesis: synthesis() } })]);
    expect(renderHook(() => useSynthesisTop(concluded)).result.current).toBeNull(); // switch off
    localStorage.setItem('synthesisV2', '1');
    expect(renderHook(() => useSynthesisTop(concluded)).result.current?.view.disputes).toHaveLength(2);
    expect(renderHook(() => useSynthesisTop(debate([entry('statement')]))).result.current).toBeNull(); // still running
    expect(renderHook(() => useSynthesisTop(debate([entry('concluding', { metadata: {} })]))).result.current).toBeNull(); // failed
    expect(renderHook(() => useSynthesisTop(null)).result.current).toBeNull();
  });

  it('find offsets: the panel counts first and a missing panel counts nothing', () => {
    const top = { entry: entry('concluding') as never, view: viewOf() };
    expect(panelFindOffsets(top, 'fair').total).toBe(2);
    expect(panelFindOffsets(null, 'fair').total).toBe(0);
    expect(findSynthesisEntry([entry('concluding') as never])).toBeNull();
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

describe('open questions in the panel (spec §8)', () => {
  const withThemes = (themes: string[]) =>
    synthesis({ unresolved_questions: ['Who pays?', 'When?', 'Which law?'], unresolved_question_themes: themes });

  it('themed groups render as a fieldset with a legend, plus a final untitled list without an Other heading', () => {
    const { container } = mount(withThemes(['Funding', 'Funding', '']));
    const fs = container.querySelector('fieldset.syn-question-group') as HTMLElement;
    expect(within(fs).getByText('Funding')).toBeTruthy();
    expect(within(fs).getAllByRole('checkbox')).toHaveLength(2);
    expect(container.querySelectorAll('fieldset')).toHaveLength(1);
    expect(container.textContent).not.toMatch(/Other/);
    expect(screen.getByLabelText('Which law?')).toBeTruthy();
  });

  it('every question with its own theme stays a flat list', () => {
    const { container } = mount(withThemes(['A', 'B', 'C']));
    expect(container.querySelectorAll('fieldset')).toHaveLength(0);
    expect(screen.getAllByRole('checkbox')).toHaveLength(3);
  });
});

describe('join and find guards (Quality, #5637)', () => {
  it('a preference with a valid disagreement_id is joined by id even when its text equals another dispute', () => {
    const v = buildSynthesisView({
      debaters: CAMPS,
      synthesis: {
        argument_map: ARGUMENT_MAP,
        areas_of_disagreement: [
          { id: 'd1', point: 'Whether audits can be enforced fairly', type: 'EMPIRICAL', positions: [] },
          { id: 'd2', point: 'Whether a pause shifts incentives toward safety', type: 'VALUES', positions: [] },
        ],
        preferences: [{ conflict: 'Whether audits can be enforced fairly', disagreement_id: 'd2', prevails: 'C1', criterion: 'scope', rationale: 'r' }],
      },
    });
    expect(v.disputes.map(d => [d.n, d.verdict.kind])).toEqual([['D1', 'none'], ['D2', 'camp']]);
  });

  it('find counts and marks the Read more text of a long bottom line', () => {
    const view = viewOf(synthesis({ topic_resolution: { where_it_landed: 'One. Two. Three. Fourth zebra here.' } }));
    const { total, offsets } = synthesisFindOffsets(view, 'zebra');
    expect(total).toBe(1);
    const find: PanelFind = { query: 'zebra', current: 0, offsets };
    render(<SynthesisPanelView debateId="d1" view={view} find={find} />);
    expect(document.querySelectorAll('mark[data-find-index]')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Read less' })).toBeTruthy(); // opened by the find, so the match has an element
  });
});
