// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4246: the Ask panel's POV tag picker, against the real tag registry (Skeptic: critical, institutional).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { TagSelection } from '@lib/schema/povTags';

const taxState = vi.hoisted(() => ({ value: {} as Record<string, { nodes: { id: string; pov_tags?: string[] }[] } | undefined> }));
vi.mock('../../hooks/useTaxonomyStore', () => ({ useTaxonomyStore: { getState: () => taxState.value } }));

const { InquiryTagPicker, inquiryTagBlocked, taggedPovs } = await import('./InquiryTagPicker');

const nodes = (tagged: number, untagged: number) => [
  ...Array.from({ length: tagged }, (_, i) => ({ id: `skp-beliefs-${i}`, pov_tags: ['critical'] })),
  ...Array.from({ length: untagged }, (_, i) => ({ id: `skp-desires-${i}` })),
];

beforeEach(() => { taxState.value = {}; });

describe('InquiryTagPicker (t/4246)', () => {
  it('offers only camps with registry tags (Skeptic today)', () => {
    expect(taggedPovs()).toEqual(['skeptic']);
  });

  it('picking a tag selects it in Scope mode for that camp; None clears it', () => {
    const onChange = vi.fn();
    const { rerender } = render(<InquiryTagPicker value={undefined} onChange={onChange} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Skeptic tag' }), { target: { value: 'critical' } });
    expect(onChange).toHaveBeenLastCalledWith({ pov: 'skeptic', tag: 'critical', mode: 'scope' });

    rerender(<InquiryTagPicker value={{ pov: 'skeptic', tag: 'critical', mode: 'scope' }} onChange={onChange} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Skeptic tag' }), { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it('switching to Prioritize keeps the tag', () => {
    const onChange = vi.fn();
    render(<InquiryTagPicker value={{ pov: 'skeptic', tag: 'critical', mode: 'scope' }} onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Prioritize' }));
    expect(onChange).toHaveBeenLastCalledWith({ pov: 'skeptic', tag: 'critical', mode: 'prioritize' });
  });

  it('with the camp loaded, shows the scope count and the floor refusal', () => {
    taxState.value = { skeptic: { nodes: nodes(3, 10) } };
    const sel: TagSelection = { pov: 'skeptic', tag: 'critical', mode: 'scope' };
    render(<InquiryTagPicker value={sel} onChange={vi.fn()} />);
    expect(screen.getByText(/3 in scope, 10 not tagged Critical/)).toBeInTheDocument();
    expect(inquiryTagBlocked(sel)).toMatch(/below the minimum/);
  });

  it('t/4275: nodes carrying another wing\'s tag count as "not tagged <wing>", not "untagged"', () => {
    const otherWing = Array.from({ length: 4 }, (_, i) => ({ id: `skp-intentions-${i}`, pov_tags: ['institutional'] }));
    taxState.value = { skeptic: { nodes: [...nodes(3, 1), ...otherWing] } };
    render(<InquiryTagPicker value={{ pov: 'skeptic', tag: 'critical', mode: 'scope' }} onChange={vi.fn()} />);
    const count = screen.getByText(/3 in scope, 5 not tagged Critical/);
    expect(count.textContent).not.toMatch(/untagged/);
  });

  it('a scope at or above the floor is not blocked', () => {
    taxState.value = { skeptic: { nodes: nodes(6, 2) } };
    expect(inquiryTagBlocked({ pov: 'skeptic', tag: 'critical', mode: 'scope' })).toBeUndefined();
  });

  it('with the camp not loaded, the UI never refuses (the server floor check decides)', () => {
    expect(inquiryTagBlocked({ pov: 'skeptic', tag: 'critical', mode: 'scope' })).toBeUndefined();
  });
});
