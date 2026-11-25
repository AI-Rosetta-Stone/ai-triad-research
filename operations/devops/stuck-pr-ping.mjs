// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Stuck-PR alert -> Interweave chat ping to the PR's owner (t/535; plan t/535#2, Lead review #3).
//
// Why: pr-triage.yml (t/4115) labels a stuck PR `stuck-pr-alert-owner` / `-tl` and posts one alert
// comment per blocker episode, but no agent reads GitHub labels or comments; agents wake only on an
// Interweave ping. The old caller (an Orca reminder) is gone (t/523). A GitHub-hosted runner cannot
// reach the local Interweave daemon, so this runs on the PI's machine from the DevOps Worker's
// Interweave reminder, twice a day.
//
// What it does, per run:
//   1. Alerts: Get-StuckPRAlerts.ps1 (the existing bridge: open, labelled, not draft, not
//      awaiting-pi; blind or unreadable -> QueryError). A QueryError stops the run: nothing is sent.
//   2. Facts, one GraphQL query: each alerted PR's head, author, title, body, branch and its latest
//      alert-comment marker `<!-- stuck-pr-alert:<class>:<sha> -->` (blocker), plus its Remedy line.
//   3. Owner, by my-prs.mjs's precedence (ticketRefs, majorityOwner reused): the assignee of a ticket
//      the title/branch cites, else one the body cites, else the majority owner of the changed files.
//      Dependabot PRs, `human` assignees, unknown or archived collaborators and unresolved PRs go to
//      the DevOps Lead ("no owner found" or the Dependabot blocker). `human` is never pinged.
//   4. ONE message per owner per run, listing only that owner's NEW keys (`#N@head:class`): a key
//      already in the ledger is not re-sent. A new head or a new blocker is a new key.
//   5. Escalation: keys first pinged >= 2 days ago and still alerted go to the Tech Lead, ONE message
//      per run, each key escalated once.
//   6. DRY-RUN BY DEFAULT: prints the messages, sends nothing, writes no ledger. `--send` sends; a key
//      is recorded only after its message was accepted, so a failed send is retried next run.
//
// Ledger: %LOCALAPPDATA%/aitriad/stuck-pr-pings.json (or --ledger). Local only; no GitHub writes.
//
// Usage: node operations/devops/stuck-pr-ping.mjs [--send] [--repo owner/name]
//          [--daemon http://127.0.0.1:7420] [--ledger <path>] [--json]
// Tests: node --test operations/devops/stuck-pr-ping.test.mjs

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ticketRefs, majorityOwner } from './my-prs.mjs';
import { ENQUEUE_REMEDY } from './stuck-pr-classifier.mjs';
import { checkPrBudget } from './pr-budget.mjs';
import { PING_REASONS as BUDGET_WAIT_REASONS } from './pr-budget-notify.mjs';

export const SENDER = 'd6bbb177-724b-466d-8382-67dd16bb3bb9'; // DevOps Worker (Lead t/535#3 Q1)
export const DEVOPS_LEAD = 'cad2074a-520d-414b-a665-d505a9d24de5';
export const TECH_LEAD = 'ad4e628f-977f-474e-ae78-f0600f1b1066';
export const ESCALATE_AFTER_MS = 2 * 24 * 3600 * 1000; // N = 2 days (t/535#3 Q2)
export const HEADER = '**DevOps stuck-PR alert** (automated, t/535: sent by the DevOps Worker\'s twice-daily reminder from the `stuck-pr-alert-*` labels; the PR comment has the details).';
const MARKER_RE = /<!-- stuck-pr-alert:([\w-]+):([0-9a-f]{7,40}) -->/;

function actionableError({ goal, problem, location, nextSteps }) {
  const err = new Error(`  Goal:       ${goal}\n  Problem:    ${problem}\n  Location:   ${location}\n  Next Steps: ${nextSteps.map((s, i) => `${i + 1}. ${s}`).join(' ')}`);
  return Object.assign(err, { name: 'ActionableError' });
}

// ── pure ──────────────────────────────────────────────────────────────────────────────────────

/** The newest alert comment's blocker: { class, sha, remedy } or null. `comments`: [{ body }], oldest first. */
export function latestBlocker(comments) {
  for (let i = (comments ?? []).length - 1; i >= 0; i--) {
    const body = String(comments[i]?.body ?? '');
    const m = MARKER_RE.exec(body);
    if (!m) continue;
    const remedy = /^Remedy:\s*(.+)$/m.exec(body);
    return { class: m[1], sha: m[2], remedy: remedy ? safeRemedy(remedy[1].trim(), m[1]) : null };
  }
  return null;
}

// t/535 (Lead p/233#56, t/537#27): an alert comment written before the classifier fix can still say
// "arm it (gh pr merge --auto ...)", "merge directly" or "toggle auto-merge". That route skips
// enqueue-pr.mjs and its gate-file check, so it is never forwarded. CLASS-AWARE (Quality on #5461):
//   - approved-not-armed: the whole remedy is about arming, so it becomes ENQUEUE_REMEDY;
//   - any other class: only the offending parenthetical or clause is dropped, so the rest (a run
//     id, a re-run step) survives; if nothing is left, the remedy is dropped and the class stays.
//     The enqueue text is never substituted there (the PR may already be queued).
// ENQUEUE_REMEDY itself names `gh pr merge` only to forbid it, so it is taken out before the test.
const FORBIDDEN_REMEDY_RE = /gh\s+pr\s+merge|merge\s+(?:it\s+)?directly|direct\s+merge|toggle\s+auto-merge|(?<![-\w])arm\s+it\b/i; // "re-arm it" / "disarm it" are not "arm it"
const isForbidden = (s) => FORBIDDEN_REMEDY_RE.test(String(s).split(ENQUEUE_REMEDY).join(''));

/**
 * PURE. The remedy to forward for an alert of class `cls`: unchanged when it is safe; for
 * approved-not-armed, ENQUEUE_REMEDY; otherwise the remedy with the offending parts removed, or
 * null when nothing safe is left.
 */
export function safeRemedy(remedy, cls = null) {
  if (remedy == null) return null;
  const text = String(remedy);
  if (!isForbidden(text)) return text;
  if (cls === 'approved-not-armed') {
    return `(the alert comment's remedy was replaced: it named a merge route that skips the gates) ${ENQUEUE_REMEDY}`;
  }
  // Drop an offending parenthetical, then any offending sentence or `;` clause.
  const noParens = text.replace(/\s*\([^()]*\)/g, (p) => (isForbidden(p) ? '' : p));
  const kept = noParens.split(/(?<=[.;!?])\s+/).filter((seg) => !isForbidden(seg)).join(' ').trim();
  return kept && !isForbidden(kept) ? kept : null;
}

/** PURE. The tickets a PR cites (my-prs.mjs's ticketRefs, which ignores the t/0-t/2 tier tokens). */
export const citedTickets = (pr) => ticketRefs({ title: pr.title, body: pr.body, branch: pr.branch });

export const isDependabot = (pr) => /dependabot/i.test(pr.author ?? '') || String(pr.branch ?? '').startsWith('dependabot/');

// t/535#24 (2), Lead p/233#180: an area train or the weekly docs train belongs to its train OWNER (t/567's
// rule, t/567#1), not to whichever ticket one of its commits cites. An area not listed here falls back to
// ticket routing with a WARN; it is never guessed.
export const TRAIN_OWNERS = Object.freeze({
  devops: DEVOPS_LEAD,
  server: '637d8eab-f350-4d00-afc2-7ca1ca122cc6', // TaxonomyServer
  renderer: '7261987e-c2fa-4526-9cc3-066b136bc9df', // Rosetta Stone
  debate: '0529ba14-3572-4349-b481-faaa3c8eba2d', // Debate Engine
  'docs-weekly': 'c1c3639b-1e86-46cb-bb29-3f22fa683170', // Documentation (lands docs/weekly-*, t/567#4)
});
/** PURE. The train area of a branch ('devops', 'docs-weekly', ...), or null if it is not a train branch. */
export function trainArea(branch) {
  const b = String(branch ?? '');
  const m = /^train\/([a-z][a-z0-9]*)-\d{8}[a-z]?$/.exec(b);
  if (m) return m[1];
  return /^docs\/weekly-\d{4}-\d{2}$/.test(b) ? 'docs-weekly' : null;
}

/**
 * PURE. Who gets this PR: { to, why, fallback }. `ticketAssignee(n)` -> { id, kind } | null (the
 * ticket's assignee); `fileOwners` -> array of owner ids per changed file, or null if not looked up;
 * `known` -> Set of live collaborator ids. Anything that is not a live agent goes to the DevOps Lead.
 */
export function resolveOwner(pr, { ticketAssignee, fileOwners, known, warn = () => {} }) {
  const toLead = (why) => ({ to: DEVOPS_LEAD, why, fallback: true });
  if (isDependabot(pr)) return toLead('Dependabot PR (DevOps Lead, t/535#3 Q3)');
  const area = trainArea(pr.branch);
  if (area) {
    const owner = TRAIN_OWNERS[area];
    if (owner && known.has(owner)) return { to: owner, why: `${area} train owner (t/567)`, fallback: false };
    warn(owner
      ? `WARN: #${pr.number} is the ${area} train, but its owner ${owner} is not a live collaborator; routing by its tickets instead.`
      : `WARN: #${pr.number} is a train branch with an unlisted area '${area}' (not in TRAIN_OWNERS); routing by its tickets instead.`);
  }
  const refs = citedTickets(pr);
  const notes = [];
  // One ticket set -> an owner, a terminal refusal (human or archived assignee), or null to fall through.
  const fromTickets = (set, where) => {
    if (!set.size) return null;
    const missing = [];
    for (const n of [...set].sort((a, b) => a - b)) {
      const a = ticketAssignee(n);
      if (a === undefined) { missing.push(n); continue; }
      if (!a) continue;
      if (a.kind !== 'agent' || a.id === 'human') return toLead(`no owner found: t/${n} is assigned to ${a.id === 'human' ? 'the human (never pinged)' : a.id}`);
      if (!known.has(a.id)) return toLead(`no owner found: t/${n}'s assignee ${a.id} is not a live collaborator`);
      return { to: a.id, why: `${where} cites t/${n}`, fallback: false };
    }
    notes.push(`the ${where} cites ${[...set].map((n) => `t/${n}`).join(', ')}, none assigned${missing.length ? ` (${missing.map((n) => `t/${n}`).join(', ')} not found in this tracker)` : ''}`);
    return null;
  };
  // Order (Lead, t/535#5): title/branch ticket, then the changed files' majority owner, then a ticket
  // named in the body as the last fallback (bodies also cite other people's tickets for context).
  const primary = fromTickets(refs.primary, 'title/branch');
  if (primary) return primary;
  const m = fileOwners ? majorityOwner(fileOwners) : null;
  if (m && known.has(m.owner)) return { to: m.owner, why: `owns ${m.count}/${m.of} changed files`, fallback: false };
  notes.push('no majority owner of the changed files');
  const body = fromTickets(refs.body, 'body');
  if (body) return body;
  return toLead(`no owner found: ${notes.join('; ')}`);
}

// The key uses the head the ALERT was raised at (the marker's SHA), not the PR's current head: a
// push alone does not re-ping with a stale blocker; pr-triage posts a new marker for the new head
// if it is still stuck, and that is a new key. No marker -> the current head.
export const keyOf = (pr, blocker) => `#${pr.number}@${(blocker?.sha ?? pr.head).slice(0, 9)}:${blocker?.class ?? 'unknown'}`;
const isStale = (item) => item.blocker?.sha && !String(item.pr.head).startsWith(item.blocker.sha) && !String(item.blocker.sha).startsWith(item.pr.head);

function line(item) {
  const b = item.blocker;
  const parts = [`- #${item.pr.number} ${item.pr.title} (head \`${item.pr.head.slice(0, 9)}\`): blocker \`${b?.class ?? 'unknown (no alert comment found)'}\``];
  if (isStale(item)) parts.push(`raised at an older head \`${b.sha.slice(0, 9)}\`, so it may already be fixed`);
  if (b?.remedy) parts.push(`remedy: ${b.remedy}`);
  if (item.owner.fallback) parts.push(`(${item.owner.why})`);
  return parts.join('; ');
}

/**
 * PURE. Plans one run. `items`: [{ pr, blocker, owner }]; `ledger`: { keys: { [key]: { firstPingedAt,
 * to, escalatedAt? } } }; `nowMs`. Returns { messages: [{ to, body, keys, kind }], } -- one 'owner'
 * message per owner with new keys, and at most one 'escalation' message to the Tech Lead.
 */
export function planRun(items, ledger, nowMs) {
  const keys = ledger?.keys ?? {};
  const byOwner = new Map();
  const escalate = [];
  const stale = [];
  const budget = [];
  const own = [];
  for (const it of items) {
    const key = keyOf(it.pr, it.blocker);
    // An alert raised at an older head is not pinged (t/535#5): the PR moved since, so the blocker
    // may be fixed; pr-triage raises a new alert for the new head if it is still stuck.
    if (isStale(it)) { stale.push({ ...it, key }); continue; }
    // t/535#24 (1): green and approved but waiting for the PR budget (enqueue-pr would refuse it today),
    // or the budget could not be read: telling the owner to enqueue it is wrong. The budget report
    // already tells over-budget owners. Not recorded, so it is reconsidered next run.
    if (it.budgetWait) { budget.push({ ...it, key }); continue; }
    // t/535#24 (3): chat refuses a send to the sender itself, which would retry forever. Listed, not pinged.
    if (it.owner.to === SENDER) { own.push({ ...it, key }); continue; }
    const seen = keys[key];
    if (!seen) {
      if (!byOwner.has(it.owner.to)) byOwner.set(it.owner.to, []);
      byOwner.get(it.owner.to).push({ ...it, key });
    } else if (!seen.escalatedAt && nowMs - Date.parse(seen.firstPingedAt) >= ESCALATE_AFTER_MS) {
      escalate.push({ ...it, key, firstPingedAt: seen.firstPingedAt, pingedTo: seen.to });
    }
  }
  const messages = [];
  for (const [to, list] of byOwner) {
    list.sort((a, b) => a.pr.number - b.pr.number);
    messages.push({
      kind: 'owner', to, keys: list.map((x) => x.key),
      body: [HEADER, '', `${list.length} of your PRs ${list.length === 1 ? 'is' : 'are'} stuck:`, ...list.map(line), '', 'Fix the blocker or say on the PR\'s ticket why it waits. You are pinged again only for a new head or a new blocker; after 2 days the Tech Lead is told.'].join('\n'),
    });
  }
  if (escalate.length) {
    escalate.sort((a, b) => a.pr.number - b.pr.number);
    messages.push({
      kind: 'escalation', to: TECH_LEAD, keys: escalate.map((x) => x.key),
      body: [HEADER, '', `Escalation: ${escalate.length} stuck PR(s) unchanged 2+ days after the owner was pinged:`,
        ...escalate.map((x) => `${line(x)}; owner pinged: ${x.pingedTo} at ${x.firstPingedAt}`)].join('\n'),
    });
  }
  for (const l of [stale, budget, own]) l.sort((a, b) => a.pr.number - b.pr.number);
  return { messages, stale, budget, own };
}

/** PURE. The ledger after `sent` messages were accepted (only those). */
export function recordSent(ledger, sent, nowMs) {
  const next = { keys: { ...(ledger?.keys ?? {}) } };
  const at = new Date(nowMs).toISOString();
  for (const m of sent) {
    for (const k of m.keys) {
      if (m.kind === 'owner') next.keys[k] = { firstPingedAt: at, to: m.to };
      else next.keys[k] = { ...next.keys[k], escalatedAt: at };
    }
  }
  return next;
}

// ── I/O ───────────────────────────────────────────────────────────────────────────────────────

let rpcId = 0;
export function makeAppRun(daemon) {
  return async (app, command, args) => {
    const res = await fetch(`${daemon}/api/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name: 'app_run', arguments: { app, command, args: [JSON.stringify(args)] } } }),
    });
    if (!res.ok) throw new Error(`Interweave ${app} ${command}: HTTP ${res.status}`);
    const out = (await res.json())?.result?.structuredContent?.result?.stdout;
    const parsed = JSON.parse(out ?? 'null');
    if (!parsed || parsed.error) throw new Error(`Interweave ${app} ${command}: ${parsed?.error?.message ?? 'no result'}`);
    return parsed;
  };
}

const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
const here = path.dirname(fileURLToPath(import.meta.url));

export function readAlerts(repo) {
  const out = execFileSync('pwsh', ['-NoProfile', '-Command', `& '${path.join(here, 'Get-StuckPRAlerts.ps1')}' -Repo '${repo}' | ConvertTo-Json -Depth 6`], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out);
}

export function readPrFacts(repo, numbers) {
  if (!numbers.length) return new Map();
  const [owner, name] = repo.split('/');
  const fields = 'number title body headRefName headRefOid author{login} comments(last:100){nodes{body}}';
  const q = `query{repository(owner:"${owner}",name:"${name}"){${numbers.map((n) => `p${n}:pullRequest(number:${n}){${fields}}`).join(' ')}}}`;
  const data = JSON.parse(gh(['api', 'graphql', '-f', `query=${q}`])).data.repository;
  const facts = new Map();
  for (const n of numbers) {
    const p = data[`p${n}`];
    if (!p) continue;
    facts.set(n, {
      pr: { number: n, title: p.title, body: p.body, branch: p.headRefName, head: p.headRefOid, author: p.author?.login ?? '' },
      blocker: latestBlocker(p.comments?.nodes ?? []),
    });
  }
  return facts;
}

export function parseArgs(argv) {
  const o = { send: false, json: false, repo: 'AI-Rosetta-Stone/ai-triad-research', daemon: 'http://127.0.0.1:7420', ledger: path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'aitriad', 'stuck-pr-pings.json') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--send') o.send = true;
    else if (a === '--json') o.json = true;
    else if (['--repo', '--daemon', '--ledger'].includes(a) && argv[i + 1]) o[a.slice(2)] = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  const host = new URL(o.daemon).hostname;
  if (host !== '127.0.0.1' && host !== 'localhost') throw new Error(`--daemon must be a loopback URL, got ${o.daemon}`);
  return o;
}

/** The whole run; every dependency injectable for the tests. Returns { messages, sent, failed }. */
export async function run(o, deps = {}) {
  const log = deps.log ?? console.log;
  const appRun = deps.appRun ?? makeAppRun(o.daemon);
  const alerts = (deps.readAlerts ?? readAlerts)(o.repo);
  if (alerts?.QueryError) {
    throw actionableError({
      goal: 'Ping the owners of stuck PRs (t/535)', problem: `the stuck-PR bridge could not read GitHub: ${alerts.QueryError}`,
      location: 'operations/devops/stuck-pr-ping.mjs (Get-StuckPRAlerts.ps1)', nextSteps: ['Nothing was sent.', 'Check `gh auth status`, then re-run.'],
    });
  }
  const numbers = [...new Set([...(alerts?.OwnerAlerts ?? []), ...(alerts?.TLAlerts ?? [])].map((a) => a.number))].sort((a, b) => a - b);
  const facts = (deps.readPrFacts ?? readPrFacts)(o.repo, numbers);

  // Live, non-archived collaborators of the SENDER's own local team: chat refuses an agent outside
  // the sender's tree, and an agent of another local team is not this repo's owner anyway.
  const live = deps.knownCollaborators ?? (async () => {
    const teams = await appRun('org-chart', 'collaborators', {});
    for (const t of teams.localTeams ?? []) {
      if (t.archived) continue;
      const r = await appRun('org-chart', 'collaborators', { localTeamId: t.id });
      const members = r.collaborators ?? [];
      if (members.some((c) => c.id === SENDER)) return new Set(members.filter((c) => !c.archived).map((c) => c.id));
    }
    throw actionableError({ goal: 'Resolve stuck-PR owners (t/535)', problem: `the sender ${SENDER} is in no local team the org chart lists`, location: 'operations/devops/stuck-pr-ping.mjs', nextSteps: ['Nothing was sent.', 'Check the org-chart app.'] });
  });
  const known = await live();
  const MISSING = Symbol('missing');
  const ticketCache = new Map();
  for (const n of numbers) {
    const f = facts.get(n);
    if (!f) continue;
    const refs = citedTickets(f.pr);
    for (const t of [...refs.primary, ...refs.body]) {
      if (ticketCache.has(t)) continue;
      try {
        const tk = await appRun('tickets', 'get', { id: `t/${t}` });
        ticketCache.set(t, tk.assignee ? { id: tk.assignee.id, kind: tk.assignee.kind } : null);
      } catch { ticketCache.set(t, MISSING); }
    }
  }
  const ticketAssignee = (t) => { const v = ticketCache.get(t); return v === MISSING || v === undefined ? undefined : v; };
  // Files are only looked up for a PR that cites no ticket and is not Dependabot (my-prs.mjs's rule):
  // one REST call per such PR, and one resolve-owner per directory (cached).
  const dirOwner = new Map();
  const root = deps.checkoutRoot ?? (() => path.dirname(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim()));
  const fileOwnersFor = deps.fileOwnersFor ?? (async (pr) => {
    // Files are needed unless the title/branch ticket already names a live agent (files come
    // before the body ticket in the owner order, t/535#5).
    if (isDependabot(pr)) return null;
    const primaryResolves = [...citedTickets(pr).primary].some((n) => { const a = ticketAssignee(n); return a && a.kind === 'agent' && known.has(a.id); });
    if (primaryResolves) return null;
    let files;
    try {
      files = gh(['api', '--paginate', `repos/${o.repo}/pulls/${pr.number}/files?per_page=100`, '--jq', '.[].filename']).split('\n').filter(Boolean);
    } catch (e) {
      log(`WARN: could not list files of #${pr.number} (${String(e.message).split('\n')[0]}); it goes to the DevOps Lead as no owner found.`);
      return null;
    }
    const base = root();
    const owners = [];
    for (const f of files) {
      const dir = path.posix.dirname(f);
      if (!dirOwner.has(dir)) {
        try { dirOwner.set(dir, (await appRun('org-chart', 'resolve-owner', { path: path.join(base, f) })).collaborator?.id ?? null); }
        catch (e) { log(`WARN: resolve-owner failed for ${f} (${e.message}); counted as unowned.`); dirOwner.set(dir, null); }
      }
      owners.push(dirOwner.get(dir));
    }
    return owners;
  });
  const items = [];
  for (const n of numbers) {
    const f = facts.get(n);
    if (!f) { log(`WARN: #${n} is labelled but its facts could not be read; skipped this run.`); continue; }
    const owner = resolveOwner(f.pr, { ticketAssignee, fileOwners: await fileOwnersFor(f.pr), known, warn: log });
    items.push({ ...f, owner });
  }

  const nowMs = deps.nowMs ?? Date.now();
  // t/535#24 (1), Lead p/233#180: an approved-not-armed PR may be green and approved yet waiting for the PR
  // budget. Ask the SAME check enqueue-pr.mjs runs (checkPrBudget -> budgetVerdict), so the two cannot
  // disagree. A budget wait (over_budget_today, pooled_no_slot, pool_expired) or an unreadable budget
  // is listed, not pinged; any allow (within budget, a pooled slot, Dependabot) pings as before.
  const budgetOf = deps.checkBudget ?? ((n) => checkPrBudget(o.repo, n, { now: nowMs, log: () => {}, warn: log }));
  for (const it of items) {
    if (it.blocker?.class !== 'approved-not-armed' || isStale(it)) continue;
    let v;
    try { v = budgetOf(it.pr.number); } catch (e) { v = { allow: false, reason: 'budget_read_failed', detail: e.message }; }
    if (v?.allow) continue;
    if (BUDGET_WAIT_REASONS.includes(v?.reason)) it.budgetWait = v.reason;
    else {
      it.budgetWait = 'budget_read_failed';
      log(`WARN: could not read the PR budget for #${it.pr.number} (${v?.reason ?? 'no verdict'}${v?.detail ? `: ${v.detail}` : ''}); not pinged this run, reconsidered next run.`);
    }
  }

  const ledgerPath = o.ledger;
  const ledger = deps.ledger ?? (existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : { keys: {} });
  const { messages, stale, budget, own } = planRun(items, ledger, nowMs);
  for (const x of stale) log(`stale alert, not pinged: #${x.pr.number} \`${x.blocker.class}\` raised at ${x.blocker.sha.slice(0, 9)}, head is now ${x.pr.head.slice(0, 9)} (owner would be ${x.owner.to}).`);
  for (const x of budget) log(`waiting for the PR budget (${x.budgetWait}), not pinged: #${x.pr.number} \`${x.blocker.class}\` (owner ${x.owner.to}).`);
  for (const x of own) log(`owner is the sender, not pinged: #${x.pr.number} \`${x.blocker?.class ?? 'unknown'}\` (${x.owner.why}).`);

  const sent = [];
  const failed = [];
  for (const m of messages) {
    if (!o.send) {
      log(`[dry-run] would send to ${m.to} (${m.kind}, ${m.keys.length} key(s)):\n${m.body}\n`);
      continue;
    }
    try {
      await appRun('chat', 'send', { sender: SENDER, to: m.to, body: m.body });
      sent.push(m);
      log(`sent to ${m.to} (${m.kind}): ${m.keys.join(', ')}`);
    } catch (e) {
      failed.push(m);
      log(`WARN: send to ${m.to} failed (${e.message}); its keys are not recorded, so the next run retries.`);
    }
  }
  if (o.send && sent.length) {
    const next = recordSent(ledger, sent, nowMs);
    if (deps.writeLedger) deps.writeLedger(next);
    else { mkdirSync(path.dirname(ledgerPath), { recursive: true }); writeFileSync(ledgerPath, JSON.stringify(next, null, 2)); }
  }
  log(`stuck-pr-ping: ${numbers.length} alerted PR(s); ${messages.length} message(s) ${o.send ? `sent ${sent.length}, failed ${failed.length}` : 'planned (dry-run, nothing sent; pass --send to send)'}.`);
  return { messages, stale, budget, own, sent, failed, items };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`stuck-pr-ping: ${e.message}`); process.exit(2); }
  run(o).then((r) => { if (r.failed.length) process.exitCode = 1; }, (e) => { console.error(e.message); process.exit(1); });
}
