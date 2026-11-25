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
  DEVOPS_LEAD, TECH_LEAD, SENDER, HEADER, ESCALATE_AFTER_MS, safeRemedy, TRAIN_OWNERS, trainArea,
} from './stuck-pr-ping.mjs';
import { ENQUEUE_REMEDY } from './stuck-pr-classifier.mjs';

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
  const at = (p, b) => ({ pr: p, blocker: { ...b, sha: p.head } }); // alert raised at the PR's own head
  const facts = new Map([
    [10, at(pr(10, { branch: 'devops/t501-x' }), blocker('merge-conflict'))],
    [11, at(pr(11, { branch: 'feat/t502-y' }), blocker('ci-red', 'fix the failing job'))],
    [12, at(pr(12, { author: 'app/dependabot', branch: 'dependabot/npm/jest-dom' }), blocker('merge-conflict'))],
    [13, { pr: pr(13, { branch: 'feat/t501-z' }), blocker: blocker('ci-red') }], // raised at an older head
  ]);
  return {
    sent, logs, written,
    d: {
      log: (s) => logs.push(s),
      readAlerts: () => (queryError ? { QueryError: queryError } : { OwnerAlerts: [{ number: 10 }, { number: 12 }, { number: 13 }], TLAlerts: [{ number: 11 }, { number: 10 }] }),
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
      // No network in a test: the budget check is always injected (t/535#24).
      checkBudget: () => ({ allow: true, reason: 'within_budget_today' }),
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
  assert.ok(logs.some((l) => /^stale alert, not pinged: #13 `ci-red`/.test(l)), logs.join(' | '));
  assert.match(logs.at(-1), /4 alerted PR\(s\); 3 message\(s\) planned \(dry-run, nothing sent; pass --send to send\)/);
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

test('an alert raised at an older head is not pinged: it is listed as stale; a push alone never re-pings', () => {
  const raised = { class: 'ci-red', sha: 'c'.repeat(40), remedy: null };
  const it = (head) => ({ pr: pr(7, { head }), blocker: raised, owner: { to: A, why: 'x', fallback: false } });
  const first = planRun([it('c'.repeat(40))], { keys: {} }, NOW);
  assert.equal(first.messages.length, 1);
  const moved = planRun([it('d'.repeat(40))], { keys: {} }, NOW);
  assert.deepEqual(moved.messages, []);
  assert.deepEqual(moved.stale.map((x) => x.pr.number), [7]);
  const ledger = recordSent({ keys: {} }, first.messages, NOW);
  assert.deepEqual(planRun([it('d'.repeat(40))], ledger, NOW + 2 * ESCALATE_AFTER_MS).messages, [], 'a stale alert is not escalated either');
});

test('owner order (t/535#5): title/branch ticket, then the changed files, then a body ticket as the last fallback', () => {
  const tickets = { 501: { id: A, kind: 'agent' }, 502: { id: B, kind: 'agent' } };
  const ta = (n) => tickets[n] ?? null;
  assert.equal(resolveOwner(pr(1, { branch: 'feat/t501', body: 'see t/502' }), { ticketAssignee: ta, fileOwners: [B, B], known }).to, A);
  assert.equal(resolveOwner(pr(1, { branch: 'feat/x', body: 'see t/502' }), { ticketAssignee: ta, fileOwners: [A, A, B], known }).to, A, 'files beat the body ticket');
  assert.equal(resolveOwner(pr(1, { branch: 'feat/x', body: 'see t/502' }), { ticketAssignee: ta, fileOwners: [A, B], known }).to, B, 'no majority -> the body ticket');
  const missingPrimary = resolveOwner(pr(1, { branch: 'feat/t4971', body: '' }), { ticketAssignee: () => undefined, fileOwners: [B, B, B], known });
  assert.equal(missingPrimary.to, B, 'a title/branch ticket not found here falls through to the files');
});

// ── t/535 (Lead p/233#56, t/537#27): an old alert comment's unsafe remedy is never forwarded ──
const OLD_ARM_REMEDY = 'Every required context is green and the PR has an approved review, but auto-merge was never armed -- arm it (gh pr merge --auto --squash --match-head-commit <sha>), or merge directly if mergeStateStatus is already CLEAN.';
const OLD_T0_REMEDY = 'Every required context is green and this is a T0 PR with no outstanding GitHub review required by default -- arm it, UNLESS the linked ticket\'s own acceptance criteria name a required review.';

test('t/535 safeRemedy (approved-not-armed): a remedy naming gh pr merge, a direct merge or "arm it" is replaced by ENQUEUE_REMEDY', () => {
  for (const r of [OLD_ARM_REMEDY, OLD_T0_REMEDY, 'merge it directly', 'do a direct merge', 'run gh  pr  merge 5 --squash']) {
    const out = safeRemedy(r, 'approved-not-armed');
    assert.ok(out.endsWith(ENQUEUE_REMEDY), out);
    assert.match(out, /^\(the alert comment's remedy was replaced/);
    assert.ok(!out.includes('--auto'), out);
  }
});

// Quality on #5461: for any other class the enqueue text is never substituted; only the offending
// part is dropped, so the run id and the re-run step survive.
const OLD_STUCK_RUN = "Re-trigger first (toggle auto-merge or a label); if that doesn't clear it, cancel and re-run run 45507837195.";
const MY_FIRST_STUCK_RUN = "Re-trigger first (toggle a label or push an empty commit; never re-arm with gh pr merge); if that doesn't clear it, cancel and re-run run 45507837195.";
const NEW_STUCK_RUN = "Re-trigger first (toggle a label or push an empty commit); if that doesn't clear it, cancel and re-run run 45507837195.";

test('t/535 safeRemedy (stuck-required-run, OLD text): drops only "(toggle auto-merge or a label)", keeps the run id and the re-run step', () => {
  const out = safeRemedy(OLD_STUCK_RUN, 'stuck-required-run');
  assert.equal(out, "Re-trigger first; if that doesn't clear it, cancel and re-run run 45507837195.");
  assert.ok(!out.includes(ENQUEUE_REMEDY));
});

test('t/535 safeRemedy (stuck-required-run): the first #5461 wording loses only its parenthetical; the NEW wording passes through unchanged', () => {
  assert.equal(safeRemedy(MY_FIRST_STUCK_RUN, 'stuck-required-run'), "Re-trigger first; if that doesn't clear it, cancel and re-run run 45507837195.");
  assert.equal(safeRemedy(NEW_STUCK_RUN, 'stuck-required-run'), NEW_STUCK_RUN);
});

test('t/535 safeRemedy (other classes): an offending sentence is dropped, the rest kept; nothing safe left -> null; never the enqueue text', () => {
  assert.equal(safeRemedy('Check the queue. Then merge it directly.', 'queued-stuck'), 'Check the queue.');
  assert.equal(safeRemedy('merge it directly', 'idle'), null);
  assert.equal(safeRemedy('gh pr merge 5 --squash', 'merge-conflict'), null);
  for (const r of [OLD_ARM_REMEDY, 'Check the queue. Then merge it directly.']) {
    const out = safeRemedy(r, 'queued-stuck');
    assert.ok(out == null || !out.includes(ENQUEUE_REMEDY), String(out));
    assert.ok(out == null || !/gh pr merge|merge directly|arm it/i.test(out), String(out));
  }
});

test('t/535 safeRemedy: a safe remedy, the new classifier remedy, and null pass through unchanged, for any class', () => {
  for (const cls of [null, 'approved-not-armed', 'stuck-required-run', 'queued-stuck']) {
    for (const r of ['rebase onto main.', `Every required context is green ... -- ${ENQUEUE_REMEDY}`, 'disarm it first', 'it is already armed, do not re-arm it.', 'check run 123 for a hang', NEW_STUCK_RUN]) {
      assert.equal(safeRemedy(r, cls), r, `${cls}: ${r}`);
    }
    assert.equal(safeRemedy(null, cls), null);
  }
});

test('t/535: latestBlocker keeps a stuck-required-run alert\'s run id and re-run step (old comment text)', () => {
  const c = [{ body: `Blocker: \`stuck-required-run\`\nRemedy: ${OLD_STUCK_RUN}\n<!-- stuck-pr-alert:stuck-required-run:0123456789abcdef -->` }];
  const b = latestBlocker(c);
  assert.equal(b.class, 'stuck-required-run');
  assert.match(b.remedy, /cancel and re-run run 45507837195/);
  assert.ok(!b.remedy.includes(ENQUEUE_REMEDY));
  assert.doesNotMatch(b.remedy, /auto-merge/);
});

test('t/535: latestBlocker rewrites an old alert comment\'s arm remedy, so planRun never forwards it', () => {
  const c = [{ body: `Blocker: \`approved-not-armed\`\nRemedy: ${OLD_ARM_REMEDY}\n<!-- stuck-pr-alert:approved-not-armed:0123456789abcdef -->` }];
  const b = latestBlocker(c);
  assert.equal(b.class, 'approved-not-armed');
  assert.ok(b.remedy.endsWith(ENQUEUE_REMEDY));
  assert.doesNotMatch(b.remedy.split(ENQUEUE_REMEDY).join(''), /gh pr merge|merge directly/);
});

// ── t/535#24, Lead p/233#180: train routing, the budget skip, the self-skip ─────────────────────

test('trainArea: area trains (with a same-day letter suffix) and the weekly docs train; anything else is not a train', () => {
  assert.equal(trainArea('train/devops-20261125'), 'devops');
  assert.equal(trainArea('train/debate-20261125b'), 'debate');
  assert.equal(trainArea('train/renderer-20261126'), 'renderer');
  assert.equal(trainArea('docs/weekly-2026-48'), 'docs-weekly');
  for (const b of ['feat/t611-x', 'train/devops', 'train/devops-2026112', 'xtrain/devops-20261125', 'docs/weekly-26-48', '']) assert.equal(trainArea(b), null, b);
});

test('resolveOwner: a train PR goes to its train owner, ahead of any ticket its title cites (#5522 case)', () => {
  const live = new Set([...known, ...Object.values(TRAIN_OWNERS)]);
  const p = pr(5522, { title: 'train/devops-20261125 (6): t/607, t/116b, t/605', branch: 'train/devops-20261125' });
  const r = resolveOwner(p, { ticketAssignee: () => ({ id: A, kind: 'agent' }), fileOwners: null, known: live });
  assert.deepEqual([r.to, r.fallback], [DEVOPS_LEAD, false]);
  assert.match(r.why, /devops train owner/);
  assert.equal(resolveOwner(pr(5487, { branch: 'train/debate-20261125b' }), { ticketAssignee: () => null, fileOwners: null, known: live }).to, TRAIN_OWNERS.debate);
  assert.equal(resolveOwner(pr(5479, { branch: 'docs/weekly-2026-48' }), { ticketAssignee: () => null, fileOwners: null, known: live }).to, TRAIN_OWNERS['docs-weekly']);
});

test('resolveOwner: an unlisted train area, or a train owner who is not live, falls back to ticket routing with a WARN (never guessed)', () => {
  const warns = [];
  const r = resolveOwner(pr(1, { branch: 'train/powershell-20261126', title: 'ps train t/501' }), { ticketAssignee: (n) => (n === 501 ? { id: A, kind: 'agent' } : null), fileOwners: null, known, warn: (w) => warns.push(w) });
  assert.equal(r.to, A, 'routed by its ticket');
  assert.match(warns[0], /unlisted area 'powershell'/);
  const warns2 = [];
  const r2 = resolveOwner(pr(2, { branch: 'train/server-20261126' }), { ticketAssignee: () => null, fileOwners: null, known, warn: (w) => warns2.push(w) }); // TaxonomyServer not in `known`
  assert.equal(r2.to, DEVOPS_LEAD);
  assert.match(warns2[0], /server train, but its owner .* is not a live collaborator/);
});

test('planRun: a budget-waiting PR and a PR owned by the sender are listed, never messaged, never recorded', () => {
  const waiting = { ...item(5, A, 'approved-not-armed'), budgetWait: 'over_budget_today' };
  const mine = item(6, SENDER, 'approved-not-armed');
  const r = planRun([waiting, mine, item(7, B)], { keys: {} }, NOW);
  assert.deepEqual(r.messages.map((m) => m.to), [B]);
  assert.deepEqual(r.budget.map((x) => x.pr.number), [5]);
  assert.deepEqual(r.own.map((x) => x.pr.number), [6]);
  assert.ok(r.messages.every((m) => m.to !== SENDER));
});

test('run: an approved, unarmed PR that enqueue-pr would refuse for the budget is not pinged; within budget it is; an unreadable budget is not pinged, with a WARN', async () => {
  const at = (p, b) => ({ pr: p, blocker: { ...b, sha: p.head } });
  const facts = new Map([
    [20, at(pr(20, { branch: 'devops/t501-a' }), blocker('approved-not-armed', 'enqueue it'))], // over budget
    [21, at(pr(21, { branch: 'feat/t502-b' }), blocker('approved-not-armed', 'enqueue it'))],   // within budget
    [22, at(pr(22, { branch: 'feat/t502-c' }), blocker('approved-not-armed', 'enqueue it'))],   // budget unreadable
    [23, at(pr(23, { branch: 'feat/t599-d' }), blocker('merge-conflict'))],                     // owned by the sender
  ]);
  const verdicts = { 20: { allow: false, reason: 'over_budget_today' }, 21: { allow: true, reason: 'within_budget_today' }, 22: { allow: false, reason: 'budget_read_failed', detail: 'HTTP 502' } };
  const asked = [];
  const logs = [];
  const r = await run(parseArgs([]), {
    log: (s) => logs.push(s),
    readAlerts: () => ({ OwnerAlerts: [20, 21, 22, 23].map((number) => ({ number })), TLAlerts: [] }),
    readPrFacts: (_r, ns) => new Map(ns.map((n) => [n, facts.get(n)])),
    knownCollaborators: async () => new Set([...known, SENDER]),
    fileOwnersFor: async () => null,
    appRun: async (app, command, args) => {
      if (app === 'tickets' && command === 'get') return { assignee: { 501: { id: A, kind: 'agent' }, 502: { id: B, kind: 'agent' }, 599: { id: SENDER, kind: 'agent' } }[Number(args.id.slice(2))] ?? null };
      throw new Error(`unexpected ${app} ${command}`);
    },
    checkBudget: (n) => { asked.push(n); return verdicts[n]; },
    ledger: { keys: {} }, writeLedger: () => {}, nowMs: NOW,
  });
  assert.deepEqual(asked.sort(), [20, 21, 22], 'only approved-not-armed PRs are budget-checked');
  assert.deepEqual(r.messages.map((m) => [m.to, m.keys.length]), [[B, 1]], 'only the within-budget PR is pinged');
  assert.match(r.messages[0].body, /#21 /);
  assert.ok(logs.some((l) => l === 'waiting for the PR budget (over_budget_today), not pinged: #20 `approved-not-armed` (owner ' + A + ').'), logs.join('\n'));
  assert.ok(logs.some((l) => /^WARN: could not read the PR budget for #22 \(budget_read_failed: HTTP 502\)/.test(l)), logs.join('\n'));
  assert.ok(logs.some((l) => /^owner is the sender, not pinged: #23 `merge-conflict`/.test(l)), logs.join('\n'));
  assert.deepEqual(r.budget.map((x) => [x.pr.number, x.budgetWait]), [[20, 'over_budget_today'], [22, 'budget_read_failed']]);
});
