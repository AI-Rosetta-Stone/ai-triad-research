// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/614: pre-push-checks.sh's PowerShell `parse` step passes its file list through a temp file
// (Test-PowerShellSyntax.ps1 -PathsFile), never the command line. A push changing thousands of .ps1 files
// would otherwise pass Windows' ~32 K command line and block the push with an unrelated error.
// Run: node --test operations/devops/pre-push-parse-pathsfile.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CHECKS = path.join(here, 'pre-push-checks.sh');
const SYNTAX = path.join(here, 'Test-PowerShellSyntax.ps1');
const have = (cmd) => spawnSync(cmd, ['--version'], { encoding: 'utf8' }).status === 0;
const SH = ['sh', 'C:\\Program Files\\Git\\bin\\sh.exe'].find((c) => spawnSync(c, ['-c', 'exit 0']).status === 0);
const PWSH = have('pwsh');

function scratchRepo() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 't614-'));
  const git = (...a) => execFileSync('git', ['-C', r, ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.email', 't@example.invalid');
  git('config', 'user.name', 't');
  for (const [rel, src] of [['operations/devops/pre-push-checks.sh', CHECKS], ['operations/devops/Test-PowerShellSyntax.ps1', SYNTAX]]) {
    fs.mkdirSync(path.dirname(path.join(r, rel)), { recursive: true });
    fs.copyFileSync(src, path.join(r, rel));
  }
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  return { r, git };
}

function runChecks(r, base, head) {
  const res = spawnSync(SH, [path.join(r, 'operations/devops/pre-push-checks.sh'), base, head], { cwd: r, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: res.status, out: `${res.stdout}${res.stderr}` };
}

test('Test-PowerShellSyntax -PathsFile: reads the list, reports a bad file as path:line:col, exits 1; a missing list exits 1', { skip: !PWSH && 'no pwsh' }, () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 't614s-'));
  try {
    fs.writeFileSync(path.join(d, 'ok.ps1'), 'function f { 1 }\n');
    fs.writeFileSync(path.join(d, 'bad.ps1'), 'function f {\n  1\n}}\n');
    fs.writeFileSync(path.join(d, 'list.txt'), 'ok.ps1\nbad.ps1\n\n');
    const run = (args) => spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', SYNTAX, ...args], { cwd: d, encoding: 'utf8' });
    const r1 = run(['-PathsFile', 'list.txt']);
    assert.equal(r1.status, 1, r1.stdout);
    assert.match(r1.stdout, /^bad\.ps1:3:\d+: /m);
    assert.doesNotMatch(r1.stdout, /^ok\.ps1:/m);
    fs.writeFileSync(path.join(d, 'list2.txt'), 'ok.ps1\n');
    assert.equal(run(['-PathsFile', 'list2.txt']).status, 0, 'a clean list passes');
    assert.equal(run(['ok.ps1']).status, 0, 'bare paths still work');
    const r3 = run(['-PathsFile', 'nope.txt']);
    assert.equal(r3.status, 1);
    assert.match(r3.stdout, /nope\.txt: cannot read the path list/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('pre-push: a push whose .ps1 path list is over Windows\' ~32 K command line reaches the parse step through a file, and a bad one still blocks', { skip: (!SH || !PWSH) && 'needs sh and pwsh', timeout: 600000 }, () => {
  const { r, git } = scratchRepo();
  try {
    const base = git('rev-parse', 'HEAD').trim();
    // t/614 asked for 5,000 files; that took 18 minutes here (extract_pushed runs one git cat-file per
    // file). The limit is the path list's LENGTH, not its count, so 400 paths of ~140 characters
    // (~56 K, asserted below) cross the ~32 K command line with the same effect, in a fraction of the time.
    const N = 400;
    const rel = `scripts/${'a-deliberately-long-directory-name-for-the-t614-huge-push-'.repeat(2)}padded`;
    const dir = path.join(r, ...rel.split('/'));
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 1; i <= N; i++) fs.writeFileSync(path.join(dir, `file-${String(i).padStart(5, '0')}.ps1`), `$x = ${i}\n`);
    fs.writeFileSync(path.join(dir, 'zz-bad.ps1'), 'function f {\n}}\n');
    const listLength = (N + 1) * (rel.length + '/file-00001.ps1'.length + 1);
    assert.ok(listLength > 40000, `the path list (${listLength} chars) must exceed the ~32 K command line`);
    git('add', '-A'); git('commit', '-q', '-m', 'huge');
    const res = runChecks(r, base, git('rev-parse', 'HEAD').trim());
    assert.doesNotMatch(res.out, /Argument list too long|filename or extension is too long/, res.out.slice(0, 2000));
    assert.match(res.out, /zz-bad\.ps1:2:\d+: /, 'the one bad file is still reported');
    assert.match(res.out, new RegExp(`FAIL {2}PowerShell parse \\(${N + 1} file\\(s\\)\\)`));
    assert.equal(res.code, 1, 'a parse error still blocks');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});
