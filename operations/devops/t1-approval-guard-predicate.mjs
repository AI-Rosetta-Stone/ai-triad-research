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

// t/311 (TL p/9#22): THE one alias table. One reviewer posting under two spellings
// (`Changes requested (Quality)` then `Approved (Quality-TechLead)`, #5005) landed in two gate
// slots, so its own approval could never clear its own hold. Keys are the role lower-cased with
// non-letters stripped (the gate's slot-key form); values are the canonical role as written.
// Only add a spelling here when it is provably the SAME reviewer: merging two real roles into one
// slot would let one role's approval clear another's block.
const ROLE_ALIASES = new Map([
  ['qualitytechlead', 'Quality'],   // Quality-TechLead, QualityTechLead, Quality TechLead, Quality (Tech Lead)
  ['qualitytl', 'Quality'],         // Quality-TL, Quality TL
]);

function roleKey(role) {
  return String(role ?? '').toLowerCase().replace(/[^a-z]/g, '');
}

/** PURE (t/311). The canonical role for a known alias; any other role unchanged. */
export function canonicalRole(role) {
  return ROLE_ALIASES.get(roleKey(role)) ?? role;
}

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
    return { role: canonicalRole(role.trim()), kind };
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
    return { role: roleMatch ? canonicalRole(roleMatch[1].trim()) : UNPARSEABLE_ROLE, kind: 'changes_requested', unparsed: true };
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

// Exported (with normalizeRole) for t1-enqueue-sweep.mjs (t/73), so the sweep reads the tier and
// the self-approval role exactly as this guard does. Keep this file import-free: the guard and
// ci.yml copy it alone into a temp dir and import it from there.
export function parseTier(body) {
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

export function normalizeRole(role) {
  return String(role ?? '').toLowerCase().replace(/[^a-z]/g, '');
}

/**
 * t/739 (t/736): THE list of roles whose `Approved (<role>):` satisfies the T1/T2 approval. One
 * list for t1-approval-guard, merge-approval rule B, enqueue-pr and the sweeps: they all call
 * evaluateT1ApprovalGuard. A spelling counts only through the alias table (canonicalRole), so
 * `Quality-TechLead` is Quality. Design is NOT a T1 reviewer: its approval is the Design gate, a
 * separate requirement (docs/review-routing.md), and must never be added here or by alias.
 */
export const T1_REVIEWER_ROLES = Object.freeze(['Quality', 'Tech Lead', 'Security']);
const T1_REVIEWER_KEYS = new Set(T1_REVIEWER_ROLES.map((r) => normalizeRole(r)));

/** PURE. True when the role, after the alias table, is exactly one of T1_REVIEWER_ROLES. */
export function isT1ReviewerRole(role) {
  return T1_REVIEWER_KEYS.has(normalizeRole(canonicalRole(role)));
}

export const MISSING_HEAD_SHA_SUMMARY ='Missing head SHA (this PR\'s branch predates #4804, so its own t1-approval-guard.yml cannot bind a review to the head): post a PR comment containing `/recheck-guards` or rebase onto main to re-run the guard on main\'s workflow.';

/**
 * t/751 (t/739): THE Dependabot exemption for a PR with no `Tier:` first line. Dependabot's PR
 * bodies carry no tier line and merge with no review by policy; every other PR with no tier line
 * is T1. This predicate is the only place that decides it, and the guard, merge-approval,
 * enqueue-pr and the Dependabot sweep all call it (it lives here because this file is the one a
 * workflow can load alone from main's tip; keep it import-free).
 *
 * Exempt only when ALL hold; anything unreadable is not exempt (fail closed):
 *   - the PR's author is `dependabot[bot]` (pulls.get `user.login`);
 *   - the head is in this repository (not a fork);
 *   - EVERY commit is verified (`commit.verification.verified === true`), authored by an
 *     allowlisted login, and committed by `web-flow` (GitHub's own signer: a commit a person signs
 *     with their key, or authors under the bot's email, has another committer);
 *   - the commit list is complete (`commitsTotal` is the PR's own `commits` count; the API caps
 *     the list at 250).
 * The lockfile-heal commit is unsigned and has no author login (t/751#4), so a healed PR is NOT
 * exempt and needs a T1 review. Do not add `dependabot-heal[bot]` here: a git author name is
 * forgeable by any pusher.
 * `input` is { authorLogin, headRepo, baseRepo, commits, commitsTotal }; returns
 * { exempt, reason, commitCount }.
 */
export const DEPENDABOT_PR_AUTHOR = 'dependabot[bot]';
export const DEPENDABOT_COMMIT_AUTHORS = Object.freeze(['dependabot[bot]']);
export const DEPENDABOT_COMMIT_COMMITTERS = Object.freeze(['web-flow']);
export const PR_COMMITS_LIST_CAP = 250;
export const PR_FILES_LIST_CAP = 3000;
/**
 * t/776 (SO condition 1 on #5601): a verified, bot-authored commit is forgeable by anyone with write
 * access (a contents-API commit is signed by web-flow and its author can be set to the bot's noreply
 * email). So the exemption also needs every changed path to be a package manifest or lockfile: the
 * files a version bump touches. Any other path (source, a Dockerfile, a workflow, a gate file) needs
 * T1 review. Basenames only; a path with `..` or a leading slash is never allowed.
 */
export function isDependabotBumpPath(path) {
  if (typeof path !== 'string' || !path || path.startsWith('/') || path.split('/').includes('..')) return false;
  const base = path.slice(path.lastIndexOf('/') + 1);
  // package.json only at the two roots Dependabot's npm bumps are accepted from (Security p/131#99);
  // any other package.json (operations/devops, .github, a nested one) needs T1 review.
  if (base === 'package.json') return DEPENDABOT_PACKAGE_JSON_PATHS.includes(path);
  return base === 'pnpm-lock.yaml' || /^requirements[A-Za-z0-9._-]*\.txt$/.test(base);
}
export const DEPENDABOT_PACKAGE_JSON_PATHS = Object.freeze(['package.json', 'taxonomy-editor/package.json']);
// A dependency version spec: ^1.2.3, ~1.2, >=1 <2, 1.2.3-beta.1, 1.2.3 - 2.0.0, 1.x || 2.x. Not a script body or a
// URL. LINEAR on purpose (CodeQL js/redos on an earlier nested-quantifier regex): this runs in the required guard
// on patch lines a forged commit controls. Split on `||`, then on whitespace, and test each token against one
// anchored, non-nested pattern; the whole value is length-capped first.
const VERSION_SPEC_MAX = 200;
const VERSION_TOKEN = /^[\^~<>=v]*\d[\w.+-]*$/;
export function isVersionSpec(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > VERSION_SPEC_MAX) return false;
  for (const alt of value.split('||')) {
    const tokens = alt.trim().split(/\s+/);
    if (tokens.length === 1 && tokens[0] === '') return false;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      // A hyphen range joins two versions ('1.0.0 - 2.0.0'): `-` alone is valid only between two version tokens.
      if (t === '-') {
        if (i === 0 || i === tokens.length - 1 || !VERSION_TOKEN.test(tokens[i - 1]) || !VERSION_TOKEN.test(tokens[i + 1])) return false;
      } else if (!VERSION_TOKEN.test(t)) return false;
    }
  }
  return true;
}
const KV_LINE = /^\s*"([^"\\]+)":\s*"([^"\\]*)",?\s*$/;
/**
 * t/776 (Security p/131#99): a package.json in a Dependabot PR may change only version strings of keys that
 * already exist. From the file's patch: every changed line is a `"key": "<version spec>"` line, the removed
 * and added lines carry the same keys (nothing added or removed, so no new dependency name), and no key is
 * `scripts`. A script body ("build": "tsc") is not a version spec, so editing a script fails. Returns
 * { ok, why }. Unreadable (no patch) fails closed.
 */
export function packageJsonPatchOk(file) {
  const bad = (why) => ({ ok: false, why });
  if (!file || typeof file.patch !== 'string' || file.patch === '') return bad('its patch was not readable');
  if (file.status !== 'modified') return bad(`its status is ${file.status ?? 'unknown'}, not modified`);
  const removed = [];
  const added = [];
  for (const line of file.patch.split('\n')) {
    if (line.startsWith('@@') || line.startsWith('\\') || line === '' || line.startsWith(' ')) continue;
    const sign = line[0];
    if (sign !== '+' && sign !== '-') return bad('its patch has an unreadable line');
    const m = KV_LINE.exec(line.slice(1));
    if (!m) return bad(`it changes a line that is not a "key": "version" pair: ${line.slice(0, 60)}`);
    if (m[1] === 'scripts' || !isVersionSpec(m[2])) return bad(`it changes "${m[1]}" to a value that is not a version spec`);
    (sign === '-' ? removed : added).push(m[1]);
  }
  if (removed.length === 0 || removed.length !== added.length || [...removed].sort().join('\n') !== [...added].sort().join('\n')) {
    return bad('it adds or removes a key (a new dependency or script), not only changes versions');
  }
  return { ok: true, why: '' };
}
// ── t/796 (SO p/136#115): content checks for pnpm-lock.yaml and requirements*.txt ──────────────────────────────────
// A forged bot commit that touches only a lockfile can re-point an existing dependency's resolution (tarball URL or
// integrity) with no package.json change, and `pnpm install --frozen-lockfile` accepts it: install-time code execution.
// requirements*.txt can add a package or an index URL. Both checks read the file's PATCH, are linear (anchored,
// non-nested patterns on bounded lines), and fail closed on an unreadable patch. Shared rules: the status is modified,
// every changed line is one of a few known shapes, and the set of package names added is within the set removed (a version
// change keeps the name; a new package, which could be a typosquat, is not exempt).
const INTEGRITY = /^sha(?:512|384|256)-[A-Za-z0-9+/=]+$/;
const LOCK_HEADER = /^\s*'?((?:@[\w.-]+\/)?[\w.-]+)@([\w.+-]+)(?:\([^\n]*\))?'?:\s*$/;
const LOCK_RESOLUTION = /^\s*resolution:\s*\{([^{}\n]*)\}\s*$/;
const LOCK_VERSION = /^\s*(version|specifier):\s*'?([^'\s]+(?: [^'\s]+)*)'?\s*$/;
// A locked `version:` is one exact version, optionally with a peer suffix like `(react@18.2.0)`; nothing else may follow it.
const LOCK_EXACT_VERSION = /^\d[\w.+-]*(?:\([\w@./ ()+-]*\))?$/;
const LOCK_DEP = /^\s{4,}'?((?:@[\w.-]+\/)?[\w.-]+)'?:\s*'?(\d[\w.+-]*(?:\([^\n]*\))?)'?\s*$/;
const LOCK_META = /^\s*(?:engines|cpu|os|libc|hasBin|deprecated|optional|dev|requiresBuild|peerDependencies|peerDependenciesMeta|transitivePeerDependencies):?(?:\s.*)?$/;
const LOCK_LINE_MAX = 600;

function patchChangedLines(file) {
  if (!file || typeof file.patch !== 'string' || file.patch === '') return { why: 'its patch was not readable' };
  if (file.status !== 'modified') return { why: `its status is ${file.status ?? 'unknown'}, not modified` };
  const removed = [];
  const added = [];
  for (const line of file.patch.split('\n')) {
    if (line.startsWith('@@') || line.startsWith('\\') || line === '' || line.startsWith(' ')) continue;
    const sign = line[0];
    if (sign !== '+' && sign !== '-') return { why: 'its patch has an unreadable line' };
    if (line.length > LOCK_LINE_MAX) return { why: 'it changes a line over the length cap' };
    (sign === '-' ? removed : added).push(line.slice(1));
  }
  if (removed.length === 0 && added.length === 0) return { why: 'its patch changes nothing' };
  return { removed, added };
}

/** pnpm-lock.yaml: only versions, specifiers and integrity hashes of packages and dependency edges already in the file change. */
export function pnpmLockPatchOk(file) {
  const bad = (why) => ({ ok: false, why });
  const p = patchChangedLines(file);
  if (p.why) return bad(p.why);
  const names = { '-': new Set(), '+': new Set() };
  const depNames = { '-': new Set(), '+': new Set() };
  for (const [sign, lines] of [['-', p.removed], ['+', p.added]]) {
    for (const line of lines) {
      const res = LOCK_RESOLUTION.exec(line);
      if (res) {
        const pairs = res[1].split(',').map((x) => x.trim());
        let integrity = false;
        for (const pair of pairs) {
          const i = pair.indexOf(':');
          const key = pair.slice(0, i).trim();
          const val = pair.slice(i + 1).trim();
          if (key === 'integrity' && INTEGRITY.test(val)) integrity = true;
          // t/796 (SO p/136#119): pnpm omits `tarball` for a registry package, and ANY registry.npmjs.org path would let a forged
          // commit re-point `lodash@x` to another published package's tarball together with that tarball's own integrity. So a
          // `tarball:` key is refused outright: only an integrity-only resolution may change.
          else return bad(`it changes a resolution to \`${pair.slice(0, 80)}\` (only an integrity hash may change; a tarball key is refused)`);
        }
        if (!integrity) return bad('it changes a resolution that has no integrity hash');
        continue;
      }
      const head = LOCK_HEADER.exec(line);
      if (head) { names[sign].add(head[1]); continue; }
      const ver = LOCK_VERSION.exec(line);
      if (ver) {
        // Anchored: the whole value must be a version (or, for `specifier:`, a version range), so `1.0.0https://x/y.tgz` fails.
        const ok = ver[1] === 'version' ? LOCK_EXACT_VERSION.test(ver[2]) : isVersionSpec(ver[2]);
        if (!ok) return bad(`it changes a ${ver[1]} to a value that is not a plain version (${ver[2].slice(0, 60)})`);
        continue;
      }
      const dep = LOCK_DEP.exec(line);
      if (dep) { depNames[sign].add(dep[1]); continue; }
      if (LOCK_META.test(line)) continue;
      return bad(`it changes a line that is not a version, integrity, registry tarball or package header: ${line.trim().slice(0, 70)}`);
    }
  }
  for (const n of names['+']) {
    if (!names['-'].has(n)) return bad(`it adds the package \`${n}\`, which the file did not have (a new name, not a version change)`);
  }
  // A snapshot dependency line may change a version of an existing edge, never add an edge: it needs a removed line for the same name.
  for (const n of depNames['+']) {
    if (!depNames['-'].has(n)) return bad(`it adds a dependency edge to \`${n}\` (an added snapshot dependency line needs a removed line for the same name)`);
  }
  return { ok: true, why: '' };
}

/** requirements*.txt: only `name==version` (and hash) lines change, for names already present; no index URL, URL, VCS or new name. */
export function requirementsPatchOk(file) {
  const bad = (why) => ({ ok: false, why });
  const p = patchChangedLines(file);
  if (p.why) return bad(p.why);
  const REQ = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[A-Za-z0-9,._-]+\])?==([\w.+!-]+)(?:\s*;[^\n]*)?(?:\s*\\)?\s*$/;
  const HASH = /^\s*--hash=sha256:[0-9a-f]{64}(?:\s*\\)?\s*$/;
  const names = { '-': new Set(), '+': new Set() };
  for (const [sign, lines] of [['-', p.removed], ['+', p.added]]) {
    for (const line of lines) {
      if (HASH.test(line)) continue;
      if (line.trim().startsWith('#')) continue;
      const m = REQ.exec(line);
      if (!m || line.includes('://') || line.includes(' @ ')) return bad(`it changes a line that is not a plain \`name==version\` pin (no index URL, URL or VCS requirement): ${line.trim().slice(0, 70)}`);
      names[sign].add(m[1].toLowerCase());
    }
  }
  for (const n of names['+']) {
    if (!names['-'].has(n)) return bad(`it adds the package \`${n}\`, which the file did not have (a new name, not a version change)`);
  }
  return { ok: true, why: '' };
}

export function dependabotExemption(input) {
  const no = (reason) => ({ exempt: false, reason, commitCount: 0 });
  if (!input || typeof input !== 'object') return no('no Dependabot facts were read');
  const { authorLogin, headRepo, baseRepo, commits, commitsTotal } = input;
  if (authorLogin !== DEPENDABOT_PR_AUTHOR) return no(`the PR author is ${authorLogin ? `\`${authorLogin}\`` : 'unknown'}, not \`${DEPENDABOT_PR_AUTHOR}\``);
  if (typeof headRepo !== 'string' || typeof baseRepo !== 'string' || !headRepo || headRepo.toLowerCase() !== baseRepo.toLowerCase()) {
    return no('the head is not in this repository (a fork, or the repository is unreadable)');
  }
  if (!Array.isArray(commits) || commits.length === 0) return no('the commit list is empty or unreadable');
  if (!Number.isInteger(commitsTotal) || commitsTotal >= PR_COMMITS_LIST_CAP || commits.length !== commitsTotal) {
    return no(`the commit list may be cut short (listed ${commits.length}, the PR reports ${commitsTotal ?? 'no count'})`);
  }
  for (const c of commits) {
    const sha = String(c?.sha ?? '').slice(0, 9) || '?';
    if (c?.commit?.verification?.verified !== true) return no(`commit ${sha} is not verified (${c?.commit?.verification?.reason ?? 'no signature data'})`);
    const author = c?.author?.login ?? null;
    if (!DEPENDABOT_COMMIT_AUTHORS.includes(author)) return no(`commit ${sha} is by ${author ? `\`${author}\`` : 'no GitHub account'}, not an allowlisted bot`);
    const committer = c?.committer?.login ?? null;
    if (!DEPENDABOT_COMMIT_COMMITTERS.includes(committer)) return no(`commit ${sha} was committed by ${committer ? `\`${committer}\`` : 'no GitHub account'}, not GitHub's signer`);
  }
  // t/776: every changed path must be a manifest or lockfile, and the file list must be complete.
  const { files, filesTotal } = input;
  if (!Array.isArray(files) || files.length === 0) return no('the changed-file list is empty or unreadable');
  if (!Number.isInteger(filesTotal) || filesTotal >= PR_FILES_LIST_CAP || files.length !== filesTotal) {
    return no(`the changed-file list may be cut short (listed ${files.length}, the PR reports ${filesTotal ?? 'no count'})`);
  }
  for (const f of files) {
    for (const p of [f?.filename, ...(f?.previous_filename ? [f.previous_filename] : [])]) {
      if (!isDependabotBumpPath(p)) return no(`the PR changes \`${String(p).slice(0, 80)}\`, which is not a package manifest or lockfile`);
    }
    const base = String(f?.filename).slice(String(f?.filename).lastIndexOf('/') + 1);
    const content = base === 'package.json' ? packageJsonPatchOk(f)
      : base === 'pnpm-lock.yaml' ? pnpmLockPatchOk(f)
        : /^requirements[A-Za-z0-9._-]*\.txt$/.test(base) ? requirementsPatchOk(f) : { ok: true };
    if (!content.ok) return no(`${f.filename}: ${content.why}`);
  }
  return { exempt: true, reason: `Dependabot PR, ${commits.length} verified commit${commits.length === 1 ? '' : 's'} from an allowlisted bot, only manifests and lockfiles changed`, commitCount: commits.length };
}

/**
 * t/751: a body with no (or an unreadable) `Tier:` first line is T1 unless the Dependabot
 * exemption holds; a declared T0 or T2 is as before (T2 is judged by merge-approval, which
 * rewrites it to T1). Before this, such a body returned `not-t1` and passed with no approval
 * (#5578, #5599). `input.dependabot` is dependabotExemption's input; absent means not exempt.
 */
export function evaluateT1ApprovalGuard(input) {
  const declared = parseTier(input.body);
  if (declared !== null) return evaluateDeclaredTier(input, declared);
  const ex = dependabotExemption(input.dependabot);
  if (ex.exempt) return { pass: true, tier: null, declaredTier: null, reason: 'no-tier-dependabot-exempt', exemption: ex };
  const note = `no Tier line: treated as T1 (${ex.reason})`;
  const r = evaluateDeclaredTier(input, 'T1');
  return { ...r, declaredTier: null, tierNote: note, ...(r.pass ? {} : { summary: [note, r.summary].filter(Boolean).join('. ') }) };
}

function evaluateDeclaredTier({ headRefName, headSha, lastPushAt, approvalComments, botReviews, reviewerAppLogin }, tier) {
  if (tier !== 'T1') {
    return { pass: true, tier, reason: 'not-t1' };
  }

  // `botReviews` keeps its historical name so a caller and a predicate from different commits
  // still agree (the merge_group arm runs a PR's ci.yml against main's predicate), but callers
  // now pass EVERY review on the PR, human ones included, each with `commitId`.
  const reviews = botReviews || [];
  if (reviews.length > 0 && !headSha) {
    // t/200 (TL p/12#100): stays fail-closed; `reason` is unchanged. `summary` names the self-serve
    // fix: the usual caller with no headSha is a pre-#4804 branch's own t1-approval-guard.yml.
    return { pass: false, tier, reason: 'missing-head-sha', summary: MISSING_HEAD_SHA_SUMMARY };
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

  // t/311: the slot roles are already canonical (canonicalRole), so the owner slug goes through
  // the SAME alias table. Otherwise a `quality-techlead/...` branch (slug `qualitytechlead`)
  // approved as `Quality-TechLead` would compare `quality` against `qualitytechlead` and slip
  // past the self-approval check.
  const rawOwnerSlug = ownerSlugFromBranch(headRefName);
  const ownerSlug = rawOwnerSlug ? normalizeRole(canonicalRole(rawOwnerSlug)) : rawOwnerSlug;
  // t/739 (t/736): an approval counts only from a T1 REVIEWER ROLE. Before this, any role other
  // than the branch owner's counted, so `Approved (Design):` alone let T1 PR #5553 merge without
  // Quality's review. Each approval at the head that does not count is kept with its reason, so
  // the check text can say what was seen and why it was not enough.
  const rejected = [];
  const approvals = [...slots.values()]
    .filter((s) => s.kind === 'approved' && s.atHead && s.source !== 'human-review')
    .filter((s) => {
      // The owner rule stays: a listed role that is the branch owner's own still does not count.
      if (ownerSlug && normalizeRole(s.role).startsWith(ownerSlug)) { rejected.push({ role: s.role, at: s.at, why: 'branch_owner_role' }); return false; }
      if (!isT1ReviewerRole(s.role)) { rejected.push({ role: s.role, at: s.at, why: 'not_a_t1_reviewer_role' }); return false; }
      return true;
    })
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  if (approvals.length > 0) {
    return { pass: true, tier, reason: 'approved-after-push', approver: { role: approvals[0].role, at: approvals[0].at } };
  }
  if (rejected.length > 0) {
    // `reason` stays 'no-post-push-approval': the guard workflow and enqueue-pr key on it (awaiting
    // review, not a failure). `rejected` and `summary` say why the approvals present did not count.
    const seen = rejected.map((r) => `${r.role} (${r.why === 'branch_owner_role' ? "the branch owner's own role" : 'not a T1 reviewer role'})`).join(', ');
    return {
      pass: false, tier, reason: 'no-post-push-approval', rejected,
      summary: `No T1 reviewer's approval at the live head. Approvals seen that do not count: ${seen}. A T1 approval must start \`Approved (<role>):\` with <role> one of ${T1_REVIEWER_ROLES.join(', ')}, from a role other than the branch owner's.`,
    };
  }
  // t/449 (a): an approval-shaped comment the grammar does not read (`Security approval (t/444)...`)
  // used to be silently ignored. Refuse with the exact form the guard reads, and quote the line.
  const unread = [...(approvalComments || []), ...reviews]
    .map((c) => String(c?.body ?? '').trim().split('\n')[0])
    .find((line) => APPROVAL_SHAPE_RE.test(line) && !parseVerdict(line));
  if (unread) {
    return {
      pass: false, tier, reason: 'no-post-push-approval',
      summary: `No approval at the live head. A comment looks like an approval but the guard does not read it: \`${unread.slice(0, 120)}\`. The first line must start exactly with \`Approved (<role>):\`, for example \`Approved (Quality): <note>\`, and be posted after the latest push.`,
    };
  }
  return { pass: false, tier, reason: 'no-post-push-approval' };
}

// Verdict-shaped only: `Security approval (t/444)...`, `Approval (Quality): ...`. Prose that merely
// mentions an approval (the sweep's nudge: "a reviewer approval is recorded") does not match.
const APPROVAL_SHAPE_RE = /^[*_\s]*(?:[\w-]+\s+){0,2}approval\s*\(/i;
