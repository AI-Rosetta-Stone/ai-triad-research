// @vitest-environment node

/**
 * t/4333/t/4334 — node→source index: canonicalDocId grouping, the per-node
 * lookup, build-once/invalidate-on-change caching, and card metadata.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as fileIO from '../storage/fileIO.js';
import { resetNodeSourceIndexCacheForTests } from '../storage/nodeSourceIndex.js';
import { log } from '../logger.js';

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

  // t/4344 (PowerShell's scan, TL's revised ruling t/4334#6): the real
  // "eight-ways" cluster isn't 2 legitimate outlet reprints — it's one
  // byte-identical article whose outlet URLs were attached by provenance
  // search after the fact. A shared `content_sha256` (recorded, as t/4337
  // would write it) is the signal that correctly collapses all 7 refs to
  // ONE canonical doc, which URL/suffix/title alone could not do safely.
  it('acc-desires-021 collapses split parts and re-ingested outlet copies to 1 row, not 7 (t/4334#6, same content hash)', async () => {
    const nodeId = 'acc-desires-021';
    const base = 'eight-ways-ai-will-shape-geopolitics-2026-2026';
    const ac = 'eight-ways-ai-will-shape-geopolitics-2026-atlantic-council-2026';
    const sameHash = 'a'.repeat(64);
    const ids = [base, `${base}-1`, `${base}-2`, `${base}-3`, ac, `${ac}-1`, `${ac}-2`];
    const urls = [
      'https://www.brookings.edu/articles/x/', 'https://etcjournal.com/y', 'https://example.com/z', 'https://example.com/w',
      'https://www.atlanticcouncil.org/dispatches/x/', 'https://example.com/ac1', 'https://example.com/ac2',
    ];
    ids.forEach((id, i) => writeSourceMeta(id, {
      title: 'Eight ways AI will shape geopolitics in 2026', url: urls[i], content_sha256: sameHash,
    }));
    for (const id of ids) writeSummary(id, nodeId);

    const index = await fileIO.buildNodeSourceIndex();
    const refs = index[nodeId];
    expect(refs).toHaveLength(7); // all 7 references still present...

    const distinctCanonicalIds = new Set(refs.map(r => r.canonicalDocId));
    expect(distinctCanonicalIds.size).toBe(1); // ...but collapsed to the 1 real document
  });

  it('without a shared content hash, genuinely different-URL outlet copies stay separate (no false merge)', async () => {
    const nodeId = 'acc-desires-021';
    const base = 'eight-ways-ai-will-shape-geopolitics-2026-2026';
    const ac = 'eight-ways-ai-will-shape-geopolitics-2026-atlantic-council-2026';
    writeSourceMeta(base, { title: 'Eight ways AI will shape geopolitics in 2026', url: 'https://www.brookings.edu/articles/x/' });
    writeSourceMeta(ac, { title: 'Eight ways AI will shape geopolitics in 2026   Atlantic Council', url: 'https://www.atlanticcouncil.org/dispatches/x/' });
    writeSummary(base, nodeId);
    writeSummary(ac, nodeId);

    const index = await fileIO.buildNodeSourceIndex();
    const refs = index[nodeId];
    const distinctCanonicalIds = new Set(refs.map(r => r.canonicalDocId));
    expect(distinctCanonicalIds.size).toBe(2);
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

  // t/4334#25 (Rosetta): a per-doc metaCache miss degraded silently (title
  // fell back to the bare doc id, no WARN) — the same silent-fallback class
  // as the empty-listing bug, just at the per-doc granularity. One
  // aggregated WARN per build, not one per occurrence.
  it('WARNs once per build, aggregated, when docs have no source metadata', async () => {
    const warnSpy = vi.spyOn(log.server, 'warn').mockImplementation(() => undefined as unknown as ReturnType<typeof log.server.warn>);
    writeSummary('orphan-a', 'n1'); // no writeSourceMeta — no metadata.json anywhere
    writeSummary('orphan-b', 'n1');
    writeSourceMeta('known-doc', { title: 'Known', url: 'https://example.com/known' });
    writeSummary('known-doc', 'n1');

    await fileIO.buildNodeSourceIndex();

    const call = warnSpy.mock.calls.find(([, msg]) => typeof msg === 'string' && msg.includes('no source metadata'));
    expect(call).toBeDefined();
    const [data] = call!;
    expect(data).toMatchObject({ missingCount: 2, missingDocIds: ['orphan-a', 'orphan-b'] });
    warnSpy.mockRestore();
  });

  it('does NOT warn about missing metadata when every doc has it', async () => {
    const warnSpy = vi.spyOn(log.server, 'warn').mockImplementation(() => undefined as unknown as ReturnType<typeof log.server.warn>);
    writeSourceMeta('known-doc', { title: 'Known', url: 'https://example.com/known' });
    writeSummary('known-doc', 'n1');

    await fileIO.buildNodeSourceIndex();

    const call = warnSpy.mock.calls.find(([, msg]) => typeof msg === 'string' && msg.includes('no source metadata'));
    expect(call).toBeUndefined();
    warnSpy.mockRestore();
  });
});
