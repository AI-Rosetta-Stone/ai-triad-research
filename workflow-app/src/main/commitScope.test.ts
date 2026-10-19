// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/3894 C + D, against a real throwaway git repo (TL condition, t/3894#2/#6).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Record every git invocation while still running real git, so the argv assertion
// below covers exactly what the code executes.
const gitCalls: string[][] = [];
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFileSync: ((file: string, args: string[], opts: unknown) => {
      if (file === 'git') gitCalls.push(args);
      return actual.execFileSync(file, args, opts as never);
    }) as typeof actual.execFileSync,
  };
});

const { execFileSync } = await import('child_process');
const { snapshotDirty, planCommit, executeCommit, parsePorcelainZ, underSurface } = await import('./commitScope');

let repo: string;
const sh = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true });
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text);
};
const committedFiles = () => sh('show', '--name-only', '--format=', 'HEAD').trim().split('\n').filter(Boolean).sort();
const baselineNow = () => ({ takenAt: new Date().toISOString(), entries: snapshotDirty(repo) });

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-scope-'));
  sh('init', '-q');
  sh('config', 'user.email', 'test@example.com');
  sh('config', 'user.name', 'Test');
  sh('config', 'commit.gpgsign', 'false');
  write('summaries/existing.json', '{"a":1}');
  write('taxonomy/Origin/situations.json', '{"nodes":[]}');
  sh('add', 'summaries/existing.json', 'taxonomy/Origin/situations.json');
  sh('commit', '-q', '-m', 'init');
  gitCalls.length = 0;
});

afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

describe('C: commit exactly what the run changed', () => {
  it('a normal run commits exactly its own changes', () => {
    const baseline = baselineNow();
    write('summaries/new.json', '{"b":2}');
    write('summaries/existing.json', '{"a":2}');
    const plan = planCommit(baseline, snapshotDirty(repo), ['summaries']);
    expect(plan).toEqual({ ok: true, paths: ['summaries/existing.json', 'summaries/new.json'], warnings: [] });
    if (plan.ok) executeCommit(repo, plan.paths, 'pipeline(summarize): test');
    expect(committedFiles()).toEqual(['summaries/existing.json', 'summaries/new.json']);
  });

  it('excludes a file that was already dirty at run start and untouched since', () => {
    write('summaries/peer-wip.json', 'peer');
    const baseline = baselineNow();
    write('summaries/new.json', 'mine');
    const plan = planCommit(baseline, snapshotDirty(repo), ['summaries']);
    expect(plan.ok && plan.paths).toEqual(['summaries/new.json']);
    if (plan.ok) executeCommit(repo, plan.paths, 'pipeline(summarize): test');
    expect(committedFiles()).toEqual(['summaries/new.json']);
    expect(sh('status', '--porcelain')).toContain('summaries/peer-wip.json');
  });

  it('refuses when a file dirty at run start was also changed during the run', () => {
    write('summaries/existing.json', 'peer edit');
    const baseline = baselineNow();
    write('summaries/existing.json', 'run edit on top');
    const plan = planCommit(baseline, snapshotDirty(repo), ['summaries']);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toMatch(/already had uncommitted changes .* summaries\/existing\.json/);
  });

  it('a peer merely staging an already-dirty file is not read as a change by the run', () => {
    write('summaries/existing.json', 'peer edit');
    const baseline = baselineNow();
    sh('add', 'summaries/existing.json'); // status ' M' → 'M ', content unchanged
    write('summaries/new.json', 'mine');
    const plan = planCommit(baseline, snapshotDirty(repo), ['summaries']);
    expect(plan.ok && plan.paths).toEqual(['summaries/new.json']);
  });

  it("does not commit a peer's staged file sitting in the shared index (t/3670)", () => {
    write('notes/peer.txt', 'peer');
    sh('add', 'notes/peer.txt'); // peer staged before the run
    const baseline = baselineNow();
    write('summaries/new.json', 'mine');
    const plan = planCommit(baseline, snapshotDirty(repo), ['summaries']);
    if (plan.ok) executeCommit(repo, plan.paths, 'pipeline(summarize): test');
    expect(committedFiles()).toEqual(['summaries/new.json']);
    expect(sh('diff', '--cached', '--name-only').trim()).toBe('notes/peer.txt'); // still staged, untouched
  });

  it('stages a deletion made during the run', () => {
    const baseline = baselineNow();
    fs.rmSync(path.join(repo, 'summaries/existing.json'));
    const plan = planCommit(baseline, snapshotDirty(repo), ['summaries']);
    expect(plan.ok && plan.paths).toEqual(['summaries/existing.json']);
    if (plan.ok) executeCommit(repo, plan.paths, 'pipeline(summarize): test');
    expect(sh('ls-files', 'summaries/existing.json').trim()).toBe('');
  });

  it('refuses with no baseline (no data step since the last commit, or a restart)', () => {
    write('summaries/new.json', 'x');
    const plan = planCommit(null, snapshotDirty(repo), ['summaries']);
    expect(plan.ok).toBe(false);
  });

  it('refuses when nothing changed during the run', () => {
    write('summaries/peer-wip.json', 'peer');
    const baseline = baselineNow();
    const plan = planCommit(baseline, snapshotDirty(repo), ['summaries']);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toMatch(/nothing in the data checkout changed/);
  });

  it('warns when the baseline is more than 24h old', () => {
    const baseline = { takenAt: new Date(Date.now() - 30 * 3_600_000).toISOString(), entries: snapshotDirty(repo) };
    write('summaries/new.json', 'x');
    const plan = planCommit(baseline, snapshotDirty(repo), ['summaries']);
    expect(plan.ok && plan.warnings[0]).toMatch(/30h old/);
  });

  it('never stages by -A, --all, ".", or a bare directory', () => {
    const baseline = baselineNow();
    write('summaries/new.json', 'x');
    const plan = planCommit(baseline, snapshotDirty(repo), ['summaries']);
    if (plan.ok) executeCommit(repo, plan.paths, 'pipeline(summarize): test');
    const addAndCommit = gitCalls.filter(a => a[0] === 'add' || a[0] === 'commit');
    expect(addAndCommit.map(a => a[0])).toEqual(['add', 'commit']);
    for (const args of addAndCommit) {
      for (const bad of ['-A', '--all', '.', 'summaries', 'summaries/', '-a', '--include']) expect(args).not.toContain(bad);
      expect(args).toContain('--pathspec-file-nul');
    }
  });
});

describe('D: changes outside the steps\' declared surfaces are refused', () => {
  it('refuses a file changed outside the declared surfaces (a concurrent writer)', () => {
    const baseline = baselineNow();
    write('summaries/new.json', 'mine');
    write('taxonomy/Origin/situations.json', '{"nodes":["editor harvest"]}');
    const plan = planCommit(baseline, snapshotDirty(repo), ['summaries']);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toMatch(/outside what its steps write .* taxonomy\/Origin\/situations\.json/);
  });

  it('matches directory and file surfaces exactly, not by prefix text', () => {
    expect(underSurface('summaries/x.json', ['summaries'])).toBe(true);
    expect(underSurface('summaries-old/x.json', ['summaries'])).toBe(false);
    expect(underSurface('taxonomy/Origin/embeddings.json', ['taxonomy/Origin/embeddings.json'])).toBe(true);
    expect(underSurface('taxonomy/Origin/edges.json', ['taxonomy/Origin/embeddings.json'])).toBe(false);
  });
});

describe('parsePorcelainZ', () => {
  it('skips the source path of a rename entry', () => {
    expect(parsePorcelainZ('R  new.json\0old.json\0 M a.json\0?? b.json\0')).toEqual([
      { status: 'R ', path: 'new.json' }, { status: ' M', path: 'a.json' }, { status: '??', path: 'b.json' },
    ]);
  });
});
