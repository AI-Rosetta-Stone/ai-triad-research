// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Pure predicate for the weekly future-clock vitest job (t/4279, t/4268 Q3b). A fixture dated
 * 2026-07-20 aged past a 90-day window on 2026-10-18, and nothing caught it before the date
 * passed -- the first signal was a scheduled run that looked like one more flake. This diffs a
 * future-clock (+N days) vitest run against the same-week real-clock run, so only genuinely NEW
 * failures are reported -- a test already broken for unrelated reasons is not noise here.
 */

/**
 * @param {object | null} vitestJsonReport parsed `vitest run --reporter=json` output, or null
 *   when the run produced no report at all (crash/OOM before any output was written).
 * @returns {Set<string>} the `fullName` of every assertion whose status is 'failed'.
 */
export function collectFailedFullNames(vitestJsonReport) {
  const out = new Set();
  if (!vitestJsonReport || !Array.isArray(vitestJsonReport.testResults)) return out;
  for (const fileResult of vitestJsonReport.testResults) {
    for (const assertion of fileResult.assertionResults ?? []) {
      if (assertion.status === 'failed' && typeof assertion.fullName === 'string') {
        out.add(assertion.fullName);
      }
    }
  }
  return out;
}

/**
 * @param {Set<string>} baselineFailed real-clock failures.
 * @param {Set<string>} futureFailed future-clock failures.
 * @param {Array<{fullName: string, reason: string}>} knownHarnessArtifacts confirmed-not-a-real-
 *   clock-dependency exclusions, each with its own reason (t/4279 AC: a harness artifact is
 *   excluded WITH the reason, not silently dropped).
 * @returns {{ newFailures: string[], excludedArtifacts: Array<{fullName: string, reason: string}> }}
 *   newFailures is sorted; excludedArtifacts is the subset of knownHarnessArtifacts that would
 *   otherwise have shown up as new (so a stale exclusion entry that no longer matches anything
 *   is visible by its absence here, not silently assumed to still apply).
 */
export function diffNewFailures(baselineFailed, futureFailed, knownHarnessArtifacts = []) {
  const excludedNames = new Map(knownHarnessArtifacts.map((e) => [e.fullName, e.reason]));
  const newFailures = [];
  const excludedArtifacts = [];
  for (const name of futureFailed) {
    if (baselineFailed.has(name)) continue; // already failing for an unrelated reason -- not new
    if (excludedNames.has(name)) {
      excludedArtifacts.push({ fullName: name, reason: excludedNames.get(name) });
      continue;
    }
    newFailures.push(name);
  }
  newFailures.sort();
  excludedArtifacts.sort((a, b) => a.fullName.localeCompare(b.fullName));
  return { newFailures, excludedArtifacts };
}

/**
 * @param {{ newFailures: string[], excludedArtifacts: Array<{fullName: string, reason: string}> }} diff
 * @param {{ baselineCrashed: boolean, futureCrashed: boolean }} runHealth whether either leg
 *   produced no report at all -- this must be visible, not silently read as "0 new failures".
 * @returns {string} Markdown for $GITHUB_STEP_SUMMARY.
 */
export function formatSummary(diff, runHealth) {
  const lines = ['## Future-clock weekly check (t/4279)', ''];

  if (runHealth.baselineCrashed || runHealth.futureCrashed) {
    const which = [
      runHealth.baselineCrashed ? 'the real-clock baseline' : null,
      runHealth.futureCrashed ? 'the future-clock (+365d)' : null,
    ].filter(Boolean).join(' and ');
    lines.push(`:warning: **WARN: ${which} run produced no report** (crash/OOM before vitest wrote output) — this result is NOT evaluable; re-run or investigate before trusting a clean diff.`, '');
  }

  if (diff.newFailures.length === 0) {
    lines.push('No new failures under the future clock. :white_check_mark:');
  } else {
    lines.push(`**${diff.newFailures.length} new failure(s) under the future clock** (passed at real-clock, fail at +365d):`, '');
    for (const name of diff.newFailures) lines.push(`- \`${name}\``);
  }

  if (diff.excludedArtifacts.length > 0) {
    lines.push('', `<details><summary>${diff.excludedArtifacts.length} known harness artifact(s) excluded from the above</summary>`, '');
    for (const e of diff.excludedArtifacts) lines.push(`- \`${e.fullName}\` — ${e.reason}`);
    lines.push('', '</details>');
  }

  return lines.join('\n') + '\n';
}
