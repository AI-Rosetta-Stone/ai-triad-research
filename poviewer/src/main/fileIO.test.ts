// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Regression tests for t/2534 (M6/M7/M8pov/M9pov): renderer-supplied IDs used
// in path construction must be rejected with statusCode 400 on any traversal
// attempt, and happy paths must be unchanged.

import { describe, it, expect, vi, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// fileIO.ts imports `electron` (app) for repo-root resolution at module load —
// stub it so the module loads deterministically under vitest's node environment.
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp', getAppPath: () => process.cwd() },
}));

// SOURCES_DIR is computed at module load from AI_TRIAD_SOURCES_ROOT — point it
// at an isolated temp dir BEFORE importing fileIO.
const TMP_SOURCES = fs.mkdtempSync(path.join(process.env.TEMP ?? process.env.TMPDIR ?? '/tmp', 'poviewer-t2534-sources-'));
process.env.AI_TRIAD_SOURCES_ROOT = TMP_SOURCES;

// Loaded in beforeAll (not top-level await — tsconfig.main.json compiles tests
// as CommonJS) so the env var above is in place before module-load resolution.
let fileIO: typeof import('./fileIO.js');
beforeAll(async () => {
  fileIO = await import('./fileIO.js');
});

const TRAVERSAL_IDS = ['../evil', '..', 'a/b', 'a\\b', '/etc/passwd', 'C:\\evil', '', '. .', 'a..b/../c'];

function expect400(fn: () => unknown): void {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    /* telemetry — silent by design (test captures the expected throw) */
    thrown = err;
  }
  expect(thrown, 'expected the call to throw').toBeDefined();
  expect((thrown as { statusCode?: number }).statusCode).toBe(400);
  expect((thrown as Error).name).toBe('ActionableError');
}

describe('t/2534 path-traversal hardening: sourceId read/write paths', () => {
  const fns: Array<[string, (id: string) => unknown]> = [
    ['readSnapshot (M8pov)', (id) => fileIO.readSnapshot(id)],
    ['loadPipelineSummary (M8pov)', (id) => fileIO.loadPipelineSummary(id)],
    ['findRawPdfPath / readRawPdfBytes (M8pov)', (id) => fileIO.readRawPdfBytes(id)],
    ['saveAnnotations (M6)', (id) => fileIO.saveAnnotations(id, [])],
    ['loadAnnotations (M6)', (id) => fileIO.loadAnnotations(id)],
    ['saveAnalysisResult (M6)', (id) => fileIO.saveAnalysisResult(id, {})],
    ['loadAnalysisResult (M6)', (id) => fileIO.loadAnalysisResult(id)],
    ['getSourceDir (M6)', (id) => fileIO.getSourceDir(id)],
    ['setActiveTaxonomyDir (M9pov)', (id) => fileIO.setActiveTaxonomyDir(id)],
  ];

  for (const [name, fn] of fns) {
    describe(name, () => {
      for (const bad of TRAVERSAL_IDS) {
        it(`rejects ${JSON.stringify(bad)} with statusCode 400`, () => {
          expect400(() => fn(bad));
        });
      }
    });
  }

  it('createSourceOnDisk (M7 write site) rejects a traversal meta.id with 400', () => {
    expect400(() => fileIO.createSourceOnDisk({
      id: '../evil',
      title: 't',
      sourceType: 'pdf',
      url: null,
      addedAt: new Date().toISOString(),
      status: 'pending',
    }));
    // Nothing escaped the sources root
    expect(fs.existsSync(path.join(TMP_SOURCES, '..', 'evil'))).toBe(false);
  });
});

describe('t/2534 happy paths unchanged', () => {
  it('createSourceOnDisk + readSnapshot + annotations + analysis round-trip with a safe id', () => {
    const id = 'good-id_01';
    fileIO.createSourceOnDisk({
      id,
      title: 'Good',
      sourceType: 'pdf',
      url: null,
      addedAt: new Date().toISOString(),
      status: 'pending',
    });
    expect(fs.existsSync(path.join(TMP_SOURCES, id, 'metadata.json'))).toBe(true);

    fs.writeFileSync(path.join(TMP_SOURCES, id, 'snapshot.md'), '# hello', 'utf-8');
    expect(fileIO.readSnapshot(id)).toBe('# hello');

    fileIO.saveAnnotations(id, [{ note: 'n1' }]);
    expect(fileIO.loadAnnotations(id)).toEqual([{ note: 'n1' }]);

    fileIO.saveAnalysisResult(id, { ok: true });
    expect(fileIO.loadAnalysisResult(id)).toEqual({ ok: true });

    expect(fileIO.getSourceDir(id)).toBe(path.resolve(TMP_SOURCES, id));
  });

  it('readRawPdfBytes returns null for a safe id with no raw/ dir', () => {
    expect(fileIO.readRawPdfBytes('good-id_01')).toBe(null);
  });

  it('loadPipelineSummary returns null for a safe id with no summary file', () => {
    expect(fileIO.loadPipelineSummary('no-such-doc')).toBe(null);
  });

  it('setActiveTaxonomyDir still raises the not-found ActionableError (no 400) for a safe unknown name', () => {
    let thrown: unknown;
    try {
      fileIO.setActiveTaxonomyDir('no-such-taxonomy-dir');
    } catch (err) {
      /* telemetry — silent by design (test captures the expected throw) */
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect((thrown as Error).name).toBe('ActionableError');
    expect((thrown as { statusCode?: number }).statusCode).toBeUndefined();
    expect((thrown as Error).message).toContain('Taxonomy directory not found');
  });
});

describe('t/781 retired Gemini ids in saved AI settings', () => {
  it('maps gemini-2.5-flash and gemini-2.5-pro to their successors and leaves other ids alone', () => {
    expect(fileIO.migrateRetiredModel({ model: 'gemini-2.5-flash', temperature: 0.2 })).toEqual({ model: 'gemini-3.5-flash-lite', temperature: 0.2 });
    expect(fileIO.migrateRetiredModel({ model: 'gemini-2.5-pro', temperature: 0.1 }).model).toBe('gemini-3.8-flash');
    expect(fileIO.migrateRetiredModel({ model: 'gemini-3.5-flash-lite', temperature: 0.1 }).model).toBe('gemini-3.5-flash-lite');
  });
});
