// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/492: document titles supplied by the host. The mapping from the sources index, the engine
// preferring the host's titles over its filesystem read, and the effect on the evidence block.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { docMetaMapFromSourcesIndex } from './docTitlesFromSourcesIndex.js';
import { retrieveSourceEvidence, linkifyEvidenceCitations, type SourceEvidenceIndex } from './evidenceFromSummaries.js';
import { loadDocTitles } from './evidenceIndexLoader.js';
import { DebateEngine } from './debateEngine.js';
import { setGlobalRecorder, clearGlobalRecorder } from '../flight-recorder/index.js';

// The filesystem lookup is replaced, so the tests can tell which source the engine used.
vi.mock('./evidenceIndexLoader.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./evidenceIndexLoader.js')>()),
  loadDocTitles: vi.fn(),
}));

const record = vi.fn();
beforeEach(() => { record.mockReset(); setGlobalRecorder({ record } as never); });
afterEach(() => { clearGlobalRecorder(); vi.mocked(loadDocTitles).mockReset(); });

const index = {
  schema_version: 1,
  docs: [
    { id: 'guide-2026', title: 'AI Governance Framework: The Complete Enterprise Guide', url: 'https://example.org/guide', resolved_url: 'https://example.org/guide-final', provenance: [{ scheme: 'doi', id: 'doi:10.1/guide' }] },
    { id: 'arxiv-2026', title: '  1703.06856v3  ', url: 'https://arxiv.org/abs/1703.06856v3' },
    { id: 'untitled-2026', url: 'https://example.org/untitled' },
    { id: 'blank-title-2026', title: '   ' },
    { id: 'bare-2026', title: 'Bare Title' },
  ],
};

describe('docMetaMapFromSourcesIndex (t/492)', () => {
  it('maps each titled entry to title, link and provenance label, as loadDocTitles does', () => {
    const map = docMetaMapFromSourcesIndex(index)!;
    expect(map['guide-2026']).toEqual({ title: 'AI Governance Framework: The Complete Enterprise Guide', resolved_url: 'https://example.org/guide-final', provenance_label: 'doi:10.1/guide' });
    // resolved_url falls back to url; the title is trimmed.
    expect(map['arxiv-2026']).toEqual({ title: '1703.06856v3', resolved_url: 'https://arxiv.org/abs/1703.06856v3' });
    expect(map['bare-2026']).toEqual({ title: 'Bare Title' });
  });

  it('leaves out entries with no title or a blank one, so they are still cited by id with the WARN', () => {
    const map = docMetaMapFromSourcesIndex(index)!;
    expect(Object.keys(map).sort()).toEqual(['arxiv-2026', 'bare-2026', 'guide-2026']);
  });

  it('returns undefined for a null, empty or titleless index, so the engine falls back to its own lookup', () => {
    expect(docMetaMapFromSourcesIndex(null)).toBeUndefined();
    expect(docMetaMapFromSourcesIndex(undefined)).toBeUndefined();
    expect(docMetaMapFromSourcesIndex({})).toBeUndefined();
    expect(docMetaMapFromSourcesIndex({ docs: [] })).toBeUndefined();
    expect(docMetaMapFromSourcesIndex({ docs: [{ id: 'untitled-2026' }] })).toBeUndefined();
  });
});

describe('DebateEngine.docTitles prefers the host-supplied titles (t/492)', () => {
  function engineWith(config: Record<string, unknown>): { docTitles: unknown } {
    const engine = Object.create(DebateEngine.prototype);
    engine.session = { id: 'sess-t492' };
    engine.config = config;
    return engine;
  }

  const fromDisk = { 'disk-doc': { title: 'From The Sources Directory' } };

  it('uses config.docTitles and does not read the filesystem', () => {
    vi.mocked(loadDocTitles).mockReturnValue(fromDisk);
    const supplied = docMetaMapFromSourcesIndex(index)!;
    const engine = engineWith({ docTitles: supplied });
    expect(engine.docTitles).toBe(supplied);
    expect(loadDocTitles).not.toHaveBeenCalled();
  });

  it('reads the sources directory, as before, when the host supplies nothing', () => {
    vi.mocked(loadDocTitles).mockReturnValue(fromDisk);
    const engine = engineWith({});
    expect(engine.docTitles).toBe(fromDisk);
    expect(loadDocTitles).toHaveBeenCalledTimes(1);
    expect(loadDocTitles).toHaveBeenCalledWith('sess-t492');
  });
});

describe('the evidence block with host-supplied titles (t/492)', () => {
  const evidence: SourceEvidenceIndex = {
    'saf-beliefs-001': {
      facts: [
        { claim: 'The Tay chatbot was exploited within 24 hours in March 2016.', label: 'Tay', doc_id: 'guide-2026', specificity: 'precise' },
        { claim: 'A claim from a document with no title.', label: 'Untitled', doc_id: 'untitled-2026', specificity: 'precise' },
      ],
      keyPoints: [],
    },
  } as SourceEvidenceIndex;

  it('gives the model the title where there is one, the id where there is none, and WARNs once for the latter', () => {
    const titles = docMetaMapFromSourcesIndex(index);
    const brief = retrieveSourceEvidence(['saf-beliefs-001'], 'safetyist', evidence, 3, 2, titles);
    expect(brief.formattedBlock).toContain('"AI Governance Framework: The Complete Enterprise Guide"');
    expect(brief.formattedBlock).not.toContain('"guide-2026"');
    expect(brief.formattedBlock).toContain('"untitled-2026"');
    const warns = record.mock.calls.map(c => c[0]).filter(e => String(e.message).includes('t/492'));
    expect(warns).toHaveLength(1);
    expect(warns[0].message).toContain('1 of 2 items have no document title');
    expect(warns[0].data.doc_ids).toEqual(['untitled-2026']);
  });

  it('lets a cited title be linked after the draft', () => {
    const titles = docMetaMapFromSourcesIndex(index);
    const out = linkifyEvidenceCitations('As AI Governance Framework: The Complete Enterprise Guide shows, Tay failed fast.', titles);
    expect(out).toContain('](https://example.org/guide-final)');
  });
});
