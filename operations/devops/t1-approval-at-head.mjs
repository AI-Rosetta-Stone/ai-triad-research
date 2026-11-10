// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// The ONE approval-at-head check for every enqueue path (t/73, Orca t/4820).
//
// WHY A SHARED MODULE: enqueue-pr.mjs (t/4939) refuses to arm a T1 PR unless the latest
// non-skipped `github-actions` `t1-approval-guard` run at the head concluded `success`. The T1
// enqueue sweep (t1-enqueue-sweep.mjs) must apply exactly that check before it selects a PR --
// the TL's condition was "one approval check, no reimplementation". This logic used to be inline
// in enqueue-pr.mjs; it moved here unchanged so both callers import the same code.
// enqueue-pr.mjs re-exports every name below, so its own callers and tests are unaffected.
//
// Split, as everywhere in operations/devops: `fetchGuardRun` is the only impure call (one
// check-runs read); `approvalAtHeadVerdict` / `classifyT1GuardForEnqueue` are pure.

import { execFileSync } from 'node:child_process';

function gh(args, options = {}) {
  return execFileSync('gh', args, { encoding: 'utf8', ...options });
}

/**
 * PURE. Decides whether enqueue-pr.mjs may arm/enqueue a PR, given its declared tier, draft
 * state, and the latest `t1-approval-guard` check run at the head SHA.
 *
 * `guardRun` is `{ status, conclusion, app: { slug } }` or `null`/missing if no such run
 * exists at the head. A run from any app other than `github-actions` is ignored (should-fix
 * 2, Quality t/4939#2) -- treated exactly like a missing run, never a green light.
 *
 * `tierCheckDisagreesOnT0` (should-fix 3, WARN-only arm, Quality t/4939#2): true when the PR
 * declares `Tier: T0` but `tier-check`'s own completed run at the head concluded `failure`.
 * `tier-check`'s verdict isn't trusted enough yet to BLOCK on (t/4939#1), so this never
 * changes `allow` -- it only surfaces a `warn` string for the caller to log, and the
 * blocking version of should-fix 3 is a named follow-up, not done here.
 *
 * Returns `{ allow, reason, warn }`. `reason` is one of: 'draft', 'guard_failure',
 * 'guard_success', 'guard_missing', 'guard_in_progress', 'guard_queued',
 * 'guard_<other-conclusion>', 'tier_exempt'.
 */
export function classifyT1GuardForEnqueue({ tier, isDraft, guardRun, tierCheckDisagreesOnT0 = false }) {
  if (isDraft) return { allow: false, reason: 'draft', warn: null };

  const effRun = guardRun && guardRun.app?.slug === 'github-actions' ? guardRun : null;
  const conclusion = effRun && effRun.status === 'completed' ? effRun.conclusion : null;

  // The guard's own failing verdict blocks regardless of declared tier -- it's the guard
  // speaking for itself, not a tier-gated rule.
  if (conclusion === 'failure') return { allow: false, reason: 'guard_failure', warn: null };

  const knownTier = tier === 'T0' || tier === 'T1' || tier === 'T2';
  // An unparseable tier is fail-closed: treated exactly like a declared T1 (Quality t/4939#2).
  const treatAsT1 = !knownTier || tier === 'T1';

  if (treatAsT1) {
    if (conclusion === 'success') return { allow: true, reason: 'guard_success', warn: null };
    const reason = !effRun
      ? 'guard_missing'
      : effRun.status === 'in_progress'
        ? 'guard_in_progress'
        : effRun.status === 'queued'
          ? 'guard_queued'
          : `guard_${conclusion ?? 'unknown'}`;
    return { allow: false, reason, warn: null };
  }

  // T0 or T2: the guard isn't required here (T0 has no approval rule; T2 is gated by
  // consult-hold elsewhere). should-fix 3's WARN-only arm: flag disagreement, never block.
  const warn = tier === 'T0' && tierCheckDisagreesOnT0
    ? "tier-check's completed run at this head disagrees with the declared Tier: T0 -- review " +
      'manually; enqueue-pr does not block on this signal yet (t/4939 follow-up).'
    : null;
  return { allow: true, reason: 'tier_exempt', warn };
}

/**
 * PURE. The approval-at-head verdict both enqueue paths act on: `fetchGuardRun`'s result fed
 * through `classifyT1GuardForEnqueue`. A failed lookup is its own refusal reason
 * (`guard_lookup_error`) -- never a pass. `guard` is `fetchGuardRun`'s return value
 * (`{ run, lookupError }`); a missing `guard` also counts as a lookup error (fail closed).
 */
export function approvalAtHeadVerdict({ tier, isDraft, guard, tierCheckDisagreesOnT0 = false }) {
  if (!guard || guard.lookupError) return { allow: false, reason: 'guard_lookup_error', warn: null };
  return classifyT1GuardForEnqueue({ tier, isDraft, guardRun: guard.run, tierCheckDisagreesOnT0 });
}

/**
 * PURE. Picks the check-run `fetchGuardRun` should treat as authoritative, from every
 * `github-actions`-app run named `t1-approval-guard` at the head.
 *
 * Live bug (#4694 enqueue refusal, 2026-11-09): ci.yml also has a job named `t1-approval-guard`
 * co-located for the merge_group queue re-check (t/4939#4) -- `if: github.event_name ==
 * 'merge_group'`. On an ordinary `pull_request` run that job's `if:` is false, so it legitimately
 * reports `skipped`, UNDER THE SAME CHECK-RUN NAME as the real PR-side gate
 * (`t1-approval-guard.yml`). Picking "latest by started_at" is a RACE: ci.yml is a large,
 * many-job workflow that often finishes its skip later than the single-job standalone gate
 * finishes its real evaluation, so the meaningless skip can shadow a genuine `success` purely by
 * timing. A `skipped` conclusion carries no information (it never evaluated anything) and must
 * never be allowed to outrank an actual evaluation of the same check name, regardless of which
 * finished later. Prefer the latest NON-skipped run; fall back to the latest skipped run only
 * when nothing else exists (still correctly fail-closed -- the real gate genuinely never ran).
 */
export function pickAuthoritativeGuardRun(runs) {
  if (!runs?.length) return null;
  const sorted = [...runs].sort((a, b) => new Date(b.started_at) - new Date(a.started_at));
  const nonSkipped = sorted.filter((r) => r.conclusion !== 'skipped');
  return nonSkipped.length ? nonSkipped[0] : sorted[0];
}

/**
 * Latest `t1-approval-guard` check run at `headSha` from the `github-actions` App, or `null`
 * on a lookup error (caller refuses on null+error). Filters by `app.slug` BEFORE picking the
 * latest run (Quality should-fix, p/780#25) -- filtering after would let a newer run from a
 * different app hide an older, still-current `github-actions` run.
 */
export function fetchGuardRun(repo, headSha, ghFn = gh) {
  try {
    // t/4939 live bug (Lead, p/648#361): any `-F`/`-f` flag makes `gh api` default to POST,
    // even on a GET-only route -- this 404s without `-X GET`. Confirmed live on #4679's own
    // head: identical request, `-X GET` added, returns total_count: 1.
    const out = JSON.parse(ghFn(['api', '-X', 'GET', `repos/${repo}/commits/${headSha}/check-runs`, '-F', 'check_name=t1-approval-guard']));
    const runs = (out.check_runs ?? []).filter((r) => r.app?.slug === 'github-actions');
    if (!runs.length) return { run: null, lookupError: false };
    return { run: pickAuthoritativeGuardRun(runs), lookupError: false };
  } catch (err) {
    return { run: null, lookupError: true, error: err };
  }
}
