// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/564 phase A: PR budget counting (pure core, the gh shim with an injected fake, no network) and the
// report. Since t/656 the count no longer gates enqueue-pr; the enqueue wiring, the CLI refusal ping and
// the head-moved check are tested in landing-vehicle.test.mjs. Run: node --test operations/devops/pr-budget.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ONE_UNIT_BRANCH_PATTERNS, SEARCH_CAP, budgetFor, budgetRefusalMessage, budgetVerdict, buildUnits, checkPrBudget,
  exemptionVerdict, fetchPrsCreated, isAccidentalClose, isOneUnitBranch, rankOf, unitKey, windowStartDay,
} from './pr-budget.mjs';
import { resolvePrOwner } from './pr-budget-notify.mjs';
import { GATE_SCRIPTS, REVIEWER_APP_REST_LOGIN } from './gate-file-change.mjs';

const TODAY = '2026-11-24';
const NOW = `${TODAY}T18:00:00Z`;
const at = (day, minute) => new Date(Date.parse(`${day}T00:00:00Z`) + minute * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
let nextNo = 1000;
const mk = (createdAt, over = {}) => ({ number: ++nextNo, title: `pr ${nextNo}`, body: '', createdAt, headRefName: `fix/x-${nextNo}`, headRefOid: `head${nextNo}`, state: 'OPEN', author: 'jpsnover', ...over });
/** `n` ordinary PRs on `day`, one a minute from `startMinute`. */
const day = (d, n, startMinute = 0, over = {}) => Array.from({ length: n }, (_, i) => mk(at(d, startMinute + i), over));

// ── unit keying ──────────────────────────────────────────────────────────────────────────────

test('t/567: each ONE_UNIT_BRANCH_PATTERNS pattern matches its branch form', () => {
  assert.equal(ONE_UNIT_BRANCH_PATTERNS.length, 3);
  for (const b of ['feat/t564-pr-budget', 'feat/t12-a', 'feat/t9-x2-y', 'train/devops-20261125', 'train/server-20261125', 'train/renderer-20261125', 'train/debate-20261125', 'docs/weekly-2026-47']) {
    assert.ok(isOneUnitBranch(b), b);
  }
});

test('t/567: near-misses are ordinary branches (one unit per PR)', () => {
  for (const b of ['train/other-20261125', 'train/devops-2026112', 'train/devops-20261125-x', 'feat/t12', 'feat/t12-', 'feat/tabc-x', 'feat/t12-Upper',
    'feat/t12/x', 'docs/weekly-2026-4', 'docs/weekly-26-47', 'xfeat/t12-a', 'devops/t564-pr-budget', '']) {
    assert.ok(!isOneUnitBranch(b), b);
  }
});

test('unitKey / buildUnits: two PRs on one train branch the same day are 1 unit; on different days 2; ordinary PRs 1 each', () => {
  const a = mk(at(TODAY, 1), { headRefName: 'train/devops-20261124' });
  const b = mk(at(TODAY, 5), { headRefName: 'train/devops-20261124' });
  const c = mk(at('2026-11-23', 5), { headRefName: 'train/devops-20261124' });
  const d = mk(at(TODAY, 2), { headRefName: 'fix/one' });
  const e = mk(at(TODAY, 3), { headRefName: 'fix/one' });
  assert.equal(unitKey(a), unitKey(b));
  assert.notEqual(unitKey(a), unitKey(c));
  assert.notEqual(unitKey(d), unitKey(e));
  const { byDay, unitOf } = buildUnits([a, b, c, d, e]);
  assert.equal(byDay.get(TODAY).length, 3);
  assert.equal(byDay.get('2026-11-23').length, 1);
  assert.equal(unitOf.get(b.number), unitOf.get(a.number));
  // The later train PR has its unit's rank (its first PR that day), not its own position.
  assert.equal(rankOf(byDay, unitOf.get(b.number)), 1);
  assert.equal(rankOf(byDay, unitOf.get(e.number)), 3);
});

test('Dependabot PRs are not counted', () => {
  const prs = [...day(TODAY, 3), ...day(TODAY, 4, 100, { author: 'dependabot', headRefName: 'dependabot/npm/x' }), mk(at(TODAY, 1), { author: 'app/dependabot' }), mk(at(TODAY, 1), { author: 'dependabot[bot]' })];
  assert.equal(buildUnits(prs).byDay.get(TODAY).length, 3);
});

// ── budget and rank ──────────────────────────────────────────────────────────────────────────

test('budgetFor: a hard 20 every day whatever the 3-day mean (TL p/9#541); the mean uses only the three days before D', () => {
  const at25 = buildUnits([...day('2026-11-21', 25), ...day('2026-11-22', 25), ...day('2026-11-23', 25), ...day('2026-11-20', 90)]).byDay;
  assert.deepEqual(budgetFor(at25, TODAY), { budget: 20, mean: 25, counts: [25, 25, 25] });
  const over = buildUnits([...day('2026-11-21', 90), ...day('2026-11-22', 90), ...day('2026-11-23', 90)]).byDay;
  assert.equal(budgetFor(over, TODAY).budget, 20); assert.equal(budgetFor(over, TODAY).mean, 90);
  assert.equal(budgetFor(buildUnits([]).byDay, TODAY).budget, 20);
});

test('rank boundary: rank 20 is allowed and rank 21 refused at budget 20', () => {
  const prs = day(TODAY, 21);
  const v20 = budgetVerdict({ prs, pr: prs[19], nowIso: NOW });
  assert.equal(v20.rank, 20); assert.equal(v20.budget, 20); assert.equal(v20.allow, true); assert.equal(v20.reason, 'within_budget_today');
  const v21 = budgetVerdict({ prs, pr: prs[20], nowIso: NOW });
  assert.equal(v21.rank, 21); assert.equal(v21.allow, false); assert.equal(v21.reason, 'over_budget_today');
});

test('a high 3-day mean no longer lowers the cap: ranks 16 to 20 are allowed, 21 refused', () => {
  const prs = [...day('2026-11-21', 90), ...day('2026-11-22', 90), ...day('2026-11-23', 90), ...day(TODAY, 21)];
  const todays = prs.slice(-21);
  assert.equal(budgetVerdict({ prs, pr: todays[15], nowIso: NOW }).allow, true);
  assert.equal(budgetVerdict({ prs, pr: todays[19], nowIso: NOW }).allow, true);
  const v = budgetVerdict({ prs, pr: todays[20], nowIso: NOW });
  assert.equal(v.allow, false); assert.equal(v.budget, 20); assert.ok(v.mean > 25);
});

test('a later PR on a train branch already within budget is allowed even when the day is past budget', () => {
  const first = mk(at(TODAY, 0), { headRefName: 'feat/t564-pr-budget' });
  const later = mk(at(TODAY, 600), { headRefName: 'feat/t564-pr-budget' });
  const prs = [first, ...day(TODAY, 30, 1), later];
  const v = budgetVerdict({ prs, pr: later, nowIso: NOW });
  assert.equal(v.rank, 1); assert.equal(v.allow, true);
});

test('Dependabot PRs always pass and do not take a rank', () => {
  const prs = [...day(TODAY, 30, 0, { author: 'dependabot', headRefName: 'dependabot/x' }), ...day(TODAY, 20, 100)];
  assert.equal(budgetVerdict({ prs, pr: prs[0], nowIso: NOW }).reason, 'dependabot');
  assert.equal(budgetVerdict({ prs, pr: prs[49], nowIso: NOW }).rank, 20);
  assert.equal(budgetVerdict({ prs, pr: prs[49], nowIso: NOW }).allow, true);
});

test('a PR missing from the search results (index lag) is still ranked, after the PRs before it', () => {
  const prs = day(TODAY, 20);
  const late = mk(at(TODAY, 700));
  const v = budgetVerdict({ prs, pr: late, nowIso: NOW });
  assert.equal(v.rank, 21); assert.equal(v.allow, false);
});

// ── carryover pool ───────────────────────────────────────────────────────────────────────────

test('an older PR that was within its day\'s budget is always allowed, even with today full', () => {
  const y = day('2026-11-23', 20);
  const prs = [...y, ...day(TODAY, 40)];
  const v = budgetVerdict({ prs, pr: y[19], nowIso: NOW });
  assert.equal(v.allow, true); assert.equal(v.reason, 'within_budget_earlier_day'); assert.equal(v.dayBudget, 20);
});

test('pool: 0 free slots today -> a pooled PR is refused', () => {
  const y = day('2026-11-23', 23); // ranks 21, 22, 23 pooled
  const prs = [...y, ...day(TODAY, 20)];
  const v = budgetVerdict({ prs, pr: y[20], nowIso: NOW });
  assert.equal(v.reason, 'pooled_no_slot'); assert.equal(v.slots, 0); assert.equal(v.poolPosition, 1); assert.equal(v.allow, false);
});

test('pool FIFO: 2 free slots -> the first two pooled PRs may enqueue, the third may not', () => {
  const y = day('2026-11-22', 22); // two pooled, older
  const z = day('2026-11-23', 21); // one pooled, newer
  const prs = [...y, ...z, ...day(TODAY, 18)];
  const verdicts = [y[20], y[21], z[20]].map((pr) => budgetVerdict({ prs, pr, nowIso: NOW }));
  assert.deepEqual(verdicts.map((v) => v.poolPosition), [1, 2, 3]);
  assert.deepEqual(verdicts.map((v) => v.slots), [2, 2, 2]);
  assert.deepEqual(verdicts.map((v) => v.allow), [true, true, false]);
  assert.deepEqual(verdicts.map((v) => v.reason), ['pooled_slot', 'pooled_slot', 'pooled_no_slot']);
});

test('pool: an over-budget PR closed, or merged before today, leaves the pool', () => {
  const y = day('2026-11-23', 23);
  y[20].state = 'MERGED'; y[20].mergedAt = '2026-11-23T23:00:00Z';
  const prs = [...y, ...day(TODAY, 19)];
  const v = budgetVerdict({ prs, pr: y[21], nowIso: NOW });
  assert.equal(v.poolPosition, 1); assert.equal(v.slots, 1); assert.equal(v.allow, true);
});

test('pool: a pooled PR merged TODAY keeps its place and its slot, so the pool cannot drain past the slots in one day', () => {
  const y = day('2026-11-23', 23); // ranks 21, 22, 23 pooled
  y[20].state = 'MERGED'; y[20].mergedAt = `${TODAY}T01:00:00Z`;
  const prs = [...y, ...day(TODAY, 19)]; // 1 free slot today, already used by y[20]
  const v = budgetVerdict({ prs, pr: y[21], nowIso: NOW });
  assert.equal(v.poolPosition, 2); assert.equal(v.slots, 1); assert.equal(v.allow, false); assert.equal(v.reason, 'pooled_no_slot');
});

test('windowStartDay: always 3 days before min(day, today-14), today included (SO A: today needs the pool window)', () => {
  assert.equal(windowStartDay(TODAY, TODAY), '2026-11-07');
  assert.equal(windowStartDay('2026-11-23', TODAY), '2026-11-07');
  assert.equal(windowStartDay('2026-11-01', TODAY), '2026-10-29');
});

// ── exemption ────────────────────────────────────────────────────────────────────────────────

const HEAD = 'a'.repeat(40);
const review = (over = {}) => ({ id: 77, user: { login: REVIEWER_APP_REST_LOGIN }, state: 'APPROVED', commit_id: HEAD, body: 'Approved (Tech Lead): budget-exempt: main is broken, this is the fix', ...over });

test('exemption: a TL or Security App approval at the head with a reason is valid', () => {
  assert.deepEqual(exemptionVerdict({ review: review(), headSha: HEAD }), { valid: true, role: 'Tech Lead', reason: 'main is broken, this is the fix' });
  assert.equal(exemptionVerdict({ review: review({ body: 'Approved (Security): budget-exempt: CVE fix' }), headSha: HEAD }).role, 'Security');
});

test('exemption: wrong head, wrong role, missing reason, not the App, not APPROVED, unreadable are all invalid', () => {
  const cases = {
    'wrong head': [review({ commit_id: 'b'.repeat(40) }), /not the current head/],
    'wrong role': [review({ body: 'Approved (Quality): budget-exempt: ok' }), /does not start with/],
    'no budget-exempt tag': [review({ body: 'Approved (Tech Lead): looks good' }), /does not start with/],
    'missing reason': [review({ body: 'Approved (Tech Lead): budget-exempt:   ' }), /no reason/],
    'not the App': [review({ user: { login: 'jpsnover' } }), /not the reviewer App/],
    'not APPROVED': [review({ state: 'COMMENTED' }), /not APPROVED/],
    unreadable: [null, /could not be read/],
  };
  for (const [name, [r, re]] of Object.entries(cases)) {
    const v = exemptionVerdict({ review: r, headSha: HEAD });
    assert.equal(v.valid, false, name); assert.match(v.detail, re, name);
  }
});

// ── the gh shim, with a fake gh ──────────────────────────────────────────────────────────────

/** A fake `gh` that serves the PR read, GraphQL search (by created range, 100 a page) and reviews. */
function fakeGh(all, { subject, reviewBody = null, failPr = false, failSearch = false, dropOne = false } = {}) {
  const calls = [];
  const fn = (args) => {
    calls.push(args);
    const j = args.join(' ');
    if (j.includes('pullRequest(number:$number)')) {
      if (failPr) throw new Error('gh: HTTP 502');
      return JSON.stringify({ data: { repository: { pullRequest: { ...subject, author: { login: subject.author } } } } });
    }
    if (j.includes('search(query:$q')) {
      if (failSearch) throw new Error('gh: HTTP 403 secondary rate limit');
      const q = args.find((a) => a.startsWith('q=')).slice(2);
      const [, a, b] = /created:(\S+)\.\.(\S+)/.exec(q);
      const hits = all.filter((p) => p.createdAt >= a && p.createdAt <= b).sort((x, y) => x.number - y.number);
      const after = Number(args.find((x) => x.startsWith('after='))?.slice(6) ?? 0);
      const listed = dropOne ? hits.slice(1) : hits;
      const nodes = listed.slice(after, after + 100).map((p) => ({ ...p, author: { login: p.author } }));
      return JSON.stringify({ data: { search: { issueCount: hits.length, pageInfo: { hasNextPage: after + 100 < listed.length, endCursor: String(after + 100) }, nodes } } });
    }
    if (/\/reviews\/\d+$/.test(j)) {
      if (!reviewBody) throw new Error('gh: Not Found (HTTP 404)');
      return JSON.stringify(reviewBody);
    }
    throw new Error(`fakeGh: unexpected call ${j}`);
  };
  fn.calls = calls;
  return fn;
}
const NOW_MS = Date.parse(NOW);
const quiet = { log: () => {}, warn: () => {} };

test('checkPrBudget: counts over a paginated search and refuses rank 21 (2 search pages + 1 PR read)', () => {
  const prs = [...day('2026-11-21', 40), ...day(TODAY, 21)];
  const subject = prs.at(-1);
  const g = fakeGh(prs, { subject });
  const v = checkPrBudget('o/r', subject.number, { gh: g, now: NOW_MS, ...quiet });
  assert.equal(v.reason, 'over_budget_today'); assert.equal(v.rank, 21); assert.equal(v.calls, 2);
  assert.equal(g.calls.length, 2);
  const many = [...day('2026-11-21', 150), ...day(TODAY, 5)];
  const g2 = fakeGh(many, { subject: many.at(-1) });
  const v2 = checkPrBudget('o/r', many.at(-1).number, { gh: g2, now: NOW_MS, ...quiet });
  assert.equal(v2.allow, true); assert.equal(v2.calls, 3); assert.equal(v2.budget, 20); // hard 20 whatever the mean (150/3)
});

test('checkPrBudget: Dependabot costs one PR read and always passes', () => {
  const subject = mk(at(TODAY, 900), { author: 'dependabot' });
  const g = fakeGh([...day(TODAY, 50), subject], { subject });
  const v = checkPrBudget('o/r', subject.number, { gh: g, now: NOW_MS, ...quiet });
  assert.equal(v.allow, true); assert.equal(v.reason, 'dependabot'); assert.equal(g.calls.length, 1);
});

test('checkPrBudget: an unreadable PR, a failed search, or an incomplete listing refuses (budget_read_failed)', () => {
  const prs = day(TODAY, 3);
  const warns = [];
  for (const opt of [{ failPr: true }, { failSearch: true }, { dropOne: true }]) {
    const v = checkPrBudget('o/r', prs[0].number, { gh: fakeGh(prs, { subject: prs[0], ...opt }), now: NOW_MS, log: () => {}, warn: (m) => warns.push(m) });
    assert.equal(v.allow, false, JSON.stringify(opt)); assert.equal(v.reason, 'budget_read_failed');
    assert.match(budgetRefusalMessage({ repo: 'o/r', prNumber: 1, verdict: v }), /Goal:[\s\S]*Problem:[\s\S]*Location:[\s\S]*Next steps:/);
  }
  assert.equal(warns.length, 3);
  assert.ok(warns.every((w) => w.startsWith('WARN:')));
});

test('fetchPrsCreated: a range over the search cap is split until each part fits; a 1-minute overflow refuses', () => {
  const prs = Array.from({ length: SEARCH_CAP + 50 }, (_, i) => mk(new Date(Date.parse(`${TODAY}T00:00:00Z`) + i * 30_000).toISOString().replace(/\.\d{3}Z$/, 'Z')));
  const g = fakeGh(prs, { subject: prs[0] });
  const out = fetchPrsCreated('o/r', Date.parse(`${TODAY}T00:00:00Z`), NOW_MS, g);
  assert.equal(out.prs.length, prs.length);
  const crowded = Array.from({ length: SEARCH_CAP + 1 }, () => mk(`${TODAY}T01:00:00Z`));
  assert.throws(() => fetchPrsCreated('o/r', Date.parse(`${TODAY}T01:00:00Z`), Date.parse(`${TODAY}T01:00:30Z`), fakeGh(crowded, { subject: crowded[0] })), /more than 1000/);
});

test('checkPrBudget: a valid exemption allows past budget and logs one BUDGET-EXEMPT line', () => {
  const prs = day(TODAY, 25);
  const subject = { ...prs.at(-1), headRefOid: HEAD };
  const lines = [];
  const g = fakeGh(prs, { subject, reviewBody: review() });
  const v = checkPrBudget('o/r', subject.number, { gh: g, now: NOW_MS, exemptReviewId: '77', by: 'devops-worker', log: (m) => lines.push(m), warn: () => {} });
  assert.equal(v.allow, true); assert.equal(v.reason, 'budget_exempt');
  assert.equal(lines.length, 1);
  assert.match(lines[0], new RegExp(`^BUDGET-EXEMPT repo=o/r pr=${subject.number} head=${HEAD} review=77 approver="Tech Lead" by=devops-worker reason="main is broken, this is the fix" at=2026-11-24T18:00:00.000Z$`));
});

test('checkPrBudget: an invalid or unreadable exemption, or one without --by, refuses (budget_exempt_invalid)', () => {
  const prs = day(TODAY, 2);
  const subject = { ...prs[0], headRefOid: HEAD };
  for (const [opts, re] of [
    [{ reviewBody: review({ commit_id: 'c'.repeat(40) }), by: 'x' }, /not the current head/],
    [{ reviewBody: null, by: 'x' }, /could not be read/],
    [{ reviewBody: review(), by: null }, /without --by/],
  ]) {
    const v = checkPrBudget('o/r', subject.number, { gh: fakeGh(prs, { subject, reviewBody: opts.reviewBody }), now: NOW_MS, exemptReviewId: '77', by: opts.by, ...quiet });
    assert.equal(v.allow, false); assert.equal(v.reason, 'budget_exempt_invalid'); assert.match(v.detail, re);
  }
});

test('budgetRefusalMessage: names the day, units, budget, 3-day mean, rank or pool position and the next UTC day', () => {
  const prs = [...day('2026-11-23', 23), ...day(TODAY, 20)];
  const pooled = budgetVerdict({ prs, pr: prs[22], nowIso: NOW });
  const t21 = day(TODAY, 21);
  const m1 = budgetRefusalMessage({ repo: 'o/r', prNumber: 5, verdict: budgetVerdict({ prs: t21, pr: t21.at(-1), nowIso: NOW }) });
  assert.match(m1, /over_budget_today[\s\S]*ranks 21[\s\S]*budget of 20[\s\S]*Today \(2026-11-24 UTC\): 21 unit\(s\) counted, budget 20, 3-day mean 0\.00/);
  assert.match(m1, /starts 2026-11-25T00:00:00Z[\s\S]*budget-exempt: <reason>[\s\S]*--budget-exempt-review=/);
  const m2 = budgetRefusalMessage({ repo: 'o/r', prNumber: 5, verdict: pooled });
  assert.match(m2, /pooled_no_slot[\s\S]*2026-11-23 \(rank 23 of 20\)[\s\S]*position 3 of 3, with 0 free slot/);
});


test('resolvePrOwner: title/branch ticket, then body ticket, then file majority (my-prs order); human never returned', async () => {
  const tickets = { 't/40': { assignee: { id: 'agent-a', kind: 'agent' } }, 't/41': { assignee: { id: 'human', kind: 'human' } }, 't/50': { assignee: { id: 'agent-b', kind: 'agent' } } };
  const appRun = async (app, cmd, args) => {
    if (app === 'tickets') { if (!tickets[args.id]) throw new Error('not found'); return tickets[args.id]; }
    if (app === 'org-chart') return { collaborator: { id: args.path.includes('server') ? 'agent-s' : 'agent-r' } };
    throw new Error('unexpected');
  };
  const g = () => 'server/a.ts\nserver/b.ts\nrenderer/c.ts\n';
  const deps = { appRun, gh: g, repo: 'o/r', checkoutRoot: () => '/repo', warn: () => {} };
  assert.equal((await resolvePrOwner({ number: 1, title: 'feat(t/40): x', body: 'see t/50', headRefName: 'b' }, deps)).id, 'agent-a');
  assert.equal((await resolvePrOwner({ number: 2, title: 'x', body: 'fixes t/50', headRefName: 'b' }, deps)).id, 'agent-b');
  assert.equal((await resolvePrOwner({ number: 3, title: 'x', body: '', headRefName: 'b' }, deps)).id, 'agent-s');
  assert.equal((await resolvePrOwner({ number: 4, title: 't/41: x', body: 'see t/50', headRefName: 'b' }, deps)).id, null);
});

// ── Second Opinion on #5473 (A, B, C) ────────────────────────────────────────────────────────

test('SO A: pooled units merged today come off today\'s budget (10 pooled merges + 20 new must not land 30)', () => {
  const y = day('2026-11-23', 30); // ranks 21..30 pooled
  for (const p of y.slice(20)) { p.state = 'MERGED'; p.mergedAt = `${TODAY}T01:00:00Z`; }
  const t = day(TODAY, 20, 120);
  const prs = [...y, ...t];
  const tenth = budgetVerdict({ prs, pr: t[9], nowIso: NOW });
  assert.equal(tenth.pooledMergedToday, 10); assert.equal(tenth.allow, true); // rank 10 + 10 = 20
  const eleventh = budgetVerdict({ prs, pr: t[10], nowIso: NOW });
  assert.equal(eleventh.allow, false); assert.equal(eleventh.reason, 'over_budget_today');
  const twentieth = budgetVerdict({ prs, pr: t[19], nowIso: NOW });
  assert.equal(twentieth.allow, false); // the reproduced case: rank 20 + 10 pooled landings > 20
  // Pooled units merged on an earlier day do not count against today.
  for (const p of y.slice(20)) p.mergedAt = '2026-11-23T23:00:00Z';
  assert.equal(budgetVerdict({ prs, pr: t[19], nowIso: NOW }).allow, true);
});

test('SO B: an over-budget PR older than the pool window is refused (pool_expired); a within-budget one is still allowed', () => {
  const old = day('2026-11-05', 22); // 19 days before TODAY, ranks 21 and 22 over budget
  const prs = [...old, ...day(TODAY, 1)];
  const v = budgetVerdict({ prs, pr: old[21], nowIso: NOW });
  assert.equal(v.allow, false); assert.equal(v.reason, 'pool_expired');
  assert.match(budgetRefusalMessage({ repo: 'o/r', prNumber: old[21].number, verdict: v }), /left the carryover pool[\s\S]*budget-exempt/);
  assert.equal(budgetVerdict({ prs, pr: old[5], nowIso: NOW }).reason, 'within_budget_earlier_day');
});


// ── TL p/9#565: an accidental open, closed unmerged within 1 h with no later commit, is not counted ──

test('isAccidentalClose: closed unmerged within 1 h with no commit after opening -> true; every other case -> false', () => {
  const base = mk(at(TODAY, 0));
  const close = (min, over = {}) => ({ ...base, state: 'CLOSED', closedAt: at(TODAY, min), ...over });
  assert.equal(isAccidentalClose(close(5)), true);
  assert.equal(isAccidentalClose(close(60)), true); // exactly 1 h
  assert.equal(isAccidentalClose(close(61)), false); // closed after the window still counts
  assert.equal(isAccidentalClose(close(5, { lastCommitAt: at(TODAY, 2) })), false); // a commit after opening
  assert.equal(isAccidentalClose(close(5, { lastCommitAt: at(TODAY, -30) })), true); // the commit predates opening
  assert.equal(isAccidentalClose(close(5, { state: 'MERGED', mergedAt: at(TODAY, 5) })), false);
  assert.equal(isAccidentalClose({ ...base, state: 'OPEN' }), false);
  assert.equal(isAccidentalClose(close(5, { closedAt: null })), false);
});

test('an accidental open does not take a budget slot; a PR closed after the window still does', () => {
  const t = day(TODAY, 21);
  for (const p of t.slice(0, 3)) { p.state = 'CLOSED'; p.closedAt = at(TODAY, 30); } // 3 clicks closed in 30 min
  const v = budgetVerdict({ prs: t, pr: t[20], nowIso: NOW });
  assert.equal(v.rank, 18); assert.equal(v.units, 18); assert.equal(v.allow, true);
  t[0].closedAt = at(TODAY, 200); // closed after 3 h: counts again
  assert.equal(budgetVerdict({ prs: t, pr: t[20], nowIso: NOW }).rank, 19);
});

