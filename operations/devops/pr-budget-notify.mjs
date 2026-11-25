// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/564 phase A: who owns a PR, and the Interweave chat ping for a PR-budget refusal.
//
// Owner, by my-prs.mjs's precedence (claim()): the agent assignee of a ticket the title/branch cites;
// else of one the body cites; else, only when the PR cites no ticket at all, the majority owner of
// its changed files (org-chart resolve-owner). `human` is never an owner here: it is never pinged.
// Unresolved -> { id: null } and the caller WARNs.
//
// Used by enqueue-pr.mjs's CLI (one ping to the owner when it refuses for budget; never from a library
// caller such as the sweeps) and by pr-budget-report.mjs. Every dependency is injectable; the tests
// never reach the network. In GATE_SCRIPTS (it is in enqueue-pr.mjs's import closure).

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { ticketRefs, majorityOwner } from './my-prs.mjs';
import { makeAppRun } from './stuck-pr-ping.mjs';

export const DEFAULT_DAEMON = 'http://127.0.0.1:7420';
export const PING_REASONS = Object.freeze(['over_budget_today', 'pooled_no_slot', 'pool_expired']);

/** Refuses anything that is not a loopback daemon URL (no ticket data off-host), as my-prs.mjs does. */
export function assertLoopback(daemon) {
  const host = new URL(daemon).hostname;
  if (host !== '127.0.0.1' && host !== 'localhost') throw new Error(`--daemon must be a loopback URL, got ${daemon}`);
  return daemon;
}

const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
const defaultRoot = () => path.dirname(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim());

/**
 * The owner collaborator id of `pr` ({ number, title, body, headRefName }). Never throws.
 * deps: { appRun, gh, repo, checkoutRoot, warn, ticketCache: Map }. Returns { id, why }; id null if unresolved.
 */
export async function resolvePrOwner(pr, { appRun, gh: ghFn = gh, repo, checkoutRoot = defaultRoot, warn = console.warn, ticketCache = new Map() } = {}) {
  const refs = ticketRefs({ title: pr.title, body: pr.body, branch: pr.headRefName });
  const assignee = async (n) => {
    if (!ticketCache.has(n)) {
      try {
        const t = await appRun('tickets', 'get', { id: `t/${n}` });
        ticketCache.set(n, t?.assignee ? { id: t.assignee.id, kind: t.assignee.kind } : null);
      } catch (e) {
        warn(`WARN: pr-budget could not read t/${n} (${e.message}); not used for #${pr.number}'s owner.`);
        ticketCache.set(n, null);
      }
    }
    return ticketCache.get(n);
  };
  for (const [set, where] of [[refs.primary, 'title/branch'], [refs.body, 'body']]) {
    if (!set.size) continue;
    for (const n of [...set].sort((a, b) => a - b)) {
      const a = await assignee(n);
      if (a && a.kind === 'agent' && a.id && a.id !== 'human') return { id: a.id, why: `${where} cites t/${n}` };
    }
    // my-prs claim(): a PR that names tickets in its title/branch belongs to their assignees, nobody else.
    return { id: null, why: `the ${where} cites ${[...set].map((n) => `t/${n}`).join(', ')}, none assigned to an agent` };
  }
  let files;
  try {
    files = ghFn(['api', '--paginate', `repos/${repo}/pulls/${pr.number}/files?per_page=100`, '--jq', '.[].filename']).split('\n').filter(Boolean);
  } catch (e) {
    return { id: null, why: `no ticket ref, and the changed files could not be listed (${String(e.message).split('\n')[0]})` };
  }
  const base = checkoutRoot();
  const dirOwner = new Map();
  const owners = [];
  for (const f of files) {
    const dir = path.posix.dirname(f);
    if (!dirOwner.has(dir)) {
      try { dirOwner.set(dir, (await appRun('org-chart', 'resolve-owner', { path: path.join(base, f) })).collaborator?.id ?? null); } catch (e) {
        warn(`WARN: resolve-owner failed for ${f} (${e.message}); counted as unowned.`);
        dirOwner.set(dir, null);
      }
    }
    owners.push(dirOwner.get(dir));
  }
  const m = majorityOwner(owners);
  if (m && m.owner !== 'human') return { id: m.owner, why: `no ticket ref; owns ${m.count}/${m.of} changed files` };
  return { id: null, why: 'no ticket ref and no majority owner of the changed files' };
}

/** PURE. The chat body for one budget refusal. */
export function refusalPingBody({ repo, pr, message }) {
  return [
    `**PR budget** (automated, t/564): \`enqueue-pr.mjs\` refused to enqueue #${pr.number} ${pr.title ?? ''} on ${repo}.`,
    '',
    '```',
    message,
    '```',
    '',
    'Keep committing to the branch; rerun the enqueue after the next UTC day starts, or ask the Tech Lead/Security for a `budget-exempt:` review.',
  ].join('\n');
}

/**
 * Sends ONE ping to the owner of a PR refused for budget. Never throws; the refusal stands either way.
 * Returns { sent, to?, skipped? }. deps: { daemon, appRun, resolveOwner, warn, log }.
 */
export async function pingBudgetRefusal({ repo, pr, reason, message, by }, deps = {}) {
  const warn = deps.warn ?? console.warn;
  const log = deps.log ?? console.log;
  if (!PING_REASONS.includes(reason) || !pr) return { sent: false, skipped: 'not_an_over_budget_refusal' };
  const sender = typeof by === 'string' && by.trim() ? by.trim() : null;
  if (!sender) {
    warn(`WARN: enqueue-pr: no --by given, so the owner of #${pr.number} is not pinged about the budget refusal (the refusal stands).`);
    return { sent: false, skipped: 'no_sender' };
  }
  try {
    const appRun = deps.appRun ?? makeAppRun(assertLoopback(deps.daemon ?? DEFAULT_DAEMON));
    const owner = await (deps.resolveOwner ?? resolvePrOwner)(pr, { appRun, repo, warn });
    if (!owner?.id || owner.id === 'human') {
      warn(`WARN: enqueue-pr: could not resolve an agent owner for #${pr.number} (${owner?.why ?? 'unknown'}); nobody pinged (the refusal stands).`);
      return { sent: false, skipped: 'owner_unresolved' };
    }
    await appRun('chat', 'send', { sender, to: owner.id, body: refusalPingBody({ repo, pr, message }) });
    log(`enqueue-pr: pinged ${owner.id} (owner of #${pr.number}: ${owner.why}) about the budget refusal.`);
    return { sent: true, to: owner.id };
  } catch (e) {
    warn(`WARN: enqueue-pr could not ping the owner of #${pr.number} about the budget refusal (${e.message}); the refusal stands.`);
    return { sent: false, skipped: 'send_failed' };
  }
}
