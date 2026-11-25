// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/644 (Security p/306#2): the capture harness's guards. Each refusal is tested with a path that must be
// refused and one that must pass, so a guard can't pass vacuously.

import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error -- plain .mjs script without types
import { allowlistedEnv, dataRootProblem, enclosingRepo, isWithin } from '../electron-capture/capture.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'capture-guard-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('electron-capture guards (t/644)', () => {
  it('passes only allowlisted variables to the app', () => {
    const env = allowlistedEnv({ PATH: 'p', SystemRoot: 'C:\\Windows', ANTHROPIC_API_KEY: 'k', GH_TOKEN: 't', GITHUB_TOKEN: 't', AI_API_KEY: 'k', AI_TRIAD_DATA_ROOT: 'real' });
    expect(env).toEqual({ PATH: 'p', SystemRoot: 'C:\\Windows' });
  });

  it('refuses a data root that is, contains or sits inside the real tree', () => {
    const realTree = join(scratch, 'ai-triad-data');
    mkdirSync(join(realTree, 'taxonomy'), { recursive: true });
    expect(dataRootProblem(realTree, [realTree])).toMatch(/overlaps the real data tree/);
    expect(dataRootProblem(join(realTree, 'taxonomy'), [realTree])).toMatch(/overlaps/);
    expect(dataRootProblem(scratch, [realTree])).toMatch(/overlaps/);
  });

  it('refuses a data root inside a git checkout, and accepts a plain scratch copy', () => {
    const clone = join(scratch, 'clone');
    mkdirSync(join(clone, '.git'), { recursive: true });
    mkdirSync(join(clone, 'data'), { recursive: true });
    expect(dataRootProblem(join(clone, 'data'), [])).toMatch(/inside the git checkout/);
    const copy = join(scratch, 'copy');
    mkdirSync(copy, { recursive: true });
    expect(dataRootProblem(copy, [join(scratch, 'ai-triad-data')])).toBeNull();
    expect(dataRootProblem(join(scratch, 'missing'), [])).toMatch(/does not exist/);
  });

  it('finds the enclosing checkout for --out (a .git file counts, as in a worktree)', () => {
    const wt = join(scratch, 'wt');
    mkdirSync(join(wt, 'a', 'b'), { recursive: true });
    writeFileSync(join(wt, '.git'), 'gitdir: elsewhere\n');
    expect(enclosingRepo(join(wt, 'a', 'b', 'shots'))).toBe(wt);
    expect(enclosingRepo(join(scratch, 'copy', 'shots'))).toBeNull();
  });

  it('isWithin is path-aware, not a string prefix', () => {
    expect(isWithin(join(scratch, 'data2'), join(scratch, 'data'))).toBe(false);
    expect(isWithin(join(scratch, 'data', 'x'), join(scratch, 'data'))).toBe(true);
  });
});
