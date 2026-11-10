// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Pure predicate: the LATEST role-tagged verdict per role, read from comment/review BODIES
 * through the reviewer App only -- never from GitHub's review `state` or `reviewDecision`
 * (t/4952 gap 2).
 *
 * WHY NOT REVIEW STATE: GitHub keeps only the latest review PER USER. On #4686, Design's
 * `CHANGES_REQUESTED` and Quality's `APPROVED` were both posted at 14:30, at the same head, by
 * the SAME reviewer-App account (every role here reviews through one shared App login,
 * `ai-triad-reviewer-jpsnover`). GitHub silently overwrote Design's request with Quality's
 * approval -- any guard reading review *state* can't see a role's block once another role's
 * later-posted review (even for a DIFFERENT role) lands on the same account. The fix is to never
 * trust `state`/`reviewDecision` for a role verdict at all: parse the body text, which carries
 * the role explicitly, and track verdicts per role, not per GitHub review slot.
 *
 * TAG GRAMMAR (docs/design-review.md, docs/agent-pr-approval.md -- shared with
 * t1-approval-guard-predicate.mjs's `Approved (<role>):` convention, extended with the other two
 * verdict words):
 *   - `Approved (<role>): ...`
 *   - `Changes requested (<role>): ...`
 *   - `Design-exempt (<role>): <reason>` -- reason must be non-empty (an exemption with nothing
 *     written after it is not a valid exemption, docs/design-review.md:46).
 *
 * CURRENT HEAD: a review counts only if `commitId === headSha` (GitHub binds a review to the
 * SHA it was submitted against). A comment has no such binding, so it counts only if its
 * EFFECTIVE time (`updatedAt` if edited, else `createdAt` -- same t1-approval-guard-predicate.mjs
 * convention) is after `lastPushAt` (SO's t/4945 direction: a comment predating the latest push
 * cannot vouch for content the push may have changed).
 *
 * LATEST PER ROLE: reviews and comments are merged into one timeline, sorted by effective time,
 * and the last entry for each role wins -- so a later `Changes requested (Design):` overrides an
 * earlier `Approved (Design):` at the same head, and vice versa. Different roles never collide.
 *
 * FAIL-OPEN GAP (Quality, p/780#46): Quality's real changes-requests render as
 * `**Changes requested (Quality), at <sha>...**` -- leading markdown bold, and a comma instead
 * of a colon after the role. The original strict grammar silently returned null for these (a
 * REAL block read as "no verdict"), while Design's plain-colon bodies parsed fine -- a fail-OPEN
 * asymmetry across roles. Fixed two ways: (1) the grammar now strips leading `**`/`*`/`_` and
 * accepts `:`, `,` or `.` after the role; (2) as a backstop against a FUTURE formatting variant
 * neither of us anticipated, any reviewer-App body that contains "changes requested" but still
 * doesn't match the grammar is NEVER silently dropped -- it registers as a `changes_requested`
 * verdict anyway (role name best-effort extracted, or `'(unparseable)'`), so the sweep still
 * blocks on it. Fails closed, not open, on an unrecognized shape.
 *
 * TWO NITS (Quality, p/780#48, approving #4696 with both left for follow-up):
 * 1. The backstop above originally scanned the WHOLE body for "changes requested" and for a
 *    role in ANY parenthesized group, which could match deep in unrelated prose (e.g. a long
 *    `Approved (Design):` comment that later explains "no changes requested from Quality").
 *    Scoped to the FIRST LINE only now, matching the strict grammar's own anchoring.
 * 2. A block keyed `'(unparseable)'` (role extraction totally failed) LATCHES: nothing else
 *    naturally produces that exact Map key, so it is NOT overwritten by a later verdict for a
 *    specific, different role -- and this is DELIBERATE, not a bug (Quality, p/780#54,
 *    correcting an over-eager first attempt at this nit that made it supersedable by ANY later
 *    entry -- that reintroduced #4686's exact shape: a badly-formed Design block, followed by
 *    an unrelated later `Approved (Quality):`, would have erased the block and let the sweep
 *    enqueue the PR). Since the ambiguous entry's role is UNKNOWN, there is no safe way to tell
 *    "a later verdict that resolves this specific block" apart from "a later verdict for some
 *    other, unrelated concern" -- so it stays latched until a genuinely NEW push. That happens
 *    for free via the existing head/push-binding checks above: a new push changes `headSha` (so
 *    an old unparseable REVIEW, bound to the old commit, no longer matches) and advances
 *    `lastPushAt` (so an old unparseable COMMENT, predating the new push, is filtered out the
 *    same as any other stale comment) -- `latestRoleVerdicts` only ever sees entries from the
 *    CURRENT head/push to begin with. If an explicit override is ever needed before a new push,
 *    the correct primitive is a new, role-tagged verdict word (e.g. `Cleared (<role>):`), not a
 *    same-head supersede rule here.
 */

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
