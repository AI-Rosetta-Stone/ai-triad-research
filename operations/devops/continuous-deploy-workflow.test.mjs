// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/801 (Security): continuous-deploy.yml's `branches: [main]` filter matches the head branch NAME, so a fork PR from the
// fork's own `main` also triggers the workflow_run. Its evaluate job checks out workflow_run.head_sha and dot-sources a
// script from that tree with an issues: write token, so the job must refuse a pull_request run and a head in another
// repository. These tests pin the job's `if:` and that the checkout and the dot-sourcing it guards are still there
// (if either moves, the guard must be revisited).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const text = readFileSync(path.join(root, '.github', 'workflows', 'continuous-deploy.yml'), 'utf8');

/** PURE. The `if:` expression of the named top-level job, whitespace-collapsed, or null. */
export function jobIf(yaml, job) {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => l === `  ${job}:`);
  if (start === -1) return null;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^  \S/.test(lines[i])) return null;          // next job
    const m = /^    if:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    let expr = m[1];
    if (expr === '>-' || expr === '>' || expr === '|') {
      expr = '';
      for (let j = i + 1; j < lines.length && /^      \S/.test(lines[j]); j++) expr += ' ' + lines[j].trim();
    }
    return expr.replace(/\s+/g, ' ').trim();
  }
  return null;
}

test('evaluate refuses a pull_request run and a head in another repository', () => {
  const expr = jobIf(text, 'evaluate');
  assert.ok(expr, 'the evaluate job has an if:');
  assert.match(expr, /github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(expr, /github\.event\.workflow_run\.event != 'pull_request'/);
  assert.match(expr, /github\.event\.workflow_run\.event != 'pull_request_target'/);
  assert.match(expr, /github\.event\.workflow_run\.head_repository\.full_name == github\.repository/);
});

test('the guarded job still checks out head_sha and dot-sources from that tree (the reason for the guard)', () => {
  assert.match(text, /ref: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/);
  assert.match(text, /\. \.\/operations\/devops\/Get-ContinuousDeployVerdict\.ps1/);
  assert.match(text, /issues: write/);
});

test('red arm: the pre-t/801 condition (conclusion only) fails the guard check', () => {
  const old = text.replace(/    if: >-[\s\S]*?\n    runs-on:/, "    if: github.event.workflow_run.conclusion == 'success'\n    runs-on:");
  const expr = jobIf(old, 'evaluate');
  assert.equal(expr, "github.event.workflow_run.conclusion == 'success'");
  assert.doesNotMatch(expr, /head_repository/);
  assert.doesNotMatch(expr, /!= 'pull_request'/);
});

test('jobIf reads a folded and a one-line if', () => {
  assert.equal(jobIf('jobs:\n  a:\n    if: x == 1\n    runs-on: u\n', 'a'), 'x == 1');
  assert.equal(jobIf('jobs:\n  a:\n    if: >-\n      x == 1 &&\n      y == 2\n    runs-on: u\n', 'a'), 'x == 1 && y == 2');
  assert.equal(jobIf('jobs:\n  a:\n    runs-on: u\n', 'a'), null);
});
