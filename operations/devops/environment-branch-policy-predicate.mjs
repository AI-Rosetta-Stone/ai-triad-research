// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4340: every environment that mints an Azure (or other federated) credential must restrict
// which branch/ref can get that token, or the credential's full privilege is available to any
// branch. `production`'s Contributor+User-Access-Administrator credential was available to any
// branch for as long as the repo has existed, and `staging` was the same, until t/4340 fixed
// both. A GitHub environment can be "configured" (custom_branch_policies: true) with an empty
// policy list -- that still restricts nothing, the gap this predicate exists to catch.
//
// Keep CREDENTIALED_ENVIRONMENTS in sync with `grep -rn "environment:" .github/workflows/*.yml`
// when a workflow starts minting a credential against a new environment.
export const CREDENTIALED_ENVIRONMENTS = ['production', 'staging', 'monitoring', 'auth-smoke'];

/**
 * Pure: does one environment's branch-policy configuration actually restrict which ref can get
 * its credential?
 * @param {{name: string, deploymentBranchPolicy: {protected_branches: boolean, custom_branch_policies: boolean} | null, policyCount: number, missing?: boolean}} env
 */
export function evaluateEnvironmentBranchPolicy(env) {
  const name = env?.name ?? '(unnamed)';
  if (env?.missing) {
    return { name, pass: false, reason: 'the environment does not exist in this repo (a credential may still reference it; check for drift)' };
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

/** Pure: evaluate every credentialed environment and collect the gaps. */
export function evaluateAll(envs) {
  const results = (envs ?? []).map(evaluateEnvironmentBranchPolicy);
  const gaps = results.filter((r) => !r.pass);
  return { pass: gaps.length === 0, results, gaps };
}
