// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Test-run guard against writes to the REAL ai-triad-data root (t/4461, prevention for incident t/4453).
 * Design: t/4454#2 (vitest section). TL conditions: t/4454#3.
 *
 * A vitest `setupFiles` entry calls `installDataRootGuard({ mode: 'warn' })` once per test file. It wraps the
 * `node:fs` / `fs/promises` write paths, and every write whose target resolves under the protected root logs
 * a `DATA-ROOT-TEST-WRITE` WARN (target, op, caller stack) and then proceeds — Phase 1 is warn-only (T1).
 * Phase 2 (`mode: 'block'`) is a T2 change and is refused here until then.
 *
 * The protected root is the `.aitriad.json`-configured data root, resolved exactly as the loaders do with
 * AI_TRIAD_DATA_ROOT UNSET — it deliberately ignores the env var, so a test that points the env var at a
 * temp dir writes there silently, and one that points it at the real root is still caught (t/4454#3 cond. 3).
 * The repo root is found from THIS module's location, never `process.cwd()`, so every vitest config agrees.
 *
 * Paths are compared after `fs.realpathSync.native` on the deepest existing ancestor (symlinks — CI's
 * `../ai-triad-data` — and Windows junctions in worktrees resolve to one target), case-insensitively on
 * win32, and bounded on a separator so `ai-triad-data2` does not match `ai-triad-data` (cond. 1).
 *
 * NODE-ONLY: imports node:fs / node:module. Import it from vitest setup files, never from renderer code.
 *
 * Not covered (accepted vectors, t/4454#3): child processes a test spawns; writes through an fd /
 * FileHandle obtained from `fs.open`; `fs.symlink`, `chmod`, `utimes` and other metadata ops.
 */

import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ActionableError } from '../debate/errors.js';
import { getGlobalRecorder } from '../flight-recorder/index.js';

export const DATA_ROOT_TEST_WRITE_TOKEN = 'DATA-ROOT-TEST-WRITE';
export type DataRootGuardMode = 'warn' | 'block';

export interface DataRootGuardOptions {
  /** Phase 1 accepts only 'warn'. 'block' is the Phase 2 T2 change (t/4454#3) and throws until then. */
  mode?: DataRootGuardMode;
  /** Override the protected root(s) — tests of this module only. */
  protectedRoot?: string | string[];
}

const DEFAULT_DATA_ROOT = '../ai-triad-data';
const INSTALLED = Symbol.for('ai-triad.dataRootGuard.installed');
const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── Protected-root resolution ─────────────────────────────────────────────

/** Walk up from `startDir` to the directory holding `.aitriad.json`; null if none. */
function findRepoRoot(startDir: string): string | null {
  let dir = path.resolve(startDir);
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.aitriad.json'))) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

/** One checkout's data root: `.aitriad.json` `data_root` (absolute, or relative to it), else the default. */
function configuredDataRoot(repoRoot: string): string {
  let dataRoot = DEFAULT_DATA_ROOT;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(repoRoot, '.aitriad.json'), 'utf-8')) as { data_root?: unknown };
    if (typeof cfg.data_root === 'string' && cfg.data_root.trim()) dataRoot = cfg.data_root;
    else console.warn(`[dataRootGuard] WARN: ${repoRoot}/.aitriad.json has no data_root; protecting the default ${DEFAULT_DATA_ROOT}`);
  } catch (err) {
    console.warn(`[dataRootGuard] WARN: could not read ${repoRoot}/.aitriad.json (${String(err)}); protecting the default ${DEFAULT_DATA_ROOT}`);
  }
  return canonicalPath(path.isAbsolute(dataRoot) ? dataRoot : path.resolve(repoRoot, dataRoot));
}

/**
 * When `repoRoot` is a linked git worktree (`.git` is a file: `gitdir: <main>/.git/worktrees/<name>`), the main
 * checkout's root; else null. Read from the file, no git process.
 */
function mainCheckoutOf(repoRoot: string): string | null {
  const dotGit = path.join(repoRoot, '.git');
  if (!fs.existsSync(dotGit)) return null; // not a git checkout (e.g. an extracted archive): nothing more to protect
  try {
    if (!fs.statSync(dotGit).isFile()) return null;
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf-8'));
    if (!m) return null;
    const gitdir = path.resolve(repoRoot, m[1]);
    if (path.basename(path.dirname(gitdir)) !== 'worktrees') return null;
    const main = path.dirname(path.dirname(path.dirname(gitdir)));
    return fs.existsSync(path.join(main, '.aitriad.json')) ? main : null;
  } catch (err) {
    const message = `could not read ${dotGit} (${String(err)}); the main checkout's data root is NOT protected`;
    console.warn(`[dataRootGuard] WARN: ${message}`);
    getGlobalRecorder()?.record({ type: 'system.error', component: 'data-root-guard', level: 'warn', message });
    return null;
  }
}

/**
 * Every real data root a test must not write to — the loaders' rule (`.aitriad.json`, else
 * `../ai-triad-data`) with AI_TRIAD_DATA_ROOT ignored, for this checkout AND, when it is a linked worktree, for
 * the main checkout. A worktree's own `../ai-triad-data` usually doesn't exist, so a worktree run reaches the real
 * data only through AI_TRIAD_DATA_ROOT; protecting the main checkout's root is what keeps that run guarded.
 * Never "nothing is protected": an unresolvable config WARNs and falls back to the default (t/4454#3 cond. 2).
 */
export function resolveProtectedDataRoots(startDir: string = HERE): string[] {
  const repoRoot = findRepoRoot(startDir);
  if (!repoRoot) {
    const fallback = path.resolve(startDir, '..', '..', DEFAULT_DATA_ROOT);
    console.warn(`[dataRootGuard] WARN: no .aitriad.json above ${startDir}; protecting the default ${fallback}`);
    return [canonicalPath(fallback)];
  }
  const roots = [configuredDataRoot(repoRoot)];
  const main = mainCheckoutOf(repoRoot);
  if (main) {
    const mainRoot = configuredDataRoot(main);
    if (!roots.some(r => isUnderRoot(mainRoot, r) && isUnderRoot(r, mainRoot))) roots.push(mainRoot);
  }
  return roots;
}

/** The primary protected root: the first that exists on disk (the real data), else the first. */
export function resolveProtectedDataRoot(startDir: string = HERE): string {
  const roots = resolveProtectedDataRoots(startDir);
  return roots.find(r => fs.existsSync(r)) ?? roots[0];
}

/** realpath of the deepest existing ancestor + the not-yet-existing remainder, so new files resolve too. */
function canonicalPath(p: string): string {
  let head = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(head), ...tail.reverse());
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return path.resolve(p);
      tail.push(path.basename(head));
      head = parent;
    }
  }
}

/** True when `target` is the protected root or inside it (separator-bounded; case-insensitive on win32). */
export function isUnderRoot(target: string, root: string): boolean {
  const norm = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s);
  const t = norm(canonicalPath(target));
  const r = norm(canonicalPath(root)).replace(/[\\/]+$/, '');
  return t === r || t.startsWith(r + path.sep);
}

// ── fs wrapping ───────────────────────────────────────────────────────────

/** A path-like fs argument as a string, or null for an fd / anything that isn't a path. */
function asPath(arg: unknown): string | null {
  if (typeof arg === 'string') return arg;
  if (Buffer.isBuffer(arg)) return arg.toString();
  if (arg instanceof URL) return arg.protocol === 'file:' ? fileURLToPath(arg) : null;
  return null;
}

// Which positional args are write targets. rename/cp also check the source: moving a file OUT of the data
// root deletes it there.
const SYNC_AND_CALLBACK: Record<string, number[]> = {
  writeFile: [0], writeFileSync: [0], appendFile: [0], appendFileSync: [0],
  rename: [0, 1], renameSync: [0, 1], copyFile: [1], copyFileSync: [1], cp: [1], cpSync: [1],
  createWriteStream: [0], rm: [0], rmSync: [0], rmdir: [0], rmdirSync: [0],
  unlink: [0], unlinkSync: [0], mkdir: [0], mkdirSync: [0], truncate: [0], truncateSync: [0],
};
const PROMISES: Record<string, number[]> = {
  writeFile: [0], appendFile: [0], rename: [0, 1], copyFile: [1], cp: [1],
  rm: [0], rmdir: [0], unlink: [0], mkdir: [0], truncate: [0],
};

interface Installed { roots: string[]; restore: () => void }
type Registry = { [INSTALLED]?: Installed };

function report(op: string, target: string, root: string): void {
  // console only — no fs on this path, so the guard can't recurse into itself.
  const caller = (new Error().stack ?? '').split('\n').slice(3, 11).join('\n');
  console.warn(`${DATA_ROOT_TEST_WRITE_TOKEN} op=${op} target=${target} protectedRoot=${root}\n${caller}`);
}

function wrapAll(obj: Record<string, unknown>, table: Record<string, number[]>, prefix: string, roots: string[], saved: Array<() => void>): void {
  for (const [name, idxs] of Object.entries(table)) {
    const orig = obj[name];
    if (typeof orig !== 'function') continue;
    const wrapped = function (this: unknown, ...args: unknown[]) {
      outer: for (const i of idxs) {
        const p = asPath(args[i]);
        if (p === null) continue;
        for (const root of roots) {
          if (isUnderRoot(p, root)) { report(prefix + name, path.resolve(p), root); break outer; }
        }
      }
      return (orig as (...a: unknown[]) => unknown).apply(this, args);
    };
    obj[name] = wrapped;
    saved.push(() => { obj[name] = orig; });
  }
}

/**
 * Install the guard for this worker. Idempotent: a second call (setupFiles run per test file in a reused
 * worker) returns the existing installation instead of double-wrapping. Returns a function that uninstalls.
 */
export function installDataRootGuard(opts: DataRootGuardOptions = {}): () => void {
  const mode = opts.mode ?? 'warn';
  if (mode !== 'warn') {
    throw new ActionableError({
      goal: 'Install the test-run data-root write guard',
      problem: `mode '${mode}' is not enabled: blocking test writes is Phase 2 of t/4454, a T2 change`,
      location: 'lib/test-support/dataRootGuard.ts installDataRootGuard',
      nextSteps: [
        "Use mode: 'warn' (Phase 1)",
        'Enable block only through the t/4454 Phase 2 T2 PR (SO round, consult-hold)',
      ],
    });
  }
  const reg = globalThis as Registry;
  const existing = reg[INSTALLED];
  if (existing) return existing.restore;

  const roots = opts.protectedRoot
    ? (Array.isArray(opts.protectedRoot) ? opts.protectedRoot : [opts.protectedRoot]).map(canonicalPath)
    : resolveProtectedDataRoots();
  const saved: Array<() => void> = [];
  wrapAll(fs as unknown as Record<string, unknown>, SYNC_AND_CALLBACK, 'fs.', roots, saved);
  wrapAll(fs.promises as unknown as Record<string, unknown>, PROMISES, 'fs.promises.', roots, saved);
  syncBuiltinESMExports(); // named ESM imports (`import { writeFileSync } from 'node:fs'`) see the wrappers too

  const restore = () => {
    if (reg[INSTALLED]?.restore !== restore) return;
    for (const undo of saved.reverse()) undo();
    syncBuiltinESMExports();
    delete reg[INSTALLED];
  };
  reg[INSTALLED] = { roots, restore };
  return restore;
}

/** Every root the installed guard protects (or would protect). */
export function protectedDataRoots(): string[] {
  return (globalThis as Registry)[INSTALLED]?.roots ?? resolveProtectedDataRoots();
}

/** The primary protected root (the first that exists on disk) — for live-fire tests that target it. */
export function protectedDataRoot(): string {
  const roots = protectedDataRoots();
  return roots.find(r => fs.existsSync(r)) ?? roots[0];
}
