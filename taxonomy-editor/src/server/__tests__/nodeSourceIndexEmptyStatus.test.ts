// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * t/498: a node source index built with nothing in it reported complete, because "complete" only means
 * that no summary read failed. On staging the index had 0 entries and 0 documents and /health still
 * showed nodeSourceIndexComplete true. The status now carries the counts and an explicit `empty` flag,
 * and the build logs a WARN when it produced nothing. `complete` keeps its meaning.
 * Every filesystem target is inside an fs.mkdtemp directory.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const record = vi.fn();
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record }) }));

const EMPTY_MESSAGE = 'Node source index is empty although the build reports complete';

describe('nodeSourceIndex: an empty index is visible in its status and the log (t/498)', () => {
  let dataRoot: string;
  let sourcesRoot: string;

  beforeEach(() => {
    record.mockClear();
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 't498-empty-index-data-'));
    sourcesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 't498-empty-index-sources-'));
    fs.mkdirSync(path.join(dataRoot, 'summaries'), { recursive: true });
    process.env.AI_TRIAD_DATA_ROOT = dataRoot;
    process.env.AI_TRIAD_SOURCES_ROOT = sourcesRoot;
  });

  afterEach(() => {
    fs.rmSync(dataRoot, { recursive: true, force: true });
    fs.rmSync(sourcesRoot, { recursive: true, force: true });
    delete process.env.AI_TRIAD_DATA_ROOT;
    delete process.env.AI_TRIAD_SOURCES_ROOT;
  });

  async function buildAndGetStatus() {
    const mod = await import('../storage/nodeSourceIndex.js');
    mod.resetNodeSourceIndexCacheForTests();
    await mod.getNodeSources('n1'); // builds and caches the index
    return mod.getNodeSourceIndexStatus();
  }

  const emptyWarnings = () => record.mock.calls.filter(c => (c[0] as { message?: string }).message === EMPTY_MESSAGE);

  it('no summaries and no sources: the status is complete AND empty, with zero counts, and the build WARNs', async () => {
    const status = await buildAndGetStatus();
    expect(status).toMatchObject({ built: true, complete: true, empty: true, entryCount: 0, canonicalDocCount: 0, summaryReadFailures: 0 });
    expect(emptyWarnings()).toHaveLength(1);
    expect(emptyWarnings()[0][0]).toMatchObject({
      component: 'node-source-index', level: 'warn',
      data: expect.objectContaining({ entryCount: 0, canonicalDocCount: 0 }),
    });
  });

  it('control: an index with an entry is not empty, and there is no empty WARN', async () => {
    fs.writeFileSync(path.join(dataRoot, 'summaries', 'doc-1.json'), JSON.stringify({
      pov_summaries: { accelerationist: { key_points: [{ taxonomy_node_id: 'n1', stance: 'supports', point: 'p', verbatim: 'v', excerpt_context: 'c' }] } },
    }));
    const status = await buildAndGetStatus();
    expect(status?.empty).toBe(false);
    expect(status?.entryCount).toBeGreaterThan(0);
    expect(status?.complete).toBe(true);
    expect(emptyWarnings()).toHaveLength(0);
  });

  it('before any build there is no status at all (null), so "empty" is never reported for an index that was not built', async () => {
    const mod = await import('../storage/nodeSourceIndex.js');
    mod.resetNodeSourceIndexCacheForTests();
    expect(mod.getNodeSourceIndexStatus()).toBeNull();
  });
});
