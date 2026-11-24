// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/492: when an evidence document has no title, the model is given the document id in the title
// position. That fallback must be visible: one WARN per evidence brief, with a count.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import { retrieveSourceEvidence, type SourceEvidenceIndex } from './evidenceFromSummaries.js';
import { loadDocTitles } from './evidenceIndexLoader.js';
import { setGlobalRecorder, clearGlobalRecorder } from '../flight-recorder/index.js';

// Only existsSync/readFileSync are mocked, and only by the loadDocTitles tests.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const existsSync = vi.fn(actual.existsSync);
  const readFileSync = vi.fn(actual.readFileSync);
  return { ...actual, default: { ...actual, existsSync, readFileSync }, existsSync, readFileSync };
});

const record = vi.fn();
const t492 = () => record.mock.calls.map(c => c[0]).filter(e => String(e.message).includes('t/492'));

beforeEach(() => {
  record.mockReset();
  setGlobalRecorder({ record } as never);
});
afterEach(() => {
  clearGlobalRecorder();
});

const index: SourceEvidenceIndex = {
  'saf-beliefs-001': {
    facts: [
      { claim: 'Audit deficiencies reached 40 percent in 2022.', label: 'Audit quality', doc_id: 'doc-with-title', specificity: 'precise' },
      { claim: 'The Tay chatbot was exploited within 24 hours in March 2016.', label: 'Tay', doc_id: 'doc-without-title', specificity: 'precise' },
    ],
    keyPoints: [{ stance: 'supports', pov: 'safetyist', point: 'Disclosure helps auditors.', doc_id: 'another-untitled-doc' }],
  },
} as SourceEvidenceIndex;

describe('retrieveSourceEvidence — title fallback is visible (t/492)', () => {
  it('records no WARN when every evidence document has a title', () => {
    const titles = { 'doc-with-title': { title: 'Audit Report' }, 'doc-without-title': { title: 'Enterprise Guide' }, 'another-untitled-doc': 'Legacy Title' };
    const brief = retrieveSourceEvidence(['saf-beliefs-001'], 'safetyist', index, 3, 2, titles as never);
    expect(brief.formattedBlock).toContain('"Enterprise Guide"');
    expect(t492()).toHaveLength(0);
  });

  it('records one WARN with the count and the document ids when some titles are missing', () => {
    const brief = retrieveSourceEvidence(['saf-beliefs-001'], 'safetyist', index, 3, 2, { 'doc-with-title': { title: 'Audit Report' } } as never);
    // The id still goes to the model in the title position; this change only makes that visible.
    expect(brief.formattedBlock).toContain('"doc-without-title"');
    const warns = t492();
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({ level: 'warn', component: 'debate-engine' });
    expect(warns[0].message).toContain('2 of 3 items have no document title');
    expect(warns[0].message).toContain('titles loaded, these documents are missing from them');
    expect(warns[0].data).toMatchObject({ untitled_items: 2, total_items: 3, titles_loaded: true });
    expect([...warns[0].data.doc_ids].sort()).toEqual(['another-untitled-doc', 'doc-without-title']);
  });

  it('says no titles were loaded at all when the title map is absent', () => {
    retrieveSourceEvidence(['saf-beliefs-001'], 'safetyist', index, 3, 2, undefined);
    const warns = t492();
    expect(warns).toHaveLength(1);
    expect(warns[0].message).toContain('3 of 3 items have no document title');
    expect(warns[0].message).toContain('no document titles were loaded at all');
    expect(warns[0].data.titles_loaded).toBe(false);
  });

  it('records nothing when there is no evidence to format', () => {
    const brief = retrieveSourceEvidence(['no-such-node'], 'safetyist', index, 3, 2, undefined);
    expect(brief.formattedBlock).toBe('');
    expect(t492()).toHaveLength(0);
  });
});

describe('loadDocTitles — an identifier-only title counts as no title (t/492, CL ruling t/492#18)', () => {
  const norm = (p: unknown): string => String(p).replace(/\\/g, '/');

  it('leaves out a document whose metadata title is an arXiv id, and keeps one with a real title', async () => {
    const actual = await vi.importActual<typeof import('fs')>('fs');
    const dirent = (name: string) => ({ name, isDirectory: () => true });
    const readdir = vi.spyOn(fs, 'readdirSync').mockImplementation(((p: unknown, ...rest: unknown[]) =>
      (norm(p).endsWith('/fake-sources/sources') || norm(p).endsWith('/fake-sources')
        ? [dirent('170306856v3-2026'), dirent('real-doc-2026')]
        : (actual.readdirSync as (...a: unknown[]) => unknown)(p, ...rest))) as never);
    vi.mocked(fs.existsSync).mockImplementation((p) => (norm(p).includes('/fake-sources') ? true : actual.existsSync(p as never)));
    vi.mocked(fs.readFileSync).mockImplementation(((p: unknown, ...rest: unknown[]) => {
      const s = norm(p);
      if (s.endsWith('.aitriad.json')) return JSON.stringify({ data_root: '.', taxonomy_dir: 'taxonomy/Origin', sources_root: '../fake-sources', sources_dir: 'sources' });
      if (s.includes('/170306856v3-2026/')) return JSON.stringify({ title: '1703.06856v3', url: 'https://arxiv.org/abs/1703.06856v3' });
      if (s.includes('/real-doc-2026/')) return JSON.stringify({ title: 'Counterfactual Fairness', url: 'https://example.org/cf' });
      return (actual.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof fs.readFileSync);
    let titles: ReturnType<typeof loadDocTitles>;
    try {
      titles = loadDocTitles('sess-t492');
    } finally {
      readdir.mockRestore();
      vi.mocked(fs.existsSync).mockImplementation(actual.existsSync);
      vi.mocked(fs.readFileSync).mockImplementation(actual.readFileSync);
    }
    expect(titles?.['real-doc-2026']?.title).toBe('Counterfactual Fairness');
    expect(titles?.['170306856v3-2026']).toBeUndefined();
  });
});

describe('loadDocTitles — a missing sources root is reported (t/492)', () => {
  const norm = (p: unknown): string => String(p).replace(/\\/g, '/');

  it('returns undefined and records a WARN naming the cause when the sources root does not exist', async () => {
    const actual = await vi.importActual<typeof import('fs')>('fs');
    vi.mocked(fs.existsSync).mockImplementation((p) => (norm(p).endsWith('/no-such-sources') ? false : actual.existsSync(p as never)));
    vi.mocked(fs.readFileSync).mockImplementation(((p: unknown, ...rest: unknown[]) => {
      if (norm(p).endsWith('.aitriad.json')) return JSON.stringify({ data_root: '.', taxonomy_dir: 'taxonomy/Origin', sources_root: '../no-such-sources' });
      return (actual.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof fs.readFileSync);
    try {
      expect(loadDocTitles('sess-t492')).toBeUndefined();
    } finally {
      vi.mocked(fs.existsSync).mockImplementation(actual.existsSync);
      vi.mocked(fs.readFileSync).mockImplementation(actual.readFileSync);
    }
    const warns = t492();
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({ level: 'warn', debate_id: 'sess-t492' });
    expect(warns[0].message).toContain('Document titles not loaded');
    expect(warns[0].message).toContain('Evidence will be cited by document id');
  });
});
