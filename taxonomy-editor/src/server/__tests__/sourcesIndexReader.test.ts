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

  it('end-to-end: buildNodeSourceIndex groups via the index (same_as + parent_doc_id merge alpha/beta/gamma; the untitled split part stays separate)', async () => {
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
    expect(refs).toHaveLength(4);

    const byId = Object.fromEntries(refs.map(r => [r.docId, r.canonicalDocId]));
    // alpha-2026 --same_as--> beta-2026, gamma-2026 --parent_doc_id--> beta-2026: one group, canonical = ordinal-smallest id.
    expect(byId['alpha-2026']).toBe('alpha-2026');
    expect(byId['beta-2026']).toBe('alpha-2026');
    expect(byId['gamma-2026']).toBe('alpha-2026');
    // alpha-2026-1 has no identity data in the index (no metadata.json upstream) — no title to
    // satisfy the conditional suffix edge, so it correctly stays its own canonical id.
    expect(byId['alpha-2026-1']).toBe('alpha-2026-1');
  });
});
