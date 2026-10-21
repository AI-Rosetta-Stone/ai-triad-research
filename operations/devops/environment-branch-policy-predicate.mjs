// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4340: every environment that mints an Azure (or other federated) credential must restrict
// which branch/ref can get that token, or the credential's full privilege is available to any
// branch. `production`'s Contributor+User-Access-Administrator credential was available to any
// branch for as long as the repo has existed, and `staging` was the same, until t/4340 fixed
// both. A GitHub environment can be "configured" (custom_branch_policies: true) with an empty
// policy list -- that still restricts nothing, the gap this predicate exists to catch.
//
// TL review (PR #3527): a HAND-KEPT list of credentialed environments reproduces t/4340's own
// failure class -- a check that silently stops covering the thing it was built to cover, the
// moment someone adds a new `environment:` without remembering to update this file's comment.
// So coverage is computed, not maintained: every real environment in the repo, PLUS every
// `environment:` value any workflow file actually references, minus an explicit, commented
// EXEMPT_ENVIRONMENTS opt-out list. An environment on neither list is simply not required (it
// isn't referenced by anything); an environment that IS referenced or exists, and isn't exempt,
// must have a branch policy or this fails -- there is no third, silently-uncovered state.

/** Environments deliberately excluded from the branch-policy requirement. Empty today: every
 * known environment in this repo mints a credential and must be restricted. Add an entry here
 * ONLY with a comment naming why that specific environment needs no restriction. */
export const EXEMPT_ENVIRONMENTS = [];

/**
 * Pure: extract every `environment: <name>` scalar value referenced in a set of workflow file
 * texts. Skips templated values (`environment: ${{ inputs.x }}`), since those can't be resolved
 * statically and are each already a developer error finding of their own (unresolvable at the
 * time deployment_branch_policy would need to check them).
 * @param {{path: string, text: string}[]} workflowFiles
 */
export function workflowEnvironmentNames(workflowFiles) {
  const names = new Set();
  // t/4058 (issue #3333): `\s` matches `\n`, so `environment:\s*` could cross a line boundary
  // when `environment:` is a bare YAML mapping key (nothing after the colon on its own line,
  // e.g. a workflow_dispatch input block) and slurp the NEXT line's content as if it were the
  // value -- it matched deploy-azure.yml's `description: '...'` child line this way. `[ \t]*`
  // (no `\n`) keeps the match confined to the same line, so a bare mapping key correctly yields
  // no match instead of a false positive.
  const re = /^[ \t]*environment:[ \t]*([^\s#][^\n]*)$/gm;
  for (const { text } of workflowFiles ?? []) {
    for (const m of (text ?? '').matchAll(re)) {
      const raw = m[1].trim();
      if (raw.startsWith('${{') || raw.startsWith('{') || raw === '') continue; // unresolvable / mapping form, not a bare name
      names.add(raw);
    }
  }
  return [...names].sort();
}

/**
 * Pure: the set of environments this check must evaluate -- every real repo environment plus
 * every workflow-referenced name, minus the exemption list.
 * @param {string[]} repoEnvironmentNames
 * @param {string[]} workflowReferencedNames
 */
export function requiredEnvironments(repoEnvironmentNames, workflowReferencedNames) {
  const all = new Set([...(repoEnvironmentNames ?? []), ...(workflowReferencedNames ?? [])]);
  for (const exempt of EXEMPT_ENVIRONMENTS) all.delete(exempt);
  return [...all].sort();
}

/**
 * Pure: does one environment's branch-policy configuration actually restrict which ref can get
 * its credential?
 * @param {{name: string, deploymentBranchPolicy: {protected_branches: boolean, custom_branch_policies: boolean} | null, policyCount: number, missing?: boolean}} env
 */
export function evaluateEnvironmentBranchPolicy(env) {
  const name = env?.name ?? '(unnamed)';
  if (env?.missing) {
    return { name, pass: false, reason: 'referenced (by a workflow or the repo environment list) but does not exist, or could not be read -- never read a missing/unreadable environment as clean' };
  }
  const policy = env?.deploymentBranchPolicy;
  if (policy == null) {
    return { name, pass: false, reason: 'deployment_branch_policy is null -- no branch restriction configured at all, any branch can get this credential' };
  }
  const { protected_branches, custom_branch_policies } = policy;
  if (custom_branch_policies && (env.policyCount ?? 0) === 0) {
    return { name, pass: false, reason: 'custom_branch_policies is true but 0 branch/tag policies are configured -- the selected-branches list is empty, so nothing is actually restricted' };
  }
  if (!custom_branch_policies && !protected_branches) {
    return { name, pass: false, reason: 'neither protected_branches nor custom_branch_policies is enabled -- any branch can get this credential' };
  }
  return { name, pass: true, reason: null };
}

/** Pure: evaluate every required environment and collect the gaps. */
export function evaluateAll(envs) {
  const results = (envs ?? []).map(evaluateEnvironmentBranchPolicy);
  const gaps = results.filter((r) => !r.pass);
  return { pass: gaps.length === 0, results, gaps };
}
