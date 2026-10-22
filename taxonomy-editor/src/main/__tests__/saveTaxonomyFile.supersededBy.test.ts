// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/4424 (t/4355 AC2, SO e/343#2 C5, desktop save path): `save-taxonomy-file` must write a
 * superseded node's `superseded_by` back byte-identical, at its original index — the editor
 * side (t/4355) merged in #3648/#3649. A code read of `stampSaveNodes`
 * (ipc/taxonomyHandlers.ts) found it only stamps `_edit_meta`/`_edit_history`, so no production
 * fix is expected here, only a regression guard that keeps it that way.
 *
 * Exercises the REAL fileIO.ts read/write path (not mocked) so "byte-identical" means the
 * actual bytes on disk, not an in-memory object-equality stand-in — same pattern as
 * edgesFormat.test.ts / fileIO.canonicalDocId.test.ts: point AI_TRIAD_DATA_ROOT at a temp dir
 * BEFORE fileIO loads (vi.hoisted runs before the imports below), stub only `electron` and the
 * heavy `embeddings.js`. `stampNodeAuthorship` (server/storage/editMeta.js) is left real and
 * unmocked deliberately — the claim under test is about what it does NOT touch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const hoisted = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMPDIR || '/tmp';
  const root = `${base}/t4424-superseded-by-${process.pid}-${Date.now()}`;
  process.env.AI_TRIAD_DATA_ROOT = root;
  return { root, handlers: new Map<string, (...a: unknown[]) => unknown>() };
});

vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { hoisted.handlers.set(ch, fn); } },
  BrowserWindow: { getAllWindows: () => [] },
  app: { getAppPath: () => process.cwd(), isPackaged: false },
}));

vi.mock('../embeddings.js', () => ({ computeEmbeddings: vi.fn(), computeQueryEmbedding: vi.fn() }));

// Imported AFTER the hoisted env + electron mock so activeTaxonomyDir/fileIO resolve into the
// temp root, and taxonomyHandlers binds the real (unmocked) fileIO + editMeta modules.
import { registerTaxonomyHandlers } from '../ipc/taxonomyHandlers.js';
import { resolveDataPath, loadDataConfig } from '../fileIO.js';

let taxonomyDir: string;

function saveTaxonomyFile(pov: string, data: unknown): unknown {
  const fn = hoisted.handlers.get('save-taxonomy-file');
  if (!fn) throw new Error('save-taxonomy-file not registered');
  return fn({ sender: {} }, pov, data);
}

beforeEach(() => {
  taxonomyDir = resolveDataPath(loadDataConfig().taxonomy_dir);
  fs.mkdirSync(taxonomyDir, { recursive: true });
  hoisted.handlers.clear();
  registerTaxonomyHandlers();
});

afterEach(() => {
  fs.rmSync(hoisted.root, { recursive: true, force: true });
});

describe('save-taxonomy-file: superseded_by round-trips byte-identical (t/4424, t/4355 AC2)', () => {
  it("a superseded node's superseded_by survives a save byte-identical, at its original index", () => {
    const supersededNode = {
      id: 'acc-desires-099',
      label: 'Old node',
      superseded_by: 'acc-desires-100',
    };
    const liveNode = { id: 'acc-desires-100', label: 'Live node' };
    const payload = { nodes: [supersededNode, liveNode] };

    saveTaxonomyFile('accelerationist', payload);

    const raw = fs.readFileSync(path.join(taxonomyDir, 'accelerationist.json'), 'utf-8');
    // Byte-level check: the exact JSON-escaped field, not just a parsed-value compare — proves
    // the on-disk text itself carries the value unmodified, not merely an equal re-serialization.
    expect(raw).toContain('"superseded_by": "acc-desires-100"');

    const written = JSON.parse(raw) as { nodes: Array<{ id: string; superseded_by?: string }> };
    expect(written.nodes).toHaveLength(2);
    expect(written.nodes[0].id).toBe('acc-desires-099'); // original index preserved
    expect(written.nodes[0].superseded_by).toBe('acc-desires-100');
    expect(written.nodes[1].id).toBe('acc-desires-100');
    expect(written.nodes[1].superseded_by).toBeUndefined();
  });

  it("stampSaveNodes doesn't alter an unchanged superseded node's other fields on a 2nd save", () => {
    const supersededNode = {
      id: 'acc-desires-099',
      label: 'Old node',
      superseded_by: 'acc-desires-100',
      description: 'original description',
    };
    const liveNode = { id: 'acc-desires-100', label: 'Live node' };

    // First save establishes the on-disk baseline (stamps _edit_meta/_edit_history).
    saveTaxonomyFile('accelerationist', { nodes: [supersededNode, liveNode] });
    const afterFirstSave = JSON.parse(fs.readFileSync(path.join(taxonomyDir, 'accelerationist.json'), 'utf-8'));
    const stampedSupersededNode = afterFirstSave.nodes[0];
    expect(stampedSupersededNode.superseded_by).toBe('acc-desires-100');

    // Re-save the identical payload the renderer would send back (the stamped node, unchanged).
    saveTaxonomyFile('accelerationist', { nodes: [stampedSupersededNode, afterFirstSave.nodes[1]] });
    const afterSecondSave = JSON.parse(fs.readFileSync(path.join(taxonomyDir, 'accelerationist.json'), 'utf-8'));

    expect(afterSecondSave.nodes[0]).toEqual(stampedSupersededNode); // byte-for-byte same object, including superseded_by and description
  });
});
