// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Pure predicate for the t1-approval-guard check (t/4247): a T1 PR auto-merged twice on 10-17
 * (#3343, #3364) with no `Approved (<role>):` comment from the round-robin reviewer. Root cause,
 * in part a rule conflict: root AGENTS.md says "arm auto-merge at PR creation for T1", Change
 * Tiers says T1 needs the reviewer's approval first — nothing mechanical enforced the approval,
 * so arming at creation merged on green CI alone.
 *
 * `evaluateT1ApprovalGuard` takes already-fetched PR facts and returns a pass/fail verdict. It
 * does not call GitHub itself — the workflow (CLI wrapper, not duplicated here) does the API
 * reads and feeds their results in, so the decision is testable without a live PR.
 *
 * TIER GATING: only a PR whose body's first line is exactly `Tier: T1` is checked at all. A
 * missing, malformed, T0 or T2 declaration always passes THIS gate — tier-check.yml already
 * flags a missing/malformed declaration on its own, and T2 has its own consult-hold mechanism.
 *
 * APPROVAL MATCH: a comment matches if it starts with `Approved (<role>):` AND its EFFECTIVE time
 * (`updatedAt` if the comment was edited, else `createdAt`) is after `lastPushAt`. Using the
 * effective time means an approval added by editing an EARLIER comment in place still counts —
 * one of this gate's own required route-table entries.
 *
 * SELF-APPROVAL HEURISTIC (a design choice, not GitHub-enforced — every agent shares one GitHub
 * login, so GitHub's own self-approval block does not apply to a free-text comment): the PR's
 * "owner slug" is the branch name's leading path segment (e.g. `devops/t4242-...` -> `devops`).
 * An approval comment whose parsed role name STARTS WITH that slug (after stripping non-letters
 * and lowercasing) is rejected as self-approval. This is an approximation, not an exact identity
 * check — documented here so a reviewer can propose a better one if this heuristic misfires on a
 * real role name.
 *
 * t/4096 Reviewer switch-over: during the transition, a T1 PR can be approved EITHER way --
 * the legacy `Approved (<role>):` comment, OR a real GitHub review left by the reviewer App
 * (originally `state: 'APPROVED'` after the latest push; since t/116, its role-tagged body bound
 * to the current head -- see the t/116 block below).
 *
 * TL correction (PR #3487 review): arm 5 proved GitHub refuses an App's approval of a PR **the
 * App itself authored** -- it does NOT prove a human-authored PR is self-approval-safe. Every PR
 * is authored by SOME identity -- `jpsnover` directly before the t/4351 author-App switch-over,
 * the author App (`ai-triad-author-jpsnover[bot]`) after it -- and any agent can run
 * `Invoke-AsAgentApp -Role reviewer`, so an author approving their own PR through the reviewer
 * App would otherwise pass EITHER WAY (App-distinctness from the reviewer App never made this
 * safe; it was never the control). The bot-review arm therefore reuses the EXACT SAME owner-slug
 * self-approval check as the comment arm, independent of author identity: the review body must
 * still start with `Approved (<role>):`, and that role must not match the head branch's owner
 * slug. It is also restricted to the configured reviewer App's own login (`reviewerAppLogin`) --
 * a human's review or any other App's review must not silently satisfy this gate.
 *
 * t/116 (a) (TL decision t/116#3, HIGH; rule refined by the TL in p/12#58, recorded on
 * t/116#8): ROLE VERDICTS, NOT REVIEW STATE. The gate used to pre-filter reviews on
 * `state === 'APPROVED'` and never looked at CHANGES_REQUESTED at all, so once any
 * `Approved (<role>):` existed after the push, a later CHANGES_REQUESTED from anyone (another
 * role through the same shared reviewer-App account -- the #4686 class -- or a human) did not
 * revoke it. Now every verdict comes from `latestRoleVerdicts({ ..., mode: 'gate' })` in
 * role-review-verdicts.mjs, the ONE shared implementation (tier-check R6, t/116 (b), is meant to
 * reuse it). That module documents the slots and the clearing rules. In short:
 *   - APPROVALS ARE HEAD-BOUND: a review at `commitId === headSha`, or a comment after
 *     `lastPushAt`. A push invalidates them.
 *   - A CHANGES-REQUEST IS STICKY ACROSS PUSHES: it blocks until the same role (reviewer App) or
 *     the same login (human) approves later, or the review is dismissed. A push, a comment, or
 *     another role's approval never clears it. Role-less App latches clear only by dismissal
 *     (or, for a comment, editing or deleting it).
 *   - Ties go to the block.
 * This predicate adds only the T1 policy on top: ANY outstanding request blocks; otherwise it
 * passes on an at-head approval from the reviewer App or a comment (never a human review, TL
 * blocking 2, PR #3487) whose role is not the branch owner's (self-approval). A reviewer-App
 * review's verdict is its body, so a COMMENTED-state review whose body is `Approved (<role>):`
 * counts, exactly as the same text in a comment always has.
 *
 * `missing-head-sha`: reviews present but no `headSha` fails closed explicitly (no review could
 * be bound to the head, so no review approval could count anyway).
 *
 * SELF-CONTAINED (t/200): this file has NO imports. It carries role-review-verdicts.mjs's code
 * verbatim in the INLINED region below, instead of `import`ing it. A `pull_request_review` run
 * executes the PR BRANCH's t1-approval-guard.yml, and a branch cut before #4804 has the old YAML,
 * which copies ONLY this file from main's tip into an otherwise empty temp dir. A relative import
 * crashed there with ERR_MODULE_NOT_FOUND, so no verdict was posted and the PR could not be
 * enqueued. The current t1-approval-guard.yml and ci.yml's merge_group arm still copy
 * role-review-verdicts.mjs alongside; that is now harmless and unused by this file.
 * role-review-verdicts.mjs remains the ONE source of truth: edit it, then run
 * `node operations/devops/sync-inlined-role-review-verdicts.mjs`. t1-approval-guard-predicate.test.mjs
 * fails if the inlined region is not byte-identical to it. Never edit the region by hand.
 */

// BEGIN INLINED role-review-verdicts.mjs (t/200) -- generated, do not edit by hand
function effectiveTimeOf(item, kind) {
  if (kind === 'review') return item?.submittedAt ?? null;
  return item?.updatedAt ?? item?.createdAt ?? null;
}

// Matches `Approved (<role>):`, `Changes requested (<role>):`, `Design-exempt (<role>): <reason>`,
// tolerating leading markdown emphasis (`**`, `*`, `_`) and `:`, `,` or `.` after the role --
// `**Changes requested (Quality), at ...**` is real-world output from the reviewer App (p/780#46).
// The exemption arm requires at least one non-whitespace character after the punctuation.
const LEADING_MARKDOWN_RE = /^[*_]+\s*/;
const VERDICT_RE = /^(Approved|Changes requested|Design-exempt)\s*\(([^)]+)\)[:,.]\s*(.*)$/s;
const LOOSE_CHANGES_REQUESTED_RE = /changes requested/i;
const LOOSE_ROLE_RE = /\(([^)]+)\)/;
const UNPARSEABLE_ROLE = '(unparseable)';

function stripLeadingMarkdown(body) {
  return String(body ?? '').trim().replace(LEADING_MARKDOWN_RE, '');
}

function parseVerdict(rawBody) {
  const stripped = stripLeadingMarkdown(rawBody);
  const m = VERDICT_RE.exec(stripped);
  if (m) {
    const [, word, role, rest] = m;
    if (word === 'Design-exempt' && rest.trim() === '') return null; // empty-reason exemption: invalid, not a verdict
    const kind = word === 'Approved' ? 'approved' : word === 'Changes requested' ? 'changes_requested' : 'exempt';
    return { role: role.trim(), kind };
  }
  // Fail-closed backstop: the strict grammar didn't match, but the text still says "changes
  // requested" -- never silently treat this as "no verdict." Best-effort role extraction from
  // the first parenthesized group; falls back to a fixed label so the sweep always has a role
  // string to put in its skip reason. Nit 1 (Quality, p/780#48): scoped to the FIRST LINE only
  // -- the same anchoring the strict grammar already uses -- so a long body that only mentions
  // "changes requested" or a parenthesized name deep in later prose can't false-positive.
  const firstLine = stripped.split('\n', 1)[0];
  if (LOOSE_CHANGES_REQUESTED_RE.test(firstLine)) {
    const roleMatch = LOOSE_ROLE_RE.exec(firstLine);
    return { role: roleMatch ? roleMatch[1].trim() : UNPARSEABLE_ROLE, kind: 'changes_requested', unparsed: true };
  }
  return null;
}

/**
 * PURE. `reviews`: PR review objects `{ body, login, commitId, submittedAt }`. `comments`:
 * issue/PR comment objects `{ body, login, createdAt, updatedAt }`. Only entries whose `login`
 * equals `reviewerAppLogin` are considered -- a human comment or another App's review never
 * satisfies or blocks a role verdict. Returns a `Map<roleNameAsWritten, { kind, at }>` with the
 * latest verdict per role (role names are kept as written in the tag, e.g. `'Design'`,
 * `'Tech Lead'` -- callers normalize/compare as needed).
 */
export function latestRoleVerdicts({ reviews, comments, reviewerAppLogin, headSha, lastPushAt, mode }) {
  if (mode === 'gate') return gateRoleVerdicts({ reviews, comments, reviewerAppLogin, headSha, lastPushAt });
  const pushMs = lastPushAt ? new Date(lastPushAt).getTime() : 0;
  const entries = [];

  for (const r of reviews || []) {
    if (!reviewerAppLogin || r?.login !== reviewerAppLogin) continue;
    if (r?.commitId !== headSha) continue; // not bound to the current head
    const parsed = parseVerdict(r?.body);
    if (!parsed) continue;
    const at = effectiveTimeOf(r, 'review');
    if (!at) continue;
    entries.push({ ...parsed, at: new Date(at).getTime(), iso: at });
  }

  for (const c of comments || []) {
    if (!reviewerAppLogin || c?.login !== reviewerAppLogin) continue;
    const parsed = parseVerdict(c?.body);
    if (!parsed) continue;
    const at = effectiveTimeOf(c, 'comment');
    if (!at) continue;
    const atMs = new Date(at).getTime();
    if (atMs <= pushMs) continue; // a comment not bound to a head must postdate the latest push
    entries.push({ ...parsed, at: atMs, iso: at });
  }

  entries.sort((a, b) => a.at - b.at);

  // Nit 2 (Quality, p/780#54): an UNPARSEABLE_ROLE entry LATCHES deliberately -- it is NOT
  // cleared by a later verdict for some other, unrelated role (see the module doc comment
  // above). It only ever stops appearing here because a new push changes `headSha`/`lastPushAt`
  // and the old entry's review/comment no longer passes the binding checks above -- nothing
  // extra needed in this function for that.
  const latest = new Map();
  for (const e of entries) latest.set(e.role, { kind: e.kind, at: e.iso, unparsed: e.unparsed ?? false });
  return latest;
}

/*
 * `mode: 'gate'` (t/116, TL p/12#58 recorded on t/116#8): the semantics a MERGE GATE needs. The
 * default mode above is unchanged for its existing callers (t0-enqueue-sweep.mjs).
 *
 *   - APPROVALS ARE HEAD-BOUND. An approval satisfies a gate only if it is at the current head:
 *     a review with `commitId === headSha`, or a comment after `lastPushAt`. A push invalidates it.
 *   - A CHANGES-REQUEST IS STICKY ACROSS PUSHES. It stays outstanding whatever the head, until the
 *     SAME slot (the same role for the reviewer App, the same login for a human) posts a later
 *     approval (at any head), or the review is dismissed. A push does not clear it. Neither does a
 *     plain comment, a `Design-exempt`, or another role's or login's approval.
 *   - SLOTS. Reviewer-App reviews and comments: the role from the body (normalized, so `Tech Lead`
 *     and `TechLead` are one slot), with this module's full grammar and fail-closed backstop. An
 *     App review whose STATE is CHANGES_REQUESTED but whose body doesn't parse as a request is
 *     still a request (state may add a block, never an approval), for the body's role if it names
 *     one, else `(unparseable)`. Other logins' REVIEWS: a human review has no role tag, so its
 *     verdict is its GitHub state, one slot per login (`@<login>`); GitHub's per-user overwrite
 *     (#4686) can't hit a per-login slot. Other logins' COMMENTS (the legacy shared-login path):
 *     strict grammar only, because status chatter that mentions "changes requested" must not
 *     latch a block.
 *   - DISMISSED (any review): a clearing entry for its slot. It never counts as an approval, and
 *     it ends the slot's outstanding request, which is GitHub's meaning of a dismissal.
 *
 * CLEARING RULES (Quality-TechLead review of #4804, t/116), one per kind of block:
 *   1. ROLE block (App review or comment `Changes requested (<role>)`, or an App review with
 *      CHANGES_REQUESTED state whose body names a role): clears ONLY on a later `Approved
 *      (<role>)` for that same role (any head; it satisfies a gate only at the head), or by
 *      dismissing the request review. Another role's approval, an exemption, a comment, or a
 *      push never clears it.
 *   2. HUMAN block (`@<login>`, a CHANGES_REQUESTED review): clears ONLY on that login's later
 *      APPROVED review, or a DISMISSED review (the request itself dismissed, or that login's
 *      later review dismissed). COMMENTED never clears it.
 *   3. ROLE-LESS App latches -- the fail-closed `(unparseable)` request, and an App review whose
 *      only signal is its CHANGES_REQUESTED state with no role in the body: each gets its own
 *      per-review/comment slot, so NO approval can clear it (there is no way to tell that an
 *      approval answers it, the #4686 lesson, p/780#54). The defined clear is: DISMISS that review
 *      (it then contributes nothing), or for a comment, EDIT it into a parseable verdict or
 *      DELETE it (the gate re-reads bodies every run). Both are always available to a maintainer,
 *      so the latch never has to last forever.
 *   4. TIES: entries with the same timestamp sort a changes-request last, so the block wins.
 *
 * Returns `Map<slot, { role, kind, at, atHead, unparsed, source }>`. `kind` is `'approved'`,
 * `'changes_requested'`, `'exempt'` or `'cleared'`. A gate blocks on any `changes_requested`
 * entry, and may accept an `'approved'` entry only when `atHead` is true (and, for its own policy,
 * not a `@<login>` slot if only the reviewer App may approve).
 */
function gateSlotKey(role) {
  if (role === UNPARSEABLE_ROLE || role.startsWith('@')) return role;
  return String(role).toLowerCase().replace(/[^a-z]/g, '');
}

// A review's GitHub state, upper-cased. Read only to (a) give a role-less human review a verdict,
// (b) add a block when an App review's body doesn't say so, and (c) honor a dismissal.
function reviewStateOf(r) {
  return String(r?.state ?? '').toUpperCase();
}

function gateRoleVerdicts({ reviews, comments, reviewerAppLogin, headSha, lastPushAt }) {
  const pushMs = lastPushAt ? new Date(lastPushAt).getTime() : 0;
  const entries = [];
  // A role-less latch gets its OWN slot per review/comment, so no verdict for some other concern
  // can supersede it, and dismissing one latched review can't clear a different one.
  const push = (e) => entries.push({
    ...e,
    slot: e.role === UNPARSEABLE_ROLE ? `${UNPARSEABLE_ROLE}#${entries.length}` : gateSlotKey(e.role),
    atMs: new Date(e.at).getTime(),
  });

  for (const r of reviews || []) {
    if (!r?.login || !r?.submittedAt) continue;
    const state = reviewStateOf(r);
    const atHead = Boolean(headSha) && r.commitId === headSha;
    if (reviewerAppLogin && r.login === reviewerAppLogin) {
      let parsed = parseVerdict(r.body);
      if (state === 'DISMISSED') {
        // A dismissed review clears its role's outstanding request. A dismissed role-less review
        // simply stops existing: its own per-review latch is gone, and nothing else is touched.
        if (parsed && parsed.role !== UNPARSEABLE_ROLE) {
          push({ role: parsed.role, kind: 'cleared', at: r.submittedAt, atHead, unparsed: false, source: 'app-review' });
        }
        continue;
      }
      // lint:review-state-ok: state only ADDS a block for an App review whose body doesn't already request changes; it never grants an approval (t/116)
      if (state === 'CHANGES_REQUESTED' && parsed?.kind !== 'changes_requested') {
        parsed = { role: parsed?.role ?? UNPARSEABLE_ROLE, kind: 'changes_requested', unparsed: !parsed };
      }
      if (!parsed) continue;
      push({ role: parsed.role, kind: parsed.kind, at: r.submittedAt, atHead, unparsed: parsed.unparsed ?? false, source: 'app-review' });
      continue;
    }
    // A human (or other-App) review: no role tag, so its state is the verdict, one slot per login.
    let kind = null;
    // lint:review-state-ok: per-LOGIN slot for a role-less human review, never shared across roles; an approval here only clears this login's own request, never satisfies a gate (t/116)
    if (state === 'CHANGES_REQUESTED') kind = 'changes_requested';
    else if (state === 'APPROVED') kind = 'approved'; // lint:review-state-ok: same per-login human slot as above; clears only this login's request (t/116)
    else if (state === 'DISMISSED') kind = 'cleared';
    if (!kind) continue; // COMMENTED / PENDING: not a verdict, and does not clear a request
    push({ role: `@${r.login}`, kind, at: r.submittedAt, atHead, unparsed: false, source: 'human-review' });
  }

  for (const c of comments || []) {
    const isApp = Boolean(reviewerAppLogin) && c?.login === reviewerAppLogin;
    const parsed = parseVerdict(c?.body);
    if (!parsed) continue;
    if (!isApp && parsed.unparsed) continue; // strict grammar only off the reviewer App
    const at = effectiveTimeOf(c, 'comment');
    if (!at) continue;
    const atHead = new Date(at).getTime() > pushMs;
    push({ role: parsed.role, kind: parsed.kind, at, atHead, unparsed: parsed.unparsed ?? false, source: isApp ? 'app-comment' : 'comment' });
  }

  // Oldest first; on a tie a changes-request sorts last, so it wins (fail closed).
  entries.sort((a, b) => (a.atMs - b.atMs) || ((a.kind === 'changes_requested') - (b.kind === 'changes_requested')));

  const slots = new Map();
  for (const e of entries) {
    const prev = slots.get(e.slot);
    // Only an approval, a dismissal or a newer request may replace an outstanding request.
    if (prev?.kind === 'changes_requested' && e.kind === 'exempt') continue;
    slots.set(e.slot, { role: e.role, kind: e.kind, at: e.at, atHead: e.atHead, unparsed: e.unparsed, source: e.source });
  }
  return slots;
}
// END INLINED role-review-verdicts.mjs (t/200)

function parseTier(body) {
  const firstLine = String(body ?? '').trim().split('\n')[0].trim();
  const m = /^Tier:\s*(T[012])\b/i.exec(firstLine);
  return m ? m[1].toUpperCase() : null;
}

/** Exported for reuse by pr-triage.yml's CI-green nudge (t/4351): since the author-App
 * switch-over, `pr.user.login` is a bot handle and no longer names a notifiable human, so the
 * nudge uses this to say WHICH role's branch is green, while still @-mentioning the one shared
 * human account (t/4351, see pr-triage.yml). */
export function ownerSlugFromBranch(headRefName) {
  const seg = String(headRefName ?? '').split('/')[0] ?? '';
  return seg.toLowerCase().replace(/[^a-z]/g, '');
}

function normalizeRole(role) {
  return String(role ?? '').toLowerCase().replace(/[^a-z]/g, '');
}

export function evaluateT1ApprovalGuard({ body, headRefName, headSha, lastPushAt, approvalComments, botReviews, reviewerAppLogin }) {
  const tier = parseTier(body);
  if (tier !== 'T1') {
    return { pass: true, tier, reason: 'not-t1' };
  }

  // `botReviews` keeps its historical name so a caller and a predicate from different commits
  // still agree (the merge_group arm runs a PR's ci.yml against main's predicate), but callers
  // now pass EVERY review on the PR, human ones included, each with `commitId`.
  const reviews = botReviews || [];
  if (reviews.length > 0 && !headSha) {
    return { pass: false, tier, reason: 'missing-head-sha' };
  }

  const slots = latestRoleVerdicts({
    reviews, comments: approvalComments || [], reviewerAppLogin, headSha, lastPushAt, mode: 'gate',
  });

  const blockers = [...slots.values()].filter((s) => s.kind === 'changes_requested');
  if (blockers.length > 0) {
    return {
      pass: false, tier, reason: 'changes-requested-outstanding',
      blockers: blockers.map((b) => ({ role: b.role, at: b.at, source: b.source })),
    };
  }

  const ownerSlug = ownerSlugFromBranch(headRefName);
  const approvals = [...slots.values()]
    .filter((s) => s.kind === 'approved' && s.atHead && s.source !== 'human-review')
    .filter((s) => !(ownerSlug && normalizeRole(s.role).startsWith(ownerSlug))) // self-approval by the owning role
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  if (approvals.length > 0) {
    return { pass: true, tier, reason: 'approved-after-push', approver: { role: approvals[0].role, at: approvals[0].at } };
  }
  return { pass: false, tier, reason: 'no-post-push-approval' };
}
