// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/4349 (full groupSourceIdentities adoption, replacing the t/4341 computeCanonicalDocIds
 * shim): buildNodeSourceIndex() must group references into canonicalDocId the same way the
 * server's buildNodeSourceIndex (t/4334, src/server/storage/nodeSourceIndex.ts) does, reading
 * the full source-identity metadata.json fields (not just {url, title}) via the shared
 * groupSourceIdentities algorithm in lib/sourceIndex/types.ts.
 *
 * Cases below are drawn from the shared fixture (tests/fixtures/source-identity-cases.json,
 * t/4344) — the one source of truth both the TS and PowerShell implementations must pass —
 * rather than hand-built scenarios, so Electron's suite tracks the spec directly (t/4349
 * plan step 4, p/638#8-11). Only `grouping_cases` entries resolvable from `metadata.json`
 * alone are replayed here (no `snapshot_sha256`/`snapshot_text` document): a computed
 * snapshot hash is exercised structurally below via `writeSnapshot`, but fixture cases that
 * pin a specific hash *value* can't be reproduced through real file hashing and are covered
 * instead by lib/sourceIndex/sourceIdentityFixture.test.ts (pure function, same fixture).
 *
 * Point AI_TRIAD_DATA_ROOT at a temp dir BEFORE fileIO loads — SUMMARIES_DIR/SOURCES_DIR_LEGACY
 * are captured at module-eval (vi.hoisted runs before the imports below). fileIO imports
 * electron (app), so it's stubbed to load under vitest — same pattern as edgesFormat.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const hoisted = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMPDIR || '/tmp';
  const root = `${base}/t4349-canonical-id-${process.pid}-${Date.now()}`;
  process.env.AI_TRIAD_DATA_ROOT = root;
  return { root };
});

vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd(), isPackaged: false } }));

// Imported AFTER the hoisted env + electron mock so SUMMARIES_DIR/getSourcesDir resolve into
// the temp root.
import { buildNodeSourceIndex } from '../fileIO.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(here, '../../../../tests/fixtures/source-identity-cases.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as {
  grouping_cases: {
    name: string;
    documents: { id: string; metadata: Record<string, unknown>; snapshot_sha256?: string; snapshot_text?: string }[];
    expected_canonical: Record<string, string>;
    expected_title_collisions: string[][];
  }[];
};

// Only cases resolvable from metadata.json alone (see file header).
const metadataOnlyCases = fixture.grouping_cases.filter(
  c => !c.documents.some(d => d.snapshot_sha256 !== undefined || d.snapshot_text !== undefined)
);

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

function writeSnapshot(docId: string, text: string): void {
  fs.writeFileSync(path.join(sourcesDir, docId, 'snapshot.md'), text);
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

describe('buildNodeSourceIndex canonicalDocId grouping (t/4349, full groupSourceIdentities parity)', () => {
  for (const c of metadataOnlyCases) {
    it(`fixture: ${c.name}`, () => {
      for (const doc of c.documents) {
        writeSourceMeta(doc.id, doc.metadata);
        writeSummary(doc.id, 'n-fixture');
      }
      const refs = buildNodeSourceIndex()['n-fixture'];
      const actual: Record<string, string> = {};
      for (const r of refs) actual[r.docId] = r.canonicalDocId;
      expect(actual).toEqual(c.expected_canonical);
    });
  }

  it('collapses split parts and re-ingested outlet copies via a shared URL, not just the suffix edge (t/4334#11 condition 2 — the gap this ticket closes)', () => {
    // Unlike the deprecated shim (which could never trust a URL), the real algorithm trusts
    // an un-contradicted url/resolved_url, so two docs sharing one with no suffix relation
    // now correctly merge.
    writeSourceMeta('report-a', { title: 'Report A', url: 'https://example.com/shared' });
    writeSourceMeta('report-b', { title: 'Report B', url: 'https://example.com/shared' });
    writeSummary('report-a', 'n1');
    writeSummary('report-b', 'n1');

    const refs = buildNodeSourceIndex()['n1'];
    const ids = new Set(refs.map(r => r.canonicalDocId));
    expect(ids.size).toBe(1);
  });

  it('merges via an explicit same_as link read from metadata.json', () => {
    writeSourceMeta('base-doc', { title: 'Base' });
    writeSourceMeta('reprint-doc', { title: 'A Totally Different Title', same_as: 'base-doc' });
    writeSummary('base-doc', 'n1');
    writeSummary('reprint-doc', 'n1');

    const refs = buildNodeSourceIndex()['n1'];
    const byId = new Map(refs.map(r => [r.docId, r.canonicalDocId]));
    expect(byId.get('reprint-doc')).toBe(byId.get('base-doc'));
  });

  it('computes a content hash from snapshot.md when metadata has no recorded content_sha256, and that computed hash still joins two docs', () => {
    // Body must clear the v4 100-word hash-identity floor (lib/sourceIndex/types.ts) or
    // computeSourceContentHash returns null and no hash edge forms.
    const words = Array.from({ length: 100 }, (_, i) => `w${i}`).join(' ');
    const text = `Shared body text for the content-hash tier.\n\n${words}\n`;
    writeSourceMeta('no-recorded-hash-a', { title: 'Alpha Title' });
    writeSnapshot('no-recorded-hash-a', text);
    writeSourceMeta('no-recorded-hash-b', { title: 'Totally Different Title' });
    writeSnapshot('no-recorded-hash-b', text);
    writeSummary('no-recorded-hash-a', 'n1');
    writeSummary('no-recorded-hash-b', 'n1');

    const refs = buildNodeSourceIndex()['n1'];
    const ids = new Set(refs.map(r => r.canonicalDocId));
    expect(ids.size).toBe(1);
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
});
