// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4914 — Debate Synthesis redesign per docs/ux/debate-synthesis.md: the leading
// heading-less block labelled "Areas of Agreement", top-3 + "Show N more" per list
// section, camp-only parentheticals becoming chips (or "All three"), and one unified
// bullet style with a trailing "details" disclosure for sub-points.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConcludingSections, splitByHeadings, extractCampChips } from './SynthesisSections';

vi.mock('react-markdown', () => ({ default: ({ children }: { children: string }) => <>{children}</> }));

function bullets(n: number, suffix = ''): string {
  return Array.from({ length: n }, (_, i) => `- Item ${i + 1}${suffix}`).join('\n');
}

describe('splitByHeadings', () => {
  it('labels the leading heading-less block "Areas of Agreement" (spec §4)', () => {
    const sections = splitByHeadings('- a\n- b\n\n## Areas of Disagreement\n- c');
    expect(sections[0]).toEqual({ heading: 'Areas of Agreement', body: '- a\n- b' });
    expect(sections[1]).toEqual({ heading: 'Areas of Disagreement', body: '- c' });
  });

  it('parses a labelled section normally', () => {
    const sections = splitByHeadings('## Cruxes\n- x\n- y');
    expect(sections).toEqual([{ heading: 'Cruxes', body: '- x\n- y' }]);
  });
});

describe('extractCampChips', () => {
  it('extracts all three camps as a set (any order) and strips the parenthetical', () => {
    const r = extractCampChips('The harm is real (Skeptic, Safetyist, Accelerationist)');
    expect(r.text).toBe('The harm is real');
    expect(r.camps).toEqual(['Accelerationist', 'Safetyist', 'Skeptic']);
  });

  it('extracts a subset of camps in the fixed render order regardless of input order', () => {
    const r = extractCampChips('Tool-level bans work (Safetyist, Accelerationist)');
    expect(r.camps).toEqual(['Accelerationist', 'Safetyist']);
    expect(r.text).toBe('Tool-level bans work');
  });

  it('extracts a single camp', () => {
    const r = extractCampChips('Only one camp holds this (Skeptic)');
    expect(r.camps).toEqual(['Skeptic']);
  });

  it('leaves text with no trailing parenthetical unchanged', () => {
    const r = extractCampChips('No camp attribution here');
    expect(r.camps).toEqual([]);
    expect(r.text).toBe('No camp attribution here');
  });

  it('leaves an unrecognized name in the parenthetical untouched (no chips)', () => {
    const r = extractCampChips('Some claim (Moderator)');
    expect(r.camps).toEqual([]);
    expect(r.text).toBe('Some claim (Moderator)');
  });

  it('leaves a mixed recognized/unrecognized parenthetical untouched', () => {
    const r = extractCampChips('Some claim (Skeptic, Moderator)');
    expect(r.camps).toEqual([]);
    expect(r.text).toBe('Some claim (Skeptic, Moderator)');
  });
});

describe('ConcludingSections — headings and counts (spec §4, AC2)', () => {
  it('renders the leading block as "Areas of Agreement (N)"', () => {
    const { container } = render(<ConcludingSections content={bullets(2)} mdComponents={{}} />);
    const heading = container.querySelector('[data-section="Areas of Agreement"] h2');
    expect(heading?.textContent).toBe('Areas of Agreement (2)');
  });
});

describe('ConcludingSections — top 3 + Show N more (spec §4, AC3)', () => {
  it('shows all items with no expander when there are 2', () => {
    render(<ConcludingSections content={bullets(2)} mdComponents={{}} />);
    expect(screen.getByText('Item 1')).toBeInTheDocument();
    expect(screen.getByText('Item 2')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Show.*more/ })).toBeNull();
  });

  it('shows all items with no expander when there are exactly 3', () => {
    render(<ConcludingSections content={bullets(3)} mdComponents={{}} />);
    expect(screen.getByText('Item 3')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Show.*more/ })).toBeNull();
  });

  it('caps at 3 with a "Show 4 more" expander when there are 7, and toggles to "Show fewer"', () => {
    render(<ConcludingSections content={bullets(7)} mdComponents={{}} />);
    expect(screen.getByText('Item 3')).toBeInTheDocument();
    expect(screen.queryByText('Item 4')).toBeNull();
    const expander = screen.getByRole('button', { name: 'Show 4 more ▾' });
    expect(expander).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(expander);
    expect(screen.getByText('Item 7')).toBeInTheDocument();
    const collapse = screen.getByRole('button', { name: 'Show fewer ▴' });
    expect(collapse).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(collapse);
    expect(screen.queryByText('Item 7')).toBeNull();
  });

  it('does not cap Resolution Analysis (not a LIST_SECTION) even with 7 items', () => {
    render(<ConcludingSections content={`## Resolution Analysis\n${bullets(7)}`} mdComponents={{}} />);
    expect(screen.getByText('Item 7')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Show.*more/ })).toBeNull();
  });
});

describe('ConcludingSections — camp chips (spec §5, AC4)', () => {
  it('renders "All three" for a bullet ending in all three camp names', () => {
    render(<ConcludingSections content="- The harm is real and documented (Skeptic, Safetyist, Accelerationist)" mdComponents={{}} />);
    expect(screen.getByText('All three')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Held by all three camps' })).toBeInTheDocument();
    expect(screen.getByText('The harm is real and documented')).toBeInTheDocument();
  });

  it('renders one chip per camp for a subset, in fixed order', () => {
    render(<ConcludingSections content="- Tool-level bans work (Safetyist, Accelerationist)" mdComponents={{}} />);
    const group = screen.getByRole('group', { name: 'Held by Accelerationist and Safetyist' });
    expect(group.textContent).toBe('AccelerationistSafetyist');
  });

  it('renders no chips for a bullet with no camp parenthetical', () => {
    const { container } = render(<ConcludingSections content="- No camp attribution here" mdComponents={{}} />);
    expect(container.querySelector('.concluding-camp-chips')).toBeNull();
    expect(screen.getByText('No camp attribution here')).toBeInTheDocument();
  });

  it('leaves an unrecognized-name parenthetical as plain text, no chips', () => {
    const { container } = render(<ConcludingSections content="- Some claim (Moderator)" mdComponents={{}} />);
    expect(container.querySelector('.concluding-camp-chips')).toBeNull();
    expect(screen.getByText('Some claim (Moderator)')).toBeInTheDocument();
  });
});

describe('ConcludingSections — unified bullet style + details disclosure (spec §6, AC5)', () => {
  it('renders a trailing "details" button for an item with sub-points, hidden by default', () => {
    const content = '- Top item\n  - Sub point one\n  - Sub point two';
    const { container } = render(<ConcludingSections content={content} mdComponents={{}} />);
    expect(container.querySelector('.concluding-bullet-subs')).toBeNull();
    const toggle = screen.getByRole('button', { name: 'details ▸' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(toggle);
    expect(container.querySelector('.concluding-bullet-subs')?.textContent).toContain('Sub point one');
    expect(screen.getByRole('button', { name: 'details ▴' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('renders no details button for an item with no sub-points', () => {
    render(<ConcludingSections content="- A plain item, no children" mdComponents={{}} />);
    expect(screen.queryByRole('button', { name: /details/ })).toBeNull();
  });

  it('the item text itself is not a button or clickable element', () => {
    const { container } = render(<ConcludingSections content="- Top item\n  - Sub point" mdComponents={{}} />);
    const item = container.querySelector('.concluding-bullet-item');
    expect(item?.querySelector('.concluding-bullet-text button')).toBeNull();
  });
});

describe('ConcludingSections — overview strip (spec §3, AC1)', () => {
  it('lists only the sections present, with counts on list sections and none on Resolution/Argument Map', () => {
    const content = [
      bullets(2),
      '## Areas of Disagreement',
      bullets(1),
      '## Resolution Analysis',
      '- prose-ish bullet',
      '## Argument Map',
      'some map content',
    ].join('\n');
    render(<ConcludingSections content={content} mdComponents={{}} />);
    const nav = screen.getByRole('navigation', { name: 'Synthesis sections' });
    expect(nav.textContent).toBe('Agreement 2Disagreement 1ResolutionArgument map');
  });

  it('clicking a link scrolls the section into view and expands it if collapsed', () => {
    const content = `${bullets(1)}\n## Argument Map\nmap content`;
    const { container } = render(<ConcludingSections content={content} mdComponents={{}} />);
    const details = container.querySelector('details.concluding-collapsed-section') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    const scrollSpy = vi.fn();
    details.scrollIntoView = scrollSpy;

    fireEvent.click(screen.getByRole('button', { name: /Argument map/ }));
    expect(details.open).toBe(true);
  });
});
