// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/718 step 1 (report-only): the daily worktree sweep's remote-branch pass. GitHub offers 'Compare & pull request' for any
// branch pushed recently by the signed-in user that has no open PR, and every agent pushes as the PI's login, so the main
// page shows a row of banners that look like PRs waiting for a click. This pass lists every origin branch with no open PR
// and says, for each, whether ALL its commits are already on origin/main. It NEVER deletes anything and raises no WARN
// (the wrapper pings WARN lines; this pass is a log and a summary until the TL has read the first report).
//
// Per branch (after `git fetch --prune origin`):
//   ancestor           the tip is an ancestor of origin/main
//   patch-equivalent   `git cherry origin/main <tip>` shows no `+` line (the squash-merge and cherry-pick case)
//   unmerged: N        N commits have no equivalent on origin/main
// Never considered, whatever their state: main, backup/*, tags/*, incident/*, gh-readonly-queue/*, and any branch with an open
// PR (an open PR includes a queued one). They are counted as 'protected', never listed as deletable.
// Fail closed: if the fetch, the branch list or the open-PR list cannot be read, the pass says 'could not evaluate' and lists
// NO branch as merged.

import { execFileSync } from 'node:child_process';

export const PROTECTED_PREFIXES = Object.freeze(['backup/', 'tags/', 'incident/', 'gh-readonly-queue/']);
export const PROTECTED_EXACT = Object.freeze(['main']);

/** PURE. Why a branch is never considered, or null. `open` is the set of branch names with an open PR from this repository. */
export function protectedReason(name, open) {
  if (PROTECTED_EXACT.includes(name)) return 'main';
  const pre = PROTECTED_PREFIXES.find((p) => name.startsWith(p));
  if (pre) return pre;
  if (open.has(name)) return 'open PR';
  return null;
}

/** PURE. `git for-each-ref --format='%(refname)%09%(objectname)%09%(committerdate:iso-strict)' refs/remotes/origin` -> [{ name, sha, date }]. `origin/HEAD` is skipped. */
export function parseRemoteBranches(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [ref, sha, date] = line.split('\t');
    const m = /^refs\/remotes\/origin\/(.+)$/.exec(ref ?? '');
    if (m && m[1] === 'HEAD') continue;   // origin/HEAD is a symbolic ref, not a branch
    if (!m || !/^[0-9a-f]{40}$/.test(sha ?? '')) throw new Error(`unreadable branch line: ${line.slice(0, 80)}`);
    out.push({ name: m[1], sha, date: date ?? '' });
  }
  return out;
}

/** PURE. The ticket id in a branch name (t731, t/731, feat/t731-x), or null. */
export function ticketOf(name) {
  const m = /(?:^|[^a-z0-9])t\/?(\d{1,5})(?!\d)/i.exec(name);
  return m ? `t/${m[1]}` : null;
}

/** PURE. The merge state from the two git facts. `cherryLines`: the output of `git cherry origin/main <tip>`. */
export function mergeStateOf({ isAncestor, cherryLines }) {
  if (isAncestor) return { state: 'ancestor', unmerged: 0 };
  const plus = cherryLines.filter((l) => l.startsWith('+')).length;
  return plus === 0 ? { state: 'patch-equivalent', unmerged: 0 } : { state: 'unmerged', unmerged: plus };
}

/**
 * PURE. The report from already-read facts. `branches`: [{ name, sha, date, state?, unmerged? }] for the unprotected ones is
 * not needed here: pass every branch with its mergeState filled in by the caller for those it computed.
 */
export function buildReport({ branches, open, merge }) {
  const lines = [];
  const counts = { withoutPr: 0, ancestor: 0, patchEquivalent: 0, unmerged: 0, protected: 0 };
  for (const b of branches) {
    if (protectedReason(b.name, open)) { counts.protected++; continue; }
    const m = merge(b);
    counts.withoutPr++;
    if (m.state === 'ancestor') counts.ancestor++;
    else if (m.state === 'patch-equivalent') counts.patchEquivalent++;
    else counts.unmerged++;
    const detail = m.state === 'unmerged' ? `unmerged: ${m.unmerged} commit${m.unmerged === 1 ? '' : 's'}` : m.state;
    lines.push(`remote-branch: ${detail} ${b.name} tip=${b.sha.slice(0, 9)} pushed=${b.date.slice(0, 10)} ticket=${ticketOf(b.name) ?? 'none'}`);
  }
  const summary = `remote branches: ${counts.withoutPr} without a PR; ${counts.ancestor} ancestor, ${counts.patchEquivalent} patch-equivalent, ${counts.unmerged} unmerged; ${counts.protected} protected (report only, nothing deleted)`;
  return { lines, summary, counts };
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
}
function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
}

/** `owner/repo` from origin's URL. */
export function repoSlugOf(url) {
  const m = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\s*$/.exec(String(url ?? '').trim());
  return m ? m[1] : null;
}

/**
 * Reads origin's branches and the open PRs and returns { evaluated, lines, summary, counts, reason }. Never throws. Report only.
 * `fetch`: false skips the fetch (tests that built the remote-tracking refs themselves).
 */
export function remoteBranchPass({ gitFn = git, ghFn = gh, repoSlug, fetch = true } = {}) {
  const fail = (reason) => ({ evaluated: false, lines: [], summary: `remote branches: could not evaluate (${reason}); nothing listed as merged`, counts: null, reason });
  let slug = repoSlug;
  try {
    if (!slug) slug = repoSlugOf(gitFn(['remote', 'get-url', 'origin']));
    if (!slug) return fail('origin is not a GitHub repository');
    if (fetch) gitFn(['fetch', '--prune', '--quiet', 'origin']);
    gitFn(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main']);
  } catch (err) {
    return fail(`git: ${String(err?.message ?? err).split('\n')[0].slice(0, 120)}`);
  }
  let branches;
  try {
    branches = parseRemoteBranches(gitFn(['for-each-ref', '--format=%(refname)%09%(objectname)%09%(committerdate:iso-strict)', 'refs/remotes/origin']));
  } catch (err) {
    return fail(`branch list: ${String(err?.message ?? err).slice(0, 120)}`);
  }
  const open = new Set();
  try {
    const out = ghFn(['api', '--paginate', `repos/${slug}/pulls?state=open&per_page=100`, '--jq', '.[] | [.head.ref, (.head.repo.full_name // "")] | @json']);
    for (const l of out.split(/\r?\n/).filter((x) => x.trim())) {
      const [ref, full] = JSON.parse(l);
      if (typeof ref !== 'string' || !ref) throw new Error('a PR without a head ref');
      if (full === slug) open.add(ref);   // a fork's branch of the same name is not this repository's branch
    }
  } catch (err) {
    return fail(`open PR list: ${String(err?.message ?? err).split('\n')[0].slice(0, 120)}`);
  }
  let mergeError = null;
  const merge = (b) => {
    try {
      let isAncestor = false;
      try { gitFn(['merge-base', '--is-ancestor', b.sha, 'refs/remotes/origin/main']); isAncestor = true; } catch (e) { if (e?.status !== 1) throw e; }
      const cherryLines = isAncestor ? [] : gitFn(['cherry', 'refs/remotes/origin/main', b.sha]).split(/\r?\n/).filter(Boolean);
      return mergeStateOf({ isAncestor, cherryLines });
    } catch (err) {
      mergeError = err;
      return { state: 'unmerged', unmerged: -1 };
    }
  };
  const report = buildReport({ branches, open, merge });
  if (mergeError) return fail(`merge state: ${String(mergeError?.message ?? mergeError).split('\n')[0].slice(0, 120)}`);
  return { evaluated: true, ...report };
}
