// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/4115 (t/4096 item 2): pure classifier for the stuck-PR SLA alert. Alert-only — never
 * blocks a merge. The impure `pr-triage.yml` step fetches facts (actions/runs?head_sha,
 * mergeability, labels, issue-events) and calls these functions; this file does no I/O.
 *
 * REQUIRED_CONTEXTS mirrors branch protection's required status checks (docs/...; t/3736).
 * Read from actions/runs?head_sha or check-suites, NEVER from `gh pr checks` or the
 * check-runs rollup — both collapse to the newest-by-name view and hide a run that is
 * QUEUED behind an older, already-green run of the same workflow (#3062, t/4096#1): GitHub
 * evaluates a required context against the NEWEST check suite, so a stuck queued suite
 * reads as "expected" even though an older green suite for the same workflow exists and is
 * visible everywhere else. That blind spot is exactly what stuck-required-run exists to catch.
 */
import { SO_CLEARED_RE } from './fleet-delivery-metrics.mjs';
import { extractTier } from './tier-check-predicate.mjs';

export const REQUIRED_CONTEXTS = ['ci-gate', 'CodeQL', 'joint-gv-guard', 'consult-hold-guard'];

// MUST-fix (Lead review, PR #3141): `actions/runs`' `name` field is the WORKFLOW name
// ('CI', 'CodeQL SAST'), not the required-context/job name ('ci-gate', 'CodeQL') -- matching
// REQUIRED_CONTEXTS against run.name silently matched NOTHING for ci-gate or CodeQL, so
// stuck-required-run/required-check-failed never saw them and armed-but-blocked could never
// fire (its allGreen check needs all four). Match on the WORKFLOW FILE PATH instead, which is
// stable across a workflow's `name:` edits. Gate Co-Location: this map MUST change whenever
// branch protection's required contexts change (verify live via `gh api .../branches/main/protection`).
export const REQUIRED_CONTEXT_PATHS = {
  'ci-gate': '.github/workflows/ci.yml',
  CodeQL: '.github/workflows/codeql.yml',
  'joint-gv-guard': '.github/workflows/joint-gv-guard.yml',
  'consult-hold-guard': '.github/workflows/consult-hold-guard.yml',
};

// Gate Co-Location: thresholds at their point of use, with rationale.
// A QUEUED required run past this is the #3062 signature -- GitHub treats it as "expected"
// even though it's doing nothing (t/4096#2).
export const QUEUED_STUCK_MINUTES = 30;

// MUST-fix (Lead review): an IN_PROGRESS run isn't stuck just because it's slow -- `ci.yml`
// legitimately runs long (PowerShell shards). Threshold is each workflow's own measured p95
// successful-run duration (updated_at - run_started_at, last 50 successful runs, measured
// 2026-10-08) * 1.5, floored at 10 min so a fast workflow (joint-gv-guard, consult-hold-guard)
// isn't flagged on ordinary runner-scheduling jitter:
//   ci-gate (ci.yml):             p95 1397s (23.3min) -> 35min
//   CodeQL (codeql.yml):          p95  426s ( 7.1min) -> 11min
//   joint-gv-guard:               p95  132s ( 2.2min) -> floor 10min
//   consult-hold-guard:           p95  117s ( 2.0min) -> floor 10min
// Re-measure if a workflow's steps change materially; these are observed-not-bounded.
export const IN_PROGRESS_STUCK_MINUTES = {
  'ci-gate': 35,
  CodeQL: 11,
  'joint-gv-guard': 10,
  'consult-hold-guard': 10,
};

// t/4533 (TL, t/4091#44): the SO's own 2h time-box (root AGENTS.md Change Tiers) isn't enforced
// today -- a consult-hold PR with no SO reply past this mark silently sits, instead of routing
// to the approver marked "SO did not review" per the documented fallback.
export const SO_TIMEBOX_HOURS = 2;

export const IDLE_DETECT_HOURS = 1;    // no PR activity for this long, with no other named blocker, names "idle".
export const OWNER_SLA_HOURS = 2;      // blocker episode age at which the owning role is pinged.
export const TL_SLA_HOURS = 6;         // blocker episode age at which the TL is pinged (never the PI).
export const SWEEP_WINDOW_SECONDS = 15;  // ready_for_review -> auto_*_enabled within this = the sweep signature.
export const SWEEP_BURST_SECONDS = 120;  // 2+ PRs showing the signature within this window = the sweep shape.
// t/4131 (t/4123 follow-up): ready_for_review -> merged, with NO arm event in between, within
// this window = an ARM-EQUIVALENT hit. TL design correction (p/331#1963): this isn't specifically
// a "direct merge" -- it's exactly what `gh pr ready` + `gh pr merge --auto` produces on a PR
// whose checks are already green (GitHub merges immediately and logs no arm event at all). 60s,
// wider than SWEEP_WINDOW_SECONDS, because GitHub's immediate-merge path can take a few seconds
// longer than an arm-event write.
export const MERGE_EQUIVALENT_WINDOW_SECONDS = 60;

/**
 * PURE. Classifies one open, non-draft PR's blocker, or null if it has none.
 *
 * @param {object} pr
 * @param {string} pr.mergeableState - GitHub's mergeable_state, e.g. 'behind'|'clean'|'dirty'|'blocked'|'unknown'.
 * @param {string|undefined} pr.mergeableStateRecheck - a SECOND, later re-fetch of mergeableState,
 *   done by the caller only for a PR that already looks armed-but-blocked (allGreen + 'blocked'),
 *   to confirm the read wasn't a transient staleness artifact (t/4096 arm 1). Undefined if the
 *   caller didn't perform the recheck.
 * @param {boolean} pr.isConflicting - true iff mergeable === false / mergeable_state === 'dirty' (GitHub's CONFLICTING).
 * @param {boolean} pr.autoMergeEnabled
 * @param {string[]} pr.labels
 * @param {Array<{path:string, status:string, conclusion:string|null, createdAt:string, startedAt:string|null, runAttempt:number, id:number}>} pr.runs
 *   The NEWEST run per workflow FILE PATH touching this head SHA (actions/runs?head_sha).
 *   `path` is matched against REQUIRED_CONTEXT_PATHS, never `name` (MUST-fix, PR #3141 review:
 *   `name` is the workflow's display name, e.g. 'CI', not the required-context/job name).
 *   `startedAt` is `run_started_at`; on a re-run (runAttempt > 1) `createdAt` keeps the
 *   ORIGINAL run's timestamp, so stuck-duration math must use startedAt (falling back to
 *   createdAt only when startedAt is unset, e.g. a run still queued and never started).
 * @param {string|null} pr.mergeRefusalText - the REST merge attempt's refusal message, if tried.
 * @param {string|null} pr.lastActivityAt - ISO timestamp of the PR's last commit or non-bot
 *   comment/review (MUST exclude the alert's OWN comments and label writes, and other bot
 *   activity — PR #3141 review: using raw `updated_at` let the alert's own writes reset the
 *   idle/held-age clock every time it ran).
 * @param {string|null} [pr.consultHoldAppliedAt] - ISO timestamp the `consult-hold` label was
 *   FIRST applied (t/4533) -- only meaningful/needed when `labels` includes 'consult-hold'.
 *   Omit or null if unknown; a PR with the label but no known apply-time is treated as `held`
 *   (never escalated), never guessed into `consult-hold-aged`.
 * @param {boolean} [pr.soClearanceDetected] - true if any comment on the PR matches
 *   SO_CLEARED_RE (t/4533, reusing fleet-delivery-metrics.mjs's own detector) -- an SO has
 *   replied (cleared, or explicitly "did not review"), so the time-box question is already
 *   answered and this is ordinary `held` (waiting on PI/TL), never `consult-hold-aged`.
 * @param {boolean} [pr.hasApproval] - true if any PR review is in APPROVED state (t/4557).
 *   Combined with every required context green and NOT autoMergeEnabled, this is
 *   `approved-not-armed`, not generic `idle` -- a ready-to-merge PR nobody armed yet.
 * @param {string} [pr.body] - the PR body (t/4557); extractTier(pr.body) === 'T0' also counts
 *   as "ready" for `approved-not-armed` even with no review at all, since T0 needs none.
 * @param {number} nowMs
 * @returns {{class:string, detail:object}|null}
 */
export function classifyBlocker(pr, nowMs) {
  const labels = pr.labels ?? [];
  const runs = pr.runs ?? [];
  const byPath = new Map(runs.map((r) => [r.path, r]));
  const runFor = (contextName) => byPath.get(REQUIRED_CONTEXT_PATHS[contextName]);
  const stuckBasisMs = (run) => Date.parse(run.startedAt || run.createdAt);

  // 1. held — checked FIRST and reported alone: a hold is deliberate, so a PR carrying one
  //    is never escalated even if it also matches another class underneath.
  //
  //    EXCEPTION (t/4533): a `consult-hold` (not `joint-gv`, which has no SO time-box) past
  //    SO_TIMEBOX_HOURS since the label was applied, with NO SO reply detected at all, is not
  //    a deliberate hold anymore -- it's the 2h time-box rule going unenforced. This escalates
  //    as `consult-hold-aged`, distinct from ordinary `held`. A hold under the time-box, OR one
  //    where an SO has already replied (cleared, or explicitly "did not review") and it's now
  //    just waiting on PI/TL sign-off, is still ordinary `held` and never escalates -- only the
  //    specific "nobody has enforced the time-box" gap is new here.
  if (labels.includes('consult-hold') && !labels.includes('joint-gv') && !pr.soClearanceDetected && pr.consultHoldAppliedAt) {
    const holdAgeHours = (nowMs - Date.parse(pr.consultHoldAppliedAt)) / 3600000;
    if (holdAgeHours > SO_TIMEBOX_HOURS) {
      return {
        class: 'consult-hold-aged',
        detail: {
          holdAgeHours: Math.round(holdAgeHours * 10) / 10,
          consultHoldAppliedAt: pr.consultHoldAppliedAt,
          remedy: 'No SO reply past the 2h time-box -- route to the approver marked "SO did not review" (root AGENTS.md Change Tiers fallback).',
        },
      };
    }
  }
  if (labels.includes('consult-hold') || labels.includes('joint-gv')) {
    const ageHours = pr.lastActivityAt ? (nowMs - Date.parse(pr.lastActivityAt)) / 3600000 : null;
    return { class: 'held', detail: { labels: labels.filter((l) => l === 'consult-hold' || l === 'joint-gv'), ageHours } };
  }

  // 2. merge-conflict
  if (pr.isConflicting) {
    return { class: 'merge-conflict', detail: {} };
  }

  // 3. stuck-required-run — the #3062 blind spot. Checked before required-check-failed:
  //    a run that is still queued/in_progress has no conclusion yet, so it can't be "failed".
  //    QUEUED and IN_PROGRESS use DIFFERENT thresholds (MUST-fix): a queued run past 30min is
  //    the #3062 signature regardless of workflow; an in_progress run is only stuck past that
  //    WORKFLOW's own measured p95 duration -- ci.yml legitimately runs ~20min.
  for (const name of REQUIRED_CONTEXTS) {
    const run = runFor(name);
    if (!run) continue;
    if (run.status === 'queued') {
      const stuckMinutes = (nowMs - stuckBasisMs(run)) / 60000;
      if (stuckMinutes > QUEUED_STUCK_MINUTES) {
        return {
          class: 'stuck-required-run',
          detail: {
            context: name, runId: run.id, stuckMinutes: Math.round(stuckMinutes), stuckKind: 'queued',
            remedy: `Re-trigger first (toggle auto-merge or a label); if that doesn't clear it, cancel and re-run run ${run.id}.`,
          },
        };
      }
    } else if (run.status === 'in_progress') {
      const stuckMinutes = (nowMs - stuckBasisMs(run)) / 60000;
      const threshold = IN_PROGRESS_STUCK_MINUTES[name];
      if (stuckMinutes > threshold) {
        return {
          class: 'stuck-required-run',
          detail: {
            context: name, runId: run.id, stuckMinutes: Math.round(stuckMinutes), stuckKind: 'in_progress',
            remedy: `Running ${Math.round(stuckMinutes)}min, past this workflow's ${threshold}min threshold — check run ${run.id} for a hang before re-triggering.`,
          },
        };
      }
    }
  }

  // 4. required-check-failed
  for (const name of REQUIRED_CONTEXTS) {
    const run = runFor(name);
    if (run && run.status === 'completed' && run.conclusion !== 'success') {
      return { class: 'required-check-failed', detail: { context: name, conclusion: run.conclusion, runId: run.id } };
    }
  }

  // 5. armed-but-blocked
  //
  // t/4096 arm 1 finding (p/331#2203): `mergeable_state` can read 'blocked' for several seconds
  // after a PR becomes genuinely mergeable (a real GitHub API staleness quirk -- a live merge
  // attempt succeeded while the field still said 'blocked'). A single 'blocked' read is not
  // proof of a real block, so this class requires it to persist: `pr.mergeableStateRecheck` is a
  // SECOND, later re-fetch of the same field, done by the caller only when the first read already
  // looked like armed-but-blocked. Fire only when BOTH reads agree; a stale-then-clean sequence,
  // or a recheck the caller never performed (undefined), does NOT escalate this pass -- the next
  // scheduled run re-observes it, so a genuinely stuck PR is still caught, just not on a transient
  // single read.
  if (pr.autoMergeEnabled) {
    const allGreen = REQUIRED_CONTEXTS.every((name) => {
      const run = runFor(name);
      return run && run.status === 'completed' && run.conclusion === 'success';
    });
    if (allGreen && pr.mergeableState === 'blocked' && pr.mergeableStateRecheck === 'blocked') {
      return { class: 'armed-but-blocked', detail: { mergeRefusalText: pr.mergeRefusalText ?? '(not captured)' } };
    }
  }

  // 6. approved-not-armed (t/4557, TL p/702#93/#95) -- checked BEFORE idle so a PR that is
  //    genuinely ready to merge but simply never got armed is never mistaken for generic
  //    staleness. Distinct from (and lower-severity than) a real blocker: escalates to the
  //    owner immediately (see escalationLevel), since the PI decided NOT to make
  //    t1-approval-guard a required context (t/4091), so this sweep is now the primary
  //    mechanism that catches "ready but not armed" at all.
  //    "Ready" means every required context green, AND EITHER a real APPROVED review exists
  //    OR the PR's own declared tier is T0 -- a T0 PR needs no approval at all per Change
  //    Tiers (root AGENTS.md), so requiring hasApproval alone would miss it (confirmed live on
  //    PR #3926, a green T0 doc PR with zero reviews that the TL still flagged as this exact
  //    shape). A T1/T2 PR that's green but genuinely still awaiting approval does NOT fire
  //    here -- it correctly isn't "ready" yet.
  if (!pr.autoMergeEnabled) {
    const allGreen = REQUIRED_CONTEXTS.every((name) => {
      const run = runFor(name);
      return run && run.status === 'completed' && run.conclusion === 'success';
    });
    const tier = extractTier(pr.body);
    if (allGreen && (pr.hasApproval || tier === 'T0')) {
      return { class: 'approved-not-armed', detail: { remedy: 'Every required context is green and the PR is ready (approved, or T0 needing no approval), but auto-merge was never armed -- arm it (gh pr merge --auto --squash --match-head-commit <sha>), or merge directly if mergeStateStatus is already CLEAN.' } };
    }
  }

  // 7. CI still in flight -- NOT stuck (t/4557, TL p/702#93: "CI running isn't stuck at all").
  //    A required context that is queued/in_progress but has NOT yet crossed its own
  //    stuck-required-run threshold (case 3 above) is legitimately still working. Without this
  //    guard, a PR whose latest push predates IDLE_DETECT_HOURS but whose CI run simply hasn't
  //    finished yet would fall through to `idle` below and alert on normal, unremarkable
  //    in-progress CI -- exactly the #3934 false alarm the TL found. Checked before idle, after
  //    every genuinely-stuck class above has already had its chance to fire.
  const ciInFlight = REQUIRED_CONTEXTS.some((name) => {
    const run = runFor(name);
    return run && (run.status === 'queued' || run.status === 'in_progress');
  });
  if (ciInFlight) return null;

  // 8. idle
  if (pr.lastActivityAt) {
    const idleHours = (nowMs - Date.parse(pr.lastActivityAt)) / 3600000;
    if (idleHours > IDLE_DETECT_HOURS) {
      return { class: 'idle', detail: { idleHours: Math.round(idleHours * 10) / 10 } };
    }
  }

  return null;
}

/**
 * PURE. Given a named blocker and how long its episode has been open, decides who to ping.
 * 'held' never escalates, regardless of age — holds are deliberate (t/4115 design).
 * 'consult-hold-aged' (t/4533) and 'approved-not-armed' (t/4557) escalate to the owner
 * IMMEDIATELY on the episode's first scan (episodeAgeHours can be ~0 here) -- both only exist
 * once their own condition is already true (the 2h SO time-box lapsed; every required context
 * is already green and approved), so there is nothing left to wait on before notifying the
 * owner. Both still escalate to the TL at the normal TL_SLA_HOURS if the owner ping itself goes
 * unaddressed -- 'approved-not-armed' is now the PRIMARY mechanism for this class of miss since
 * the PI decided not to make t1-approval-guard a required context (t/4091), so it must not go
 * silent past its own owner ping.
 * @returns {'none'|'owner'|'tl'}
 */
export function escalationLevel(blockerClass, episodeAgeHours) {
  if (blockerClass === 'held') return 'none';
  if (episodeAgeHours >= TL_SLA_HOURS) return 'tl';
  if (blockerClass === 'consult-hold-aged' || blockerClass === 'approved-not-armed') return 'owner';
  if (episodeAgeHours >= OWNER_SLA_HOURS) return 'owner';
  return 'none';
}

// BLOCKING fix (t/4123, D1): the detector matched only `auto_merge_enabled`/`auto_update_enabled`,
// assumed names never recorded against this repo's live feed. GitHub actually logs
// `auto_squash_enabled` (781 occurrences) and `auto_rebase_enabled` (183) depending on the
// configured merge method; `auto_merge_enabled` itself occurred ONCE. The detector was seeing
// ~0.1% of real arm events -- exactly the #3141 path-mapping defect's shape: a fixture built
// from an assumed name, never a recorded payload. ARM_EVENT_RE is exported so the workflow's
// own event-type filter can delegate to this ONE list instead of hardcoding a second one.
export const ARM_EVENT_RE = /^auto_(merge|squash|rebase|update)_enabled$/;

/**
 * PURE. Finds ready_for_review -> arm-event pairs within SWEEP_WINDOW_SECONDS on the same PR
 * (t/4096#4 / t/3716), AND whether the PR was held (consult-hold/joint-gv) AT THE ARM EVENT'S
 * OWN TIME -- not at scan time (D2 fix). `events` is the repo-wide issue-events feed for the
 * lookback window, covering `ready_for_review`, every ARM_EVENT_RE match, and `labeled`/`unlabeled`
 * (GraphQL omits AutoMergeEnabledEvent from PR timelines, t/3716#18, so the caller must use the
 * REST issue-events endpoint, not GraphQL).
 *
 * heldAtArmTime is computed by replaying BACKWARDS from the live (current, scan-time) label
 * state, undoing every labeled/unlabeled event strictly after the arm timestamp, newest first
 * (Lead review, PR #3152: forward-replay-from-empty missed a PR held BEFORE the lookback
 * window that then received any OTHER label event inside it -- e.g. this job's own
 * `stuck-pr-alert-owner` label -- which made `labelEvents.length > 0` true while never showing
 * the original hold, so the forward replay silently reported `false`). Backward replay is exact
 * regardless of the lookback: every event after the arm is, by construction, inside the window
 * that was fetched to find the arm itself. This also removes the `null`/WARN fallback entirely
 * -- there is no "undetermined" state once the walk starts from a known-current snapshot.
 * Also pairs `ready_for_review` -> `merged` (t/4131, TL design correction p/331#1963): a merge
 * within MERGE_EQUIVALENT_WINDOW_SECONDS with NO arm event in between is an ARM-EQUIVALENT hit,
 * fed through the identical held/burst/confirm classification below -- held state is evaluated
 * at the MERGE event's time, using the same backward replay. Arm-based and merge-equivalent hits
 * are mutually exclusive by construction: an arm event strictly between ready and merged rules
 * out the merge-equivalent pairing for that same ready event.
 * @param {Array<{prNumber:number, event:string, actor:string, label?:string, createdAt:string}>} events
 * @param {Map<number,string[]>} liveLabelsByPr - current (scan-time) label names per PR, from
 *   `pulls.get` -- the only impure input this pure function needs; the caller fetches it once
 *   per PR that shows a ready+arm hit.
 * @returns {Array<{prNumber:number, readyAt:string, armedAt:string, deltaSeconds:number, actor:string, heldAtArmTime:boolean, heldLabels:string[], signatureType:'arm'|'merge-equivalent'}>}
 */
export function detectSweepSignature(events, liveLabelsByPr) {
  const byPr = new Map();
  for (const e of events ?? []) {
    if (!byPr.has(e.prNumber)) byPr.set(e.prNumber, []);
    byPr.get(e.prNumber).push(e);
  }
  const HOLD_LABELS = new Set(['consult-hold', 'joint-gv']);

  function heldStateAt(prNumber, prEventsSorted, armMs) {
    const liveLabels = liveLabelsByPr?.get(prNumber) ?? [];
    const held = new Set(liveLabels.filter((l) => HOLD_LABELS.has(l)));
    const labelEvents = prEventsSorted.filter((e) => e.event === 'labeled' || e.event === 'unlabeled');
    // Newest first; undo each event strictly after armMs. Once an event's time is <= armMs,
    // every earlier event (we're walking backwards) is too, so stop.
    for (let k = labelEvents.length - 1; k >= 0; k--) {
      const e = labelEvents[k];
      if (Date.parse(e.createdAt) <= armMs) break;
      if (!HOLD_LABELS.has(e.label)) continue;
      if (e.event === 'labeled') held.delete(e.label); // before this event, the label wasn't there yet
      else held.add(e.label); // before this event, the label WAS there (it got removed after)
    }
    return { heldAtArmTime: held.size > 0, heldLabels: [...held] };
  }

  const hits = [];
  for (const [prNumber, prEvents] of byPr) {
    const sorted = [...prEvents].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i].event !== 'ready_for_review') continue;
      const readyAt = Date.parse(sorted[i].createdAt);

      // Arm pairing: the first ARM_EVENT_RE match after this ready_for_review.
      for (let j = i + 1; j < sorted.length; j++) {
        if (!ARM_EVENT_RE.test(sorted[j].event)) continue;
        const armedAt = Date.parse(sorted[j].createdAt);
        const deltaSeconds = (armedAt - readyAt) / 1000;
        if (deltaSeconds >= 0 && deltaSeconds <= SWEEP_WINDOW_SECONDS) {
          const { heldAtArmTime, heldLabels } = heldStateAt(prNumber, sorted, armedAt);
          hits.push({
            prNumber, readyAt: sorted[i].createdAt, armedAt: sorted[j].createdAt, deltaSeconds,
            actor: sorted[j].actor, heldAtArmTime, heldLabels, signatureType: 'arm',
          });
        }
        break; // only the first arm event after this ready_for_review counts
      }

      // Merge-equivalent pairing (t/4131): the first 'merged' event after this ready_for_review,
      // provided no arm event occurs strictly between them.
      for (let j = i + 1; j < sorted.length; j++) {
        if (ARM_EVENT_RE.test(sorted[j].event)) break; // an arm event rules out this pairing
        if (sorted[j].event !== 'merged') continue;
        const mergedAt = Date.parse(sorted[j].createdAt);
        const deltaSeconds = (mergedAt - readyAt) / 1000;
        if (deltaSeconds >= 0 && deltaSeconds <= MERGE_EQUIVALENT_WINDOW_SECONDS) {
          const { heldAtArmTime, heldLabels } = heldStateAt(prNumber, sorted, mergedAt);
          hits.push({
            prNumber, readyAt: sorted[i].createdAt, armedAt: sorted[j].createdAt, deltaSeconds,
            actor: sorted[j].actor, heldAtArmTime, heldLabels, signatureType: 'merge-equivalent',
          });
        }
        break; // only the first merged event after this ready_for_review counts
      }
    }
  }
  return hits;
}

/**
 * PURE. Decides escalation for each sweep-signature hit.
 * - A hit HELD AT ITS OWN ARM TIME (consult-hold/joint-gv) escalates straight to DevOps+TL,
 *   regardless of burst membership -- this is #3142/#3145's exact shape (t/4123): the hold was
 *   cleared minutes later, so a scan-time label read would have missed it entirely (D2).
 * - A BURST is computed ONLY among hits that are NOT held at arm time. Design decision (t/4123
 *   AC, "write down what you decide here"): #3141 (not held) armed 94s before #3142 (held) --
 *   within SWEEP_BURST_SECONDS, but #3141 is the ONLY non-held hit in that window, so it is a
 *   burst of one and does NOT escalate. Coupling a legitimate, non-held, standalone arm to an
 *   unrelated PR's hold-clearing via mere time-proximity would escalate normal fleet activity
 *   every time two unrelated arms land close together; held hits already escalate on their own
 *   reason, so folding them into the burst count would double up, not add signal.
 * - Otherwise (not held, not a burst): one confirmation-request comment, never escalated.
 * @param {Array<{prNumber:number, readyAt:string, armedAt:string, actor:string, heldAtArmTime:boolean|null, heldLabels:string[]}>} hits
 * @returns {Array<{prNumber:number, escalate:boolean, reason:string}>}
 */
export function classifySweepHits(hits) {
  const nonHeld = hits.filter((h) => !h.heldAtArmTime);
  const sortedNonHeld = [...nonHeld].sort((a, b) => Date.parse(a.armedAt) - Date.parse(b.armedAt));
  const burstPrNumbers = new Set();
  for (let i = 0; i < sortedNonHeld.length; i++) {
    for (let j = i + 1; j < sortedNonHeld.length; j++) {
      const deltaSeconds = (Date.parse(sortedNonHeld[j].armedAt) - Date.parse(sortedNonHeld[i].armedAt)) / 1000;
      if (deltaSeconds > SWEEP_BURST_SECONDS) break;
      if (sortedNonHeld[i].prNumber !== sortedNonHeld[j].prNumber) {
        burstPrNumbers.add(sortedNonHeld[i].prNumber);
        burstPrNumbers.add(sortedNonHeld[j].prNumber);
      }
    }
  }

  return hits.map((h) => {
    const verb = h.signatureType === 'merge-equivalent' ? 'merged' : 'armed';
    if (h.heldAtArmTime) {
      return { prNumber: h.prNumber, escalate: true, reason: `held (${h.heldLabels.join(', ')}) at the moment it was ${verb} — escalating to DevOps+TL` };
    }
    if (burstPrNumbers.has(h.prNumber)) {
      return { prNumber: h.prNumber, escalate: true, reason: `sweep burst — ${burstPrNumbers.size} non-held PRs armed/merged within ${SWEEP_BURST_SECONDS}s of each other` };
    }
    return { prNumber: h.prNumber, escalate: false, reason: 'single-PR signature, not held, no burst — asking the owner to confirm' };
  });
}
