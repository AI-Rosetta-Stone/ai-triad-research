// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/357: pr-triage.yml's activityAndSoFacts must count the head commit (the latest push) as
// activity. It read pr.head.commit, which REST pulls.get never returns, so the idle clock always
// fell back to created_at. This extracts the real function from the workflow and runs it against
// a fake GitHub.
// Run: node --test operations/devops/pr-triage-activity.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SO_CLEARED_RE, soRepliedAtHead } from './fleet-delivery-metrics.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const WF = readFileSync(path.join(here, '..', '..', '.github', 'workflows', 'pr-triage.yml'), 'utf8').replace(/\r\n/g, '\n');
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

/** Source of `async function activityAndSoFacts(pr) { ... }`, by brace matching from its header. */
function extractActivityFn() {
  const start = WF.indexOf('async function activityAndSoFacts(pr) {');
  assert.ok(start >= 0, 'pr-triage.yml: activityAndSoFacts not found');
  let depth = 0;
  for (let i = WF.indexOf('{', start); i < WF.length; i++) {
    if (WF[i] === '{') depth++;
    else if (WF[i] === '}' && --depth === 0) return WF.slice(start, i + 1);
  }
  throw new Error('unbalanced braces in activityAndSoFacts');
}

async function run({ getCommit, comments = [], reviews = [], headSha = 'abc' }) {
  const warnings = [];
  const github = { rest: {
    issues: { listComments: async () => ({ data: comments }) },
    pulls: { listReviews: async () => ({ data: reviews }) },
    git: { getCommit },
  } };
  const core = { warning: (m) => warnings.push(String(m)) };
  // t/4972: the workflow imports SO_CLEARED_RE and soRepliedAtHead from fleet-delivery-metrics.mjs;
  // pass the real ones, so this runs the code the workflow runs.
  const fn = await new AsyncFunction('github', 'core', 'owner', 'repo', 'SO_CLEARED_RE', 'soRepliedAtHead', `${extractActivityFn()}\nreturn activityAndSoFacts;`)(github, core, 'o', 'r', SO_CLEARED_RE, soRepliedAtHead);
  const pr = { number: 7, created_at: '2026-11-01T00:00:00Z', head: { sha: headSha } };
  return { facts: await fn(pr), warnings };
}

test('a recent push with no comments: lastActivityAt is the head commit date, not created_at', async () => {
  const { facts } = await run({ getCommit: async () => ({ data: { committer: { date: '2026-11-10T09:00:00Z' } } }) });
  assert.equal(facts.lastActivityAt, '2026-11-10T09:00:00Z');
});

test('head commit date unreadable: falls back to created_at, with a WARN', async () => {
  const { facts, warnings } = await run({ getCommit: async () => { throw new Error('HTTP 502'); } });
  assert.equal(facts.lastActivityAt, '2026-11-01T00:00:00Z');
  assert.ok(warnings.some((w) => /could not read head commit date/.test(w)));
});

test('a later human comment still wins over an older push', async () => {
  const { facts } = await run({
    getCommit: async () => ({ data: { committer: { date: '2026-11-05T00:00:00Z' } } }),
    comments: [{ body: 'hi', user: { type: 'User' }, created_at: '2026-11-09T12:00:00Z' }],
  });
  assert.equal(facts.lastActivityAt, '2026-11-09T12:00:00Z');
});

// t/4972: a "Second Opinion verdict" reply that cites the PR's CURRENT head suppresses
// consult-hold-aged (soClearanceDetected) through the workflow's own function; one citing an older
// head does not, and neither does a comment with no verdict header.
const noCommit = async () => ({ data: { committer: { date: '2026-11-05T00:00:00Z' } } });
const verdict = (sha) => ({ body: `**Second Opinion verdict, mirrored for the PI: proceed with conditions at \`${sha}\`**`, user: { type: 'Bot' }, created_at: '2026-11-09T12:00:00Z' });

test('t/4972: an SO verdict at the current head counts as a reply (soClearanceDetected)', async () => {
  const { facts } = await run({ getCommit: noCommit, headSha: 'abc1234def', comments: [verdict('abc1234')] });
  assert.equal(facts.soClearanceDetected, true);
});

test('t/4972: an SO verdict at a superseded head does not count', async () => {
  const { facts } = await run({ getCommit: noCommit, headSha: 'abc1234def', comments: [verdict('0ff1ce0')] });
  assert.equal(facts.soClearanceDetected, false);
});

test('t/4972: plain chatter citing the head is not an SO reply', async () => {
  const { facts } = await run({ getCommit: noCommit, headSha: 'abc1234def', comments: [{ body: 'Head updated to `abc1234`', user: { type: 'User' }, created_at: '2026-11-09T12:00:00Z' }] });
  assert.equal(facts.soClearanceDetected, false);
});

test('t/4972 (Quality, #5286): an SO send-back at the current head still alerts (soClearanceDetected false); a clearance does not', async () => {
  const back = { body: '**Second Opinion verdict, mirrored for the PI: send back at `abc1234`.** Rebase first.', user: { type: 'Bot' }, created_at: '2026-11-09T12:00:00Z' };
  const { facts: sentBack } = await run({ getCommit: noCommit, headSha: 'abc1234def', comments: [back] });
  assert.equal(sentBack.soClearanceDetected, false);
  const cleared = { body: '**Second Opinion verdict: cleared at `abc1234`.**', user: { type: 'Bot' }, created_at: '2026-11-09T12:00:00Z' };
  const { facts: ok } = await run({ getCommit: noCommit, headSha: 'abc1234def', comments: [cleared] });
  assert.equal(ok.soClearanceDetected, true);
});
