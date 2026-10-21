// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * t/4391 (follow-up to #3639, the sources-index.json session-ref bug): a
 * guard against the same class recurring. `sources-index.json` existed on
 * `ai-triad-data` `main`, but every signed-in user's request still read it as
 * missing — the read resolved against the request's `api-session/*` branch,
 * which predated the commit that added the file. Pipeline-generated data
 * (never user-written) must always read `ref: 'main'`; only user-editable
 * content should resolve against the caller's session branch.
 *
 * This asserts the call shape directly (via `fileIO.setBackend`, a spy
 * `StorageBackend`) for every pipeline-generated reader fixed under t/4391 —
 * a *registered* set, not a codebase-wide static scan. A reader added later
 * for another pipeline-generated path needs its own line here (or a
 * stronger, AST-based lint rule, left as a possible follow-up — see
 * `eslint-rules/no-raw-data-root-read.js` for the project's precedent for
 * that style of enforcement).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { StorageBackend } from '../storage/storageBackend.js';
import { FilesystemBackend } from '../storage/filesystemBackend.js';
import * as fileIO from '../storage/fileIO.js';
import { resetNodeSourceIndexCacheForTests } from '../storage/nodeSourceIndex.js';

function makeSpyBackend(): StorageBackend & { readFile: ReturnType<typeof vi.fn>; listDirectory: ReturnType<typeof vi.fn> } {
  return {
    backendName: 'spy',
    readFile: vi.fn().mockResolvedValue(null),
    writeFile: vi.fn().mockResolvedValue({ version: '' }),
    listDirectory: vi.fn().mockResolvedValue([]),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    fileExists: vi.fn().mockResolvedValue(false),
    readBinaryFile: vi.fn().mockResolvedValue(null),
    writeBinaryFile: vi.fn().mockResolvedValue(undefined),
  };
}

describe('pipeline-generated-data reads always pin ref: main (t/4391)', () => {
  let spy: ReturnType<typeof makeSpyBackend>;

  beforeEach(() => {
    spy = makeSpyBackend();
    fileIO.setBackend(spy);
    resetNodeSourceIndexCacheForTests();
  });

  afterEach(() => {
    // Restore the real backend — this is a module-level singleton (fileIO.ts's
    // `let backend`), so leaving the spy installed would leak into whichever
    // test file runs next in this worker.
    fileIO.setBackend(new FilesystemBackend());
  });

  it('readPolicyRegistry (policy_actions.json)', async () => {
    await fileIO.readPolicyRegistry();
    expect(spy.readFile).toHaveBeenCalledWith(expect.stringContaining('policy_actions.json'), expect.objectContaining({ ref: 'main' }));
  });

  it('readConflictClusters (_conflict-clusters.json)', async () => {
    await fileIO.readConflictClusters();
    expect(spy.readFile).toHaveBeenCalledWith(expect.stringContaining('_conflict-clusters.json'), expect.objectContaining({ ref: 'main' }));
  });

  it('readLineageCategories (lineage_categories.json)', async () => {
    await fileIO.readLineageCategories();
    expect(spy.readFile).toHaveBeenCalledWith(expect.stringContaining('lineage_categories.json'), expect.objectContaining({ ref: 'main' }));
  });

  it('loadSummary (summaries/<id>.json)', async () => {
    await fileIO.loadSummary('doc-a');
    expect(spy.readFile).toHaveBeenCalledWith(expect.stringContaining('doc-a.json'), expect.objectContaining({ ref: 'main' }));
  });
});
