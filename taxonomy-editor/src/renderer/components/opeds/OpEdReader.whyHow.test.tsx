// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/173: Why shows the top 4 used elements by relevance plus a collapsed "Other (N)"; How shows
// Raw Prompt / Raw Output per pipeline stage (generation first) and the Op-Ed Methods links.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { OpEdReader, sortByRelevance } from './OpEdReader';
import { stageLabel, orderStages, OPED_HOW_METHODS_LINKS } from './OpEdHowPanel';
import type { OpEdSet, OpEdMember, OpEdGroundingRef, OpEdStage } from '../../../../../lib/oped/types';

vi.mock('@bridge', () => ({ api: { openExternal: vi.fn().mockResolvedValue(undefined) } }));

const ref = (id: string, relevance: string, how = `uses ${id}`): OpEdGroundingRef =>
  ({ node_id: id, label: `Label ${id}`, category: 'Beliefs', pov: 'safetyist', relevance, how_reflected: how });

const stage = (s: string, overrides: Partial<OpEdStage> = {}): OpEdStage =>
  ({ stage: s as OpEdStage['stage'], attempt: 1, model: 'gemini-x', prompt: `${s} prompt`, output: `${s} output`, ...overrides });

function setWith(member: Partial<OpEdMember>): OpEdSet {
  return {
    schema_version: 1, set_id: 's', topic: 't', created_at: '2026-11-10T00:00:00Z',
    params: { wordCount: 800, model: 'gemini-x', outlet: 'The Post' },
    opeds: [{ pov: 'safetyist', status: 'complete', headline: 'H', body: 'B', wordCount: 800, grounding: [], ...member }],
  };
}

const rowIds = () => screen.getAllByRole('button', { name: /^Show Label/ }).map(b => b.textContent);

describe('Why: top 4 by relevance + Other (N) (t/173)', () => {
  beforeAll(() => { Element.prototype.scrollIntoView = vi.fn(); });

  // Stored order is by BDI category, not one ranking (t/170#5), so the UI sorts by relevance.
  const grounding = [
    ref('a', '0.10'), ref('b', '0.90'), ref('c', '0.50'), ref('d', '0.70'),
    ref('e', '0.30'), ref('f', '0.80'), ref('u1', '0.99', 'not directly used'),
  ];

  it('shows the 4 most relevant used elements, highest first', () => {
    render(<OpEdReader set={setWith({ grounding })} />);
    expect(rowIds()).toEqual(['b', 'f', 'd', 'c']);
  });

  it('hides the rest behind a collapsed "Other (N)" that reveals them', () => {
    render(<OpEdReader set={setWith({ grounding })} />);
    const other = screen.getByRole('button', { name: 'Other (2)' });
    expect(other.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(other);
    expect(rowIds()).toEqual(['b', 'f', 'd', 'c', 'e', 'a']);
  });

  it('keeps the unused toggle after Other, and the Why count covers every element', () => {
    render(<OpEdReader set={setWith({ grounding })} />);
    expect(screen.getByText('Why (7 elements)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show 1 unused element' }));
    expect(rowIds()).toContain('u1');
  });

  it('has no Other expander with 4 or fewer used elements', () => {
    render(<OpEdReader set={setWith({ grounding: grounding.slice(0, 4) })} />);
    expect(screen.queryByRole('button', { name: /^Other/ })).toBeNull();
  });

  it('sorts non-numeric relevance last and keeps ties in stored order', () => {
    expect(sortByRelevance([ref('x', 'n/a'), ref('y', '0.5'), ref('z', '0.5')]).map(g => g.node_id)).toEqual(['y', 'z', 'x']);
  });
});

describe('How: per-stage raw prompt and output (t/173)', () => {
  const openHow = () => fireEvent.click(screen.getByRole('button', { name: 'How' }));

  it('lists generation first, then the other stages in pipeline order, with model and attempt', () => {
    const stages = [stage('source-brief'), stage('generation'), stage('readability-edit'), stage('readability-edit', { attempt: 2 })];
    expect(orderStages(stages).map(stageLabel)).toEqual(['Generation', 'Source brief', 'Readability edit', 'Readability edit (attempt 2)']);
    render(<OpEdReader set={setWith({ stages })} />);
    openHow();
    // Raw Prompt is open; its first stage (generation) is expanded, the rest collapsed.
    expect(screen.getByLabelText('Raw prompt: Generation').textContent).toBe('generation prompt');
    expect(screen.queryByLabelText('Raw prompt: Source brief')).toBeNull();
    const srcToggle = screen.getAllByRole('button', { name: 'Source brief · gemini-x' })[0];
    fireEvent.click(srcToggle);
    expect(screen.getByLabelText('Raw prompt: Source brief').textContent).toBe('source-brief prompt');
  });

  it('shows a failed call\'s error in Raw Output instead of an empty box', () => {
    render(<OpEdReader set={setWith({ stages: [stage('generation', { output: '', error: 'quota exceeded' })] })} />);
    openHow();
    fireEvent.click(screen.getByRole('button', { name: 'Raw Output' }));
    expect(screen.getByText('This call failed: quota exceeded')).toBeTruthy();
  });

  it('shows an unknown stage name verbatim (t/171#4)', () => {
    expect(stageLabel({ stage: 'future-stage' as OpEdStage['stage'], attempt: 1 })).toBe('future-stage');
  });

  it('shows owner-only message for op-eds without stages', () => {
    render(<OpEdReader set={setWith({})} />);
    openHow();
    expect(screen.getByText('Raw prompts and outputs are visible only to the op-ed\'s author.')).toBeTruthy();
  });

  it('links the three Op-Ed theory docs under Methods', () => {
    render(<OpEdReader set={setWith({})} />);
    openHow();
    fireEvent.click(screen.getByRole('button', { name: 'Methods' }));
    const list = screen.getByRole('list');
    expect(within(list).getAllByRole('button').map(b => b.textContent)).toEqual(['Theory of Success', 'Theory of Operations', 'Theory of Outlets']);
    expect(OPED_HOW_METHODS_LINKS.every(l => /docs\/ux\/oped-tool-theory-of-(success|operations|outlets)\.md$/.test(l.url))).toBe(true);
  });
});
