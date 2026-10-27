// @vitest-environment node

/**
 * t/4499 (TL design t/4499#18) — `readFilesBatch`'s consumption in
 * `nodeSourceIndex.ts`'s cold build. `GitHubAPIBackend`'s own GraphQL
 * transport is covered in `githubApi.test.ts`; this file exercises the
 * backend-agnostic contract: a full batch hit, a partial batch (some paths
 * fall back to `readFile`), and a batch failure (everything falls back) all
 * produce the exact same index as the no-batch path — the batch is a cache,
 * not a second source of truth.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as fileIO from '../storage/fileIO.js';
import { FilesystemBackend } from '../storage/filesystemBackend.js';
import type { StorageBackend } from '../storage/storageBackend.js';
import { resetNodeSourceIndexCacheForTests } from '../storage/nodeSourceIndex.js';
import type { NodeSourceIndex } from '../storage/nodeSourceIndex.js';

/** Concurrent reads (`mapWithConcurrencyLimit`) complete in whatever order
 *  the event loop schedules them — a pre-existing, by-design property
 *  (existing tests assert ref counts/sets, never array order). Sort each
 *  node's refs by `docId` before comparing so these tests assert on content,
 *  not on an order the system never promised. */
function sorted(index: NodeSourceIndex): NodeSourceIndex {
  const out: NodeSourceIndex = {};
  for (const [nodeId, refs] of Object.entries(index)) {
    out[nodeId] = [...refs].sort((a, b) => a.docId.localeCompare(b.docId));
  }
  return out;
}

let dataRoot: string;
let sourcesRoot: string;

function writeSummary(docId: string, nodeId: string): void {
  const summary = {
    pov_summaries: {
      accelerationist: {
        key_points: [{ taxonomy_node_id: nodeId, stance: 'supports', point: 'a point', verbatim: 'v', excerpt_context: 'c' }],
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

/** Wraps a real FilesystemBackend with a `readFilesBatch` that serves some
 *  (or all, or none) of the requested paths straight from the same disk
 *  content a plain `readFile` would return — simulating a GraphQL batch hit
 *  without a real GitHub API, so these tests are about the consumption
 *  contract (nodeSourceIndex.ts), not the transport (githubApi.test.ts). */
function withBatchReader(inner: StorageBackend, servePaths: 'all' | 'none' | string[]): StorageBackend {
  return {
    ...inner,
    readFile: inner.readFile.bind(inner),
    listDirectory: inner.listDirectory.bind(inner),
    async readFilesBatch(filePaths: string[]) {
      const contents = new Map<string, string>();
      const toServe = servePaths === 'all' ? filePaths : servePaths === 'none' ? [] : servePaths;
      for (const fp of filePaths) {
        if (!toServe.includes(fp)) continue;
        const raw = await inner.readFile(fp, { ref: 'main' });
        if (raw !== null) contents.set(fp, raw);
      }
      return { contents, fallbackCount: filePaths.length - contents.size, graphqlCost: toServe.length > 0 ? 1 : 0 };
    },
  };
}

describe('nodeSourceIndex.ts readFilesBatch consumption (t/4499)', () => {
  beforeEach(() => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 't4499-data-'));
    sourcesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 't4499-sources-'));
    fs.mkdirSync(path.join(dataRoot, 'summaries'), { recursive: true });
    process.env.AI_TRIAD_DATA_ROOT = dataRoot;
    process.env.AI_TRIAD_SOURCES_ROOT = sourcesRoot;
    resetNodeSourceIndexCacheForTests();

    writeSourceMeta('doc-a', { title: 'Doc A', url: 'https://example.com/a' });
    writeSourceMeta('doc-b', { title: 'Doc B', url: 'https://example.com/b' });
    writeSourceMeta('doc-c', { title: 'Doc C', url: 'https://example.com/c' });
    writeSummary('doc-a', 'node-1');
    writeSummary('doc-b', 'node-1');
    writeSummary('doc-c', 'node-2');
  });

  afterEach(() => {
    fileIO.setBackend(new FilesystemBackend());
    fs.rmSync(dataRoot, { recursive: true, force: true });
    fs.rmSync(sourcesRoot, { recursive: true, force: true });
    delete process.env.AI_TRIAD_DATA_ROOT;
    delete process.env.AI_TRIAD_SOURCES_ROOT;
  });

  it('a full batch hit produces the same index as no batch at all', async () => {
    const baseline = await fileIO.buildNodeSourceIndex();

    resetNodeSourceIndexCacheForTests();
    fileIO.setBackend(withBatchReader(new FilesystemBackend(), 'all'));
    const withBatch = await fileIO.buildNodeSourceIndex();

    expect(sorted(withBatch)).toEqual(sorted(baseline));
  });

  it('a partial batch (some paths fall back to readFile) produces the same index', async () => {
    const baseline = await fileIO.buildNodeSourceIndex();

    resetNodeSourceIndexCacheForTests();
    const summariesDir = path.join(dataRoot, 'summaries');
    fileIO.setBackend(withBatchReader(new FilesystemBackend(), [path.join(summariesDir, 'doc-b.json')]));
    const withPartialBatch = await fileIO.buildNodeSourceIndex();

    expect(sorted(withPartialBatch)).toEqual(sorted(baseline));
  });

  it('a batch that resolves nothing (chunk failure) falls back entirely and still matches', async () => {
    const baseline = await fileIO.buildNodeSourceIndex();

    resetNodeSourceIndexCacheForTests();
    fileIO.setBackend(withBatchReader(new FilesystemBackend(), 'none'));
    const withFailedBatch = await fileIO.buildNodeSourceIndex();

    expect(sorted(withFailedBatch)).toEqual(sorted(baseline));
  });

  it('a backend with no readFilesBatch at all (the plain FilesystemBackend contract) is unaffected', async () => {
    const result = await fileIO.buildNodeSourceIndex();
    expect(result['node-1']).toHaveLength(2);
    expect(result['node-2']).toHaveLength(1);
  });
});
