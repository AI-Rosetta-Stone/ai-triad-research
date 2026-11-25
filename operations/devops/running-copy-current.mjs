// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/556 (t/537#40, TL p/9#518 item 2, Security p/131#45): enqueue-pr.mjs refuses to run when the
// copy that is running is not origin/main's.
//
// WHY. #5439's gate-file refusal only exists in a current copy of the wrapper. The shared checkout
// sat 71 commits behind with a pre-#5439 copy, and an enqueue from it skipped the check entirely.
// So before any other check, the wrapper fetches origin main and compares the CONTENT of itself,
// gate-file-change.mjs and every local module they import (transitively, relative imports only)
// with origin/main's blob. Any difference, a file origin/main lacks, or a failed fetch or read
// refuses. FAIL CLOSED: a failed fetch is a refusal, never a WARN-and-proceed.
//
// LIMIT (stated in t/556): a copy older than this change cannot refuse itself. The one-time
// fast-forward (t/537) and the behind-main alert (t/557) cover that.
//
// This module is in GATE_SCRIPTS (gate-file-change.mjs), so a PR that edits it needs a Tech Lead or
// Security review at its head before the wrapper takes it.
//
// Pure core: localImports, currencyVerdict. Impure shim: checkRunningCopy (git + fs, injectable).

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..', '..');

/** The entry points whose import graph is compared. Repo-relative, forward slashes. */
export const CURRENCY_ENTRY_POINTS = Object.freeze([
  'operations/devops/enqueue-pr.mjs',
  'operations/devops/gate-file-change.mjs',
]);

export const MAIN_TOOLS_FIX =
  'git -C .worktrees/main-tools fetch -q origin && git -C .worktrees/main-tools checkout -q --detach origin/main';

// Static `import ... from './x'`, `export ... from './x'`, bare `import './x'` (multi-line import
// lists included), and dynamic `import('./x')`. Relative specifiers only: packages and node:
// builtins are not repo files.
// A static import starts its own line; comment lines (`//`, `/*`, ` *`) are blanked first, so an
// import quoted in a comment is never read as one (a false import would refuse every run).
const STATIC_RE = /^[ \t]*(?:import|export)\s+(?:[^'"`;]*?\s+from\s+)?['"](\.{1,2}\/[^'"]+)['"]/gm;
const DYNAMIC_RE = /\bimport\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;
const COMMENT_LINE_RE = /^[ \t]*(?:\/\/|\/\*|\*).*$/gm;

/** PURE. Repo-relative paths of the relative modules `source` (at repo-relative `fromPath`) imports. */
export function localImports(source, fromPath) {
  const dir = path.posix.dirname(fromPath);
  const code = String(source ?? '').replace(COMMENT_LINE_RE, '');
  const out = new Set();
  for (const re of [STATIC_RE, DYNAMIC_RE]) {
    for (const m of code.matchAll(re)) out.add(path.posix.normalize(path.posix.join(dir, m[1])));
  }
  return [...out].sort();
}

/**
 * PURE. Walks the import graph from `entries` with `readLocal(path) -> text` (throws on failure).
 * Returns `{ paths }` (sorted, entries included) or `{ error, path }` on the first unreadable file.
 */
export function importClosure(entries, readLocal) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const p = queue.shift();
    if (seen.has(p)) continue;
    seen.add(p);
    let text;
    try {
      text = readLocal(p);
    } catch (err) {
      return { error: err, path: p };
    }
    for (const dep of localImports(text, p)) if (!seen.has(dep)) queue.push(dep);
  }
  return { paths: [...seen].sort() };
}

/**
 * Impure (git and fs injectable). Fetches origin main, then compares every file in the import
 * closure of CURRENCY_ENTRY_POINTS with origin/main's blob. Never throws. Returns
 * `{ ok: true, reason: 'current', mainSha, paths }` or
 * `{ ok: false, reason, mainSha?, paths?, detail }` with `reason` one of:
 *   'fetch_failed'    `git fetch origin main` or reading FETCH_HEAD failed
 *   'read_failed'     a local file (or its hash) could not be read
 *   'missing_on_main' a file in the closure does not exist on origin/main
 *   'differs'         a file's content differs from origin/main's (detail names every one)
 * `git(args) -> stdout` throws on a non-zero exit; `readLocal(repoRelativePath) -> text`.
 */
export function checkRunningCopy({ git = defaultGit, readLocal = defaultReadLocal, entries = CURRENCY_ENTRY_POINTS } = {}) {
  let mainSha;
  try {
    git(['fetch', '-q', 'origin', 'main']);
    mainSha = String(git(['rev-parse', 'FETCH_HEAD'])).trim();
    if (!/^[0-9a-f]{40}$/.test(mainSha)) throw new Error(`FETCH_HEAD is not a commit SHA (${JSON.stringify(mainSha)})`);
  } catch (err) {
    return { ok: false, reason: 'fetch_failed', detail: firstLine(err) };
  }

  const closure = importClosure(entries, readLocal);
  if (closure.error) return { ok: false, reason: 'read_failed', mainSha, detail: `${closure.path}: ${firstLine(closure.error)}` };

  const missing = [];
  const differs = [];
  for (const p of closure.paths) {
    let mainBlob;
    try {
      mainBlob = String(git(['rev-parse', '--verify', '--quiet', `${mainSha}:${p}`])).trim();
    } catch {
      mainBlob = '';
    }
    if (!mainBlob) { missing.push(p); continue; }
    let localBlob;
    try {
      // hash-object applies the path's clean filters (autocrlf), so a CRLF checkout of an identical
      // file hashes like the LF blob on main.
      localBlob = String(git(['hash-object', '--', p])).trim();
    } catch (err) {
      return { ok: false, reason: 'read_failed', mainSha, paths: closure.paths, detail: `${p}: ${firstLine(err)}` };
    }
    if (localBlob !== mainBlob) differs.push(p);
  }
  if (missing.length) return { ok: false, reason: 'missing_on_main', mainSha, paths: closure.paths, detail: missing.join(', ') };
  if (differs.length) return { ok: false, reason: 'differs', mainSha, paths: closure.paths, detail: differs.join(', ') };
  return { ok: true, reason: 'current', mainSha, paths: closure.paths };
}

/** PURE. The ActionableError text for a refusal (Goal / Problem / Location / Next steps). */
export function currencyRefusalMessage(result) {
  const problem = {
    fetch_failed: `could not fetch origin main to compare against (${result.detail}). A failed fetch is a refusal, not a pass.`,
    read_failed: `could not read a file of the running copy (${result.detail}).`,
    missing_on_main: `origin/main (${result.mainSha}) does not have: ${result.detail}.`,
    differs: `the running copy differs from origin/main (${result.mainSha}) in: ${result.detail}.`,
  }[result.reason] ?? `unexpected currency result ${JSON.stringify(result.reason)}.`;
  return (
    `enqueue-pr: refusing to run (${result.reason}) -- this copy of the wrapper is not origin/main's.\n` +
    '  Goal:       enqueue only with the current gates (a stale copy can skip a refusal, t/537#40).\n' +
    `  Problem:    ${problem}\n` +
    '  Location:   operations/devops/running-copy-current.mjs (checkRunningCopy, t/556).\n' +
    `  Next steps: run it from a worktree at origin/main (${MAIN_TOOLS_FIX}), or fast-forward this checkout to origin/main, then rerun.`
  );
}

/** PURE. The one success line: the origin/main SHA and every compared path. */
export function currencyOkLine(result) {
  return `enqueue-pr: running copy matches origin/main ${result.mainSha} (${result.paths.length} files: ${result.paths.join(', ')})`;
}

function firstLine(err) {
  return String(err?.stderr || err?.message || err).trim().split('\n')[0];
}

function defaultGit(args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function defaultReadLocal(p) {
  return readFileSync(path.join(REPO_ROOT, p), 'utf8');
}
