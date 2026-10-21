// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * t/4334#18 (the hosted AC1 root cause): a configured data directory that
 * lists empty is a silent-failure signal, not a legitimate "nothing here" —
 * exactly what happened when `getSourcesDir()` returned a path the backend's
 * tree didn't cover. This must WARN, not degrade silently.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const record = vi.fn();
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record }) }));

describe('nodeSourceIndex: WARN on an empty configured data directory (t/4334#18)', () => {
  let dataRoot: string;
  let sourcesRoot: string;

  beforeEach(() => {
    record.mockClear();
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 't4334-emptydir-data-'));
    sourcesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 't4334-emptydir-sources-'));
    fs.mkdirSync(path.join(dataRoot, 'summaries'), { recursive: true });
    process.env.AI_TRIAD_DATA_ROOT = dataRoot;
    process.env.AI_TRIAD_SOURCES_ROOT = sourcesRoot; // exists, but empty
  });

  afterEach(() => {
    fs.rmSync(dataRoot, { recursive: true, force: true });
    fs.rmSync(sourcesRoot, { recursive: true, force: true });
    delete process.env.AI_TRIAD_DATA_ROOT;
    delete process.env.AI_TRIAD_SOURCES_ROOT;
  });

  it('WARNs when sourcesDir is configured (exists) but has zero entries', async () => {
    const fileIO = await import('../storage/fileIO.js');
    const { resetNodeSourceIndexCacheForTests } = await import('../storage/nodeSourceIndex.js');
    resetNodeSourceIndexCacheForTests();

    // A summary with no matching sources/<id>/metadata.json anywhere.
    fs.writeFileSync(path.join(dataRoot, 'summaries', 'orphan-doc.json'), JSON.stringify({
      pov_summaries: { accelerationist: { key_points: [{ taxonomy_node_id: 'n1', stance: 'supports', point: 'p', verbatim: 'v', excerpt_context: 'c' }] } },
    }));

    await fileIO.buildNodeSourceIndex();

    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      component: 'node-source-index',
      level: 'warn',
      message: expect.stringContaining('sourcesDir'),
      data: expect.objectContaining({ label: 'sourcesDir', dirPath: sourcesRoot }),
    }));
  });

  it('does NOT warn when sourcesDir has real entries', async () => {
    const fileIO = await import('../storage/fileIO.js');
    const { resetNodeSourceIndexCacheForTests } = await import('../storage/nodeSourceIndex.js');
    resetNodeSourceIndexCacheForTests();

    const docDir = path.join(sourcesRoot, 'doc-a');
    fs.mkdirSync(docDir, { recursive: true });
    fs.writeFileSync(path.join(docDir, 'metadata.json'), JSON.stringify({ title: 'Doc A', url: 'https://example.com/a' }));
    fs.writeFileSync(path.join(dataRoot, 'summaries', 'doc-a.json'), JSON.stringify({
      pov_summaries: { accelerationist: { key_points: [{ taxonomy_node_id: 'n1', stance: 'supports', point: 'p', verbatim: 'v', excerpt_context: 'c' }] } },
    }));

    await fileIO.buildNodeSourceIndex();

    const sourcesDirWarnCalls = record.mock.calls.filter(([arg]) => arg?.data?.label === 'sourcesDir');
    expect(sourcesDirWarnCalls).toHaveLength(0);
  });
});
