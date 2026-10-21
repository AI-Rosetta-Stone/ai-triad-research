// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * t/4334#18: the sources-index.json reader. `expected.json` is the shared
 * contract sample (`tests/fixtures/sources-index/`) PowerShell's generator
 * (#3558) is tested against too — both sides parse the same bytes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(here, '../../../../tests/fixtures/sources-index/expected.json');
const expectedRaw = fs.readFileSync(fixturePath, 'utf-8');
const expected = JSON.parse(expectedRaw) as { schema_version: number; docs: { id: string }[] };

const record = vi.fn();
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record }) }));

describe('sourcesIndexReader (t/4334#18)', () => {
  let dataRoot: string;
  let indexPath: string;

  beforeEach(() => {
    record.mockClear();
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 't4334-sources-index-'));
    fs.mkdirSync(path.join(dataRoot, 'summaries'), { recursive: true });
    const taxonomyDir = path.join(dataRoot, 'taxonomy', 'Origin');
    fs.mkdirSync(taxonomyDir, { recursive: true });
    indexPath = path.join(taxonomyDir, 'sources-index.json');
    process.env.AI_TRIAD_DATA_ROOT = dataRoot;
  });

  afterEach(() => {
    fs.rmSync(dataRoot, { recursive: true, force: true });
    delete process.env.AI_TRIAD_DATA_ROOT;
  });

  it('parses the shared contract sample (same bytes PowerShell tests the generator against)', async () => {
    fs.writeFileSync(indexPath, expectedRaw);
    const { loadSourcesIndex } = await import('../storage/sourcesIndexReader.js');

    const result = await loadSourcesIndex();
    expect(result).toEqual(expected);
  });

  it('returns null and WARNs when the file is missing', async () => {
    const { loadSourcesIndex } = await import('../storage/sourcesIndexReader.js');
    const result = await loadSourcesIndex();
    expect(result).toBeNull();
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ reason: 'missing' }) }));
  });

  it('returns null and WARNs on malformed JSON', async () => {
    fs.writeFileSync(indexPath, '{ not valid json');
    const { loadSourcesIndex } = await import('../storage/sourcesIndexReader.js');
    const result = await loadSourcesIndex();
    expect(result).toBeNull();
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ reason: 'malformed JSON' }) }));
  });

  it('returns null and WARNs on an unrecognized schema_version (stale)', async () => {
    fs.writeFileSync(indexPath, JSON.stringify({ ...expected, schema_version: 999 }));
    const { loadSourcesIndex } = await import('../storage/sourcesIndexReader.js');
    const result = await loadSourcesIndex();
    expect(result).toBeNull();
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ reason: 'schema_version mismatch (stale)', found: 999 }),
    }));
  });

  it('end-to-end: buildNodeSourceIndex groups via the index (same_as + parent_doc_id + duplicate_of merge alpha/beta/gamma/delta; the untitled split part stays separate)', async () => {
    fs.writeFileSync(indexPath, expectedRaw);
    const fileIO = await import('../storage/fileIO.js');
    const { resetNodeSourceIndexCacheForTests } = await import('../storage/nodeSourceIndex.js');
    resetNodeSourceIndexCacheForTests();

    const writeSummary = (docId: string) => fs.writeFileSync(
      path.join(dataRoot, 'summaries', `${docId}.json`),
      JSON.stringify({ pov_summaries: { accelerationist: { key_points: [{ taxonomy_node_id: 'n1', stance: 'supports', point: 'p', verbatim: 'v', excerpt_context: 'c' }] } } }),
    );
    for (const id of expected.docs.map(d => d.id)) writeSummary(id);

    const index = await fileIO.buildNodeSourceIndex();
    const refs = index.n1;
    // alpha/beta/gamma/alpha-2026-1 each get their own row; delta-2026 (t/4357:
    // duplicate_of beta-2026) collapses into beta's own row — one evidence
    // unit, not two (SO condition C2) — so the count is unchanged at 4.
    expect(refs).toHaveLength(4);
    expect(refs.some(r => r.docId === 'delta-2026')).toBe(false);

    const byId = Object.fromEntries(refs.map(r => [r.docId, r.canonicalDocId]));
    // alpha-2026 --same_as--> beta-2026, gamma-2026 --parent_doc_id--> beta-2026,
    // delta-2026 --duplicate_of--> beta-2026: one group. t/4357 (spec 4.6 rule
    // 1): a group with a valid duplicate_of mark uses the mark's target as
    // canonical — beta-2026, not the ordinal-smallest id (alpha-2026).
    expect(byId['alpha-2026']).toBe('beta-2026');
    expect(byId['beta-2026']).toBe('beta-2026');
    expect(byId['gamma-2026']).toBe('beta-2026');
    // alpha-2026-1 has no identity data in the index (no metadata.json upstream) — no title to
    // satisfy the conditional suffix edge, so it correctly stays its own canonical id.
    expect(byId['alpha-2026-1']).toBe('alpha-2026-1');
  });

  // t/4334#38/#39 (TL/SO go-live check): the 20 real t/4337 partial-ingest docs
  // have no metadata.json, so Export-SourcesIndex lists them as bare {id,
  // snapshot_sha256} entries — no title, no duplicate_of mark (C10: left
  // alone, never written). A standalone index (not the shared PowerShell
  // contract sample, to avoid touching that cross-stack fixture) models one.
  it('a bare-id entry (no metadata.json) groups under its canonical via the hash edge, and never appears as its own row (TL/SO go-live check, t/4334#38)', async () => {
    const sharedHash = 'f'.repeat(64);
    // Named so the metadata-bearing doc sorts first ordinally (4.6 rule 2 — no
    // duplicate_of mark exists for these, per C10) and so is unambiguously the
    // group's canonical, matching the real-world case (an ordinary doc id vs.
    // a UUID-shaped partial-ingest id would sort either way by luck alone).
    const bareIndex = {
      schema_version: 1,
      source_commit: null,
      doc_count: 2,
      docs: [
        { id: 'aaa-canon-2026', title: 'Canon', url: 'https://example.org/canon', content_sha256: sharedHash },
        { id: 'zzz-bare-twin-2026', snapshot_sha256: sharedHash }, // no title/url — the bare-id shape
      ],
    };
    fs.writeFileSync(indexPath, JSON.stringify(bareIndex));
    const fileIO = await import('../storage/fileIO.js');
    const { resetNodeSourceIndexCacheForTests } = await import('../storage/nodeSourceIndex.js');
    resetNodeSourceIndexCacheForTests();

    // Only the canonical has a summary — matching the real 20's "0 readers today"
    // (t/4337#37): a doc with no metadata.json also has no summaries/<id>.json,
    // so it can never be cited and can never appear as its own evidence row.
    fs.writeFileSync(
      path.join(dataRoot, 'summaries', 'aaa-canon-2026.json'),
      JSON.stringify({ pov_summaries: { accelerationist: { key_points: [{ taxonomy_node_id: 'n1', stance: 'supports', point: 'p', verbatim: 'v', excerpt_context: 'c' }] } } }),
    );

    const index = await fileIO.buildNodeSourceIndex();
    const refs = index.n1;
    expect(refs).toHaveLength(1);
    expect(refs[0].docId).toBe('aaa-canon-2026');
    expect(refs[0].canonicalDocId).toBe('aaa-canon-2026');
    expect(refs.some(r => r.docId === 'zzz-bare-twin-2026')).toBe(false); // never a row of its own

    // Grouped under the canonical through the hash edge, not its own id.
    const { getNodeSources } = fileIO;
    const { cards } = await getNodeSources('n1');
    expect(Object.keys(cards)).toEqual(['aaa-canon-2026']);
    expect(cards['aaa-canon-2026']).toMatchObject({ title: 'Canon', url: 'https://example.org/canon' });
  });
});
