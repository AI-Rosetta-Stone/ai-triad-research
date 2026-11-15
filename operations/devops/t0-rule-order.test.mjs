// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Run: node --test operations/devops/t0-rule-order.test.mjs
//
// The T0 sweep's rule order is unchanged by the sharedSkipReason refactor (t/73, Second Opinion's
// condition 4 on #4795). t0-rule-order.fixture.json holds what MAIN's selectT0Candidates (before
// the refactor) decided for every case in t0-rule-order.cases.mjs: a passing PR, each rule tripped
// alone, and every pair of rules tripped together. This runs the same cases through the working
// tree's selectT0Candidates and requires the same decision for each: same skip reason (so the same
// rule ran first), same re-pin comment request, same idle-window wait.
//
// IF THIS FAILS: the rule order or a skip reason changed. Do not regenerate the fixture from the
// changed code to make it pass. Either restore the order, or, when the change is intended and
// reviewed, regenerate from a reference that has the intended behavior and say so in the PR.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { selectT0Candidates } from './t0-enqueue-sweep.mjs';
import { MUTATORS, EXPECTED_CASE_COUNT, NOW_MS, buildCases, runCases, runCasesInOneBatch } from './t0-rule-order.cases.mjs';
import { formatFixture } from './gen-t0-rule-order-fixture.mjs';

const fixtureUrl = new URL('./t0-rule-order.fixture.json', import.meta.url);
const fixtureText = readFileSync(fixtureUrl, 'utf8');
const fixture = JSON.parse(fixtureText);
const expectedById = new Map(fixture.cases.map((c) => [c.id, c]));

// Every difference in one message, so a moved rule shows all the pairs it changed.
function assertSameAsFixture(actual, label) {
  const diffs = [];
  for (const a of actual) {
    const e = expectedById.get(a.id);
    try {
      assert.deepEqual(a, e);
    } catch {
      diffs.push(`case ${a.id}:\n    fixture (main): ${JSON.stringify(e)}\n    ${label}: ${JSON.stringify(a)}`);
    }
  }
  assert.equal(diffs.length, 0, `${diffs.length} of ${actual.length} cases differ from main's decision:\n  ${diffs.join('\n  ')}`);
}

test('the fixture covers the base PR, every mutator alone and every pair, and matches the cases module', () => {
  assert.equal(MUTATORS.length, 28);
  assert.equal(EXPECTED_CASE_COUNT, 1 + 28 + (28 * 27) / 2);
  assert.equal(fixture.cases.length, EXPECTED_CASE_COUNT);
  assert.equal(fixture.caseCount, EXPECTED_CASE_COUNT);
  assert.equal(fixture.nowMs, NOW_MS);
  assert.deepEqual(fixture.mutators, MUTATORS.map((m) => m.id));
  assert.deepEqual(fixture.cases.map((c) => c.id), buildCases().map((c) => c.id), 'same cases, same order');
  assert.equal(expectedById.size, fixture.cases.length, 'case ids are unique');
  assert.match(fixture.generatedFrom.commit, /^[0-9a-f]{40}$/);
  assert.match(fixture.generatedFrom.blob, /^[0-9a-f]{40}$/);
  assert.equal(fixture.generatedFrom.path, 'operations/devops/t0-enqueue-sweep.mjs');
  // The file is exactly what the generator writes (no hand edits to its shape).
  assert.equal(formatFixture({ generatedFrom: fixture.generatedFrom, cases: fixture.cases }), fixtureText.replace(/\r\n/g, '\n'));
});

test('in the fixture, the base PR is enqueued and every mutator alone is skipped for its own rule', () => {
  const base = expectedById.get('base');
  assert.equal(base.enqueued, true);
  assert.equal(base.reason, null);
  for (const m of MUTATORS) {
    const c = expectedById.get(m.id);
    assert.equal(c.enqueued, false, m.id);
    assert.match(c.reason, m.wins, `${m.id} (rule: ${m.rule})`);
  }
  const rules = new Set(MUTATORS.map((m) => m.rule));
  assert.deepEqual([...rules], [
    'fork', 'not declared T0', 'base not main', 'draft', 'already queued', 'Dependabot', 'blocking label',
    'manual-dequeue hold', 'merge conflict', 're-pin re-check', 'review data error', 'changes requested',
    'Design gate', 'required context', 'checks still running', 'push time unknown', 'idle window',
  ], 'one mutator or more for each of main\'s 17 rules, listed in main\'s order');
});

test('in the fixture, no pair is enqueued, and each pair reports one of its two rules', () => {
  const single = (id) => expectedById.get(id).reason;
  for (const c of fixture.cases) {
    const ids = c.id.split('+');
    if (ids.length !== 2) continue;
    assert.equal(c.enqueued, false, c.id);
    // The reason is word for word the reason one of the two gives alone: the rule that ran first.
    // (Usually the first-listed mutator's. Not always: a push 5 minutes ago releases a dequeue hold
    // and makes a 10-minute-old comment stale, so `idle` wins those two pairs.)
    assert.ok([single(ids[0]), single(ids[1])].includes(c.reason), `${c.id}: ${c.reason}`);
  }
});

test('in the fixture, the t/309 re-pin re-check sits after merge conflict and before review data (main\'s order)', () => {
  const reason = (id) => expectedById.get(id).reason;
  const NOT_PURE = /^WARN: docker\/base-repin-.* head is not a pure base-pin bump/;
  const NO_FACTS = /^WARN: docker\/base-repin-.* head could not be re-classified/;
  for (const [repin, re] of [['repin-not-pure', NOT_PURE], ['repin-facts-missing', NO_FACTS]]) {
    // Rules that run before it win.
    for (const earlier of ['fork', 'not-t0', 'base-not-main', 'draft', 'queued', 'dependabot', 'label-consult-hold', 'manual-dequeue', 'conflict']) {
      const c = expectedById.get(`${earlier}+${repin}`);
      assert.equal(c.reason, reason(earlier), `${earlier}+${repin}`);
      assert.equal(c.repinComment, null, `${earlier}+${repin}: no comment when an earlier rule skipped it`);
    }
    // Rules that run after it lose.
    for (const later of ['review-data-error', 'changes-requested', 'changes-requested-unparsed', 'changes-requested-comment', 'design-gate',
      'ci-gate-failed', 'codeql-missing', 'joint-gv-guard-pending', 'check-running', 'push-time-unknown', 'idle']) {
      const c = expectedById.get(`${repin}+${later}`);
      assert.match(c.reason, re, `${repin}+${later}`);
      assert.equal(c.waiting, null, `${repin}+${later}`);
    }
  }
  // The T1-review comment is requested exactly when the reason is "not a pure bump".
  for (const c of fixture.cases) {
    assert.equal(c.repinComment != null, NOT_PURE.test(c.reason ?? ''), c.id);
    if (c.repinComment) assert.deepEqual(c.repinComment, { headRefOid: 'abc1234abc1234abc1234abc1234abc1234abc12', reason: 'line count changed (6 -> 7)' }, c.id);
    assert.deepEqual(c.extraSkipKeys, [], c.id);
  }
});

test('in the fixture, only a PR blocked by nothing but the idle window is waiting', () => {
  for (const c of fixture.cases) {
    assert.equal(c.waiting != null, /^idle \d+m < 15m since last push$/.test(c.reason ?? ''), c.id);
    if (c.waiting) assert.equal(c.waiting.eligibleAt, NOW_MS + 10 * 60000, c.id);
  }
});

test('selectT0Candidates decides every case exactly as main did (one PR per call)', () => {
  assertSameAsFixture(runCases(selectT0Candidates), 'this tree  ');
});

test('selectT0Candidates decides every case exactly as main did (all PRs in one call: no state leaks between PRs)', () => {
  assertSameAsFixture(runCasesInOneBatch(selectT0Candidates), 'this tree  ');
});
