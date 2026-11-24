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
 * t/4958 (Tech Lead review of #5285): environments KNOWN to mint no credential. Only these may be
 * downgraded to informational when they have no branch policy, and only while they also hold 0
 * secrets and 0 variables. "0 secrets and 0 variables" alone is NOT evidence of no credential:
 * cloud OIDC trust (an Azure federated credential with subject
 * `repo:<owner>/<repo>:environment:<name>`) is keyed on the environment's NAME, and the client id
 * can live in repo-level variables. `production` and `staging` here are exactly that shape (0/0,
 * trusted by the deploy app). Every entry needs a comment saying why it is safe and how that was
 * checked; an environment that cannot be shown credential-less stays off this list and keeps
 * failing.
 */
export const CREDENTIAL_LESS_ENVIRONMENTS = new Map([
  // Created by GitHub's Copilot coding agent for its own runs; no workflow here deploys with it.
  // Checked 2026-11-24 (t/4958): 0 secrets, 0 variables, no branch policy; no Azure federated
  // credential in the tenant names `environment:copilot` (all 8 app registrations scanned; this
  // repo's subjects are only staging, production and monitoring; 0 user-assigned managed
  // identities). Limit: other clouds and package-registry trusted publishing were not checked,
  // and this repo publishes to neither. Re-check before adding OIDC trust for this name.
  ['copilot', 'GitHub Copilot coding agent environment; no OIDC trust or secret (checked 2026-11-24, t/4958)'],
]);

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
 *
 * t/4958: a policy-less environment is reported as informational, not a failing gap, ONLY when
 * it is on CREDENTIAL_LESS_ENVIRONMENTS AND holds 0 secrets AND 0 variables (e.g. `copilot`, the
 * environment GitHub's Copilot coding agent creates). 0/0 alone fails: OIDC trust is keyed on the
 * environment name, so a 0/0 environment can still mint a cloud credential (Tech Lead, #5285).
 * Fail CLOSED whenever the counts aren't both known integers: an unreadable or unprovided count
 * is never read as "credential-less" (same discipline as the existing `missing` arm).
 * @param {{name: string, deploymentBranchPolicy: {protected_branches: boolean, custom_branch_policies: boolean} | null, policyCount: number, missing?: boolean, secretsCount?: number, variablesCount?: number, countsError?: string}} env
 */
export function evaluateEnvironmentBranchPolicy(env) {
  const name = env?.name ?? '(unnamed)';
  if (env?.missing) {
    return { name, pass: false, reason: 'referenced (by a workflow or the repo environment list) but does not exist, or could not be read -- never read a missing/unreadable environment as clean' };
  }
  const policy = env?.deploymentBranchPolicy;
  let noPolicyReason = null;
  if (policy == null) {
    noPolicyReason = 'deployment_branch_policy is null -- no branch restriction configured at all';
  } else {
    const { protected_branches, custom_branch_policies } = policy;
    if (custom_branch_policies && (env.policyCount ?? 0) === 0) {
      noPolicyReason = 'custom_branch_policies is true but 0 branch/tag policies are configured -- the selected-branches list is empty';
    } else if (!custom_branch_policies && !protected_branches) {
      noPolicyReason = 'neither protected_branches nor custom_branch_policies is enabled';
    }
  }
  if (noPolicyReason == null) {
    return { name, pass: true, reason: null };
  }

  if (env?.countsError) {
    return { name, pass: false, reason: `${noPolicyReason}, and this environment's secret/variable counts could not be read (${env.countsError}) -- fail closed, never read an unreadable count as credential-less` };
  }
  const { secretsCount, variablesCount } = env ?? {};
  const countsKnown = Number.isInteger(secretsCount) && Number.isInteger(variablesCount);
  if (!countsKnown) {
    return { name, pass: false, reason: `${noPolicyReason}, and this environment's secret/variable counts were not provided -- fail closed, never read an unknown count as credential-less` };
  }
  if (secretsCount === 0 && variablesCount === 0) {
    const why = CREDENTIAL_LESS_ENVIRONMENTS.get(name);
    if (why) {
      return { name, pass: true, info: true, reason: `${noPolicyReason}, but this environment has 0 secrets and 0 variables and is on the credential-less allowlist (${why}) -- reported as informational only` };
    }
    return { name, pass: false, reason: `${noPolicyReason}; it has 0 secrets and 0 variables, but that does not prove it mints no credential (OIDC trust is keyed on the environment name, and the client id can be a repo variable) and it is not on CREDENTIAL_LESS_ENVIRONMENTS -- any branch could get a credential trusted for this environment` };
  }
  return { name, pass: false, reason: `${noPolicyReason}, and this environment has ${secretsCount} secret(s)/${variablesCount} variable(s) -- a real credential with no branch restriction, any branch can get it` };
}

/** Pure: evaluate every required environment and collect the gaps. */
export function evaluateAll(envs) {
  const results = (envs ?? []).map(evaluateEnvironmentBranchPolicy);
  const gaps = results.filter((r) => !r.pass);
  return { pass: gaps.length === 0, results, gaps };
}
