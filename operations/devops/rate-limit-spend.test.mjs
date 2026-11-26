// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/563 step 2: spend per workflow and job from the start/end snapshot lines.
// Run: node --test operations/devops/rate-limit-spend.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, collect, formatReport, pairDeltas, parseSnapshots, TARGET_WORKFLOW_FILES } from './rate-limit-spend.mjs';

const TS = '2026-11-25T10:00:00.0000000Z';
const startLine = (wf, job, core, reset, gql) => `${job}\tRate-limit snapshot at job start (t/563)\t${TS} t/563 rate-limit-start: workflow=${wf} job=${job} core used=${core} reset=${reset} graphql used=${gql} graphql_reset=1794372000`;
const endLine = (wf, job, core, reset, gql) => `${job}\tRate-limit snapshot (t/314)\t${TS} t/314 rate-limit: workflow=${wf} job=${job} core used=${core} remaining=${5000 - core} limit=5000 reset=${reset} graphql used=${gql} remaining=${5000 - gql} limit=5000`;

test('parseSnapshots pairs a job\'s start and end lines; workflow names with spaces are kept', () => {
  const log = [
    startLine('Tier check', 'tier-check', 100, '11:00:00Z', 10),
    'tier-check\tsome step\tnoise',
    endLine('Tier check', 'tier-check', 130, '11:00:00Z', 14),
  ].join('\n');
  const e = parseSnapshots(log);
  assert.equal(e.length, 1);
  assert.equal(e[0].workflow, 'Tier check');
  assert.deepEqual(e[0].start, { coreUsed: 100, coreReset: '11:00:00Z', gqlUsed: 10, gqlReset: '1794372000' });
  assert.deepEqual(e[0].end, { coreUsed: 130, coreReset: '11:00:00Z', gqlUsed: 14 });
});

test('pairDeltas: the delta per side; a core window reset or a GraphQL used-going-down is discarded with a reason', () => {
  const [ok, coreReset, gqlReset, noStart] = pairDeltas([
    { workflow: 'w', job: 'a', start: { coreUsed: 100, coreReset: '11:00:00Z', gqlUsed: 10 }, end: { coreUsed: 130, coreReset: '11:00:00Z', gqlUsed: 14 } },
    { workflow: 'w', job: 'b', start: { coreUsed: 4990, coreReset: '11:00:00Z', gqlUsed: 10 }, end: { coreUsed: 12, coreReset: '12:00:00Z', gqlUsed: 12 } },
    { workflow: 'w', job: 'c', start: { coreUsed: 100, coreReset: '11:00:00Z', gqlUsed: 4999 }, end: { coreUsed: 101, coreReset: '11:00:00Z', gqlUsed: 3 } },
    { workflow: 'w', job: 'd', end: { coreUsed: 1, coreReset: 'x', gqlUsed: 1 } },
  ]);
  assert.equal(ok.core, 30); assert.equal(ok.gql, 4);
  assert.equal(coreReset.core, null); assert.match(coreReset.coreSkip, /reset/); assert.equal(coreReset.gql, 2);
  assert.equal(gqlReset.gql, null); assert.match(gqlReset.gqlSkip, /reset/); assert.equal(gqlReset.core, 1);
  assert.equal(noStart.core, null); assert.equal(noStart.coreSkip, 'no start line');
});

test('aggregate ranks per workflow and per job, separately for core and GraphQL, and counts discards', () => {
  const agg = aggregate([
    { workflow: 'A', job: 'x', core: 50, gql: 1 },
    { workflow: 'A', job: 'x', core: 30, gql: null },
    { workflow: 'B', job: 'y', core: 10, gql: 90 },
  ]);
  assert.equal(agg.perJobCore[0].key, 'A:x'); assert.equal(agg.perJobCore[0].core, 80); assert.equal(agg.perJobCore[0].coreN, 2);
  assert.equal(agg.perJobGql[0].key, 'B:y');
  assert.equal(agg.perWorkflowCore[0].key, 'A');
  assert.equal(agg.gqlDiscarded, 1); assert.equal(agg.coreDiscarded, 0);
  const md = formatReport(agg, { hours: 24, runs: 3 });
  assert.match(md, /### Top 10 jobs, REST core\n\| workflow:job \| REST core spend \| jobs measured \|\n\|---\|---\|---\|\n\| A:x \| 80 \| 2 \|/);
  assert.match(md, /upper bound on that job's own spend/);
});

test('collect: lists only the target workflows in the window, reads each run log once, and skips an unreadable log with a WARN', () => {
  const calls = [];
  const warns = [];
  const gh = (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'api') {
      const file = /workflows\/([^/]+)\/runs/.exec(args[4])[1];
      return file === 'tier-check.yml' ? '11\t2026-11-25T09:00:00Z\n12\t2026-11-25T09:30:00Z\n' : '';
    }
    if (args[0] === 'run' && args[2] === '12') throw new Error('HTTP 410 logs expired');
    return [startLine('Tier check', 'tier-check', 100, '11:00:00Z', 10), endLine('Tier check', 'tier-check', 120, '11:00:00Z', 10)].join('\n');
  };
  const c = collect({ repo: 'o/r', hours: 24, maxRuns: 10, gh, nowMs: Date.parse('2026-11-25T10:00:00Z'), warn: (m) => warns.push(m) });
  assert.equal(c.runs, 2);
  assert.equal(c.failed, 1);
  assert.equal(c.entries.length, 1);
  assert.match(warns[0], /could not read the log of run 12/);
  assert.equal(calls.filter((x) => x.startsWith('api ')).length, TARGET_WORKFLOW_FILES.length, 'one listing per target workflow');
  assert.ok(calls.every((x) => !x.startsWith('api ') || x.includes('created=>=2026-11-24T10:00:00.000Z')), 'the window starts 24 h back');
  assert.equal(pairDeltas(c.entries)[0].core, 20);
});

test('collect honours --max-runs (newest first)', () => {
  const gh = (args) => (args[0] === 'api'
    ? (args[4].includes('tier-check.yml') ? '1\t2026-11-25T01:00:00Z\n2\t2026-11-25T02:00:00Z\n3\t2026-11-25T03:00:00Z\n' : '')
    : '');
  const c = collect({ repo: 'o/r', hours: 24, maxRuns: 2, gh, nowMs: Date.parse('2026-11-25T10:00:00Z'), warn: () => {} });
  assert.equal(c.runs, 2); assert.equal(c.listed, 3);
  assert.equal(c.from, '2026-11-25T02:00:00Z');
});

test('t/563 (Lead p/233#187): an App-pool line pairs only with its own pool, is labelled as that App quota, and an unlisted pool is ignored', () => {
  const log = [
    'x t/563 rate-limit-start: pool=merge-approval-app workflow=merge-approval job=compute core used=10 reset=12:00:00Z graphql used=5 graphql_reset=1795612860',
    'x t/314 rate-limit: pool=merge-approval-app workflow=merge-approval job=compute core used=14 remaining=4986 limit=5000 reset=12:00:00Z graphql used=9 remaining=4991 limit=5000',
    // The enqueue sweep's end-only App line (t/318): ignored, not counted as a 'no start line' discard.
    'x t/314 rate-limit: pool=app workflow=Merge-queue enqueue sweep job=sweep core used=1 remaining=1 limit=2 reset=12:00:00Z graphql used=1 remaining=1 limit=2',
  ].join('\n');
  const entries = parseSnapshots(log);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].workflow, 'merge-approval [merge-approval-app quota, not GITHUB_TOKEN]');
  assert.deepEqual(pairDeltas(entries).map((d) => [d.core, d.gql]), [[4, 4]]);
  assert.ok(TARGET_WORKFLOW_FILES.includes('merge-approval.yml'), 'its logs are read');
});
