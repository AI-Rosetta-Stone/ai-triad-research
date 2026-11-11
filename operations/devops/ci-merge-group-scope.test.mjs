// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/391 (TL p/9#81): a scoped merge_group CI. Pins the three conditions:
//   1. fail-safe: every failure to judge the batch means the FULL suite (ci-merge-group-scope.sh);
//   2. ci-gate accepts a skipped gated job on merge_group only on a positive filter verdict;
//   3. (ci-nightly-alert.yml) structure only; its behaviour is a plain issue open/close.
// Run: node --test operations/devops/ci-merge-group-scope.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const SCRIPT = path.join(here, 'ci-merge-group-scope.sh');
const CI = readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8').replace(/\r\n/g, '\n');

function bashPath() {
  for (const p of ['/bin/bash', '/usr/bin/bash', 'C:\\Program Files\\Git\\bin\\bash.exe']) if (existsSync(p)) return p;
  try { return execFileSync(process.platform === 'win32' ? 'where' : 'which', ['bash'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim(); } catch { return null; }
}
const BASH = bashPath();
const skip = !BASH && 'no bash';

// ── 1. the scope script in a scratch repo ──
function repo() {
  const d = mkdtempSync(path.join(tmpdir(), 't391-'));
  const git = (...a) => execFileSync('git', ['-C', d, ...a], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.invalid'); git('config', 'user.name', 't'); git('config', 'core.autocrlf', 'false');
  const commit = (files) => {
    for (const [f, c] of Object.entries(files)) { mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); writeFileSync(path.join(d, f), c); git('add', '--', f); }
    git('commit', '-q', '-m', 'c');
    return git('rev-parse', 'HEAD');
  };
  const base = commit({ 'README.md': 'x\n' });
  return { d, base, commit, cleanup: () => rmSync(d, { recursive: true, force: true }) };
}
function scope(cwd, base, head, outcome = 'success') {
  const outFile = path.join(cwd, '.gh-output');
  const r = spawnSync(BASH, [SCRIPT.replace(/\\/g, '/'), base, head, outcome], { cwd, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: outFile } });
  const kv = Object.fromEntries((existsSync(outFile) ? readFileSync(outFile, 'utf8') : '').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  rmSync(outFile, { force: true });
  return { code: r.status, out: r.stdout + r.stderr, ...kv };
}

test('docs-only batch: full=false (families follow the filter)', { skip }, () => {
  const r = repo();
  try {
    const head = r.commit({ 'docs/a.md': 'a\n', 'operations/devops/notes.md': 'n\n' });
    const s = scope(r.d, r.base, head);
    assert.equal(s.code, 0); assert.equal(s.full, 'false', s.out);
    assert.match(s.reason, /touches no shared code/);
  } finally { r.cleanup(); }
});

for (const f of ['lib/debate/x.ts', 'taxonomy-editor/src/server/a.ts', '.github/workflows/ci.yml', '.github/actions/a/action.yml', '.github/ci/tier-paths.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'package.json', 'taxonomy-editor/package.json', 'lib/tsconfig.json', 'tsconfig.base.json']) {
  test(`shared code ${f}: full=true`, { skip }, () => {
    const r = repo();
    try {
      const head = r.commit({ [f]: '{}\n' });
      const s = scope(r.d, r.base, head);
      assert.equal(s.full, 'true', s.out);
      assert.match(s.reason, /shared code/);
      assert.doesNotMatch(s.out, /::warning::/, 'shared code is a decision, not a fallback');
    } finally { r.cleanup(); }
  });
}

test('a batch of a docs PR plus a lib PR: the union decides, full=true', { skip }, () => {
  const r = repo();
  try {
    r.commit({ 'docs/a.md': 'a\n' });
    const head = r.commit({ 'lib/b.ts': 'b\n' });
    assert.equal(scope(r.d, r.base, head).full, 'true');
  } finally { r.cleanup(); }
});

test('FAIL-SAFE: every way the scope cannot be judged means full=true with a WARN', { skip }, () => {
  const r = repo();
  try {
    const head = r.commit({ 'docs/a.md': 'a\n' });
    const cases = {
      'filter step failed': scope(r.d, r.base, head, 'failure'),
      'filter step skipped/empty': scope(r.d, r.base, head, ''),
      'base missing': scope(r.d, '', head),
      'base malformed': scope(r.d, 'not-a-sha', head),
      'base unknown to git': scope(r.d, 'a'.repeat(40), head),
      'empty diff': scope(r.d, head, head),
    };
    for (const [name, s] of Object.entries(cases)) {
      assert.equal(s.code, 0, name);
      assert.equal(s.full, 'true', `${name}: ${s.out}`);
      assert.match(s.out, /::warning::t\/391 merge_group scope: FULL suite \(fail-safe\)/, name);
    }
  } finally { r.cleanup(); }
});

// ── 2. ci.yml wiring ──
test('ci.yml: changes runs on merge_group, diffs the batch, and never fails the job on merge_group', () => {
  assert.match(CI, /^  changes:\n(?:    #.*\n)*    if: github\.event_name == 'pull_request' \|\| github\.event_name == 'push' \|\| github\.event_name == 'merge_group'$/m);
  assert.match(CI, /if: github\.event_name == 'push' \|\| github\.event_name == 'merge_group'\n        with:\n          fetch-depth: 0/);
  assert.match(CI, /id: filter\n(?:        #.*\n)*        continue-on-error: \$\{\{ github\.event_name == 'merge_group' \}\}\n        with:\n(?:          #.*\n)*          base: \$\{\{ github\.event\.merge_group\.base_sha \}\}\n          ref: \$\{\{ github\.event\.merge_group\.head_sha \}\}/);
  assert.match(CI, /      full: \$\{\{ steps\.scope\.outputs\.full \}\}/);
  assert.match(CI, /id: scope\n        if: always\(\) && github\.event_name == 'merge_group'\n[\s\S]*?run: bash operations\/devops\/ci-merge-group-scope\.sh "\$BASE_SHA" "\$HEAD_SHA" "\$FILTER_OUTCOME"/);
});

test("ci.yml: every gated family trims on merge_group only on a positive full=='false'", () => {
  assert.doesNotMatch(CI, /github\.event_name == 'merge_group' \|\| needs\.changes/, 'a bare merge_group clause would still run everything');
  assert.doesNotMatch(CI, /'workflow_dispatch' \|\| github\.event_name == 'merge_group' \|\|/);
  assert.equal(CI.split("(github.event_name == 'merge_group' && needs.changes.outputs.full != 'false')").length - 1, 26);
});

// ── 3. ci-gate's merge_group skip-integrity step, run on needs fixtures ──
function integrityScript() {
  const m = CI.match(/- name: Merge-group skip integrity \(t\/391\)[\s\S]*?node -e '\n([\s\S]*?)\n {10}'\n/);
  assert.ok(m, 'ci-gate: skip-integrity step not found');
  return m[1];
}
const POSITIVE = { powershell: 'false', electron: 'false', lib: 'false', debate: 'true', 'dockerfile-scan': '[]', full: 'false' };
function gate(needs) {
  const r = spawnSync(process.execPath, ['-e', integrityScript()], { encoding: 'utf8', env: { ...process.env, NEEDS_JSON: JSON.stringify(needs) } });
  return { code: r.status, out: r.stdout + r.stderr };
}
test('ci-gate integrity: full=false + positive verdicts: skips are accepted', () => {
  const g = gate({ changes: { result: 'success', outputs: POSITIVE }, 'test-powershell': { result: 'skipped' }, 'debate-eval': { result: 'success' } });
  assert.equal(g.code, 0, g.out);
  assert.match(g.out, /skipped by positive filter verdicts: test-powershell/);
});
test('ci-gate integrity: full=false but a family output is not a positive verdict: RED', () => {
  const g = gate({ changes: { result: 'success', outputs: { ...POSITIVE, electron: '' } }, 'test-electron': { result: 'skipped' } });
  assert.equal(g.code, 1); assert.match(g.out, /not positive verdicts: electron=""/);
});
test('ci-gate integrity: full=true (or missing) with any skipped gated job: RED', () => {
  for (const full of ['true', undefined, '']) {
    const g = gate({ changes: { result: 'success', outputs: { ...POSITIVE, full } }, 'test-powershell': { result: 'skipped' } });
    assert.equal(g.code, 1, `full=${full}`); assert.match(g.out, /full suite expected/);
  }
});
test('ci-gate integrity: full=true with nothing skipped: green', () => {
  assert.equal(gate({ changes: { result: 'success', outputs: { ...POSITIVE, full: 'true' } }, 'test-powershell': { result: 'success' } }).code, 0);
});
test('ci-gate integrity: changes did not succeed: RED whatever else', () => {
  const g = gate({ changes: { result: 'failure', outputs: {} }, 'test-powershell': { result: 'success' } });
  assert.equal(g.code, 1); assert.match(g.out, /changes is failure/);
});

test('ci-nightly-alert.yml: fires on the scheduled CI run on main only', () => {
  const y = readFileSync(path.join(root, '.github', 'workflows', 'ci-nightly-alert.yml'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(y, /workflow_run:\n    workflows: \[CI\]\n    types: \[completed\]\n    branches: \[main\]/);
  assert.match(y, /if: github\.event\.workflow_run\.event == 'schedule'/);
  assert.match(y, /gh issue create/); assert.match(y, /gh issue close/);
});
