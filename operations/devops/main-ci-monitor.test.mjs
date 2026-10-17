// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// All-arms proof for the main-CI monitor verdict (t/3737), observe-what-ran model (TL p/331#1626/
// #1629). The shim keys on live gh state it can't exercise in unit tests, so the pure classifier is
// proven here directly. Run:  node --test operations/devops/main-ci-monitor.test.mjs
// Proves the SAME logic the workflow acts on (test == runtime).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyMainCI, runState, dedupeLatestByWorkflow, DEADLINE_MS, HEALTH_WORKFLOW,
  escalationDecision, heartbeatGap, ESCALATED_LABEL, HEARTBEAT_STALE_MS,
  isDocsOnlyPush, pushLivenessVerdict, PUSH_LIVENESS_DEADLINE_MS, CI_PATHS_IGNORE } from './main-ci-monitor.mjs';

// A push-event run: {name, status, conclusion}. Helpers for the common shapes.
const passed = (name) => ({ name, status: 'completed', conclusion: 'success' });
const failed = (name, c = 'failure') => ({ name, status: 'completed', conclusion: c });
const running = (name) => ({ name, status: 'in_progress', conclusion: null });
const CI = HEALTH_WORKFLOW; // 'CI'
const FRESH = 60 * 1000;
const OLD = DEADLINE_MS + 60 * 1000;

// ── runState ──
test('runState: completed+success → passed; skipped/neutral also non-failing', () => {
  assert.equal(runState(passed(CI)), 'passed');
  assert.equal(runState({ name: CI, status: 'completed', conclusion: 'skipped' }), 'passed');
  assert.equal(runState({ name: CI, status: 'completed', conclusion: 'neutral' }), 'passed');
});
test('runState: completed+failure/cancelled/timed_out → failed', () => {
  for (const c of ['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure']) {
    assert.equal(runState(failed(CI, c)), 'failed', c);
  }
});
test('runState: queued / in_progress → pending', () => {
  assert.equal(runState({ name: CI, status: 'queued', conclusion: null }), 'pending');
  assert.equal(runState(running(CI)), 'pending');
});

// ── dedupeLatestByWorkflow (re-runs) ──
test('dedupeLatestByWorkflow: keeps the latest run per workflow name by createdAt', () => {
  const runs = [
    { name: CI, status: 'completed', conclusion: 'failure', createdAt: '2026-09-29T10:00:00Z' },
    { name: CI, status: 'completed', conclusion: 'success', createdAt: '2026-09-29T11:00:00Z' }, // a re-run that fixed it
    { name: 'Other', status: 'completed', conclusion: 'success', createdAt: '2026-09-29T10:30:00Z' },
  ];
  const d = dedupeLatestByWorkflow(runs);
  assert.equal(d.length, 2);
  assert.equal(runState(d.find((r) => r.name === CI)), 'passed', 'latest CI re-run (success) wins over the earlier failure');
});

// ── classifyMainCI — the observe-what-ran states ──
test('RED — CI concluded failure → FULL alert, regardless of head age', () => {
  const v = classifyMainCI({ runs: [failed(CI), passed('Other')], headAgeMs: FRESH });
  assert.equal(v.severity, 'red');
  assert.equal(v.alert, true);
  assert.deepEqual(v.failedHealth, [CI]);
});
test('RED — CI failure also reports co-failing non-CI workflows', () => {
  const v = classifyMainCI({ runs: [failed(CI), failed('Debate-Tested Sweep')], headAgeMs: FRESH });
  assert.equal(v.severity, 'red');
  assert.deepEqual(v.failedOther, ['Debate-Tested Sweep']);
});
test('LOW NOTICE — a non-CI push workflow failed while CI passed → notice, not green, not full', () => {
  const v = classifyMainCI({ runs: [passed(CI), failed('Debate-Tested Sweep')], headAgeMs: FRESH });
  assert.equal(v.severity, 'notice');
  assert.equal(v.state, 'other-red');
  assert.equal(v.alert, true);
  assert.deepEqual(v.failedOther, ['Debate-Tested Sweep']);
});
test('LOW NOTICE — non-CI failure surfaces even when CI is absent (never silently dropped)', () => {
  const v = classifyMainCI({ runs: [failed('Debate-Tested Sweep')], headAgeMs: FRESH });
  assert.equal(v.severity, 'notice');
  assert.match(v.reason, /absent/);
});
test('GREEN — CI passed, nothing failed → no alert', () => {
  const v = classifyMainCI({ runs: [passed(CI), passed('Other')], headAgeMs: OLD });
  assert.equal(v.severity, 'none');
  assert.equal(v.state, 'green');
  assert.equal(v.alert, false);
});
test('UNRESOLVED within deadline — CI in flight does NOT alert', () => {
  const v = classifyMainCI({ runs: [running(CI)], headAgeMs: FRESH });
  assert.equal(v.state, 'unresolved');
  assert.equal(v.alert, false);
});
test('STUCK — CI created but unconcluded past deadline → alert (hung run)', () => {
  const v = classifyMainCI({ runs: [running(CI)], headAgeMs: OLD });
  assert.equal(v.state, 'stuck');
  assert.equal(v.severity, 'red');
  assert.equal(v.alert, true);
  assert.match(v.reason, /CREATED but has not concluded|hung|stuck/);
});

// ── the load-bearing TL ruling (p/331#1629): ABSENT → UNKNOWN, NO alert, EVEN past deadline ──
test('UNKNOWN — CI absent entirely does NOT alert even past deadline (docs-only merge: push-runs=0)', () => {
  const v = classifyMainCI({ runs: [], headAgeMs: OLD });
  assert.equal(v.state, 'unknown');
  assert.equal(v.alert, false, 'the every-docs-merge false-fire this whole model exists to prevent');
  assert.equal(v.severity, 'none');
});
test('UNKNOWN — CI absent with only a passing non-CI run past deadline still does NOT alert', () => {
  const v = classifyMainCI({ runs: [passed('Some-Other-Push-Workflow')], headAgeMs: OLD });
  assert.equal(v.state, 'unknown');
  assert.equal(v.alert, false);
});

// ── t/3912 escalation: both arms (transient does NOT escalate; persisting DOES, exactly once) ──
const H = 60 * 60 * 1000;
const NOW = Date.parse('2026-10-05T12:00:00Z');

test('escalation — transient: first sighting never escalates (the issue was just opened)', () => {
  // openOrUpdate only consults escalation on an ALREADY-open issue; a brand-new episode has 0 priors.
  assert.equal(escalationDecision({ openedAtMs: NOW, priorOccurrences: 0, nowMs: NOW }).escalate, false);
});

test('escalation — 2nd sighting within the hour does NOT escalate (age floor)', () => {
  assert.equal(escalationDecision({ openedAtMs: NOW - 15 * 60000, priorOccurrences: 1, nowMs: NOW }).escalate, false);
});

test('escalation — persisting: 2nd consecutive sighting ≥1h after open DOES escalate', () => {
  const d = escalationDecision({ openedAtMs: NOW - 2 * H, priorOccurrences: 1, nowMs: NOW });
  assert.equal(d.escalate, true);
  assert.match(d.reason, /persisting: 2 consecutive/);
});

test('escalation — the #2551 shape (30 sightings over 6 days) escalates', () => {
  assert.equal(escalationDecision({ openedAtMs: NOW - 6 * 24 * H, priorOccurrences: 29, nowMs: NOW }).escalate, true);
});

test('escalation — once per episode: an already-labelled issue never re-escalates', () => {
  const d = escalationDecision({ openedAtMs: NOW - 6 * 24 * H, priorOccurrences: 29, labels: ['bug', ESCALATED_LABEL], nowMs: NOW });
  assert.equal(d.escalate, false);
  assert.match(d.reason, /already escalated/);
});

test('escalation — unreadable open time fails SAFE (escalates), never silent', () => {
  assert.equal(escalationDecision({ openedAtMs: NaN, priorOccurrences: 1, nowMs: NOW }).escalate, true);
});

test('heartbeat — the observed throttled cadence (7.4h gap) is NOT a stale event', () => {
  // Baseline (t/3085): 30 scheduled runs arrived 1.5–7.4h apart; the old 45m threshold flagged every one.
  assert.equal(heartbeatGap({ priorMs: NOW - 7.4 * H, nowMs: NOW }).stale, false);
});

test('heartbeat — a gap past the recalibrated threshold IS stale', () => {
  const g = heartbeatGap({ priorMs: NOW - HEARTBEAT_STALE_MS - 60000, nowMs: NOW });
  assert.equal(g.stale, true);
  assert.equal(g.gapMin, HEARTBEAT_STALE_MS / 60000 + 1);
});

test('heartbeat — unreadable prior stamp is not stale (fresh heartbeat issue)', () => {
  assert.deepEqual(heartbeatGap({ priorMs: NaN, nowMs: NOW }), { stale: false, gapMin: null });
});

// ── PUSH LIVENESS (t/4126) ───────────────────────────────────────────────────────────────────
test('isDocsOnlyPush: all-markdown/docs change is docs-only', () => {
  assert.equal(isDocsOnlyPush(['README.md', 'docs/guide.md']), true);
});

test('isDocsOnlyPush: a docs commit that sneaks in one code file is NOT docs-only', () => {
  assert.equal(isDocsOnlyPush(['docs/guide.md', 'lib/foo.ts']), false);
});

test('isDocsOnlyPush: empty/unreadable file list fails toward checking it, not excusing it', () => {
  assert.equal(isDocsOnlyPush([]), false);
  assert.equal(isDocsOnlyPush(undefined), false);
});

test('isDocsOnlyPush: covers all three real ci.yml paths-ignore globs', () => {
  assert.equal(isDocsOnlyPush(['CHANGELOG.md', 'docs/x/y.md', 'deploy/azure/runbooks/ops.md'], CI_PATHS_IGNORE), true);
});

const commit = (sha, ageMs, extra = {}) => ({ sha, committedAtMs: NOW - ageMs, docsOnly: false, hasRun: false, ...extra });

test('push liveness — a push with a run within the deadline passes (no violation)', () => {
  const v = pushLivenessVerdict({ commits: [commit('a', 5 * 60000, { hasRun: true })], nowMs: NOW });
  assert.equal(v.alert, false);
  assert.deepEqual(v.violations, []);
});

test('push liveness — a push with NO run, past the deadline, alerts', () => {
  const v = pushLivenessVerdict({ commits: [commit('a', PUSH_LIVENESS_DEADLINE_MS + 60000)], nowMs: NOW });
  assert.equal(v.alert, true);
  assert.equal(v.violations.length, 1);
  assert.equal(v.violations[0].sha, 'a');
});

test('push liveness — a docs-only push never alerts, even with no run past the deadline', () => {
  const v = pushLivenessVerdict({ commits: [commit('a', PUSH_LIVENESS_DEADLINE_MS + 60000, { docsOnly: true })], nowMs: NOW });
  assert.equal(v.alert, false);
  assert.deepEqual(v.violations, []);
});

test('push liveness — a LATER descendant run covers an earlier commit with no run of its own', () => {
  const commits = [
    commit('older', PUSH_LIVENESS_DEADLINE_MS + 5 * 60000),                       // no run of its own
    commit('newer', PUSH_LIVENESS_DEADLINE_MS - 60000, { hasRun: true }),          // later, has a run
  ];
  const v = pushLivenessVerdict({ commits, nowMs: NOW });
  assert.equal(v.alert, false, 'the newer commit\'s run covers the older, uncovered commit');
  assert.deepEqual(v.violations, []);
});

test('push liveness — surfaces pushEventListed per violation for the observability ask', () => {
  const v = pushLivenessVerdict({
    commits: [commit('a', PUSH_LIVENESS_DEADLINE_MS + 60000, { pushEventListed: false })],
    nowMs: NOW,
  });
  assert.equal(v.violations[0].pushEventListed, false);
});

// ── REPLAY: the actual 2026-10-08 14:30-15:30Z incident (t/4126 acceptance criteria) ─────────
test('REPLAY: at ~15:01Z, e5b347fb (14:41Z, no run yet) alerts; dae9a5c6/309c7ff5/e9bf9e98 are too fresh', () => {
  // 15:02Z (not exactly 15:01Z) so e5b347fb's age (21m) is unambiguously past the 20m deadline,
  // not sitting exactly on the boundary.
  const base = new Date('2026-10-08T15:02:00Z').getTime();
  const commits = [
    { sha: 'e5b347fb', committedAtMs: new Date('2026-10-08T14:41:00Z').getTime(), docsOnly: false, hasRun: false, pushEventListed: false },
    { sha: 'dae9a5c6', committedAtMs: new Date('2026-10-08T14:57:00Z').getTime(), docsOnly: false, hasRun: false, pushEventListed: false },
    { sha: '309c7ff5', committedAtMs: new Date('2026-10-08T15:00:00Z').getTime(), docsOnly: false, hasRun: false, pushEventListed: false },
  ];
  const v = pushLivenessVerdict({ commits, nowMs: base });
  assert.equal(v.alert, true);
  assert.equal(v.violations.length, 1, 'only e5b347fb is past the 20min deadline at 15:01Z');
  assert.equal(v.violations[0].sha, 'e5b347fb');
});

test('REPLAY: at 15:21Z, all four are covered by e9bf9e98\'s late run (arrived 15:16Z) — clears', () => {
  const base = new Date('2026-10-08T15:21:00Z').getTime();
  const commits = [
    { sha: 'e5b347fb', committedAtMs: new Date('2026-10-08T14:41:00Z').getTime(), docsOnly: false, hasRun: false, pushEventListed: false },
    { sha: 'dae9a5c6', committedAtMs: new Date('2026-10-08T14:57:00Z').getTime(), docsOnly: false, hasRun: false, pushEventListed: false },
    { sha: '309c7ff5', committedAtMs: new Date('2026-10-08T15:00:00Z').getTime(), docsOnly: false, hasRun: false, pushEventListed: false },
    { sha: 'e9bf9e98', committedAtMs: new Date('2026-10-08T15:05:00Z').getTime(), docsOnly: false, hasRun: true, pushEventListed: true },
  ];
  const v = pushLivenessVerdict({ commits, nowMs: base });
  assert.equal(v.alert, false, 'e9bf9e98\'s run (15:16Z) covers all three earlier commits in the same gap');
  assert.deepEqual(v.violations, []);
});

// ── FAULT-ARM: prove a stubbed-out verdict is distinguishable from the real one ──────────────
test('FAULT-ARM: a pushLivenessVerdict that ignores coverage entirely always alerts — distinguishable', () => {
  function brokenVerdict({ commits, nowMs, deadlineMs = PUSH_LIVENESS_DEADLINE_MS }) {
    // t/3897#6-shaped: forgets the "covered by a later run" rule entirely.
    const violations = (commits ?? [])
      .filter((c) => !c.docsOnly && Number(nowMs) - Number(c.committedAtMs) > deadlineMs)
      .map((c) => ({ sha: c.sha }));
    return { alert: violations.length > 0, violations };
  }
  const commits = [
    commit('older', PUSH_LIVENESS_DEADLINE_MS + 5 * 60000),
    commit('newer', PUSH_LIVENESS_DEADLINE_MS - 60000, { hasRun: true }),
  ];
  const real = pushLivenessVerdict({ commits, nowMs: NOW });
  assert.equal(real.alert, false, 'the real implementation correctly honors descendant-run coverage');

  const broken = brokenVerdict({ commits, nowMs: NOW });
  assert.equal(broken.alert, true, 'the broken implementation would have false-alerted on a covered commit');
});
