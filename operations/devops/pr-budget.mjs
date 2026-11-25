// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/564 phase A: the team PR budget, enforced at enqueue time (docs/pr-landing.md § PR Budget).
//
// RULE (TL-agreed spec, t/564). Times are UTC days. Repo-wide, base any.
//   UNIT     Every non-Dependabot PR is one unit, except that all PRs from one branch matching
//            ONE_UNIT_BRANCH_PATTERNS created on the same UTC day are ONE unit (key = branch).
//   BUDGET   budget(D) = 15 if the mean unit count of the three complete UTC days before D is > 25,
//            else 20.
//   RANK     rank on day D = 1 + the number of distinct units created on D strictly before this PR's
//            unit was (a one-unit branch: its first PR that day). Allowed on D iff rank <= budget(D).
//   POOL     A PR from an earlier day that was over its day's budget waits in a FIFO pool (open,
//            over-budget units from the last POOL_DAYS days, oldest first). Today it may enqueue iff
//            its pool position <= max(0, budget(today) - units(today)). A PR from an earlier day that
//            was within its day's budget is always allowed.
//   EXEMPT   A reviewer-App APPROVED review at the PR's head with a body starting
//            `Approved (Tech Lead): budget-exempt: <reason>` or `Approved (Security): budget-exempt: <reason>`,
//            named with --budget-exempt-review=<id> --by=<collaborator id>. Logged as BUDGET-EXEMPT.
//   DEPENDABOT PRs are neither counted nor checked.
//   FAIL CLOSED: any unreadable PR, search page or count is a refusal (budget_read_failed).
//
// Pure core: unitKey, buildUnits, rankOf, budgetFor, poolOf, budgetVerdict, exemptionVerdict and the
// message builders. Impure shim (gh injectable): readPrFacts, fetchPrsCreated, checkPrBudget.
// In GATE_SCRIPTS (gate-file-change.mjs): a PR that edits this file needs a TL/Security review.
//
// GitHub cost per enqueue (non-Dependabot): 1 GraphQL PR read + 1 GraphQL search per 100 PRs in the
// window (window = 3 days before the PR's creation day through now, or, for a PR from an earlier day,
// 3 days before min(its day, today - POOL_DAYS) through now). A window holding more than the search
// cap (1000) is split in half until each part fits. Dependabot: the PR read only. +1 REST call to read
// a named exemption review.

import { execFileSync } from 'node:child_process';
import { REVIEWER_APP_REST_LOGIN } from './gate-file-change.mjs';

// t/567 (TL, PI-approved; replaces t/564's provisional TRAIN_BRANCH_PREFIXES): branches whose PRs
// count as ONE unit per UTC day, however many PRs the branch opens that day.
export const ONE_UNIT_BRANCH_PATTERNS = Object.freeze([
  /^feat\/t\d+-[a-z0-9][a-z0-9-]*$/, // feature PRs: feat/t<N>-<slug>
  /^train\/(devops|server|renderer|debate)-\d{8}$/, // area trains: train/<area>-YYYYMMDD
  /^docs\/weekly-\d{4}-\d{2}$/, // the weekly docs train: docs/weekly-YYYY-WW
]);

export const BUDGET_NORMAL = 20;
export const BUDGET_HARD = 15;
export const HARD_MEAN_THRESHOLD = 25; // mean strictly above this -> BUDGET_HARD
export const POOL_DAYS = 14;
export const SEARCH_CAP = 1000;
export const BUDGET_APPROVER_ROLES = ['Tech Lead', 'Security'];
export const REFUSAL_REASONS = Object.freeze(['over_budget_today', 'pooled_no_slot', 'budget_read_failed', 'budget_exempt_invalid']);

const DAY_MS = 86_400_000;

// ── pure ──────────────────────────────────────────────────────────────────────────────────────

/** PURE. Dependabot as GraphQL (`dependabot`), REST (`dependabot[bot]`) or gh (`app/dependabot`) reports it. */
export const isDependabotAuthor = (login) => /^(app\/)?dependabot(\[bot\])?$/i.test(String(login ?? ''));

export const isOneUnitBranch = (branch) => ONE_UNIT_BRANCH_PATTERNS.some((re) => re.test(String(branch ?? '')));

/** PURE. 'YYYY-MM-DD' (UTC) of an ISO time, or null if unparseable. */
export function utcDay(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}

export const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
export const nextDayStart = (day) => `${addDays(day, 1)}T00:00:00Z`;

/** PURE. The unit a PR counts in: `<day>|branch:<name>` for a one-unit branch, else `<day>|pr:<n>`. */
export function unitKey(pr) {
  const day = utcDay(pr.createdAt);
  return isOneUnitBranch(pr.headRefName) ? `${day}|branch:${pr.headRefName}` : `${day}|pr:${pr.number}`;
}

/**
 * PURE. Groups non-Dependabot PRs into units. Returns { byDay: Map<day, unit[]>, unitOf: Map<prNumber, unit> },
 * unit = { key, day, first (ms of its first PR), prs: [pr...] }; each day's list sorted by first.
 * Throws on a PR with an unparseable createdAt (callers treat that as unreadable).
 */
export function buildUnits(prs) {
  const units = new Map();
  for (const pr of prs) {
    if (isDependabotAuthor(pr.author)) continue;
    const t = Date.parse(pr.createdAt);
    if (!Number.isFinite(t)) throw new Error(`#${pr.number} has an unreadable createdAt (${JSON.stringify(pr.createdAt)})`);
    const key = unitKey(pr);
    let u = units.get(key);
    if (!u) units.set(key, (u = { key, day: utcDay(pr.createdAt), first: t, prs: [] }));
    if (!u.prs.some((p) => p.number === pr.number)) u.prs.push(pr);
    u.first = Math.min(u.first, t);
  }
  const byDay = new Map();
  const unitOf = new Map();
  for (const u of units.values()) {
    if (!byDay.has(u.day)) byDay.set(u.day, []);
    byDay.get(u.day).push(u);
    for (const p of u.prs) unitOf.set(p.number, u);
  }
  for (const list of byDay.values()) list.sort((a, b) => a.first - b.first || a.key.localeCompare(b.key));
  return { byDay, unitOf };
}

export const unitCount = (byDay, day) => byDay.get(day)?.length ?? 0;

/** PURE. 1 + the number of units on the unit's day created strictly before it. */
export const rankOf = (byDay, unit) => 1 + (byDay.get(unit.day) ?? []).filter((u) => u.first < unit.first).length;

/** PURE. { budget, mean, counts: [D-1, D-2, D-3] } for day D. */
export function budgetFor(byDay, day) {
  const counts = [1, 2, 3].map((i) => unitCount(byDay, addDays(day, -i)));
  const mean = (counts[0] + counts[1] + counts[2]) / 3;
  return { budget: mean > HARD_MEAN_THRESHOLD ? BUDGET_HARD : BUDGET_NORMAL, mean, counts };
}

/**
 * PURE. The FIFO pool on `today`: units created on days [fromDay, today - 1] whose rank exceeded their
 * day's budget and that still hold an OPEN PR, or a PR MERGED today, oldest first. A unit that merged
 * today keeps its place and its slot (DevOps Lead, t/564): without it, each merge would move the rest
 * of the pool up and the whole pool could drain in one day past `slots`. `alsoOpen`: PR numbers to treat as open
 * (the PR being enqueued). Returns [{ unit, rank, budget, position }].
 */
export function poolOf(byDay, today, fromDay, { alsoOpen = [] } = {}) {
  const pooled = [];
  for (let d = fromDay; d < today; d = addDays(d, 1)) {
    const { budget } = budgetFor(byDay, d);
    for (const u of byDay.get(d) ?? []) {
      const rank = rankOf(byDay, u);
      if (rank <= budget) continue;
      if (!u.prs.some((p) => p.state === 'OPEN' || alsoOpen.includes(p.number) || (p.mergedAt && utcDay(p.mergedAt) === today))) continue;
      pooled.push({ unit: u, rank, budget });
    }
  }
  pooled.sort((a, b) => a.unit.first - b.unit.first || a.unit.key.localeCompare(b.unit.key));
  return pooled.map((p, i) => ({ ...p, position: i + 1 }));
}

/**
 * PURE. The budget decision for `pr` ({ number, createdAt, headRefName, author, state }) given every PR
 * created in the window (see the header) and `nowIso`. Returns
 *   { allow, reason, day, today, units, budget, mean, counts, rank, dayBudget?, poolPosition?, slots?, nextDayStart }
 * reasons: allow 'dependabot' | 'within_budget_today' | 'within_budget_earlier_day' | 'pooled_slot';
 *          refuse 'over_budget_today' | 'pooled_no_slot' | 'budget_read_failed'.
 */
export function budgetVerdict({ prs, pr, nowIso, poolDays = POOL_DAYS }) {
  const today = utcDay(nowIso);
  const base = { today, nextDayStart: today ? nextDayStart(today) : null };
  if (isDependabotAuthor(pr.author)) return { ...base, allow: true, reason: 'dependabot' };
  const day = utcDay(pr.createdAt);
  if (!today || !day) return { ...base, allow: false, reason: 'budget_read_failed', detail: `unreadable time (createdAt ${JSON.stringify(pr.createdAt)}, now ${JSON.stringify(nowIso)})` };
  if (day > today) return { ...base, allow: false, reason: 'budget_read_failed', detail: `#${pr.number} was created ${pr.createdAt}, after now (${nowIso}); clock skew` };
  let built;
  try {
    built = buildUnits([...prs.filter((p) => p.number !== pr.number), pr]);
  } catch (err) {
    return { ...base, allow: false, reason: 'budget_read_failed', detail: err.message };
  }
  const { byDay, unitOf } = built;
  const unit = unitOf.get(pr.number);
  const rank = rankOf(byDay, unit);
  const dayB = budgetFor(byDay, day);
  const todayB = budgetFor(byDay, today);
  const out = { ...base, day, units: unitCount(byDay, today), budget: todayB.budget, mean: todayB.mean, counts: todayB.counts, rank, unitKey: unit.key };
  if (day === today) {
    return { ...out, allow: rank <= todayB.budget, reason: rank <= todayB.budget ? 'within_budget_today' : 'over_budget_today' };
  }
  out.dayBudget = dayB.budget;
  out.dayUnits = unitCount(byDay, day);
  out.dayMean = dayB.mean;
  if (rank <= dayB.budget) return { ...out, allow: true, reason: 'within_budget_earlier_day' };
  const fromDay = day < addDays(today, -poolDays) ? day : addDays(today, -poolDays);
  const pool = poolOf(byDay, today, fromDay, { alsoOpen: [pr.number] });
  const entry = pool.find((p) => p.unit === unit);
  const slots = Math.max(0, todayB.budget - out.units);
  const poolPosition = entry?.position ?? null;
  const allow = poolPosition != null && poolPosition <= slots;
  return { ...out, poolPosition, poolSize: pool.length, slots, allow, reason: allow ? 'pooled_slot' : 'pooled_no_slot' };
}

/**
 * PURE. Whether a review releases the PR from the budget. `review` is the REST review object (or null
 * when unreadable). Returns { valid, role?, reason?, detail? }.
 */
export function exemptionVerdict({ review, headSha, reviewerLogin = REVIEWER_APP_REST_LOGIN }) {
  if (!review || typeof review !== 'object') return { valid: false, detail: 'the named review could not be read' };
  const why = [];
  if (review.user?.login !== reviewerLogin) why.push(`it is from ${review.user?.login ?? 'an unknown account'}, not the reviewer App`);
  if (review.state !== 'APPROVED') why.push(`its state is ${review.state ?? 'unknown'}, not APPROVED`);
  if (!headSha || review.commit_id !== headSha) why.push(`it is bound to ${String(review.commit_id).slice(0, 9)}, not the current head ${String(headSha).slice(0, 9)}`);
  const m = /^Approved \(([^)]+)\): budget-exempt:([\s\S]*)$/.exec(String(review.body ?? '').trimStart());
  const role = m?.[1] ?? null;
  const reason = (m?.[2] ?? '').trim().split('\n')[0].trim();
  if (!m || !BUDGET_APPROVER_ROLES.includes(role)) {
    why.push(`its body does not start with "Approved (${BUDGET_APPROVER_ROLES.join('): budget-exempt:" or "Approved (')}): budget-exempt:"`);
  } else if (!reason) {
    why.push('it gives no reason after "budget-exempt:"');
  }
  if (why.length) return { valid: false, detail: why.join('; ') };
  return { valid: true, role, reason };
}

/** PURE. The BUDGET-EXEMPT audit line. */
export function exemptLogLine({ repo, prNumber, headSha, reviewId, role, by, reason, at }) {
  const q = (s) => String(s).replace(/"/g, "'");
  return `BUDGET-EXEMPT repo=${repo} pr=${prNumber} head=${headSha} review=${reviewId} approver="${q(role)}" by=${by} reason="${q(reason)}" at=${at}`;
}

const fmtMean = (m) => (Number.isFinite(m) ? m.toFixed(2) : 'unknown');

/** PURE. One line for an allowed, non-exempt verdict. */
export function budgetOkLine({ repo, prNumber, verdict: v }) {
  if (v.reason === 'dependabot') return `enqueue-pr: PR budget: #${prNumber} on ${repo} is a Dependabot PR (not counted, not checked).`;
  const where = v.reason === 'within_budget_today' ? `rank ${v.rank} of budget ${v.budget} today (${v.today})`
    : v.reason === 'within_budget_earlier_day' ? `rank ${v.rank} of budget ${v.dayBudget} on its day ${v.day}`
      : `pool position ${v.poolPosition} of ${v.slots} free slot(s) today (${v.today})`;
  return `enqueue-pr: PR budget ok for #${prNumber} on ${repo}: ${where}; ${v.units} unit(s) today, 3-day mean ${fmtMean(v.mean)}.`;
}

/** PURE. The ActionableError text for a budget refusal (Goal / Problem / Location / Next steps). */
export function budgetRefusalMessage({ repo, prNumber, verdict: v }) {
  const facts = `Today (${v.today ?? 'unknown'} UTC): ${v.units ?? 'unknown'} unit(s) counted, budget ${v.budget ?? 'unknown'}, ` +
    `3-day mean ${fmtMean(v.mean)}${v.counts ? ` (${v.counts.join(', ')})` : ''}.`;
  const problem = {
    over_budget_today: `#${prNumber} ranks ${v.rank} among today's units, over today's budget of ${v.budget}. ${facts}`,
    pooled_no_slot: `#${prNumber} was over budget on its creation day ${v.day} (rank ${v.rank} of ${v.dayBudget}), so it waits in the carryover pool: ` +
      `position ${v.poolPosition ?? 'unknown'} of ${v.poolSize ?? 'unknown'}, with ${v.slots ?? 0} free slot(s) today. ${facts}`,
    budget_read_failed: `could not read what the budget needs (${v.detail ?? 'unknown error'}). An unreadable count is a refusal, not a pass.`,
    budget_exempt_invalid: `the named budget-exempt review does not release #${prNumber}: ${v.detail ?? 'unknown'}.`,
  }[v.reason] ?? `unexpected budget verdict ${JSON.stringify(v.reason)}.`;
  const steps = v.reason === 'budget_read_failed'
    ? 'check `gh auth status` and the API rate limit, then rerun.'
    : `wait for the next UTC day (starts ${v.nextDayStart ?? 'at 00:00Z'}) and rerun, or get a Tech Lead or Security reviewer-App approval at the PR head ` +
      'with a body starting "Approved (Tech Lead): budget-exempt: <reason>" or "Approved (Security): budget-exempt: <reason>", ' +
      'then rerun with --budget-exempt-review=<that review\'s id> --by=<your collaborator id>.';
  return `enqueue-pr: refusing to arm/enqueue #${prNumber} on ${repo} (${v.reason}).\n` +
    `  Goal:       land #${prNumber} within the team PR budget (docs/pr-landing.md § PR Budget, t/564).\n` +
    `  Problem:    ${problem}\n` +
    '  Location:   operations/devops/pr-budget.mjs (budgetVerdict, t/564).\n' +
    `  Next steps: ${steps}`;
}

// ── impure (gh injectable) ────────────────────────────────────────────────────────────────────

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

const PR_FIELDS = 'number title createdAt mergedAt headRefName state author{login}';

/** One PR's facts over GraphQL. Throws on any failure or a missing PR. */
export function readPrFacts(repo, prNumber, ghFn = gh) {
  const [owner, name] = repo.split('/');
  const query = 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){' +
    `pullRequest(number:$number){${PR_FIELDS} body headRefOid}}}`;
  const p = JSON.parse(ghFn(['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${prNumber}`]))?.data?.repository?.pullRequest;
  if (!p || p.number !== prNumber) throw new Error(`#${prNumber} was not returned`);
  return toPr(p);
}

const toPr = (p) => ({ number: p.number, title: p.title ?? '', body: p.body ?? '', createdAt: p.createdAt, headRefName: p.headRefName ?? '', headRefOid: p.headRefOid ?? null, state: p.state, mergedAt: p.mergedAt ?? null, author: p.author?.login ?? '' });
const isoSec = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * Every PR (any state, Dependabot included) created in [startMs, endMs] (whole seconds, inclusive),
 * via GraphQL search. A range over the search cap is split in half. Throws on any failure, an
 * incomplete page set, or a cap overflow in a range of one minute or less (fail closed).
 * Returns { prs, calls }.
 */
export function fetchPrsCreated(repo, startMs, endMs, ghFn = gh) {
  const query = 'query($q:String!,$after:String){search(query:$q,type:ISSUE,first:100,after:$after){' +
    `issueCount pageInfo{hasNextPage endCursor} nodes{... on PullRequest{${PR_FIELDS}}}}}`;
  let calls = 0;
  const page = (q, after) => {
    calls++;
    const args = ['api', 'graphql', '-f', `query=${query}`, '-f', `q=${q}`];
    if (after) args.push('-f', `after=${after}`);
    const s = JSON.parse(ghFn(args))?.data?.search;
    if (!s || !Number.isInteger(s.issueCount) || !Array.isArray(s.nodes) || !s.pageInfo) throw new Error(`search returned no result for "${q}"`);
    return s;
  };
  const range = (a, b) => {
    const q = `repo:${repo} is:pr created:${isoSec(a)}..${isoSec(b)}`;
    let s = page(q, null);
    if (s.issueCount > SEARCH_CAP) {
      if (b - a <= 60_000) throw new Error(`more than ${SEARCH_CAP} PRs created in ${isoSec(a)}..${isoSec(b)}; search cannot list them all`);
      const mid = a + Math.floor((b - a) / 2000) * 1000;
      return [...range(a, mid), ...range(mid + 1000, b)];
    }
    const out = new Map();
    for (;;) {
      for (const n of s.nodes) if (n && Number.isInteger(n.number)) out.set(n.number, toPr(n));
      if (!s.pageInfo.hasNextPage) break;
      s = page(q, s.pageInfo.endCursor);
    }
    if (out.size !== s.issueCount) throw new Error(`search for ${isoSec(a)}..${isoSec(b)} listed ${out.size} PRs but reports ${s.issueCount}`);
    return [...out.values()];
  };
  const prs = range(Math.floor(startMs / 1000) * 1000, Math.floor(endMs / 1000) * 1000);
  return { prs, calls };
}

/** Reads one review by id (REST). Never throws: { review, error }. */
export function fetchExemptReview(repo, prNumber, reviewId, ghFn = gh) {
  if (!/^[1-9]\d{0,18}$/.test(String(reviewId))) return { review: null, error: new Error('the review id is not a number') };
  try {
    return { review: JSON.parse(ghFn(['api', `repos/${repo}/pulls/${prNumber}/reviews/${reviewId}`])), error: null };
  } catch (err) {
    return { review: null, error: err };
  }
}

/** The first day of the search window for a PR created on `day`, checked on `today`. */
export function windowStartDay(day, today, poolDays = POOL_DAYS) {
  const from = day === today ? day : (day < addDays(today, -poolDays) ? day : addDays(today, -poolDays));
  return addDays(from, -3);
}

/**
 * The budget check enqueuePR runs. Never throws. Returns the verdict (see budgetVerdict) plus
 * { pr, calls, exempt? }; refusals carry reason 'budget_read_failed' or 'budget_exempt_invalid' too.
 * `exemptReviewId`/`by`: the --budget-exempt-review / --by flags. `now`: injectable clock (ms).
 */
export function checkPrBudget(repo, prNumber, { gh: ghFn = gh, exemptReviewId = null, by = null, now = Date.now(), log = console.log, warn = console.warn } = {}) {
  const nowIso = new Date(now).toISOString();
  const today = utcDay(nowIso);
  const fail = (reason, detail, extra = {}) => ({ allow: false, reason, detail, today, nextDayStart: nextDayStart(today), ...extra });
  let pr;
  try {
    pr = readPrFacts(repo, prNumber, ghFn);
  } catch (err) {
    warn(`WARN: enqueue-pr could not read #${prNumber} on ${repo} for the PR budget (${firstLine(err)}); refusing.`);
    return fail('budget_read_failed', `reading #${prNumber} failed: ${firstLine(err)}`, { calls: 1 });
  }
  if (isDependabotAuthor(pr.author)) return { allow: true, reason: 'dependabot', today, pr, calls: 1 };

  if (exemptReviewId != null) {
    if (!(typeof by === 'string' && by.trim())) return fail('budget_exempt_invalid', '--budget-exempt-review was given without --by, so the exemption cannot be attributed', { pr, calls: 1 });
    const { review, error } = fetchExemptReview(repo, prNumber, exemptReviewId, ghFn);
    if (error) warn(`WARN: enqueue-pr could not read review ${exemptReviewId} on #${prNumber} (${firstLine(error)}); refusing.`);
    const ev = exemptionVerdict({ review, headSha: pr.headRefOid });
    if (!ev.valid) return fail('budget_exempt_invalid', ev.detail, { pr, calls: 2 });
    log(exemptLogLine({ repo, prNumber, headSha: pr.headRefOid, reviewId: exemptReviewId, role: ev.role, by: by.trim(), reason: ev.reason, at: nowIso }));
    return { allow: true, reason: 'budget_exempt', exempt: ev, today, pr, calls: 2 };
  }

  const day = utcDay(pr.createdAt);
  if (!day) return fail('budget_read_failed', `#${prNumber} has an unreadable createdAt`, { pr, calls: 1 });
  let fetched;
  try {
    fetched = fetchPrsCreated(repo, Date.parse(`${windowStartDay(day, today)}T00:00:00Z`), now, ghFn);
  } catch (err) {
    warn(`WARN: enqueue-pr could not list the PRs the budget counts (${firstLine(err)}); refusing.`);
    return fail('budget_read_failed', `listing PRs created since ${windowStartDay(day, today)} failed: ${firstLine(err)}`, { pr, calls: 1 });
  }
  return { ...budgetVerdict({ prs: fetched.prs, pr, nowIso }), pr, calls: 1 + fetched.calls };
}

function firstLine(err) {
  return String(err?.stderr || err?.message || err).trim().split('\n')[0];
}
