// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/4342 (Electron leg of t/4335's transport trio): getNodeSources(nodeId) scopes the
 * node→source index to one node's references plus one source card per canonical document
 * referenced — mirrors the server's getNodeSources (src/server/storage/nodeSourceIndex.ts).
 *
 * Same electron-mock / AI_TRIAD_DATA_ROOT hoist pattern as fileIO.canonicalDocId.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const hoisted = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMPDIR || '/tmp';
  const root = `${base}/t4342-get-node-sources-${process.pid}-${Date.now()}`;
  process.env.AI_TRIAD_DATA_ROOT = root;
  return { root };
});

vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd(), isPackaged: false } }));

import { getNodeSources } from '../fileIO.js';

let summariesDir: string;
let sourcesDir: string;

function writeSummary(docId: string, nodeId: string, point = 'a point'): void {
  const summary = {
    pov_summaries: {
      accelerationist: {
        key_points: [{ taxonomy_node_id: nodeId, stance: 'supports', point, verbatim: 'v', excerpt_context: 'c' }],
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

describe('getNodeSources (t/4342)', () => {
  it('scopes sources to the requested node only', () => {
    writeSourceMeta('doc-a', { title: 'Doc A', url: 'https://example.com/a' });
    writeSourceMeta('doc-b', { title: 'Doc B', url: 'https://example.com/b' });
    writeSummary('doc-a', 'node-1');
    writeSummary('doc-b', 'node-2');

    const result = getNodeSources('node-1');
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].docId).toBe('doc-a');
  });

  it('returns one card per canonical document, carrying authors/topicTags/oneLiner', () => {
    writeSourceMeta('doc-a', {
      title: 'Doc A', url: 'https://example.com/a',
      authors: ['Jane Doe'], topic_tags: ['governance'], one_liner: 'A summary.',
    });
    // doc-a-1 has no metadata.json of its own — a split part whose card metadata falls back
    // to the canonical id's cache entry (metaCache[ref.docId] is undefined for it), so the
    // card assertion below doesn't depend on which of the two refs the scan visits first.
    writeSummary('doc-a', 'node-1', 'first point');
    writeSummary('doc-a-1', 'node-1', 'second point');

    const result = getNodeSources('node-1');
    expect(result.sources).toHaveLength(2);

    const canonicalIds = new Set(result.sources.map(r => r.canonicalDocId));
    expect(canonicalIds.size).toBe(1); // collapsed to one real document

    const [canonicalId] = [...canonicalIds];
    expect(Object.keys(result.cards)).toEqual([canonicalId]);
    expect(result.cards[canonicalId]).toEqual({
      title: 'Doc A',
      url: 'https://example.com/a',
      authors: ['Jane Doe'],
      topicTags: ['governance'],
      oneLiner: 'A summary.',
      datePublished: '',
    });
  });

  it('returns an empty result for a node with no sources', () => {
    writeSourceMeta('doc-a', { title: 'Doc A', url: 'https://example.com/a' });
    writeSummary('doc-a', 'node-1');

    const result = getNodeSources('node-unknown');
    expect(result.sources).toEqual([]);
    expect(result.cards).toEqual({});
    expect(result.indexVersion).toBe(0);
  });
});
