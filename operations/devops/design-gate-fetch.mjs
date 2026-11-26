// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/752: the reads behind the Design gate for a caller that has only `gh` (enqueue-pr.mjs). The
// verdict itself is design-gate.mjs (pure). merge-approval-run.mjs reads the same facts through
// Octokit and calls the same earliestCheckRunStartMs.

import { execFileSync } from 'node:child_process';
import { BLOCKING_REVIEW_ASSOCIATIONS, COMMENT_APPROVER_ALLOWLIST, REVIEWER_APP_REST_LOGIN } from './t1-approval-at-head.mjs';
import { earliestCheckRunStartMs } from './design-gate.mjs';

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

/**
 * Reads the reviews, comments and push time of one PR head, in the shapes designGateVerdict takes.
 * Never throws: a failure returns { error } and the caller refuses (fail closed).
 * Reviews: the reviewer App's and write-level humans' (as merge-approval reads them). Comments:
 * only the reviewer App's. Push time: the earliest check-run start on the head (the sweeps' proxy).
 */
export function fetchDesignGateInputs(repo, prNumber, headSha, ghFn = gh) {
  try {
    const pages = (path) => {
      const out = JSON.parse(ghFn(['api', '-X', 'GET', '--paginate', '--slurp', path]));
      if (!Array.isArray(out) || !out.every(Array.isArray)) throw new Error(`${path} did not return a list of pages`);
      return out.flat();
    };
    const reviews = pages(`repos/${repo}/pulls/${prNumber}/reviews?per_page=100`)
      .filter((r) => r?.user?.login === REVIEWER_APP_REST_LOGIN || BLOCKING_REVIEW_ASSOCIATIONS.includes(r?.author_association))
      .map((r) => ({ state: r.state, submittedAt: r.submitted_at, login: r.user?.login, body: r.body, commitId: r.commit_id }));
    const comments = pages(`repos/${repo}/issues/${prNumber}/comments?per_page=100`)
      .filter((c) => COMMENT_APPROVER_ALLOWLIST.includes(c?.user?.login))
      .map((c) => ({ body: c.body, createdAt: c.created_at, updatedAt: c.updated_at, login: c.user?.login }));
    const runPages = JSON.parse(ghFn(['api', '-X', 'GET', '--paginate', '--slurp', `repos/${repo}/commits/${headSha}/check-runs?per_page=100`]));
    if (!Array.isArray(runPages)) throw new Error('the check-runs read did not return a list of pages');
    const pushedAtMs = earliestCheckRunStartMs(runPages.flatMap((p) => p?.check_runs ?? []));
    return { reviews, comments, pushedAtMs, error: null };
  } catch (err) {
    return { reviews: null, comments: null, pushedAtMs: null, error: err };
  }
}
