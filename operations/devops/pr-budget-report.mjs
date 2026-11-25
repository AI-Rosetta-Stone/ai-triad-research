#!/usr/bin/env node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/656 (t/655, PI 2026-11-25; replaces t/564's budget report): a BATCHING MONITOR, not a gate.
// The PI's goal is fewer, bigger PRs, so the report measures tickets per PR, with no PR-count
// threshold anywhere (TL p/9#630):
//   - each PR merged today (UTC): its landing vehicle and its tickets (the body's ticket table, else
//     the t/<N> refs in its title and branch);
//   - the median tickets per PR and the share of single-ticket PRs, today and over the last 7 days;
//   - ALERTS to the Tech Lead: every single-ticket PR merged today that is not an incident, Dependabot
//     or automated PR; and a 7-day median under MEDIAN_FLOOR (3);
//   - PRs opened and merged today, for context only (no threshold).
// Not measured yet: time from ticket-done to landed (needs the tickets' Done timestamps; t/656 follow-up).
// Read-only on GitHub. DRY-RUN BY DEFAULT. With `--send --sender <id> --tl <id>` it sends ONE message,
// to the Tech Lead; no PR owner is pinged, and nothing is ever refused. A failed send is a WARN.
//
// Usage: node operations/devops/pr-budget-report.mjs [--json] [--repo owner/name]
//          [--daemon http://127.0.0.1:7420] [--send --sender <collaborator id> --tl <collaborator id>]

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addDays, fetchPrsCreated, isDependabotAuthor, utcDay } from './pr-budget.mjs';
import { assertLoopback, DEFAULT_DAEMON, makeAppRun } from './pr-budget-notify.mjs';
import { classifyBranch, ticketTableFacts } from './landing-vehicle.mjs';

export const MEDIAN_FLOOR = 3;
export const WINDOW_DAYS = 7;
export const LOOKBACK_DAYS = 21; // PRs merged in the window may have been opened up to this long before

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

/** PURE. A PR's tickets: its body's ticket table, else the t/<N> refs in its title and head branch. */
export function ticketsOf(pr) {
  const table = ticketTableFacts(pr.body).tickets;
  if (table.length) return table;
  const refs = new Set();
  for (const s of [pr.title, String(pr.headRefName ?? '').replace(/^(?:feat|fix|incident|devops|docs|ci)\/t(\d+)/, 't/$1')]) {
    for (const m of String(s ?? '').matchAll(/\bt\/(\d+)\b/g)) refs.add(`t/${m[1]}`);
  }
  return [...refs].sort();
}

/** PURE. 'dependabot' | 'automated' | 'incident' | 'train' | 'feature' | 'other'. */
export function vehicleOf(pr) {
  if (isDependabotAuthor(pr.author)) return 'dependabot';
  const k = classifyBranch(pr.headRefName).kind;
  return k === 'none' ? 'other' : k;
}

const EXCLUDED = new Set(['dependabot', 'automated']);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** PURE. The batching numbers and alerts from every PR created in the lookback. */
export function analyze(prs, nowIso) {
  const today = utcDay(nowIso);
  const from = addDays(today, -(WINDOW_DAYS - 1));
  const merged = prs.filter((p) => p.mergedAt).map((p) => ({ pr: p, day: utcDay(p.mergedAt), vehicle: vehicleOf(p), tickets: ticketsOf(p) }));
  const counted = (xs) => xs.filter((x) => !EXCLUDED.has(x.vehicle));
  const mergedToday = merged.filter((x) => x.day === today);
  const mergedWeek = merged.filter((x) => x.day >= from && x.day <= today);
  const stats = (xs) => {
    const c = counted(xs);
    const single = c.filter((x) => x.tickets.length <= 1);
    return { prs: c.length, medianTickets: median(c.map((x) => x.tickets.length)), singleTicket: single.length, singleShare: c.length ? single.length / c.length : null };
  };
  const day = stats(mergedToday);
  const week = stats(mergedWeek);
  const singleAlerts = counted(mergedToday).filter((x) => x.tickets.length <= 1 && x.vehicle !== 'incident');
  const medianAlert = week.medianTickets != null && week.medianTickets < MEDIAN_FLOOR;
  return {
    today, from, day, week, medianFloor: MEDIAN_FLOOR,
    openedToday: prs.filter((p) => utcDay(p.createdAt) === today).length,
    mergedToday: mergedToday.length,
    mergedTodayList: mergedToday,
    singleAlerts, medianAlert,
    alert: singleAlerts.length > 0 || medianAlert,
  };
}

const pct = (x) => (x == null ? 'n/a' : `${Math.round(x * 100)}%`);
const num = (x) => (x == null ? 'n/a' : String(x));

export function formatText(r) {
  const row = (x) => `  #${x.pr.number} [${x.vehicle}] ${x.tickets.length} ticket(s)${x.tickets.length ? ` (${x.tickets.join(', ')})` : ''}: ${x.pr.title}`;
  return [
    ...(r.alert ? ['**Batching alert** (t/655):',
      ...(r.singleAlerts.length ? [`- ${r.singleAlerts.length} single-ticket non-incident PR(s) merged today: ${r.singleAlerts.map((x) => `#${x.pr.number}`).join(', ')}`] : []),
      ...(r.medianAlert ? [`- the ${WINDOW_DAYS}-day median is ${num(r.week.medianTickets)} ticket(s) per PR, under ${r.medianFloor}`] : []),
      ''] : []),
    `Batching ${r.today} (UTC). Today: ${r.day.prs} PR(s) merged (Dependabot and automated excluded), median ${num(r.day.medianTickets)} ticket(s) per PR, ${pct(r.day.singleShare)} single-ticket.`,
    `Last ${WINDOW_DAYS} days (${r.from}..${r.today}): ${r.week.prs} PR(s), median ${num(r.week.medianTickets)} ticket(s) per PR (floor ${r.medianFloor}), ${pct(r.week.singleShare)} single-ticket.`,
    `Context only (no threshold): ${r.openedToday} PR(s) opened today, ${r.mergedToday} merged today.`,
    `Merged today (${r.mergedTodayList.length}):`, ...(r.mergedTodayList.length ? r.mergedTodayList.map(row) : ['  none']),
    'Not measured yet: time from ticket-done to landed.',
  ].join('\n');
}

/** PURE. The one message a --send run sends: to the Tech Lead. Nobody else is pinged. */
export function planMessages(r, { tl }) {
  const header = '**Batching report** (automated, t/656; `node operations/devops/pr-budget-report.mjs`).';
  return [{ to: tl, kind: 'tl', body: `${header}\n\n${formatText(r)}` }];
}

/** The whole run; every dependency injectable. Returns { report, messages, sent, failed }. */
export async function run(o, deps = {}) {
  const log = deps.log ?? console.log;
  const warn = deps.warn ?? console.warn;
  const now = deps.now ?? Date.now();
  const nowIso = new Date(now).toISOString();
  const start = Date.parse(`${addDays(utcDay(nowIso), -LOOKBACK_DAYS)}T00:00:00Z`);
  const { prs, calls } = (deps.fetch ?? fetchPrsCreated)(o.repo, start, now, deps.gh);
  const r = analyze(prs, nowIso);
  const report = { ...r, githubCalls: { search: calls } };
  if (o.json) log(JSON.stringify({ ...report, mergedTodayList: r.mergedTodayList.map(slim), singleAlerts: r.singleAlerts.map(slim) }, null, 2));
  else log(formatText(r));
  // Never ping yourself: chat refuses a send to the sender.
  const messages = o.tl ? planMessages(r, { tl: o.tl }).filter((m) => m.to && m.to !== 'human' && m.to !== o.sender) : [];
  const sent = [];
  const failed = [];
  if (!o.send) {
    if (!o.json) log(`[dry-run] nothing sent${messages.length ? ` (${messages.length} message(s) planned)` : ''}; pass --send --sender <id> --tl <id> to ping.`);
  } else {
    const appRun = deps.appRun ?? makeAppRun(o.daemon);
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

const slim = (x) => ({ number: x.pr.number, title: x.pr.title, vehicle: x.vehicle, tickets: x.tickets });

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`pr-budget-report: ${e.message}`); process.exit(2); }
  run(o).then((r) => { if (r.failed.length) process.exitCode = 1; }, (e) => {
    console.error(`pr-budget-report: refusing to report (read_failed).\n  Goal:       report how well changes are batched (t/656).\n  Problem:    ${e.message}\n` +
      '  Location:   operations/devops/pr-budget-report.mjs.\n  Next steps: check `gh auth status` and the API rate limit, then rerun.');
    process.exit(1);
  });
}
