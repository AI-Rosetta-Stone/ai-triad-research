// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/644 (Security p/306#2): the capture harness's guards. Each refusal is tested with a path that must be
// refused and one that must pass, so a guard can't pass vacuously.

import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error -- plain .mjs script without types
import { allowlistedEnv, dataRootProblem, enclosingRepo, isWithin, protectedDataRoots, mainCheckoutOf } from '../electron-capture/capture.mjs';

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

// t/743: .aitriad.json's data_root is relative, so a worktree resolved it to a path that does not exist.
describe('protectedDataRoots from a worktree (t/743)', () => {
  const layout = (name: string) => {
    const base = join(scratch, name);
    const main = join(base, 'repo');
    const wt = join(main, '.worktrees', 'wt');
    const data = join(base, 'ai-triad-data');
    mkdirSync(wt, { recursive: true });
    mkdirSync(data, { recursive: true });
    writeFileSync(join(main, '.aitriad.json'), JSON.stringify({ data_root: '../ai-triad-data' }));
    return { main, wt, data };
  };

  it('main checkout: protects data_root resolved against it, no warning', () => {
    const { main, data } = layout('main-layout');
    const warns: string[] = [];
    const roots = protectedDataRoots(main, {}, (m: string) => warns.push(m), main);
    expect(roots).toContain(realpathSync(data));
    expect(warns).toEqual([]);
  });

  it("worktree: the main checkout's data_root is protected, and the worktree-relative miss is not the only entry", () => {
    const { main, wt, data } = layout('wt-layout');
    writeFileSync(join(wt, '.aitriad.json'), JSON.stringify({ data_root: '../ai-triad-data' }));
    const warns: string[] = [];
    const roots = protectedDataRoots(wt, {}, (m: string) => warns.push(m), main);
    expect(roots).toContain(realpathSync(data));
    expect(warns).toEqual([]); // one of the candidates exists, so the guard protects something
  });

  it("worktree with no .aitriad.json of its own: falls back to the main checkout's", () => {
    const { main, wt, data } = layout('wt-nocfg');
    expect(protectedDataRoots(wt, {}, () => {}, main)).toContain(realpathSync(data));
  });

  it('env override is protected too', () => {
    const { main } = layout('env-layout');
    const envRoot = join(scratch, 'env-data');
    mkdirSync(envRoot, { recursive: true });
    expect(protectedDataRoots(main, { AI_TRIAD_DATA_ROOT: envRoot }, () => {}, main)).toContain(realpathSync(envRoot));
  });

  it('WARNs when the configured data_root exists nowhere', () => {
    const base = join(scratch, 'missing-layout');
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, '.aitriad.json'), JSON.stringify({ data_root: '../no-such-data' }));
    const warns: string[] = [];
    protectedDataRoots(base, {}, (m: string) => warns.push(m), base);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/does not exist/);
  });
});

// t/743 follow-up (Security p/246#15): mainCheckoutOf's fallback must say so.
describe('mainCheckoutOf (t/743 follow-up)', () => {
  it('a directory git cannot read: returns it and WARNs with the reason', () => {
    const notGit = join(scratch, 'not-a-git-dir');
    mkdirSync(notGit, { recursive: true });
    const warns: string[] = [];
    expect(mainCheckoutOf(notGit, (m: string) => warns.push(m))).toBe(notGit);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/git rev-parse --git-common-dir failed/);
    expect(warns[0]).toContain(notGit);
  });

  it('a real checkout: returns the main checkout and does not WARN', () => {
    const warns: string[] = [];
    const main = mainCheckoutOf(undefined, (m: string) => warns.push(m));
    expect(typeof main).toBe('string');
    expect(warns).toEqual([]);
  });

  it('protectedDataRoots passes its warn through, so the fallback is visible there too', () => {
    const notGit = join(scratch, 'not-a-git-dir-2');
    mkdirSync(notGit, { recursive: true });
    const warns: string[] = [];
    protectedDataRoots(notGit, {}, (m: string) => warns.push(m));
    expect(warns.some(w => /git rev-parse --git-common-dir failed/.test(w))).toBe(true);
  });
});
