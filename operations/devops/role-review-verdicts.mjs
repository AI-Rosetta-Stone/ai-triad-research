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
  // string to put in its skip reason.
  if (LOOSE_CHANGES_REQUESTED_RE.test(stripped)) {
    const roleMatch = LOOSE_ROLE_RE.exec(stripped);
    return { role: roleMatch ? roleMatch[1].trim() : '(unparseable)', kind: 'changes_requested', unparsed: true };
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
export function latestRoleVerdicts({ reviews, comments, reviewerAppLogin, headSha, lastPushAt }) {
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

  const latest = new Map();
  for (const e of entries) latest.set(e.role, { kind: e.kind, at: e.iso, unparsed: e.unparsed ?? false });
  return latest;
}
