// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/656: the landing-vehicle check that replaced the daily PR count in enqueue-pr. Pure core (branch
// classes, ticket tables, every verdict arm, the grandfather window, messages), the gh/ticket shim
// with fakes, and the enqueuePR/runCli wiring (order, refusal before any gh merge, head-moved check,
// one owner ping). Run: node --test operations/devops/landing-vehicle.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTOMATED_RE, CUTOVER_ISO, GRANDFATHER_UNTIL_ISO, REFUSAL_REASONS, ROUTE_REASONS, TRAIN_AREAS,
  checkLandingVehicle, classifyBranch, ticketTableFacts, vehicleOkLine, vehicleRefusalMessage, vehicleVerdict,
} from './landing-vehicle.mjs';
import { PING_REASONS, pingVehicleRefusal } from './pr-budget-notify.mjs';
import { enqueuePR, runCli } from './enqueue-pr.mjs';
import { GATE_SCRIPTS, REVIEWER_APP_REST_LOGIN } from './gate-file-change.mjs';
import { classifyEnqueueFailure } from './dependabot-enqueue-sweep.mjs';

const AFTER = '2026-11-26T10:00:00Z'; // after the cutover, inside the grandfather window
const LATER = '2026-11-28T10:00:00Z'; // after the grandfather window
const BEFORE_CUTOVER = '2026-11-25T12:00:00Z';
const pr = (over = {}) => ({ number: 42, title: 't', body: '', createdAt: AFTER, headRefName: 'fix/x', headRefOid: 'head42', state: 'OPEN', author: 'jpsnover', ...over });
const quiet = { log: () => {}, warn: () => {} };
const table = (rows, header = '| Ticket | Owner | Change |') => [header, '|---|---|---|', ...rows].join('\n');

// ── branch classes ───────────────────────────────────────────────────────────────────────────

test('classifyBranch: every area train, the weekly docs train, feature, incident and the base re-pin', () => {
  for (const a of TRAIN_AREAS) assert.equal(classifyBranch(`train/${a}-20261126`).kind, 'train', a);
  assert.equal(classifyBranch('train/devops-20261125b').kind, 'train');
  assert.equal(classifyBranch('docs/weekly-2026-48').kind, 'train');
  assert.deepEqual(classifyBranch('feat/t656-landing-vehicle'), { kind: 'feature', ticket: 't/656' });
  assert.deepEqual(classifyBranch('incident/t650-gemini-key'), { kind: 'incident', ticket: 't/650' });
  assert.equal(classifyBranch('docker/base-repin-2026-11-25-fdf12637c4b6').kind, 'automated');
  assert.ok(AUTOMATED_RE.test('docker/base-repin-x'));
});

test('classifyBranch: near-misses are not vehicles', () => {
  for (const b of ['train/other-20261126', 'train/devops-2026112', 'train/devops-20261126-x', 'feat/t12', 'feat/tabc-x', 'feat/t12-Upper',
    'incident/x', 'incident/t12', 'docker/base-image', 'docker/other-repin-1', 'fix/t1-x', 'devops/t564-x', 't617/staging', 'dependabot/npm/x', '', null]) {
    assert.equal(classifyBranch(b).kind, 'none', String(b));
  }
});

// ── ticket tables ────────────────────────────────────────────────────────────────────────────

test('ticketTableFacts: distinct tickets from every table row, distinct owners from an Owner/Author column', () => {
  const body = ['Tier: T1', '', table(['| t/1 | DevOps Lead | a |', '| t/2, t/3 | **Security** | b |', '| t/2 | devops lead | c |']), '', 'Prose mentions t/99 outside a table.'].join('\n');
  assert.deepEqual(ticketTableFacts(body), { tickets: ['t/1', 't/2', 't/3'], owners: ['devops lead', 'security'] });
  assert.deepEqual(ticketTableFacts(table(['| `a1` | t/4 | x |'], '| Commit | Ticket | Author |')), { tickets: ['t/4'], owners: ['x'] });
  assert.deepEqual(ticketTableFacts('| not | a table |\nno separator'), { tickets: [], owners: [] });
  assert.deepEqual(ticketTableFacts(''), { tickets: [], owners: [] });
});

// ── verdicts ─────────────────────────────────────────────────────────────────────────────────

test('vehicleVerdict: Dependabot, trains and the automated re-pin are allowed with no further read', () => {
  assert.equal(vehicleVerdict({ pr: pr({ author: 'app/dependabot', headRefName: 'dependabot/npm/x' }), nowIso: LATER }).reason, 'dependabot');
  assert.equal(vehicleVerdict({ pr: pr({ headRefName: 'train/server-20261126' }), nowIso: LATER }).reason, 'train');
  assert.equal(vehicleVerdict({ pr: pr({ headRefName: 'docs/weekly-2026-48' }), nowIso: LATER }).reason, 'train');
  assert.equal(vehicleVerdict({ pr: pr({ headRefName: 'docker/base-repin-2026-11-25-ab' }), nowIso: LATER }).reason, 'automated');
});

test('vehicleVerdict: a feature PR needs 3+ tickets or 2+ owners in its table; otherwise feature_too_small', () => {
  const f = (rows) => pr({ headRefName: 'feat/t9-x', body: table(rows) });
  assert.equal(vehicleVerdict({ pr: f(['| t/1 | A | x |', '| t/2 | A | y |', '| t/3 | A | z |']), nowIso: LATER }).reason, 'feature');
  assert.equal(vehicleVerdict({ pr: f(['| t/1 | A | x |', '| t/1 | B | y |']), nowIso: LATER }).reason, 'feature');
  const small = vehicleVerdict({ pr: f(['| t/1 | A | x |', '| t/2 | A | y |']), nowIso: LATER });
  assert.equal(small.allow, false); assert.equal(small.reason, 'feature_too_small');
  assert.match(small.detail, /2 ticket\(s\) and 1 owner\(s\)/);
  assert.equal(vehicleVerdict({ pr: pr({ headRefName: 'feat/t9-x' }), nowIso: LATER }).reason, 'feature_too_small');
});

test('vehicleVerdict: an incident PR needs an open INCIDENT ticket, or a valid exemption; an unreadable ticket refuses', () => {
  const p = pr({ headRefName: 'incident/t650-key' });
  assert.equal(vehicleVerdict({ pr: p, nowIso: LATER, ticket: { title: 'INCIDENT (security): x', status: 'Open' } }).reason, 'incident');
  assert.equal(vehicleVerdict({ pr: p, nowIso: LATER, ticket: { title: 'INCIDENT: x', status: 'InProgress' } }).reason, 'incident');
  for (const ticket of [{ title: 'INCIDENT: x', status: 'Done' }, { title: 'A bug', status: 'Open' }, null]) {
    const v = vehicleVerdict({ pr: p, nowIso: LATER, ticket });
    assert.equal(v.allow, false); assert.equal(v.reason, 'incident_not_open', JSON.stringify(ticket));
  }
  const unread = vehicleVerdict({ pr: p, nowIso: LATER, ticket: null, ticketError: 'daemon down' });
  assert.equal(unread.reason, 'vehicle_read_failed'); assert.match(unread.detail, /t\/650.*daemon down/);
  assert.equal(vehicleVerdict({ pr: p, nowIso: LATER, exempt: { valid: true, role: 'Tech Lead', reason: 'r' } }).reason, 'incident_exempt');
});

test('vehicleVerdict: anything else is not_a_vehicle; a PR opened before the cutover is grandfathered until the window ends', () => {
  const v = vehicleVerdict({ pr: pr({ headRefName: 't617/staging-ro' }), nowIso: LATER });
  assert.equal(v.allow, false); assert.equal(v.reason, 'not_a_vehicle'); assert.match(v.detail, /t617\/staging-ro/);
  const old = pr({ headRefName: 't617/staging-ro', createdAt: BEFORE_CUTOVER });
  assert.equal(vehicleVerdict({ pr: old, nowIso: AFTER }).reason, 'grandfathered');
  assert.equal(vehicleVerdict({ pr: old, nowIso: LATER }).reason, 'not_a_vehicle');
  // A single-ticket feature PR opened before the cutover is grandfathered too.
  assert.equal(vehicleVerdict({ pr: { ...old, headRefName: 'feat/t540-staging-boot-guard' }, nowIso: AFTER }).reason, 'grandfathered');
  // A PR opened at or after the cutover is never grandfathered.
  assert.equal(vehicleVerdict({ pr: pr({ headRefName: 'fix/x', createdAt: CUTOVER_ISO }), nowIso: AFTER }).reason, 'not_a_vehicle');
  assert.equal(Date.parse(GRANDFATHER_UNTIL_ISO) - Date.parse(CUTOVER_ISO), 48 * 3600_000);
});

test('messages: the refusal keeps the shape the sweeps classify, names the trains and the close times; grandfather WARNs', () => {
  for (const reason of REFUSAL_REASONS) {
    const m = vehicleRefusalMessage({ repo: 'o/r', prNumber: 42, verdict: { allow: false, reason, detail: 'D', branch: 'fix/x' } });
    assert.match(m, new RegExp(`^enqueue-pr: refusing to arm/enqueue #42 on o/r \\(${reason}\\)\\.`));
    assert.match(m, /Goal:[\s\S]*Problem:[\s\S]*Location:[\s\S]*Next steps:/);
    assert.equal(classifyEnqueueFailure(Object.assign(new Error(m), { reason })).kind, 'policy', reason);
  }
  const m = vehicleRefusalMessage({ repo: 'o/r', prNumber: 42, verdict: { allow: false, reason: 'not_a_vehicle', detail: 'x' } });
  assert.match(m, /train\/devops-YYYYMMDD[\s\S]*06:00Z and 18:00Z/);
  assert.match(vehicleOkLine({ repo: 'o/r', prNumber: 42, verdict: { reason: 'grandfathered', vehicle: { kind: 'none' } } }), /^WARN: .*opened before the .*cutover.*train\/devops-YYYYMMDD/);
});

test('the sweeps skip exactly the route refusals, and the owner ping fires on exactly those', () => {
  assert.deepEqual([...PING_REASONS].sort(), [...ROUTE_REASONS].sort());
  for (const r of ROUTE_REASONS) assert.ok(REFUSAL_REASONS.includes(r));
});

// ── the shim ─────────────────────────────────────────────────────────────────────────────────

const ghFor = (p, reviews = {}) => (args) => {
  if (args[0] === 'api' && args[1] === 'graphql') {
    return JSON.stringify({ data: { repository: { pullRequest: { ...p, author: { login: p.author }, commits: { nodes: [] } } } } });
  }
  const m = /^repos\/o\/r\/pulls\/42\/reviews\/(\d+)$/.exec(args[1] ?? '');
  if (args[0] === 'api' && m) { if (!reviews[m[1]]) throw new Error('HTTP 404'); return JSON.stringify(reviews[m[1]]); }
  throw new Error(`unexpected gh ${args.join(' ')}`);
};
const NOW = Date.parse(LATER);

test('checkLandingVehicle: reads the PR once; trains pass; a read failure refuses (fail closed)', async () => {
  const ok = await checkLandingVehicle('o/r', 42, { gh: ghFor(pr({ headRefName: 'train/devops-20261126' })), now: NOW, ...quiet });
  assert.equal(ok.allow, true); assert.equal(ok.reason, 'train'); assert.equal(ok.pr.headRefOid, 'head42');
  const bad = await checkLandingVehicle('o/r', 42, { gh: () => { throw new Error('HTTP 502'); }, now: NOW, ...quiet });
  assert.equal(bad.allow, false); assert.equal(bad.reason, 'vehicle_read_failed');
});

test('checkLandingVehicle: an incident PR reads its ticket; an unreadable ticket refuses', async () => {
  const g = ghFor(pr({ headRefName: 'incident/t650-key' }));
  const read = [];
  const ok = await checkLandingVehicle('o/r', 42, { gh: g, now: NOW, readTicket: async (id) => { read.push(id); return { title: 'INCIDENT: x', status: 'Open' }; }, ...quiet });
  assert.equal(ok.reason, 'incident'); assert.deepEqual(read, ['t/650']);
  const down = await checkLandingVehicle('o/r', 42, { gh: g, now: NOW, readTicket: async () => { throw new Error('ECONNREFUSED'); }, ...quiet });
  assert.equal(down.allow, false); assert.equal(down.reason, 'vehicle_read_failed');
});

test('checkLandingVehicle: --budget-exempt-review is for incident PRs only; it needs --by and a valid TL/Security review at the head', async () => {
  const review = (over = {}) => ({ user: { login: REVIEWER_APP_REST_LOGIN }, state: 'APPROVED', commit_id: 'head42', body: 'Approved (Tech Lead): budget-exempt: incident t/650', ...over });
  const notIncident = await checkLandingVehicle('o/r', 42, { gh: ghFor(pr({ headRefName: 'train/devops-20261126' }), { 7: review() }), exemptReviewId: 7, by: 'me', now: NOW, ...quiet });
  assert.equal(notIncident.allow, false); assert.equal(notIncident.reason, 'budget_exempt_not_incident');
  const inc = pr({ headRefName: 'incident/t650-key' });
  const noBy = await checkLandingVehicle('o/r', 42, { gh: ghFor(inc, { 7: review() }), exemptReviewId: 7, now: NOW, ...quiet });
  assert.equal(noBy.reason, 'budget_exempt_invalid');
  const stale = await checkLandingVehicle('o/r', 42, { gh: ghFor(inc, { 7: review({ commit_id: 'old' }) }), exemptReviewId: 7, by: 'me', now: NOW, ...quiet });
  assert.equal(stale.reason, 'budget_exempt_invalid');
  const logs = [];
  const good = await checkLandingVehicle('o/r', 42, { gh: ghFor(inc, { 7: review() }), exemptReviewId: 7, by: 'me', now: NOW, readTicket: async () => { throw new Error('must not read'); }, log: (l) => logs.push(l), warn: () => {} });
  assert.equal(good.allow, true); assert.equal(good.reason, 'incident_exempt');
  assert.match(logs[0], /^BUDGET-EXEMPT repo=o\/r pr=42 head=head42 review=7 approver="Tech Lead" by=me/);
});

// ── enqueuePR wiring ─────────────────────────────────────────────────────────────────────────

const CURRENT = () => ({ ok: true, reason: 'current', mainSha: 'f'.repeat(40), paths: ['operations/devops/enqueue-pr.mjs'] });

test('enqueuePR: the vehicle check runs after the currency check and before any other read; a refusal throws before any gh call', async () => {
  const order = [];
  const g = (args) => { order.push(`gh ${args.slice(0, 2).join(' ')}`); throw new Error('no gh call may happen'); };
  const refuse = async (repo, n, opts) => { order.push('vehicle'); assert.equal(opts.gh, g); return { allow: false, reason: 'not_a_vehicle', detail: 'head branch "fix/x" is not a landing vehicle', pr: { number: n } }; };
  await assert.rejects(() => enqueuePR('o/r', 42, { sleepMs: 0, gh: g, currency: () => { order.push('currency'); return CURRENT(); }, vehicle: refuse }), (err) => {
    assert.equal(err.name, 'ActionableError'); assert.equal(err.reason, 'not_a_vehicle'); assert.equal(err.vehicle.pr.number, 42);
    assert.match(err.message, /refusing to arm\/enqueue #42 on o\/r \(not_a_vehicle\)[\s\S]*Next steps:/);
    return true;
  });
  assert.deepEqual(order, ['currency', 'vehicle']);
});

test('enqueuePR: a stale copy is refused before the vehicle check runs', async () => {
  let calls = 0;
  await assert.rejects(() => enqueuePR('o/r', 42, { sleepMs: 0, gh: () => { throw new Error('x'); }, currency: () => ({ ok: false, reason: 'differs', mainSha: 'f'.repeat(40), detail: 'x' }), vehicle: async () => { calls++; return { allow: true }; } }));
  assert.equal(calls, 0);
});

test('enqueuePR: an allowed vehicle passes on to the PR read; a throwing or empty check refuses; a moved head refuses', async () => {
  const order = [];
  const g = (args) => {
    const j = args.join(' ');
    if (j.includes('headRefOid,body,isDraft')) { order.push('pr-view'); return JSON.stringify({ headRefOid: 'newhead00', body: 'Tier: T0', isDraft: false, labels: [] }); }
    if (j.includes('{changed_files}')) { order.push('gate-files'); throw new Error('gh: HTTP 502'); }
    order.push(`unexpected ${j}`);
    throw new Error('unexpected');
  };
  const ok = async () => { order.push('vehicle'); return { allow: true, reason: 'train', vehicle: { kind: 'train' }, pr: { number: 42, headRefOid: 'newhead00' } }; };
  await assert.rejects(() => enqueuePR('o/r', 42, { sleepMs: 0, gh: g, currency: CURRENT, vehicle: ok }), /files_unreadable/);
  assert.deepEqual(order, ['vehicle', 'pr-view', 'gate-files']);
  for (const vehicle of [async () => { throw new Error('boom'); }, async () => undefined]) {
    await assert.rejects(() => enqueuePR('o/r', 42, { sleepMs: 0, gh: g, currency: CURRENT, vehicle }), (err) => err.reason === 'vehicle_read_failed');
  }
  const moved = async () => ({ allow: true, reason: 'train', pr: { number: 42, headRefOid: 'oldhead00' } });
  await assert.rejects(() => enqueuePR('o/r', 42, { sleepMs: 0, gh: g, currency: CURRENT, vehicle: moved }),
    (err) => err.reason === 'vehicle_read_failed' && /head moved between the vehicle check/.test(err.message));
});

test('GATE_SCRIPTS lists the vehicle check and the modules it imports', () => {
  for (const p of ['landing-vehicle.mjs', 'pr-budget.mjs', 'pr-budget-notify.mjs', 'my-prs.mjs']) assert.ok(GATE_SCRIPTS.includes(`operations/devops/${p}`), p);
});

// ── CLI refusal ping ─────────────────────────────────────────────────────────────────────────

const routeErr = (reason = 'not_a_vehicle') => Object.assign(new Error(`enqueue-pr: refusing (${reason})`), { reason, vehicle: { reason, pr: { number: 42, title: 't', body: '', headRefName: 'fix/x' } } });

test('runCli: a wrong-vehicle refusal pings once, with the --by sender, and exits 1; another error does not ping', async () => {
  const pings = [];
  const code = await runCli('o/r', 42, { by: 'devops-worker' }, { enqueue: async () => { throw routeErr(); }, ping: async (a) => { pings.push(a); return { sent: true }; }, log: () => {}, error: () => {} });
  assert.equal(code, 1); assert.equal(pings.length, 1);
  assert.equal(pings[0].by, 'devops-worker'); assert.equal(pings[0].pr.number, 42); assert.equal(pings[0].reason, 'not_a_vehicle');
  const none = [];
  assert.equal(await runCli('o/r', 42, {}, { enqueue: async () => { throw new Error('other'); }, ping: async (a) => none.push(a), log: () => {}, error: () => {} }), 1);
  assert.equal(none.length, 0);
  assert.equal(await runCli('o/r', 42, {}, { enqueue: async () => ({ ok: true }), ping: async (a) => none.push(a), log: () => {}, error: () => {} }), 0);
});

test('pingVehicleRefusal: ONE chat to the resolved owner, naming the train route; other reasons, no sender or no owner send nothing', async () => {
  const sent = [];
  const appRun = async (app, cmd, args) => { sent.push({ app, cmd, args }); return { ok: true }; };
  const r = await pingVehicleRefusal({ repo: 'o/r', pr: routeErr().vehicle.pr, reason: 'feature_too_small', message: 'M', by: 'sender-id' },
    { appRun, resolveOwner: async () => ({ id: 'owner-id', why: 'title/branch cites t/9' }), ...quiet });
  assert.deepEqual(r, { sent: true, to: 'owner-id' });
  assert.equal(sent.length, 1); assert.match(sent[0].args.body, /Landing vehicle[\s\S]*#42[\s\S]*M[\s\S]*area train/);
  const p = routeErr().vehicle.pr;
  assert.equal((await pingVehicleRefusal({ repo: 'o/r', pr: p, reason: 'vehicle_read_failed', message: 'M', by: 's' }, { appRun: async () => { throw new Error('no'); }, ...quiet })).skipped, 'not_a_vehicle_refusal');
  const warns = [];
  assert.equal((await pingVehicleRefusal({ repo: 'o/r', pr: p, reason: 'not_a_vehicle', message: 'M', by: null }, { appRun: async () => { throw new Error('no'); }, log: () => {}, warn: (m) => warns.push(m) })).skipped, 'no_sender');
  assert.match(warns[0], /^WARN:/);
});
