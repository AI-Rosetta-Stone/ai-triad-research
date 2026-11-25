#!/usr/bin/env node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/564 phase A: the team PR budget, as enqueue-pr.mjs sees it right now (pr-budget.mjs).
// Prints today's units, budget and 3-day mean, today's over-budget PRs and the carryover pool, each
// with its owner (pr-budget-notify.mjs, my-prs.mjs's ownership). Read-only on GitHub.
//
// DRY-RUN BY DEFAULT: nothing is sent. With `--send --sender <id> --tl <id>` it pings the TL once with
// the report and each owner of an over-budget or pooled PR once (one message listing their PRs).
// `human` is never pinged. A failed send is a WARN; the rest still go.
// SOFT POINT (TL p/9#541): once today's units reach SOFT_POINT (15), nothing is refused, but the report
// is marked 'budget nearly used': the TL's message leads with it, and every owner of a PR opened today
// gets one heads-up (merged into their over-budget/pool message if they have one).
//
// GitHub cost: 1 GraphQL search per 100 PRs created in the last POOL_DAYS + 3 days (split if over the
// search cap), plus one REST file list per listed PR that cites no ticket (owner lookup).
//
// Usage: node operations/devops/pr-budget-report.mjs [--json] [--repo owner/name]
//          [--daemon http://127.0.0.1:7420] [--send --sender <collaborator id> --tl <collaborator id>]

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addDays, budgetFor, buildUnits, exemptionVerdict, fetchPrsCreated, isAccidentalClose, nextDayStart, poolOf, POOL_DAYS, rankOf, SOFT_POINT, unitCount, utcDay } from './pr-budget.mjs';
import { assertLoopback, DEFAULT_DAEMON, makeAppRun, resolvePrOwner } from './pr-budget-notify.mjs';

export function parseArgs(argv) {
  const o = { repo: 'AI-Rosetta-Stone/ai-triad-research', daemon: DEFAULT_DAEMON, json: false, send: false, sender: null, tl: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--send') o.send = true;
    else if (['--repo', '--daemon', '--sender', '--tl'].includes(a) && argv[i + 1]) o[a.slice(2)] = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  assertLoopback(o.daemon);
  if (o.send && (!o.sender || !o.tl)) throw new Error('--send needs --sender <collaborator id> and --tl <collaborator id>');
  return o;
}

/** PURE. Today's numbers, over-budget PRs and pool from every PR created in the window. */
export function analyze(prs, nowIso) {
  const today = utcDay(nowIso);
  const { byDay } = buildUnits(prs);
  const b = budgetFor(byDay, today);
  const units = unitCount(byDay, today);
  const overToday = [];
  for (const u of byDay.get(today) ?? []) {
    const rank = rankOf(byDay, u);
    if (rank > b.budget) for (const pr of u.prs) overToday.push({ pr, rank, unit: u.key });
  }
  const slots = Math.max(0, b.budget - units);
  const pool = [];
  for (const p of poolOf(byDay, today, addDays(today, -POOL_DAYS))) {
    for (const pr of p.unit.prs.filter((x) => x.state === 'OPEN')) pool.push({ pr, day: p.unit.day, rank: p.rank, dayBudget: p.budget, position: p.position, hasSlot: p.position <= slots, unit: p.unit.key });
  }
  const notCounted = prs.filter((pr) => utcDay(pr.createdAt) === today && isAccidentalClose(pr));
  const nearlyUsed = units >= SOFT_POINT;
  const todays = nearlyUsed ? (byDay.get(today) ?? []).flatMap((u) => u.prs.map((pr) => ({ pr, unit: u.key }))) : [];
  return { today, nextDayStart: nextDayStart(today), units, budget: b.budget, mean: b.mean, counts: b.counts, slots, overToday, pool, nearlyUsed, softPoint: SOFT_POINT, todays, notCounted };
}

/**
 * PURE (t/619). Splits today's over-budget list: a MERGED PR with a valid `budget-exempt:` review (the
 * same match enqueue-pr.mjs applies, exemptionVerdict: reviewer App, APPROVED, bound to the PR's head,
 * body `Approved (Tech Lead|Security): budget-exempt: <reason>`) is listed as exempt, with the review id
 * and approver. Open, closed-unmerged and non-exempt merged PRs stay over budget. `evidence` maps a PR
 * number to { headSha, reviews } or { error }; an unreadable one stays over, marked so.
 */
export function splitExempt(overToday, evidence) {
  const over = [];
  const exempt = [];
  for (const x of overToday) {
    const ev = x.pr.state === 'MERGED' ? evidence.get(x.pr.number) : undefined;
    if (!ev) { over.push(x); continue; }
    if (ev.error) { over.push({ ...x, exemptCheck: `unreadable (${ev.error})` }); continue; }
    let hit = null;
    for (const review of ev.reviews ?? []) {
      const v = exemptionVerdict({ review, headSha: ev.headSha });
      if (v.valid) { hit = { reviewId: review.id, approver: v.role, reason: v.reason }; break; }
    }
    if (hit) exempt.push({ ...x, ...hit }); else over.push(x);
  }
  return { over, exempt };
}

/** Impure (gh injectable). A merged PR's head SHA and reviews, for splitExempt. Never throws. */
export function fetchExemptEvidence(repo, prNumber, ghFn = ghCli) {
  try {
    const head = JSON.parse(ghFn(['api', `repos/${repo}/pulls/${prNumber}`, '--jq', '{sha: .head.sha}'])).sha;
    const reviews = JSON.parse(ghFn(['api', '--paginate', '--slurp', `repos/${repo}/pulls/${prNumber}/reviews`])).flat();
    return { headSha: head, reviews };
  } catch (e) {
    return { error: String(e?.message ?? e).split('\n')[0] };
  }
}

function ghCli(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

export function formatText(r) {
  const row = (x, extra) => `  #${x.pr.number} ${x.pr.title} [owner ${x.owner ?? 'unresolved'}] ${extra}`;
  const exempt = r.exempt ?? [];
  return [
    ...(r.nearlyUsed ? [`**Budget nearly used:** ${r.units} of ${r.budget} units today (soft point ${r.softPoint}); PRs past ${r.budget} are refused until ${r.nextDayStart}.`] : []),
    `PR budget ${r.today} (UTC): ${r.units} unit(s) today, budget ${r.budget}, 3-day mean ${r.mean.toFixed(2)} (${r.counts.join(', ')}); ${r.slots} free slot(s) for the pool; next day starts ${r.nextDayStart}.`,
    `Over budget today (${r.overToday.length}):`, ...(r.overToday.length ? r.overToday.map((x) => row(x, `rank ${x.rank}${x.exemptCheck ? `; exemption check ${x.exemptCheck}` : ''}`)) : ['  none']),
    // t/619: merged past the cap with a TL/Security budget-exempt review. Not violations, so not under 'Over budget'.
    `Exempt (${exempt.length}):`, ...(exempt.length ? exempt.map((x) => row(x, `rank ${x.rank}, merged with a budget-exempt review ${x.reviewId} (${x.approver})`)) : ['  none']),
    `Carryover pool (${r.pool.length} open PR(s)):`, ...(r.pool.length ? r.pool.map((x) => row(x, `from ${x.day}, rank ${x.rank}/${x.dayBudget}, position ${x.position}${x.hasSlot ? ' (may enqueue today)' : ''}`)) : ['  empty']),
    ...((r.notCounted ?? []).length ? [`Not counted: closed within 1 h (${r.notCounted.length}): ${r.notCounted.map((pr) => `#${pr.number}`).join(', ')}`] : []),
  ].join('\n');
}

/** PURE. The messages a --send run sends: one to the TL, one per (non-human) owner. */
export function planMessages(r, { tl }) {
  const header = '**PR budget report** (automated, t/564; `node operations/devops/pr-budget-report.mjs`).';
  const messages = [{ to: tl, kind: 'tl', body: `${header}\n\n${formatText(r)}` }];
  const byOwner = new Map();
  for (const x of [...r.overToday.map((y) => ({ ...y, kind: 'over' })), ...r.pool.map((y) => ({ ...y, kind: 'pool' }))]) {
    if (!x.owner || x.owner === 'human') continue;
    if (!byOwner.has(x.owner)) byOwner.set(x.owner, []);
    byOwner.get(x.owner).push(x);
  }
  const softOwners = new Set(r.nearlyUsed ? (r.todays ?? []).map((x) => x.owner).filter((o) => o && o !== 'human') : []);
  const softLine = `Heads-up: the team PR budget is nearly used today (${r.units} of ${r.budget} units, soft point ${r.softPoint}). ` +
    `New PRs past ${r.budget} are refused until ${r.nextDayStart}; batch into your feature or train branch instead of opening another PR.`;
  for (const [to, list] of byOwner) {
    if (to === tl) continue; // the TL already has the whole report
    const soft = softOwners.delete(to) ? [softLine, ''] : [];
    messages.push({ to, kind: 'owner', body: [header, '', ...soft, `Your PR(s) over the team PR budget (${r.today}, budget ${r.budget}):`,
      ...list.map((x) => `- #${x.pr.number} ${x.pr.title}: ${x.kind === 'over' ? `rank ${x.rank} today` : `pooled from ${x.day}, position ${x.position}${x.hasSlot ? ', may enqueue today' : ''}`}`),
      '', `Keep committing to the branch; enqueue after ${r.nextDayStart}, or ask the Tech Lead/Security for a \`budget-exempt:\` review.`].join('\n') });
  }
  for (const to of softOwners) {
    if (to !== tl) messages.push({ to, kind: 'soft', body: [header, '', softLine].join('\n') });
  }
  return messages;
}

/** The whole run; every dependency injectable. Returns { report, messages, sent, failed }. */
export async function run(o, deps = {}) {
  const log = deps.log ?? console.log;
  const warn = deps.warn ?? console.warn;
  const now = deps.now ?? Date.now();
  const nowIso = new Date(now).toISOString();
  const today = utcDay(nowIso);
  const start = Date.parse(`${addDays(today, -POOL_DAYS - 3)}T00:00:00Z`);
  const { prs, calls } = (deps.fetch ?? fetchPrsCreated)(o.repo, start, now, deps.gh);
  const r = analyze(prs, nowIso);
  // t/619: a merged PR past the cap may carry a budget-exempt review; read only those (two REST calls each).
  const merged = r.overToday.filter((x) => x.pr.state === 'MERGED');
  const evidence = new Map();
  for (const x of merged) {
    const ev = (deps.fetchExemptEvidence ?? fetchExemptEvidence)(o.repo, x.pr.number, deps.gh);
    if (ev.error) warn(`WARN: pr-budget-report: could not read #${x.pr.number}'s reviews (${ev.error}); listing it as over budget.`);
    evidence.set(x.pr.number, ev);
  }
  const split = splitExempt(r.overToday, evidence);
  r.overToday = split.over;
  r.exempt = split.exempt;
  const appRun = deps.appRun ?? makeAppRun(o.daemon);
  const ticketCache = new Map();
  const ownerOf = new Map();
  for (const x of [...r.overToday, ...r.exempt, ...r.pool, ...(r.todays ?? [])]) {
    if (!ownerOf.has(x.pr.number)) {
      const res = await (deps.resolveOwner ?? resolvePrOwner)(x.pr, { appRun, repo: o.repo, warn, ticketCache, ...(deps.gh ? { gh: deps.gh } : {}) });
      if (!res?.id) warn(`WARN: pr-budget-report: no owner for #${x.pr.number} (${res?.why ?? 'unknown'}).`);
      ownerOf.set(x.pr.number, res?.id ?? null);
    }
    x.owner = ownerOf.get(x.pr.number);
  }
  const report = { ...r, githubCalls: { search: calls, exemptChecks: merged.length * 2 } };
  if (o.json) log(JSON.stringify({ ...report, overToday: r.overToday.map(slim), exempt: r.exempt.map((x) => ({ ...slim(x), reviewId: x.reviewId, approver: x.approver })), pool: r.pool.map(slim) }, null, 2));
  else log(formatText(r));
  // Never ping yourself: chat refuses a send to the sender (the first live run, 2026-11-25).
  const messages = o.tl ? planMessages(r, { tl: o.tl }).filter((m) => m.to && m.to !== 'human' && m.to !== o.sender) : [];
  const sent = [];
  const failed = [];
  if (!o.send) {
    if (!o.json) log(`[dry-run] nothing sent${messages.length ? ` (${messages.length} message(s) planned)` : ''}; pass --send --sender <id> --tl <id> to ping.`);
  } else {
    for (const m of messages) {
      try {
        await appRun('chat', 'send', { sender: o.sender, to: m.to, body: m.body });
        sent.push(m);
      } catch (e) {
        failed.push(m);
        warn(`WARN: pr-budget-report: send to ${m.to} failed (${e.message}).`);
      }
    }
    log(`pr-budget-report: sent ${sent.length}, failed ${failed.length}.`);
  }
  return { report, messages, sent, failed };
}

const slim = (x) => ({ number: x.pr.number, title: x.pr.title, owner: x.owner ?? null, unit: x.unit, rank: x.rank, ...(x.day ? { day: x.day, dayBudget: x.dayBudget, position: x.position, hasSlot: x.hasSlot } : {}) });

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`pr-budget-report: ${e.message}`); process.exit(2); }
  run(o).then((r) => { if (r.failed.length) process.exitCode = 1; }, (e) => {
    console.error(`pr-budget-report: refusing to report (budget_read_failed).\n  Goal:       report the team PR budget (t/564).\n  Problem:    ${e.message}\n` +
      '  Location:   operations/devops/pr-budget-report.mjs.\n  Next steps: check `gh auth status` and the API rate limit, then rerun.');
    process.exit(1);
  });
}
