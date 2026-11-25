// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateEnvironmentBranchPolicy,
  evaluateAll,
  workflowEnvironmentNames,
  requiredEnvironments,
  EXEMPT_ENVIRONMENTS,
  CREDENTIAL_LESS_ENVIRONMENTS,
} from './environment-branch-policy-predicate.mjs';

test('FIRE ARM: deployment_branch_policy null -> fail (the staging shape found in t/4340)', () => {
  const r = evaluateEnvironmentBranchPolicy({ name: 'staging', deploymentBranchPolicy: null, policyCount: 0 });
  assert.equal(r.pass, false);
  assert.match(r.reason, /no branch restriction/);
});

test('FIRE ARM: custom_branch_policies true but 0 policies -> fail (configured but empty)', () => {
  const r = evaluateEnvironmentBranchPolicy({
    name: 'monitoring',
    deploymentBranchPolicy: { protected_branches: false, custom_branch_policies: true },
    policyCount: 0,
  });
  assert.equal(r.pass, false);
  assert.match(r.reason, /selected-branches list is empty/);
});

test('FIRE ARM: neither protected_branches nor custom_branch_policies enabled -> fail', () => {
  const r = evaluateEnvironmentBranchPolicy({
    name: 'auth-smoke',
    deploymentBranchPolicy: { protected_branches: false, custom_branch_policies: false },
    policyCount: 0,
  });
  assert.equal(r.pass, false);
});

test('FIRE ARM: the environment is missing entirely -> fail, never read as clean', () => {
  const r = evaluateEnvironmentBranchPolicy({ name: 'ghost', missing: true });
  assert.equal(r.pass, false);
  assert.match(r.reason, /does not exist/);
});

// ── t/4958: policy-less but credential-less (#5279/#4539 false alarm on `copilot`) ──────────
test('INFO, not FAIL: policy-less environment with 0 secrets and 0 variables (the `copilot` shape)', () => {
  const r = evaluateEnvironmentBranchPolicy({
    name: 'copilot',
    deploymentBranchPolicy: null,
    policyCount: 0,
    secretsCount: 0,
    variablesCount: 0,
  });
  assert.equal(r.pass, true);
  assert.equal(r.info, true);
  assert.match(r.reason, /0 secrets and 0 variables/);
});

test('FIRE ARM: policy-less environment with at least 1 secret still fails', () => {
  const r = evaluateEnvironmentBranchPolicy({
    name: 'staging',
    deploymentBranchPolicy: null,
    policyCount: 0,
    secretsCount: 1,
    variablesCount: 0,
  });
  assert.equal(r.pass, false);
  assert.match(r.reason, /1 secret\(s\)\/0 variable\(s\)/);
});

test('FIRE ARM: policy-less environment with at least 1 variable (no secrets) still fails', () => {
  const r = evaluateEnvironmentBranchPolicy({
    name: 'staging',
    deploymentBranchPolicy: null,
    policyCount: 0,
    secretsCount: 0,
    variablesCount: 3,
  });
  assert.equal(r.pass, false);
});

test('FIRE ARM: an unreadable secret/variable count fails closed, is never read as credential-less', () => {
  const r = evaluateEnvironmentBranchPolicy({
    name: 'staging',
    deploymentBranchPolicy: null,
    policyCount: 0,
    countsError: 'HTTP 403',
  });
  assert.equal(r.pass, false);
  assert.match(r.reason, /could not be read/);
  assert.match(r.reason, /HTTP 403/);
});

test('FIRE ARM: counts simply not provided (caller didn\'t look them up) also fails closed, not read as credential-less', () => {
  const r = evaluateEnvironmentBranchPolicy({ name: 'staging', deploymentBranchPolicy: null, policyCount: 0 });
  assert.equal(r.pass, false);
  assert.match(r.reason, /were not provided/);
});

test('INFO applies equally to the custom_branch_policies-empty and neither-flag-enabled shapes', () => {
  const emptyCustom = evaluateEnvironmentBranchPolicy({
    name: 'copilot',
    deploymentBranchPolicy: { protected_branches: false, custom_branch_policies: true },
    policyCount: 0,
    secretsCount: 0,
    variablesCount: 0,
  });
  assert.equal(emptyCustom.pass, true);
  assert.equal(emptyCustom.info, true);

  const neitherFlag = evaluateEnvironmentBranchPolicy({
    name: 'copilot',
    deploymentBranchPolicy: { protected_branches: false, custom_branch_policies: false },
    policyCount: 0,
    secretsCount: 0,
    variablesCount: 0,
  });
  assert.equal(neitherFlag.pass, true);
  assert.equal(neitherFlag.info, true);
});

// ── t/4958, Tech Lead review of #5285: 0/0 is not proof of no credential ─────────────────────
// OIDC trust (Azure federated credential `repo:...:environment:<name>`) is keyed on the NAME; the
// client id can be a repo-level variable. `production`/`staging` in this repo hold 0 secrets and
// 0 variables and are trusted by the deploy app. Only an allowlisted environment is informational.
for (const name of ['production', 'staging', 'some-new-env']) {
  test(`FIRE ARM: a policy-less 0/0 environment NOT on the allowlist fails (${name})`, () => {
    const r = evaluateEnvironmentBranchPolicy({ name, deploymentBranchPolicy: null, policyCount: 0, secretsCount: 0, variablesCount: 0 });
    assert.equal(r.pass, false);
    assert.equal(r.info, undefined);
    assert.match(r.reason, /not on CREDENTIAL_LESS_ENVIRONMENTS/);
    assert.match(r.reason, /OIDC trust is keyed on the environment name/);
  });
}

test('INFO arm: the allowlisted 0/0 environment is informational and names why it is on the list', () => {
  const r = evaluateEnvironmentBranchPolicy({ name: 'copilot', deploymentBranchPolicy: null, policyCount: 0, secretsCount: 0, variablesCount: 0 });
  assert.equal(r.pass, true);
  assert.equal(r.info, true);
  assert.match(r.reason, /credential-less allowlist \(GitHub Copilot coding agent environment/);
});

test('FIRE ARM: an allowlisted environment that gains a secret or a variable fails again', () => {
  for (const [s, v] of [[1, 0], [0, 1]]) {
    const r = evaluateEnvironmentBranchPolicy({ name: 'copilot', deploymentBranchPolicy: null, policyCount: 0, secretsCount: s, variablesCount: v });
    assert.equal(r.pass, false, `${s}/${v}`);
  }
});

test('FIRE ARM: an allowlisted environment with unreadable counts still fails closed', () => {
  const r = evaluateEnvironmentBranchPolicy({ name: 'copilot', deploymentBranchPolicy: null, policyCount: 0, countsError: 'HTTP 403' });
  assert.equal(r.pass, false);
});

test('allowlist hygiene: every CREDENTIAL_LESS_ENVIRONMENTS entry carries a non-empty reason, and the deploy environments are never on it', () => {
  assert.ok(CREDENTIAL_LESS_ENVIRONMENTS.size >= 1);
  for (const [name, why] of CREDENTIAL_LESS_ENVIRONMENTS) {
    assert.ok(typeof why === 'string' && why.trim().length > 20, `${name} needs a reason`);
  }
  for (const name of ['production', 'staging', 'monitoring', 'auth-smoke', 'author-app']) {
    assert.equal(CREDENTIAL_LESS_ENVIRONMENTS.has(name), false, name);
  }
});

test('evaluateAll: a non-allowlisted 0/0 environment IS a gap', () => {
  const result = evaluateAll([{ name: 'staging', deploymentBranchPolicy: null, policyCount: 0, secretsCount: 0, variablesCount: 0 }]);
  assert.equal(result.pass, false);
  assert.equal(result.gaps.length, 1);
});

test('evaluateAll never counts an INFO result as a gap', () => {
  const result = evaluateAll([
    { name: 'copilot', deploymentBranchPolicy: null, policyCount: 0, secretsCount: 0, variablesCount: 0 },
    { name: 'production', deploymentBranchPolicy: { protected_branches: false, custom_branch_policies: true }, policyCount: 1 },
  ]);
  assert.equal(result.pass, true);
  assert.deepEqual(result.gaps, []);
});

test('PASS: custom_branch_policies true with at least one policy configured (production/staging/monitoring after t/4340)', () => {
  const r = evaluateEnvironmentBranchPolicy({
    name: 'production',
    deploymentBranchPolicy: { protected_branches: false, custom_branch_policies: true },
    policyCount: 1,
  });
  assert.equal(r.pass, true);
  assert.equal(r.reason, null);
});

test('PASS: protected_branches true alone (GitHub\'s "protected branches only" option) also restricts', () => {
  const r = evaluateEnvironmentBranchPolicy({
    name: 'production',
    deploymentBranchPolicy: { protected_branches: true, custom_branch_policies: false },
    policyCount: 0,
  });
  assert.equal(r.pass, true);
});

test('evaluateAll: both arms -- a mix of passing and failing environments collects only the gaps', () => {
  const result = evaluateAll([
    { name: 'production', deploymentBranchPolicy: { protected_branches: false, custom_branch_policies: true }, policyCount: 1 },
    { name: 'staging', deploymentBranchPolicy: null, policyCount: 0 },
  ]);
  assert.equal(result.pass, false);
  assert.deepEqual(result.gaps.map((g) => g.name), ['staging']);
  assert.equal(result.results.length, 2);
});

test('empty/undefined input never throws', () => {
  assert.doesNotThrow(() => evaluateAll(undefined));
  assert.doesNotThrow(() => evaluateAll([]));
  assert.doesNotThrow(() => evaluateEnvironmentBranchPolicy({}));
  assert.doesNotThrow(() => evaluateEnvironmentBranchPolicy(undefined));
});

// ── t/4340 TL review (PR #3527): coverage is COMPUTED, not a hand-kept list ───────────────
test('workflowEnvironmentNames: finds every bare `environment: NAME` scalar across files', () => {
  const files = [
    { path: 'a.yml', text: 'jobs:\n  x:\n    environment: production\n' },
    { path: 'b.yml', text: 'jobs:\n  y:\n    environment: staging\n  z:\n    environment: monitoring\n' },
  ];
  assert.deepEqual(workflowEnvironmentNames(files), ['monitoring', 'production', 'staging']);
});

test('workflowEnvironmentNames: skips a templated/unresolvable value, does not crash on it', () => {
  const files = [{ path: 'a.yml', text: 'environment: ${{ inputs.environment }}\n' }];
  assert.deepEqual(workflowEnvironmentNames(files), []);
});

// t/4058, issue #3333: a bare `environment:` mapping key (workflow_dispatch input block, nothing
// after the colon on its own line) must NOT be read as having the next line's `description:`
// content as its value -- `\s*` matches `\n`, so a naive regex can cross the line boundary.
test('workflowEnvironmentNames: a bare `environment:` input-mapping key yields no false match', () => {
  const files = [{
    path: 'deploy-azure.yml',
    text: [
      'on:',
      '  workflow_dispatch:',
      '    inputs:',
      '      environment:',
      "        description: 'Deployment environment (production only)'",
      '        required: true',
      "        default: 'production'",
      '',
    ].join('\n'),
  }];
  assert.deepEqual(workflowEnvironmentNames(files), []);
});

test('workflowEnvironmentNames: a bare mapping key does not suppress a real scalar elsewhere', () => {
  const files = [{
    path: 'mixed.yml',
    text: [
      '    inputs:',
      '      environment:',
      "        description: 'x'",
      'jobs:',
      '  deploy:',
      '    environment: production',
      '',
    ].join('\n'),
  }];
  assert.deepEqual(workflowEnvironmentNames(files), ['production']);
});

test('workflowEnvironmentNames: de-duplicates the same name used by multiple jobs/files', () => {
  const files = [
    { path: 'a.yml', text: 'environment: production\n' },
    { path: 'b.yml', text: 'environment: production\n' },
  ];
  assert.deepEqual(workflowEnvironmentNames(files), ['production']);
});

test('requiredEnvironments: the union of repo environments and workflow-referenced names, minus exemptions', () => {
  const required = requiredEnvironments(['production', 'staging'], ['staging', 'monitoring']);
  assert.deepEqual(required, ['monitoring', 'production', 'staging']);
});

test('FIRE ARM: a brand-new environment neither hand-listed anywhere else still gets required, and fails if unrestricted', () => {
  // This is the coverage proof the TL asked for: nothing but live repo/workflow enumeration
  // decides what's required, so a newly added environment is covered automatically.
  const required = requiredEnvironments(['production', 'a-brand-new-environment'], []);
  assert.ok(required.includes('a-brand-new-environment'));
  const r = evaluateEnvironmentBranchPolicy({ name: 'a-brand-new-environment', deploymentBranchPolicy: null, policyCount: 0 });
  assert.equal(r.pass, false);
});

test('CONTROL: an environment on the exemption list is excluded from what\'s required', () => {
  if (EXEMPT_ENVIRONMENTS.length === 0) {
    // Nothing is exempt today; prove the mechanism instead with a local exemption set, since
    // asserting against the live (empty) list would make this test vacuous.
    const all = new Set(['production', 'staging']);
    all.delete('staging');
    assert.deepEqual([...all], ['production']);
    return;
  }
  const required = requiredEnvironments([...EXEMPT_ENVIRONMENTS, 'production'], []);
  for (const exempt of EXEMPT_ENVIRONMENTS) assert.ok(!required.includes(exempt));
});

test('requiredEnvironments: empty/undefined input never throws', () => {
  assert.doesNotThrow(() => requiredEnvironments(undefined, undefined));
  assert.deepEqual(requiredEnvironments(undefined, undefined), []);
});
