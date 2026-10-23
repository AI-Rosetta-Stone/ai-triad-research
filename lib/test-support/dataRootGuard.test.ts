// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * Both-arms tests for the test-run data-root write guard (t/4461; design t/4454#2, conditions t/4454#3).
 * Each case runs against a MOCKED protected root under os.tmpdir(), never the real ai-triad-data.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { writeFileSync as namedWriteFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  installDataRootGuard, resolveProtectedDataRoot, resolveProtectedDataRoots, protectedDataRoot, isUnderRoot,
  DATA_ROOT_TEST_WRITE_TOKEN, DATA_ROOT_GUARD_INSTALLED_TOKEN,
} from './dataRootGuard.js';

let base: string;
let root: string;      // the mocked protected root
let link: string;      // a symlink / junction that resolves to it
let outside: string;   // a temp dir outside it
let hadGuard = false;
let warn: ReturnType<typeof vi.spyOn>;

const hits = () => warn.mock.calls.filter(c => String(c[0]).startsWith(DATA_ROOT_TEST_WRITE_TOKEN));

beforeAll(() => {
  // If a setupFiles guard is already installed in this worker, set it aside so these tests own the install.
  hadGuard = (globalThis as Record<symbol, unknown>)[Symbol.for('ai-triad.dataRootGuard.installed')] !== undefined;
  if (hadGuard) installDataRootGuard()(); // returns the existing install's uninstall; call it
  base = fs.mkdtempSync(path.join(os.tmpdir(), 't4461-'));
  root = path.join(base, 'ai-triad-data');
  outside = path.join(base, 'elsewhere');
  fs.mkdirSync(path.join(root, 'taxonomy'), { recursive: true });
  fs.mkdirSync(outside);
  fs.mkdirSync(path.join(base, 'ai-triad-data2'));
  link = path.join(base, 'data-link');
  fs.symlinkSync(root, link, process.platform === 'win32' ? 'junction' : 'dir');
});

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
  if (hadGuard) installDataRootGuard();
});

let uninstall: () => void = () => {};
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  uninstall = installDataRootGuard({ mode: 'warn', protectedRoot: root });
});
afterEach(() => {
  uninstall();
  warn.mockRestore();
  delete process.env.AI_TRIAD_DATA_ROOT;
});

describe('dataRootGuard: writes under the protected root WARN (t/4454#3)', () => {
  it('a direct write warns with the fixed token, the op and the target, and still writes (Phase 1 is warn-only)', () => {
    const target = path.join(root, 'taxonomy', 'a.json');
    fs.writeFileSync(target, '{}');
    expect(hits()).toHaveLength(1);
    const msg = String(hits()[0][0]);
    expect(msg).toContain('op=fs.writeFileSync');
    expect(msg).toContain(`target=${target}`);
    expect(fs.existsSync(target)).toBe(true);
  });

  it('a write through a symlink / junction to the root warns (cond. 1: resolved real paths)', () => {
    fs.writeFileSync(path.join(link, 'taxonomy', 'via-link.json'), '{}');
    expect(hits()).toHaveLength(1);
  });

  it('a not-yet-existing nested target under the root warns', () => {
    expect(() => fs.writeFileSync(path.join(root, '__guard_livefire__', 'missing', 'x.json'), '{}')).toThrow(/ENOENT/);
    expect(hits()).toHaveLength(1);
  });

  it('AI_TRIAD_DATA_ROOT pointed at the real root does not exempt it (cond. 3)', () => {
    process.env.AI_TRIAD_DATA_ROOT = root;
    fs.writeFileSync(path.join(root, 'b.json'), '{}');
    expect(hits()).toHaveLength(1);
  });

  it('a named ESM import sees the wrapper (syncBuiltinESMExports)', () => {
    namedWriteFileSync(path.join(root, 'named.json'), '{}');
    expect(hits()).toHaveLength(1);
  });

  it('async, promise, stream, rename, copy, mkdir and rm paths warn', async () => {
    await new Promise<void>((res, rej) => fs.writeFile(path.join(root, 'cb.json'), '{}', e => (e ? rej(e) : res())));
    await fs.promises.writeFile(path.join(root, 'p.json'), '{}');
    await fs.promises.mkdir(path.join(root, 'dir'), { recursive: true });
    await new Promise<void>((res, rej) => {
      const s = fs.createWriteStream(path.join(root, 's.json'));
      s.on('error', rej); s.end('{}', () => res());
    });
    const src = path.join(outside, 'src.json');
    fs.writeFileSync(src, '{}');
    fs.copyFileSync(src, path.join(root, 'copied.json'));
    fs.renameSync(path.join(root, 'copied.json'), path.join(outside, 'moved-out.json')); // moving OUT deletes there
    fs.rmSync(path.join(root, 'p.json'));
    const ops = hits().map(c => /op=(\S+)/.exec(String(c[0]))?.[1]);
    expect(ops).toEqual([
      'fs.writeFile', 'fs.promises.writeFile', 'fs.promises.mkdir', 'fs.createWriteStream',
      'fs.copyFileSync', 'fs.renameSync', 'fs.rmSync',
    ]);
  });

  it.runIf(process.platform === 'win32')('matches case-insensitively on win32', () => {
    fs.writeFileSync(path.join(root.toUpperCase(), 'upper.json'), '{}');
    expect(hits()).toHaveLength(1);
  });
});

describe('dataRootGuard: precision arm, writes elsewhere stay silent', () => {
  it('a temp-dir write is silent', async () => {
    fs.writeFileSync(path.join(outside, 'ok.json'), '{}');
    await fs.promises.writeFile(path.join(outside, 'ok2.json'), '{}');
    expect(hits()).toHaveLength(0);
  });

  it('a sibling that only shares the prefix (ai-triad-data2) is silent (separator-bounded)', () => {
    fs.writeFileSync(path.join(base, 'ai-triad-data2', 'x.json'), '{}');
    expect(isUnderRoot(path.join(base, 'ai-triad-data2', 'x.json'), root)).toBe(false);
    expect(hits()).toHaveLength(0);
  });

  it('an fd argument is ignored, not crashed on', () => {
    const fd = fs.openSync(path.join(outside, 'fd.json'), 'w');
    try { fs.writeFileSync(fd, '{}'); } finally { fs.closeSync(fd); }
    expect(hits()).toHaveLength(0);
  });
});

describe('dataRootGuard: install contract', () => {
  it('proof arm: with the guard uninstalled, the same write is silent, so the WARN comes from the wrapper', () => {
    uninstall();
    fs.writeFileSync(path.join(root, 'unguarded.json'), '{}');
    expect(hits()).toHaveLength(0);
  });

  it('a second install is idempotent: no double wrapping, one WARN per write', () => {
    const again = installDataRootGuard({ mode: 'warn', protectedRoot: root });
    expect(again).toBe(uninstall);
    fs.writeFileSync(path.join(root, 'once.json'), '{}');
    expect(hits()).toHaveLength(1);
  });

  it('with several protected roots, a write under any of them warns', () => {
    uninstall();
    uninstall = installDataRootGuard({ mode: 'warn', protectedRoot: [path.join(base, 'ai-triad-data2'), root] });
    fs.writeFileSync(path.join(root, 'second.json'), '{}');
    fs.writeFileSync(path.join(base, 'ai-triad-data2', 'first.json'), '{}');
    expect(hits()).toHaveLength(2);
  });

  it('emits one DATA-ROOT-GUARD-INSTALLED marker per process, with the mode and the roots, however often it installs (t/4464)', () => {
    // An earlier install in this worker (setupFiles, or a test above) already emitted it; reset to observe it.
    uninstall();
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('ai-triad.dataRootGuard.markerEmitted')];
    const markers = () => warn.mock.calls.map(c => String(c[0])).filter(m => m.startsWith(DATA_ROOT_GUARD_INSTALLED_TOKEN));
    uninstall = installDataRootGuard({ mode: 'warn', protectedRoot: root });
    installDataRootGuard({ mode: 'warn', protectedRoot: root }); // idempotent call
    uninstall();
    uninstall = installDataRootGuard({ mode: 'warn', protectedRoot: root }); // reinstall after an uninstall
    expect(markers()).toHaveLength(1);
    const [marker] = markers();
    expect(marker).toMatch(/^DATA-ROOT-GUARD-INSTALLED mode=warn roots=\[/);
    expect(JSON.parse(marker.slice(marker.indexOf('roots=') + 'roots='.length))).toEqual([fs.realpathSync.native(root)]);
  });

  it("mode 'block' is refused until the Phase 2 T2 change", () => {
    expect(() => installDataRootGuard({ mode: 'block' })).toThrow(/Phase 2 of t\/4454/);
  });

  it('protectedDataRoot() reports the installed root', () => {
    expect(isUnderRoot(protectedDataRoot(), root) && isUnderRoot(root, protectedDataRoot())).toBe(true);
  });
});

describe('resolveProtectedDataRoot (cond. 2)', () => {
  const repo = () => path.join(base, 'repo');
  beforeEach(() => {
    fs.rmSync(repo(), { recursive: true, force: true });
    fs.mkdirSync(path.join(repo(), 'lib', 'test-support'), { recursive: true });
  });

  it('resolves .aitriad.json data_root relative to the repo root, ignoring AI_TRIAD_DATA_ROOT', () => {
    fs.writeFileSync(path.join(repo(), '.aitriad.json'), JSON.stringify({ data_root: '../ai-triad-data' }));
    process.env.AI_TRIAD_DATA_ROOT = outside;
    const r = resolveProtectedDataRoot(path.join(repo(), 'lib', 'test-support'));
    expect(isUnderRoot(r, root) && isUnderRoot(root, r)).toBe(true);
  });

  it('an absolute data_root is used as-is', () => {
    fs.writeFileSync(path.join(repo(), '.aitriad.json'), JSON.stringify({ data_root: outside }));
    expect(isUnderRoot(resolveProtectedDataRoot(repo()), outside)).toBe(true);
  });

  it('an unreadable config WARNs and protects the default ../ai-triad-data, never nothing', () => {
    fs.writeFileSync(path.join(repo(), '.aitriad.json'), '{ not json');
    const r = resolveProtectedDataRoot(repo());
    expect(isUnderRoot(r, root) && isUnderRoot(root, r)).toBe(true);
    expect(warn.mock.calls.some(c => String(c[0]).includes('protecting the default'))).toBe(true);
  });

  it("a linked worktree also protects the MAIN checkout's data root (reached via AI_TRIAD_DATA_ROOT in worktree runs)", () => {
    // main checkout at <base>/repo (data root ../ai-triad-data = the mocked root); worktree at <repo>/.worktrees/wt
    fs.writeFileSync(path.join(repo(), '.aitriad.json'), JSON.stringify({ data_root: '../ai-triad-data' }));
    const wt = path.join(repo(), '.worktrees', 'wt');
    fs.mkdirSync(path.join(repo(), '.git', 'worktrees', 'wt'), { recursive: true });
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(path.join(wt, '.aitriad.json'), JSON.stringify({ data_root: '../ai-triad-data' }));
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(repo(), '.git', 'worktrees', 'wt')}\n`);
    // the worktree's own root (.worktrees/ai-triad-data) doesn't exist: skipped with a WARN (amended cond. 2)
    let roots = resolveProtectedDataRoots(wt);
    expect(roots).toHaveLength(1);
    expect(isUnderRoot(roots[0], root) && isUnderRoot(root, roots[0])).toBe(true); // the main checkout's
    expect(warn.mock.calls.some(c => /ai-triad-data does not exist; skipped/.test(String(c[0])))).toBe(true);
    // once the worktree's own root exists too, the protected set is the union
    fs.mkdirSync(path.join(repo(), '.worktrees', 'ai-triad-data'));
    roots = resolveProtectedDataRoots(wt);
    expect(roots).toHaveLength(2);
    expect(isUnderRoot(roots[0], path.join(repo(), '.worktrees', 'ai-triad-data'))).toBe(true);
    expect(isUnderRoot(resolveProtectedDataRoot(wt), roots[0])).toBe(true);
  });

  it("when no configured root exists, it WARNs and protects the main checkout's default, never nothing", () => {
    const main = path.join(base, 'nomain', 'repo');
    const wt = path.join(main, '.worktrees', 'wt');
    fs.mkdirSync(path.join(main, '.git', 'worktrees', 'wt'), { recursive: true });
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(path.join(main, '.aitriad.json'), JSON.stringify({ data_root: '../missing-a' }));
    fs.writeFileSync(path.join(wt, '.aitriad.json'), JSON.stringify({ data_root: '../missing-b' }));
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'wt')}\n`);
    const roots = resolveProtectedDataRoots(wt);
    expect(roots).toHaveLength(1);
    expect(isUnderRoot(roots[0], path.join(base, 'nomain', 'ai-triad-data'))).toBe(true);
    expect(warn.mock.calls.some(c => /no configured data root exists; protecting the default/.test(String(c[0])))).toBe(true);
  });

  it('a plain checkout (.git is a directory) protects only its own root', () => {
    fs.writeFileSync(path.join(repo(), '.aitriad.json'), JSON.stringify({ data_root: '../ai-triad-data' }));
    fs.mkdirSync(path.join(repo(), '.git'), { recursive: true });
    expect(resolveProtectedDataRoots(repo())).toHaveLength(1);
  });

  it('the real resolution (from the module location) finds a data root ending in the configured name', () => {
    delete process.env.AI_TRIAD_DATA_ROOT;
    expect(path.basename(resolveProtectedDataRoot()).toLowerCase()).toContain('ai-triad-data');
  });
});
