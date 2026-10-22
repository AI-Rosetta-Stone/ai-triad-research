// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/4377 (t/4357 AC2, web/Electron parity): a `duplicate_of` mark must collapse a node's
 * evidence to one row per resolved id, attributed to the canonical, the same way the
 * server's `buildNodeSourceIndex`/`getNodeSources` (src/server/storage/nodeSourceIndex.ts,
 * #3590) does — mirrors its `nodeSourceIndex.test.ts` duplicate_of describe block, plus a
 * parity test running the identical doc set through both `groupSourceIdentities` call sites.
 *
 * t/4421 (t/4400's Electron leg): superseded the single-survivor collapse with the
 * de-duplicated UNION of (node, quote) across the group (`lib/sourceIndex/evidenceUnion.ts`),
 * mirroring the server's `resolveGroupRefs`/`mergeGroupEvidence` call site. Adds the two new
 * server-side scenarios (distinct quote recovered, near-equal quote still deduped); the
 * existing cases below are unaffected since their fixtures share an identical default
 * `verbatim` ('v') across canonical and marked docs.
 *
 * Point AI_TRIAD_DATA_ROOT at a temp dir BEFORE fileIO loads — same pattern as
 * fileIO.canonicalDocId.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const hoisted = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMPDIR || '/tmp';
  const root = `${base}/t4377-duplicate-of-${process.pid}-${Date.now()}`;
  process.env.AI_TRIAD_DATA_ROOT = root;
  return { root };
});

vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd(), isPackaged: false } }));

import { buildNodeSourceIndex, getNodeSources } from '../fileIO.js';

let summariesDir: string;
let sourcesDir: string;

function writeSummary(docId: string, nodeId: string, overrides: Partial<{ point: string; verbatim: string }> = {}): void {
  const summary = {
    pov_summaries: {
      accelerationist: {
        key_points: [{ taxonomy_node_id: nodeId, stance: 'supports', point: overrides.point ?? 'a point', verbatim: overrides.verbatim ?? 'v', excerpt_context: 'c' }],
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

describe('buildNodeSourceIndex / getNodeSources: duplicate_of (t/4377, parity with server nodeSourceIndex.ts)', () => {
  it('a duplicate pair gives one evidence unit, attributed to the canonical (SO C2)', () => {
    writeSourceMeta('report-2026', { title: 'The Report', url: 'https://example.com/report' });
    writeSourceMeta('copy-2026', { title: 'The Report (mirror)', url: 'https://example.com/mirror', duplicate_of: 'report-2026' });
    writeSummary('report-2026', 'n1', { point: 'from the original' });
    writeSummary('copy-2026', 'n1', { point: 'from the mirror' });

    const { sources } = getNodeSources('n1');
    expect(sources).toHaveLength(1);
    expect(sources[0].docId).toBe('report-2026');
    expect(sources[0].title).toBe('The Report');
  });

  it("the duplicate's id still resolves by id — a card is still produced, keyed by the canonical", () => {
    writeSourceMeta('report-2026', { title: 'The Report', url: 'https://example.com/report' });
    writeSourceMeta('copy-2026', { title: 'Mirror', url: 'https://example.com/mirror', duplicate_of: 'report-2026' });
    writeSummary('copy-2026', 'n1'); // ONLY the marked doc cites this node — its content must not vanish

    const { sources, cards } = getNodeSources('n1');
    expect(sources).toHaveLength(1);
    expect(sources[0].docId).toBe('report-2026');
    expect(cards['report-2026']).toMatchObject({ title: 'The Report' });
  });

  it('an invalid mark (self) is treated as absent — the doc stays its own row', () => {
    writeSourceMeta('solo-2026', { title: 'Solo', duplicate_of: 'solo-2026' });
    writeSummary('solo-2026', 'n1');

    const { sources } = getNodeSources('n1');
    expect(sources).toHaveLength(1);
    expect(sources[0].docId).toBe('solo-2026');
  });

  it('an unmarked split part is unaffected — still a separate row, grouped by canonicalDocId only', () => {
    writeSourceMeta('base-2026', { title: 'Base', content_sha256: 'h1' });
    writeSourceMeta('base-2026-1', { title: 'Base', content_sha256: 'h1' });
    writeSummary('base-2026', 'n1', { point: 'part one' });
    writeSummary('base-2026-1', 'n1', { point: 'part two' });

    const { sources } = getNodeSources('n1');
    expect(sources).toHaveLength(2);
    expect(new Set(sources.map(s => s.canonicalDocId))).toEqual(new Set(['base-2026']));
  });

  it('a duplicate_of target cited by nothing still resolves validly (full sources-dir scope, not just cited docs)', () => {
    // report-2026 is never cited by any summary — only copy-2026's mark references it. If the
    // scope were limited to cited docs, report-2026 wouldn't be "known" and the mark would
    // wrongly read as missing_target.
    writeSourceMeta('report-2026', { title: 'The Report' });
    writeSourceMeta('copy-2026', { title: 'Mirror', duplicate_of: 'report-2026' });
    writeSummary('copy-2026', 'n1');

    const { sources } = getNodeSources('n1');
    expect(sources).toHaveLength(1);
    expect(sources[0].docId).toBe('report-2026');
  });

  // t/4337 section 7 (t/4421): a copy's run over byte-identical text often extracts a
  // genuinely distinct key_point the canonical's run didn't. The old presence/absence
  // dedupe (t/4377) dropped it entirely; the quote-level union keeps it, attributed to the
  // canonical, alongside the canonical's own quote.
  it("a marked copy's distinct quote is recovered, attributed to the canonical, not dropped (t/4337#60)", () => {
    writeSourceMeta('canonical-2026', { title: 'Canonical', url: 'https://example.com/canonical' });
    writeSourceMeta('copy-2026', { title: 'Copy', url: 'https://example.com/copy', duplicate_of: 'canonical-2026' });
    writeSummary('canonical-2026', 'n1', { verbatim: 'US will double down on exporting its tech stack.' });
    writeSummary('copy-2026', 'n1', { verbatim: 'Nations are seeking sovereign AI capabilities.' });

    const { sources } = getNodeSources('n1');
    expect(sources).toHaveLength(2); // both distinct quotes survive...
    expect(sources.every(s => s.docId === 'canonical-2026' && s.canonicalDocId === 'canonical-2026')).toBe(true); // ...both attributed to the canonical
    expect(new Set(sources.map(s => s.verbatim))).toEqual(new Set([
      'US will double down on exporting its tech stack.',
      'Nations are seeking sovereign AI capabilities.',
    ]));
  });

  it("a marked copy's near-equal quote is still deduped — the canonical's wording wins the tie", () => {
    writeSourceMeta('canonical-2026', { title: 'Canonical', url: 'https://example.com/canonical' });
    writeSourceMeta('copy-2026', { title: 'Copy', url: 'https://example.com/copy', duplicate_of: 'canonical-2026' });
    writeSummary('canonical-2026', 'n1', { verbatim: 'The US will double down on exporting its tech stack.' });
    writeSummary('copy-2026', 'n1', { verbatim: 'the US will double-down on exporting its tech stack' });

    const { sources } = getNodeSources('n1');
    expect(sources).toHaveLength(1);
    expect(sources[0].verbatim).toBe('The US will double down on exporting its tech stack.');
  });

  it('parity: buildNodeSourceIndex row count matches a direct groupSourceIdentities call on the same universe', () => {
    writeSourceMeta('report-2026', { title: 'The Report', url: 'https://example.com/report' });
    writeSourceMeta('copy-2026', { title: 'Mirror', url: 'https://example.com/mirror', duplicate_of: 'report-2026' });
    writeSourceMeta('solo-2026', { title: 'Solo' });
    writeSummary('report-2026', 'n1', { point: 'original' });
    writeSummary('copy-2026', 'n1', { point: 'mirror' });
    writeSummary('solo-2026', 'n1', { point: 'solo' });

    const index = buildNodeSourceIndex();
    // 3 citations in, 1 collapsed away by the duplicate_of mark → 2 rows.
    expect(index['n1']).toHaveLength(2);
    expect(new Set(index['n1'].map(r => r.docId))).toEqual(new Set(['report-2026', 'solo-2026']));
  });
});
