// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Keeps the `issue_comment` filter in t1-approval-guard.yml and tier-check.yml in step with the
// predicates they front. Each workflow runs its job for a created or edited PR comment only when
// the comment body (or, for an edit, its previous body) contains one of a short list of
// substrings. The list must be a SUPERSET of what the predicate reacts to: a missed run loses an
// approval or a block. A DELETED PR comment always runs the job, whatever its body.
//
// The REAL predicates are the oracle here, not a copy of their regexes: every candidate body is
// fed to latestRoleVerdicts / checkR6, and any body they react to must pass the workflow filter.
// Candidates are the `body:` literals of the predicates' own test files plus generated variants.
//
// Run: node --test operations/devops/comment-filter-workflow.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { latestRoleVerdicts } from './role-review-verdicts.mjs';
import { checkR6 } from './tier-check-predicate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const read = (...p) => readFileSync(path.join(root, ...p), 'utf8').replace(/\r\n/g, '\n');

const guardYml = read('.github', 'workflows', 't1-approval-guard.yml');
const tierYml = read('.github', 'workflows', 'tier-check.yml');

const HAYSTACK = "format('{0} {1}', github.event.comment.body, github.event.changes.body.from)";
const PR_KEY = '${{ github.event.pull_request.number || github.event.issue.number || github.event.merge_group.head_sha || github.run_id }}';
// t/237: tier-check's group also carries github.event_name, so a comment run can't cancel a PR-event run
// (it posts no head-pinned check). t1-approval-guard pins its verdict to the head SHA and keeps the shared key.
const PR_GROUP = { 't1-approval-guard.yml': `\${{ github.workflow }}-${PR_KEY}`, 'tier-check.yml': `\${{ github.workflow }}-\${{ github.event_name }}-${PR_KEY}` };
const SWEEP_MARKER = '<!-- t1-sweep-guard-rerun:';
const RECHECK = '/recheck-guards';

// ── Reading the filter out of the YAML ──────────────────────────────────────────────────────────

/** The folded block scalar (`key: >-`) between two marker comment lines, folded to one line. */
function foldedScalar(yml, beginMarker, endMarker, key) {
  const lines = yml.split('\n');
  const begin = lines.findIndex((l) => l.trim() === beginMarker);
  const end = lines.findIndex((l) => l.trim() === endMarker);
  assert.ok(begin >= 0 && end > begin, `markers "${beginMarker}" / "${endMarker}" not found in order`);
  const block = lines.slice(begin + 1, end);
  assert.equal(block[0].trim(), `${key}: >-`, `the line after "${beginMarker}" must be "${key}: >-"`);
  const body = block.slice(1);
  // A folded scalar joins lines with a space only when they share one indentation; a deeper line
  // keeps its newline. Uniform indentation keeps this reader and GitHub's YAML parser in agreement.
  const indents = new Set(body.map((l) => l.length - l.trimStart().length));
  assert.equal(indents.size, 1, `every line of the "${key}" scalar must have the same indentation`);
  return body.map((l) => l.trim()).join(' ');
}

function readFilter(yml) {
  const ifExpr = foldedScalar(yml, '# BEGIN comment-filter', '# END comment-filter', 'if');
  const group = foldedScalar(yml, '# BEGIN comment-filter (group copy)', '# END comment-filter (group copy)', 'group');
  const tokens = [...ifExpr.matchAll(/contains\(format\('\{0\} \{1\}', github\.event\.comment\.body, github\.event\.changes\.body\.from\), '([^']*)'\)/g)].map((m) => m[1]);
  return { ifExpr, group, tokens };
}

/** The exact expression a token list must produce. Pins the whole `if:`, not only its strings. */
function expectedIf(tokens) {
  return [
    '${{',
    '(github.event.issue.pull_request || !github.event.issue)',
    '&& (',
    "github.event_name != 'issue_comment'",
    "|| github.event.action == 'deleted'",
    ...tokens.map((t) => `|| contains(${HAYSTACK}, '${t}')`),
    ')',
    '}}',
  ].join(' ');
}

/**
 * The `if:` as JavaScript. Valid only because expectedIf() pins the expression's shape.
 * GitHub's contains() ignores case; a missing property reads as an empty string.
 */
function jobRuns(tokens, event) {
  const isPrOrNotIssue = Boolean(event.issue?.pull_request) || !event.issue;
  if (!isPrOrNotIssue) return false;
  if (event.eventName !== 'issue_comment') return true;
  if (event.action === 'deleted') return true; // never filtered: the body of a deletion is not relied on
  const haystack = `${event.comment?.body ?? ''} ${event.changes?.body?.from ?? ''}`.toLowerCase();
  return tokens.some((t) => haystack.includes(t.toLowerCase()));
}

const prComment = (body) => ({ eventName: 'issue_comment', issue: { number: 7, pull_request: {} }, comment: { body } });
const prCommentEdit = (body, from) => ({ ...prComment(body), changes: { body: { from } } });

const guard = readFilter(guardYml);
const tier = readFilter(tierYml);

// ── Candidate bodies ────────────────────────────────────────────────────────────────────────────

const HEAD = 'c81d7dd8ec596f458dbd199b7e0a697df77ec3dd';

/** Every `body: '...'` / "..." / `...` literal in a test file, unescaped; `${HEAD}` filled in. */
function harvestBodies(testFile) {
  const src = read('operations', 'devops', testFile);
  const out = [];
  for (const m of src.matchAll(/\bbody:\s*(['"`])((?:\\[\s\S]|(?!\1)[^\\])*)\1/g)) {
    let s = m[2].replace(/\$\{HEAD\}/g, HEAD);
    if (s.includes('${')) continue; // some other interpolation: not a fixed body
    s = s.replace(/\\(n|t|[\s\S])/g, (_, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));
    out.push(s);
  }
  return out;
}

const APP = 'ai-triad-reviewer-jpsnover[bot]';
const PUSH_AT = '2026-10-19T12:00:00Z';
const AFTER_PUSH = '2026-10-19T12:05:00Z';

/** True when the guard's verdict code reads this comment body as a verdict (reviewer-App login,
 *  the most permissive path: strict grammar plus the fail-closed backstop). */
function guardReacts(body) {
  const slots = latestRoleVerdicts({
    reviews: [], comments: [{ body, login: APP, createdAt: AFTER_PUSH }],
    reviewerAppLogin: APP, headSha: HEAD, lastPushAt: PUSH_AT, mode: 'gate',
  });
  return slots.size > 0;
}

/**
 * True when this comment body is R6 evidence (t/116: no comment approves, PI ruling t/116#31):
 * it supplies the SO half, or it adds a block (from the reviewer App or the shared login).
 * The approval half is a reviewer-App REVIEW, never a comment.
 */
function tierReacts(body) {
  const appApproval = [{ state: 'APPROVED', commitId: HEAD, login: APP, body: 'Approved (Tech Lead): ok.', submittedAt: AFTER_PUSH }];
  const soHalf = { body: 'SO did not review within the time-box.', createdAt: AFTER_PUSH };
  // As the SO half: with an App approval review and no SO evidence, R6 fires; with this comment, it clears.
  const asSo = !checkR6(true, [], [{ body, createdAt: AFTER_PUSH }], appApproval, HEAD, APP, PUSH_AT);
  // As a block: with an App approval review and SO evidence, R6 is clear; adding this comment makes it fire.
  const asBlock = [APP, undefined].some((login) => checkR6(true, [], [soHalf, { login, body, createdAt: AFTER_PUSH }], appApproval, HEAD, APP, PUSH_AT));
  return asSo || asBlock;
}

function guardVariants() {
  const out = [];
  for (const word of ['Approved', 'Changes requested', 'Design-exempt']) {
    for (const lead of ['', '**', '*', '_', '__', '** ', '  ', '\n\n', '\t']) {
      for (const gap of ['', ' ', '  ', '\t', '\n']) {
        for (const punct of [':', ',', '.']) {
          out.push(`${lead}${word}${gap}(Quality)${punct} at abc123, see below.`);
        }
      }
    }
  }
  out.push(
    'changes requested', 'CHANGES REQUESTED (Design) - see the error path', 'Re-review: Changes Requested by Quality',
    '**Changes requested (Quality), at abc123, re: the error path.**', 'Approved (Tech Lead): ok', 'Approved (Quality-TechLead). fine',
  );
  return out;
}

function tierVariants() {
  return [
    'Approved (PI): go ahead.', 'Some context first.\nApproved (PI): proceeding.', 'Approved (PI):',
    'Changes requested (Quality): fix it.', '**Changes requested (Design), at abc123.**', 'CHANGES REQUESTED',
    'Changes requested (Tech Lead): no.', 'Context.\nChanges requested (Security): see the note.',
    'SO did not review within the time-box.', 'so DID NOT review this one', 'Marked: SO did not review',
    `**SO clearing comment (T2, t/4266), head \`${HEAD}\`.**`, `so clearing comment ${HEAD}`, `Note.\nSO clearing comment, head ${HEAD}`,
  ];
}

const CHATTER = [
  'Head updated to abc123',
  'Head updated to 65ab11a02585bcadd6e76dad463ebfbde285d291. Rebased onto main, no content change.',
  'Ready for reviewer approval',
  'CI has been green for 37 min',
  'Pushed a fix for the lint failure; waiting on ci-gate.',
  'Enqueued pinned at the current head.',
  '',
];

// ── The expression itself ───────────────────────────────────────────────────────────────────────

for (const [name, f] of [['t1-approval-guard.yml', guard], ['tier-check.yml', tier]]) {
  test(`${name}: the if: is exactly the PR-comment condition AND (not issue_comment OR a listed substring)`, () => {
    assert.ok(f.tokens.length > 0, 'no filter substrings found');
    assert.equal(f.ifExpr, expectedIf(f.tokens));
    for (const t of f.tokens) assert.ok(t.length >= 8, `"${t}" is too short to be distinctive`);
  });

  test(`${name}: the concurrency group carries the SAME filter, so a skipped run never shares the PR's group`, () => {
    const inner = f.ifExpr.replace(/^\$\{\{ /, '').replace(/ \}\}$/, '');
    assert.equal(f.group, `${PR_GROUP[name]}-\${{ ( ${inner} ) && 'evaluate' || github.run_id }}`);
  });

  test(`${name}: the explicit re-run token runs the job, and the header and docs/pr-landing.md name it`, () => {
    assert.ok(f.tokens.includes(RECHECK));
    assert.equal(jobRuns(f.tokens, prComment(`${RECHECK}`)), true);
    assert.equal(jobRuns(f.tokens, prComment(`Dismissed the stale review.\n\n${RECHECK}\n`)), true);
    const yml = name.startsWith('t1') ? guardYml : tierYml;
    assert.match(yml.slice(0, yml.indexOf('\non:\n')), /\/recheck-guards/, 'the workflow header must document the token');
    assert.match(read('docs', 'pr-landing.md'), /\/recheck-guards/);
  });

  test(`${name}: status chatter does not run the job`, () => {
    for (const body of CHATTER) assert.equal(jobRuns(f.tokens, prComment(body)), false, `chatter ran the job: ${JSON.stringify(body)}`);
  });

  test(`${name}: every other trigger still runs, and a comment on a plain issue never does`, () => {
    assert.equal(jobRuns(f.tokens, { eventName: 'pull_request_target' }), true);
    assert.equal(jobRuns(f.tokens, { eventName: 'pull_request_review' }), true);
    const plainIssue = { eventName: 'issue_comment', issue: { number: 7 }, comment: { body: `Approved (PI): x ${RECHECK}` } };
    assert.equal(jobRuns(f.tokens, plainIssue), false);
  });

  test(`${name}: an edit runs the job when EITHER the new or the previous body matches`, () => {
    const verdict = f.tokens[0] === 'Approved' ? 'Approved (Quality): ok' : 'Changes requested (Quality): no';
    assert.equal(jobRuns(f.tokens, prCommentEdit(verdict, 'Looking now.')), true, 'edited INTO a verdict');
    assert.equal(jobRuns(f.tokens, prCommentEdit('Withdrawn, see below.', verdict)), true, 'a verdict edited AWAY must re-evaluate');
    assert.equal(jobRuns(f.tokens, prCommentEdit('Head updated to abc124', 'Head updated to abc123')), false, 'chatter edited into chatter');
  });
}

// ── t1-approval-guard: superset of role-review-verdicts.mjs ─────────────────────────────────────

test('guard: every body the verdict code reads as a verdict runs the job (its own test fixtures + variants)', () => {
  const candidates = [
    ...harvestBodies('role-review-verdicts.test.mjs'),
    ...harvestBodies('t1-approval-guard-predicate.test.mjs'),
    ...harvestBodies('t1-approval-guard-workflow.test.mjs'),
    ...guardVariants(),
  ];
  const reacting = candidates.filter(guardReacts);
  assert.ok(candidates.length > 150 && reacting.length > 100, `too few candidates to mean anything (${reacting.length} of ${candidates.length} react)`);
  for (const body of reacting) {
    assert.equal(jobRuns(guard.tokens, prComment(body)), true, `the guard reads this as a verdict, but the filter would skip it: ${JSON.stringify(body)}`);
    assert.equal(jobRuns(guard.tokens, prCommentEdit('edited away', body)), true, `filter would skip the edit that withdraws: ${JSON.stringify(body)}`);
  }
});

test('guard: the oracle is live -- it reads spacing and case variants the plain `Approved (` substring would miss', () => {
  assert.equal(guardReacts('Approved(Quality): ok'), true);
  assert.equal(guardReacts('Approved\n(Quality): ok'), true);
  assert.equal(guardReacts('CHANGES REQUESTED, details to follow'), true);
  assert.equal(guardReacts('Head updated to abc123'), false);
});

test('guard: the sweep marker runs the job', () => {
  assert.ok(guard.tokens.includes(SWEEP_MARKER));
  assert.equal(jobRuns(guard.tokens, prComment(`${SWEEP_MARKER} 65ab11a0 -->\nRe-running t1-approval-guard: its run for this head was lost.`)), true);
});

test('guard: a skipped job cannot be read as a verdict -- the job id is not the posted check name', () => {
  const jobIds = [...guardYml.slice(guardYml.indexOf('\njobs:\n')).matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gm)].map((m) => m[1]);
  assert.deepEqual(jobIds, ['evaluate']);
  assert.ok(!/^\s+name:\s*t1-approval-guard\s*$/m.test(guardYml.slice(guardYml.indexOf('\njobs:\n'))), 'the job must not be display-named t1-approval-guard either');
  assert.match(guardYml, /name: 't1-approval-guard', head_sha: headSha/, 'the verdict is the explicit check run pinned to the PR head');
});

// ── tier-check: superset of checkR6's comment evidence ──────────────────────────────────────────

test('tier-check: every body R6 reads as evidence runs the job (its own test fixtures + variants)', () => {
  const candidates = [...harvestBodies('tier-check-predicate.test.mjs'), ...tierVariants()];
  const reacting = candidates.filter(tierReacts);
  assert.ok(reacting.length >= 12, `too few reacting candidates to mean anything (${reacting.length} of ${candidates.length})`);
  for (const body of reacting) {
    assert.equal(jobRuns(tier.tokens, prComment(body)), true, `R6 reads this as evidence, but the filter would skip it: ${JSON.stringify(body)}`);
  }
});

test('tier-check: the oracle is live -- each kind of R6 comment evidence reacts, chatter does not', () => {
  assert.equal(tierReacts('SO did not review within the time-box.'), true);
  assert.equal(tierReacts(`**SO clearing comment, head \`${HEAD}\`.**`), true);
  assert.equal(tierReacts('Changes requested (Quality): fix it.'), true, 'a changes-request comment adds an R6 block (t/116)');
  assert.equal(tierReacts('CHANGES REQUESTED'), true, 'the App latch blocks too');
  assert.equal(tierReacts('Approved (PI): go ahead.'), false, 'no comment approves in R6 (PI ruling t/116#31)');
  assert.equal(tierReacts('Approved (Quality): fine'), false, 'a role approval comment is not R6 evidence');
  assert.equal(tierReacts('Head updated to abc123'), false);
});

test('tier-check: comment bodies are read ONLY by checkR6 -- a new reader must extend the filter', () => {
  const predicate = read('operations', 'devops', 'tier-check-predicate.mjs');
  const code = predicate.split('\n').filter((l) => !/^\s*(\/\/|\/?\*)/.test(l)).join('\n');
  // What the header of tier-check.yml's filter names, each used in checkR6: the two SO patterns, and
  // latestRoleVerdicts for the comment blocks (t/116). No comment-approval pattern exists any more.
  for (const re of ['SO_DID_NOT_REVIEW_RE', 'SO_CLEARING_PREFIX_RE']) {
    assert.match(code, new RegExp(`const ${re} = `));
  }
  assert.doesNotMatch(code, /PI_COMMENT_APPROVAL_RE/, 'the Approved (PI): comment path is gone (PI ruling t/116#31)');
  assert.match(code, /comments: blockComments/, 'R6 blocks read the comments through latestRoleVerdicts');
  assert.match(code, /latestRoleVerdicts\(\{ reviews, comments: \[\]/, 'R6 approvals read no comment');
  const usesOfComments = [...code.matchAll(/\bapprovalComments\b/g)].length;
  assert.equal(usesOfComments, 2, 'approvalComments must appear exactly twice in evaluateTierCheck: destructured, then passed to checkR6');
  assert.match(code, /checkR6\(tier === 'T2' \|\| Boolean\(r1\), labels, approvalComments \?\? \[\]/);
});

// ── One table of comment shapes, run through BOTH workflows' lists (SO condition 3, #5176) ─────
//
// Each row is one event. `guard` / `tier` state whether that workflow's job must RUN (true) or
// SKIP (false). An edit row matches on one half only (new body or previous body), so the two
// halves of the searched text are each proven on their own. A deleted PR comment RUNS both
// workflows whatever its body (chatter and an empty body included): the lists are not applied to
// a deletion, because whether the event carries the deleted comment's body is not confirmed.

const SO_CLEARING = `**SO clearing comment (T2, t/4266), head \`${HEAD}\`.**`;
const onPr = (action, body, from) => ({
  eventName: 'issue_comment', action, issue: { number: 7, pull_request: {} }, comment: { body },
  ...(from === undefined ? {} : { changes: { body: { from } } }),
});
const created = (body) => onPr('created', body);
const edited = (from, to) => onPr('edited', to, from);
const deleted = (body) => onPr('deleted', body);

const SHAPES = [
  // name, event, guard runs, tier-check runs
  ['verdict created (approval)', created('Approved (Quality): ok at abc123'), true, false],
  ['verdict created (changes request) -- an R6 block since t/116', created('Changes requested (Design): fix the error path'), true, true],
  ['verdict created (exemption)', created('Design-exempt (Design): store-only fix'), true, false],
  ['chatter created', created('Head updated to abc123'), false, false],
  ['chatter created (ready)', created('Ready for reviewer approval'), false, false],
  ['chatter created (CI)', created('CI has been green for 37 min'), false, false],
  ['chatter edited into a verdict (new body only)', edited('Looking now.', 'Approved (Quality): ok'), true, false],
  ['verdict edited into chatter (previous body only)', edited('Approved (Quality): ok', 'Withdrawn, see below.'), true, false],
  ['changes request edited into chatter (previous body only)', edited('**Changes requested (Quality), at abc123**', 'Resolved.'), true, true],
  ['chatter edited into chatter', edited('Head updated to abc123', 'Head updated to abc124'), false, false],
  ['verdict deleted (unfiltered: runs both)', deleted('Approved (Quality): ok'), true, true],
  ['changes request deleted (unfiltered: runs both)', deleted('Changes requested (Design): no'), true, true],
  ['chatter deleted (unfiltered: RUNS both, by design)', deleted('Head updated to abc123'), true, true],
  ['deleted with an EMPTY body (unfiltered: RUNS both -- the case the filter could not see)', deleted(''), true, true],
  ['deleted with no body field at all (unfiltered: RUNS both)', { eventName: 'issue_comment', action: 'deleted', issue: { number: 7, pull_request: {} }, comment: {} }, true, true],
  ['sweep marker', created(`${SWEEP_MARKER} 65ab11a0 -->\nRe-running the guard: its run for this head was lost.`), true, false],
  ['/recheck-guards', created('/recheck-guards'), true, true],
  ['/recheck-guards inside a longer comment', created('Dismissed the stale review.\n\n/recheck-guards\n'), true, true],
  ['/RECHECK-GUARDS (mixed case)', created('/Recheck-Guards'), true, true],
  // t/116 (PI ruling t/116#31): no comment approves in R6, so a PI approval comment is not tier-check evidence.
  ['PI approval created -- not R6 evidence since t/116', created('Approved (PI): go ahead.'), true, false],
  ['PI approval on a later line', created('Context first.\nApproved (PI): proceeding.'), true, false],
  ['chatter edited into a PI approval (new body only)', edited('Reading.', 'Approved (PI): go ahead.'), true, false],
  ['PI approval edited into chatter (previous body only)', edited('Approved (PI): go ahead.', 'Retracted.'), true, false],
  ['PI approval deleted (unfiltered: runs both)', deleted('Approved (PI): go ahead.'), true, true],
  ['SO clearing created', created(SO_CLEARING), false, true],
  ['chatter edited into an SO clearing (new body only)', edited('Reviewing.', SO_CLEARING), false, true],
  ['SO clearing edited into chatter (previous body only)', edited(SO_CLEARING, 'Clearing withdrawn.'), false, true],
  ['SO clearing deleted (unfiltered: runs both)', deleted(SO_CLEARING), true, true],
  ['"SO did not review" created', created('SO did not review within the time-box.'), false, true],
  ['"SO did not review" edited away (previous body only)', edited('SO did not review within the time-box.', 'The SO replied after all.'), false, true],
  ['"SO did not review" deleted (unfiltered: runs both)', deleted('SO did not review within the time-box.'), true, true],
  ['markdown-emphasised verdict (bold, comma)', created('**Changes requested (Quality), at abc123, re: the error path.**'), true, true],
  ['markdown-emphasised verdict (underscore)', created('_Approved (Tech Lead)._ fine'), true, false],
  ['odd whitespace: no space before the parenthesis', created('Approved(Quality): ok'), true, false],
  ['odd whitespace: newline before the parenthesis', created('Approved\n(Quality): ok'), true, false],
  ['odd whitespace: leading blank lines and tabs', created('\n\n\t**  Design-exempt\t(Design): docs only'), true, false],
  ['mixed case: reviewer-App backstop', created('CHANGES REQUESTED (design) -- details to follow'), true, true],
  ['mixed case: SO did not review', created('so DID NOT review this one'), false, true],
  ['mixed case: so clearing comment', created(`so CLEARING comment ${HEAD}`), false, true],
  // Supersets: the lists ignore case, the predicates do not. An extra run is harmless.
  ['mixed case: approved (pi): -- over-triggers the guard only', created('approved (pi): x'), true, false],
  ['mixed case: changes requested in prose -- over-triggers both, by design', created('changes requested, in prose'), true, true],
  ['prose that mentions "approved" -- over-triggers the guard, by design', created('Head updated; previously approved by Quality.'), true, false],
  // t/538 (t/437#9, observed live on #5436): a comment of only lower-case "approved" runs the guard
  // (contains() ignores case) and skips tier-check (no approval-shaped token is on its list). By design:
  // tier-check reads no T1 verdict. The guard's predicate does not count it (t1-approval-guard-pending.test.mjs).
  ['t/538: bare lower-case "approved" -- runs the guard, skips tier-check, by design', created('approved'), true, false],
  ['empty body', created(''), false, false],
  ['verdict on a plain issue (not a PR)', { eventName: 'issue_comment', action: 'created', issue: { number: 7 }, comment: { body: 'Approved (PI): x /recheck-guards' } }, false, false],
  ['verdict deleted on a plain issue (the PR condition still applies)', { eventName: 'issue_comment', action: 'deleted', issue: { number: 7 }, comment: { body: 'Approved (Quality): ok' } }, false, false],
  ['pull_request_review submitted (never filtered)', { eventName: 'pull_request_review', action: 'submitted', pull_request: { number: 7 } }, true, true],
  ['pull_request_review dismissed (never filtered)', { eventName: 'pull_request_review', action: 'dismissed', pull_request: { number: 7 } }, true, true],
  ['pull_request_target synchronize (never filtered)', { eventName: 'pull_request_target', action: 'synchronize', pull_request: { number: 7 } }, true, true],
];

for (const [name, event, guardRuns, tierRuns] of SHAPES) {
  test(`shape: ${name} -> guard ${guardRuns ? 'RUNS' : 'skips'}, tier-check ${tierRuns ? 'RUNS' : 'skips'}`, () => {
    assert.equal(jobRuns(guard.tokens, event), guardRuns, 't1-approval-guard.yml');
    assert.equal(jobRuns(tier.tokens, event), tierRuns, 'tier-check.yml');
  });
}

test('shapes: every edit row matches on exactly one half, and both halves are exercised for both lists', () => {
  const half = (tokens, text) => tokens.some((t) => String(text).toLowerCase().includes(t.toLowerCase()));
  const seen = { guard: { newBody: 0, previous: 0 }, tier: { newBody: 0, previous: 0 } };
  for (const [name, event] of SHAPES) {
    if (event.action !== 'edited') continue;
    for (const [key, tokens] of [['guard', guard.tokens], ['tier', tier.tokens]]) {
      const inNew = half(tokens, event.comment.body);
      const inPrev = half(tokens, event.changes.body.from);
      assert.ok(!(inNew && inPrev), `"${name}" matches ${key} on both halves, so it proves neither`);
      if (inNew) seen[key].newBody++;
      if (inPrev) seen[key].previous++;
    }
  }
  for (const key of ['guard', 'tier']) {
    assert.ok(seen[key].newBody >= 1 && seen[key].previous >= 2, `${key}: ${JSON.stringify(seen[key])}`);
  }
});

test('shapes: no row disagrees with the predicates -- anything a predicate reacts to is a RUN row for its workflow', () => {
  for (const [name, event, guardRuns, tierRuns] of SHAPES) {
    if (event.eventName !== 'issue_comment' || !event.issue?.pull_request) continue;
    for (const body of [event.comment.body, event.changes?.body?.from].filter((b) => b !== undefined)) {
      if (guardReacts(body)) assert.equal(guardRuns, true, `"${name}": the guard reads ${JSON.stringify(body)} as a verdict`);
      if (tierReacts(body)) assert.equal(tierRuns, true, `"${name}": R6 reads ${JSON.stringify(body)} as evidence`);
    }
  }
});

// ── Removed approvals re-evaluate (SO condition 1, #5176) ───────────────────────────────────────

function triggerTypes(yml, event) {
  const m = new RegExp(`^  ${event}:\\n(?:    branches: .*\\n)?    types: \\[([^\\]]*)\\]`, 'm').exec(yml.slice(yml.indexOf('\non:\n')));
  assert.ok(m, `no inline types list for ${event}`);
  return m[1].split(',').map((s) => s.trim());
}

for (const [name, yml] of [['t1-approval-guard.yml', guardYml], ['tier-check.yml', tierYml]]) {
  test(`${name}: a deleted or edited comment and a dismissed review are triggers`, () => {
    assert.deepEqual(triggerTypes(yml, 'issue_comment'), ['created', 'edited', 'deleted']);
    // t/534 part B (the guard) and t/544 (tier-check): neither runs on pull_request_review (a PR-side
    // workflow file); the permission-less relay does, and both follow it via workflow_run (from main).
    assert.ok(!/^  pull_request_review:/m.test(yml.slice(yml.indexOf('\non:\n'))), `${name} must not trigger on pull_request_review`);
    assert.match(yml.slice(yml.indexOf('\non:\n')), /^  workflow_run:\n    workflows: \[t1-approval-review-relay\]\n    types: \[completed\]/m);
    assert.deepEqual(triggerTypes(read('.github', 'workflows', 't1-approval-review-relay.yml'), 'pull_request_review'), ['submitted', 'dismissed']);
  });
}

// The guard's REAL github-script body, run against a mocked GitHub API, with the payload of each
// new event. `git show basetip:<path>` serves this checkout's files as main's tip.
const nodeRequire = createRequire(import.meta.url);
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const PR_HEAD = 'd'.repeat(40);

function scriptBlock(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^\s*script:\s*\|\s*$/.test(l));
  assert.ok(start >= 0, 'no "script: |" block');
  const body = [];
  let indent = null;
  for (const l of lines.slice(start + 1)) {
    if (l.trim() === '') { body.push(''); continue; }
    const ind = l.match(/^ */)[0].length;
    if (indent === null) indent = ind;
    if (ind < indent) break;
    body.push(l.slice(indent));
  }
  return body.join('\n');
}

async function runGuard({ payload, comments = [], reviews = [] }) {
  const log = { info: [], warning: [], error: [], failed: [] };
  const checks = [];
  const asked = [];
  const api = {
    'pulls.get': (p) => { asked.push(p.pull_number); return {
      number: 7, body: 'Tier: T1\n\nA change.', created_at: '2026-10-18T00:00:00Z',
      head: { sha: PR_HEAD, ref: 'devops/comment-filter' }, base: { ref: 'main' },
    }; },
    'pulls.listCommits': () => [{ commit: { committer: { date: PUSH_AT } } }],
    'pulls.listFiles': () => [{ filename: 'docs/notes.md', status: 'modified' }], // t/776: the guard lists the PR's files
    'issues.listComments': () => comments,
    'pulls.listReviews': () => reviews,
    'issues.createComment': () => ({}),
    'issues.updateComment': () => ({}),
    'checks.create': (p) => { checks.push(p); return {}; },
  };
  const rest = {};
  for (const [key, fn] of Object.entries(api)) {
    const [ns, m] = key.split('.');
    rest[ns] ??= {};
    rest[ns][m] = async (params) => ({ data: fn(params) });
  }
  const github = { rest, paginate: async (method, params) => (await method(params)).data };
  const execSync = (cmd) => {
    if (/^git fetch origin /.test(cmd)) return '';
    if (/^git rev-parse FETCH_HEAD$/.test(cmd)) return 'basetip\n';
    const show = /^git show basetip:(operations\/devops\/[\w.-]+\.mjs)$/.exec(cmd);
    if (show) return readFileSync(path.join(root, show[1]), 'utf8');
    throw new Error(`test harness: unexpected command: ${cmd}`);
  };
  const fakeRequire = (id) => (id === 'child_process' ? { execSync } : nodeRequire(id));
  const core = {
    info: (m) => log.info.push(m), warning: (m) => log.warning.push(m),
    error: (m) => log.error.push(m), setFailed: (m) => log.failed.push(m),
  };
  const context = { repo: { owner: 'o', repo: 'r' }, payload: { repository: { default_branch: 'main' }, ...payload } };
  const prevWs = process.env.GITHUB_WORKSPACE;
  process.env.GITHUB_WORKSPACE = root;
  try {
    await new AsyncFunction('require', 'github', 'context', 'core', 'setTimeout', scriptBlock(guardYml))(fakeRequire, github, context, core, (fn) => { fn(); return 0; });
  } finally {
    if (prevWs === undefined) delete process.env.GITHUB_WORKSPACE; else process.env.GITHUB_WORKSPACE = prevWs;
  }
  return { log, checks, asked };
}

const apiComment = (body, at, login = 'jpsnover') => ({ body, created_at: at, updated_at: at, user: { login } });
const apiReview = (state, body) => ({ state, body, submitted_at: AFTER_PUSH, commit_id: PR_HEAD, user: { login: APP, type: 'Bot' } });
const commentPayload = (action, body) => ({ action, issue: { number: 7, pull_request: {} }, comment: { body } });
const reviewPayload = (action, state) => ({ action, pull_request: { number: 7 }, review: { state } });

function assertOneCheck(result, conclusion) {
  assert.deepEqual(result.asked.slice(0, 1), [7], 'the PR number is resolved from the payload');
  assert.equal(result.checks.length, 1, `expected one check run; errors: ${JSON.stringify(result.log.error)}`);
  assert.equal(result.checks[0].name, 't1-approval-guard');
  assert.equal(result.checks[0].head_sha, PR_HEAD, 'pinned to the PR head read from the API, not the event SHA');
  assert.equal(result.checks[0].conclusion, conclusion);
}

// t/534: with the approval gone the head is AWAITING REVIEW again: the check goes back to pending
// (in_progress), which enqueue-pr.mjs refuses as guard_in_progress. It must never stay success.
function assertPending(result) {
  assert.equal(result.checks.length, 1, `expected one check run; errors: ${JSON.stringify(result.log.error)}`);
  assert.equal(result.checks[0].head_sha, PR_HEAD);
  assert.equal(result.checks[0].status, 'in_progress');
  assert.equal(result.checks[0].conclusion, undefined, 'a pending run has no conclusion, and never success');
  assert.deepEqual(result.log.failed, [], 'awaiting review does not fail the job (t/534)');
}

test('guard script, issue_comment.deleted: the approval comment is gone from the list -> the head goes back to pending, not success', async () => {
  const approval = 'Approved (Quality): fine';
  const before = await runGuard({ payload: commentPayload('created', approval), comments: [apiComment(approval, AFTER_PUSH)] });
  assertOneCheck(before, 'success');
  const after = await runGuard({ payload: commentPayload('deleted', approval), comments: [] });
  assertPending(after);
});

test('guard script, issue_comment.deleted: deleting the only changes-request comment unblocks an approved PR', async () => {
  const approval = apiComment('Approved (Quality): fine', AFTER_PUSH);
  const blocked = await runGuard({ payload: commentPayload('created', 'Changes requested (Design): no'), comments: [approval, apiComment('Changes requested (Design): no', '2026-10-19T12:06:00Z')] });
  assertOneCheck(blocked, 'failure');
  const cleared = await runGuard({ payload: commentPayload('deleted', 'Changes requested (Design): no'), comments: [approval] });
  assertOneCheck(cleared, 'success');
});

test('guard script, pull_request_review.dismissed: a dismissed reviewer-App approval no longer satisfies the gate', async () => {
  const body = 'Approved (Quality): fine';
  const before = await runGuard({ payload: reviewPayload('submitted', 'approved'), reviews: [apiReview('APPROVED', body)] });
  assertOneCheck(before, 'success');
  const after = await runGuard({ payload: reviewPayload('dismissed', 'dismissed'), reviews: [apiReview('DISMISSED', body)] });
  assertPending(after);
});

test('guard script, pull_request_review.dismissed: one of two approvals dismissed -> the other still satisfies the gate', async () => {
  const result = await runGuard({
    payload: reviewPayload('dismissed', 'dismissed'),
    // t/739: the surviving approval was Design's until Design stopped being a T1 approver.
    reviews: [apiReview('DISMISSED', 'Approved (Quality): fine'), apiReview('APPROVED', 'Approved (Tech Lead): fine')],
  });
  assertOneCheck(result, 'success');
});

test('tier-check R6: a dismissed reviewer-App approval stops counting, so a dismissal must re-evaluate', () => {
  const so = [{ body: SO_CLEARING, createdAt: AFTER_PUSH }];
  const review = (state) => [{ state, commitId: HEAD, login: APP, body: 'Approved (Tech Lead): T2 approval at this head.', submittedAt: AFTER_PUSH }];
  assert.equal(checkR6(true, [], so, review('APPROVED'), HEAD, APP, PUSH_AT), false, 'approved + SO cleared: no advisory');
  assert.equal(checkR6(true, [], so, review('DISMISSED'), HEAD, APP, PUSH_AT), true, 'the advisory is back once the approval is dismissed');
});

test('tier-check R6: deleting the SO clearing comment brings the advisory back, deleting a changes-request lifts the block', () => {
  const tl = [{ state: 'APPROVED', commitId: HEAD, login: APP, body: 'Approved (Tech Lead): ok.', submittedAt: AFTER_PUSH }];
  const so = { body: SO_CLEARING, createdAt: AFTER_PUSH };
  const cr = { login: APP, body: 'Changes requested (Quality): no.', createdAt: AFTER_PUSH };
  assert.equal(checkR6(true, [], [so], tl, HEAD, APP, PUSH_AT), false, 'App approval + SO cleared: no advisory');
  assert.equal(checkR6(true, [], [], tl, HEAD, APP, PUSH_AT), true, 'SO clearing deleted');
  assert.equal(checkR6(true, [], [so, cr], tl, HEAD, APP, PUSH_AT), true, 'a changes-request comment blocks');
  assert.equal(checkR6(true, [], [so], tl, HEAD, APP, PUSH_AT), false, 'the changes-request deleted: the block lifts');
});

test('tier-check R6: a PI approval COMMENT never clears the advisory (PI ruling t/116#31)', () => {
  const so = { body: SO_CLEARING, createdAt: AFTER_PUSH };
  assert.equal(checkR6(true, [], [{ body: 'Approved (PI): go ahead.', createdAt: AFTER_PUSH }, so], [], HEAD, APP, PUSH_AT), true);
  assert.equal(checkR6(true, [], [{ login: APP, body: 'Approved (PI): go ahead.', createdAt: AFTER_PUSH }, so], [], HEAD, APP, PUSH_AT), true);
});

// t/237 (SO t/237#3 condition 3, before t/4103 makes tier-check required): an issue_comment run must never
// share a concurrency group with a pull_request_target run of tier-check, or cancel-in-progress lets the
// comment run cancel the PR-event run, leaving tier-check CANCELLED with no head-pinned verdict.
test('tier-check.yml: the concurrency group is keyed on github.event_name, so event types never cancel each other', () => {
  assert.match(tier.group, /^\$\{\{ github\.workflow \}\}-\$\{\{ github\.event_name \}\}-/);
});
