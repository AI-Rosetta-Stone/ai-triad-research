// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Guard Testability (t/2971) for the pre-self-merge head-guard (t/3270). The predicate keys on a
// merge-time condition PR-CI cannot exercise, so both arms are proven here directly. Run:
//   node --test operations/devops/merge-guard-predicate.test.mjs
// This proves the SAME logic the type:block feedback rule inlines (INLINE_FOR_RULE in the module).
//
// CI (t/3871): this suite runs via operations/devops/run-merge-guard-tests.sh, which fails if fewer
// than MIN tests are collected. **When you add tests here, raise MIN in that script to the new count
// in the same PR** — a floor left behind silently tolerates losing every test added since.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  mergeGuardVerdict,
  mergeClauses,
  mergeClauseVerdict,
  stripHeredocBodies,
  parseMergeClause,
  jointGvAutoMergeVerdict,
  isAutoMergeCommand,
  parsePrRef,
  buildMergeGuardSinkRecord,
  baseRefStaleVerdict,
  parseBaseRefRecords,
  classifyGhError,
} from './merge-guard-predicate.mjs';
import { reconcileMergeGuardCoverage, parsePrRefKey, isArmEquivalentMerge } from './merge-guard-reconcile.mjs';

// ── t/3687: classifyGhError — shim fail-policy (fast-fail 4xx; retry 5xx/408/429/network) ──
test('t/3687 classifyGhError: 4xx auth/perm/not-found → NOT retryable (fast-fail)', () => {
  assert.deepEqual(classifyGhError('gh: Not Found (HTTP 404)'), { retryable: false, reason: 'http-404' });
  assert.deepEqual(classifyGhError('HTTP 403: Resource not accessible'), { retryable: false, reason: 'http-403' });
  assert.deepEqual(classifyGhError('bad (HTTP 401)'), { retryable: false, reason: 'http-401' });
});
test('t/3687 classifyGhError: 5xx / 408 / 429 → retryable (transient)', () => {
  assert.equal(classifyGhError('boom (HTTP 500)').retryable, true);
  assert.equal(classifyGhError('gateway (HTTP 502)').retryable, true);
  assert.equal(classifyGhError('unavailable (HTTP 503)').retryable, true);
  assert.equal(classifyGhError('timeout (HTTP 408)').retryable, true); // request-timeout: retry, not a 4xx fast-fail
  assert.equal(classifyGhError('rate limited (HTTP 429)').retryable, true); // rate-limit: retry, not fast-fail
});
test('t/3687 classifyGhError: no HTTP code (network/DNS/timeout) → retryable', () => {
  assert.deepEqual(classifyGhError('dial tcp: lookup api.github.com: no such host'), { retryable: true, reason: 'no-http-code' });
  assert.equal(classifyGhError('').retryable, true);
  assert.equal(classifyGhError(null).retryable, true);
});

// ── t/3687: retarget stale-green guard — baseRefStaleVerdict (base-ref-NAME identity) ──
// Design of record: t/3687#2 (locked via the e/212 SO+TL review). Block iff the LATEST record from any
// required recorder names a base ref != the PR's current baseRefName. Selection (latest-per-recorder by
// createdAt) survives identity; "any record differs" would permanently block a correctly-retargeted PR.
// Recorder ids and base names are realistic (the 3 enumerated recorders; epic/main retargets seen in this
// repo). createdAt is ISO-8601 UTC; ordering is single-instant (no created/finished split).
const RECORDERS = ['ci.yml', 'joint-gv-guard', 'codeql.yml'];
const rec = (recorder, baseRef, createdAt) => ({ recorder, baseRef, createdAt });
// all three recorders' latest record names `base`, all at time `t`.
const allMatching = (base, t) => RECORDERS.map((r) => rec(r, base, t));

test('t/3687 ALLOW: every required recorder\'s latest record names the current base', () => {
  const v = baseRefStaleVerdict({ currentBaseRefName: 'main', expectedRecorders: RECORDERS, records: allMatching('main', '2026-09-25T17:00:00Z') });
  assert.equal(v.block, false);
  assert.equal(v.reason, 'all-recorders-match-current-base');
});
test('t/3687 BLOCK: one recorder\'s latest record names the OLD base (retarget stale-green)', () => {
  const records = [rec('ci.yml', 'main', '2026-09-25T17:00:00Z'), rec('joint-gv-guard', 'main', '2026-09-25T17:00:00Z'), rec('codeql.yml', 'epic/x', '2026-09-25T17:00:00Z')];
  const v = baseRefStaleVerdict({ currentBaseRefName: 'main', expectedRecorders: RECORDERS, records });
  assert.equal(v.block, true);
  assert.equal(v.reason, 'base-ref-mismatch:codeql.yml');
});
test('t/3687 ALLOW: retargeted-then-fresh-run — old epic record + newer main record → latest wins (the permanent-block regression)', () => {
  // Opened against epic/x (17:00), retargeted to main, synchronize minted a fresh record naming main
  // (17:30). The OLD epic records are immutable but SUPERSEDED. "Any record differs" would block forever;
  // latest-per-recorder correctly allows.
  const records = RECORDERS.flatMap((r) => [rec(r, 'epic/x', '2026-09-25T17:00:00Z'), rec(r, 'main', '2026-09-25T17:30:00Z')]);
  const v = baseRefStaleVerdict({ currentBaseRefName: 'main', expectedRecorders: RECORDERS, records });
  assert.equal(v.block, false);
  assert.equal(v.reason, 'all-recorders-match-current-base');
});
test('t/3687 ALLOW: 3+ records for one recorder (unbounded, t/3646 triggers) — latest names current → allow', () => {
  // t/3646 added edited/auto_merge_disabled triggers → a PR with edits carries several records per
  // recorder; the count is unbounded, so selection maxes over a set. Latest (18:10) names main.
  const many = [
    rec('ci.yml', 'main', '2026-09-25T17:00:00Z'),
    rec('ci.yml', 'main', '2026-09-25T17:40:00Z'),
    rec('ci.yml', 'epic/x', '2026-09-25T16:00:00Z'),
    rec('ci.yml', 'main', '2026-09-25T18:10:00Z'),
  ];
  const records = [...many, rec('joint-gv-guard', 'main', '2026-09-25T18:00:00Z'), rec('codeql.yml', 'main', '2026-09-25T18:00:00Z')];
  const v = baseRefStaleVerdict({ currentBaseRefName: 'main', expectedRecorders: RECORDERS, records });
  assert.equal(v.block, false);
  assert.equal(v.reason, 'all-recorders-match-current-base');
});
test('t/3687 BLOCK: a required recorder has NO record → block, naming it (never allow on a partial set)', () => {
  const records = [rec('ci.yml', 'main', '2026-09-25T17:00:00Z'), rec('joint-gv-guard', 'main', '2026-09-25T17:00:00Z')]; // codeql.yml absent
  const v = baseRefStaleVerdict({ currentBaseRefName: 'main', expectedRecorders: RECORDERS, records });
  assert.equal(v.block, true);
  assert.equal(v.reason, 'missing-record:codeql.yml');
});
test('t/3687 BLOCK: no records at all → block', () => {
  const v = baseRefStaleVerdict({ currentBaseRefName: 'main', expectedRecorders: RECORDERS, records: [] });
  assert.equal(v.block, true);
  assert.equal(v.reason, 'missing-record:ci.yml');
});
test('t/3687 BLOCK: no expected recorders → block (nothing evaluated)', () => {
  const v = baseRefStaleVerdict({ currentBaseRefName: 'main', expectedRecorders: [], records: allMatching('main', '2026-09-25T17:00:00Z') });
  assert.equal(v.block, true);
  assert.equal(v.reason, 'no-expected-recorders');
});
test('t/3687 BLOCK: no current base ref → block (can\'t verify)', () => {
  const v = baseRefStaleVerdict({ currentBaseRefName: '', expectedRecorders: RECORDERS, records: allMatching('main', '2026-09-25T17:00:00Z') });
  assert.equal(v.block, true);
  assert.equal(v.reason, 'no-current-base-ref');
});
test('t/3687 BLOCK: tie at max createdAt with a mismatch → safe side (unknown ordering → block)', () => {
  // Two ci.yml records at the SAME instant, one naming main and one epic/x. Ordering is unknown at
  // second-granularity; the safe resolution is to block.
  const records = [
    rec('ci.yml', 'main', '2026-09-25T17:00:00Z'),
    rec('ci.yml', 'epic/x', '2026-09-25T17:00:00Z'),
    rec('joint-gv-guard', 'main', '2026-09-25T17:00:00Z'),
    rec('codeql.yml', 'main', '2026-09-25T17:00:00Z'),
  ];
  const v = baseRefStaleVerdict({ currentBaseRefName: 'main', expectedRecorders: RECORDERS, records });
  assert.equal(v.block, true);
  assert.equal(v.reason, 'base-ref-mismatch:ci.yml');
});

// ── t/3687: parseBaseRefRecords — commit-statuses payload → records (storage layer, pending TL GV) ──
// Fixture mirrors the shape of `gh api repos/{o}/{r}/commits/{sha}/statuses`: newest-first list of
// { context, description, created_at, state }. Only `base-ref-record/<recorder>` contexts are records.
const STATUSES = [
  { context: 'base-ref-record/ci.yml', description: 'main', created_at: '2026-09-25T17:40:00Z', state: 'success' },
  { context: 'ci-gate', description: 'All checks passed', created_at: '2026-09-25T17:41:00Z', state: 'success' }, // foreign — ignored
  { context: 'base-ref-record/codeql.yml', description: 'epic/x', created_at: '2026-09-25T17:00:00Z', state: 'success' },
  { context: 'base-ref-record/ci.yml', description: 'epic/x', created_at: '2026-09-25T16:00:00Z', state: 'success' }, // older dup — kept (history)
];
test('t/3687 parse: extracts base-ref-record/* statuses to {recorder,baseRef,createdAt}, ignoring foreign contexts', () => {
  const recs = parseBaseRefRecords(STATUSES);
  assert.equal(recs.length, 3); // the ci-gate status is not a record
  assert.deepEqual(recs.find((r) => r.recorder === 'codeql.yml'), { recorder: 'codeql.yml', baseRef: 'epic/x', createdAt: '2026-09-25T17:00:00Z' });
  assert.equal(recs.filter((r) => r.recorder === 'ci.yml').length, 2); // full history preserved for latest-selection
});
test('t/3687 parse: feeds baseRefStaleVerdict end-to-end — latest ci.yml record (main) wins over older (epic/x)', () => {
  const records = parseBaseRefRecords(STATUSES);
  // codeql.yml's only record names epic/x → mismatch → block on that recorder
  const v = baseRefStaleVerdict({ currentBaseRefName: 'main', expectedRecorders: ['ci.yml', 'codeql.yml'], records });
  assert.equal(v.block, true);
  assert.equal(v.reason, 'base-ref-mismatch:codeql.yml');
  // ci.yml alone: latest is main (17:40) over epic/x (16:00) → that recorder matches
  const vCi = baseRefStaleVerdict({ currentBaseRefName: 'main', expectedRecorders: ['ci.yml'], records });
  assert.equal(vCi.block, false);
});
test('t/3687 parse: skips a record missing description or created_at (→ missing-record, never silent allow)', () => {
  const recs = parseBaseRefRecords([
    { context: 'base-ref-record/ci.yml', description: '', created_at: '2026-09-25T17:00:00Z', state: 'success' },
    { context: 'base-ref-record/codeql.yml', description: 'main', created_at: null, state: 'success' },
  ]);
  assert.equal(recs.length, 0);
});
test('t/3687 parse: non-array / empty input → []', () => {
  assert.deepEqual(parseBaseRefRecords(undefined), []);
  assert.deepEqual(parseBaseRefRecords([]), []);
});

const MODULE = fileURLToPath(new URL('./merge-guard-predicate.mjs', import.meta.url));
// Invoke the module the SAME way the feedback rule does — proves runtime (CLI shim) == the tested
// function (test==runtime, TL GV t/3270#4). Returns the shim's stdout: 'fire' to block, '' to allow.
function runShim(command) {
  return execFileSync(process.execPath, [MODULE, command], { encoding: 'utf8' });
}

test('BLOCK arm: manual merge without --match-head-commit', () => {
  const v = mergeGuardVerdict('gh pr merge 1901 --squash');
  assert.equal(v.block, true);
  assert.equal(v.reason, 'missing-match-head-commit');
});

test('ALLOW arm: manual merge WITH --match-head-commit <SHA> (space form)', () => {
  const v = mergeGuardVerdict('gh pr merge 1901 --squash --match-head-commit 1578b0a0');
  assert.equal(v.block, false);
  assert.equal(v.reason, 'guarded');
});

test('ALLOW arm: --match-head-commit=<SHA> (equals form — must not false-block)', () => {
  // TL robustness condition: the = form is a correct merge; missing it would false-block.
  const v = mergeGuardVerdict('gh pr merge 1901 --squash --match-head-commit=1578b0a0');
  assert.equal(v.block, false);
  assert.equal(v.reason, 'guarded');
});

// t/3695#30 (t/4109 root rule #7): --auto is NO LONGER exempt on its own -- it now needs
// --match-head-commit too, since GitHub merges it instantly with no arm event on an already-green
// PR (t/4131), reaching the exact stranding vector this guard exists to close.
test('BLOCK arm: --auto WITHOUT --match-head-commit now blocks (t/3695#30, supersedes t/3270#2)', () => {
  const v = mergeGuardVerdict('gh pr merge 1901 --auto --squash');
  assert.equal(v.block, true);
  assert.equal(v.reason, 'auto-missing-match-head-commit');
});

test('ALLOW arm: --auto WITH --match-head-commit is guarded (both flag forms, either order)', () => {
  assert.equal(mergeGuardVerdict('gh pr merge 1901 --auto --squash --match-head-commit 1578b0a0').reason, 'guarded');
  assert.equal(mergeGuardVerdict('gh pr merge 1901 --match-head-commit=1578b0a0 --auto --squash').reason, 'guarded');
});

test('ALLOW arm: --disable-auto and --help/-h stay exempt with no pin needed', () => {
  assert.equal(mergeGuardVerdict('gh pr merge 1901 --disable-auto').block, false);
  assert.equal(mergeGuardVerdict('gh pr merge --help').block, false);
  assert.equal(mergeGuardVerdict('gh pr merge -h').block, false);
});

test('NO-OP: a non-merge command is never blocked', () => {
  for (const c of ['gh pr view 1901 --json headRefOid', 'git status', 'gh pr checks 1901', 'ls -la']) {
    const v = mergeGuardVerdict(c);
    assert.equal(v.block, false, `should not fire on: ${c}`);
    assert.equal(v.reason, 'not-a-merge');
  }
});

// t/3695#19: repo-selector bypass. Every form below returned 'not-a-merge' before the fix — a bare
// repo-scoped merge passed silently through ordinary use.
const REPO_SCOPED_MERGES = [
  'gh -R x/y pr merge 1901 --squash',
  'gh --repo x/y pr merge 1901 --squash',
  'gh --repo=x/y pr merge 1901 --squash',
  'gh pr -R x/y merge 1901 --squash',
  'gh.exe -R AI-Rosetta-Stone/ai-triad-research pr merge 1901 --squash',
];

test('t/3695 BLOCK arm: bare repo-scoped merge (-R / --repo / --repo= / either side of pr) is caught', () => {
  for (const c of REPO_SCOPED_MERGES) {
    const v = mergeGuardVerdict(c);
    assert.equal(v.block, true, `should fire on: ${c}`);
    assert.equal(v.reason, 'missing-match-head-commit', `wrong reason on: ${c}`);
  }
});

test('t/3695 ALLOW arm: repo-scoped merge WITH --match-head-commit stays silent', () => {
  for (const c of REPO_SCOPED_MERGES) {
    const v = mergeGuardVerdict(`${c} --match-head-commit 1578b0a0`);
    assert.equal(v.block, false, `should not fire on pinned: ${c}`);
    assert.equal(v.reason, 'guarded');
  }
});

test('t/3695 BLOCK arm: repo-scoped --auto without a pin now blocks too', () => {
  assert.equal(mergeGuardVerdict('gh -R x/y pr merge 1901 --auto --squash').reason, 'auto-missing-match-head-commit');
});

test('t/3695 NO-OP: repo-scoped NON-merge commands stay silent (no widening false positive)', () => {
  for (const c of ['gh -R x/y pr view 1901', 'gh --repo x/y pr checks 1901', 'gh pr view 1901', 'gh -R x/y issue list']) {
    const v = mergeGuardVerdict(c);
    assert.equal(v.block, false, `should not fire on: ${c}`);
    assert.equal(v.reason, 'not-a-merge');
  }
});

test('robustness: gh.exe (win32 fleet) is matched', () => {
  assert.equal(mergeGuardVerdict('gh.exe pr merge 1901 --squash').block, true);
  assert.equal(mergeGuardVerdict('gh.exe pr merge 1901 --squash --match-head-commit=abc').block, false);
});

test('robustness: flag ordering — head flag before the PR number', () => {
  const v = mergeGuardVerdict('gh pr merge --match-head-commit abcdef0 --squash 1901');
  assert.equal(v.block, false);
});

test('robustness: --auto WITHOUT a pin blocks regardless of flag order / trailing position', () => {
  assert.equal(mergeGuardVerdict('gh pr merge 1901 --squash --auto').block, true);
});

test('edge: a bare --match-head-commit with NO value does NOT count as guarded (still blocks)', () => {
  // A value-less flag would be a malformed merge; must not pass the guard.
  const v = mergeGuardVerdict('gh pr merge 1901 --squash --match-head-commit');
  assert.equal(v.block, true);
  assert.equal(v.reason, 'missing-match-head-commit');
});

test('edge: empty / undefined command is a no-op', () => {
  assert.equal(mergeGuardVerdict('').block, false);
  assert.equal(mergeGuardVerdict(undefined).block, false);
});

// ── t/3695#30 (cycle 3): real tokenizer, judge ONLY in command position ──────────────────────
// Five RECORDED false positives (10-07 to 10-12) from the old bare-text regex search, which
// matched `gh pr merge` wherever the substring appeared, including inside a quoted argument to
// an unrelated command. All five must be ALLOWED (not-a-merge): the tokenizer's quote handling
// collapses each quoted argument into ONE word, so it can never match in command position.
test('t/3695 FALSE-POSITIVE FIXTURE 1 (10-07 19:39): grep pattern text containing "gh pr merge" is NOT a merge', () => {
  const c = String.raw`grep -En "gh pr merge [^\"\\]{0,40}--auto" operations/devops/*.mjs`;
  assert.equal(mergeGuardVerdict(c).reason, 'not-a-merge');
});

test('t/3695 FALSE-POSITIVE FIXTURE 2 (10-07 19:42): sed/grep -e pattern text "merge 3031 --auto" is NOT a merge', () => {
  const c = String.raw`grep -e "merge 3031 --auto" *.jsonl`;
  assert.equal(mergeGuardVerdict(c).reason, 'not-a-merge');
});

test('t/3695 FALSE-POSITIVE FIXTURE 3 (10-07 19:43): a regex literal containing the merge command text is NOT a merge', () => {
  const c = String.raw`grep -En "gh pr merge 3031 --auto)[^\"]*" *.log`;
  assert.equal(mergeGuardVerdict(c).reason, 'not-a-merge');
});

test('t/3695 FALSE-POSITIVE FIXTURE 4 (10-12 10:36): a PR comment body MENTIONING a merge command is NOT a merge', () => {
  const c = String.raw`gh pr comment 3181 --body "Owner: please disarm auto-merge (gh pr merge 3181 --disable-auto) and remove the hold"`;
  assert.equal(mergeGuardVerdict(c).reason, 'not-a-merge');
});

test('t/3695 FALSE-POSITIVE FIXTURE 5 (10-12, live): `gh pr merge --help` / `-h` merges nothing', () => {
  assert.equal(mergeGuardVerdict('gh pr merge --help').block, false);
  assert.equal(mergeGuardVerdict('gh pr merge --help').reason, 'help');
  assert.equal(mergeGuardVerdict('gh pr merge -h').reason, 'help');
});

// A REAL merge is still caught even when the clause ALSO contains quoted text elsewhere on the
// same line (proves the tokenizer isn't over-correcting into blindness).
test('t/3695 BLOCK arm survives alongside quoted text: a real merge next to a grep-pattern string', () => {
  const c = String.raw`grep -n "gh pr merge" README.md; gh pr merge 1901 --squash`;
  const v = mergeGuardVerdict(c);
  assert.equal(v.block, true);
  assert.equal(v.reason, 'missing-match-head-commit');
});

test('t/3695 command-position tolerance: env-prefixed and assignment-prefixed merges are still caught', () => {
  assert.equal(mergeGuardVerdict('MSYS_NO_PATHCONV=1 gh pr merge 1901 --squash').block, true);
  assert.equal(mergeGuardVerdict('env FOO=bar gh pr merge 1901 --squash').block, true);
  assert.equal(mergeGuardVerdict('MSYS_NO_PATHCONV=1 gh pr merge 1901 --squash --match-head-commit abc').block, false);
});

test('t/3695 single-quoted content is also never command position (sanity: single and $\' quoting)', () => {
  assert.equal(mergeGuardVerdict(`echo 'gh pr merge 1901 --auto'`).reason, 'not-a-merge');
  assert.equal(mergeGuardVerdict(`echo $'gh pr merge 1901 --auto'`).reason, 'not-a-merge');
});

// ── t/3695#30 round 2 (Lead review on PR #3189): 4 probed fixtures -- 3 missed merges, 1 FP ──
test('t/3695 FIXTURE: a path-qualified gh (/usr/bin/gh) is still caught via basename matching', () => {
  const v = mergeGuardVerdict('/usr/bin/gh pr merge 5 --squash');
  assert.equal(v.block, true);
  assert.equal(v.reason, 'missing-match-head-commit');
});

test('t/3695 FIXTURE: the PowerShell call operator with a quoted Windows gh.exe path is still caught', () => {
  const v = mergeGuardVerdict(String.raw`& "C:\tools\gh.exe" pr merge 5 --squash`);
  assert.equal(v.block, true);
  assert.equal(v.reason, 'missing-match-head-commit');
  // Guarded form of the same path must also still be recognized as guarded, not just blocked.
  assert.equal(mergeGuardVerdict(String.raw`& "C:\tools\gh.exe" pr merge 5 --squash --match-head-commit abc`).reason, 'guarded');
});

test('t/3695 FIXTURE: command substitution — x=$(gh pr merge 5 --squash) is still caught', () => {
  const v = mergeGuardVerdict('x=$(gh pr merge 5 --squash)');
  assert.equal(v.block, true);
  assert.equal(v.reason, 'missing-match-head-commit');
});

test('t/3695 FIXTURE: a parenthesized subshell — ( gh pr merge 5 --squash ) is still caught', () => {
  const v = mergeGuardVerdict('( gh pr merge 5 --squash )');
  assert.equal(v.block, true);
  assert.equal(v.reason, 'missing-match-head-commit');
});

test('t/3695 FIXTURE: a backtick subshell is also caught', () => {
  const v = mergeGuardVerdict('`gh pr merge 5 --squash`');
  assert.equal(v.block, true);
});

// ── t/3695#30 round 3 (Lead review, real incident 2026-10-12 11:21Z): backtick substitution
// inside a DOUBLE-QUOTED --body argument actually ran `gh pr merge 5 --squash` for real (it
// failed harmlessly on a stray flag). Round 2's tokenizer still read this as `not-a-merge` --
// a live regression for a class that had just occurred, caught before merge. ──
test('t/3695 FIXTURE: a backtick inside a DOUBLE-QUOTED --body argument IS judged (bash substitutes there)', () => {
  const c = 'gh pr comment 1 --body "see `gh pr merge 5 --squash`"';
  const v = mergeGuardVerdict(c);
  assert.equal(v.block, true);
  assert.equal(v.reason, 'missing-match-head-commit');
});

test('t/3695 FIXTURE: a backtick inside a SINGLE-QUOTED --body argument stays literal (no substitution)', () => {
  const c = "gh pr comment 1 --body 'see `gh pr merge 5 --squash`'";
  const v = mergeGuardVerdict(c);
  assert.equal(v.block, false);
  assert.equal(v.reason, 'not-a-merge');
});

test('t/3695 regression: a guarded merge inside a double-quoted backtick span is also recognized', () => {
  const c = 'gh pr comment 1 --body "see `gh pr merge 5 --squash --match-head-commit abc`"';
  const v = mergeGuardVerdict(c);
  assert.equal(v.block, false);
  assert.equal(v.reason, 'guarded');
});

test('t/3695 REGRESSION GUARD: a subshell used as a FLAG VALUE (not a separate clause) stays one guarded clause', () => {
  // The exact shape the root AGENTS.md remedy text recommends: --match-head-commit's value is
  // itself a command substitution. Must NOT be cut into a bare merge + a stray $(gh pr view …).
  const v = mergeGuardVerdict('gh pr merge 1901 --match-head-commit $(gh pr view 1901 --json headRefOid -q .headRefOid)');
  assert.equal(v.block, false);
  assert.equal(v.reason, 'guarded');
});

test('t/3695 FIXTURE (false positive): a BARE `cat <<EOF` heredoc (no redirect at all) is data, not a merge', () => {
  const v = mergeGuardVerdict('cat <<EOF\ngh pr merge 5 --squash\nEOF');
  assert.equal(v.block, false);
  assert.equal(v.reason, 'not-a-merge');
});

test('t/3695 FIXTURE: printf/echo heredoc consumers are also data sinks', () => {
  assert.equal(mergeGuardVerdict('printf <<EOF\ngh pr merge 5 --squash\nEOF').reason, 'not-a-merge');
  assert.equal(mergeGuardVerdict('echo <<EOF\ngh pr merge 5 --squash\nEOF').reason, 'not-a-merge');
});

test('t/3695 sanity: bash/sh/pwsh interpreters are UNCHANGED by the heredoc-sink widening — still judged', () => {
  const v = mergeGuardVerdict('bash <<EOF\ngh pr merge 5 --squash\nEOF');
  assert.equal(v.block, true);
});

// --- CLI shim: prove the RUNTIME the feedback rule invokes (test==runtime, TL GV t/3270#4) ---

test('CLI shim: BLOCKs (emits "fire") on a manual merge missing the flag', () => {
  assert.equal(runShim('gh pr merge 1901 --squash'), 'fire');
});

test('CLI shim: ALLOWs (no output) on a guarded merge — both flag forms', () => {
  assert.equal(runShim('gh pr merge 1901 --squash --match-head-commit 1578b0a0'), '');
  assert.equal(runShim('gh pr merge 1901 --squash --match-head-commit=1578b0a0'), '');
});

test('CLI shim: BLOCKs --auto without a pin, ALLOWs it with one, ALLOWs non-merge commands', () => {
  assert.equal(runShim('gh pr merge 1901 --auto'), 'fire');
  assert.equal(runShim('gh pr merge 1901 --auto --match-head-commit 1578b0a0'), '');
  assert.equal(runShim('gh pr view 1901 --json headRefOid'), '');
});

// ── t/3318: auto-merge-on-joint-GV guard (TL gate design t/3318#1) ──
// The pure predicate is the both-arms unit under test; the label lookup (fetch shim) is impure and
// proven by the real fire-drill (labeled test PR + --auto → blocks). Here we prove the 4-combo truth
// table + the command parsers, and the CLI --jointgv mode's gh-free early-exits.

test('jointGv BLOCK arm: --auto + joint-gv label → block', () => {
  const v = jointGvAutoMergeVerdict({ isAutoMerge: true, isJointGvLabeled: true });
  assert.equal(v.block, true);
  assert.equal(v.reason, 'auto-merge-on-joint-gv');
});

test('jointGv ALLOW arm: --auto + NOT labeled → allow (solo draft may auto-merge)', () => {
  const v = jointGvAutoMergeVerdict({ isAutoMerge: true, isJointGvLabeled: false });
  assert.equal(v.block, false);
  assert.equal(v.reason, 'auto-merge-unlabeled-ok');
});

test('jointGv ALLOW arm: manual (no --auto) + joint-gv label → allow (manual co-merge is the intent)', () => {
  const v = jointGvAutoMergeVerdict({ isAutoMerge: false, isJointGvLabeled: true });
  assert.equal(v.block, false);
  assert.equal(v.reason, 'not-auto-merge');
});

test('jointGv ALLOW arm: manual + not labeled → allow', () => {
  const v = jointGvAutoMergeVerdict({ isAutoMerge: false, isJointGvLabeled: false });
  assert.equal(v.block, false);
  assert.equal(v.reason, 'not-auto-merge');
});

test('isAutoMergeCommand: true only for a `gh pr merge` carrying --auto', () => {
  assert.equal(isAutoMergeCommand('gh pr merge 1947 --auto --squash'), true);
  assert.equal(isAutoMergeCommand('gh pr merge 1947 --squash --auto'), true);
  assert.equal(isAutoMergeCommand('gh.exe pr merge --auto'), true);
  assert.equal(isAutoMergeCommand('gh pr merge 1947 --squash'), false); // manual
  assert.equal(isAutoMergeCommand('gh pr view 1947 --json labels'), false); // not a merge
  assert.equal(isAutoMergeCommand('gh pr merge 1947 --squash --auto-delete'), false); // not the --auto flag
});

test('parsePrRef: numeric id, pull URL, else null (→ current branch)', () => {
  assert.equal(parsePrRef('gh pr merge 1947 --auto'), '1947');
  assert.equal(parsePrRef('gh pr merge https://github.com/AI-Rosetta-Stone/ai-triad-research/pull/1947 --auto'),
    'https://github.com/AI-Rosetta-Stone/ai-triad-research/pull/1947');
  assert.equal(parsePrRef('gh pr merge --auto --squash'), null); // no ref → gh uses current branch
  // a --match-head-commit value is never mistaken for the ref (leading-position only)
  assert.equal(parsePrRef('gh pr merge --match-head-commit deadbeef --squash 1947'), null);
});

// CLI --jointgv mode: the gh-free early-exits are deterministic (no PR lookup performed).
function runShimJointGv(command) {
  return execFileSync(process.execPath, [MODULE, '--jointgv', command], { encoding: 'utf8' });
}

test('CLI --jointgv: no gh call + no fire on a MANUAL merge (not --auto)', () => {
  assert.equal(runShimJointGv('gh pr merge 1947 --squash --match-head-commit abc'), '');
});

test('CLI --jointgv: no gh call + no fire on a non-merge command', () => {
  assert.equal(runShimJointGv('gh pr view 1947 --json labels'), '');
});

// CLI --base-ref-stale mode: gh-free early-exits (no PR fetch performed) are deterministic. A MANUAL
// merge WOULD fetch (needs a real PR), so only the --auto-exempt and non-merge arms are unit-testable —
// the fetch+verdict path is proven by the pure baseRefStaleVerdict/parseBaseRefRecords/classifyGhError arms.
function runShimBaseRef(command) {
  return execFileSync(process.execPath, [MODULE, '--base-ref-stale', command], { encoding: 'utf8' });
}
test('CLI --base-ref-stale: no gh call + no fire on an --auto merge (auto-exempt)', () => {
  assert.equal(runShimBaseRef('gh pr merge 1947 --auto'), '');
});
test('CLI --base-ref-stale: no gh call + no fire on a non-merge command', () => {
  assert.equal(runShimBaseRef('gh pr view 1947 --json baseRefName'), '');
});

// ── buildMergeGuardSinkRecord: durable telemetry record shape (t/3395) ──
// The platform telemetry writer is dead (t/3394#2); the shim appends these records so merge-guard
// fires/allows — especially the jointgv fail-CLOSED block — stay observable.

test('sink record: head-guard BLOCK (missing --match-head-commit) → decision=block + command captured', () => {
  const cmd = 'gh pr merge 2059 --squash';
  const r = buildMergeGuardSinkRecord({
    nowIso: '2026-09-07T20:00:00.000Z', mode: 'head-guard', command: cmd,
    verdict: mergeGuardVerdict(cmd), failClosed: false,
  });
  assert.equal(r.gate, 'merge-guard');
  assert.equal(r.mode, 'head-guard');
  assert.equal(r.decision, 'block');
  assert.equal(r.reason, 'missing-match-head-commit');
  assert.equal(r.failClosed, false);
  assert.equal(r.command, cmd);
});

test('sink record: head-guard ALLOW (guarded merge) → decision=allow', () => {
  const cmd = 'gh pr merge 2059 --squash --match-head-commit abc123';
  const r = buildMergeGuardSinkRecord({ nowIso: 'x', mode: 'head-guard', command: cmd, verdict: mergeGuardVerdict(cmd) });
  assert.equal(r.decision, 'allow');
  assert.equal(r.reason, 'guarded');
});

test('sink record: jointgv fail-CLOSED block → decision=block, failClosed=true (the high-value event)', () => {
  const r = buildMergeGuardSinkRecord({
    nowIso: 'x', mode: 'jointgv', command: 'gh pr merge 1947 --auto',
    verdict: { block: true, reason: 'failclosed-unverifiable' }, failClosed: true,
  });
  assert.equal(r.mode, 'jointgv');
  assert.equal(r.decision, 'block');
  assert.equal(r.reason, 'failclosed-unverifiable');
  assert.equal(r.failClosed, true);
});

test('sink record: jointgv verified block (labeled joint-gv) → decision=block, failClosed=false', () => {
  const r = buildMergeGuardSinkRecord({
    nowIso: 'x', mode: 'jointgv', command: 'gh pr merge 1947 --auto',
    verdict: jointGvAutoMergeVerdict({ isAutoMerge: true, isJointGvLabeled: true }), failClosed: false,
  });
  assert.equal(r.decision, 'block');
  assert.equal(r.reason, 'auto-merge-on-joint-gv');
  assert.equal(r.failClosed, false);
});

test('sink record: command is truncated to 300 chars; empty args never throw', () => {
  const long = `gh pr merge 1 ${'x'.repeat(500)}`;
  const r = buildMergeGuardSinkRecord({ nowIso: 'x', mode: 'head-guard', command: long, verdict: { block: false, reason: 'guarded' } });
  assert.equal(r.command.length, 300);
  const empty = buildMergeGuardSinkRecord();
  assert.equal(empty.decision, 'allow');
  assert.equal(empty.command, null);
  assert.equal(empty.gate, 'merge-guard');
  assert.deepEqual(empty.clauses, []);
});

// ── t/3695#26-27: --disable-auto never merges; the verdict is per merge clause ──

test('t/3695 ALLOW arm: --disable-auto only disarms auto-merge → allow (the first window\'s 9 FPs)', () => {
  for (const c of ['gh pr merge 2830 --disable-auto', 'gh pr merge 2830 --disable-auto 2>&1', 'gh -R x/y pr merge 22 --disable-auto']) {
    const v = mergeGuardVerdict(c);
    assert.equal(v.block, false, `should not fire on: ${c}`);
    assert.equal(v.reason, 'disable-auto');
  }
});

test('t/3695 BLOCK arm: a disarm followed by a REAL bare merge is still judged → block', () => {
  for (const c of [
    'gh pr merge 1 --disable-auto; gh pr merge 1 --squash',
    'gh pr merge 1 --disable-auto && gh pr merge 1 --squash',
    'gh pr merge 1 --disable-auto\ngh pr merge 1 --squash',
  ]) {
    const v = mergeGuardVerdict(c);
    assert.equal(v.block, true, `should fire on: ${JSON.stringify(c)}`);
    assert.equal(v.reason, 'missing-match-head-commit');
  }
});

test('t/3695 ALLOW arm: a disarm followed by a head-pinned merge → allow', () => {
  const v = mergeGuardVerdict('gh pr merge 1 --disable-auto && gh pr merge 1 --squash --match-head-commit abc1234');
  assert.equal(v.block, false);
});

test('t/3695 BLOCK arm: an exemption on one clause no longer covers another clause on the line', () => {
  for (const c of [
    'gh pr merge 1 --auto --squash; gh pr merge 2 --squash',
    'gh pr merge 1 --squash --match-head-commit abc1234; gh pr merge 2 --squash',
  ]) {
    assert.equal(mergeGuardVerdict(c).block, true, `should fire on: ${c}`);
  }
});

test('t/3695 clause split: redirects (2>&1, &>) are not separators; a value after them still counts', () => {
  assert.deepEqual(mergeClauses('gh pr merge 5 --squash 2>&1 --match-head-commit abc; echo done'), [
    'gh pr merge 5 --squash 2>&1 --match-head-commit abc',
  ]);
  assert.equal(mergeGuardVerdict('gh pr merge 5 --squash 2>&1 --match-head-commit abc').block, false);
});

test('t/3695 clause split: the $(gh pr view …) head lookup is not a merge clause', () => {
  const c = 'gh pr merge 5 --squash --match-head-commit $(gh pr view 5 --json headRefOid -q .headRefOid)';
  assert.equal(mergeClauses(c).length, 1);
  assert.equal(mergeClauseVerdict(mergeClauses(c)[0]).reason, 'guarded');
});

test('t/3695 heredoc bodies are data: a merge MENTIONED in a commit message / PR body is not judged', () => {
  const commit = "git commit -q -F - <<'EOF'\nfix: 9 blocks were gh pr merge N --disable-auto; also gh pr merge 5 --squash\nEOF\ngit push";
  assert.equal(mergeGuardVerdict(commit).reason, 'not-a-merge');
  const body = 'gh pr create --body-file - <<EOF\nThen run gh pr merge 7 --squash\nEOF';
  assert.equal(mergeGuardVerdict(body).reason, 'not-a-merge');
});

test('t/3695 heredoc bodies: a REAL bare merge after the heredoc terminator is still judged → block', () => {
  const c = "cat > f <<'EOF'\nnotes\nEOF\ngh pr merge 7 --squash";
  assert.equal(mergeGuardVerdict(c).block, true);
  // <<- with an indented terminator: stripped for a data sink, kept verbatim for anything else.
  assert.equal(stripHeredocBodies('cat > f <<-X\nbody\n  X\nb'), 'cat > f <<-X\nb');
  assert.equal(stripHeredocBodies('a <<-X\nbody\n  X\nb'), 'a <<-X\nbody\n  X\nb');
});

// TL review of #2966 (t/3695#29): a heredoc fed to an INTERPRETER runs its body, so only an allowlist
// of data sinks may be stripped. One arm per shell, per sink, and an unknown consumer.
const BODY = 'gh pr merge 7 --squash';

test('t/3695 heredoc → interpreter (bash, sh -s, zsh, pwsh -Command -, powershell -Command -) is JUDGED → block', () => {
  for (const opener of ["bash <<'EOF'", 'sh -s <<EOF', 'zsh <<EOF', 'pwsh -Command - <<EOF', 'powershell -NoProfile -Command - <<EOF', 'cd /x && bash <<-EOF']) {
    const c = `${opener}\n${BODY}\nEOF`;
    assert.equal(mergeGuardVerdict(c).block, true, `should fire on: ${opener}`);
  }
});

test('t/3695 heredoc → data sink (git commit -F -, gh --body-file -, cat > f, cat <<EOF > f, tee f, -m "$(cat <<EOF") is stripped → not-a-merge', () => {
  for (const opener of [
    "git commit -q -F - <<'EOF'",
    'git commit --file=- <<EOF',
    'gh pr create --title t --body-file - <<EOF',
    'gh pr comment 5 -F - <<EOF',
    'cat > notes.md <<EOF',
    "cat <<'EOF' > notes.md",
    'tee notes.md <<EOF',
    'git commit -m "$(cat <<\'EOF\'',
    'gh pr create --title t --body "$(cat <<EOF',
  ]) {
    const c = `${opener}\n${BODY}\nEOF`;
    assert.equal(mergeGuardVerdict(c).reason, 'not-a-merge', `should strip for: ${opener}`);
  }
});

test('t/3695 heredoc → unknown consumer (python -, node, bare cat piped to bash, any other command) is JUDGED → block', () => {
  for (const opener of ['python3 - <<EOF', 'node <<EOF', 'cat <<EOF | bash', 'xargs -I{} sh -c {} <<EOF', 'mytool <<EOF']) {
    const c = `${opener}\n${BODY}\nEOF`;
    assert.equal(mergeGuardVerdict(c).block, true, `should fire on: ${opener}`);
  }
});

test('t/3695 sink piped onward to a non-sink (tee f | sh, cat > f … | bash) is JUDGED → block', () => {
  for (const opener of ["tee notes.md <<'EOF' | sh", 'gh pr create --body-file - <<EOF | bash', 'tee a.md <<EOF | tee b.md | sh']) {
    const c = `${opener}\n${BODY}\nEOF`;
    assert.equal(mergeGuardVerdict(c).block, true, `should fire on: ${opener}`);
  }
});

test('t/3695 sink piped only into other sinks (tee a | tee b) is still data → not-a-merge', () => {
  const c = `tee a.md <<EOF | tee b.md\n${BODY}\nEOF`;
  assert.equal(mergeGuardVerdict(c).reason, 'not-a-merge');
});

test('t/3695 parseMergeClause: prRef (number / pull URL / none) and repo (-R / --repo / --repo= / none)', () => {
  assert.deepEqual(parseMergeClause('gh pr merge 22 -R AI-Rosetta-Stone/ai-triad-data --squash'), { prRef: '22', repo: 'AI-Rosetta-Stone/ai-triad-data' });
  assert.deepEqual(parseMergeClause('gh --repo=x/y pr merge 7 --squash'), { prRef: '7', repo: 'x/y' });
  assert.deepEqual(parseMergeClause('gh pr merge https://github.com/x/y/pull/9 --squash'), { prRef: 'https://github.com/x/y/pull/9', repo: null });
  assert.deepEqual(parseMergeClause('gh pr merge --squash'), { prRef: null, repo: null });
});

test('t/3695 sink record: each merge clause is recorded with its own verdict and join keys', () => {
  const long = `cd /some/where && ${'x'.repeat(400)}; gh pr merge 2907 -R x/y --squash --match-head-commit abc1234`;
  const r = buildMergeGuardSinkRecord({ nowIso: 'x', mode: 'head-guard', command: long, verdict: mergeGuardVerdict(long) });
  assert.equal(r.command.length, 300); // shell-line prefix: the merge clause is not in it
  assert.deepEqual(r.clauses, [{
    clause: 'gh pr merge 2907 -R x/y --squash --match-head-commit abc1234',
    reason: 'guarded',
    prRef: '2907',
    repo: 'x/y',
  }]);
});

// ── t/3695#27: advisory-cycle coverage reconciler (pure core) ──

const R = 'o/code';
const D = 'o/data';
const grec = (ts, clauses) => ({ ts, mode: 'head-guard', clauses });
const cl = (reason, prRef, repo = null) => ({ clause: 'gh pr merge …', reason, prRef, repo });

test('t/3695 reconcile parsePrRefKey: number (+repo), pull URL, unparseable', () => {
  assert.deepEqual(parsePrRefKey('22', D), { repo: D, number: 22 });
  assert.deepEqual(parsePrRefKey('22', null), { repo: null, number: 22 });
  assert.deepEqual(parsePrRefKey('https://github.com/o/data/pull/9'), { repo: D, number: 9 });
  assert.equal(parsePrRefKey(null), null);
  assert.equal(parsePrRefKey('feature-branch'), null);
});

test('t/3695 reconcile COVERED: every manual merge has a judged clause → missing empty; auto-merged PRs are not owed a record', () => {
  const r = reconcileMergeGuardCoverage({
    since: '2026-10-07T00:00:00Z',
    records: [grec('2026-10-07T01:00:00Z', [cl('guarded', '22', D)]), grec('2026-10-07T02:00:00Z', [cl('guarded', '2950')])],
    mergedPrs: [
      { repo: D, number: 22, mergedAt: '2026-10-07T01:00:05Z', autoMerge: false },
      { repo: R, number: 2950, mergedAt: '2026-10-07T02:00:05Z', autoMerge: false },
      { repo: R, number: 2951, mergedAt: '2026-10-07T03:00:00Z', autoMerge: true },
    ],
  });
  assert.equal(r.manual, 2);
  assert.equal(r.covered, 2);
  assert.deepEqual(r.missing.all, []);
  assert.deepEqual(r.missing.uncovered, []);
});

test('t/3695 reconcile MISSING: a manual merge with no judged clause is reported (the coverage failure arm)', () => {
  const r = reconcileMergeGuardCoverage({
    since: '2026-10-07T00:00:00Z',
    records: [grec('2026-10-07T01:00:00Z', [cl('disable-auto', '5'), cl('guarded', '6')])],
    mergedPrs: [{ repo: R, number: 5, mergedAt: '2026-10-07T01:10:00Z', autoMerge: false }],
  });
  assert.equal(r.covered, 0);
  assert.deepEqual(r.missing.all.map((p) => p.number), [5]);
  assert.deepEqual(r.missing.uncovered.map((p) => p.number), [5]);
});

// ── t/3695#30: missing classified into autoImmediate / outOfBand / uncovered ──
test('t/3695 reconcile: an armEquivalent missing merge is autoImmediate, not a gap', () => {
  const r = reconcileMergeGuardCoverage({
    since: '2026-10-07T00:00:00Z',
    records: [],
    mergedPrs: [{ repo: R, number: 9001, mergedAt: '2026-10-07T01:00:05Z', autoMerge: false, armEquivalent: true }],
  });
  assert.equal(r.missing.all.length, 1);
  assert.deepEqual(r.missing.autoImmediate.map((p) => p.number), [9001]);
  assert.deepEqual(r.missing.uncovered, []);
});

test('t/3695 reconcile: a known t/3716 sweeper incident is outOfBand even if it looks armEquivalent', () => {
  const r = reconcileMergeGuardCoverage({
    since: '2026-10-07T00:00:00Z',
    records: [],
    mergedPrs: [{ repo: R, number: 3155, mergedAt: '2026-10-08T15:55:36Z', autoMerge: false, armEquivalent: true }],
    outOfBandRefs: [{ repo: R, number: 3155 }],
  });
  assert.deepEqual(r.missing.outOfBand.map((p) => p.number), [3155]);
  assert.deepEqual(r.missing.autoImmediate, []);
  assert.deepEqual(r.missing.uncovered, []);
});

test('t/3695 reconcile: a missing merge that is neither armEquivalent nor out-of-band is a REAL uncovered gap', () => {
  const r = reconcileMergeGuardCoverage({
    since: '2026-10-07T00:00:00Z',
    records: [],
    mergedPrs: [{ repo: R, number: 42, mergedAt: '2026-10-07T01:00:05Z', autoMerge: false, armEquivalent: false }],
  });
  assert.deepEqual(r.missing.uncovered.map((p) => p.number), [42]);
  assert.deepEqual(r.missing.autoImmediate, []);
  assert.deepEqual(r.missing.outOfBand, []);
});

test('t/3695 reconcile: isArmEquivalentMerge matches t/4131\'s window and excludes when an arm event exists', () => {
  assert.equal(isArmEquivalentMerge({ readyAt: '2026-10-08T15:55:31Z', mergedAt: '2026-10-08T15:55:36Z', hasArmEventBetween: false }), true);
  assert.equal(isArmEquivalentMerge({ readyAt: '2026-10-08T15:55:31Z', mergedAt: '2026-10-08T15:57:00Z', hasArmEventBetween: false }), false); // past the 60s window
  assert.equal(isArmEquivalentMerge({ readyAt: '2026-10-08T15:55:31Z', mergedAt: '2026-10-08T15:55:36Z', hasArmEventBetween: true }), false); // a real arm event, not equivalent
  assert.equal(isArmEquivalentMerge({ readyAt: null, mergedAt: '2026-10-08T15:55:36Z', hasArmEventBetween: false }), false); // no ready event at all
});

test('t/3695 reconcile: blocks now also include auto-missing-match-head-commit (t/4109 rule #7)', () => {
  const r = reconcileMergeGuardCoverage({
    since: '2026-10-07T00:00:00Z',
    records: [grec('2026-10-07T01:00:00Z', [cl('auto-missing-match-head-commit', '77')])],
  });
  assert.equal(r.judged, 1);
  assert.equal(r.blocks.length, 1);
});

test('t/3695 reconcile: unparseable PR refs are their own count, never silently dropped (TL condition 2)', () => {
  const r = reconcileMergeGuardCoverage({
    since: '2026-10-07T00:00:00Z',
    records: [grec('2026-10-07T01:00:00Z', [cl('guarded', null), cl('missing-match-head-commit', null)])],
  });
  assert.equal(r.judged, 2);
  assert.equal(r.unparseableRefs.length, 2);
  assert.equal(r.blocks.length, 1);
});

test('t/3695 reconcile: a bare number with no -R matching PRs in two repos is ambiguous, not covered', () => {
  const r = reconcileMergeGuardCoverage({
    since: '2026-10-07T00:00:00Z',
    records: [grec('2026-10-07T01:00:00Z', [cl('guarded', '22')])],
    mergedPrs: [
      { repo: R, number: 22, mergedAt: '2026-10-07T01:00:05Z', autoMerge: false },
      { repo: D, number: 22, mergedAt: '2026-10-07T01:00:05Z', autoMerge: false },
    ],
  });
  assert.equal(r.ambiguous.length, 1);
  assert.equal(r.covered, 0);
  assert.equal(r.missing.all.length, 2);
});

test('t/3695 reconcile: in-window records without per-clause fields count as legacy; out-of-window ignored', () => {
  const r = reconcileMergeGuardCoverage({
    since: '2026-10-07T00:00:00Z',
    until: '2026-10-08T00:00:00Z',
    records: [
      { ts: '2026-10-07T01:00:00Z', mode: 'head-guard', reason: 'guarded' },
      grec('2026-10-06T23:00:00Z', [cl('missing-match-head-commit', '1')]),
      grec('2026-10-08T01:00:00Z', [cl('missing-match-head-commit', '2')]),
      { ts: '2026-10-07T02:00:00Z', mode: 'jointgv', clauses: [cl('missing-match-head-commit', '3')] },
    ],
  });
  assert.equal(r.legacyRecords, 1);
  assert.equal(r.judged, 0);
  assert.equal(r.blocks.length, 0);
});
