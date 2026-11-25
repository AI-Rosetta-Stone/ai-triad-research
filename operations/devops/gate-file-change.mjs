// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/537 (hardening, TL p/9#479): a PR that changes a workflow or one of the scripts the merge
// gates run is not enqueued on the strength of its own checks. It needs a second reader: a
// reviewer-App `Approved (Tech Lead):` or `Approved (Security):` review bound to the PR's current
// head, named explicitly on the command line. Applies to EVERY tier.
//
// This runs inside enqueue-pr.mjs, so the manual enqueue and every sweep get it. It reads the
// change list and the review from the GitHub API, never from a checkout of the PR. Anything it
// cannot read is a refusal (fail closed).
//
//   node operations/devops/enqueue-pr.mjs <owner>/<repo> <N> --gate-change-review=<review id> --by=<who>

import { execFileSync } from 'node:child_process';

/** The reviewer App's login as the REST API reports it on a review. */
export const REVIEWER_APP_REST_LOGIN = 'ai-triad-reviewer-jpsnover[bot]';

/** Roles whose approval may release a gate-file change. */
export const GATE_CHANGE_APPROVER_ROLES = ['Tech Lead', 'Security'];

/** Scripts the merge gates load or that decide an enqueue. Paths are repo-relative. */
export const GATE_SCRIPTS = [
  'operations/devops/enqueue-pr.mjs',
  'operations/devops/gate-file-change.mjs',
  'operations/devops/running-copy-current.mjs', // t/556: enqueue-pr.mjs's origin/main currency check
  'operations/devops/t1-approval-at-head.mjs',
  'operations/devops/t1-approval-guard-predicate.mjs',
  'operations/devops/t1-approval-guard-merge-group-predicate.mjs',
  'operations/devops/role-review-verdicts.mjs',
  'operations/devops/github-retry.mjs',
  'operations/devops/tier-check-predicate.mjs',
  // The sweeps that decide enqueues, and the modules their decisions read. A sweep run by hand
  // from a PR branch uses that branch's copy (Security, t/537).
  'operations/devops/t0-enqueue-sweep.mjs',
  'operations/devops/t1-enqueue-sweep.mjs',
  'operations/devops/dependabot-enqueue-sweep.mjs',
  'operations/devops/infra-rearm-sweep.mjs',
  'operations/devops/live-pr-state.mjs',
  'operations/devops/pr-contexts.mjs',
  'operations/devops/ejected-batch.mjs',
  'operations/devops/design-review-scope.mjs',
  'operations/devops/docker/repin-tier.mjs',
];

// Every operations/devops script that a required-check workflow runs or loads (ci.yml,
// joint-gv-guard.yml, consult-hold-guard.yml, codeql.yml, t1-approval-guard.yml, tier-check.yml).
// A PR that edits one of these changes what its own required check runs. Kept current by
// gate-file-change.test.mjs, which walks those workflows and fails on a script missing here.
export const WORKFLOW_RUN_SCRIPTS = [
  'operations/devops/AgentAppToken.psm1',
  'operations/devops/DataRepoHooksVerdict.ps1',
  'operations/devops/FlakeVerdict.ps1',
  'operations/devops/GateVerdict.ps1',
  'operations/devops/Get-BicepBaseEnv.ps1',
  'operations/devops/Get-PesterExcludePaths.ps1',
  'operations/devops/Get-TestPowerShellAbnormalEndVerdict.ps1',
  'operations/devops/ShardBalancer.ps1',
  'operations/devops/Test-BicepAcaResourcePairs.ps1',
  'operations/devops/Test-BicepEnvDrift.ps1',
  'operations/devops/Test-CitationLinkIntegrityFixtureCI.ps1',
  'operations/devops/Test-ContainerVarIsolation.ps1',
  'operations/devops/Test-EnvBicepWiring.ps1',
  'operations/devops/Test-InMemoryJobStoreScaleGuard.ps1',
  'operations/devops/azure/Test-BicepExpressionLength.ps1',
  'operations/devops/check-action-pin-resolution.mjs',
  'operations/devops/check-code-root-allowlist.mjs',
  'operations/devops/check-dockerfile-store-mounts.mjs',
  'operations/devops/check-merge-queue-liveness.sh',
  'operations/devops/check-vitest-shard-blobs.sh',
  'operations/devops/ci-merge-group-scope.sh',
  'operations/devops/ci-shared-input-coverage-predicate.mjs',
  'operations/devops/ci-shared-inputs.json',
  'operations/devops/cl-path-check-predicate.mjs',
  'operations/devops/create-coldstore-builder.sh',
  'operations/devops/css-brace-check.mjs',
  'operations/devops/env-var-allowlist.json',
  'operations/devops/gate-verdict.mjs',
  'operations/devops/get-merge-group-prs.sh',
  'operations/devops/guard-pr-read.sh',
  'operations/devops/rate-limit-snapshot-step.yml',
  'operations/devops/run-merge-guard-tests.sh',
  'operations/devops/scheduled-workflows.json',
  'operations/devops/test-check-merge-queue-liveness-headgreen.sh',
  'operations/devops/test-check-merge-queue-liveness-lookup-failure.sh',
  'operations/devops/test-check-vitest-shard-blobs.sh',
  'operations/devops/test-get-merge-group-prs-ejected.sh',
  'operations/devops/test-get-merge-group-prs-f4.sh',
  'operations/devops/test-powershell-shard-durations.json',
];

// Directory prefixes that count in full. `.github/ci/` holds data the gates load
// (required-contexts.json, tier-paths.json, the allowlists).
export const GATE_PREFIXES = ['.github/workflows/', '.github/actions/', '.github/ci/'];

// GitHub's "list pull request files" returns at most this many files. At or above it the list
// may be cut short, so it is treated as unreadable.
export const PR_FILES_API_CAP = 3000;

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** PURE. True when a repo-relative path is a workflow, a composite action, gate data under .github/ci, or a gate script. */
export function isGateFile(path) {
  if (typeof path !== 'string' || !path) return false;
  const p = path.replace(/\\/g, '/').replace(/^\.\//, '');
  return GATE_PREFIXES.some((pre) => p.startsWith(pre)) || GATE_SCRIPTS.includes(p) || WORKFLOW_RUN_SCRIPTS.includes(p);
}

/**
 * PURE. Decides from what the shims read.
 *   files:    { paths: string[] | null, expectedCount: number | null }   (null paths = unreadable)
 *   override: null (no flag given) or { review: object | null }          (null review = unreadable)
 * Returns { allow, reason, gateFiles, detail }:
 *   'no_gate_files'            allow  -- nothing to do
 *   'files_unreadable'         refuse -- the change list could not be read, or may be cut short
 *   'gate_files_no_override'   refuse -- gate files changed and no review was named
 *   'override_unreadable'      refuse -- the named review could not be read
 *   'override_invalid'         refuse -- the named review does not qualify (detail says why)
 *   'gate_files_overridden'    allow  -- a qualifying review at this head was named
 */
export function gateFileChangeVerdict({ files, headSha, override, reviewerLogin = REVIEWER_APP_REST_LOGIN }) {
  const paths = files?.paths;
  if (!Array.isArray(paths)) return { allow: false, reason: 'files_unreadable', gateFiles: [], detail: 'the list of changed files could not be read' };
  if (paths.length >= PR_FILES_API_CAP) {
    return { allow: false, reason: 'files_unreadable', gateFiles: [], detail: `the PR changes ${paths.length} or more files, more than the API lists` };
  }
  if (!Number.isInteger(files.expectedCount) || files.expectedCount !== files.listedCount) {
    return { allow: false, reason: 'files_unreadable', gateFiles: [], detail: `the API listed ${files.listedCount} changed file(s) but the PR reports ${files.expectedCount}` };
  }
  const gateFiles = [...new Set(paths.filter(isGateFile))].sort();
  if (gateFiles.length === 0) return { allow: true, reason: 'no_gate_files', gateFiles, detail: null };
  if (!override) return { allow: false, reason: 'gate_files_no_override', gateFiles, detail: null };
  const r = override.review;
  if (!r || typeof r !== 'object') return { allow: false, reason: 'override_unreadable', gateFiles, detail: 'the named review could not be read' };
  const why = [];
  if (r.user?.login !== reviewerLogin) why.push(`it is from ${r.user?.login ?? 'an unknown account'}, not the reviewer App`);
  if (r.state !== 'APPROVED') why.push(`its state is ${r.state ?? 'unknown'}, not APPROVED`);
  if (!headSha || r.commit_id !== headSha) why.push(`it is bound to ${String(r.commit_id).slice(0, 9)}, not the current head ${String(headSha).slice(0, 9)}`);
  const role = /^Approved \(([^)]+)\):/.exec(String(r.body ?? '').trimStart())?.[1] ?? null;
  if (!GATE_CHANGE_APPROVER_ROLES.includes(role)) {
    why.push(`its body does not start with "Approved (${GATE_CHANGE_APPROVER_ROLES.join(')" or "Approved (')}):"`);
  }
  if (why.length) return { allow: false, reason: 'override_invalid', gateFiles, detail: why.join('; ') };
  return { allow: true, reason: 'gate_files_overridden', gateFiles, detail: `review ${r.id} by ${role}`, role };
}

/**
 * Reads the PR's changed files from the GitHub API (both names of a rename), with the PR's own
 * count for a completeness check. Never throws: a failure returns { paths: null }.
 */
export function fetchChangedFiles(repo, prNumber, ghFn = gh) {
  try {
    const expectedCount = JSON.parse(ghFn(['api', `repos/${repo}/pulls/${prNumber}`, '--jq', '{changed_files}'])).changed_files;
    const out = ghFn(['api', '--paginate', `repos/${repo}/pulls/${prNumber}/files?per_page=100`, '--jq', '.[] | [.filename, (.previous_filename // "")] | @json']);
    const rows = out.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    const paths = rows.flatMap(([name, prev]) => (prev ? [name, prev] : [name]));
    return { paths, listedCount: rows.length, expectedCount, error: null };
  } catch (err) {
    return { paths: null, listedCount: null, expectedCount: null, error: err };
  }
}

/** Reads one review by id from the GitHub API. Never throws: a failure returns { review: null }. */
export function fetchReview(repo, prNumber, reviewId, ghFn = gh) {
  if (!/^[1-9]\d{0,18}$/.test(String(reviewId))) return { review: null, error: new Error('the review id is not a number') };
  try {
    return { review: JSON.parse(ghFn(['api', `repos/${repo}/pulls/${prNumber}/reviews/${reviewId}`])), error: null };
  } catch (err) {
    return { review: null, error: err };
  }
}

/** PURE. The refusal text for a verdict that does not allow (Goal / Problem / Location / Next steps). */
export function gateFileRefusalMessage({ repo, prNumber, headSha, verdict }) {
  const shown = verdict.gateFiles.slice(0, 8).join(', ') + (verdict.gateFiles.length > 8 ? `, and ${verdict.gateFiles.length - 8} more` : '');
  const problem = {
    files_unreadable: `cannot tell whether this PR changes a workflow or a gate script: ${verdict.detail}.`,
    gate_files_no_override: `this PR changes workflow or gate-script files (${shown}), which need a second reader before they land.`,
    override_unreadable: `this PR changes workflow or gate-script files (${shown}), and ${verdict.detail}.`,
    override_invalid: `this PR changes workflow or gate-script files (${shown}), and the named review does not release it: ${verdict.detail}.`,
  }[verdict.reason];
  return `enqueue-pr: refusing to arm/enqueue #${prNumber} on ${repo} (${verdict.reason}).\n` +
    `  Goal:       land #${prNumber} via the merge queue.\n` +
    `  Problem:    ${problem}\n` +
    '  Location:   operations/devops/gate-file-change.mjs (gateFileChangeVerdict, t/537).\n' +
    `  Next steps: ask the Tech Lead or Security to review the workflow diff and approve through the reviewer App at ${String(headSha).slice(0, 9)} ` +
    'with a body starting "Approved (Tech Lead):" or "Approved (Security):", then rerun with ' +
    '--gate-change-review=<that review\'s id> --by=<your collaborator id>.';
}
