// @vitest-environment node

/**
 * t/4333/t/4334 — node→source index: canonicalDocId grouping, the per-node
 * lookup, build-once/invalidate-on-change caching, and card metadata.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as fileIO from '../storage/fileIO.js';
import { resetNodeSourceIndexCacheForTests } from '../storage/nodeSourceIndex.js';

let dataRoot: string;
let sourcesRoot: string;

function writeSummary(docId: string, nodeIds: string | string[], overrides: Partial<{ stance: string; point: string }> = {}): void {
  const ids = Array.isArray(nodeIds) ? nodeIds : [nodeIds];
  const summary = {
    pov_summaries: {
      accelerationist: {
        key_points: ids.map(nodeId => ({ taxonomy_node_id: nodeId, stance: overrides.stance ?? 'supports', point: overrides.point ?? 'a point', verbatim: 'v', excerpt_context: 'c' })),
      },
    },
  };
  fs.writeFileSync(path.join(dataRoot, 'summaries', `${docId}.json`), JSON.stringify(summary));
}

function writeSourceMeta(docId: string, meta: Record<string, unknown>): void {
  const dir = path.join(sourcesRoot, docId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify(meta));
}

describe('buildNodeSourceIndex / getNodeSources (t/4333/t/4334)', () => {
  beforeEach(() => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 't4334-data-'));
    sourcesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 't4334-sources-'));
    fs.mkdirSync(path.join(dataRoot, 'summaries'), { recursive: true });
    process.env.AI_TRIAD_DATA_ROOT = dataRoot;
    process.env.AI_TRIAD_SOURCES_ROOT = sourcesRoot;
    resetNodeSourceIndexCacheForTests();
  });

  afterEach(() => {
    fs.rmSync(dataRoot, { recursive: true, force: true });
    fs.rmSync(sourcesRoot, { recursive: true, force: true });
    delete process.env.AI_TRIAD_DATA_ROOT;
    delete process.env.AI_TRIAD_SOURCES_ROOT;
  });

  it('acc-desires-021 collapses split parts and re-ingested outlet copies to 2 rows, not 7 (t/4334#2)', async () => {
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

    const index = await fileIO.buildNodeSourceIndex();
    const refs = index[nodeId];
    expect(refs).toHaveLength(7); // all 7 references still present...

    const distinctCanonicalIds = new Set(refs.map(r => r.canonicalDocId));
    expect(distinctCanonicalIds.size).toBe(2); // ...but collapsed to 2 real documents
  });

  it('does not merge two different documents with similar titles (false-merge guard)', async () => {
    writeSourceMeta('doc-a-2026', { title: 'AI Governance in 2026', url: 'https://example.com/a' });
    writeSourceMeta('doc-b-2026', { title: 'AI Governance Report 2026', url: 'https://example.com/b' });
    writeSummary('doc-a-2026', 'n1');
    writeSummary('doc-b-2026', 'n1');

    const index = await fileIO.buildNodeSourceIndex();
    const ids = index['n1'].map(r => r.canonicalDocId);
    expect(new Set(ids).size).toBe(2);
  });

  it('getNodeSources scopes to one node and returns one card per canonical document', async () => {
    writeSourceMeta('solo-doc-2026', {
      title: 'Solo Document', url: 'https://example.com/solo', authors: ['A. Author'],
      date_published: '2026-01-01', topic_tags: ['governance'], one_liner: 'A summary.',
    });
    writeSummary('solo-doc-2026', ['target-node', 'other-node']);

    const result = await fileIO.getNodeSources('target-node');
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].docId).toBe('solo-doc-2026');
    const card = result.cards['solo-doc-2026'];
    expect(card).toMatchObject({
      title: 'Solo Document', url: 'https://example.com/solo', authors: ['A. Author'],
      datePublished: '2026-01-01', topicTags: ['governance'], oneLiner: 'A summary.',
    });
    expect(result.indexVersion).toBeGreaterThan(0);
  });

  it('invalidates and reflects a newly added summary without a restart (AC5)', async () => {
    writeSourceMeta('first-doc', { title: 'First', url: 'https://example.com/first' });
    writeSummary('first-doc', 'n1');
    const before = await fileIO.getNodeSources('n1');
    expect(before.sources).toHaveLength(1);
    const versionBefore = before.indexVersion;

    writeSourceMeta('second-doc', { title: 'Second', url: 'https://example.com/second' });
    writeSummary('second-doc', 'n1');
    const after = await fileIO.getNodeSources('n1');
    expect(after.sources).toHaveLength(2);
    expect(after.indexVersion).toBeGreaterThan(versionBefore);
  });

  it('a request before any summary add reuses the cache (same indexVersion)', async () => {
    writeSourceMeta('a-doc', { title: 'A', url: 'https://example.com/a' });
    writeSummary('a-doc', 'n1');
    const first = await fileIO.getNodeSources('n1');
    const second = await fileIO.getNodeSources('n1');
    expect(second.indexVersion).toBe(first.indexVersion);
  });
});
