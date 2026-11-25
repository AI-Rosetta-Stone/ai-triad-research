// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/585 (t/572, spec 6.2 / 7.1): the desktop node-source index folds a legacy chunk into its
 * base only when the legacy-chunk manifest lists it. Runs the shared fixture's
 * `chunk_union_cases` (tests/fixtures/evidence-union-cases.json, the same cases the lib and
 * PowerShell readers assert) through buildNodeSourceIndex against a temp data root, with each
 * case's own manifest swapped in for the shared file.
 *
 * Point AI_TRIAD_DATA_ROOT at a temp dir BEFORE fileIO loads, the same pattern as
 * fileIO.duplicateOf.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const hoisted = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMPDIR || '/tmp';
  const root = `${base}/t585-legacy-chunks-${process.pid}-${Date.now()}`;
  process.env.AI_TRIAD_DATA_ROOT = root;
  return { root, manifest: {} as Record<string, string> };
});

vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd(), isPackaged: false } }));
vi.mock('../legacyChunkManifest.js', () => ({ readLegacyChunkManifest: () => hoisted.manifest }));

import { buildNodeSourceIndex } from '../fileIO.js';

interface FixtureDoc { has_source: boolean; mark?: string | null; summary?: unknown }
interface ChunkUnionCase {
  name: string;
  canonical: string;
  docs: Record<string, FixtureDoc>;
  manifest: Record<string, string>;
  expected: Record<string, Array<{ field: string; quote: string }>>;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(
  path.resolve(here, '../../../../tests/fixtures/evidence-union-cases.json'), 'utf-8',
)) as { chunk_union_cases: ChunkUnionCase[] };

function writeDocs(docs: Record<string, FixtureDoc>): void {
  const summariesDir = path.join(hoisted.root, 'summaries');
  const sourcesDir = path.join(hoisted.root, 'sources');
  fs.mkdirSync(summariesDir, { recursive: true });
  fs.mkdirSync(sourcesDir, { recursive: true });
  for (const [id, doc] of Object.entries(docs)) {
    if (doc.has_source) {
      fs.mkdirSync(path.join(sourcesDir, id), { recursive: true });
      const meta = { title: `Title of ${id}`, url: `https://example.com/${id}`, ...(doc.mark ? { duplicate_of: doc.mark } : {}) };
      fs.writeFileSync(path.join(sourcesDir, id, 'metadata.json'), JSON.stringify(meta));
    }
    if (doc.summary) fs.writeFileSync(path.join(summariesDir, `${id}.json`), JSON.stringify(doc.summary));
  }
}

/** The refs on `node` attributed to `docId`, as quotes (verbatim, else point: spec 7.1). */
const quotesFor = (index: ReturnType<typeof buildNodeSourceIndex>, node: string, docId: string) =>
  (index[node] ?? []).filter(r => r.docId === docId).map(r => r.verbatim || r.point);

beforeEach(() => { hoisted.manifest = {}; });
afterEach(() => { fs.rmSync(hoisted.root, { recursive: true, force: true }); });

describe('buildNodeSourceIndex: legacy-chunk manifest (t/585, fixture chunk_union_cases)', () => {
  for (const c of fixture.chunk_union_cases) {
    it(c.name, () => {
      writeDocs(c.docs);
      hoisted.manifest = c.manifest;
      const index = buildNodeSourceIndex();

      for (const [node, links] of Object.entries(c.expected)) {
        const expectedQuotes = links.filter(l => l.field === 'key_point').map(l => l.quote);
        expect(quotesFor(index, node, c.canonical)).toEqual(expectedQuotes);
      }
      // A group member (a listed chunk or a marked copy) never survives as its own source.
      const members = Object.keys(c.docs).filter(id => id !== c.canonical && (c.manifest[id] || c.docs[id].mark));
      for (const refs of Object.values(index)) {
        expect(refs.filter(r => members.includes(r.docId))).toEqual([]);
      }
      // A kept chunk link carries the canonical's card fields, not the chunk's.
      for (const refs of Object.values(index)) {
        for (const r of refs.filter(x => x.docId === c.canonical)) {
          expect(r.canonicalDocId).toBe(c.canonical);
          expect(r.title).toBe(`Title of ${c.canonical}`);
        }
      }
    });
  }

  it('an unlisted -N document stays its own source with its own links', () => {
    const c = fixture.chunk_union_cases.find(x => Object.keys(x.manifest).length === 0)!;
    writeDocs(c.docs);
    const index = buildNodeSourceIndex();
    const unlisted = Object.keys(c.docs).find(id => id !== c.canonical)!;
    expect(quotesFor(index, 'n1', unlisted)).toEqual(['A different document that happens to share the stem.']);
  });

  it('without the manifest no chunk is folded (pre-t/572 behaviour)', () => {
    const c = fixture.chunk_union_cases[0];
    writeDocs(c.docs);
    hoisted.manifest = {};
    const index = buildNodeSourceIndex();
    expect(quotesFor(index, 'n1', 'd-2026-1')).toHaveLength(2);
  });

  it('a listed chunk whose base does not exist is left unfolded and named (missing_base)', () => {
    writeDocs({
      'o-2026-1': { has_source: false, summary: { pov_summaries: { accelerationist: { key_points: [{ taxonomy_node_id: 'n1', verbatim: 'orphan chunk' }] } } } },
    });
    hoisted.manifest = { 'o-2026-1': 'o-2026' };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const index = buildNodeSourceIndex();
    expect(quotesFor(index, 'n1', 'o-2026-1')).toEqual(['orphan chunk']);
    expect(err.mock.calls.some(a => String(a[0]).includes('missing_base') && String(a[0]).includes('o-2026-1'))).toBe(true);
    err.mockRestore();
  });
});
