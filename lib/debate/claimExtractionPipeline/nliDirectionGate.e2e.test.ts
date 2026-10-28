// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// End-to-end acceptance test for t/4596 (TL ruling t/4596#2): "One test runs the gate end to
// end in the built server layout: compiled output, a real interpreter lookup, and a fixture
// script." Deliberately NOT mocking child_process — a real `python3`/`python` subprocess runs
// a trivial fixture script (not the real scripts/nli_classify.py; this file doesn't need its
// ML dependencies to prove the resolution + spawn + parse chain works). Kept in its own file so
// nliDirectionGate.test.ts's `vi.mock('child_process', ...)` (hoisted, file-scoped) never
// shadows the real subprocess call here.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveNliScriptPath, runNliDirectionGate } from './nliDirectionGate.js';
import type { ArgumentNetworkNode } from '../types.js';

// Mirrors the real scripts/nli_classify.py SUBPROCESS CONTRACT (stdin JSON array of
// {id, claim_prop, node_prop, ...} -> stdout JSON array of {id, direction, confidence, method})
// without any of its ML dependencies — this test exercises resolution + process plumbing, not
// classification accuracy.
const FIXTURE_SCRIPT = [
  'import sys, json',
  'batch = json.load(sys.stdin)',
  'out = [{"id": b["id"], "direction": "unrelated", "confidence": 0.0, "method": "fixture"} for b in batch]',
  'print(json.dumps(out))',
].join('\n');

function probePythonInterpreter(): string | undefined {
  for (const candidate of ['python3', 'python']) {
    const probe = spawnSync(candidate, ['--version'], { windowsHide: true });
    if (!probe.error) return candidate;
  }
  return undefined;
}

function makeNode(id: string, primaryRef: string): ArgumentNetworkNode {
  return {
    id,
    text: 'a claim',
    speaker: 'accelerationist',
    source_entry_id: 'e1',
    taxonomy_refs: [],
    turn_number: 1,
    claim_taxonomy_attribution: { primary_ref: primaryRef, attribution_confidence: 0.7 },
  } as unknown as ArgumentNetworkNode;
}

describe('nliDirectionGate — end-to-end against a real fixture script (t/4596 acceptance criterion)', () => {
  let tmpRoot: string;
  const ORIGINAL_SCRIPT_ENV = process.env.NLI_CLASSIFY_SCRIPT;

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nli-gate-e2e-'));
    const scriptsDir = path.join(tmpRoot, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(path.join(scriptsDir, 'nli_classify.py'), FIXTURE_SCRIPT, 'utf8');
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  afterEach(() => {
    if (ORIGINAL_SCRIPT_ENV === undefined) delete process.env.NLI_CLASSIFY_SCRIPT;
    else process.env.NLI_CLASSIFY_SCRIPT = ORIGINAL_SCRIPT_ENV;
  });

  it('resolves a dist/server-style compiled layout on real disk — 4 levels up, no mocked fs', () => {
    const compiledDir = path.join(tmpRoot, 'dist', 'server', 'lib', 'debate', 'claimExtractionPipeline');
    fs.mkdirSync(compiledDir, { recursive: true });
    expect(resolveNliScriptPath(compiledDir)).toBe(path.join(tmpRoot, 'scripts', 'nli_classify.py'));
  });

  it('resolves an Electron dist/main-style compiled layout on real disk', () => {
    const compiledDir = path.join(tmpRoot, 'dist', 'main', 'lib', 'debate', 'claimExtractionPipeline');
    fs.mkdirSync(compiledDir, { recursive: true });
    expect(resolveNliScriptPath(compiledDir)).toBe(path.join(tmpRoot, 'scripts', 'nli_classify.py'));
  });

  it('runs the gate end to end: real resolution (via NLI_CLASSIFY_SCRIPT), real interpreter lookup, real subprocess', () => {
    const interpreter = probePythonInterpreter();
    if (!interpreter) {
      // No python3/python on this machine/runner. Skipping silently is fine for local dev
      // without Python installed — but in CI, a missing interpreter must FAIL this test, not
      // quietly pass (TL ruling t/4596#5): a runner-image change that drops Python would
      // otherwise turn this acceptance test into exactly the silent-no-op failure class t/4596
      // fixes, and nobody would notice.
      expect(
        process.env.CI,
        'No python3/python interpreter found on this CI runner — the end-to-end acceptance ' +
        'test for t/4596 cannot be silently skipped in CI.',
      ).toBeFalsy();
      return;
    }
    process.env.NLI_CLASSIFY_SCRIPT = path.join(tmpRoot, 'scripts', 'nli_classify.py');

    const nodes = [makeNode('AN-1', 'acc-bel-001')];
    const nodeTextById = new Map([['acc-bel-001', 'the node this claim is checked against']]);
    const result = runNliDirectionGate(nodes, nodeTextById, 'acc');

    // The fixture always returns 'unrelated' — proves stdin write, subprocess spawn under a
    // real interpreter, stdout read, and JSON parse all actually worked end to end.
    expect(result.counts.unrelated).toBe(1);
    expect(result.opposingIds.size).toBe(0);
  });
});
