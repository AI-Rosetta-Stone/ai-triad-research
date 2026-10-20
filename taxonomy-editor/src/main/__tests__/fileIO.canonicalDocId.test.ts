// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/4341 (Electron parity for t/4333/t/4334): buildNodeSourceIndex() must group references
 * into canonicalDocId the same way the server's buildNodeSourceIndex (t/4334,
 * src/server/storage/nodeSourceIndex.ts) does, via the shared pure algorithm in
 * lib/sourceIndex/types.ts. Mirrors the server's own test fixtures
 * (src/server/__tests__/nodeSourceIndex.test.ts) so the two suites assert the same scenarios.
 *
 * Point AI_TRIAD_DATA_ROOT at a temp dir BEFORE fileIO loads — SUMMARIES_DIR/SOURCES_DIR_LEGACY
 * are captured at module-eval (vi.hoisted runs before the imports below). fileIO imports
 * electron (app), so it's stubbed to load under vitest — same pattern as edgesFormat.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const hoisted = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMPDIR || '/tmp';
  const root = `${base}/t4341-canonical-id-${process.pid}-${Date.now()}`;
  process.env.AI_TRIAD_DATA_ROOT = root;
  return { root };
});

vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd(), isPackaged: false } }));

// Imported AFTER the hoisted env + electron mock so SUMMARIES_DIR/getSourcesDir resolve into
// the temp root.
import { buildNodeSourceIndex } from '../fileIO.js';
import { computeCanonicalDocIds, type CanonicalIdDocMeta } from '../../../../lib/sourceIndex/types.js';

let summariesDir: string;
let sourcesDir: string;

function writeSummary(docId: string, nodeId: string): void {
  const summary = {
    pov_summaries: {
      accelerationist: {
        key_points: [{ taxonomy_node_id: nodeId, stance: 'supports', point: 'a point', verbatim: 'v', excerpt_context: 'c' }],
      },
    },
  };
  fs.writeFileSync(path.join(summariesDir, `${docId}.json`), JSON.stringify(summary));
}

function writeSourceMeta(docId: string, meta: Record<string, unknown>): void {
  const dir = path.join(sourcesDir, docId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify(meta));
}

beforeEach(() => {
  summariesDir = path.join(hoisted.root, 'summaries');
  sourcesDir = path.join(hoisted.root, 'sources');
  fs.mkdirSync(summariesDir, { recursive: true });
  fs.mkdirSync(sourcesDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(hoisted.root, { recursive: true, force: true });
});

describe('buildNodeSourceIndex canonicalDocId grouping (t/4341, Electron parity for t/4333/t/4334)', () => {
  it('acc-desires-021 collapses split parts and re-ingested outlet copies to 2 rows, not 7 (same scenario as t/4334#2)', () => {
    const nodeId = 'acc-desires-021';
    const base = 'eight-ways-ai-will-shape-geopolitics-2026-2026';
    const ac = 'eight-ways-ai-will-shape-geopolitics-2026-atlantic-council-2026';
    writeSourceMeta(base, { title: 'Eight ways AI will shape geopolitics in 2026', url: 'https://www.brookings.edu/articles/x/' });
    writeSourceMeta(`${base}-1`, { title: 'Eight ways AI will shape geopolitics in 2026', url: 'https://etcjournal.com/y' });
    writeSourceMeta(`${base}-2`, { title: 'Eight ways AI will shape geopolitics in 2026', url: 'https://example.com/z' });
    writeSourceMeta(`${base}-3`, { title: 'Eight ways AI will shape geopolitics in 2026', url: 'https://example.com/w' });
    writeSourceMeta(ac, { title: 'Eight ways AI will shape geopolitics in 2026   Atlantic Council', url: 'https://www.atlanticcouncil.org/dispatches/x/' });
    writeSourceMeta(`${ac}-1`, { title: 'Eight ways AI will shape geopolitics in 2026   Atlantic Council', url: 'https://example.com/ac1' });
    writeSourceMeta(`${ac}-2`, { title: 'Eight ways AI will shape geopolitics in 2026   Atlantic Council', url: 'https://example.com/ac2' });

    for (const id of [base, `${base}-1`, `${base}-2`, `${base}-3`, ac, `${ac}-1`, `${ac}-2`]) writeSummary(id, nodeId);

    const index = buildNodeSourceIndex();
    const refs = index[nodeId];
    expect(refs).toHaveLength(7); // all 7 references still present...

    const distinctCanonicalIds = new Set(refs.map(r => r.canonicalDocId));
    expect(distinctCanonicalIds.size).toBe(2); // ...but collapsed to 2 real documents (one per outlet)
  });

  it('does not merge two different documents with similar titles (false-merge guard)', () => {
    writeSourceMeta('doc-a-2026', { title: 'AI Governance in 2026', url: 'https://example.com/a' });
    writeSourceMeta('doc-b-2026', { title: 'AI Governance Report 2026', url: 'https://example.com/b' });
    writeSummary('doc-a-2026', 'n1');
    writeSummary('doc-b-2026', 'n1');

    const index = buildNodeSourceIndex();
    const ids = index['n1'].map(r => r.canonicalDocId);
    expect(new Set(ids).size).toBe(2);
  });

  it('is governed by the same shared computeCanonicalDocIds the server uses, not a local reimplementation (t/4341 AC1/AC2)', () => {
    // A -1 suffix split, a URL match, and a title match — one case per tier the ticket covers.
    writeSourceMeta('report-2026', { title: 'Annual Report', url: 'https://example.com/report' });
    writeSourceMeta('report-2026-1', { title: 'Annual Report', url: 'https://example.com/report-mirror' });
    writeSourceMeta('reprint-x', { title: 'Same Article', url: 'https://outlet-a.example.com/x' });
    writeSourceMeta('reprint-y', { title: 'Same Article', url: 'https://outlet-a.example.com/x' }); // same URL → tier 2
    writeSourceMeta('title-match-a', { title: 'Distinct Wording Here', url: 'https://outlet-b.example.com/a' });
    writeSourceMeta('title-match-b', { title: 'Distinct Wording Here', url: 'https://outlet-c.example.com/b' }); // same normalized title → tier 4
    for (const id of ['report-2026', 'report-2026-1', 'reprint-x', 'reprint-y', 'title-match-a', 'title-match-b']) {
      writeSummary(id, 'n-parity');
    }

    const index = buildNodeSourceIndex();
    const refs = index['n-parity'];

    // Independently recompute via the same shared function with the same universe of docIds
    // and per-doc {url, title} — this is exactly what the server's applyCanonicalDocIds does
    // (src/server/storage/nodeSourceIndex.ts), so a match here is structural parity, not a
    // coincidence of two independently-written algorithms agreeing by chance.
    const docIds = refs.map(r => r.docId);
    const meta: Record<string, CanonicalIdDocMeta> = {};
    for (const r of refs) meta[r.docId] = { url: r.url, title: r.title };
    const expected = computeCanonicalDocIds(docIds, meta);

    for (const r of refs) expect(r.canonicalDocId).toBe(expected[r.docId]);

    // Sanity-check the groupings actually collapsed as the fixture intends.
    const byCanonical = new Map<string, string[]>();
    for (const r of refs) byCanonical.set(r.canonicalDocId, [...(byCanonical.get(r.canonicalDocId) ?? []), r.docId]);
    expect(byCanonical.size).toBe(3); // 6 docIds → 3 canonical documents
  });
});
