// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/3894: the data-repo commit. Fix A — refuse when no data-producing step ran (f9cb8ef4,
// 09-29, was a lone git-commit step that committed the shared checkout's accumulated WIP,
// 78 files, as "pipeline(adhoc)"). C+D — the in-process commit, against a real temp repo.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildCommitMessage, PIPELINE_STEPS, planPush, recordDataStep, resetPipelineState, runGitCommit, runGitPush } from './pipeline';

const BASE = { surfaces: ['summaries'], runId: 'r1', commitSummary: 'did it', baselineAt: '2026-10-04T00:00:00.000Z' };

describe('buildCommitMessage — zero-step refusal (t/3894 fix A)', () => {
  it('refuses when no data-producing step ran (the f9cb8ef4 shape)', () => {
    expect(() => buildCommitMessage({ ...BASE, steps: [] })).toThrow(/Refusing to commit: no data-producing pipeline step ran/);
  });

  it('names the real steps and carries the Baseline-At trailer', () => {
    const msg = buildCommitMessage({ ...BASE, steps: ['summarize'] });
    expect(msg.split('\n')[0]).toBe('pipeline(summarize): did it');
    expect(msg).toContain('Steps: summarize');
    expect(msg).toContain('Surfaces: summaries');
    expect(msg).toContain('Baseline-At: 2026-10-04T00:00:00.000Z');
    expect(msg).not.toContain('pipeline(adhoc)');
  });
});

describe('PIPELINE_STEPS writes', () => {
  it('declares no surface that would let D pass a whole-tree change', () => {
    for (const step of PIPELINE_STEPS) {
      for (const w of step.writes) expect(w, `${step.id}: ${w}`).toMatch(/^[\w.-]+(\/[\w.-]+)*$/);
    }
  });
});

describe('runGitCommit — C+D in a real repo (t/3894)', () => {
  let repo: string;
  let out: string;
  let err: string;
  const sh = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true });
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text);
  };
  const commit = () => runGitCommit(repo, { runId: 'run-1', commitSummary: 'test' }, t => { out += t; }, t => { err += t; });
  const headSubject = () => sh('log', '-1', '--format=%s').trim();

  beforeEach(() => {
    resetPipelineState();
    out = '';
    err = '';
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-pipe-'));
    sh('init', '-q');
    sh('config', 'user.email', 'test@example.com');
    sh('config', 'user.name', 'Test');
    sh('config', 'commit.gpgsign', 'false');
    write('summaries/existing.json', '1');
    write('taxonomy/Origin/edges.json', '{}');
    sh('add', 'summaries/existing.json', 'taxonomy/Origin/edges.json');
    sh('commit', '-q', '-m', 'init');
  });

  afterEach(() => {
    resetPipelineState();
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('refuses a lone git-commit with no data step since the last commit (fix A, main-side)', () => {
    write('summaries/stray.json', 'someone else');
    expect(commit().exitCode).toBe(1);
    expect(err).toMatch(/no data-producing pipeline step ran/);
    expect(headSubject()).toBe('init');
  });

  it('a read-only step does not open a run', () => {
    recordDataStep('health', repo);
    write('summaries/stray.json', 'someone else');
    expect(commit().exitCode).toBe(1);
    expect(headSubject()).toBe('init');
  });

  it("commits exactly the run's paths with provenance, leaving prior WIP and staged peers alone", () => {
    write('summaries/peer-wip.json', 'peer');
    write('notes/peer-staged.txt', 'peer');
    sh('add', 'notes/peer-staged.txt');
    recordDataStep('summarize', repo);
    write('summaries/new.json', 'mine');
    expect(commit().exitCode).toBe(0);
    expect(sh('show', '--name-only', '--format=', 'HEAD').trim()).toBe('summaries/new.json');
    const body = sh('log', '-1', '--format=%B');
    expect(body).toMatch(/^pipeline\(summarize\): test/);
    expect(body).toMatch(/Baseline-At: \d{4}-\d\d-\d\dT/);
    expect(body).toContain('Run-Id: run-1');
    expect(sh('diff', '--cached', '--name-only').trim()).toBe('notes/peer-staged.txt');
    expect(out).toContain('summaries/new.json');
  });

  it('closes the run on success: a second commit with no new step is refused', () => {
    recordDataStep('summarize', repo);
    write('summaries/new.json', 'mine');
    expect(commit().exitCode).toBe(0);
    write('summaries/later.json', 'someone else');
    expect(commit().exitCode).toBe(1);
  });

  it("refuses a change outside the ran steps' surfaces (fix D)", () => {
    recordDataStep('summarize', repo);
    write('summaries/new.json', 'mine');
    write('taxonomy/Origin/edges.json', '{"concurrent":true}');
    expect(commit().exitCode).toBe(1);
    expect(err).toMatch(/outside what its steps write.*taxonomy\/Origin\/edges\.json/);
    expect(headSubject()).toBe('init');
  });

  it("a hook-refused commit leaves none of the run's paths staged in the shared index", () => {
    write('.githooks/pre-commit', '#!/bin/sh\necho "refused by test hook" >&2\nexit 1\n');
    fs.chmodSync(path.join(repo, '.githooks/pre-commit'), 0o755);
    sh('add', '.githooks/pre-commit');
    sh('commit', '-q', '--no-verify', '-m', 'hook');
    recordDataStep('summarize', repo);
    write('summaries/new.json', 'mine');
    expect(commit().exitCode).toBe(1);
    expect(err).toMatch(/refused by test hook/);
    expect(headSubject()).toBe('hook');
    expect(sh('diff', '--cached', '--name-only').trim()).toBe('');
    expect(fs.readFileSync(path.join(repo, 'summaries/new.json'), 'utf8')).toBe('mine');
  });
});

// t/683: the push publishes only the pipeline's own commits (Security, t/651).
describe('planPush — pure (t/683)', () => {
  const SURF = ['summaries', 'taxonomy/Origin'];
  it('accepts a commit this pipeline made, under a declared surface', () => {
    expect(planPush([{ sha: 'a1', paths: ['summaries/x.json'] }], new Set(['a1']), SURF).ok).toBe(true);
  });
  it('refuses a commit the pipeline did not make, naming it and its paths', () => {
    const r = planPush([{ sha: 'b2222222222222', paths: ['chats/x.json'] }], new Set(['a1']), SURF);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not made by this pipeline run[\s\S]*chats\/x\.json/);
  });
  it('refuses a pipeline commit that touches a path outside the surfaces', () => {
    const r = planPush([{ sha: 'a1', paths: ['chats/x.json'] }], new Set(['a1']), SURF);
    expect(r.ok).toBe(false);
  });
  it('does not treat a prefix sibling as inside a surface', () => {
    expect(planPush([{ sha: 'a1', paths: ['summariesX/y.json'] }], new Set(['a1']), SURF).ok).toBe(false);
  });
});

describe('runGitPush — real repo with an upstream (t/683)', () => {
  let repo: string;
  let remote: string;
  let out: string;
  let err: string;
  const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text);
  };
  const remoteHas = (rel: string) => {
    const files = sh(remote, 'ls-tree', '-r', '--name-only', 'main');
    return files.split('\n').includes(rel);
  };

  beforeEach(() => {
    resetPipelineState();
    out = '';
    err = '';
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-push-'));
    remote = path.join(base, 'remote.git');
    repo = path.join(base, 'data');
    fs.mkdirSync(remote);
    sh(remote, 'init', '-q', '--bare');
    fs.mkdirSync(repo);
    sh(repo, 'init', '-q', '-b', 'main');
    sh(repo, 'config', 'user.email', 'test@example.com');
    sh(repo, 'config', 'user.name', 'Test');
    sh(repo, 'config', 'commit.gpgsign', 'false');
    write('summaries/existing.json', '1');
    sh(repo, 'add', 'summaries/existing.json');
    sh(repo, 'commit', '-q', '-m', 'init');
    sh(repo, 'remote', 'add', 'origin', remote);
    sh(repo, 'push', '-q', '-u', 'origin', 'main');
  });

  afterEach(() => {
    resetPipelineState();
    fs.rmSync(path.dirname(repo), { recursive: true, force: true });
  });

  it('pushes a commit the pipeline made', () => {
    recordDataStep('summarize', repo);
    write('summaries/new.json', '2');
    expect(runGitCommit(repo, { runId: 'r', commitSummary: 's' }, () => {}, () => {}).exitCode).toBe(0);
    const r = runGitPush(repo, t => { out += t; }, t => { err += t; });
    expect(r.exitCode).toBe(0);
    expect(remoteHas('summaries/new.json')).toBe(true);
  });

  it('refuses a pre-existing local commit adding chats/x.json, and pushes nothing', () => {
    write('chats/x.json', '{"user":"private"}');
    sh(repo, 'add', 'chats/x.json');
    sh(repo, 'commit', '-q', '-m', 'electron auto-commit');
    const r = runGitPush(repo, t => { out += t; }, t => { err += t; });
    expect(r.exitCode).toBe(1);
    expect(err).toMatch(/chats\/x\.json/);
    expect(remoteHas('chats/x.json')).toBe(false);
  });

  it('refuses when the branch has no upstream', () => {
    sh(repo, 'branch', '--unset-upstream');
    const r = runGitPush(repo, t => { out += t; }, t => { err += t; });
    expect(r.exitCode).toBe(1);
    expect(err).toMatch(/no upstream/);
  });
});
