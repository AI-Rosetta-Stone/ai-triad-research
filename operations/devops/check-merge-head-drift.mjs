// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Post-merge observability detector (t/4858): for each recently-merged PR, confirms the
// merge commit actually shipped the content of the PR's own final head, file by file.
//
// WHY: t/4858 found PR #4489 merged (as commit `0de47809`) with the content of an EARLIER
// head (`acf344e7`) despite GitHub reporting it merged and its true final head being
// `4f9ba173` -- a real commit on the PR, never shipped, silently. "Merged" was green while
// the shipped content was stale, and nothing noticed until a human spotted the missing
// behavior days later. This check would have caught it within the hour.
//
// METHOD, per changed file: compare the blob SHA at the PR's headRefOid against the blob SHA
// at the same path in the merge commit. BUT a raw blob-equality check is only valid when
// mainline (the merge commit's first parent) never touched that file after the PR's own
// merge-base -- hot files like ci.yml/AGENTS.md routinely get touched by several concurrent
// PRs, and a squash merge correctly recombines all of them, so the final blob legitimately
// differs from any single PR's own head blob even though that PR's change landed intact
// (first version of this script flagged ~90% of real, correct merges on exactly this false
// positive -- caught by a smoke-test comparison against known-good recent merges before
// landing). So: for each file, first check whether mainline changed it between the PR's
// merge-base and the merge commit's parent (`git log <prBase>..<mergeParent> -- path`). If
// NOT, blob equality is precise and a mismatch is real drift. If mainline DID touch it, this
// check cannot cleanly attribute a blob mismatch to either side -- it is reported separately
// as `skippedConcurrent`, never silently treated as clean.
//
// `git ls-tree`/`git log` read blob SHAs and history without materializing file content, so
// this is cheap even for many files. Commits must be present locally (git fetch origin <sha>
// if missing) -- GitHub keeps a merged PR's head commit reachable for a good while after the
// branch is deleted (confirmed empirically for #4489's head, 18+ hours post-merge), but a head
// beyond retention, or outside the scan's own --since lookback, reads as QueryError on that
// PR, never as clean.
//
// Pure core (`computeDrift`) is unit-tested; gh/git calls are the impure shim, same split as
// enqueue-pr.mjs / t0-enqueue-sweep.mjs.
//
//   node operations/devops/check-merge-head-drift.mjs <owner>/<repo> [--since-days=14]

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * PURE. Given a map of { path -> { headBlob, mergeBlob, touchedByMainline } }, returns:
 *  - drifted: files NOT touched by mainline in between, where head's blob != the merge
 *    commit's blob -- real drift, precisely attributed to this PR's own change going missing.
 *  - skippedConcurrent: files mainline also touched in between -- blob equality can't
 *    distinguish "my change landed, combined with theirs" from "my change was dropped",
 *    so these are reported separately, never silently folded into either bucket.
 *  - unreadable: a blob on either side couldn't be read at all.
 */
export function computeDrift(blobsByPath) {
  const drifted = [];
  const skippedConcurrent = [];
  const unreadable = [];
  for (const [path, { headBlob, mergeBlob, touchedByMainline }] of Object.entries(blobsByPath)) {
    if (headBlob == null || mergeBlob == null) { unreadable.push(path); continue; }
    if (touchedByMainline) { skippedConcurrent.push(path); continue; }
    if (headBlob !== mergeBlob) drifted.push(path);
  }
  return { drifted, skippedConcurrent, unreadable };
}

/** PURE. One finding line per drifted PR, for the GitHub comment / console report. */
export function formatFinding({ number, headRefOid, mergeCommitOid, drifted, skippedConcurrent, unreadable }) {
  const lines = [`PR #${number}: head ${headRefOid.slice(0, 8)} vs merge commit ${mergeCommitOid.slice(0, 8)}`];
  if (drifted.length) lines.push(`  DRIFTED (this PR's change is missing from the merge): ${drifted.join(', ')}`);
  if (skippedConcurrent.length) lines.push(`  skipped (also touched by mainline concurrently, can't attribute cleanly): ${skippedConcurrent.join(', ')}`);
  if (unreadable.length) lines.push(`  UNREADABLE (not evaluated, not clean): ${unreadable.join(', ')}`);
  return lines.join('\n');
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}
function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

function listMergedPRs(repo, sinceDays) {
  const since = new Date(Date.now() - sinceDays * 86400000).toISOString().slice(0, 10);
  const query = `query($q:String!,$cursor:String){search(query:$q,type:ISSUE,first:50,after:$cursor){
    pageInfo{hasNextPage endCursor}
    nodes{... on PullRequest{number headRefOid mergeCommit{oid parents(first:1){nodes{oid}}} files(first:100){nodes{path}}}}}}`;
  const prs = [];
  let cursor = null;
  for (let page = 0; page < 10; page++) {
    const args = ['api', 'graphql', '-f', `query=${query}`,
      '-f', `q=repo:${repo} is:pr is:merged base:main merged:>=${since}`];
    if (cursor) args.push('-f', `cursor=${cursor}`);
    const r = JSON.parse(gh(args)).data.search;
    for (const n of r.nodes) {
      prs.push({
        number: n.number,
        headRefOid: n.headRefOid,
        mergeCommitOid: n.mergeCommit?.oid ?? null,
        mergeParentOid: n.mergeCommit?.parents?.nodes?.[0]?.oid ?? null,
        files: n.files.nodes.map((f) => f.path),
      });
    }
    if (!r.pageInfo.hasNextPage) break;
    cursor = r.pageInfo.endCursor;
  }
  return prs;
}

/** Ensures a commit object is present locally, fetching it if not. Returns false if neither works. */
function ensureCommit(sha) {
  try { git(['cat-file', '-e', sha]); return true; } catch { /* fall through to fetch */ }
  try { git(['fetch', '--quiet', 'origin', sha]); git(['cat-file', '-e', sha]); return true; }
  catch { return false; }
}

/** Blob SHA of a path at a commit, or null if the path doesn't exist there or the commit is unreadable. */
function blobAt(sha, path) {
  try {
    const out = git(['ls-tree', sha, '--', path]).trim();
    const match = out.match(/^\S+\s+blob\s+(\S+)/);
    return match ? match[1] : null;
  } catch { return null; }
}

/** True if any commit touched `path` strictly between `fromSha` (exclusive) and `toSha` (inclusive). */
function touchedBetween(fromSha, toSha, path) {
  try {
    const out = git(['log', '--oneline', `${fromSha}..${toSha}`, '--', path]).trim();
    return out.length > 0;
  } catch { return true; } // can't determine -> don't risk a false "clean"; treat as touched (skip, not flag)
}

export async function scan(repo, { sinceDays = 14 } = {}) {
  const prs = listMergedPRs(repo, sinceDays);
  const findings = [];
  const queryErrors = [];
  for (const pr of prs) {
    if (!pr.mergeCommitOid || !pr.mergeParentOid) {
      queryErrors.push({ number: pr.number, reason: 'no mergeCommit or parent recorded' });
      continue;
    }
    const headOk = ensureCommit(pr.headRefOid);
    const mergeOk = ensureCommit(pr.mergeCommitOid) && ensureCommit(pr.mergeParentOid);
    if (!headOk || !mergeOk) {
      queryErrors.push({
        number: pr.number,
        reason: `commit unreachable (head ${headOk ? 'ok' : 'MISSING'}, merge/parent ${mergeOk ? 'ok' : 'MISSING'})`,
      });
      continue;
    }
    const prBase = (() => {
      try { return git(['merge-base', pr.headRefOid, pr.mergeParentOid]).trim(); } catch { return null; }
    })();
    const blobsByPath = {};
    for (const path of pr.files) {
      const touchedByMainline = prBase ? touchedBetween(prBase, pr.mergeParentOid, path) : true;
      blobsByPath[path] = {
        headBlob: blobAt(pr.headRefOid, path),
        mergeBlob: blobAt(pr.mergeCommitOid, path),
        touchedByMainline,
      };
    }
    const { drifted, skippedConcurrent, unreadable } = computeDrift(blobsByPath);
    if (drifted.length) {
      findings.push({
        number: pr.number, headRefOid: pr.headRefOid, mergeCommitOid: pr.mergeCommitOid,
        drifted, skippedConcurrent, unreadable,
      });
    }
  }
  return { checked: prs.length, findings, queryErrors };
}

const isCliEntry = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCliEntry) {
  const repo = process.argv[2];
  if (!repo) {
    console.error('Usage: node operations/devops/check-merge-head-drift.mjs <owner>/<repo> [--since-days=N]');
    process.exit(1);
  }
  const sinceArg = process.argv.find((a) => a.startsWith('--since-days='));
  const sinceDays = sinceArg ? Number(sinceArg.split('=')[1]) || 14 : 14;
  scan(repo, { sinceDays }).then(
    ({ checked, findings, queryErrors }) => {
      console.log(`check-merge-head-drift: checked ${checked} merged PR(s) over the last ${sinceDays} day(s).`);
      for (const q of queryErrors) console.log(`::warning::#${q.number}: UNREADABLE -- ${q.reason}`);
      for (const f of findings) console.log(`::error::${formatFinding(f)}`);
      if (findings.length) {
        console.log(`check-merge-head-drift: ${findings.length} PR(s) merged with content that doesn't match their final head.`);
        process.exit(1);
      }
      console.log('check-merge-head-drift: clean -- every merge commit matches its PR\'s final head.');
    },
    (err) => { console.error(err.message ?? err); process.exit(1); },
  );
}
