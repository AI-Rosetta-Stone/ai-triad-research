// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Both-arms + regression-fixture proof for the t/3738 foreign-commit detector. Run:
//   node --test operations/devops/worker/foreign-commit-predicate.test.mjs
// The 8 arms below are verbatim from the Lead's build brief (t/3738#7), which consolidates six
// rounds of TL/Second-Opinion hardening on real repo history.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractTicketRefs, isForeignCommit, evaluateForeignInheritance, formatResult } from './foreign-commit-predicate.mjs';

// ── extractTicketRefs ──

test('extractTicketRefs: t/NNNN form', () => {
  assert.deepEqual(extractTicketRefs('feat(debate): vocab-weighted edit pass (t/3729 Part B)'), ['t3729']);
});

test('extractTicketRefs: scope(tNNNN) form (t/3738#6 false-negative fix)', () => {
  assert.deepEqual(extractTicketRefs('analysis(t3596): recompute drift baseline'), ['t3596']);
  assert.deepEqual(extractTicketRefs('docs(t3655): update runbook'), ['t3655']);
});

test('extractTicketRefs: multiple refs, deduped, order-preserving', () => {
  assert.deepEqual(extractTicketRefs('feat(cl): t3350 demotion-set manifest for the genuine-conflict gate (t3633, t3350)'), ['t3350', 't3633']);
});

test('extractTicketRefs: 5-digit ticket number (t/10000) is recognized — silent-cliff regression (t/3738#9/#11)', () => {
  // {3,4} would match "t/1000" inside "t/10000", then \b fails on the trailing "0", backtracks,
  // fails again, and produces NO match at all (total miss, not truncation). {3,} has no cliff.
  assert.deepEqual(extractTicketRefs('feat: thing (t/10000)'), ['t10000']);
  assert.deepEqual(extractTicketRefs('feat: thing (t/12345)'), ['t12345']);
});

test('extractTicketRefs: no ref -> empty array', () => {
  assert.deepEqual(extractTicketRefs('docs(lessons): land rescued multi-agent LessonsLearned WIP'), []);
  assert.deepEqual(extractTicketRefs(''), []);
  assert.deepEqual(extractTicketRefs(undefined), []);
});

// ── isForeignCommit ──

test('isForeignCommit: disjoint ref -> foreign', () => {
  assert.equal(isForeignCommit({ subjectRefs: ['t3733'], prTicket: 't3729' }), true);
});

test('isForeignCommit: own ticket + related ticket -> NOT foreign (intersection, t/3738#4)', () => {
  assert.equal(isForeignCommit({ subjectRefs: ['t3350', 't3633'], prTicket: 't3350' }), false);
});

test('isForeignCommit: same single ticket -> not foreign', () => {
  assert.equal(isForeignCommit({ subjectRefs: ['t3736'], prTicket: 't3736' }), false);
});

test('isForeignCommit: no subject refs -> not foreign (contributes nothing, the stated residual)', () => {
  assert.equal(isForeignCommit({ subjectRefs: [], prTicket: 't3667' }), false);
});

test('isForeignCommit: no PR ticket -> not foreign at the per-commit level (handled at PR level)', () => {
  assert.equal(isForeignCommit({ subjectRefs: ['t3350'], prTicket: null }), false);
});

// ── evaluateForeignInheritance — the 8 arms from t/3738#7 ──

test('Arm 1: foreign ticket commit (t3725) in a t3729 PR -> FIRES', () => {
  const r = evaluateForeignInheritance({
    prTicket: 't3729',
    commits: [{ sha: '142d8186aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', subject: 'feat(cl): something (t3725)', isMerge: false }],
    rangeValid: true,
  });
  assert.equal(r.verdict, 'fire');
  assert.equal(r.foreignCommits.length, 1);
});

test('Arm 2: same-ticket-only range -> clean', () => {
  const r = evaluateForeignInheritance({
    prTicket: 't3729',
    commits: [
      { sha: '6af9de53aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', subject: 'feat(debate): part A (t3729)', isMerge: false },
      { sha: 'fe98948eaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', subject: 'feat(debate): part B (t3729)', isMerge: false },
    ],
    rangeValid: true,
  });
  assert.equal(r.verdict, 'clean');
});

test('Arm 3: own-ticket + related ticket (cb35c91e-shaped: t3350+t3633, t3350 PR) -> passes (FP regression fixture)', () => {
  const r = evaluateForeignInheritance({
    prTicket: 't3350',
    commits: [{ sha: 'cb35c91eaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', subject: 'feat(cl): t3350 demotion-set manifest for the genuine-conflict gate (t3633 follow-on)', isMerge: false }],
    rangeValid: true,
  });
  assert.equal(r.verdict, 'clean');
  assert.equal(r.foreignCommits.length, 0);
});

test('Arm 4: single-ticket commit with a body full of Ref: lines (fe4d8143-shaped) -> passes; subject-only extraction never sees the body refs', () => {
  // The body-ref false positive (t/3738#3) is structurally impossible here because
  // extractTicketRefs only ever receives the subject string, never body text.
  const subject = 'docs(tl): Route Enumeration pattern for gate-verification tables (t3736)';
  const r = evaluateForeignInheritance({
    prTicket: 't3736',
    commits: [{ sha: 'fe4d8143aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', subject, isMerge: false }],
    rangeValid: true,
  });
  assert.equal(r.verdict, 'clean');
  assert.deepEqual(extractTicketRefs(subject), ['t3736']); // confirms the body's other refs never entered the picture
});

test('Arm 5: scope(tNNNN) form recognized as its own ticket -> clean when it matches the PR', () => {
  const r = evaluateForeignInheritance({
    prTicket: 't3596',
    commits: [{ sha: 'cfbe1604aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', subject: 'analysis(t3596): recompute drift baseline', isMerge: false }],
    rangeValid: true,
  });
  assert.equal(r.verdict, 'clean');
});

test('Arm 5b: scope(tNNNN) form fires when foreign to the PR', () => {
  const r = evaluateForeignInheritance({
    prTicket: 't3729',
    commits: [{ sha: 'db42b4d0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', subject: 'ci(t3642): tighten workflow-lint', isMerge: false }],
    rangeValid: true,
  });
  assert.equal(r.verdict, 'fire');
  assert.equal(r.foreignCommits.length, 1);
});

test('Arm 6: merge commit in range -> FIRES (Option B), even with zero ticket refs anywhere', () => {
  const r = evaluateForeignInheritance({
    prTicket: 't3729',
    commits: [
      { sha: '6af9de53aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', subject: 'feat(debate): part A (t3729)', isMerge: false },
      { sha: 'af0b6920aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', subject: "Merge branch 'main' into t3729-work", isMerge: true },
    ],
    rangeValid: true,
  });
  assert.equal(r.verdict, 'fire');
  assert.equal(r.mergeCommits.length, 1);
  assert.equal(r.foreignCommits.length, 0); // merge commit alone triggers this, independent of the foreign-commit arm
});

test('Arm 7: cannot-evaluate (merge-base unresolved / shallow checkout) -> NEVER passes, regardless of commits/prTicket', () => {
  const r1 = evaluateForeignInheritance({ prTicket: 't3729', commits: [], rangeValid: false });
  assert.equal(r1.verdict, 'cannot-evaluate');
  // Even if commits happen to be populated (caller bug), rangeValid:false must still win.
  const r2 = evaluateForeignInheritance({
    prTicket: 't3729',
    commits: [{ sha: '6af9de53aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', subject: 'feat(debate): part A (t3729)', isMerge: false }],
    rangeValid: false,
  });
  assert.equal(r2.verdict, 'cannot-evaluate');
});

test('Arm 8: no-ticket PR (empty expected set, #2516-shaped) -> fires, clearable via opt-out', () => {
  const r = evaluateForeignInheritance({
    prTicket: null,
    commits: [{ sha: '5de42009aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', subject: 'docs(lessons): land rescued multi-agent LessonsLearned WIP', isMerge: false }],
    rangeValid: true,
  });
  assert.equal(r.verdict, 'fire');
  assert.equal(r.noTicketPr, true);

  const cleared = evaluateForeignInheritance({
    prTicket: null,
    commits: [{ sha: '5de42009aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', subject: 'docs(lessons): land rescued multi-agent LessonsLearned WIP', isMerge: false }],
    rangeValid: true,
    optedOut: true,
  });
  assert.equal(cleared.verdict, 'clean');
});

// ── Named residual (t/3738#6): a ref-less, non-merge foreign commit is invisible by design ──

test('residual: a ref-less non-merge commit contributes nothing, even when it is genuinely foreign content', () => {
  // e348e467-shaped: no ticket ref in the subject at all. This is the documented blind spot, not a bug.
  const r = evaluateForeignInheritance({
    prTicket: 't3667',
    commits: [{ sha: 'e348e467aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', subject: 'fix: tighten validation on the share-link parser', isMerge: false }],
    rangeValid: true,
  });
  assert.equal(r.verdict, 'clean');
});

// ── #2521 regression fixture — the incident that motivated this ticket (t/3738#3) ──

test('#2521 regression: four-commit foreign range against a t3729 PR -> FIRES on all three foreign commits', () => {
  const r = evaluateForeignInheritance({
    prTicket: 't3729',
    commits: [
      { sha: '97a75eebaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', subject: 'feat(x): something for t3733', isMerge: false },
      { sha: '6eeea603aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', subject: 'feat(y): something for t3732', isMerge: false },
      { sha: '142d8186aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', subject: 'feat(z): something for t3725', isMerge: false },
      { sha: '6af9de53aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', subject: 'feat(debate): the actual t3729 fix', isMerge: false },
    ],
    rangeValid: true,
  });
  assert.equal(r.verdict, 'fire');
  assert.equal(r.foreignCommits.length, 3);
  assert.deepEqual(r.foreignCommits.map((c) => c.sha.slice(0, 8)).sort(), ['142d8186', '6eeea603', '97a75eeb']);
});

// ── formatResult: never silently omits the cannot-evaluate warning ──

test('formatResult: cannot-evaluate message names the fail-closed rule explicitly', () => {
  const msg = formatResult({ verdict: 'cannot-evaluate', foreignCommits: [], mergeCommits: [], noTicketPr: false });
  assert.match(msg, /CANNOT EVALUATE/);
  assert.match(msg, /never treated as clean/);
});

test('formatResult: fire message states the residual, never claims general ancestry-inheritance detection', () => {
  const msg = formatResult({
    verdict: 'fire',
    foreignCommits: [{ sha: '97a75eebaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', subject: 'feat(x): t3733' }],
    mergeCommits: [],
    noTicketPr: false,
  });
  assert.match(msg, /Blind to a ref-less, non-merge foreign commit/);
  assert.doesNotMatch(msg, /ancestry inheritance detected/i);
});

// ── CLI shim: prove the RUNTIME the workflow invokes (test == runtime, t/3270#4 discipline) ──
// Exercised in a throwaway git repo whose HEAD == origin/main (t/729: never the real checkout, whose
// range is empty only on a branch with no commits).

const MODULE = fileURLToPath(new URL('./foreign-commit-predicate.mjs', import.meta.url));
function emptyRangeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'fcp-empty-'));
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];
  const g = (...a) => execFileSync('git', a, { cwd: dir, env, windowsHide: true, stdio: 'pipe' });
  g('init', '-q');
  g('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'base');
  g('update-ref', 'refs/remotes/origin/main', 'HEAD');
  return { dir, env };
}
function runShim(prTitle, optedOut) {
  const { dir, env } = emptyRangeRepo();
  try {
    const out = execFileSync(process.execPath, [MODULE, prTitle, optedOut ? '1' : '0'], { encoding: 'utf8', cwd: dir, env });
    return { out, code: 0 };
  } catch (e) {
    return { out: e.stdout, code: e.status };
  }
}

test('CLI shim: a ticketed PR title against an empty range (HEAD == origin/main) reports clean, exit 0', () => {
  // HEAD == origin/main at the point this worktree was created, so merge-base..HEAD is empty —
  // a valid, resolved, EMPTY range. A ticketed title with nothing in range must read as clean,
  // not cannot-evaluate (proves the resolved-but-empty branch is distinguished from unresolved).
  const { out, code } = runShim('feat(devops): t3738 foreign-commit check');
  assert.equal(code, 0);
  assert.match(out, /clean/);
});

test('CLI shim: a title with no ticket ref against an empty range still fires (Arm 8 at the CLI layer)', () => {
  const { out, code } = runShim('chore: no-op title with no matching ticket');
  assert.equal(code, 1);
  assert.match(out, /no t\/NNNN ticket ref/);
});
