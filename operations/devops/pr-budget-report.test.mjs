// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/656: the batching monitor (tickets per PR). No PR-count threshold anywhere (TL p/9#630), the
// alerts (single-ticket non-incident merges today; a 7-day median under 3), the TL-only message, and
// the dry-run default. Run: node --test operations/devops/pr-budget-report.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, formatText, MEDIAN_FLOOR, planMessages, run, ticketsOf, vehicleOf } from './pr-budget-report.mjs';

const TODAY = '2026-11-26';
const NOW = `${TODAY}T18:00:00Z`;
let n = 1000;
const table = (tickets) => ['| Ticket | Owner |', '|---|---|', ...tickets.map((t) => `| ${t} | A |`)].join('\n');
const mk = (over = {}) => ({ number: ++n, title: `pr ${n}`, body: '', createdAt: `${TODAY}T01:00:00Z`, mergedAt: `${TODAY}T10:00:00Z`, headRefName: `fix/x-${n}`, state: 'MERGED', author: 'jpsnover', ...over });
const quiet = { log: () => {}, warn: () => {} };

test('ticketsOf: the body table wins; else the t/<N> refs in title and branch', () => {
  assert.deepEqual(ticketsOf(mk({ body: table(['t/1', 't/2', 't/2', 't/3']) })), ['t/1', 't/2', 't/3']);
  assert.deepEqual(ticketsOf(mk({ title: 'fix(t/77): x', headRefName: 'feat/t77-x' })), ['t/77']);
  assert.deepEqual(ticketsOf(mk({ title: 'x', headRefName: 'fix/t12-y' })), ['t/12']);
  assert.deepEqual(ticketsOf(mk({ title: 'no ticket', headRefName: 'misc/x' })), []);
});

test('vehicleOf: Dependabot, automated, incident, train, feature, other', () => {
  assert.equal(vehicleOf(mk({ author: 'app/dependabot' })), 'dependabot');
  assert.equal(vehicleOf(mk({ headRefName: 'docker/base-repin-x' })), 'automated');
  assert.equal(vehicleOf(mk({ headRefName: 'incident/t650-x' })), 'incident');
  assert.equal(vehicleOf(mk({ headRefName: 'train/devops-20261126' })), 'train');
  assert.equal(vehicleOf(mk({ headRefName: 'feat/t9-x' })), 'feature');
  assert.equal(vehicleOf(mk({ headRefName: 'fix/x' })), 'other');
});

test('analyze: today and 7-day medians and single-ticket shares; Dependabot and automated excluded', () => {
  const prs = [
    mk({ headRefName: 'train/devops-20261126', body: table(['t/1', 't/2', 't/3', 't/4']) }),
    mk({ headRefName: 'train/server-20261126', body: table(['t/5', 't/6', 't/7']) }),
    mk({ author: 'app/dependabot', headRefName: 'dependabot/npm/x' }),
    mk({ headRefName: 'docker/base-repin-x', title: 'fix(docker): re-pin' }),
    mk({ createdAt: `${TODAY}T02:00:00Z`, mergedAt: null, state: 'OPEN', headRefName: 'train/renderer-20261126' }),
  ];
  const r = analyze(prs, NOW);
  assert.equal(r.day.prs, 2); assert.equal(r.day.medianTickets, 3.5); assert.equal(r.day.singleShare, 0);
  assert.equal(r.openedToday, 5); assert.equal(r.mergedToday, 4);
  assert.equal(r.alert, false);
});

test('alerts: every single-ticket non-incident PR merged today; an incident PR is not alerted', () => {
  const prs = [
    mk({ headRefName: 'train/devops-20261126', body: table(['t/1', 't/2', 't/3']) }),
    mk({ title: 'fix(t/9): one thing', headRefName: 'fix/t9-x' }),
    mk({ title: 'INCIDENT fix t/650', headRefName: 'incident/t650-key' }),
  ];
  const r = analyze(prs, NOW);
  assert.deepEqual(r.singleAlerts.map((x) => x.pr.number), [prs[1].number]);
  assert.equal(r.alert, true);
  assert.match(formatText(r), /\*\*Batching alert\*\*[\s\S]*1 single-ticket non-incident PR\(s\) merged today: #/);
});

test('alerts: a 7-day median under the floor alerts; at the floor it does not', () => {
  const past = (d, tickets) => mk({ createdAt: `2026-11-${d}T01:00:00Z`, mergedAt: `2026-11-${d}T10:00:00Z`, headRefName: `train/devops-202611${d}`, body: table(tickets) });
  const low = analyze([past('21', ['t/1', 't/2']), past('22', ['t/3', 't/4']), past('23', ['t/5', 't/6', 't/7'])], NOW);
  assert.equal(low.week.medianTickets, 2); assert.equal(low.medianAlert, true);
  const ok = analyze([past('21', ['t/1', 't/2', 't/3']), past('22', ['t/4', 't/5', 't/6'])], NOW);
  assert.equal(ok.week.medianTickets, MEDIAN_FLOOR); assert.equal(ok.medianAlert, false);
  // Outside the 7-day window: not counted.
  assert.equal(analyze([past('18', ['t/1'])], NOW).week.prs, 0);
});

test('TL p/9#638: every feature PR merged today is named with its tickets, so a padded table can be spot-checked', () => {
  const f = mk({ headRefName: 'feat/t9-x', body: table(['t/1', 't/2', 't/3']) });
  const r = analyze([f, mk({ headRefName: 'train/devops-20261126', body: table(['t/4', 't/5', 't/6']) })], NOW);
  assert.deepEqual(r.featureMerges.map((x) => x.pr.number), [f.number]);
  assert.match(formatText(r), new RegExp(`Feature PRs merged today[^\\n]*\\(1\\):\\n  #${f.number}: 3 ticket\\(s\\) \\(t/1, t/2, t/3\\)`));
});

test('no PR-count threshold: 60 PRs opened today, all three-ticket trains, raise no alert', () => {
  const prs = Array.from({ length: 60 }, (_, i) => mk({ headRefName: `train/devops-20261126${String.fromCharCode(97 + (i % 26))}`, body: table(['t/1', 't/2', 't/3']) }));
  const r = analyze(prs, NOW);
  assert.equal(r.openedToday, 60); assert.equal(r.alert, false);
  assert.doesNotMatch(formatText(r), /budget|refused|over\b/i);
  assert.match(formatText(r), /Context only \(no threshold\): 60 PR\(s\) opened today/);
});

test('messages: exactly one, to the TL; never to the sender or human; dry-run sends nothing', async () => {
  const prs = [mk({ title: 'fix(t/9): x', headRefName: 'fix/t9-x' })];
  const r = analyze(prs, NOW);
  assert.deepEqual(planMessages(r, { tl: 'tl-id' }).map((m) => m.to), ['tl-id']);
  const sent = [];
  const out = await run({ repo: 'o/r', json: false, send: true, sender: 's', tl: 'tl-id' }, { now: Date.parse(NOW), fetch: () => ({ prs, calls: 1 }), appRun: async (app, cmd, args) => { sent.push(args.to); return {}; }, ...quiet });
  assert.deepEqual(sent, ['tl-id']); assert.equal(out.failed.length, 0);
  const self = [];
  await run({ repo: 'o/r', json: false, send: true, sender: 'tl-id', tl: 'tl-id' }, { now: Date.parse(NOW), fetch: () => ({ prs, calls: 1 }), appRun: async (a, c, args) => { self.push(args.to); }, ...quiet });
  assert.deepEqual(self, []);
  const dry = [];
  await run({ repo: 'o/r', json: true, send: false, tl: 'tl-id' }, { now: Date.parse(NOW), fetch: () => ({ prs, calls: 1 }), appRun: async (...a) => { dry.push(a); }, ...quiet });
  assert.equal(dry.length, 0);
});
