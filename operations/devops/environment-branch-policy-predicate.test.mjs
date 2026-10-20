// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateEnvironmentBranchPolicy, evaluateAll, CREDENTIALED_ENVIRONMENTS } from './environment-branch-policy-predicate.mjs';

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

test('evaluateAll: CONTROL -- a clean set of environments passes with no gaps', () => {
  const result = evaluateAll(
    CREDENTIALED_ENVIRONMENTS.map((name) => ({
      name,
      deploymentBranchPolicy: { protected_branches: false, custom_branch_policies: true },
      policyCount: 1,
    })),
  );
  assert.equal(result.pass, true);
  assert.deepEqual(result.gaps, []);
});

test('empty/undefined input never throws', () => {
  assert.doesNotThrow(() => evaluateAll(undefined));
  assert.doesNotThrow(() => evaluateAll([]));
  assert.doesNotThrow(() => evaluateEnvironmentBranchPolicy({}));
  assert.doesNotThrow(() => evaluateEnvironmentBranchPolicy(undefined));
});
