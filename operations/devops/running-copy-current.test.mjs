// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/556: enqueue-pr.mjs refuses when its running copy differs from origin/main.
// Run: node --test operations/devops/running-copy-current.test.mjs
// Every test injects git and the file reader: no network, no real repository state.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  localImports, importClosure, checkRunningCopy, currencyRefusalMessage, currencyOkLine, CURRENCY_ENTRY_POINTS, REPO_ROOT,
} from './running-copy-current.mjs';
import { GATE_SCRIPTS } from './gate-file-change.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const MAIN = 'a'.repeat(40);
const ENQ = 'operations/devops/enqueue-pr.mjs';
const GATE = 'operations/devops/gate-file-change.mjs';
const LIB = 'operations/devops/lib.mjs';
const DEEP = 'operations/devops/sub/deep.mjs';

// A tiny repo: enqueue-pr imports lib (multi-line) and gate-file-change; lib imports sub/deep.
const FILES = {
  [ENQ]: "import { x } from 'node:fs';\nimport {\n  a,\n  b,\n} from './lib.mjs';\nimport { g } from './gate-file-change.mjs';\n",
  [GATE]: "export const g = 1;\n",
  [LIB]: "export { d } from './sub/deep.mjs';\nexport const a = 1, b = 2;\n",
  [DEEP]: "export const d = 1;\n",
};
const blob = (p, text) => `blob:${p}:${text.length}`; // stands in for a content hash

/** A fake git: `main` maps a path to its content on origin/main (absent = missing there). */
function fakeGit({ main = { ...FILES }, local = FILES, fetchFails = false, fetchHead = MAIN, hashFails = null } = {}) {
  const calls = [];
  const git = (args) => {
    calls.push(args);
    if (args[0] === 'fetch') { if (fetchFails) throw Object.assign(new Error('fatal: unable to access origin'), { stderr: 'fatal: unable to access origin\n' }); return ''; }
    if (args[0] === 'rev-parse' && args[1] === 'FETCH_HEAD') return `${fetchHead}\n`;
    if (args[0] === 'rev-parse' && args[1] === '--verify') {
      const p = args[3].slice(args[3].indexOf(':') + 1);
      if (!(p in main)) throw new Error('exit 1');
      return `${blob(p, main[p])}\n`;
    }
    if (args[0] === 'hash-object') {
      const p = args[2];
      if (hashFails === p) throw new Error('fatal: could not open');
      return `${blob(p, local[p])}\n`;
    }
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  git.calls = calls;
  return git;
}
const reader = (local = FILES) => (p) => { if (!(p in local)) throw new Error(`ENOENT: ${p}`); return local[p]; };

test('localImports: static (multi-line), re-exports, bare and dynamic relative imports; never packages or node: builtins', () => {
  const src = "import fs from 'node:fs';\nimport x from 'lodash';\nimport {\n a } from './a.mjs';\nexport * from '../b.mjs';\nimport './c.mjs';\nconst m = await import('./d.mjs');\n";
  assert.deepEqual(localImports(src, 'operations/devops/x.mjs'), [
    'operations/b.mjs', 'operations/devops/a.mjs', 'operations/devops/c.mjs', 'operations/devops/d.mjs',
  ]);
});

test('importClosure: walks transitively from the entry points, once per file', () => {
  assert.deepEqual(importClosure([ENQ, GATE], reader()).paths, [ENQ, GATE, LIB, DEEP].sort());
});

test('IDENTICAL: every file matches origin/main -> ok, with the SHA and every compared path', () => {
  const git = fakeGit();
  const r = checkRunningCopy({ git, readLocal: reader(), entries: [ENQ, GATE] });
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'current');
  assert.equal(r.mainSha, MAIN);
  assert.deepEqual(r.paths, [ENQ, GATE, LIB, DEEP].sort());
  assert.deepEqual(git.calls[0], ['fetch', '-q', 'origin', 'main'], 'it fetches first');
  assert.match(currencyOkLine(r), new RegExp(`matches origin/main ${MAIN} \\(4 files: .*enqueue-pr\\.mjs`));
});

test('WRAPPER DIFFERS: refused with reason differs, naming the file', () => {
  const r = checkRunningCopy({ git: fakeGit({ main: { ...FILES, [ENQ]: `${FILES[ENQ]}// newer\n` } }), readLocal: reader(), entries: [ENQ, GATE] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'differs');
  assert.equal(r.detail, ENQ);
});

test('IMPORTED MODULE DIFFERS (two levels down): refused with reason differs', () => {
  const r = checkRunningCopy({ git: fakeGit({ main: { ...FILES, [DEEP]: 'export const d = 2; // changed\n' } }), readLocal: reader(), entries: [ENQ, GATE] });
  assert.equal(r.reason, 'differs');
  assert.equal(r.detail, DEEP);
});

test('FETCH FAILS: refused with reason fetch_failed (never a WARN-and-proceed), and nothing else is read', () => {
  const git = fakeGit({ fetchFails: true });
  const r = checkRunningCopy({ git, readLocal: () => { throw new Error('must not read'); }, entries: [ENQ, GATE] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'fetch_failed');
  assert.match(r.detail, /unable to access origin/);
  assert.equal(git.calls.length, 1);
});

test('FETCH_HEAD that is not a SHA is fetch_failed too', () => {
  assert.equal(checkRunningCopy({ git: fakeGit({ fetchHead: 'garbage' }), readLocal: reader(), entries: [ENQ] }).reason, 'fetch_failed');
});

test('ORIGIN/MAIN LACKS THE FILE: refused with reason missing_on_main', () => {
  const main = { ...FILES };
  delete main[LIB];
  const r = checkRunningCopy({ git: fakeGit({ main }), readLocal: reader(), entries: [ENQ, GATE] });
  assert.equal(r.reason, 'missing_on_main');
  assert.equal(r.detail, LIB);
});

test('READ FAILS: an unreadable local module or hash is read_failed', () => {
  const local = { ...FILES };
  delete local[LIB];
  assert.equal(checkRunningCopy({ git: fakeGit({ local }), readLocal: reader(local), entries: [ENQ, GATE] }).reason, 'read_failed');
  assert.equal(checkRunningCopy({ git: fakeGit({ hashFails: GATE }), readLocal: reader(), entries: [ENQ, GATE] }).reason, 'read_failed');
});

test('refusal message: Goal / Problem / Location / Next steps, naming the main-tools fix, for every reason', () => {
  for (const reason of ['fetch_failed', 'read_failed', 'missing_on_main', 'differs']) {
    const msg = currencyRefusalMessage({ ok: false, reason, mainSha: MAIN, detail: ENQ });
    assert.match(msg, new RegExp(`refusing to run \\(${reason}\\)`));
    for (const part of ['Goal:', 'Problem:', 'Location:', 'Next steps:']) assert.ok(msg.includes(part), `${reason}: ${part}`);
    assert.ok(msg.includes('git -C .worktrees/main-tools fetch -q origin && git -C .worktrees/main-tools checkout -q --detach origin/main'));
  }
});

test('the check protects itself: running-copy-current.mjs is in GATE_SCRIPTS and in the compared closure', () => {
  assert.ok(GATE_SCRIPTS.includes('operations/devops/running-copy-current.mjs'));
  const real = (p) => readFileSync(path.join(REPO_ROOT, p), 'utf8');
  const closure = importClosure(CURRENCY_ENTRY_POINTS, real);
  assert.equal(closure.error, undefined);
  for (const p of ['operations/devops/enqueue-pr.mjs', 'operations/devops/gate-file-change.mjs', 'operations/devops/running-copy-current.mjs', 'operations/devops/t1-approval-at-head.mjs']) {
    assert.ok(closure.paths.includes(p), p);
  }
});

test('localImports: an import quoted in a comment is not an import (a false one would refuse every run)', () => {
  const src = "// Static `import ... from './x'` is matched.\n/* import y from './y.mjs' */\n * export * from './z.mjs'\nimport { real } from './real.mjs';\n";
  assert.deepEqual(localImports(src, 'operations/devops/m.mjs'), ['operations/devops/real.mjs']);
});

test('the REAL closure of the entry points reads cleanly and matches what the modules import', () => {
  const real = (p) => readFileSync(path.join(REPO_ROOT, p), 'utf8');
  const closure = importClosure(CURRENCY_ENTRY_POINTS, real);
  assert.equal(closure.error, undefined, String(closure.error));
  assert.ok(closure.paths.every((p) => p.startsWith('operations/devops/') && p.endsWith('.mjs')), closure.paths.join(', '));
});
