// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/4878 (t/4872 AC, follow-up to t/4424/t/4355 AC2): SituationNodeSchema now declares
 * `superseded_by` (lib/debate/schemas.ts), mirroring PovNodeSchema's field exactly, but the
 * editor's own situations.json save path had never been directly checked for it — only the POV
 * file round-trip was covered by saveTaxonomyFile.supersededBy.test.ts. Same scaffold: the real
 * fileIO.ts read/write path is exercised (not mocked), so "byte-identical" means the actual bytes
 * on disk.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const hoisted = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMPDIR || '/tmp';
  const root = `${base}/t4878-situation-superseded-by-${process.pid}-${Date.now()}`;
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

// A BDI-compliant interpretation per POV — satisfies guardSituationsBdiSave on first write
// (missing baseline ⇒ every node is new and validated), unrelated to the superseded_by check.
const compliantInterpretation = { belief: 'b', desire: 'd', intention: 'i' };

beforeEach(() => {
  taxonomyDir = resolveDataPath(loadDataConfig().taxonomy_dir);
  fs.mkdirSync(taxonomyDir, { recursive: true });
  // resolveSituationsFilePath (fileIO.ts) falls back to cross-cutting.json when situations.json
  // doesn't exist yet — seed an empty situations.json so writes land where this test reads.
  fs.writeFileSync(path.join(taxonomyDir, 'situations.json'), JSON.stringify({ nodes: [] }), 'utf-8');
  hoisted.handlers.clear();
  registerTaxonomyHandlers();
});

afterEach(() => {
  fs.rmSync(hoisted.root, { recursive: true, force: true });
});

describe('save-taxonomy-file (situations): superseded_by round-trips byte-identical (t/4878)', () => {
  it("a superseded situation's superseded_by survives a save byte-identical, at its original index", () => {
    const supersededNode = {
      id: 'sit-001',
      label: 'Old situation',
      description: 'A situation that is old',
      interpretations: {
        accelerationist: compliantInterpretation,
        safetyist: compliantInterpretation,
        skeptic: compliantInterpretation,
      },
      linked_nodes: [],
      conflict_ids: [],
      superseded_by: 'sit-002',
    };
    const liveNode = {
      id: 'sit-002',
      label: 'New situation',
      description: 'A situation that is new',
      interpretations: {
        accelerationist: compliantInterpretation,
        safetyist: compliantInterpretation,
        skeptic: compliantInterpretation,
      },
      linked_nodes: [],
      conflict_ids: [],
    };
    const payload = { nodes: [supersededNode, liveNode] };

    saveTaxonomyFile('situations', payload);

    const raw = fs.readFileSync(path.join(taxonomyDir, 'situations.json'), 'utf-8');
    expect(raw).toContain('"superseded_by": "sit-002"');

    const written = JSON.parse(raw) as { nodes: Array<{ id: string; superseded_by?: string }> };
    expect(written.nodes).toHaveLength(2);
    expect(written.nodes[0].id).toBe('sit-001'); // original index preserved
    expect(written.nodes[0].superseded_by).toBe('sit-002');
    expect(written.nodes[1].id).toBe('sit-002');
    expect(written.nodes[1].superseded_by).toBeUndefined();
  });

  it('a 2nd save of the unchanged superseded situation preserves superseded_by without re-triggering the BDI gate', () => {
    const supersededNode = {
      id: 'sit-001',
      label: 'Old situation',
      description: 'A situation that is old',
      interpretations: {
        accelerationist: compliantInterpretation,
        safetyist: compliantInterpretation,
        skeptic: compliantInterpretation,
      },
      linked_nodes: [],
      conflict_ids: [],
      superseded_by: 'sit-002',
    };
    const liveNode = {
      id: 'sit-002',
      label: 'New situation',
      description: 'A situation that is new',
      interpretations: {
        accelerationist: compliantInterpretation,
        safetyist: compliantInterpretation,
        skeptic: compliantInterpretation,
      },
      linked_nodes: [],
      conflict_ids: [],
    };

    saveTaxonomyFile('situations', { nodes: [supersededNode, liveNode] });
    const afterFirstSave = JSON.parse(fs.readFileSync(path.join(taxonomyDir, 'situations.json'), 'utf-8'));

    // Re-save the identical payload the renderer would send back (the stamped nodes, unchanged
    // interpretations) — must not throw the BDI gate and must keep superseded_by intact.
    expect(() => saveTaxonomyFile('situations', afterFirstSave)).not.toThrow();

    const afterSecondSave = JSON.parse(fs.readFileSync(path.join(taxonomyDir, 'situations.json'), 'utf-8'));
    expect(afterSecondSave.nodes[0].superseded_by).toBe('sit-002');
    expect(afterSecondSave.nodes[1].superseded_by).toBeUndefined();
  });
});
