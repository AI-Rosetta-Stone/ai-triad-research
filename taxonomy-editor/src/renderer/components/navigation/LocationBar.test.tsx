// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4640#40 item 3: the breadcrumb's markup per docs/ux/navigation-location-bar.md — a Breadcrumb
// landmark with a list, links only on up-ancestors, the current crumb as plain text.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { LocationBar } from './LocationBar';
import type { Crumb } from '../../navigation/types';

const itemCrumbs: Crumb[] = [
  { text: 'Chat', href: '/chat' },
  { text: 'How would a Safetyist see compute caps?' },
];

describe('LocationBar', () => {
  it('is a Breadcrumb nav landmark with an ordered list, one item per crumb', () => {
    render(<LocationBar crumbs={itemCrumbs} tool="chat" onUp={vi.fn()} />);
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    const list = within(nav).getByRole('list');
    expect(list.tagName).toBe('OL');
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
  });

  it('renders the current crumb as plain text with aria-current="location" — not a button or link', () => {
    render(<LocationBar crumbs={itemCrumbs} tool="chat" onUp={vi.fn()} />);
    const current = screen.getByText('How would a Safetyist see compute caps?').closest('li')!;
    expect(current).toHaveAttribute('aria-current', 'location');
    expect(within(current).queryByRole('link')).toBeNull();
    expect(within(current).queryByRole('button')).toBeNull();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('renders an up-ancestor as a real link to its collection, titled "Up to …"', () => {
    render(<LocationBar crumbs={itemCrumbs} tool="chat" onUp={vi.fn()} />);
    const link = screen.getByRole('link', { name: 'Chat' });
    expect(link).toHaveAttribute('href', '/chat');
    expect(link).toHaveAttribute('title', 'Up to Chat');
  });

  it('a plain click on an up-link navigates in place: prevents the page load and calls onUp(href)', () => {
    const onUp = vi.fn();
    render(<LocationBar crumbs={itemCrumbs} tool="chat" onUp={onUp} />);
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    fireEvent(screen.getByRole('link', { name: 'Chat' }), event);
    expect(event.defaultPrevented).toBe(true);
    expect(onUp).toHaveBeenCalledWith('/chat');
  });

  it('an ancestor without href (e.g. "Taxonomy") is plain text, not a link', () => {
    const crumbs: Crumb[] = [
      { text: 'Taxonomy' },
      { text: 'Safetyist', camp: 'saf', href: '/taxonomy/saf' },
      { text: 'AI must not erode human oversight' },
    ];
    render(<LocationBar crumbs={crumbs} tool="taxonomy" onUp={vi.fn()} />);
    expect(screen.queryByRole('link', { name: 'Taxonomy' })).toBeNull();
    expect(screen.getByText('Taxonomy')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Safetyist' })).toHaveAttribute('href', '/taxonomy/saf');
  });

  it('draws the camp dot for a crumb with a camp, hidden from assistive tech', () => {
    const { container } = render(
      <LocationBar crumbs={[{ text: 'Taxonomy' }, { text: 'Safetyist', camp: 'saf' }]} tool="taxonomy" onUp={vi.fn()} />,
    );
    const dot = container.querySelector('.nav-locbar-dot-saf');
    expect(dot).not.toBeNull();
    expect(dot).toHaveAttribute('aria-hidden', 'true');
  });

  it('a single-crumb place has no links and no separators', () => {
    const { container } = render(<LocationBar crumbs={[{ text: 'Rosetta Stone' }]} tool="rosetta-stone" onUp={vi.fn()} />);
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(container.querySelectorAll('.nav-locbar-separator')).toHaveLength(0);
  });
});
