// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/684 (t/651): debate-tested-sweep.yml's commit step stages ONLY taxonomy/ and refuses to commit or push
// when anything else in the ai-triad-data checkout changed. The step's own `run:` block is extracted from the
// workflow and run in a throwaway clone (origin = a local bare repo), so the test exercises the shipped shell.
// Run: node --test operations/devops/debate-tested-sweep-commit.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const WF = path.join(here, '..', '..', '.github', 'workflows', 'debate-tested-sweep.yml');
const bash = process.platform === 'win32' ? 'bash.exe' : 'bash';
const haveBash = spawnSync(bash, ['-c', 'true']).status === 0;
const opts = { skip: !haveBash && 'bash not available' };
const posix = (p) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);

/** The commit step's run block, de-indented, with the step output expression substituted. */
function commitStep() {
  const lines = readFileSync(WF, 'utf8').replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => /- name: Commit \+ push harvested records to ai-triad-data/.test(l));
  assert.notEqual(start, -1, 'commit step not found');
  const runAt = lines.findIndex((l, i) => i > start && /^\s+run: \|\s*$/.test(l));
  const indent = lines[runAt + 1].match(/^\s*/)[0];
  const body = [];
  for (let i = runAt + 1; i < lines.length; i++) {
    if (lines[i].trim() !== '' && !lines[i].startsWith(indent)) break;
    body.push(lines[i].slice(indent.length));
  }
  return body.join('\n').replaceAll('${{ steps.sweep.outputs.created }}', '3');
}

function sh(cwd, cmd) {
  const r = spawnSync(bash, ['-c', cmd], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd}\n${r.stderr}`);
  return r.stdout.trim();
}

function setup() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dts-'));
  const origin = path.join(tmp, 'origin.git');
  const data = path.join(tmp, 'ai-triad-data');
  sh(tmp, `git init -q --bare -b main "${posix(origin)}"`);
  sh(tmp, `git clone -q "${posix(origin)}" "${posix(data)}" 2>/dev/null; cd "${posix(data)}" && git config user.email t@t && git config user.name t && git config core.hooksPath /nonexistent && mkdir -p taxonomy/Origin preferences && echo '{}' > taxonomy/Origin/acc.json && echo x > preferences/p.json && echo r > README.md && git add -A && git commit -qm base && git push -q origin HEAD:main`);
  const run = () => {
    const r = spawnSync(bash, ['-c', commitStep()], { cwd: data, encoding: 'utf8' });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const pushedFiles = () => sh(tmp, `git --git-dir="${posix(origin)}" diff --name-only HEAD~1 HEAD 2>/dev/null || true`);
  const originHead = () => sh(tmp, `git --git-dir="${posix(origin)}" rev-parse HEAD`);
  return { data, run, pushedFiles, originHead };
}

test('the step never uses git add -A and stages taxonomy/ by pathspec', () => {
  const step = commitStep().split('\n').filter((l) => !/^\s*#/.test(l)).join('\n'); // code only, not comments
  assert.doesNotMatch(step, /git add -A|git add \.|git add --all/);
  assert.match(step, /git add -- taxonomy\//);
});

test('only taxonomy/ changed: committed and pushed, and the push carries only taxonomy files', opts, () => {
  const s = setup();
  writeFileSync(path.join(s.data, 'taxonomy', 'Origin', 'acc.json'), '{"debate_tested":true}\n');
  const r = s.run();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Pushed 3 harvested entries/);
  assert.equal(s.pushedFiles(), 'taxonomy/Origin/acc.json');
});

test('a MODIFIED file outside taxonomy/ fails the job; nothing is pushed', opts, () => {
  const s = setup();
  const before = s.originHead();
  writeFileSync(path.join(s.data, 'taxonomy', 'Origin', 'acc.json'), '{"debate_tested":true}\n');
  writeFileSync(path.join(s.data, 'preferences', 'p.json'), 'user data\n');
  const r = s.run();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /::error::t\/684: .*outside taxonomy\//);
  assert.match(r.out, /preferences\/p\.json/);
  assert.equal(s.originHead(), before, 'nothing may reach the data repo');
});

test('an UNTRACKED file outside taxonomy/ fails the job; nothing is pushed', opts, () => {
  const s = setup();
  const before = s.originHead();
  writeFileSync(path.join(s.data, 'taxonomy', 'Origin', 'acc.json'), '{"debate_tested":true}\n');
  mkdirSync(path.join(s.data, 'user-content'), { recursive: true });
  writeFileSync(path.join(s.data, 'user-content', 'u.json'), '{}\n');
  const r = s.run();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /user-content\/u\.json/);
  assert.equal(s.originHead(), before);
});

test('a change PRE-STAGED outside taxonomy/ fails the job too', opts, () => {
  const s = setup();
  const before = s.originHead();
  writeFileSync(path.join(s.data, 'README.md'), 'changed\n');
  sh(s.data, 'git add README.md');
  const r = s.run();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /README\.md/);
  assert.equal(s.originHead(), before);
});

test('nothing changed: the existing no-diff warning, exit 0, no push', opts, () => {
  const s = setup();
  const before = s.originHead();
  const r = s.run();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /no file diff/);
  assert.equal(s.originHead(), before);
});
