// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/537: the PURE verdict behind the `merge-approval` check run. merge-approval-run.mjs fetches
// the facts from the GitHub API and posts the result with the ai-triad-merge-approval App;
// .github/workflows/merge-approval.yml runs both from a checkout of the DEFAULT BRANCH only, so
// a PR can never change the rules it is judged by. This file makes no network call and reads no
// file: every fact comes in as an argument, so the whole decision is unit-testable.
//
// RULES (each PR must pass all three; a group passes only if every PR in it passes):
//   A. gate files. A change to a workflow, composite action, .github/ci data or a gate script
//      (isGateFile) needs a reviewer-App APPROVED review bound to the head whose body starts
//      `Approved (Tech Lead):` or `Approved (Security):` (gateFileChangeVerdict decides it, with
//      that review passed as the override). The branch owner's own role does not count (same
//      owner-slug heuristic as t1-approval-guard). A change list cut short at the API cap fails. Any
//      outstanding changes-request (latestRoleVerdicts, gate mode) also fails it: a second
//      reader's approval does not stand while another reader still objects.
//   B. T1/T2 approval. A PR declaring `Tier: T1` or `Tier: T2` (parseTier) must pass evaluateT1ApprovalGuard.
//   C. tier honesty. tier-check's R1 path floor (evaluateR1Only) and R3's breaking-schema floor,
//      from main's .github/ci/tier-paths.json, must not require a higher tier than declared.
//
// WHO COUNTS (B, and the changes-request part of A):
//   - Approvals: only reviews from the reviewer App, bound to the head by commit_id. The App's
//     approval COMMENTS do not approve here. A comment is not bound to a commit, so the predicate
//     binds it with `lastPushAt`, and the only cheap source for that is the head commit's
//     committer date, which the PR author sets (git commit --date). A back-dated commit would make
//     an old approval comment count for new code. So this module passes a far-future lastPushAt:
//     every comment is "before the push", which keeps an App comment able to BLOCK (a request is
//     sticky across pushes) and to clear its own role's block, but never to satisfy the gate.
//   - Comments: only the reviewer App's (the allowlist is exactly REVIEWER_APP_REST_LOGIN). The
//     shared `jpsnover` login and every other account are dropped, because on a public repo anyone
//     can write `Approved (Security):` in a comment.
//   - Reviews: the reviewer App's, plus reviews from accounts with write-level association
//     (OWNER, MEMBER, COLLABORATOR). The predicate never counts a human review as an approval
//     (source 'human-review'), so the humans are passed only so their CHANGES_REQUESTED blocks.
//     Reviews from other accounts are dropped so a drive-by account cannot block a PR.
//
// OUTPUT: { conclusion: 'success' | 'failure', title, summary }. Never neutral, never skipped: a
// neutral conclusion satisfies a required check on GitHub. Any missing or malformed input is a
// failure that names the field.

import { REVIEWER_APP_REST_LOGIN, gateFileChangeVerdict, isGateFile } from './gate-file-change.mjs';
import {
  T1_REVIEWER_ROLES, canonicalRole, evaluateT1ApprovalGuard, latestRoleVerdicts, normalizeRole, ownerSlugFromBranch, parseTier,
} from './t1-approval-guard-predicate.mjs';
import { checkR3, evaluateR1Only, extractSchemaChange, extractTier } from './tier-check-predicate.mjs';

export const CHECK_NAME = 'merge-approval';

/** Comment authors whose comments are read at all. Exactly the reviewer App. */
export const COMMENT_AUTHOR_ALLOWLIST = Object.freeze([REVIEWER_APP_REST_LOGIN]);

/** Review author associations whose CHANGES_REQUESTED blocks (their approvals never count). */
export const BLOCKING_REVIEW_ASSOCIATIONS = Object.freeze(['OWNER', 'MEMBER', 'COLLABORATOR']);

// Later than any real push, so no comment is "after the push" (see WHO COUNTS above).
const FAR_FUTURE_PUSH = '9999-12-31T23:59:59Z';

const SHA_RE = /^[0-9a-f]{40}$/;
const GATE_APPROVAL_RE = /^Approved \((Tech Lead|Security)\):/;

const short = (sha) => String(sha ?? '').slice(0, 9);
const pass = (detail) => ({ ok: true, detail });
const fail = (detail) => ({ ok: false, detail });

/** PURE. Names every missing or malformed field of one PR's input; [] when the input is usable. */
export function inputProblems(pr) {
  if (!pr || typeof pr !== 'object') return ['the PR input is missing'];
  const p = [];
  if (!Number.isInteger(pr.number) || pr.number <= 0) p.push('number');
  if (typeof pr.headSha !== 'string' || !SHA_RE.test(pr.headSha)) p.push('headSha');
  if (typeof pr.body !== 'string') p.push('body');
  if (typeof pr.headRefName !== 'string' || !pr.headRefName) p.push('headRefName');
  if (!Array.isArray(pr.files) || pr.files.some((f) => typeof f?.filename !== 'string' || !f.filename)) p.push('files');
  if (typeof pr.filesTruncated !== 'boolean') p.push('filesTruncated');
  if (!Array.isArray(pr.reviews)) p.push('reviews');
  if (!Array.isArray(pr.comments)) p.push('comments');
  if (!Array.isArray(pr.labels)) p.push('labels');
  return p;
}

/** PURE. Both names of every changed file (a rename away from a protected path still counts). */
export function changedPaths(files) {
  return files.flatMap((f) => (typeof f.previous_filename === 'string' && f.previous_filename ? [f.filename, f.previous_filename] : [f.filename]));
}

/** PURE. The reviews the predicate sees, in its shape: the reviewer App plus write-level humans. */
export function predicateReviews(reviews, reviewerLogin = REVIEWER_APP_REST_LOGIN) {
  return reviews
    .filter((r) => r?.user?.login === reviewerLogin || BLOCKING_REVIEW_ASSOCIATIONS.includes(r?.author_association))
    .map((r) => ({ state: r.state, submittedAt: r.submitted_at, login: r.user?.login, body: r.body, commitId: r.commit_id }));
}

/** PURE. The comments the predicate sees, in its shape: only allowlisted authors. */
export function predicateComments(comments, allowlist = COMMENT_AUTHOR_ALLOWLIST) {
  return comments
    .filter((c) => allowlist.includes(c?.user?.login))
    .map((c) => ({ body: c.body, createdAt: c.created_at, updatedAt: c.updated_at, login: c.user?.login }));
}

function outstandingRequests(pr, reviewerLogin) {
  const slots = latestRoleVerdicts({
    reviews: predicateReviews(pr.reviews, reviewerLogin),
    comments: predicateComments(pr.comments),
    reviewerAppLogin: reviewerLogin,
    headSha: pr.headSha,
    lastPushAt: FAR_FUTURE_PUSH,
    mode: 'gate',
  });
  return [...slots.values()].filter((s) => s.kind === 'changes_requested');
}

/** PURE. True when the role is the branch owner's own (same heuristic as t1-approval-guard). */
export function isOwnerRole(role, headRefName) {
  const raw = ownerSlugFromBranch(headRefName);
  const slug = raw ? normalizeRole(canonicalRole(raw)) : raw;
  return Boolean(slug) && normalizeRole(canonicalRole(role)).startsWith(slug);
}

/**
 * PURE. The latest reviewer-App APPROVED review at the head whose body names Tech Lead or
 * Security, not counting the branch owner's own role (a second reader, not the author).
 */
export function pickGateApproval(reviews, headSha, reviewerLogin = REVIEWER_APP_REST_LOGIN, headRefName = '') {
  const hits = reviews.filter((r) => {
    // lint:review-state-ok: picks the override gateFileChangeVerdict requires (APPROVED AND a role-tagged body at the head); outstanding requests are judged separately by latestRoleVerdicts (t/537)
    if (r?.user?.login !== reviewerLogin || r.state !== 'APPROVED' || r.commit_id !== headSha) return false;
    const m = GATE_APPROVAL_RE.exec(String(r.body ?? '').trimStart());
    return Boolean(m) && !isOwnerRole(m[1], headRefName);
  });
  hits.sort((a, b) => String(a.submitted_at ?? '').localeCompare(String(b.submitted_at ?? '')));
  return hits.length ? hits[hits.length - 1] : null;
}

/** PURE. Rule A. */
export function ruleGateFiles(pr, { reviewerLogin = REVIEWER_APP_REST_LOGIN } = {}) {
  if (pr.filesTruncated) return fail('the changed-file list is cut short at the API limit, so gate files cannot be ruled out');
  const paths = changedPaths(pr.files);
  const gateFiles = [...new Set(paths.filter(isGateFile))];
  const review = gateFiles.length ? pickGateApproval(pr.reviews, pr.headSha, reviewerLogin, pr.headRefName) : null;
  const v = gateFileChangeVerdict({
    files: { paths, listedCount: pr.files.length, expectedCount: pr.files.length },
    headSha: pr.headSha,
    override: review ? { review } : null,
    reviewerLogin,
  });
  const shown = v.gateFiles.slice(0, 5).join(', ') + (v.gateFiles.length > 5 ? ` and ${v.gateFiles.length - 5} more` : '');
  if (!v.allow) {
    if (v.reason === 'gate_files_no_override') {
      return fail(`changes ${shown}; needs a reviewer-App APPROVED review at ${short(pr.headSha)} starting "Approved (Tech Lead):" or "Approved (Security):", from a role other than the branch owner's`);
    }
    return fail(`${v.reason}: ${v.detail ?? 'refused'}`);
  }
  if (v.reason === 'no_gate_files') return pass('no gate files changed');
  const blockers = outstandingRequests(pr, reviewerLogin);
  if (blockers.length) {
    return fail(`changes ${shown}; approved by ${v.role} (review ${review.id}), but a changes-request is outstanding from ${blockers.map((b) => b.role).join(', ')}`);
  }
  return pass(`changes ${shown}; approved by ${v.role} (review ${review.id}) at ${short(pr.headSha)}`);
}

/** PURE. Rule B. */
export function ruleT1Approval(pr, { reviewerLogin = REVIEWER_APP_REST_LOGIN } = {}) {
  const tier = parseTier(pr.body);
  // KNOWN GAP (t/751): a body with no `Tier:` first line passes here with no approval. Left as it
  // is in the t/739 fix, because Dependabot PRs have no tier line and merge on this arm by policy.
  if (tier !== 'T1' && tier !== 'T2') return pass(`not T1 or T2 (declared ${tier ?? 'no tier'})`);
  // t/537 (DevOps Lead): T2 needs at least T1's approval at the head; declaring T2 must never skip
  // rule B. The shared predicate acts only on a `Tier: T1` first line, so a T2 body is passed to
  // it with that first line rewritten (the rest of the body unchanged).
  const guardBody = tier === 'T2' ? String(pr.body ?? '').replace(/^(\s*Tier:\s*)T2\b/i, '$1T1') : pr.body;
  const r = evaluateT1ApprovalGuard({
    body: guardBody,
    headRefName: pr.headRefName,
    headSha: pr.headSha,
    lastPushAt: FAR_FUTURE_PUSH,
    approvalComments: predicateComments(pr.comments),
    botReviews: predicateReviews(pr.reviews, reviewerLogin),
    reviewerAppLogin: reviewerLogin,
  });
  if (r.pass) {
    // t/739 (decision 6): say WHICH review was counted. The slot carries the review's time, so the
    // id is read back from the reviewer App's reviews at the head with that time.
    const counted = pr.reviews.find((x) => x?.user?.login === reviewerLogin && x.commit_id === pr.headSha && x.submitted_at === r.approver?.at);
    return pass(`${tier}, approved by ${r.approver?.role ?? 'the reviewer App'} (review ${counted?.id ?? 'id not found'}) at ${short(pr.headSha)}`);
  }
  if (r.reason === 'changes-requested-outstanding') {
    return fail(`${tier}, changes-request outstanding from ${r.blockers.map((b) => `${b.role} (${b.at})`).join(', ')}`);
  }
  const seen = (r.rejected ?? []).map((x) => `${x.role} (${x.why === 'branch_owner_role' ? "the branch owner's own role" : 'not a T1 reviewer role'})`);
  const sawText = seen.length ? `approvals seen that do not count: ${seen.join(', ')}` : 'no reviewer-App approval review seen at this head';
  return fail(`${tier}, no reviewer-App approval review at ${short(pr.headSha)} from a T1 reviewer role (${T1_REVIEWER_ROLES.join(', ')}) other than the branch owner's; ${sawText} (${r.reason})`);
}

/** PURE. Rule C. `tierConfig` is main's .github/ci/tier-paths.json. */
export function ruleTierHonesty(pr, tierConfig) {
  if (!tierConfig || !Array.isArray(tierConfig.r1Paths) || !Array.isArray(tierConfig.schemaDirPrefixes) ||
      (tierConfig.r1Globs !== undefined && !Array.isArray(tierConfig.r1Globs))) {
    return fail('the tier config (.github/ci/tier-paths.json on main) is missing or malformed');
  }
  if (pr.filesTruncated) return fail('the changed-file list is cut short at the API limit, so the tier floor cannot be checked');
  const tier = extractTier(pr.body);
  const paths = changedPaths(pr.files);
  const r1 = evaluateR1Only(paths, tierConfig, tier);
  if (!r1.pass) return fail(`${r1.comments.join('; ')} (declared ${tier ?? 'no tier'})`);
  const r3 = checkR3(paths, extractSchemaChange(pr.body), tier, tierConfig);
  if (r3?.kind === 'breaking_no_t2') return fail(`R3: breaking schema change in ${r3.path}, must declare Tier: T2 (declared ${tier ?? 'no tier'})`);
  return pass(`declared ${tier ?? 'no tier'}; no path in the change needs a higher tier`);
}

/** PURE. One PR: { number, headSha, ok, lines }. */
export function evaluatePullRequest(pr, { tierConfig, reviewerLogin = REVIEWER_APP_REST_LOGIN } = {}) {
  const problems = inputProblems(pr);
  const label = `#${pr?.number ?? '?'} at ${short(pr?.headSha) || '?'}`;
  if (problems.length) {
    return { number: pr?.number ?? null, headSha: pr?.headSha ?? null, ok: false, lines: [`${label}: FAIL`, `  input: FAIL, missing or malformed: ${problems.join(', ')}`] };
  }
  const rules = [
    ['A gate-files', ruleGateFiles(pr, { reviewerLogin })],
    ['B t1-approval', ruleT1Approval(pr, { reviewerLogin })],
    ['C tier-honesty', ruleTierHonesty(pr, tierConfig)],
  ];
  const ok = rules.every(([, r]) => r.ok);
  return {
    number: pr.number,
    headSha: pr.headSha,
    ok,
    failed: rules.filter(([, r]) => !r.ok).map(([n]) => n.split(' ')[0]),
    lines: [`${label}: ${ok ? 'PASS' : 'FAIL'}`, ...rules.map(([n, r]) => `  ${n}: ${r.ok ? 'PASS' : 'FAIL'}, ${r.detail}`)],
  };
}

/** PURE. A failure verdict for when no PR could be evaluated. */
export function failureVerdict(reason, extraLines = []) {
  return {
    conclusion: 'failure',
    title: `${CHECK_NAME}: CANNOT EVALUATE`,
    summary: [`CANNOT EVALUATE: ${reason}`, 'This is not a pass. The check fails closed until a run can evaluate.', ...extraLines].join('\n'),
  };
}

/**
 * PURE. The verdict for one SHA: a PR head (every open PR to main at that head) or a merge-group
 * commit (the PR the group is for and every entry ahead of it).
 *   prs:   PR inputs (see inputProblems)
 *   scope: { ok, detail } from checkInstallationScope
 *   context: lines that say what was evaluated (shown first)
 */
export function evaluateGroup({ prs, tierConfig, scope, context = [], reviewerLogin = REVIEWER_APP_REST_LOGIN }) {
  const scopeLine = `Installation scope: ${scope?.ok ? 'OK' : 'FAIL'}, ${scope?.detail ?? 'not checked'}`;
  if (!Array.isArray(prs) || prs.length === 0) return failureVerdict('no pull request to evaluate', [...context, scopeLine]);
  const results = prs.map((pr) => evaluatePullRequest(pr, { tierConfig, reviewerLogin }));
  const ok = Boolean(scope?.ok) && results.every((r) => r.ok);
  const blocked = results.filter((r) => !r.ok).map((r) => `#${r.number ?? '?'}${r.failed?.length ? ` (${r.failed.join(',')})` : ''}`);
  const title = ok
    ? `${CHECK_NAME}: OK (${results.length} PR${results.length === 1 ? '' : 's'})`
    : `${CHECK_NAME}: BLOCKED${blocked.length ? ` ${blocked.join(' ')}` : ''}${scope?.ok ? '' : ' (installation scope)'}`;
  return {
    conclusion: ok ? 'success' : 'failure',
    title,
    summary: [...context, scopeLine, '', ...results.flatMap((r) => r.lines)].join('\n'),
  };
}
