// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/682 (t/651): pullDataUpdates must never commit local content. The old `git add -A` plus an
 * electron-auto commit put untracked user content (chats, debates, ...) into the public data
 * repo's history. Runs against real git: a bare "origin", a local clone as the data root, and a
 * second clone that pushes an upstream change. `electron` and `fileIO` are mocked; git is real.
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const hoisted = vi.hoisted(() => ({ dataRoot: '' }));

vi.mock('electron', () => ({ net: { fetch: async () => ({ ok: true, status: 200 }) } }));
vi.mock('../fileIO.js', () => ({ resolveDataPath: () => hoisted.dataRoot }));

import { pullDataUpdates } from '../dataUpdateChecker.js';

// Git hooks export GIT_DIR, GIT_INDEX_FILE and friends. Inherited, they point every git call
// here (and pullDataUpdates' own runGit, which uses process.env) at the repo running the
// hook instead of the temp repos: under pre-push, this test once committed onto the real
// branch and tried to push to origin main. Strip them for the whole file and restore after.
const savedGitEnv: Record<string, string> = {};
beforeAll(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('GIT_')) { savedGitEnv[k] = process.env[k]!; delete process.env[k]; }
  }
});
afterAll(() => { Object.assign(process.env, savedGitEnv); });

let tmp = '';
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf-8', windowsHide: true }).trim();

/** Refuses to run git mutations unless `dir` really is inside the temp dir. */
function assertInTmp(dir: string): void {
  const top = path.resolve(git(dir, 'rev-parse', '--show-toplevel'));
  if (!top.toLowerCase().startsWith(path.resolve(tmp).toLowerCase())) {
    throw new Error(`t/682 test: git in ${dir} resolves to ${top}, outside the temp dir; refusing`);
  }
}
const write = (root: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't682-'));
  const origin = path.join(tmp, 'origin.git');
  git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
  const seed = path.join(tmp, 'seed');
  git(tmp, 'clone', '-q', origin, seed);
  assertInTmp(seed);
  write(seed, 'taxonomy/acc.json', '{"v":1}\n');
  write(seed, 'summaries/doc.json', '{"s":1}\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'seed');
  git(seed, 'push', '-q', 'origin', 'HEAD:main');

  hoisted.dataRoot = path.join(tmp, 'data');
  git(tmp, 'clone', '-q', origin, hoisted.dataRoot);
  assertInTmp(hoisted.dataRoot);

  // Upstream moves on: a corpus change the pull should bring in.
  write(seed, 'summaries/new.json', '{"n":1}\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'upstream');
  git(seed, 'push', '-q', 'origin', 'HEAD:main');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('pullDataUpdates never commits local content (t/682)', () => {
  it('an untracked chats/x.json is not committed, stays on disk untracked, and the pull still lands', async () => {
    const root = hoisted.dataRoot;
    write(root, 'chats/x.json', '{"private":true}\n');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await pullDataUpdates();

    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(root, 'summaries/new.json'))).toBe(true); // upstream arrived
    expect(git(root, 'log', '--all', '--format=%H', '--', 'chats/x.json')).toBe(''); // never in any commit
    expect(git(root, 'log', '--format=%an')).not.toContain('electron-auto');
    expect(git(root, 'status', '--porcelain')).toContain('?? chats/');
    expect(fs.readFileSync(path.join(root, 'chats/x.json'), 'utf-8')).toContain('private');
    expect(warn.mock.calls.some(a => String(a[0]).includes('1 untracked file(s) left unstaged'))).toBe(true);
    warn.mockRestore();
  });

  it('a local edit to a tracked file is kept in the working tree, not committed', async () => {
    const root = hoisted.dataRoot;
    write(root, 'taxonomy/acc.json', '{"v":2,"local":true}\n');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await pullDataUpdates();

    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(root, 'summaries/new.json'))).toBe(true);
    expect(git(root, 'log', '--format=%an')).not.toContain('electron-auto');
    expect(git(root, 'rev-parse', 'HEAD')).toBe(git(root, 'rev-parse', 'origin/main')); // no local commit on top
    expect(fs.readFileSync(path.join(root, 'taxonomy/acc.json'), 'utf-8')).toContain('"local":true');
    expect(git(root, 'status', '--porcelain')).toContain('M taxonomy/acc.json');
    warn.mockRestore();
  });

  it('a clean tree pulls with no WARN', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await pullDataUpdates();
    expect(result.success).toBe(true);
    expect(warn.mock.calls.some(a => String(a[0]).includes('dirty data root'))).toBe(false);
    warn.mockRestore();
  });

  it('a conflicting stash restore returns success:false naming the file and the stash (SO risk on #5581)', async () => {
    const root = hoisted.dataRoot;
    const seed = path.join(tmp, 'seed');
    // Upstream edits the same tracked file the user edited locally: `pull --rebase --autostash`
    // exits 0 but the stash restore conflicts (warning on stderr only).
    write(seed, 'taxonomy/acc.json', '{"v":3,"upstream":true}\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'upstream edits acc');
    git(seed, 'push', '-q', 'origin', 'HEAD:main');
    write(root, 'taxonomy/acc.json', '{"v":2,"local":true}\n');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await pullDataUpdates();

    expect(result.success).toBe(false);
    expect(result.message).toContain('taxonomy/acc.json');
    expect(result.message).toContain('stash@{0}');
    expect(git(root, 'stash', 'list')).toContain('autostash'); // the edit is not lost
    expect(warn.mock.calls.some(a => String(a[0]).includes('autostash restore conflicted'))).toBe(true);
    warn.mockRestore();
  });
});
