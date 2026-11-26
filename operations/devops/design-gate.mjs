// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/752 (t/739, incident PR 2): THE Design gate. docs/review-routing.md: a user-facing PR arms
// only after Design passes it, at every tier. Until now the rule lived inline in the T0/T1 enqueue
// sweeps (t0-enqueue-sweep.mjs sharedSkipReason) and nowhere else, so a hand enqueue (enqueue-pr.mjs)
// or a merge around it (merge-approval) needed no Design verdict (#5598 merged on Quality's approval
// alone). The sweeps, enqueue-pr.mjs and merge-approval (rule D) all call designGateVerdict, so one
// set of facts gives one verdict.
//
// WHAT COUNTS. The Design role's LATEST verdict (role-review-verdicts.mjs, default mode) must be
// `Approved (Design):` or `Design-exempt (Design): <reason>`, from the reviewer App: a REVIEW bound to
// the head (commit_id === headSha), or a COMMENT posted after the head's push time. A
// `Changes requested (Design):` later than either blocks. A dismissed review counts for nothing.
// The push time is the earliest check-run start on the head, the sweeps' proxy (headPushedAt): a
// committer date is author-controlled. When it is unknown no comment counts (only a head-bound
// review does), which is stricter than the sweeps' old reading of "no push time".
// An exemption is only ever the reviewer App's `Design-exempt (Design): <reason>` with a non-empty
// reason; a line in the PR body never exempts (the author writes the body).
//
// This file is pure. The reads (files, reviews, comments, check runs) are the callers'.

import { latestRoleVerdicts } from './role-review-verdicts.mjs';
import { isUserFacingPath } from './design-review-scope.mjs';

export const DESIGN_ROLE = 'Design';

const isDesign = (role) => String(role ?? '').toLowerCase().replace(/[^a-z]/g, '') === 'design';

/** PURE. Path strings from a files list of strings, `{path}` (gh) or `{filename, previous_filename}` (REST). */
export function filePaths(files) {
  return (files ?? []).flatMap((f) => {
    if (typeof f === 'string') return [f];
    return [f?.path ?? f?.filename, f?.previous_filename].filter((p) => typeof p === 'string' && p);
  });
}

/**
 * PURE. The Design gate for one PR at one head.
 *   files:          the changed files (strings, `{path}` or `{filename, previous_filename}`), or null
 *   filesTruncated: the list is known to be cut short
 *   reviews:        predicate-shaped reviews { login, state, submittedAt, commitId, body }
 *   comments:       predicate-shaped comments { login, body, createdAt, updatedAt }
 *   pushedAtMs:     the head's push time in ms (earliest check-run start), or null when unknown
 * Returns { applies, pass, kind, at, reason, paths }. `applies` is false when no changed file is
 * user-facing (then `pass` is true). Anything unreadable applies and does not pass.
 */
export function designGateVerdict({ files, filesTruncated = false, reviews, comments, reviewerAppLogin, headSha, pushedAtMs = null }) {
  if (!Array.isArray(files) || filesTruncated) {
    return { applies: true, pass: false, kind: null, at: null, paths: [], reason: 'the changed-file list is unreadable or cut short, so user-facing files cannot be ruled out' };
  }
  const paths = [...new Set(filePaths(files).filter(isUserFacingPath))];
  if (paths.length === 0) return { applies: false, pass: true, kind: null, at: null, paths, reason: null };

  const pushKnown = Number.isFinite(pushedAtMs);
  const slots = latestRoleVerdicts({
    reviews: (reviews ?? []).filter((r) => String(r?.state ?? '').toUpperCase() !== 'DISMISSED'),
    comments: pushKnown ? (comments ?? []) : [],
    reviewerAppLogin,
    headSha,
    lastPushAt: pushKnown ? new Date(pushedAtMs).toISOString() : null,
  });
  // The role as written may differ in case or spacing; the latest Design entry of any spelling wins.
  const latest = [...slots.entries()]
    .filter(([role]) => isDesign(role))
    .map(([, v]) => v)
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
    .at(-1);
  if (!latest) return { applies: true, pass: false, kind: null, at: null, paths, reason: `no ${DESIGN_ROLE} verdict from the reviewer App at this head${pushKnown ? '' : ' (push time unknown: only a review bound to the head counts)'}` };
  if (latest.kind === 'approved' || latest.kind === 'exempt') return { applies: true, pass: true, kind: latest.kind, at: latest.at, paths, reason: null };
  return { applies: true, pass: false, kind: latest.kind, at: latest.at, paths, reason: `${DESIGN_ROLE}'s latest verdict is ${latest.kind === 'changes_requested' ? 'changes requested' : latest.kind}` };
}

/** PURE. The earliest `started_at` (ms) among a head's check runs, the push-time proxy; null when none. */
export function earliestCheckRunStartMs(checkRuns) {
  const starts = (checkRuns ?? []).map((c) => Date.parse(c?.started_at ?? '')).filter((t) => !Number.isNaN(t));
  return starts.length ? Math.min(...starts) : null;
}

/** PURE. One line for a check text or a skip reason: the paths shown, at most three. */
export function shownPaths(paths) {
  return paths.slice(0, 3).join(', ') + (paths.length > 3 ? ` and ${paths.length - 3} more` : '');
}
