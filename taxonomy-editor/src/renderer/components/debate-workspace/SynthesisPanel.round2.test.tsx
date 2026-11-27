// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/825 (spec §13.3 Strongest arguments) and t/829 (spec §13.7 crux Details) in the synthesis panel.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { SynthesisPanelView } from './SynthesisPanel';
import { buildSynthesisView } from '@lib/debate/synthesisView';
import { synthesisFindOffsets } from './synthesisFind';

const CAMPS = ['accelerationist', 'safetyist', 'skeptic'];

function synthesis(over: Record<string, unknown> = {}) {
  return {
    topic_resolution: { restated_question: 'Q?', where_it_landed: 'It landed.' },
    areas_of_agreement: ['a1', 'a2', 'a3', 'a4', 'a5'].map(point => ({ point })),
    areas_of_disagreement: [
      { point: 'Does it work?', type: 'EMPIRICAL', positions: [] },
      { point: 'Is it fair?', type: 'VALUES', positions: [] },
    ],
    cruxes: ['c1', 'c2', 'c3', 'c4'].map(question => ({ question })),
    unresolved_questions: ['Who pays?', 'When?'],
    ...over,
  };
}

const nodes = [
  { id: 'A1', text: 'Accelerationist claim one', speaker: 'accelerationist', source_entry_id: 'e1', computed_strength: 0.9 },
  { id: 'S1', text: 'Safetyist claim one', speaker: 'safetyist', source_entry_id: 'e2', computed_strength: 0.8 },
  { id: 'S2', text: 'Safetyist claim two', speaker: 'safetyist', source_entry_id: 'e3', computed_strength: 0.5 },
  { id: 'K0', text: 'Skeptic claim with no edges', speaker: 'skeptic', source_entry_id: 'e4', computed_strength: 1 },
];
const edges = [
  { source: 'S1', target: 'A1', type: 'attacks' },
  { source: 'S2', target: 'A1', type: 'supports' },
  { source: 'S2', target: 'S1', type: 'supports' },
];

const viewWith = (argumentNetwork: unknown, s: unknown = synthesis()) =>
  buildSynthesisView({ synthesis: s, debaters: CAMPS, argumentNetwork: argumentNetwork as never });
const withNetwork = (argumentNetwork: unknown) =>
  render(<SynthesisPanelView debateId="d1" view={viewWith(argumentNetwork)} />);

describe('Strongest arguments (spec 13.3, t/825)', () => {
  it('lists camps in a fixed order with ranked, engaged arguments only; a camp with none says so', () => {
    const { container } = withNetwork({ nodes, edges });
    const sections = Array.from(container.querySelectorAll('section.syn-arg-camp'));
    expect(sections.map(s => s.getAttribute('aria-label'))).toEqual([
      'Strongest arguments: Accelerationist', 'Strongest arguments: Safetyist', 'Strongest arguments: Skeptic',
    ]);
    expect(within(sections[1] as HTMLElement).getAllByRole('listitem').map(li => li.querySelector('p')?.textContent)).toEqual([
      'Safetyist claim one', 'Safetyist claim two',
    ]);
    expect(screen.queryByText('Skeptic claim with no edges')).toBeNull();
    expect(screen.getByText('No argument from Skeptic was supported or challenged by another.')).toBeTruthy();
  });

  it('the muted line is Supported by / Challenged by, or Engages N when both are zero', () => {
    withNetwork({ nodes, edges });
    expect(screen.getByText('Supported by 1 · Challenged by 1')).toBeTruthy(); // A1
    expect(screen.getByText('Supported by 1')).toBeTruthy(); // S1, supported by S2
    expect(screen.getByText('Engages 2 other arguments')).toBeTruthy(); // S2 is only a source
  });

  it('Show in transcript scrolls to the source statement and its link names the claim', () => {
    withNetwork({ nodes, edges });
    const target = document.createElement('div');
    target.id = 'debate-entry-e1';
    document.body.appendChild(target);
    const scroll = vi.fn();
    HTMLElement.prototype.scrollIntoView = scroll;
    fireEvent.click(screen.getByRole('link', { name: 'Show in transcript: Accelerationist claim one' }));
    expect(scroll).toHaveBeenCalled();
    expect(target.classList.contains('syn-flash')).toBe(true);
    target.remove();
  });

  it('the section and its nav link are hidden without a network or without engaged nodes', () => {
    const { unmount } = withNetwork(undefined);
    expect(screen.queryByRole('heading', { name: 'Strongest arguments' })).toBeNull();
    expect(screen.queryByRole('link', { name: /Strongest arguments/ })).toBeNull();
    unmount();
    withNetwork({ nodes, edges: [] });
    expect(screen.queryByRole('heading', { name: 'Strongest arguments' })).toBeNull();
  });

  it('is in the nav with the number of camps that have arguments, between Disputes and Cruxes', () => {
    withNetwork({ nodes, edges });
    const nav = screen.getByRole('navigation', { name: 'Synthesis sections' });
    expect(within(nav).getAllByRole('link').map(a => a.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      'Common ground 5', 'Disputes 2', 'Strongest arguments 2', 'Cruxes 4', 'Open questions 2',
    ]);
  });

  it('find reaches the argument text', () => {
    const view = viewWith({ nodes, edges });
    const { total, offsets } = synthesisFindOffsets(view, 'claim two');
    expect(total).toBe(1);
    render(<SynthesisPanelView debateId="d1" view={view} find={{ query: 'claim two', current: 0, offsets }} />);
    expect(document.querySelectorAll('mark[data-find-index]')).toHaveLength(1);
  });
});

describe('Crux details (spec 13.7, t/829)', () => {
  const cruxes = [
    { question: 'Both?', type: 'EMPIRICAL', if_yes: 'The safetyist position weakens.', if_no: 'The skeptic position weakens.' },
    { question: 'Only yes?', type: 'VALUES', if_yes: 'Only the yes line.' },
    { question: 'Neither?', type: 'VALUES' },
  ];
  const mountCruxes = (list: unknown[]) => render(<SynthesisPanelView debateId="d1" view={viewWith(undefined, synthesis({ cruxes: list }))} />);

  it('shows Details only where a field exists, with the lines in order and aria-expanded', () => {
    mountCruxes(cruxes);
    expect(screen.getAllByRole('button', { name: /^Details/ })).toHaveLength(2);
    const first = screen.getAllByRole('button', { name: /^Details/ })[0];
    expect(first.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(first);
    expect(first.getAttribute('aria-expanded')).toBe('true');
    const body = document.getElementById(first.getAttribute('aria-controls') as string) as HTMLElement;
    expect(Array.from(body.querySelectorAll('p')).map(p => p.textContent)).toEqual([
      'If yes: The safetyist position weakens.', 'If no: The skeptic position weakens.',
    ]);
    const second = screen.getAllByRole('button', { name: /^Details/ })[1];
    fireEvent.click(second);
    const body2 = document.getElementById(second.getAttribute('aria-controls') as string) as HTMLElement;
    expect(Array.from(body2.querySelectorAll('p')).map(p => p.textContent)).toEqual(['If yes: Only the yes line.']);
  });

  it('a find match inside a collapsed Details opens it', () => {
    const view = viewWith(undefined, synthesis({ cruxes }));
    const { offsets } = synthesisFindOffsets(view, 'skeptic position');
    render(<SynthesisPanelView debateId="d1" view={view} find={{ query: 'skeptic position', current: 0, offsets }} />);
    expect(document.querySelectorAll('mark[data-find-index]')).toHaveLength(1);
  });

  it('Show fewer resets every open Details', () => {
    mountCruxes([...cruxes, { question: 'Fourth?', if_yes: 'y4' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Show 1 more cruxes' }));
    const btn = screen.getAllByRole('button', { name: /^Details/ })[0];
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Show fewer' }));
    expect(screen.getAllByRole('button', { name: /^Details/ })[0].getAttribute('aria-expanded')).toBe('false');
  });
});
