// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { OpEdReader } from './OpEdReader';
import type { OpEdSet, OpEdMember } from '../../../../../lib/oped/types';

function member(overrides: Partial<OpEdMember> = {}): OpEdMember {
  return {
    pov: 'safetyist',
    status: 'complete',
    headline: 'Mandatory Audits Are the Floor',
    subtitle: 'Why the oversight bill must go further',
    body: 'The lede opens on the news hook.\n\nA second paragraph.',
    wordCount: 812,
    grounding: [],
    ...overrides,
  };
}

function makeSet(members: OpEdMember[], overrides: Partial<OpEdSet> = {}): OpEdSet {
  return {
    schema_version: 1,
    set_id: 'set-1',
    topic: 'Audits',
    params: { wordCount: 800, model: 'gemini-3.6-flash', outlet: 'The Washington Post' },
    created_at: '2026-08-08T12:00:00Z',
    opeds: members,
    ...overrides,
  };
}

describe('OpEdReader — single voice', () => {
  beforeAll(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('renders no tab strip and the headline as the sole h1', () => {
    render(<OpEdReader set={makeSet([member()])} />);
    expect(screen.queryByRole('tablist')).toBeNull();
    const h1s = screen.getAllByRole('heading', { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0].textContent).toBe('Mandatory Audits Are the Floor');
  });

  it('renders the subtitle and camp label in the accent strip', () => {
    render(<OpEdReader set={makeSet([member()])} />);
    expect(screen.getByText('Why the oversight bill must go further')).toBeTruthy();
    expect(screen.getByText(/SAFETYIST/)).toBeTruthy();
  });

  it('shows the voice-only notice when grounding is empty', () => {
    render(<OpEdReader set={makeSet([member({ grounding: [] })])} />);
    expect(screen.getByText(/Written from voice alone/i)).toBeTruthy();
  });

  it('renders a grounding table (not the voice-only notice) when grounding is present', () => {
    render(<OpEdReader set={makeSet([member({
      grounding: [{ node_id: 'saf-belief-014', label: 'A belief', category: 'Belief', pov: 'safetyist', relevance: '0.82', how_reflected: 'Grounds the claim' }],
    })])} />);
    expect(screen.queryByText(/Written from voice alone/i)).toBeNull();
    // t/4634: the ID button moved to its own column (visible text is the node_id now); its
    // accessible name is `Show ${label}` per Design's spec.
    const btn = screen.getByRole('button', { name: 'Show A belief' });
    expect(btn).toBeTruthy();
    expect(btn.textContent).toBe('saf-belief-014');
    expect(btn.getAttribute('title')).toBe('saf-belief-014');
    // Element is now plain text, not a button.
    expect(screen.getByText('A belief')).toBeTruthy();
    expect(screen.getByText('Grounds the claim')).toBeTruthy();
  });

  it('drops the Type and Relevance columns, and hides "not directly used" rows behind a toggle (t/2703, t/4634)', () => {
    render(<OpEdReader set={makeSet([member({
      grounding: [
        { node_id: 'acc-belief-001', label: 'Unused', category: 'Belief', pov: 'accelerationist', relevance: '0.15', how_reflected: 'not directly used' },
        { node_id: 'saf-belief-014', label: 'Used', category: 'Belief', pov: 'safetyist', relevance: '0.82', how_reflected: 'Grounds the claim' },
      ],
    })])} />);
    // t/4634: columns are now ID / Element / Reflected in the op-ed only.
    expect(screen.queryByRole('columnheader', { name: 'Type' })).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Relevance' })).toBeNull();
    expect(screen.getByRole('columnheader', { name: 'ID' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Element' })).toBeTruthy();
    // The used row shows; the 'not directly used' row is hidden by default.
    expect(screen.getByRole('button', { name: 'Show Used' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show Unused' })).toBeNull();
    // The toggle reveals the hidden row…
    fireEvent.click(screen.getByRole('button', { name: /show 1 unused element/i }));
    expect(screen.getByRole('button', { name: 'Show Unused' })).toBeTruthy();
    // …and toggling again re-hides it.
    fireEvent.click(screen.getByRole('button', { name: /hide 1 unused element/i }));
    expect(screen.queryByRole('button', { name: 'Show Unused' })).toBeNull();
  });

  it('shows no unused-toggle when every element is reflected (t/2703)', () => {
    render(<OpEdReader set={makeSet([member({
      grounding: [{ node_id: 'saf-belief-014', label: 'Used', category: 'Belief', pov: 'safetyist', relevance: '0.82', how_reflected: 'Grounds the claim' }],
    })])} />);
    expect(screen.queryByRole('button', { name: /unused element/i })).toBeNull();
  });

  it('renders document_claims list in the detail card when present (t/2717)', () => {
    render(<OpEdReader set={makeSet([member({
      grounding: [{ node_id: 'saf-belief-014', label: 'A belief', category: 'Belief', pov: 'safetyist', relevance: '0.82', how_reflected: 'Grounds the claim', document_claims: ['Safety incidents doubled last year', 'Only 3 labs share proactively'] }],
    })])} />);
    fireEvent.click(screen.getByRole('button', { name: 'A belief' }));
    expect(screen.getByText('Addresses these source claims:')).toBeTruthy();
    expect(screen.getByText('Safety incidents doubled last year')).toBeTruthy();
    expect(screen.getByText('Only 3 labs share proactively')).toBeTruthy();
  });

  it('renders nothing for document_claims when absent (t/2717)', () => {
    render(<OpEdReader set={makeSet([member({
      grounding: [{ node_id: 'saf-belief-014', label: 'A belief', category: 'Belief', pov: 'safetyist', relevance: '0.82', how_reflected: 'Grounds the claim' }],
    })])} />);
    fireEvent.click(screen.getByRole('button', { name: 'A belief' }));
    expect(screen.queryByText('Addresses these source claims:')).toBeNull();
  });
});

describe('OpEdReader — failed / cancelled member', () => {
  it('renders an honest notice instead of a body for a failed voice', () => {
    render(<OpEdReader set={makeSet([member({ status: 'failed' })])} />);
    expect(screen.getByText(/This voice failed to generate/i)).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
  });

  it('renders a cancelled notice for a cancelled voice', () => {
    render(<OpEdReader set={makeSet([member({ status: 'cancelled' })])} />);
    expect(screen.getByText(/was cancelled/i)).toBeTruthy();
  });
});

describe('OpEdReader — multi-voice set', () => {
  const set = makeSet([
    member({ pov: 'skeptic', headline: 'Skeptic headline' }),
    member({ pov: 'safetyist', headline: 'Safetyist headline' }),
  ]);

  it('renders a tablist with one tab per voice', () => {
    render(<OpEdReader set={set} />);
    expect(screen.getByRole('tablist')).toBeTruthy();
    expect(screen.getAllByRole('tab')).toHaveLength(2);
  });

  it('shows the first voice active by default', () => {
    render(<OpEdReader set={set} />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    expect(tabs[1].getAttribute('aria-selected')).toBe('false');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Skeptic headline');
  });

  it('clicking a tab swaps the article', () => {
    render(<OpEdReader set={set} />);
    fireEvent.click(screen.getAllByRole('tab')[1]);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Safetyist headline');
  });

  it('ArrowRight moves the active tab (roving)', () => {
    render(<OpEdReader set={set} />);
    const tabs = screen.getAllByRole('tab');
    fireEvent.keyDown(tabs[0], { key: 'ArrowRight' });
    expect(screen.getAllByRole('tab')[1].getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Safetyist headline');
  });

  it('only one h1 is present at a time (sole-h1 invariant)', () => {
    render(<OpEdReader set={set} />);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  // t/3486: deep-linkable in-app URLs — the reader seeds its starting tab from a route
  // restore and reports tab changes back so the URL can track the active camp.
  it('t/3486: initialPov seeds the starting active tab', () => {
    render(<OpEdReader set={set} initialPov="safetyist" />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Safetyist headline');
  });

  it('t/3486: falls back to the first tab when initialPov matches no member', () => {
    render(<OpEdReader set={set} initialPov="accelerationist" />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
  });

  it('t/3486: onPovChange fires with the newly active pov on click and keyboard nav', () => {
    const onPovChange = vi.fn();
    render(<OpEdReader set={set} onPovChange={onPovChange} />);
    fireEvent.click(screen.getAllByRole('tab')[1]);
    expect(onPovChange).toHaveBeenCalledWith('safetyist');

    onPovChange.mockClear();
    fireEvent.keyDown(screen.getAllByRole('tab')[1], { key: 'ArrowRight' });
    expect(onPovChange).toHaveBeenCalledWith('skeptic');
  });
});

describe('OpEdReader — new member fields (t/2849)', () => {
  beforeAll(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('renders byline, disclosure, and the "What this op-ed did" closing section', () => {
    render(<OpEdReader set={makeSet([member({
      byline: 'By the Safetyist Camp, as modeled in AI Rosetta Stone',
      disclosure: 'Generated by AI Rosetta Stone to illustrate the Safetyist perspective.',
      rhetorical_meta: 'It opened on a concrete harm, then generalized to policy.',
    })])} />);
    expect(screen.getByText(/By the Safetyist Camp/)).toBeTruthy();
    expect(screen.getByText(/Generated by AI Rosetta Stone to illustrate/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'What this op-ed did' })).toBeTruthy();
    expect(screen.getByText(/opened on a concrete harm/)).toBeTruthy();
    // the closing-section heading is an h2 — the headline stays the sole h1
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('omits the closing section and byline when those fields are empty', () => {
    render(<OpEdReader set={makeSet([member({ byline: '', disclosure: '', rhetorical_meta: '' })])} />);
    expect(screen.queryByText('What this op-ed did')).toBeNull();
  });
});

// t/3992: a tagged member shows its wing scope. Uses the committed registry's skeptic "critical" tag
// (t/3956), so the label is the real registry label.
describe('OpEdReader — wing scope (t/3992)', () => {
  beforeAll(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });
  const tagged = (mode: 'scope' | 'prioritize', excludedUntagged: number) =>
    member({ pov: 'skeptic', tag: { pov: 'skeptic', tag: 'critical', mode, included: 12, excludedUntagged } });

  it('Scope shows the wing and how many nodes without its tag were excluded', () => {
    render(<OpEdReader set={makeSet([tagged('scope', 31)])} />);
    expect(screen.getByRole('note', { name: '' }).textContent).toBe('Skeptic · Critical wing (scope; 31 not tagged Critical excluded)');
  });

  it('Prioritize shows no exclusion count (0 by construction would read as full coverage)', () => {
    render(<OpEdReader set={makeSet([tagged('prioritize', 0)])} />);
    const line = screen.getByText(/Critical wing/);
    expect(line.textContent).toBe('Skeptic · Critical wing (prioritized)');
    expect(line.textContent).not.toMatch(/excluded/);
  });

  it('an untagged member shows no scope line', () => {
    render(<OpEdReader set={makeSet([member()])} />);
    expect(screen.queryByText(/ wing \(/)).toBeNull();
  });
});
