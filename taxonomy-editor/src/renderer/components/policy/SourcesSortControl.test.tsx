// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4389: Sources panels sort A–Z by title by default, or by references; the choice is remembered per viewer.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { SourceReference, SourceCardMeta } from '../../../../../lib/sourceIndex/types';

const getNodeSources = vi.hoisted(() => vi.fn());
vi.mock('@bridge', () => ({ api: { getNodeSources, openExternal: vi.fn() } }));
const record = vi.hoisted(() => vi.fn());
vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record }) }));

const { SourcesPanel, __resetSourcesCacheForTests } = await import('./SourcesPanel');
const { SOURCES_SORT_STORAGE_KEY } = await import('./SourcesSortControl');

const ref = (doc: string, point: string, title = doc): SourceReference => ({
  docId: doc, canonicalDocId: doc, title, pov: 'accelerationist', stance: 'aligned',
  point, verbatim: point, excerptContext: '', url: null, sourceType: 'paper', datePublished: '',
});
const card = (title: string): SourceCardMeta => ({ title, url: null, authors: [], datePublished: '', topicTags: [], oneLiner: null });

// "zebra" has the most references; "apple" the fewest. The card title overrides doc-b's slug title.
const PAYLOAD = {
  sources: [
    ref('doc-z', 'p1', 'zebra report'), ref('doc-z', 'p2', 'zebra report'), ref('doc-z', 'p3', 'zebra report'),
    ref('doc-b', 'p4', 'doc-b'), ref('doc-b', 'p5', 'doc-b'),
    ref('doc-a', 'p6', 'Apple Paper'),
  ],
  cards: { 'doc-b': card('Mango study') } as Record<string, SourceCardMeta>,
  indexVersion: 1,
};

const rowTitles = () => [...document.querySelectorAll('.sources-panel-doc-title')].map(e => e.textContent);

beforeEach(() => {
  localStorage.clear();
  getNodeSources.mockReset().mockResolvedValue(PAYLOAD);
  record.mockClear();
  __resetSourcesCacheForTests();
});
afterEach(() => { vi.restoreAllMocks(); });

describe('SourcesPanel sort (t/4389)', () => {
  it('defaults to title A–Z, using the source card title when there is one', async () => {
    render(<SourcesPanel nodeId="n1" />);
    await screen.findByText(/6 references across 3 documents/);
    expect(rowTitles()).toEqual(['Apple Paper', 'Mango study', 'zebra report']);
    expect(screen.getByRole('button', { name: 'Title (A–Z)' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('the toggle switches to most references first', async () => {
    render(<SourcesPanel nodeId="n1" />);
    await screen.findByText(/6 references/);
    fireEvent.click(screen.getByRole('button', { name: 'References (most first)' }));
    expect(rowTitles()).toEqual(['zebra report', 'Mango study', 'Apple Paper']);
  });

  it('the choice is remembered across a remount', async () => {
    render(<SourcesPanel nodeId="n1" />);
    await screen.findByText(/6 references/);
    fireEvent.click(screen.getByRole('button', { name: 'References (most first)' }));
    expect(localStorage.getItem(SOURCES_SORT_STORAGE_KEY)).toBe('count');
    cleanup();
    render(<SourcesPanel nodeId="n1" />);
    await screen.findByText(/6 references/);
    expect(rowTitles()[0]).toBe('zebra report');
  });

  it('an unknown stored value falls back to title order', async () => {
    localStorage.setItem(SOURCES_SORT_STORAGE_KEY, 'bogus');
    render(<SourcesPanel nodeId="n1" />);
    await screen.findByText(/6 references/);
    expect(rowTitles()[0]).toBe('Apple Paper');
  });

  it('fault arm: storage that throws on read and write still renders, in the default order, and the toggle still works', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('SecurityError'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError'); });
    render(<SourcesPanel nodeId="n1" />);
    await screen.findByText(/6 references/);
    expect(rowTitles()[0]).toBe('Apple Paper');
    fireEvent.click(screen.getByRole('button', { name: 'References (most first)' }));
    expect(rowTitles()[0]).toBe('zebra report'); // applies for this visit even though it can't be saved
    const notes = record.mock.calls.map(c => c[0]).filter(e => e.component === 'sources-panel' && e.type === 'system.error');
    expect(notes.map(n => n.message)).toEqual(expect.arrayContaining([
      expect.stringContaining('read failed'), expect.stringContaining('write failed'),
    ]));
  });
});
