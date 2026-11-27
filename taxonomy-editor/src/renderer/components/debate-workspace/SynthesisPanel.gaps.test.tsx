// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/833: three test gaps Quality found in #5654 (p/19#44), each pinned to the line it guards.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, renderHook } from '@testing-library/react';
import { SynthesisPanelView } from './SynthesisPanel';
import { useSynthesisTop } from './SynthesisTop';
import { buildSynthesisView } from '@lib/debate/synthesisView';
import { synthesisFindOffsets } from './synthesisFind';

const CAMPS = ['accelerationist', 'safetyist', 'skeptic'];

const synthesis = {
  topic_resolution: { restated_question: 'Q?', where_it_landed: 'It landed.' },
  areas_of_disagreement: [{ point: 'Does it work?', type: 'EMPIRICAL', positions: [] }],
  cruxes: [{ question: 'Both?', if_yes: 'The safetyist position weakens.', if_no: 'The skeptic position weakens.' }],
};

const network = {
  nodes: [
    { id: 'A1', text: 'Accelerationist claim', speaker: 'accelerationist', source_entry_id: 'e1', computed_strength: 0.9 },
    { id: 'S1', text: 'Safetyist claim', speaker: 'safetyist', source_entry_id: 'e2', computed_strength: 0.8 },
  ],
  edges: [{ source: 'S1', target: 'A1', type: 'attacks' }],
};

const entry = { id: 'c1', type: 'concluding', speaker: 'system', content: 'x', metadata: { synthesis } };
const debate = (extra: Record<string, unknown>) =>
  ({ id: 'd1', active_povers: CAMPS, topic: { final: 'T' }, transcript: [entry], ...extra }) as never;

describe('useSynthesisTop passes the argument network (the line that makes Strongest arguments appear)', () => {
  it('builds strongestArguments from debate.argument_network', () => {
    const { result } = renderHook(() => useSynthesisTop(debate({ argument_network: network })));
    const items = result.current?.view.strongestArguments.flatMap(c => c.items.map(i => i.id));
    expect(items).toEqual(['A1', 'S1']);
  });

  it('shows no Strongest arguments when the debate has no argument_network', () => {
    const { result } = renderHook(() => useSynthesisTop(debate({})));
    expect(result.current?.view.strongestArguments).toEqual([]);
  });
});

describe('find matches the crux If yes / If no text', () => {
  const view = buildSynthesisView({ synthesis, debaters: CAMPS });

  it('counts a match in If yes and one in If no, keyed so they highlight separately', () => {
    expect(synthesisFindOffsets(view, 'weakens').total).toBe(2);
    expect([...synthesisFindOffsets(view, 'weakens').offsets.keys()]).toEqual(['C1.yes', 'C1.no']);
  });

  it('opens the Details for a match in If yes and highlights it', () => {
    const { offsets } = synthesisFindOffsets(view, 'safetyist position');
    render(<SynthesisPanelView debateId="d1" view={view} find={{ query: 'safetyist position', current: 0, offsets }} />);
    expect(screen.getByRole('button', { name: /^Details/ }).getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelectorAll('mark[data-find-index]')).toHaveLength(1);
  });
});

describe('Show in transcript', () => {
  it('prevents the anchor default (the in-page scroll replaces the hash navigation)', () => {
    render(<SynthesisPanelView debateId="d1" view={buildSynthesisView({ synthesis, debaters: CAMPS, argumentNetwork: network as never })} />);
    HTMLElement.prototype.scrollIntoView = vi.fn();
    const link = screen.getAllByRole('link', { name: /^Show in transcript/ })[0];
    // fireEvent returns false when the event's default was prevented
    expect(fireEvent.click(link)).toBe(false);
  });
});
