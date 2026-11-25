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
  // t/564: the PR budget enqueue-pr.mjs enforces, and the modules its refusal ping loads (all in
  // enqueue-pr.mjs's import closure, so they run inside the wrapper).
  'operations/devops/pr-budget.mjs',
  'operations/devops/pr-budget-notify.mjs',
  'operations/devops/my-prs.mjs',
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
  // t/543: loaded by a workflow-run script (check-code-root-allowlist.mjs), found by the import walk.
  'operations/devops/code-root-allowlist-predicate.mjs',
  // t/543#7: the walker that keeps this list honest. Weakening it would let new drift pass the test
  // unnoticed, so a change to it needs the same second reader.
  'operations/devops/gate-path-walk.mjs',
];

// Every operations/devops script that a required-check workflow runs or loads (ci.yml,
// joint-gv-guard.yml, consult-hold-guard.yml, codeql.yml, t1-approval-guard.yml, tier-check.yml,
// merge-approval.yml).
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
  'operations/devops/merge-approval-run.mjs',
  'operations/devops/merge-approval-verdict.mjs',
  'operations/devops/rate-limit-snapshot-step.yml',
  'operations/devops/rate-limit-snapshot-start-step.yml', // t/563
  'operations/devops/run-merge-guard-tests.sh',
  'operations/devops/run-schema-drift.ts',
  'operations/devops/scheduled-workflows.json',
  'operations/devops/staging-keyvault-whatif-guard.mjs', // t/92: run by staging-keyvault.yml
  // t/92 (SO p/44#102): the template staging-keyvault.yml applies. It grants Key Vault Secrets Officer, so an
  // edit (another principal, another scope) needs the same second reader as the workflow itself.
  'deploy/azure/staging-keyvault.bicep',
  'operations/devops/test-check-merge-queue-liveness-headgreen.sh',
  'operations/devops/test-check-merge-queue-liveness-lookup-failure.sh',
  'operations/devops/test-check-vitest-shard-blobs.sh',
  'operations/devops/test-get-merge-group-prs-ejected.sh',
  'operations/devops/test-get-merge-group-prs-f4.sh',
  'operations/devops/test-get-merge-group-prs-ratelimit.sh',
  'operations/devops/test-verify-deploy-ci.sh', // t/591
  'operations/devops/verify-deploy-ci.sh', // t/591: the prod deploy preflight's CI check (deploy-azure.yml runs it)
  'operations/devops/test-powershell-shard-durations.json',
];

// Directory prefixes that count in full. `.github/ci/` holds data the gates load
// (required-contexts.json, tier-paths.json, the allowlists); `.github/scripts/` the check scripts
// ci.yml runs; `.github/codeql/` the CodeQL query and path config (t/543).
export const GATE_PREFIXES = ['.github/workflows/', '.github/actions/', '.github/ci/', '.github/scripts/', '.github/codeql/'];

// t/543 (agreed boundary, TL + Security, t/543#6): outside operations/devops and .github, protect
// what decides or can change a required-check workflow's verdict WITHOUT product code changing:
// gate, verdict and predicate scripts and what they load, test-selection and exclusion config,
// lint rules and allowlist/threshold config. Not product code, not its tests (CODE_UNDER_TEST).
// Kept current by gate-file-change.test.mjs: a file a workflow names, or a protected script loads,
// that is in neither list fails that test by name.
export const VERDICT_SCRIPTS = [
  // Check scripts the required-check workflows run.
  'scripts/check-quality-gates.sh', // ci.yml quality-gates job: compares counts to quality-gates.json
  'scripts/check-doc-claims.sh', // ci.yml doc-claims step: checks doc-claims.json against the docs
  'scripts/check-agents-md-budget.mjs', // ci.yml AGENTS.md instruction-budget check
  'scripts/run-agents-md-budget-tests.sh', // ci.yml: selects and runs the budget checker's own tests
  'scripts/check-commit-hygiene.sh', // ci.yml commit-hygiene check
  'scripts/validate-schemas.mjs', // ci.yml schema job: validates the taxonomy against its schemas
  'scripts/ci-audit-build-paths.mjs', // ci.yml build-path dependency coverage check
  'scripts/Verify-Config.ps1', // ci.yml verify-config job; its $PesterGates/$VitestGates lists select the gate tests
  'scripts/CalibrationEpochCheck.ps1', // run by Verify-Config.ps1 (warn-only lane)
  'taxonomy-editor/scripts/check-contrast.sh', // ci.yml contrast gate wrapper
  'taxonomy-editor/scripts/check-renderer-tsc.sh', // ci.yml renderer tsc error-ceiling gate
  'lib/brief/schemas/check-version-bump.mjs', // ci.yml schema version-bump check (block mode)
  'lib/embeddings/onnx-equivalence-check.mjs', // ci.yml embedding-onnx-equivalence harness and verdict (required)
  'lib/eslint-rules/generate-complexity-baseline.mjs', // ci.yml complexity-budget drift check (--drift-check)
  'research/comp-linguist/analyses/embedding-drift-gate/check_composition_drift.py', // ci.yml embedding drift gate
  // t/543#7: the PowerShell complexity steps call this cmdlet to compute their verdict. Reached through
  // the AITriad module, so neither walk sees it; listed by hand.
  'scripts/AITriad/Public/Test-ComplexityBudget.ps1',
  // t/543 (Security p/131#48): its `test` block chooses which taxonomy-editor and lib tests the
  // required vitest run executes. Same class as poviewer/vitest.config.ts; read by default name.
  'taxonomy-editor/vite.config.ts',
  // Modules those scripts load (found by the import walk).
  'taxonomy-editor/scripts/check-contrast.mjs', // the contrast checker check-contrast.sh runs
  'taxonomy-editor/scripts/contrast-gate.mjs', // the contrast verdict predicate check-contrast.sh runs
  'lib/schema/checkSchemaDrift.ts', // schema-drift predicate, loaded only by operations/devops/run-schema-drift.ts
  'lib/schema/extractors.ts', // schema-drift field extractors, loaded only by the drift check
  'lib/schema/promptWriterGuard.ts', // schema-drift prompt-writer guard, loaded only by the drift check
  'scripts/AITriad/Private/New-ActionableError.ps1', // dot-sourced by operations/devops/GateVerdict.ps1; shared with the product module
  // ESLint rules the lint jobs and the complexity drift check load.
  'lib/eslint-rules/complexity-budget.js', // complexity ratchet rule
  'lib/eslint-rules/complexity-budget-predicate.js', // complexity ratchet predicate
  'lib/eslint-rules/no-actionable-error-message-nesting.js', // lint rule
  'lib/eslint-rules/no-bare-throw.js', // lint rule
  'lib/eslint-rules/require-flight-recorder-in-catch.js', // lint rule
  'lib/eslint-rules/require-warn-on-degraded-catch-return.js', // lint rule
  'lib/eslint-rules/require-windows-hide.js', // lint rule
  'lib/eslint-rules/require-windows-hide-disable-reason.js', // lint rule
  'taxonomy-editor/eslint-rules/no-data-root-write.js', // lint rule
  'taxonomy-editor/eslint-rules/no-inline-style.js', // lint rule
  'taxonomy-editor/eslint-rules/no-raw-data-root-read.js', // lint rule
  'taxonomy-editor/eslint-rules/no-unmanaged-module-resources.js', // lint rule
  // Lint baselines (per-file allowlists). Read by path string from the ESLint configs and the
  // PowerShell complexity steps, so the import walk does not see them; listed by hand.
  'lib/eslint-rules/complexity-baseline.json', // taxonomy-editor complexity-budget baseline
  'lib/eslint-rules/lib-complexity-baseline.json', // lib complexity-budget baseline
  'lib/eslint-rules/bare-throw-baseline.json', // no-bare-throw baseline (lib and taxonomy-editor)
  'poviewer/complexity-baseline.json', // poviewer complexity-budget baseline
  'summary-viewer/complexity-baseline.json', // summary-viewer complexity-budget baseline
  'workflow-app/complexity-baseline.json', // workflow-app complexity-budget baseline
  'scripts/complexity-baseline.json', // PowerShell complexity budget baseline, scripts/ (warn-first)
  'operations/complexity-baseline.json', // PowerShell complexity budget baseline, operations/ (warn-first)
  // Threshold and allowlist data those scripts read. The import walk does not follow data reads,
  // so these are listed by hand.
  'quality-gates.json', // ceilings for check-quality-gates.sh, check-renderer-tsc.sh and check-contrast.sh
  'doc-claims.json', // the claims check-doc-claims.sh verifies
  'docs/agent-instruction-budgets.json', // the budgets check-agents-md-budget.mjs enforces
  // Lint and test-selection config that `pnpm run lint`, `pnpm run test` and vitest read by default
  // name. No workflow names them, so neither walk can see them; listed by hand.
  'lib/eslint.config.mjs', // ci.yml lib-lint (pnpm run lint in lib/)
  'poviewer/eslint.config.mjs', // ci.yml lint matrix (matrix.app)
  'summary-viewer/eslint.config.mjs', // ci.yml lint matrix (matrix.app)
  'taxonomy-editor/eslint.config.mjs', // ci.yml lint matrix (matrix.app)
  'workflow-app/eslint.config.mjs', // ci.yml lint matrix (matrix.app)
  'poviewer/vitest.config.ts', // test include/exclude for the poviewer vitest run
  'summary-viewer/vitest.config.ts', // test include/exclude for the summary-viewer vitest run
  'workflow-app/vitest.config.mts', // test include/exclude for the workflow-app vitest run
];

// t/543: repo files the required-check workflows name, or protected scripts load, that are product
// code, product config or tests of it. Deliberately NOT protected: a PR that changes them is
// checked by the gates, it does not change what the gates decide. Listed so the test can tell
// "deliberately unprotected" from "forgotten". "Lead decision" marks a borderline call made deliberately (t/543#7); each is a stated limit.
export const CODE_UNDER_TEST = [
  // Product config and data named in ci.yml path filters (what a change triggers) or read by checks.
  '.aitriad.json', // product data-root config; schema/container filters
  '.dockerignore', // container build context; container filter
  '.npmrc', // package manager config; container filter
  'ai-models.json', // product model registry; the subject of the config gates
  'ai-usages.json', // product usage registry; debate/container filters
  'CHANGELOG.md', // product doc copied into the image; container filter
  'AGENTS.md', // instruction doc; the subject of the AGENTS.md budget check, linked in guard messages
  'REPO_MAP.md', // generated doc; the subject of the warn-only REPO_MAP drift step
  'docs/agent-pr-approval.md', // doc linked from tier-check's PR comment text
  'docs/lessons/INDEX.md', // generated doc; the subject of the lessons-index freshness step
  'research/comp-linguist/docs/metric-provenance-register.md', // doc read by CalibrationEpochCheck (warn-only)
  'taxonomy-snapshot/snapshot-meta.json', // overwritten by a stub in ci.yml before the container build
  'lib/debate/soul-docs/pov-tags.json', // product registry; the subject of the pov-tags scan step
  'Dockerfile', // dev image; Trivy scan subject
  'taxonomy-editor/Dockerfile', // prod image; container build and Trivy scan subject
  'deploy/azure/Dockerfile.base', // base image; container build and Trivy scan subject
  'deploy/azure/main.bicep', // infra; the subject of the bicep checks
  'pnpm-lock.yaml', // dependency lockfile; electron/lib/container filters
  'pnpm-workspace.yaml', // workspace and overrides; the subject of the lockfile-overrides check
  'taxonomy-editor/pnpm-lock.yaml', // dependency lockfile; the subject of the lockfile-overrides check
  'scripts/requirements.txt', // python dependencies of product scripts
  'scripts/embed_model_pins.json', // product embedding model pins
  'scripts/embed_model_pins.py', // product embedding model loader
  'scripts/embed_taxonomy.py', // product embedding script; imported by check_composition_drift.py
  'package.json', // Lead decision (t/543#7): unprotected; its scripts block decides what `pnpm run lint/test` runs (test selection), but it is also the product dependency manifest
  'taxonomy-editor/package.json', // Lead decision (t/543#7): unprotected; as package.json (scripts block decides what lint/test runs; also product dependencies)
  'lib/debate/tsconfig.json', // Lead decision (t/543#7): unprotected; compiler config for the lib/debate tsc check; strictness or include can change the verdict, but it is also product build config
  // Product code named in ci.yml (filters, or run as the thing under test).
  'build/AITriad/AITriad.psd1', // module build output, checked by Test-ModuleManifest
  'scripts/Build-Module.ps1', // product module build
  'scripts/AITriad/AITriad.psd1', // product PowerShell module manifest
  'scripts/AITriad/AITriad.psm1', // product PowerShell module; imported by Test-CitationLinkIntegrityFixtureCI.ps1 to run the cmdlet under test
  'scripts/AITriad/Public/Test-CitationLinkIntegrity.ps1', // product cmdlet; citation-link-ci filter
  'scripts/AITriad/Public/Build-NodeSourceIndex.ps1', // product cmdlet; citation-link-ci filter
  'scripts/AITriad/Private/Get-SummariesInputHash.ps1', // product helper; citation-link-ci filter
  'scripts/AITriad/Private/Compare-NodeSourceIndexKeySet.ps1', // product helper; citation-link-ci filter
  'scripts/AITriad/Private/Get-NodeSourceIndexLink.ps1', // product helper; citation-link-ci filter
  'lib/ai-client/cache-pricing-cli.ts', // product CLI; verify-config filter (warn-only lane)
  'lib/ai-client/registry.ts', // product model registry code; verify-config filter
  'lib/debate/schemas.ts', // product Zod schemas; the subject of the schema-drift check
  'lib/debate/cli.ts', // product debate CLI, run for the golden evals
  'lib/schema/pov-tags-cli.ts', // Lead decision (t/543#7): unprotected; product CLI run in --scan-data mode as the pov-tags check; the product code path, not a separate gate
  'evals/run.mjs', // structural evals of product output (continue-on-error)
  'taxonomy-editor/src/server/briefExportJobs.ts', // product server code; powershell filter
  'taxonomy-editor/src/renderer/hooks/useDebateStore/shared/modelConfig.ts', // product code; debate filter
  'research/comp-linguist/scripts/reconcile_grounding.py', // product reconciler, run with its own --selftest
  'deploy/azure/smoke-healthz.sh', // readiness smoke test of the product image
  'scripts/build-lessons-index.mjs', // doc generator; its output is diffed by a warn-only step
  // Tests of product code (named in the verify-config filter or run directly).
  'scripts/build-lessons-index.test.mjs', // test of the lessons-index generator
  'taxonomy-editor/scripts/check-contrast.test.mjs', // self-test of check-contrast.mjs (the checker is protected)
  'tests/FlakeVerdict.Tests.ps1', // test of operations/devops/FlakeVerdict.ps1
  'tests/OutletKeySetVerdict.Tests.ps1', // test of operations/devops/OutletKeySetVerdict.ps1 on synthetic fixtures
  'tests/Test-AIModelsConfig.Tests.ps1', // Lead decision (t/543#7): unprotected; Pester test of ai-models.json, also a Verify-Config gate over committed config
  'tests/ModelLiteralLint.Tests.ps1', // Lead decision (t/543#7): unprotected; Pester lint over product source (model-id literals); a lint written as a test
  'tests/OutletsKeySetGate.Tests.ps1', // Lead decision (t/543#7): unprotected; Pester parity gate over real repo files; a gate written as a test
  'tests/AIBackendProfiles.Completeness.Tests.ps1', // Lead decision (t/543#7): unprotected; Pester completeness gate over product config; a gate written as a test
  'lib/ai-config/modelLiteralLint.test.ts', // Lead decision (t/543#7): unprotected; vitest lint over product source (model-id literals); a lint written as a test
  'lib/ai-config/modelLiteralLint.conformance.test.ts', // Lead decision (t/543#7): unprotected; conformance corpus test shared with the PS lint
  'lib/oped/__tests__/outletsKeySetGate.test.ts', // Lead decision (t/543#7): unprotected; vitest parity gate over real repo files; a gate written as a test
  'lib/debate/__tests__/configInvariant.test.ts', // test of product config invariants
  'lib/electron-shared/modelDiscovery.test.ts', // test of product model discovery
  'taxonomy-editor/src/server/__tests__/keysValidation.test.ts', // test of product key validation
  'taxonomy-editor/src/main/__tests__/modelConfigCache.test.ts', // test of product model config cache
  'taxonomy-editor/src/renderer/hooks/useTaxonomyStore/slices/__tests__/registryCompleteness.test.ts', // test of product registry
  // Unit tests of operations/devops gate scripts. The scripts are protected; their tests are reviewed as code.
  'operations/devops/actions-cache-budget.test.mjs', // test of actions-cache-budget.mjs
  'operations/devops/record-base-ref-retry.test.mjs', // t/238: unit test of the record-base-ref retry; reviewed as code
  'operations/devops/cancel-superseded-runs.test.mjs', // test of cancel-superseded-runs
  'operations/devops/check-action-pin-resolution.test.mjs', // test of check-action-pin-resolution.mjs
  'operations/devops/check-dockerfile-store-mounts.test.mjs', // test of check-dockerfile-store-mounts.mjs
  'operations/devops/ci-filter-coverage.test.mjs', // drift test of ci.yml's changes filters (ci.yml is protected)
  'operations/devops/ci-merge-group-scope.test.mjs', // test of ci-merge-group-scope.sh
  'operations/devops/ci-shared-input-coverage-workflow.test.mjs', // test of a ci.yml step script (ci.yml is protected)
  'operations/devops/code-root-allowlist-predicate.test.mjs', // test of check-code-root-allowlist
  'operations/devops/collect-flake-heal-runs.test.mjs', // test of collect-flake-heal-runs
  'operations/devops/comment-filter-workflow.test.mjs', // test of the guard workflows' comment filters
  'operations/devops/dependabot-docker-gate.test.mjs', // test of dependabot-docker-gate.mjs
  'operations/devops/dependabot-enqueue-sweep.test.mjs', // test of dependabot-enqueue-sweep.mjs
  'operations/devops/docker/base-pin-cves.test.mjs', // test of base-pin-cves.mjs, the drift issue-vs-PR routing (t/605)
  'operations/devops/docker/base-pin-drift.test.mjs', // test of base-pin-drift.mjs, the runtime pin drift check (t/255)
  'operations/devops/docker/docker-digest-only.test.mjs', // test of the Docker digest pinning rule
  'operations/devops/ejected-batch.test.mjs', // test of ejected-batch.mjs
  'operations/devops/enqueue-pr.test.mjs', // test of enqueue-pr.mjs
  'operations/devops/flake-heal-tripwire.test.mjs', // test of flake-heal-tripwire.mjs
  'operations/devops/gate-verdict.test.mjs', // test of gate-verdict.mjs
  'operations/devops/gh-budget.test.mjs', // test of gh-budget
  'operations/devops/github-retry-workflow.test.mjs', // test of github-retry wiring in workflows
  'operations/devops/github-retry.test.mjs', // test of github-retry.mjs
  'operations/devops/guard-pr-read.test.mjs', // test of guard-pr-read.sh
  'operations/devops/live-pr-state.test.mjs', // test of live-pr-state.mjs
  'operations/devops/my-prs.test.mjs', // test of my-prs
  'operations/devops/pr-contexts.test.mjs', // test of pr-contexts.mjs
  'operations/devops/pr-triage-activity.test.mjs', // test of pr-triage-activity
  'operations/devops/pr-volume-metric.test.mjs', // test of pr-volume-metric
  'operations/devops/precommit-hint-guard-parity.test.mjs', // parity test of the pre-commit hint and the worktree guard
  'operations/devops/rate-limit-snapshot-step.test.mjs', // test of rate-limit-snapshot-step.yml
  'operations/devops/role-review-verdicts.test.mjs', // test of role-review-verdicts.mjs
  'operations/devops/scheduled-workflow-health.test.mjs', // test of scheduled-workflow-health.mjs
  'operations/devops/staging-keyvault-whatif-guard.test.mjs', // test of staging-keyvault-whatif-guard (t/92)
  'operations/devops/stuck-pr-classifier.test.mjs', // test of stuck-pr-classifier
  'operations/devops/t0-enqueue-sweep.test.mjs', // test of t0-enqueue-sweep.mjs
  'operations/devops/t0-rule-order.test.mjs', // rule-order test of t0-enqueue-sweep.mjs
  'operations/devops/t1-approval-guard-predicate.test.mjs', // test of t1-approval-guard-predicate.mjs
  'operations/devops/t1-approval-guard-workflow.test.mjs', // test of t1-approval-guard.yml wiring
  'operations/devops/t1-enqueue-sweep.test.mjs', // test of t1-enqueue-sweep.mjs
  'operations/devops/tier-check-predicate.test.mjs', // test of tier-check-predicate.mjs
  'operations/devops/tier-check-workflow.test.mjs', // test of tier-check.yml wiring
];

// GitHub's "list pull request files" returns at most this many files. At or above it the list
// may be cut short, so it is treated as unreadable.
export const PR_FILES_API_CAP = 3000;

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** PURE. True when a repo-relative path is a workflow, a composite action, gate data or a script under .github, or a gate or verdict script. */
export function isGateFile(path) {
  if (typeof path !== 'string' || !path) return false;
  const p = path.replace(/\\/g, '/').replace(/^\.\//, '');
  return GATE_PREFIXES.some((pre) => p.startsWith(pre)) || GATE_SCRIPTS.includes(p) || WORKFLOW_RUN_SCRIPTS.includes(p) ||
    VERDICT_SCRIPTS.includes(p);
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
  // lint:review-state-ok: one review named by id (--gate-change-review), bound to the head; its role comes from the body
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
