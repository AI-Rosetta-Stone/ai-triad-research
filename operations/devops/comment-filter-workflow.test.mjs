// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Keeps the `issue_comment` filter in t1-approval-guard.yml and tier-check.yml in step with the
// predicates they front. Each workflow runs its job for a PR comment only when the comment body
// (or, for an edit, its previous body) contains one of a short list of substrings. The list must
// be a SUPERSET of what the predicate reacts to: a missed run loses an approval or a block.
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

import { latestRoleVerdicts } from './role-review-verdicts.mjs';
import { checkR6 } from './tier-check-predicate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const read = (...p) => readFileSync(path.join(root, ...p), 'utf8').replace(/\r\n/g, '\n');

const guardYml = read('.github', 'workflows', 't1-approval-guard.yml');
const tierYml = read('.github', 'workflows', 'tier-check.yml');

const HAYSTACK = "format('{0} {1}', github.event.comment.body, github.event.changes.body.from)";
const PR_GROUP = '${{ github.workflow }}-${{ github.event.pull_request.number || github.event.issue.number || github.event.merge_group.head_sha || github.run_id }}';
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

/** True when this comment body is R6 evidence: it supplies the approval half or the SO half. */
function tierReacts(body) {
  const c = { body, createdAt: AFTER_PUSH };
  const soHalf = { body: 'SO did not review within the time-box.', createdAt: AFTER_PUSH };
  const approvalHalf = { body: 'Approved (PI): go ahead.', createdAt: AFTER_PUSH };
  const asApproval = !checkR6(true, [], [soHalf, c], [], HEAD, APP, PUSH_AT);
  const asSo = !checkR6(true, [], [approvalHalf, c], [], HEAD, APP, PUSH_AT);
  return asApproval || asSo;
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
    assert.equal(f.group, `${PR_GROUP}-\${{ ( ${inner} ) && 'evaluate' || github.run_id }}`);
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
    const verdict = f.tokens[0] === 'Approved' ? 'Approved (Quality): ok' : 'Approved (PI): ok';
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
  assert.equal(tierReacts('Approved (PI): go ahead.'), true);
  assert.equal(tierReacts('SO did not review within the time-box.'), true);
  assert.equal(tierReacts(`**SO clearing comment, head \`${HEAD}\`.**`), true);
  assert.equal(tierReacts('Approved (Quality): fine'), false, 'a role approval comment is not R6 evidence');
  assert.equal(tierReacts('Head updated to abc123'), false);
});

test('tier-check: comment bodies are read ONLY by checkR6 -- a new reader must extend the filter', () => {
  const predicate = read('operations', 'devops', 'tier-check-predicate.mjs');
  const code = predicate.split('\n').filter((l) => !/^\s*(\/\/|\/?\*)/.test(l)).join('\n');
  // The three patterns the header of tier-check.yml's filter names, each used in checkR6.
  for (const re of ['PI_COMMENT_APPROVAL_RE', 'SO_DID_NOT_REVIEW_RE', 'SO_CLEARING_PREFIX_RE']) {
    assert.match(code, new RegExp(`const ${re} = `));
  }
  const usesOfComments = [...code.matchAll(/\bapprovalComments\b/g)].length;
  assert.equal(usesOfComments, 2, 'approvalComments must appear exactly twice in evaluateTierCheck: destructured, then passed to checkR6');
  assert.match(code, /checkR6\(tier === 'T2' \|\| Boolean\(r1\), labels, approvalComments \?\? \[\]/);
});
