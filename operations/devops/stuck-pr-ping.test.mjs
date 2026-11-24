// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/535: stuck-PR alert -> one Interweave ping per owner per run. Arms: blocker parsing; owner
// resolution in each branch (title/branch ticket, body ticket, files, Dependabot, human, archived,
// none); one message per owner listing only NEW keys; a new head or blocker is a new key; TL
// escalation after 2 days, once, one message; dry-run sends nothing and writes no ledger; a failed
// send is not recorded; a bridge QueryError sends nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  latestBlocker, resolveOwner, citedTickets, planRun, recordSent, keyOf, run, parseArgs,
  DEVOPS_LEAD, TECH_LEAD, SENDER, HEADER, ESCALATE_AFTER_MS,
} from './stuck-pr-ping.mjs';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const ARCHIVED = '33333333-3333-3333-3333-333333333333';
const known = new Set([A, B, DEVOPS_LEAD, TECH_LEAD]);
const NOW = Date.parse('2026-11-24T22:00:00Z');
const pr = (n, over = {}) => ({ number: n, title: `PR ${n}`, body: '', branch: `feat/x${n}`, head: `${n}`.padEnd(40, 'a'), author: 'jpsnover', ...over });
const blocker = (cls = 'merge-conflict', remedy = null) => ({ class: cls, sha: 'a'.repeat(40), remedy });

test('latestBlocker: the newest alert marker wins, with its Remedy line', () => {
  const c = [
    { body: 'chatter' },
    { body: 'Blocker: `ci-red`\n<!-- stuck-pr-alert:ci-red:abcdef1 -->' },
    { body: 'Blocker: `merge-conflict`\nRemedy: rebase onto main.\n<!-- stuck-pr-alert:merge-conflict:0123456789abcdef -->' },
  ];
  assert.deepEqual(latestBlocker(c), { class: 'merge-conflict', sha: '0123456789abcdef', remedy: 'rebase onto main.' });
  assert.equal(latestBlocker([{ body: 'no marker' }]), null);
  assert.equal(latestBlocker(undefined), null);
});

test('resolveOwner: the title/branch ticket beats the body; its agent assignee is the owner', () => {
  const tickets = { 501: { id: A, kind: 'agent' }, 502: { id: B, kind: 'agent' } };
  const r = resolveOwner(pr(1, { branch: 'devops/t501-x', body: 'see t/502' }), { ticketAssignee: (n) => tickets[n] ?? null, fileOwners: null, known });
  assert.deepEqual(r, { to: A, why: 'title/branch cites t/501', fallback: false });
});

test('resolveOwner: with no title/branch ticket, the body ticket decides', () => {
  const r = resolveOwner(pr(1, { branch: 'feat/x', body: 'Fixes t/502.' }), { ticketAssignee: (n) => (n === 502 ? { id: B, kind: 'agent' } : null), fileOwners: null, known });
  assert.equal(r.to, B);
});

test('resolveOwner: no ticket ref -> the majority owner of the changed files', () => {
  const r = resolveOwner(pr(1, { branch: 'feat/x' }), { ticketAssignee: () => null, fileOwners: [A, A, B], known });
  assert.equal(r.to, A);
  assert.match(r.why, /owns 2\/3 changed files/);
});

for (const [label, p, opts, re] of [
  ['Dependabot PR', pr(1, { author: 'app/dependabot', branch: 'dependabot/npm/x' }), {}, /Dependabot/],
  ['ticket assigned to the human (never pinged)', pr(1, { branch: 'feat/t501' }), { ticketAssignee: () => ({ id: 'human', kind: 'human' }) }, /never pinged/],
  ['archived/unknown assignee', pr(1, { branch: 'feat/t501' }), { ticketAssignee: () => ({ id: ARCHIVED, kind: 'agent' }) }, /not a live collaborator/],
  ['cited ticket has no assignee', pr(1, { branch: 'feat/t501' }), { ticketAssignee: () => null }, /none assigned/],
  ['no ticket and no majority owner', pr(1), { fileOwners: [A, B] }, /no majority owner/],
  ['no ticket and files not looked up', pr(1), { fileOwners: null }, /no majority owner/],
]) {
  test(`resolveOwner -> DevOps Lead: ${label}`, () => {
    const r = resolveOwner(p, { ticketAssignee: () => null, fileOwners: null, known, ...opts });
    assert.equal(r.to, DEVOPS_LEAD);
    assert.equal(r.fallback, true);
    assert.match(r.why, re);
  });
}

test('citedTickets: tier tokens are not tickets (`ci(t1-approval-guard)`, `(Tier: T2)`); the branch ticket stays', () => {
  const r = citedTickets(pr(5283, { title: 'ci(t1-approval-guard): use the shared retry (Tier: T2)', branch: 'devops/t238-withretry-split' }));
  assert.deepEqual([...r.primary], [238]);
});

test('resolveOwner: a cited ticket that does not exist here is named as not found, and goes to the DevOps Lead', () => {
  const r = resolveOwner(pr(1, { branch: 'devops/t4971-cache-prune' }), { ticketAssignee: () => undefined, fileOwners: null, known });
  assert.equal(r.to, DEVOPS_LEAD);
  assert.match(r.why, /t\/4971 not found in this tracker/);
});

// The alert is raised at the PR's own head (pr-triage writes the head into the marker).
const item = (n, to, cls = 'merge-conflict', over = {}) => {
  const p = pr(n, over);
  return { pr: p, blocker: { ...blocker(cls, 'rebase onto main.'), sha: p.head }, owner: { to, why: 'x', fallback: to === DEVOPS_LEAD } };
};

test('planRun: ONE message per owner listing all their new keys; each starts with the automated header', () => {
  const { messages } = planRun([item(1, A), item(2, A), item(3, B)], { keys: {} }, NOW);
  assert.equal(messages.length, 2);
  const toA = messages.find((m) => m.to === A);
  assert.deepEqual(toA.keys, [item(1, A), item(2, A)].map((i) => keyOf(i.pr, i.blocker)));
  assert.ok(toA.body.startsWith(HEADER));
  assert.match(toA.body, /2 of your PRs are stuck/);
  assert.match(toA.body, /#1 PR 1 .*blocker `merge-conflict`; remedy: rebase onto main\./);
  assert.ok(messages.every((m) => m.to !== 'human'));
});

test('planRun: a key already pinged is not re-sent; a new alert at a new head, or a new blocker, is a new key', () => {
  const ledger = recordSent({ keys: {} }, planRun([item(1, A)], { keys: {} }, NOW).messages, NOW);
  assert.deepEqual(planRun([item(1, A)], ledger, NOW + 3600e3).messages, []);
  const newHead = planRun([item(1, A, 'merge-conflict', { head: 'b'.repeat(40) })], ledger, NOW + 3600e3).messages; // marker re-raised at the new head
  assert.equal(newHead.length, 1);
  const newBlocker = planRun([item(1, A, 'ci-red')], ledger, NOW + 3600e3).messages;
  assert.equal(newBlocker.length, 1);
});

test('planRun: escalation after 2 days goes to the Tech Lead in ONE message, and only once per key', () => {
  const ledger = recordSent({ keys: {} }, planRun([item(1, A), item(2, B)], { keys: {} }, NOW).messages, NOW);
  assert.deepEqual(planRun([item(1, A), item(2, B)], ledger, NOW + ESCALATE_AFTER_MS - 1).messages, [], 'not before 2 days');
  const later = NOW + ESCALATE_AFTER_MS;
  const { messages } = planRun([item(1, A), item(2, B)], ledger, later);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].to, TECH_LEAD);
  assert.equal(messages[0].kind, 'escalation');
  assert.equal(messages[0].keys.length, 2);
  assert.match(messages[0].body, /owner pinged: 1111/);
  const after = recordSent(ledger, messages, later);
  assert.deepEqual(planRun([item(1, A), item(2, B)], after, later + 1e9).messages, [], 'escalated once');
});

test('planRun: a PR that is no longer alerted is not escalated', () => {
  const ledger = recordSent({ keys: {} }, planRun([item(1, A)], { keys: {} }, NOW).messages, NOW);
  assert.deepEqual(planRun([], ledger, NOW + 2 * ESCALATE_AFTER_MS).messages, []);
});

// ── whole run, all I/O injected ─────────────────────────────────────────────────────────────

function deps({ sendFails = new Set(), queryError = null, ledger = { keys: {} } } = {}) {
  const sent = [];
  const logs = [];
  const written = [];
  const facts = new Map([
    [10, { pr: pr(10, { branch: 'devops/t501-x' }), blocker: blocker('merge-conflict') }],
    [11, { pr: pr(11, { branch: 'feat/t502-y' }), blocker: blocker('ci-red', 'fix the failing job') }],
    [12, { pr: pr(12, { author: 'app/dependabot', branch: 'dependabot/npm/jest-dom' }), blocker: blocker('merge-conflict') }],
  ]);
  return {
    sent, logs, written,
    d: {
      log: (s) => logs.push(s),
      readAlerts: () => (queryError ? { QueryError: queryError } : { OwnerAlerts: [{ number: 10 }, { number: 12 }], TLAlerts: [{ number: 11 }, { number: 10 }] }),
      readPrFacts: (_repo, numbers) => new Map(numbers.map((n) => [n, facts.get(n)])),
      knownCollaborators: async () => known,
      fileOwnersFor: async () => null,
      appRun: async (app, command, args) => {
        if (app === 'tickets' && command === 'get') return { assignee: { 501: { id: A, kind: 'agent' }, 502: { id: B, kind: 'agent' } }[Number(args.id.slice(2))] ?? null };
        if (app === 'chat' && command === 'send') {
          if (sendFails.has(args.to)) throw new Error('Busy');
          sent.push(args);
          return { ping: 'p/1#1' };
        }
        throw new Error(`unexpected ${app} ${command}`);
      },
      ledger,
      writeLedger: (l) => written.push(l),
      nowMs: NOW,
    },
  };
}

test('run, DEFAULT dry-run: plans one message per owner, sends nothing, writes no ledger', async () => {
  const { d, sent, logs, written } = deps();
  const r = await run(parseArgs([]), d);
  assert.equal(sent.length, 0);
  assert.equal(written.length, 0);
  assert.deepEqual(r.messages.map((m) => m.to).sort(), [A, B, DEVOPS_LEAD].sort());
  assert.ok(logs.some((l) => l.startsWith('[dry-run] would send to')));
  assert.match(logs.at(-1), /3 alerted PR\(s\); 3 message\(s\) planned \(dry-run, nothing sent; pass --send to send\)/);
});

test('run --send: sends as the DevOps Worker, records only accepted messages', async () => {
  const { d, sent, written } = deps({ sendFails: new Set([B]) });
  const r = await run(parseArgs(['--send']), d);
  assert.equal(sent.length, 2);
  assert.ok(sent.every((s) => s.sender === SENDER));
  assert.equal(r.failed.length, 1);
  assert.equal(written.length, 1);
  const keys = Object.keys(written[0].keys);
  assert.ok(keys.some((k) => k.startsWith('#10@')) && keys.some((k) => k.startsWith('#12@')));
  assert.ok(!keys.some((k) => k.startsWith('#11@')), 'the failed send to B is not recorded, so it is retried');
});

test('run: a bridge QueryError stops the run with an ActionableError and sends nothing', async () => {
  const { d, sent } = deps({ queryError: 'HTTP 401' });
  await assert.rejects(run(parseArgs(['--send']), d), (e) => e.name === 'ActionableError' && /HTTP 401/.test(e.message) && /Nothing was sent/.test(e.message));
  assert.equal(sent.length, 0);
});

test('parseArgs: dry-run unless --send; only a loopback daemon', () => {
  assert.equal(parseArgs([]).send, false);
  assert.equal(parseArgs(['--send']).send, true);
  assert.throws(() => parseArgs(['--daemon', 'http://example.com:7420']), /loopback/);
  assert.throws(() => parseArgs(['--sned']), /unknown argument/);
});

test('keys use the head the alert was raised at: a push alone does not re-ping; a stale alert is marked as such', () => {
  const raised = { class: 'ci-red', sha: 'c'.repeat(40), remedy: null };
  const it = (head) => ({ pr: pr(7, { head }), blocker: raised, owner: { to: A, why: 'x', fallback: false } });
  const first = planRun([it('c'.repeat(40))], { keys: {} }, NOW).messages;
  const ledger = recordSent({ keys: {} }, first, NOW);
  assert.deepEqual(planRun([it('d'.repeat(40))], ledger, NOW + 1).messages, [], 'same alert, new head: no re-ping');
  const fresh = planRun([it('d'.repeat(40))], { keys: {} }, NOW).messages[0].body;
  assert.match(fresh, /raised at an older head `ccccccccc`, so it may already be fixed/);
});
