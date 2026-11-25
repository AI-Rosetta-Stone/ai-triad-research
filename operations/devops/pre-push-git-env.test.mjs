// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/686 (Security, t/682#2): git exports GIT_DIR, GIT_INDEX_FILE and friends to hooks. A test suite that
// pre-push-checks.sh runs, and that runs real git in its own temp repo, inherited them and acted on the
// pushing repo instead (a stray local commit and a declined `push origin HEAD:main`). Every child runner
// now goes through run_clean, which drops every GIT_* variable.
//
// The fixture "suite" is a fake pwsh (the AITRIAD_PREPUSH_PWSH seam the ps-lint step uses). It runs
// `git rev-parse` in a fresh temp repo of its own and records what git saw. The hook runs with GIT_DIR
// and GIT_INDEX_FILE exported, as git does, pointing at the scratch repo being pushed, so the red arm's
// damage stays inside the scratch repo.
// Run: node --test operations/devops/pre-push-git-env.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CHECKS = path.join(here, 'pre-push-checks.sh');
const SH = ['sh', 'C:\\Program Files\\Git\\bin\\sh.exe'].find((c) => spawnSync(c, ['-c', 'exit 0']).status === 0);

// This test may itself run under a hook: never let OUR git calls inherit a GIT_* either.
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));

const FAKE_PWSH = `#!/bin/sh
# t/686 fixture suite: runs real git in a temp repo of its own and records what it saw.
d=$(mktemp -d)
git init -q "$d" >/dev/null 2>&1
{
  if [ -d "$d/.git" ]; then echo "inited=own"; else echo "inited=elsewhere"; fi
  echo "own=$(cd "$d" && env -u GIT_DIR -u GIT_INDEX_FILE -u GIT_WORK_TREE git rev-parse --show-toplevel 2>&1)"
  echo "seen=$(cd "$d" && git rev-parse --show-toplevel 2>&1)"
  env | grep '^GIT_' | sed 's/^/leak=/'
} > "$T686_OUT"
rm -rf "$d"
exit 0
`;

function scratchRepo() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 't686-'));
  const git = (...a) => execFileSync('git', ['-C', r, ...a], { encoding: 'utf8', env: cleanEnv });
  git('init', '-q', '-b', 'main');
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.email', 't@example.invalid');
  git('config', 'user.name', 't');
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(r, rel)), { recursive: true }); fs.writeFileSync(path.join(r, rel), text); };
  fs.mkdirSync(path.join(r, 'operations', 'devops'), { recursive: true });
  fs.copyFileSync(CHECKS, path.join(r, 'operations', 'devops', 'pre-push-checks.sh'));
  put('operations/devops/Invoke-PrePushPsLint.ps1', '# t/686 placeholder: the fake pwsh never reads it\n');
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  return { r, git, put };
}

test('t/686: a child test suite run by pre-push sees no GIT_* variable, so its git acts on its own temp repo', { skip: !SH && 'needs sh' }, () => {
  const { r, git, put } = scratchRepo();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 't686bin-'));
  try {
    const fake = path.join(bin, 'fakepwsh');
    fs.writeFileSync(fake, FAKE_PWSH, { mode: 0o755 });
    const out = path.join(bin, 'out.txt');
    const base = git('rev-parse', 'HEAD').trim();
    put('tests/Fixture.Tests.ps1', '$x = 1\n'); // a ps-lint trigger (tests/)
    git('add', '-A'); git('commit', '-q', '-m', 'touch a lint input');
    const head = git('rev-parse', 'HEAD').trim();

    const gitDir = path.join(r, '.git');
    const res = spawnSync(SH, [path.join(r, 'operations/devops/pre-push-checks.sh'), base, head], {
      cwd: r, encoding: 'utf8',
      env: { ...cleanEnv, GIT_DIR: gitDir, GIT_INDEX_FILE: path.join(gitDir, 'index'), AITRIAD_PREPUSH_PWSH: fake, T686_OUT: out },
    });
    const log = `${res.stdout}${res.stderr}`;
    assert.ok(fs.existsSync(out), `the fixture suite did not run (ps-lint step skipped?):\n${log.slice(-1500)}`);
    const lines = fs.readFileSync(out, 'utf8').trim().split(/\r?\n/);
    const own = lines.find((l) => l.startsWith('own='))?.slice(4);
    const seen = lines.find((l) => l.startsWith('seen='))?.slice(5);
    const leaks = lines.filter((l) => l.startsWith('leak='));
    // With a leaked GIT_DIR, the suite's `git init <its temp dir>` re-initialises the PUSHING repo instead.
    assert.ok(lines.includes('inited=own'), `the suite's git init acted on the pushing repo, not its temp dir: ${lines.join(' | ')}`);
    // `own` is the fixture's temp repo as git sees it with GIT_* cleared for that one call; `seen` is what
    // the suite's plain git saw. A leaked GIT_DIR makes `seen` the pushing repo (or an error).
    assert.ok(own && !/fatal/.test(own), `fixture could not read its own repo: ${own}`);
    assert.equal(seen, own, `the suite's git reported ${seen}, not its own temp repo ${own}`);
    assert.deepEqual(leaks, [], 'no GIT_* variable reaches a child test runner');
    assert.match(log, /PowerShell repo lints/, 'the ps-lint step ran');
  } finally {
    fs.rmSync(r, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test('t/686: run_clean wraps every child runner, and none of the hook\'s own git calls', () => {
  const src = fs.readFileSync(CHECKS, 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*#/.test(l));
  for (const runner of ['pnpm exec eslint', 'pnpm exec tsc', 'pnpm run --silent', 'pnpm exec vitest related',
    'pwsh -NoProfile -NonInteractive -File "$ROOT/operations/devops/Test-PowerShellSyntax.ps1"',
    '"$PWSH" -NoProfile -NonInteractive -File "$ROOT/operations/devops/Invoke-PrePushPsLint.ps1"',
    '"$pybin" -I -m py_compile']) {
    const hits = code.filter((l) => l.includes(runner));
    assert.equal(hits.length, 1, `exactly one call of ${runner}`);
    assert.ok(hits[0].includes(`run_clean ${runner}`), `${runner} runs through run_clean: ${hits[0].trim()}`);
  }
  assert.ok(!code.some((l) => /run_clean\s+git\b/.test(l)), 'the hook\'s own git calls are not stripped');
});
