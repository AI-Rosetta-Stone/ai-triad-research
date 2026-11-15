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

async function run({ getCommit, comments = [], reviews = [] }) {
  const warnings = [];
  const github = { rest: {
    issues: { listComments: async () => ({ data: comments }) },
    pulls: { listReviews: async () => ({ data: reviews }) },
    git: { getCommit },
  } };
  const core = { warning: (m) => warnings.push(String(m)) };
  const fn = await new AsyncFunction('github', 'core', 'owner', 'repo', 'SO_CLEARED_RE', `${extractActivityFn()}\nreturn activityAndSoFacts;`)(github, core, 'o', 'r', /cleared/i);
  const pr = { number: 7, created_at: '2026-11-01T00:00:00Z', head: { sha: 'abc' } };
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
