#!/usr/bin/env node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/371: every PR's GitHub author is the shared `jpsnover` login, so `gh pr list --author @me`
// lists everyone's PRs and agents can't tell which are theirs. This lists the open PRs one agent
// owns, by the same facts a person would use (see claim() for the precedence):
//   (a) TICKET: the PR's title or branch (else its body) cites a ticket assigned to the agent,
//       in any status. Bodies cite others' tickets for context, so they only count when the
//       title and branch name none.
//   (b) FILES, only for PRs that cite no ticket at all: more than half of the changed files
//       resolve to the agent (org-chart resolve-owner).
// Ticket assignees and ownership come from the local Interweave daemon (MCP over HTTP, no GitHub
// cost). GitHub cost (t/313): one paginated list of open PRs; one REST call per PR with no ticket
// ref (its file list, cached on disk per head SHA, so a re-run is free); and one GraphQL query
// for the owned PRs' checks and reviews together.
//
// Usage: node operations/devops/my-prs.mjs --agent <collaborator id> [--json]
//          [--repo owner/name] [--daemon http://127.0.0.1:7420] [--no-files]

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { latestRoleVerdicts } from './role-review-verdicts.mjs';

export const REVIEWER_APP_LOGIN = 'ai-triad-reviewer-jpsnover'; // GraphQL form (no [bot]), as t0-enqueue-sweep.mjs
const TICKET_STATUSES = ['Open', 'InProgress', 'Done'];
const FAILING = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR']);

// ── pure ──────────────────────────────────────────────────────────────────────────────────────

/** Ticket numbers a PR cites, split by weight. `primary`: the title and branch, which name the
 *  PR's own ticket, in the loose `t292` / `t-292` / `t/292` forms agents use there. `body`: the
 *  canonical `t/N` only (bodies carry SHAs, run ids and tier tags the loose form would misread),
 *  and bodies also cite other people's tickets for context ("child of t/313", "your t/318"). */
export function ticketRefs({ title = '', body = '', branch = '' }) {
  const primary = new Set();
  const loose = /(?<![A-Za-z0-9])t[/-]?(\d{1,6})(?![0-9])/g;
  for (const s of [title, branch]) for (const m of String(s ?? '').matchAll(loose)) primary.add(Number(m[1]));
  const inBody = new Set();
  for (const m of String(body ?? '').matchAll(/(?<![A-Za-z0-9])t\/(\d{1,6})(?![0-9])/g)) inBody.add(Number(m[1]));
  return { primary, body: inBody };
}

/** The owner of more than half the files, or null. `owners` is one owner id (or null) per file. */
export function majorityOwner(owners) {
  if (!owners.length) return null;
  const counts = new Map();
  for (const o of owners) if (o) counts.set(o, (counts.get(o) ?? 0) + 1);
  for (const [o, n] of counts) if (n * 2 > owners.length) return { owner: o, count: n, of: owners.length };
  return null;
}

/** Returns { owned, why, needsFiles } for one PR. The most specific evidence decides:
 *   1. the title/branch tickets: the PR is the agent's if any of them is the agent's, and is NOT
 *      (whatever its body or files say) if none is, because it names someone else's ticket;
 *   2. with no title/branch ticket, the body's `t/N` refs the same way;
 *   3. with no ticket ref at all (Dependabot, untagged PRs), the majority owner of its files. */
export function claim({ refs, myTickets, fileOwners, agent }) {
  const mine = (set) => [...set].filter((n) => myTickets.has(n)).sort((x, y) => x - y);
  const cite = (ns, where) => ({ owned: true, why: `${where} cites ${ns.map((n) => `t/${n}`).join(', ')}`, needsFiles: false });
  for (const [set, where] of [[refs.primary, 'title/branch'], [refs.body, 'body']]) {
    if (!set.size) continue;
    const hit = mine(set);
    return hit.length ? cite(hit, where) : { owned: false, why: '', needsFiles: false };
  }
  if (!fileOwners) return { owned: false, why: '', needsFiles: true };
  {
    const m = majorityOwner(fileOwners);
    if (m && m.owner === agent) return { owned: true, why: `no ticket ref; owns ${m.count}/${m.of} changed files`, needsFiles: false };
  }
  return { owned: false, why: '', needsFiles: false };
}

/** Failing check names and open blocks (changes-requested per role, hold labels) for one PR's GraphQL node. */
export function prStatus(node) {
  const commit = node.commits?.nodes?.[0]?.commit;
  const contexts = commit?.statusCheckRollup?.contexts?.nodes ?? [];
  const failing = [...new Set(contexts
    .filter((c) => FAILING.has(String(c.conclusion ?? c.state ?? '').toUpperCase()))
    .map((c) => c.name ?? c.context))].sort();
  const pending = contexts.filter((c) => c.status && c.status !== 'COMPLETED' || c.state === 'PENDING').length;
  const verdicts = latestRoleVerdicts({
    reviews: (node.reviews?.nodes ?? []).map((r) => ({ body: r.body, login: r.author?.login ?? null, commitId: r.commit?.oid ?? null, submittedAt: r.submittedAt, state: r.state })),
    comments: (node.comments?.nodes ?? []).map((c) => ({ body: c.body, login: c.author?.login ?? null, createdAt: c.createdAt, updatedAt: c.lastEditedAt ?? null })),
    reviewerAppLogin: REVIEWER_APP_LOGIN, headSha: node.headRefOid, lastPushAt: commit?.committedDate ?? null, mode: 'gate',
  });
  const blocks = [...verdicts.values()].filter((v) => v.kind === 'changes_requested').map((v) => `changes requested (${v.role})`);
  const approvals = [...verdicts.values()].filter((v) => v.kind === 'approved' && v.atHead).map((v) => v.role);
  const holds = (node.labels?.nodes ?? []).map((l) => l.name).filter((n) => /^(consult-hold|joint-gv|no-auto-enqueue)$/.test(n));
  return { failing, pending, blocks, approvals, holds, inQueue: !!node.isInMergeQueue };
}

export function formatPr(pr) {
  const s = pr.status;
  const lines = [`#${pr.number}  ${pr.draft ? 'draft' : 'ready'}  ${pr.sha.slice(0, 9)}  ${pr.title}`, `    why: ${pr.why}`];
  if (s) {
    lines.push(`    checks: ${s.failing.length ? `FAILING ${s.failing.join(', ')}` : 'none failing'}${s.pending ? ` (${s.pending} pending)` : ''}${s.inQueue ? '; in merge queue' : ''}`);
    lines.push(`    reviews: ${[...s.blocks, ...s.holds.map((h) => `label ${h}`)].join('; ') || 'no blocks'}${s.approvals.length ? `; approved at head: ${s.approvals.join(', ')}` : ''}`);
  }
  return lines.join('\n');
}

// ── I/O ───────────────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const o = { repo: 'AI-Rosetta-Stone/ai-triad-research', daemon: process.env.INTERWEAVE_DAEMON_URL || 'http://127.0.0.1:7420', files: true, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--agent') o.agent = argv[++i];
    else if (a === '--repo') o.repo = argv[++i];
    else if (a === '--daemon') o.daemon = argv[++i];
    else if (a === '--no-files') o.files = false;
    else if (a === '--json') o.json = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.agent) throw new Error('missing --agent <collaborator id> (your own id, from your prompt)');
  return o;
}

let rpcId = 0;
async function appRun(daemon, app, command, args) {
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
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

function mainCheckoutRoot() {
  // resolve-owner answers for the shared checkout's paths; from a worktree, use its common dir's parent.
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
  return path.dirname(common);
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const warn = (m) => console.error(`my-prs: WARN ${m}`);

  const myTickets = new Set();
  for (const status of TICKET_STATUSES) {
    const r = await appRun(o.daemon, 'tickets', 'list', { assignee: o.agent, status });
    for (const t of r.tickets ?? []) myTickets.add(Number(String(t.id).replace(/^t\//, '')));
  }

  const prs = gh(['api', '--paginate', `repos/${o.repo}/pulls?state=open&per_page=100`,
    '--jq', '.[] | {number, title, body, branch: .head.ref, sha: .head.sha, draft}'])
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));

  const root = o.files ? mainCheckoutRoot() : null;
  const cacheDir = path.join(tmpdir(), 'aitriad-my-prs', o.repo.replace('/', '_'));
  if (o.files) mkdirSync(cacheDir, { recursive: true });
  const dirOwner = new Map();
  const ownerOf = async (file) => {
    const dir = path.posix.dirname(file);
    if (!dirOwner.has(dir)) {
      try {
        const r = await appRun(o.daemon, 'org-chart', 'resolve-owner', { path: path.join(root, file) });
        dirOwner.set(dir, r.collaborator?.id ?? null);
      } catch (e) { warn(`resolve-owner failed for ${file} (${e.message}); counted as unowned`); dirOwner.set(dir, null); }
    }
    return dirOwner.get(dir);
  };

  const owned = [];
  let restCalls = 0;
  for (const pr of prs) {
    const refs = ticketRefs(pr);
    let fileOwners = null;
    if (o.files && claim({ refs, myTickets, fileOwners: null, agent: o.agent }).needsFiles) {
      const cache = path.join(cacheDir, `${pr.number}-${pr.sha}.json`);
      let files;
      if (existsSync(cache)) files = JSON.parse(readFileSync(cache, 'utf8'));
      else {
        try {
          files = gh(['api', '--paginate', `repos/${o.repo}/pulls/${pr.number}/files?per_page=100`, '--jq', '.[].filename']).split('\n').filter(Boolean);
          restCalls++;
          writeFileSync(cache, JSON.stringify(files));
        } catch (e) { warn(`could not list files of #${pr.number} (${String(e.message).split('\n')[0]}); judged by ticket refs only`); files = []; }
      }
      fileOwners = [];
      for (const f of files) fileOwners.push(await ownerOf(f));
    }
    const c = claim({ refs, myTickets, fileOwners, agent: o.agent });
    if (c.owned) owned.push({ ...pr, why: c.why });
  }

  if (owned.length) {
    const fields = 'number headRefOid isInMergeQueue labels(first:20){nodes{name}} '
      + 'commits(last:1){nodes{commit{committedDate statusCheckRollup{contexts(first:100){nodes{__typename ... on CheckRun{name status conclusion} ... on StatusContext{context state}}}}}}} '
      + 'reviews(last:50){nodes{author{login} body state submittedAt commit{oid}}} comments(last:50){nodes{author{login} body createdAt lastEditedAt}}';
    const [owner, name] = o.repo.split('/');
    const q = `query{repository(owner:"${owner}",name:"${name}"){${owned.map((p) => `p${p.number}:pullRequest(number:${p.number}){${fields}}`).join(' ')}}}`;
    try {
      const data = JSON.parse(gh(['api', 'graphql', '-f', `query=${q}`])).data.repository;
      for (const p of owned) if (data[`p${p.number}`]) p.status = prStatus(data[`p${p.number}`]);
    } catch (e) { warn(`could not read checks/reviews (${String(e.message).split('\n')[0]}); listing without them`); }
  }

  owned.sort((a, b) => a.number - b.number);
  if (o.json) console.log(JSON.stringify({ agent: o.agent, tickets: [...myTickets].sort((a, b) => a - b), prs: owned, githubCalls: { listPages: 'paginated', perPrFileLists: restCalls, graphql: owned.length ? 1 : 0 } }, null, 2));
  else {
    console.log(owned.length ? owned.map(formatPr).join('\n') : 'No open PRs for this agent.');
    console.error(`my-prs: ${prs.length} open PRs scanned; ${myTickets.size} tickets; ${restCalls} file-list calls (rest cached or skipped); ${owned.length ? 1 : 0} GraphQL query.`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`my-prs: ERROR ${e.message}`); process.exit(1); });
}
