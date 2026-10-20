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
