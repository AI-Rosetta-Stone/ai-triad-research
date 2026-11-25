// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/656 (t/655, PI 2026-11-25): enqueue-pr checks the LANDING VEHICLE instead of a daily PR count.
// The 20/day cap (t/564) throttled a stream of small PRs instead of making PRs bigger, so it is
// gone from the enqueue path; the count lives on as a monitor (pr-budget-report.mjs).
//
// A non-Dependabot PR is enqueued only when its head branch is one of:
//   train      train/<area>-YYYYMMDD[x], area in TRAIN_AREAS; or docs/weekly-YYYY-WW
//   feature    feat/t<N>-<slug>, and only when the PR body's ticket table names 3+ tickets or
//              2+ owners (otherwise: "land it on your area train")
//   incident   incident/t<N>-<slug>, and only when t/<N> is a ticket titled INCIDENT that is still
//              open, or a Tech Lead/Security `budget-exempt:` review at the head is named with
//              --budget-exempt-review (the flag is accepted for incident PRs only)
//   automated  docker/base-repin-* (check-base-pin-drift.yml, which opens a PR only when a runtime
//              CVE is fixed; TL p/9#628). Nothing else automated is exempt.
// Grandfather (TL p/9#628): a PR created before CUTOVER_ISO is allowed until GRANDFATHER_UNTIL_ISO
// with a WARN naming the train it should have used, then refused like any other.
// Anything else is refused with a message naming the area trains. Every read fails closed.
//
// Pure core: classifyBranch, ticketTableFacts, vehicleVerdict, vehicleOkLine, vehicleRefusalMessage.
// Impure: checkLandingVehicle (gh and the ticket reader injectable).

import { exemptionVerdict, exemptLogLine, fetchExemptReview, isDependabotAuthor, readPrFacts } from './pr-budget.mjs';
import { assertLoopback, DEFAULT_DAEMON, makeAppRun } from './pr-budget-notify.mjs';

export const TRAIN_AREAS = Object.freeze(['devops', 'server', 'renderer', 'debate', 'powershell', 'security']);
export const TRAIN_RE = new RegExp(`^train\\/(${TRAIN_AREAS.join('|')})-\\d{8}[a-z]?$`);
export const WEEKLY_RE = /^docs\/weekly-\d{4}-\d{2}$/;
export const FEATURE_RE = /^feat\/t(\d+)-[a-z0-9][a-z0-9-]*$/;
export const INCIDENT_RE = /^incident\/t(\d+)-[a-z0-9][a-z0-9-]*$/;
export const AUTOMATED_RE = /^docker\/base-repin-[A-Za-z0-9._-]+$/;
export const FEATURE_MIN_TICKETS = 3;
export const FEATURE_MIN_OWNERS = 2;
export const CUTOVER_ISO = '2026-11-25T20:00:00Z';
export const GRANDFATHER_UNTIL_ISO = '2026-11-27T20:00:00Z'; // CUTOVER + 48 h (TL p/9#628)
export const ALLOW_REASONS = Object.freeze(['dependabot', 'train', 'feature', 'incident', 'incident_exempt', 'automated', 'grandfathered']);
/** Refusals that mean "land it on the right vehicle": the sweeps log them as skips, never as failures. */
export const ROUTE_REASONS = Object.freeze(['not_a_vehicle', 'feature_too_small', 'incident_not_open']);
export const REFUSAL_REASONS = Object.freeze([...ROUTE_REASONS, 'vehicle_read_failed', 'budget_exempt_invalid', 'budget_exempt_not_incident']);

const TRAIN_LIST = `${TRAIN_AREAS.map((a) => `train/${a}-YYYYMMDD`).join(', ')}, or docs/weekly-YYYY-WW`;

/** PURE. { kind, ticket? } for a head branch: train | feature | incident | automated | none. */
export function classifyBranch(branch) {
  const b = String(branch ?? '');
  if (TRAIN_RE.test(b) || WEEKLY_RE.test(b)) return { kind: 'train' };
  let m = FEATURE_RE.exec(b);
  if (m) return { kind: 'feature', ticket: `t/${m[1]}` };
  m = INCIDENT_RE.exec(b);
  if (m) return { kind: 'incident', ticket: `t/${m[1]}` };
  if (AUTOMATED_RE.test(b)) return { kind: 'automated' };
  return { kind: 'none' };
}

const splitRow = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const isSeparator = (cells) => cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c));

/**
 * PURE. The PR body's ticket table(s): every markdown table row's `t/<N>` references (distinct
 * tickets), and the distinct values of a column headed Owner/Author (distinct owners).
 * Returns { tickets: string[], owners: string[] }.
 */
export function ticketTableFacts(body) {
  const tickets = new Set();
  const owners = new Set();
  const lines = String(body ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\|/.test(lines[i])) continue;
    // A table: a header row followed by a separator row.
    const header = splitRow(lines[i]);
    if (i + 1 >= lines.length || !isSeparator(splitRow(lines[i + 1]))) continue;
    const ownerCol = header.findIndex((h) => /^(owner|author)s?$/i.test(h.replace(/\*/g, '')));
    let j = i + 2;
    for (; j < lines.length && /^\s*\|/.test(lines[j]); j++) {
      const cells = splitRow(lines[j]);
      for (const c of cells) for (const t of c.matchAll(/\bt\/(\d+)\b/g)) tickets.add(`t/${t[1]}`);
      if (ownerCol >= 0 && cells[ownerCol]) owners.add(cells[ownerCol].replace(/[`*]/g, '').trim().toLowerCase());
    }
    i = j - 1;
  }
  owners.delete('');
  return { tickets: [...tickets].sort(), owners: [...owners].sort() };
}

/**
 * PURE. The verdict for one PR. `pr`: readPrFacts' shape. `ticket`: { title, status } of an incident
 * branch's ticket, or null when unread or unreadable (`ticketError` says why). `exempt`: a valid
 * exemptionVerdict result when --budget-exempt-review was given and checked. `nowIso` decides the grandfather.
 */
export function vehicleVerdict({ pr, nowIso, ticket = null, ticketError = null, exempt = null }) {
  if (isDependabotAuthor(pr.author)) return { allow: true, reason: 'dependabot' };
  const v = classifyBranch(pr.headRefName);
  if (v.kind === 'train') return { allow: true, reason: 'train', vehicle: v };
  if (v.kind === 'automated') return { allow: true, reason: 'automated', vehicle: v };
  if (v.kind === 'incident') {
    if (exempt?.valid) return { allow: true, reason: 'incident_exempt', vehicle: v, exempt };
    if (ticket && /^INCIDENT\b/i.test(String(ticket.title ?? '').trim()) && ['Open', 'InProgress'].includes(ticket.status)) {
      return { allow: true, reason: 'incident', vehicle: v };
    }
    if (!ticket && ticketError) return { allow: false, reason: 'vehicle_read_failed', vehicle: v, detail: `could not read ${v.ticket} (${ticketError})` };
    return {
      allow: false, reason: 'incident_not_open', vehicle: v,
      detail: ticket ? `${v.ticket} is "${String(ticket.title).slice(0, 80)}" (${ticket.status}); an incident PR needs an open ticket titled INCIDENT` : `${v.ticket} was not found`,
    };
  }
  if (v.kind === 'feature') {
    const f = ticketTableFacts(pr.body);
    if (f.tickets.length >= FEATURE_MIN_TICKETS || f.owners.length >= FEATURE_MIN_OWNERS) return { allow: true, reason: 'feature', vehicle: v, facts: f };
    const g = grandfather(pr, nowIso, v);
    if (g) return g;
    return {
      allow: false, reason: 'feature_too_small', vehicle: v, facts: f,
      detail: `its ticket table names ${f.tickets.length} ticket(s) and ${f.owners.length} owner(s); a feature PR needs ${FEATURE_MIN_TICKETS}+ tickets or ${FEATURE_MIN_OWNERS}+ owners`,
    };
  }
  const g = grandfather(pr, nowIso, v);
  if (g) return g;
  return { allow: false, reason: 'not_a_vehicle', vehicle: v, detail: `head branch "${pr.headRefName}" is not a landing vehicle` };
}

function grandfather(pr, nowIso, vehicle) {
  const created = Date.parse(pr.createdAt);
  const now = Date.parse(nowIso);
  if (Number.isFinite(created) && created < Date.parse(CUTOVER_ISO) && now < Date.parse(GRANDFATHER_UNTIL_ISO)) {
    return { allow: true, reason: 'grandfathered', vehicle };
  }
  return null;
}

/** PURE. The log line for an allowed verdict (a WARN for a grandfathered one). */
export function vehicleOkLine({ repo, prNumber, verdict: v }) {
  const head = `enqueue-pr: landing vehicle: #${prNumber} on ${repo}`;
  switch (v.reason) {
    case 'dependabot': return `${head} is a Dependabot PR (not checked).`;
    case 'train': return `${head} is an area train (${v.vehicle?.kind}).`;
    case 'automated': return `${head} is an automated base-image re-pin (docker/base-repin-*).`;
    case 'incident': return `${head} is an incident PR for open ${v.vehicle?.ticket}.`;
    case 'incident_exempt': return `${head} is an incident PR released by a ${v.exempt?.role} budget-exempt review.`;
    case 'feature': return `${head} is a feature PR (${v.facts?.tickets.length} ticket(s), ${v.facts?.owners.length} owner(s)).`;
    case 'grandfathered': return `WARN: ${head} is not a landing vehicle, but it was opened before the ${CUTOVER_ISO} cutover, so it is allowed until ${GRANDFATHER_UNTIL_ISO} (TL p/9#628). After that, land changes like it on an area train: ${TRAIN_LIST}.`;
    default: return `${head}: ${v.reason}.`;
  }
}

/** PURE. The refusal message. Keeps the "refusing to arm/enqueue #N on <repo> (<reason>)" shape the sweeps classify. */
export function vehicleRefusalMessage({ repo, prNumber, verdict: v }) {
  const problem = {
    not_a_vehicle: `${v.detail}.`,
    feature_too_small: `${v.detail}.`,
    incident_not_open: `${v.detail}.`,
    vehicle_read_failed: `could not read what the vehicle check needs (${v.detail ?? 'unknown error'}). An unreadable fact is a refusal, not a pass.`,
    budget_exempt_invalid: `the named budget-exempt review does not release #${prNumber}: ${v.detail ?? 'unknown'}.`,
    budget_exempt_not_incident: `--budget-exempt-review is accepted only for an incident PR (incident/t<N>-<slug>); #${prNumber}'s head branch is "${v.branch ?? '?'}".`,
  }[v.reason] ?? `unexpected vehicle verdict ${JSON.stringify(v.reason)}.`;
  const steps = v.reason === 'vehicle_read_failed'
    ? 'check `gh auth status`, the API rate limit and the local Interweave daemon, then rerun.'
    : `land the change on your area's train (${TRAIN_LIST}; owners in t/567), which closes at 06:00Z and 18:00Z. ` +
      `A feature PR (feat/t<N>-<slug>) is for a change spanning ${FEATURE_MIN_TICKETS}+ tickets or ${FEATURE_MIN_OWNERS}+ owners, listed in the body's ticket table. ` +
      'An incident PR (incident/t<N>-<slug>) needs an open ticket titled INCIDENT.';
  return `enqueue-pr: refusing to arm/enqueue #${prNumber} on ${repo} (${v.reason}).\n` +
    `  Goal:       land #${prNumber} in a landing vehicle (docs/pr-landing.md, t/655).\n` +
    `  Problem:    ${problem}\n` +
    '  Location:   operations/devops/landing-vehicle.mjs (vehicleVerdict, t/656).\n' +
    `  Next steps: ${steps}`;
}

/** Reads one ticket's { title, status } from the local Interweave daemon. Throws on any failure. */
export async function readTicketViaDaemon(id, { daemon = DEFAULT_DAEMON } = {}) {
  const appRun = makeAppRun(assertLoopback(daemon));
  const t = await appRun('tickets', 'get', { id });
  if (!t || typeof t.title !== 'string' || typeof t.status !== 'string') throw new Error(`${id}: no title/status returned`);
  return { title: t.title, status: t.status };
}

/**
 * The vehicle check enqueuePR runs. Never throws. Returns the verdict plus { pr, calls } (the same
 * contract enqueuePR used for the budget check: allow, reason, detail, pr.headRefOid).
 */
export async function checkLandingVehicle(repo, prNumber, { gh: ghFn, exemptReviewId = null, by = null, now = Date.now(), readTicket = readTicketViaDaemon, log = console.log, warn = console.warn } = {}) {
  const nowIso = new Date(now).toISOString();
  let pr;
  try {
    pr = ghFn ? readPrFacts(repo, prNumber, ghFn) : readPrFacts(repo, prNumber);
  } catch (err) {
    warn(`WARN: enqueue-pr could not read #${prNumber} on ${repo} for the landing-vehicle check (${firstLine(err)}); refusing.`);
    return { allow: false, reason: 'vehicle_read_failed', detail: `reading #${prNumber} failed: ${firstLine(err)}`, calls: 1 };
  }
  const v = classifyBranch(pr.headRefName);
  let exempt = null;
  if (exemptReviewId != null) {
    if (v.kind !== 'incident' || isDependabotAuthor(pr.author)) return { allow: false, reason: 'budget_exempt_not_incident', branch: pr.headRefName, pr, calls: 1 };
    if (!(typeof by === 'string' && by.trim())) return { allow: false, reason: 'budget_exempt_invalid', detail: '--budget-exempt-review was given without --by, so the exemption cannot be attributed', pr, calls: 1 };
    const { review, error } = ghFn ? fetchExemptReview(repo, prNumber, exemptReviewId, ghFn) : fetchExemptReview(repo, prNumber, exemptReviewId);
    if (error) warn(`WARN: enqueue-pr could not read review ${exemptReviewId} on #${prNumber} (${firstLine(error)}); refusing.`);
    exempt = exemptionVerdict({ review, headSha: pr.headRefOid });
    if (!exempt.valid) return { allow: false, reason: 'budget_exempt_invalid', detail: exempt.detail, pr, calls: 2 };
    log(exemptLogLine({ repo, prNumber, headSha: pr.headRefOid, reviewId: exemptReviewId, role: exempt.role, by: by.trim(), reason: exempt.reason, at: nowIso }));
  }
  let ticket = null;
  let ticketError = null;
  if (v.kind === 'incident' && !exempt) {
    try {
      ticket = await readTicket(v.ticket);
    } catch (err) {
      ticketError = firstLine(err);
      warn(`WARN: enqueue-pr could not read ${v.ticket} for the incident check (${ticketError}); refusing.`);
    }
  }
  return { ...vehicleVerdict({ pr, nowIso, ticket, ticketError, exempt }), pr, calls: exempt ? 2 : 1 };
}

function firstLine(err) {
  return String(err?.stderr || err?.message || err).trim().split('\n')[0];
}
