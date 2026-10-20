// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SeatTagPicker, seatTagLabel, seatTagRefusal, seatTagIssueMessage } from './SeatTagPicker';
import type { PovNode } from '@lib/debate/taxonomyTypes';
import type { PovTagRegistry } from '@lib/schema/povTags';

const registry: PovTagRegistry = {
  version: 1,
  povs: {
    skeptic: [
      { id: 'critical', label: 'Critical', soul_doc: 'skeptic.critical', description: 'Critical wing' },
      { id: 'institutional', label: 'Institutional', soul_doc: 'skeptic.institutional', description: 'Institutional wing' },
    ],
  },
};

function makeNode(id: string, tags: string[] = []): PovNode {
  return { id, category: 'beliefs', label: id, description: '', parent_id: null, children: [], situation_refs: [], pov_tags: tags } as unknown as PovNode;
}

describe('seatTagLabel', () => {
  it('returns the registry label for a set tag', () => {
    expect(seatTagLabel('skeptic', { pov_tag: 'critical', tag_mode: 'scope' }, registry)).toBe('Critical');
  });
  it('returns undefined when untagged', () => {
    expect(seatTagLabel('skeptic', undefined, registry)).toBeUndefined();
  });
  it('returns undefined for a tag retired from the registry', () => {
    expect(seatTagLabel('skeptic', { pov_tag: 'gone', tag_mode: 'scope' }, registry)).toBeUndefined();
  });
});

describe('seatTagRefusal', () => {
  const taggedNodes = (n: number) => Array.from({ length: 10 }, (_, i) => makeNode(`skp-beliefs-${i}`, i < n ? ['critical'] : []));

  it('is undefined when untagged', () => {
    expect(seatTagRefusal(taggedNodes(0), undefined)).toBeUndefined();
  });

  // TL t/3957#7 cond B(a): Scope refuses below the checkTagScope floor (5).
  it('refuses Scope below the floor', () => {
    const refusal = seatTagRefusal(taggedNodes(3), { pov_tag: 'critical', tag_mode: 'scope' });
    expect(refusal).toEqual({ inScope: 3, excluded: 7, minimum: 5 });
  });

  it('does not refuse Scope at or above the floor', () => {
    expect(seatTagRefusal(taggedNodes(5), { pov_tag: 'critical', tag_mode: 'scope' })).toBeUndefined();
  });

  // TL t/3958#3 (CL permanent ruling): Prioritize has no floor but refuses at zero tagged nodes.
  it('refuses Prioritize at zero tagged nodes', () => {
    expect(seatTagRefusal(taggedNodes(0), { pov_tag: 'critical', tag_mode: 'prioritize' })).toEqual({ inScope: 0, excluded: 10 });
  });

  it('does not refuse Prioritize with any tagged node', () => {
    expect(seatTagRefusal(taggedNodes(1), { pov_tag: 'critical', tag_mode: 'prioritize' })).toBeUndefined();
  });
});

// TL p/696#6: the insufficient-scope message must show all three values — in-scope, excluded, minimum.
describe('seatTagIssueMessage', () => {
  it('shows in-scope, excluded, and minimum together for a Scope-below-floor refusal', () => {
    const message = seatTagIssueMessage({ inScope: 3, excluded: 7, minimum: 5 });
    expect(message).toMatch(/\b3\b/);
    expect(message).toMatch(/\b7\b/);
    expect(message).toMatch(/\b5\b/);
  });

  it('has no minimum to show for a Prioritize-zero refusal', () => {
    expect(seatTagIssueMessage({ inScope: 0, excluded: 10 })).toBe('No nodes carry this tag');
  });
});

describe('SeatTagPicker', () => {
  it('renders nothing when the registry has no entries for the POV', () => {
    const { container } = render(
      <SeatTagPicker pov="accelerationist" povNodes={[]} registry={registry} seatTag={undefined} onChange={vi.fn()} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('shows mode radios only once a tag is selected', () => {
    render(<SeatTagPicker pov="skeptic" povNodes={[]} registry={registry} seatTag={undefined} onChange={vi.fn()} />);
    expect(screen.queryByRole('radiogroup')).toBeNull();

    render(<SeatTagPicker pov="skeptic" povNodes={[]} registry={registry} seatTag={{ pov_tag: 'critical', tag_mode: 'scope' }} onChange={vi.fn()} />);
    expect(screen.getByRole('radiogroup')).toBeTruthy();
  });

  it('calling onChange with a tag id defaults to scope mode', () => {
    const onChange = vi.fn();
    render(<SeatTagPicker pov="skeptic" povNodes={[]} registry={registry} seatTag={undefined} onChange={onChange} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'critical' } });
    expect(onChange).toHaveBeenCalledWith({ pov_tag: 'critical', tag_mode: 'scope' });
  });

  it('clearing the tag calls onChange with undefined', () => {
    const onChange = vi.fn();
    render(<SeatTagPicker pov="skeptic" povNodes={[]} registry={registry} seatTag={{ pov_tag: 'critical', tag_mode: 'scope' }} onChange={onChange} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it('shows the in-scope/excluded counts in Scope mode, labelled by the selected tag', () => {
    const povNodes = [makeNode('skp-beliefs-001', ['critical']), makeNode('skp-beliefs-002')];
    render(<SeatTagPicker pov="skeptic" povNodes={povNodes} registry={registry} seatTag={{ pov_tag: 'critical', tag_mode: 'scope' }} onChange={vi.fn()} />);
    expect(screen.getByText('1 in scope, 1 not tagged Critical')).toBeTruthy();
  });

  // t/4275: excluded nodes may carry a different wing's tag, not be untagged — the count label must not claim "untagged".
  it('still reads "not tagged" when the excluded node carries a different tag entirely', () => {
    const povNodes = [makeNode('skp-beliefs-001', ['critical']), makeNode('skp-beliefs-002', ['institutional'])];
    render(<SeatTagPicker pov="skeptic" povNodes={povNodes} registry={registry} seatTag={{ pov_tag: 'critical', tag_mode: 'scope' }} onChange={vi.fn()} />);
    expect(screen.getByText('1 in scope, 1 not tagged Critical')).toBeTruthy();
  });

  it('shows in-scope, excluded, and minimum together when Scope is below the floor', () => {
    const povNodes = [makeNode('skp-beliefs-001', ['critical']), makeNode('skp-beliefs-002'), makeNode('skp-beliefs-003')];
    render(<SeatTagPicker pov="skeptic" povNodes={povNodes} registry={registry} seatTag={{ pov_tag: 'critical', tag_mode: 'scope' }} onChange={vi.fn()} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/\b1\b/); // inScope
    expect(alert).toHaveTextContent(/\b2\b/); // excluded
    expect(alert).toHaveTextContent(/\b5\b/); // minimum
  });
});
