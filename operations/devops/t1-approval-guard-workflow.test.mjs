// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4266 P1 (TL p/331#2585): pull_request_target migration coverage for t1-approval-guard.yml,
// mirroring tier-check-workflow.test.mjs's P1 arms -- these test the code the workflow actually
// executes, not a copy of it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const workflow = readFileSync(path.join(root, '.github', 'workflows', 't1-approval-guard.yml'), 'utf8');

function scriptCodeLines() {
  return workflow.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
}

test('P1: the PR trigger is pull_request_target, not pull_request (a PR can no longer disable evaluation by editing this file)', () => {
  assert.match(workflow, /^\s*pull_request_target:\s*\n\s*branches: \[main\]/m);
  assert.ok(!/^\s*pull_request:\s*\n\s*branches:/m.test(workflow), 'must not also trigger on plain pull_request');
});

test('P1: issue_comment and pull_request_review triggers are unaffected (no "target" variant exists for them)', () => {
  assert.match(workflow, /^\s*issue_comment:\s*\n\s*types: \[created, edited\]/m);
  assert.match(workflow, /^\s*pull_request_review:\s*\n\s*types: \[submitted\]/m);
});

test('P1: checkout never persists credentials, and the predicate is loaded only from the explicitly-fetched BASE tip', () => {
  assert.match(workflow, /persist-credentials:\s*false/);
  const code = scriptCodeLines();
  assert.match(code, /git show \$\{baseTipSha\}:operations\/devops\/t1-approval-guard-predicate\.mjs/,
    'the predicate must come from the base tip, fetched explicitly, never the checked-out PR tree');
  assert.ok(!code.includes('git diff') && !code.includes('git show ${headSha}') && !code.includes('git show ${pr.head'),
    'this job must never read any file from the head commit at all (it never needed to)');
});

test('ATTACK ARM (t/4266): fully decoupled from gate-self-health -- rewriting the self-test to always pass cannot touch the verdict', () => {
  assert.ok(!/needs:\s*\[[^\]]*gate-self-health/.test(workflow), 't1-approval-guard.yml\'s job must not declare a `needs:` on the self-test job');
  assert.ok(!/needs\.gate-self-health/.test(workflow), 'the step must not read gate-self-health\'s outcome');
  assert.ok(!scriptCodeLines().includes('node --test'), 't1-approval-guard.yml must never execute a test suite itself (moved to ci.yml, t/4266)');
});

// ── t/116 (a): the PR-side guard and ci.yml's merge_group arm feed the predicate IDENTICAL inputs ──
const ciYml = readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');

function mergeGroupJob() {
  const start = ciYml.indexOf('\n  t1-approval-guard:\n');
  assert.ok(start >= 0, 'ci.yml must still define the t1-approval-guard merge_group job');
  const rest = ciYml.slice(start + 1);
  const next = rest.slice(1).search(/\n  [a-z0-9-]+:\n/);
  return next >= 0 ? rest.slice(0, next + 1) : rest;
}

// The one line that builds `name` in each workflow, whitespace-trimmed.
function lineDefining(text, re) {
  const hits = text.split('\n').map((l) => l.trim()).filter((l) => re.test(l) && !l.startsWith('//'));
  assert.equal(hits.length, 1, `expected exactly one line matching ${re}, got ${hits.length}`);
  return hits[0];
}

test('t/116 PARITY: both arms call evaluateT1ApprovalGuard with the same arguments, including headSha', () => {
  const re = /evaluateT1ApprovalGuard\(\{/;
  const prSide = lineDefining(workflow, re).replace(/^const result = /, '');
  const mgSide = lineDefining(mergeGroupJob(), re).replace(/^const result = /, '');
  assert.equal(mgSide, prSide);
  assert.match(prSide, /headSha: pr\.head\.sha/);
});

test('t/116 PARITY: both arms map reviews and comments identically (every review, with commitId and login)', () => {
  for (const re of [/^const botReviews = /, /^const approvalComments = /]) {
    assert.equal(lineDefining(mergeGroupJob(), re), lineDefining(workflow, re));
  }
  const reviews = lineDefining(workflow, /^const botReviews = /);
  assert.match(reviews, /commitId: r\.commit_id/);
  assert.ok(!/type === 'Bot'/.test(reviews), 'human reviews must reach the predicate so their changes-requests block (t/116#3)');
  assert.match(lineDefining(workflow, /^const approvalComments = /), /login: c\.user\?\.login/);
});

test('t/116: both arms put role-review-verdicts.mjs from the BASE tip next to the predicate (it is imported relatively)', () => {
  assert.match(scriptCodeLines(), /git show \$\{baseTipSha\}:operations\/devops\/role-review-verdicts\.mjs/);
  const mg = mergeGroupJob();
  const verdictsAt = mg.indexOf("loadFromBase('operations/devops/role-review-verdicts.mjs')");
  const predicateAt = mg.indexOf("loadFromBase('operations/devops/t1-approval-guard-predicate.mjs')");
  assert.ok(verdictsAt >= 0 && predicateAt > verdictsAt, 'ci.yml must load role-review-verdicts.mjs before importing the predicate');
});

test('t/116 (TL rule from #4771): CANNOT EVALUATE posts failure, never neutral, on either arm', () => {
  assert.ok(!/['"`]neutral['"`]/.test(scriptCodeLines()), 't1-approval-guard.yml must not post a neutral conclusion');
  assert.match(scriptCodeLines(), /postCheckRun\(pr\.head\.sha, 'failure', 't1-approval-guard: [^']*CANNOT EVALUATE[^']*'/);
  assert.ok(!/['"`]neutral['"`]/.test(mergeGroupJob()), 'the merge_group arm must not post a neutral conclusion');
});
