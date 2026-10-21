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
 *
 * **The actual rule is narrower than "looks pipeline-generated" (TL
 * p/538#161, after `readPolicyRegistry` was wrongly pinned on first pass):
 * pin only where NO path writes that exact file through the session
 * backend.** `policy_actions.json` and the core `lineage-enrichments.json`
 * both have such a writer (`routes/policyRegistry.ts`'s recount,
 * `calibrationStore.ts`'s `promoteLineageEnrichments`) and must NOT be
 * pinned — pinning would break read-after-write for whoever just wrote
 * through their own session branch. The negative-assertion tests below lock
 * that in, so a future "helpful" pin doesn't quietly reintroduce the bug in
 * the other direction.
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

describe('NOT pinned — a session-backend writer exists for these (TL p/538#161)', () => {
  let spy: ReturnType<typeof makeSpyBackend>;

  beforeEach(() => {
    spy = makeSpyBackend();
    fileIO.setBackend(spy);
  });

  afterEach(() => {
    fileIO.setBackend(new FilesystemBackend());
  });

  it('readPolicyRegistry (policy_actions.json) — routes/policyRegistry.ts recounts write this through the session backend', async () => {
    await fileIO.readPolicyRegistry();
    const [, opts] = spy.readFile.mock.calls[0];
    expect(opts?.ref).not.toBe('main');
  });

  it('readLineageEnrichments core map — calibrationStore.ts promoteLineageEnrichments() writes this through the session backend', async () => {
    await fileIO.readLineageEnrichments();
    const [, opts] = spy.readFile.mock.calls[0];
    expect(opts?.ref).not.toBe('main');
  });
});
