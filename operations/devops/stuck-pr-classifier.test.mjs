// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// All-arms proof for the t/4115 stuck-PR classifier. Run:
//   node --test operations/devops/stuck-pr-classifier.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyBlocker, escalationLevel, detectSweepSignature, classifySweepHits, ARM_EVENT_RE,
  REQUIRED_CONTEXTS, REQUIRED_CONTEXT_PATHS, QUEUED_STUCK_MINUTES, IN_PROGRESS_STUCK_MINUTES,
  OWNER_SLA_HOURS, TL_SLA_HOURS, SWEEP_WINDOW_SECONDS, SWEEP_BURST_SECONDS,
  MERGE_EQUIVALENT_WINDOW_SECONDS, SO_TIMEBOX_HOURS,
} from './stuck-pr-classifier.mjs';

const NOW = Date.parse('2026-10-08T12:00:00Z');
const minsAgo = (m) => new Date(NOW - m * 60000).toISOString();
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();

function allGreenRuns(overrides = {}) {
  return REQUIRED_CONTEXTS.map((name) => ({
    path: REQUIRED_CONTEXT_PATHS[name], status: 'completed', conclusion: 'success',
    createdAt: hoursAgo(1), startedAt: hoursAgo(1), runAttempt: 1, id: 1,
    ...(overrides[name] ?? {}),
  }));
}

function basePr(overrides = {}) {
  return {
    mergeableState: 'clean',
    isConflicting: false,
    autoMergeEnabled: false,
    labels: [],
    runs: allGreenRuns(),
    mergeRefusalText: null,
    lastActivityAt: minsAgo(5),
    ...overrides,
  };
}

// ── held ──
test('held: consult-hold label never escalates, reports age only', () => {
  const pr = basePr({ labels: ['consult-hold'], isConflicting: true /* would otherwise be merge-conflict */ });
  const v = classifyBlocker(pr, NOW);
  assert.equal(v.class, 'held');
  assert.equal(escalationLevel(v.class, 100), 'none'); // even at 100h, never escalates
});
test('held: joint-gv label also never escalates', () => {
  const pr = basePr({ labels: ['joint-gv'] });
  assert.equal(classifyBlocker(pr, NOW)?.class, 'held');
});

// ── consult-hold-aged (t/4533) ──
test('consult-hold-aged: consult-hold past SO_TIMEBOX_HOURS with no SO reply detected escalates', () => {
  const pr = basePr({
    labels: ['consult-hold'],
    consultHoldAppliedAt: hoursAgo(SO_TIMEBOX_HOURS + 1),
    soClearanceDetected: false,
  });
  const v = classifyBlocker(pr, NOW);
  assert.equal(v.class, 'consult-hold-aged');
  assert.ok(v.detail.holdAgeHours > SO_TIMEBOX_HOURS);
  assert.equal(escalationLevel(v.class, 0), 'owner'); // escalates immediately, not after another OWNER_SLA_HOURS
});

test('consult-hold-aged: NOT fired when under the time-box (ordinary held)', () => {
  const pr = basePr({
    labels: ['consult-hold'],
    consultHoldAppliedAt: hoursAgo(SO_TIMEBOX_HOURS - 0.5),
    soClearanceDetected: false,
  });
  assert.equal(classifyBlocker(pr, NOW)?.class, 'held');
});

test('consult-hold-aged: NOT fired when an SO has already replied, even well past the time-box (ordinary held, waiting on PI/TL)', () => {
  const pr = basePr({
    labels: ['consult-hold'],
    consultHoldAppliedAt: hoursAgo(SO_TIMEBOX_HOURS + 10),
    soClearanceDetected: true,
  });
  assert.equal(classifyBlocker(pr, NOW)?.class, 'held');
});

test('consult-hold-aged: NOT fired without a known consultHoldAppliedAt -- never guessed, stays ordinary held', () => {
  const pr = basePr({ labels: ['consult-hold'], soClearanceDetected: false });
  assert.equal(classifyBlocker(pr, NOW)?.class, 'held');
});

test('consult-hold-aged: joint-gv-held PRs are exempt (no SO time-box applies to them)', () => {
  const pr = basePr({
    labels: ['joint-gv'],
    consultHoldAppliedAt: hoursAgo(SO_TIMEBOX_HOURS + 5),
    soClearanceDetected: false,
  });
  assert.equal(classifyBlocker(pr, NOW)?.class, 'held');
});

test('consult-hold-aged: a PR with BOTH consult-hold and joint-gv is exempt from aging (still just held)', () => {
  const pr = basePr({
    labels: ['consult-hold', 'joint-gv'],
    consultHoldAppliedAt: hoursAgo(SO_TIMEBOX_HOURS + 5),
    soClearanceDetected: false,
  });
  assert.equal(classifyBlocker(pr, NOW)?.class, 'held');
});

// ── merge-conflict ──
test('merge-conflict: isConflicting true, no hold label', () => {
  const pr = basePr({ isConflicting: true });
  assert.equal(classifyBlocker(pr, NOW).class, 'merge-conflict');
});

// ── stuck-required-run (the #3062 class) — queued arm ──
test('stuck-required-run: queued past the 30-min threshold (using startedAt)', () => {
  const pr = basePr({ runs: allGreenRuns({ 'joint-gv-guard': { status: 'queued', conclusion: null, createdAt: minsAgo(QUEUED_STUCK_MINUTES + 1), startedAt: null, id: 999 } }) });
  const v = classifyBlocker(pr, NOW);
  assert.equal(v.class, 'stuck-required-run');
  assert.equal(v.detail.context, 'joint-gv-guard');
  assert.equal(v.detail.runId, 999);
  assert.equal(v.detail.stuckKind, 'queued');
  assert.match(v.detail.remedy, /re-trigger/i);
});
test('BOUNDARY: queued exactly at 30 min is NOT yet stuck', () => {
  const pr = basePr({ runs: allGreenRuns({ 'ci-gate': { status: 'queued', conclusion: null, createdAt: minsAgo(QUEUED_STUCK_MINUTES), startedAt: null, id: 1 } }) });
  const v = classifyBlocker(pr, NOW);
  assert.notEqual(v?.class, 'stuck-required-run');
});
test('BOUNDARY: queued at 30 min + 1 second IS stuck', () => {
  const createdAt = new Date(NOW - (QUEUED_STUCK_MINUTES * 60 + 1) * 1000).toISOString();
  const pr = basePr({ runs: allGreenRuns({ 'ci-gate': { status: 'queued', conclusion: null, createdAt, startedAt: null, id: 1 } }) });
  assert.equal(classifyBlocker(pr, NOW).class, 'stuck-required-run');
});
test('an older green run does NOT mask a stuck queued run (#3062 blind spot)', () => {
  const pr = basePr({ runs: allGreenRuns({ 'joint-gv-guard': { status: 'queued', conclusion: null, createdAt: minsAgo(40), startedAt: null, id: 2 } }) });
  assert.equal(classifyBlocker(pr, NOW).class, 'stuck-required-run');
});

// ── stuck-required-run — in_progress arm, PER-WORKFLOW threshold (MUST-fix) ──
test('in_progress: ci-gate (35min threshold) at 20min is NOT stuck -- a slow but normal CI run', () => {
  const pr = basePr({ runs: allGreenRuns({ 'ci-gate': { status: 'in_progress', conclusion: null, createdAt: minsAgo(20), startedAt: minsAgo(20), id: 1 } }) });
  assert.notEqual(classifyBlocker(pr, NOW)?.class, 'stuck-required-run');
});
test('in_progress: ci-gate past its own 35min threshold IS stuck', () => {
  const pr = basePr({ runs: allGreenRuns({ 'ci-gate': { status: 'in_progress', conclusion: null, createdAt: minsAgo(36), startedAt: minsAgo(36), id: 1 } }) });
  const v = classifyBlocker(pr, NOW);
  assert.equal(v.class, 'stuck-required-run');
  assert.equal(v.detail.stuckKind, 'in_progress');
});
test('in_progress: joint-gv-guard (10min floor) at 20min IS stuck, even though it would NOT be at ci-gate\'s threshold', () => {
  const pr = basePr({ runs: allGreenRuns({ 'joint-gv-guard': { status: 'in_progress', conclusion: null, createdAt: minsAgo(20), startedAt: minsAgo(20), id: 1 } }) });
  assert.equal(classifyBlocker(pr, NOW).class, 'stuck-required-run');
});

// ── re-run handling (MUST-fix): createdAt keeps the ORIGINAL run's time; startedAt must be used ──
test('a re-run (runAttempt>1) uses startedAt, not the stale original createdAt, for stuck math', () => {
  // The run was first attempted 2 hours ago (would read as very stuck on createdAt alone),
  // but re-run 5 minutes ago and is legitimately still queued since then.
  const pr = basePr({ runs: allGreenRuns({ 'ci-gate': { status: 'queued', conclusion: null, createdAt: hoursAgo(2), startedAt: null, runAttempt: 2, id: 1 } }) });
  // queued uses createdAt as fallback when startedAt is null (still queued, never started) --
  // this specific case is ambiguous by design (a queued re-run has no startedAt yet), so the
  // real re-run protection is for IN_PROGRESS re-runs, tested next.
  const inProgressRerun = basePr({ runs: allGreenRuns({ 'ci-gate': { status: 'in_progress', conclusion: null, createdAt: hoursAgo(2), startedAt: minsAgo(5), runAttempt: 2, id: 1 } }) });
  assert.notEqual(classifyBlocker(inProgressRerun, NOW)?.class, 'stuck-required-run', 'startedAt (5min ago) must win over stale createdAt (2h ago)');
});

// ── REAL RECORDED PAYLOAD SHAPE (Lead review: "the test that fails today" before the fix) ──
test('REAL SHAPE: a queued "CI" workflow run (name=CI, path=ci.yml) classifies as stuck-required-run/ci-gate', () => {
  // This fixture is the actual actions/runs shape GitHub returns -- `name` is the workflow's
  // display name ('CI'), never the required-context name ('ci-gate'). Before the path-matching
  // fix, REQUIRED_CONTEXTS.includes('CI') was always false, so this never classified at all.
  const realRun = {
    name: 'CI', // <- present in the real payload but DELIBERATELY unused by the classifier
    path: '.github/workflows/ci.yml',
    status: 'queued',
    conclusion: null,
    createdAt: minsAgo(45),
    startedAt: null,
    runAttempt: 1,
    id: 37762036293,
  };
  const pr = basePr({ runs: [realRun, ...allGreenRuns().filter((r) => r.path !== REQUIRED_CONTEXT_PATHS['ci-gate'])] });
  const v = classifyBlocker(pr, NOW);
  assert.equal(v.class, 'stuck-required-run');
  assert.equal(v.detail.context, 'ci-gate');
});
test('REAL SHAPE: "CodeQL SAST" workflow run (name != CodeQL, path=codeql.yml) is matched for armed-but-blocked', () => {
  const runs = REQUIRED_CONTEXTS.map((name) => {
    if (name === 'CodeQL') {
      return { name: 'CodeQL SAST', path: REQUIRED_CONTEXT_PATHS.CodeQL, status: 'completed', conclusion: 'success', createdAt: hoursAgo(1), startedAt: hoursAgo(1), runAttempt: 1, id: 2 };
    }
    return { name, path: REQUIRED_CONTEXT_PATHS[name], status: 'completed', conclusion: 'success', createdAt: hoursAgo(1), startedAt: hoursAgo(1), runAttempt: 1, id: 1 };
  });
  const pr = basePr({ runs, autoMergeEnabled: true, mergeableState: 'blocked', mergeableStateRecheck: 'blocked' });
  assert.equal(classifyBlocker(pr, NOW).class, 'armed-but-blocked');
});

// ── required-check-failed ──
test('required-check-failed: a required context concluded failure', () => {
  const pr = basePr({ runs: allGreenRuns({ CodeQL: { status: 'completed', conclusion: 'failure', createdAt: minsAgo(10), startedAt: minsAgo(10), id: 5 } }) });
  const v = classifyBlocker(pr, NOW);
  assert.equal(v.class, 'required-check-failed');
  assert.equal(v.detail.context, 'CodeQL');
});

// ── armed-but-blocked ──
test('armed-but-blocked: auto-merge armed, everything green, still BLOCKED on both reads', () => {
  const pr = basePr({ autoMergeEnabled: true, mergeableState: 'blocked', mergeableStateRecheck: 'blocked', mergeRefusalText: 'Required status check "joint-gv-guard" is expected' });
  const v = classifyBlocker(pr, NOW);
  assert.equal(v.class, 'armed-but-blocked');
  assert.match(v.detail.mergeRefusalText, /joint-gv-guard/);
});
test('NOT armed-but-blocked: armed and green but mergeableState is clean (normal in-flight merge)', () => {
  const pr = basePr({ autoMergeEnabled: true, mergeableState: 'clean' });
  assert.notEqual(classifyBlocker(pr, NOW)?.class, 'armed-but-blocked');
});
test('NOT armed-but-blocked: ci-gate missing entirely (even with everything else green and armed)', () => {
  const pr = basePr({ runs: allGreenRuns().filter((r) => r.path !== REQUIRED_CONTEXT_PATHS['ci-gate']), autoMergeEnabled: true, mergeableState: 'blocked', mergeableStateRecheck: 'blocked' });
  assert.notEqual(classifyBlocker(pr, NOW)?.class, 'armed-but-blocked');
});
test('t/4096 arm 1: FIRE ARM -- stale-then-clean sequence does NOT escalate (first read blocked, recheck clean)', () => {
  const pr = basePr({ autoMergeEnabled: true, mergeableState: 'blocked', mergeableStateRecheck: 'clean' });
  assert.notEqual(classifyBlocker(pr, NOW)?.class, 'armed-but-blocked');
});
test('t/4096 arm 1: a recheck the caller never performed (undefined) does NOT escalate on a single blocked read', () => {
  const pr = basePr({ autoMergeEnabled: true, mergeableState: 'blocked' });
  assert.notEqual(classifyBlocker(pr, NOW)?.class, 'armed-but-blocked');
});

// ── approved-not-armed (t/4557) ──
test('approved-not-armed: approved, every required context green, NOT armed -> fires, escalates to owner immediately', () => {
  const pr = basePr({ hasApproval: true, autoMergeEnabled: false, lastActivityAt: hoursAgo(5) /* would otherwise be idle */ });
  const v = classifyBlocker(pr, NOW);
  assert.equal(v.class, 'approved-not-armed');
  assert.equal(escalationLevel(v.class, 0), 'owner');
});
test('NOT approved-not-armed: approved and green, but ALREADY armed -> falls through (not this class)', () => {
  const pr = basePr({ hasApproval: true, autoMergeEnabled: true, lastActivityAt: minsAgo(5) });
  assert.notEqual(classifyBlocker(pr, NOW)?.class, 'approved-not-armed');
});
test('NOT approved-not-armed: a T1/T2 PR not yet approved, even though green and unarmed -> correctly NOT ready yet (falls through to idle/null)', () => {
  const pr = basePr({ hasApproval: false, autoMergeEnabled: false, lastActivityAt: minsAgo(5), body: 'Tier: T1\n...' });
  assert.notEqual(classifyBlocker(pr, NOW)?.class, 'approved-not-armed');
});

test('approved-not-armed: a T0 PR with NO review at all still fires -- T0 needs no approval (real shape, PR #3926)', () => {
  const pr = basePr({ hasApproval: false, autoMergeEnabled: false, body: 'Tier: T0\n...' });
  assert.equal(classifyBlocker(pr, NOW)?.class, 'approved-not-armed');
});
test('NOT approved-not-armed: approved and unarmed, but a required context is NOT green -> falls through (a real failure/in-flight class takes priority)', () => {
  const pr = basePr({
    hasApproval: true, autoMergeEnabled: false,
    runs: allGreenRuns({ 'ci-gate': { status: 'completed', conclusion: 'failure' } }),
  });
  assert.notEqual(classifyBlocker(pr, NOW)?.class, 'approved-not-armed');
});

// ── CI still in flight is NOT stuck (t/4557, the #3934 false-alarm shape) ──
test('CI in flight: a required context queued or in_progress, under its own stuck threshold, with stale lastActivityAt -> null, NOT idle', () => {
  const pr = basePr({
    lastActivityAt: hoursAgo(2), // would otherwise trip idle
    runs: allGreenRuns({ 'ci-gate': { status: 'in_progress', conclusion: null, startedAt: minsAgo(5) } }),
  });
  assert.equal(classifyBlocker(pr, NOW), null);
});
test('CI in flight guard does NOT mask a run that IS past its stuck threshold (stuck-required-run still fires)', () => {
  const pr = basePr({
    lastActivityAt: hoursAgo(2),
    runs: allGreenRuns({ 'ci-gate': { status: 'in_progress', conclusion: null, startedAt: hoursAgo(1) } }),
  });
  assert.equal(classifyBlocker(pr, NOW)?.class, 'stuck-required-run');
});

// ── idle ──
test('idle: no other blocker, no activity for over the idle-detect threshold', () => {
  const pr = basePr({ lastActivityAt: hoursAgo(2) });
  assert.equal(classifyBlocker(pr, NOW).class, 'idle');
});
test('NOT idle: recent activity, no other blocker -> null (nothing to report)', () => {
  const pr = basePr({ lastActivityAt: minsAgo(5) });
  assert.equal(classifyBlocker(pr, NOW), null);
});

// ── escalation SLA ──
test('escalation: under 2h -> none', () => {
  assert.equal(escalationLevel('idle', 1), 'none');
});
test('escalation: at 2h -> owner', () => {
  assert.equal(escalationLevel('stuck-required-run', OWNER_SLA_HOURS), 'owner');
});
test('escalation: at 6h -> tl', () => {
  assert.equal(escalationLevel('stuck-required-run', TL_SLA_HOURS), 'tl');
});
test('escalation: held never escalates regardless of age', () => {
  assert.equal(escalationLevel('held', 1000), 'none');
});

// ── D1 (t/4123 BLOCKING): real arm-event names, not the assumed ones ──
test('ARM_EVENT_RE matches every real arm event name seen in the live feed', () => {
  assert.ok(ARM_EVENT_RE.test('auto_squash_enabled'), '781 occurrences in the live feed (t/4123)');
  assert.ok(ARM_EVENT_RE.test('auto_rebase_enabled'), '183 occurrences in the live feed (t/4123)');
  assert.ok(ARM_EVENT_RE.test('auto_merge_enabled'), 'the originally-assumed name -- only 1 occurrence, still valid');
  assert.ok(ARM_EVENT_RE.test('auto_update_enabled'));
  assert.ok(!ARM_EVENT_RE.test('auto_merge_disabled'), 'disabling is not arming');
  assert.ok(!ARM_EVENT_RE.test('ready_for_review'));
});
test('sweep: ready_for_review then auto_squash_enabled within 15s -> a hit (the real event name)', () => {
  const events = [
    { prNumber: 101, event: 'ready_for_review', actor: 'agent-a', createdAt: '2026-10-08T10:00:00Z' },
    { prNumber: 101, event: 'auto_squash_enabled', actor: 'agent-a', createdAt: '2026-10-08T10:00:10Z' },
  ];
  const hits = detectSweepSignature(events);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].prNumber, 101);
  assert.equal(hits[0].deltaSeconds, 10);
});
test('sweep: a gap beyond the window is NOT a hit (legitimate owner flow)', () => {
  const events = [
    { prNumber: 101, event: 'ready_for_review', actor: 'tl', createdAt: '2026-10-08T10:00:00Z' },
    { prNumber: 101, event: 'auto_squash_enabled', actor: 'tl', createdAt: '2026-10-08T10:05:00Z' }, // 5 min later
  ];
  assert.equal(detectSweepSignature(events).length, 0);
});
test('sweep: auto_rebase_enabled and auto_update_enabled also count as arm events', () => {
  for (const ev of ['auto_rebase_enabled', 'auto_update_enabled']) {
    const events = [
      { prNumber: 7, event: 'ready_for_review', actor: 'x', createdAt: '2026-10-08T10:00:00Z' },
      { prNumber: 7, event: ev, actor: 'x', createdAt: '2026-10-08T10:00:05Z' },
    ];
    assert.equal(detectSweepSignature(events).length, 1, ev);
  }
});

// ── D2, backward-replay fix (Lead review, PR #3152): forward-replay-from-empty missed a PR
// held BEFORE the lookback window that then received any OTHER label event inside it. Fixed
// by walking backwards from the LIVE label snapshot, undoing events after the arm time.
test('REAL FIXTURE #3145 via backward replay: live labels empty (held cleared after), unlabeled event after arm -> heldAtArmTime true', () => {
  const events = [
    { prNumber: 3145, event: 'labeled', label: 'consult-hold', actor: 'jpsnover', createdAt: '2026-10-08T12:52:08Z' },
    { prNumber: 3145, event: 'ready_for_review', actor: 'jpsnover', createdAt: '2026-10-08T12:58:26Z' },
    { prNumber: 3145, event: 'auto_squash_enabled', actor: 'jpsnover', createdAt: '2026-10-08T12:58:30Z' },
    { prNumber: 3145, event: 'auto_merge_disabled', actor: 'jpsnover', createdAt: '2026-10-08T13:02:25Z' },
    { prNumber: 3145, event: 'unlabeled', label: 'consult-hold', actor: 'jpsnover', createdAt: '2026-10-08T13:02:39Z' },
  ];
  // Live (scan-time) state: consult-hold was removed at 13:02:39, so the CURRENT label set is
  // empty. Backward replay must still find heldAtArmTime=true at 12:58:30 by undoing the
  // unlabeled event (which happened AFTER the arm).
  const liveLabelsByPr = new Map([[3145, []]]);
  const hits = detectSweepSignature(events, liveLabelsByPr);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].heldAtArmTime, true);
  assert.deepEqual(hits[0].heldLabels, ['consult-hold']);
  const verdicts = classifySweepHits(hits);
  assert.equal(verdicts[0].escalate, true);
  assert.match(verdicts[0].reason, /held/i);
});
test('BUG FIX: held BEFORE the window, plus an unrelated label event INSIDE the window -> still escalates', () => {
  // The exact miss the Lead found: the original "consult-hold" labeled event is outside the
  // fetched window entirely (never appears in `events`), but the PR gets an unrelated label
  // (e.g. this job's own stuck-pr-alert-owner) inside the window. Forward-replay-from-empty
  // saw labelEvents.length > 0 (the unrelated one) and never found the hold -> false. Backward
  // replay starts from the LIVE state (which DOES show consult-hold, since nothing removed it)
  // and finds no undo-worthy event after the arm -- correctly stays held.
  const events = [
    { prNumber: 5000, event: 'labeled', label: 'stuck-pr-alert-owner', actor: 'github-actions[bot]', createdAt: '2026-10-08T11:00:00Z' },
    { prNumber: 5000, event: 'ready_for_review', actor: 'jpsnover', createdAt: '2026-10-08T11:05:00Z' },
    { prNumber: 5000, event: 'auto_squash_enabled', actor: 'jpsnover', createdAt: '2026-10-08T11:05:03Z' },
  ];
  const liveLabelsByPr = new Map([[5000, ['consult-hold', 'stuck-pr-alert-owner']]]);
  const hits = detectSweepSignature(events, liveLabelsByPr);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].heldAtArmTime, true, 'the pre-window hold must still be found via the live snapshot');
  const verdicts = classifySweepHits(hits);
  assert.equal(verdicts[0].escalate, true);
});
test('a hold labelled AFTER the arm event does NOT count as held at arm time', () => {
  const events = [
    { prNumber: 6000, event: 'ready_for_review', actor: 'x', createdAt: '2026-10-08T12:00:00Z' },
    { prNumber: 6000, event: 'auto_squash_enabled', actor: 'x', createdAt: '2026-10-08T12:00:05Z' },
    { prNumber: 6000, event: 'labeled', label: 'consult-hold', actor: 'x', createdAt: '2026-10-08T12:05:00Z' },
  ];
  // Live state shows consult-hold (nobody removed it), but it was applied AFTER the arm, so
  // backward replay must undo it before concluding held-at-arm-time.
  const liveLabelsByPr = new Map([[6000, ['consult-hold']]]);
  const hits = detectSweepSignature(events, liveLabelsByPr);
  assert.equal(hits[0].heldAtArmTime, false);
});
test('a label cleared BEFORE the arm event is correctly NOT held at arm time', () => {
  const events = [
    { prNumber: 999, event: 'labeled', label: 'consult-hold', actor: 'x', createdAt: '2026-10-08T12:00:00Z' },
    { prNumber: 999, event: 'unlabeled', label: 'consult-hold', actor: 'x', createdAt: '2026-10-08T12:30:00Z' },
    { prNumber: 999, event: 'ready_for_review', actor: 'x', createdAt: '2026-10-08T12:35:00Z' },
    { prNumber: 999, event: 'auto_squash_enabled', actor: 'x', createdAt: '2026-10-08T12:35:05Z' },
  ];
  const liveLabelsByPr = new Map([[999, []]]);
  const hits = detectSweepSignature(events, liveLabelsByPr);
  assert.equal(hits[0].heldAtArmTime, false);
});
test('a PR with zero labeled/unlabeled events anywhere in the feed just reflects the live snapshot unchanged', () => {
  const events = [
    { prNumber: 1000, event: 'ready_for_review', actor: 'x', createdAt: '2026-10-08T12:00:00Z' },
    { prNumber: 1000, event: 'auto_squash_enabled', actor: 'x', createdAt: '2026-10-08T12:00:05Z' },
  ];
  assert.equal(detectSweepSignature(events, new Map([[1000, []]]))[0].heldAtArmTime, false);
  assert.equal(detectSweepSignature(events, new Map([[1000, ['consult-hold']]]))[0].heldAtArmTime, true);
});

// ── sweep classification: burst vs single legitimate flow, including the design decision
// t/4123 AC explicitly asks for: REAL FIXTURE #3141 (not held) + #3142 (held), 94s apart ──
test('REAL FIXTURE #3141/#3142: #3142 escalates as held; #3141 alone (burst-of-one, non-held) does NOT escalate', () => {
  const hits = [
    { prNumber: 3141, readyAt: '2026-10-08T12:37:44Z', armedAt: '2026-10-08T12:37:45Z', actor: 'jpsnover', heldAtArmTime: false, heldLabels: [] },
    { prNumber: 3142, readyAt: '2026-10-08T12:39:13Z', armedAt: '2026-10-08T12:39:18Z', actor: 'jpsnover', heldAtArmTime: true, heldLabels: ['consult-hold'] },
  ];
  // 94 seconds apart -- inside SWEEP_BURST_SECONDS (120), so a naive "any 2 hits within the
  // window" burst rule would couple them. Design decision (t/4123 AC): burst membership is
  // computed ONLY among non-held hits. #3142 is held, so it's excluded from the burst pool;
  // #3141 is then the ONLY non-held hit nearby -- a burst of one, which does not escalate.
  assert.ok((Date.parse(hits[1].armedAt) - Date.parse(hits[0].armedAt)) / 1000 < SWEEP_BURST_SECONDS);
  const verdicts = classifySweepHits(hits);
  const v3141 = verdicts.find((v) => v.prNumber === 3141);
  const v3142 = verdicts.find((v) => v.prNumber === 3142);
  assert.equal(v3142.escalate, true, '#3142 escalates on its own held-at-arm-time reason');
  assert.equal(v3141.escalate, false, '#3141 is not held and not part of a non-held burst -- confirm-only');
});
// ── t/4131: ready_for_review -> merged, no arm event, is an ARM-EQUIVALENT hit ─────────────
// TL design correction (p/331#1963): this is exactly what `gh pr ready` + `gh pr merge --auto`
// produces on an already-green PR -- GitHub merges immediately with no arm event at all.
test('REAL FIXTURE #3155 (10-08 sweeper incident): ready->merged in 5s, no arm, not held, not a burst -> confirm-only', () => {
  const events = [
    { prNumber: 3155, event: 'ready_for_review', actor: 'jpsnover', createdAt: '2026-10-08T15:55:31Z' },
    { prNumber: 3155, event: 'merged', actor: 'jpsnover', createdAt: '2026-10-08T15:55:36Z' },
  ];
  const hits = detectSweepSignature(events, new Map([[3155, []]]));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].signatureType, 'merge-equivalent');
  assert.equal(hits[0].deltaSeconds, 5);
  assert.equal(hits[0].heldAtArmTime, false);
  const verdicts = classifySweepHits(hits);
  assert.equal(verdicts[0].escalate, false, '#3155 was not held and not a burst -- confirm-only, matching the Lead\'s fixture note');
});

test('REAL FIXTURE #3172 (10-12, legitimate Worker merge): hold removed before ready, then ready->merged in 11s -> confirm-only', () => {
  // Real sequence: labeled consult-hold 09:42:42 -> unlabeled 09:56:41 -> ready_for_review
  // 09:56:44 -> merged 09:56:55. Live labels now empty. Proves the detector does NOT escalate
  // the normal green-PR --auto merge flow just because it matches the timing shape.
  const events = [
    { prNumber: 3172, event: 'labeled', label: 'consult-hold', actor: 'jpsnover', createdAt: '2026-10-12T09:42:42Z' },
    { prNumber: 3172, event: 'unlabeled', label: 'consult-hold', actor: 'jpsnover', createdAt: '2026-10-12T09:56:41Z' },
    { prNumber: 3172, event: 'ready_for_review', actor: 'jpsnover', createdAt: '2026-10-12T09:56:44Z' },
    { prNumber: 3172, event: 'merged', actor: 'jpsnover', createdAt: '2026-10-12T09:56:55Z' },
  ];
  const hits = detectSweepSignature(events, new Map([[3172, []]]));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].signatureType, 'merge-equivalent');
  assert.equal(hits[0].deltaSeconds, 11);
  assert.equal(hits[0].heldAtArmTime, false);
  const verdicts = classifySweepHits(hits);
  assert.equal(verdicts[0].escalate, false);
});

test('merge-equivalent: held at MERGE time (not scan time) still escalates, via the same backward replay', () => {
  const events = [
    { prNumber: 4000, event: 'labeled', label: 'consult-hold', actor: 'x', createdAt: '2026-10-12T09:00:00Z' },
    { prNumber: 4000, event: 'ready_for_review', actor: 'x', createdAt: '2026-10-12T09:05:00Z' },
    { prNumber: 4000, event: 'merged', actor: 'x', createdAt: '2026-10-12T09:05:30Z' },
  ];
  // Held throughout -- never unlabeled -- so it's held both at merge time and in the live snapshot.
  const hits = detectSweepSignature(events, new Map([[4000, ['consult-hold']]]));
  assert.equal(hits[0].heldAtArmTime, true);
  const verdicts = classifySweepHits(hits);
  assert.equal(verdicts[0].escalate, true);
  assert.match(verdicts[0].reason, /held .* at the moment it was merged/);
});

test('negative arm: an arm event between ready and merged rules out the merge-equivalent pairing (mutually exclusive)', () => {
  const events = [
    { prNumber: 5000, event: 'ready_for_review', actor: 'x', createdAt: '2026-10-12T09:00:00Z' },
    { prNumber: 5000, event: 'auto_squash_enabled', actor: 'x', createdAt: '2026-10-12T09:00:05Z' },
    { prNumber: 5000, event: 'merged', actor: 'x', createdAt: '2026-10-12T09:00:30Z' },
  ];
  const hits = detectSweepSignature(events, new Map([[5000, []]]));
  // Exactly one hit: the ARM pairing (at 5s). No second, merge-equivalent hit for the same
  // ready event, since an arm event occurred strictly between ready and merged.
  assert.equal(hits.length, 1);
  assert.equal(hits[0].signatureType, 'arm');
});

test('negative arm: ready, then a merge MINUTES later, does not fire the merge-equivalent pairing', () => {
  const events = [
    { prNumber: 6000, event: 'ready_for_review', actor: 'x', createdAt: '2026-10-12T09:00:00Z' },
    { prNumber: 6000, event: 'merged', actor: 'x', createdAt: '2026-10-12T09:05:00Z' }, // 5 minutes later
  ];
  const hits = detectSweepSignature(events, new Map([[6000, []]]));
  assert.equal(hits.length, 0);
});

test('a merged event with no preceding ready_for_review is not paired (same as the existing arm logic)', () => {
  const events = [
    { prNumber: 7000, event: 'merged', actor: 'x', createdAt: '2026-10-12T09:00:00Z' },
  ];
  assert.equal(detectSweepSignature(events, new Map([[7000, []]])).length, 0);
});

test('MERGE_EQUIVALENT_WINDOW_SECONDS is wider than SWEEP_WINDOW_SECONDS (GitHub\'s immediate-merge path can take longer than an arm-event write)', () => {
  assert.ok(MERGE_EQUIVALENT_WINDOW_SECONDS > SWEEP_WINDOW_SECONDS);
});

test('sweep burst: 2+ NON-HELD PRs within the burst window -> both escalate', () => {
  const hits = [
    { prNumber: 1, readyAt: '2026-10-08T10:00:00Z', armedAt: '2026-10-08T10:00:05Z', actor: 'x', heldAtArmTime: false, heldLabels: [] },
    { prNumber: 2, readyAt: '2026-10-08T10:01:00Z', armedAt: '2026-10-08T10:01:30Z', actor: 'x', heldAtArmTime: false, heldLabels: [] },
  ];
  const verdicts = classifySweepHits(hits);
  assert.ok(verdicts.every((v) => v.escalate));
});
test('single legitimate owner flow: one PR, not held, no burst -> confirm-only, no escalation', () => {
  const hits = [{ prNumber: 3121, readyAt: '2026-10-07T23:44:00Z', armedAt: '2026-10-07T23:44:05Z', actor: 'tl', heldAtArmTime: false, heldLabels: [] }];
  const verdicts = classifySweepHits(hits);
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0].escalate, false);
});
test('two hits on the SAME PR far apart do not count as a burst (burst needs 2+ DISTINCT PRs)', () => {
  const hits = [
    { prNumber: 9, readyAt: '2026-10-08T10:00:00Z', armedAt: '2026-10-08T10:00:05Z', actor: 'x', heldAtArmTime: false, heldLabels: [] },
    { prNumber: 9, readyAt: '2026-10-08T10:01:00Z', armedAt: '2026-10-08T10:01:05Z', actor: 'x', heldAtArmTime: false, heldLabels: [] },
  ];
  const verdicts = classifySweepHits(hits);
  assert.ok(verdicts.every((v) => !v.escalate));
});

// ── idempotent re-run over the same window (D3 support) ──
test('re-running detectSweepSignature over the SAME events twice yields identical hits (idempotent by construction)', () => {
  const events = [
    { prNumber: 101, event: 'ready_for_review', actor: 'x', createdAt: '2026-10-08T10:00:00Z' },
    { prNumber: 101, event: 'auto_squash_enabled', actor: 'x', createdAt: '2026-10-08T10:00:05Z' },
  ];
  assert.deepEqual(detectSweepSignature(events), detectSweepSignature(events));
});

test('constants are sane (Gate Co-Location)', () => {
  assert.ok(QUEUED_STUCK_MINUTES > 0);
  assert.ok(OWNER_SLA_HOURS < TL_SLA_HOURS);
  assert.ok(SWEEP_WINDOW_SECONDS > 0 && SWEEP_WINDOW_SECONDS < SWEEP_BURST_SECONDS);
  assert.deepEqual(REQUIRED_CONTEXTS, ['ci-gate', 'CodeQL', 'joint-gv-guard', 'consult-hold-guard']);
  for (const name of REQUIRED_CONTEXTS) {
    assert.ok(REQUIRED_CONTEXT_PATHS[name], `missing path mapping for ${name}`);
    assert.ok(IN_PROGRESS_STUCK_MINUTES[name] >= 10, `${name} in_progress threshold below the 10min floor`);
  }
});
