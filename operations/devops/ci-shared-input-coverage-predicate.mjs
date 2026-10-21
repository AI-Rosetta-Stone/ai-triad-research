// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Pure predicate for the advisory CI shared-input coverage check (t/4368, t/4367 parts 2+3).
 *
 * The class: a file read by more than one ci.yml path-filter group ("shared input"), but
 * missing from one of them. A PR that only touches that file skips the under-filtered group's
 * jobs entirely; ci-gate treats a skipped gated job as satisfied (t/2094/t/2025 soundness rule),
 * so main reports green while that stack's tests never ran. #3546 is the trigger incident:
 * tests/fixtures/source-identity-cases.json changed, test-electron was SKIPPED (not in the
 * electron/lib filters), and 8 TS tests were actually failing behind a green PR.
 *
 * `consumerJobs` in the registry (operations/devops/ci-shared-inputs.json) are ci.yml's
 * CHANGES-JOB FILTER-GROUP NAMES (e.g. 'electron', 'lib', 'python') -- the boolean outputs at
 * `needs.changes.outputs.<group>` -- not literal job IDs. Multiple jobs share one group's
 * output, so checking the group boolean is both necessary and sufficient: if the group is
 * 'true', every job gated on it ran; if 'false', they all skipped together.
 *
 * Advisory only (t/4367's own tier note): a match is a warning, never a failure. Promotion to
 * blocking is a separate T2 change, same pattern as tier-check/t1-approval-guard's own rollout.
 */

import { matchAnyGlob } from './cl-path-check-predicate.mjs';

/**
 * @param {{entries: Array<{path: string, consumerJobs: string[]}>}} registry
 * @param {string[]} changedPaths
 * @param {Record<string, string>} filterOutputs e.g. { electron: 'true', lib: 'false', ... }
 *   (ci.yml's `needs.changes.outputs`, string 'true'/'false' as GitHub Actions renders booleans)
 * @returns {{underCovered: Array<{path: string, matchedFile: string, missingGroups: string[]}>}}
 */
export function evaluateCoverage(registry, changedPaths, filterOutputs) {
  const underCovered = [];
  for (const entry of registry?.entries ?? []) {
    const matchedFile = (changedPaths ?? []).find((p) => matchAnyGlob(p, [entry.path]));
    if (!matchedFile) continue;
    const missingGroups = (entry.consumerJobs ?? []).filter((g) => (filterOutputs ?? {})[g] !== 'true');
    if (missingGroups.length > 0) {
      underCovered.push({ path: entry.path, matchedFile, missingGroups });
    }
  }
  return { underCovered };
}

/** Formats the underCovered list as a human-readable PR comment body, or null if clean. */
export function formatCoverageComment(underCovered) {
  if (!underCovered || underCovered.length === 0) return null;
  const lines = [
    '**ci-shared-input-coverage (advisory)**',
    '',
    'A registered shared input changed, but not every job family that reads it ran for this PR:',
    '',
  ];
  for (const hit of underCovered) {
    lines.push(`- \`${hit.matchedFile}\` matches registry entry \`${hit.path}\` — missing from: ${hit.missingGroups.map((g) => `\`${g}\``).join(', ')}`);
  }
  lines.push('', 'This means a job family\'s tests did NOT run against this change. If the registry entry is wrong, fix `operations/devops/ci-shared-inputs.json`; if a path filter is missing the group, fix `.github/workflows/ci.yml`.', '', '_This check is advisory and never blocks a merge. See t/4368._');
  return lines.join('\n');
}

/** Formats the $GITHUB_STEP_SUMMARY table for the shared-input coverage check (always written,
 * clean or not -- distinct from the PR comment, which is clean-is-silent). */
export function formatCoverageSummary(underCovered) {
  const lines = ['### CI shared-input coverage', ''];
  if (!underCovered || underCovered.length === 0) {
    lines.push('All registered shared inputs are covered by every listed filter group for this PR.');
    return lines.join('\n');
  }
  lines.push('| Changed file | Registry path | Missing groups |', '|---|---|---|');
  for (const hit of underCovered) {
    lines.push(`| \`${hit.matchedFile}\` | \`${hit.path}\` | ${hit.missingGroups.join(', ')} |`);
  }
  return lines.join('\n');
}
