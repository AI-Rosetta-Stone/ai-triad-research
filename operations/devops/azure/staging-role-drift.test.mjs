// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Run: node --test operations/devops/azure/staging-role-drift.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { declaredStagingRoles, roleDriftVerdict } from './staging-role-drift.mjs';

const BLOB = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe';
const OFFICER = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7';
const SUB = '/subscriptions/00000000-0000-0000-0000-000000000000';
const ACCOUNT = `${SUB}/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/acct`;

const BICEP = `
param vaultName string = 'kv-stg'
var blobRole = '${BLOB}'
var officerRole = '${OFFICER}'

resource stagingA 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'staging-a'
}

resource prodA 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'a'
}

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: vaultName
}

resource grantStagingA 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: stagingA
  name: guid(stagingA.id, containerAppStaging.id, blobRole)
  properties: {
    principalId: containerAppStaging.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobRole)
  }
}

resource grantProdA 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: prodA
  name: guid(prodA.id, containerApp.id, blobRole)
  properties: {
    principalId: containerApp.identity.principalId
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobRole)
  }
}

resource grantVault 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: vault
  name: guid(vault.id, stagingPrincipalId, officerRole)
  properties: {
    principalId: stagingPrincipalId
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', officerRole)
  }
}
`;

const live = (role, scope, name = 'n') => ({
  name,
  roleDefinitionName: 'role',
  roleDefinitionId: `${SUB}/providers/Microsoft.Authorization/roleDefinitions/${role}`,
  scope,
});
const LIVE_A = live(BLOB, `${ACCOUNT}/blobServices/default/containers/staging-a`, 'a1');
const LIVE_VAULT = live(OFFICER, `${SUB}/resourcegroups/rg/providers/Microsoft.KeyVault/vaults/kv-stg`, 'v1');

test('declared: only the staging identity grants, with role and scope resolved', () => {
  const { declared, unresolved } = declaredStagingRoles(BICEP, 'x.bicep');
  assert.deepEqual(unresolved, []);
  assert.deepEqual(
    declared.map((d) => [d.symbol, d.roleId, d.scopeSuffix]),
    [
      ['grantStagingA', BLOB, '/containers/staging-a'],
      ['grantVault', OFFICER, '/vaults/kv-stg'],
    ],
  );
});

test('every live grant is declared: ok', () => {
  const v = roleDriftVerdict({ ...declaredStagingRoles(BICEP), live: [LIVE_A, LIVE_VAULT] });
  assert.equal(v.ok, true);
  assert.deepEqual(v.undeclared, []);
  assert.deepEqual(v.missing, []);
});

test('a live grant on a container Bicep does not declare for staging: fails and names it', () => {
  const extra = live(BLOB, `${ACCOUNT}/blobServices/default/containers/staging-b`, 'hand-made');
  const v = roleDriftVerdict({ ...declaredStagingRoles(BICEP), live: [LIVE_A, LIVE_VAULT, extra] });
  assert.equal(v.ok, false);
  assert.deepEqual(v.undeclared.map((u) => u.name), ['hand-made']);
  assert.match(v.summary, /staging-b \(hand-made\)/);
});

test('the right scope with a different role is undeclared', () => {
  const v = roleDriftVerdict({
    ...declaredStagingRoles(BICEP),
    live: [live(OFFICER, LIVE_A.scope, 'wrong-role')],
  });
  assert.equal(v.ok, false);
  assert.deepEqual(v.undeclared.map((u) => u.name), ['wrong-role']);
});

test('a wider scope is undeclared: an account-scope grant does not match a container grant', () => {
  const v = roleDriftVerdict({ ...declaredStagingRoles(BICEP), live: [LIVE_A, live(BLOB, ACCOUNT, 'account')] });
  assert.equal(v.ok, false);
  assert.deepEqual(v.undeclared.map((u) => u.name), ['account']);
});

test("a container whose name only ends with a declared name is undeclared ('x-staging-a')", () => {
  const scope = `${ACCOUNT}/blobServices/default/containers/x-staging-a`;
  const v = roleDriftVerdict({ ...declaredStagingRoles(BICEP), live: [live(BLOB, scope, 'lookalike')] });
  assert.equal(v.ok, false);
});

test("prod's own grant is not staging's: a live staging grant on prod's container is undeclared", () => {
  const scope = `${ACCOUNT}/blobServices/default/containers/a`;
  const v = roleDriftVerdict({ ...declaredStagingRoles(BICEP), live: [live(BLOB, scope, 'on-prod')] });
  assert.equal(v.ok, false);
  assert.deepEqual(v.undeclared.map((u) => u.name), ['on-prod']);
});

test('scope casing differs between Azure reads: still matches', () => {
  const v = roleDriftVerdict({
    ...declaredStagingRoles(BICEP),
    live: [{ ...LIVE_A, scope: LIVE_A.scope.toUpperCase() }],
  });
  assert.equal(v.undeclared.length, 0);
});

test('declared but not live is reported and does not fail', () => {
  const v = roleDriftVerdict({ ...declaredStagingRoles(BICEP), live: [LIVE_A] });
  assert.equal(v.ok, true);
  assert.equal(v.missing.length, 1);
  assert.match(v.summary, /declared but not live \(not a failure\): grantVault/);
});

test('fails closed: a live list that is not an array', () => {
  for (const bad of [null, undefined, {}, '']) {
    const v = roleDriftVerdict({ ...declaredStagingRoles(BICEP), live: bad });
    assert.equal(v.ok, false);
    assert.match(v.summary, /not a JSON array/);
  }
});

test('fails closed: zero assignments read is an error, not clean (TL t/707#5 condition 5)', () => {
  const v = roleDriftVerdict({ ...declaredStagingRoles(BICEP), live: [] });
  assert.equal(v.ok, false);
  assert.deepEqual(v.undeclared, []);
  assert.match(v.summary, /zero role assignments.*failed read, not a clean result/);
});

test('fails closed: a live assignment with no scope or role id', () => {
  const v = roleDriftVerdict({ ...declaredStagingRoles(BICEP), live: [{ name: 'broken' }] });
  assert.equal(v.ok, false);
  assert.match(v.summary, /'broken' has no usable scope/);
});

test('fails closed: a staging grant whose scope name is computed', () => {
  const text = BICEP.replace("name: 'staging-a'", "name: '${prefix}-a'");
  const result = declaredStagingRoles(text, 'x.bicep');
  assert.equal(result.unresolved.length, 1);
  assert.match(result.unresolved[0], /grantStagingA.*not a string literal/);
  assert.equal(roleDriftVerdict({ ...result, live: [LIVE_VAULT] }).ok, false);
});

test('fails closed: an unknown role variable, an undeclared scope, and a missing principalId', () => {
  const unknownRole = declaredStagingRoles(BICEP.replace("var blobRole = '", "var otherRole = '"));
  assert.ok(unknownRole.unresolved.some((u) => /grantStagingA.*does not resolve to a role GUID/.test(u)));

  const noScope = declaredStagingRoles(BICEP.replace('scope: stagingA', 'scope: elsewhere'));
  assert.ok(noScope.unresolved.some((u) => /scope 'elsewhere' is not a resource/.test(u)));

  const noPrincipal = declaredStagingRoles(BICEP.replace('    principalId: stagingPrincipalId\n', ''));
  assert.ok(noPrincipal.unresolved.some((u) => /grantVault.*no principalId/.test(u)));
});

test('a literal assignment name (adopting a hand-made grant, t/707) is still read as declared', () => {
  const text = BICEP.replace(
    'name: guid(stagingA.id, containerAppStaging.id, blobRole)',
    "name: '237665b7-8bde-42b5-b8d7-7eaa9959f88d'",
  );
  const { declared, unresolved } = declaredStagingRoles(text);
  assert.deepEqual(unresolved, []);
  assert.equal(declared[0].scopeSuffix, '/containers/staging-a');
});

// The real templates: every staging grant in them must resolve, or the scheduled check would
// fail for a reason that is not drift.
test('the repository Bicep resolves with nothing unresolved', () => {
  const read = (name) => readFileSync(fileURLToPath(new URL(`../../../deploy/azure/${name}`, import.meta.url)), 'utf8');
  const main = declaredStagingRoles(read('main.bicep'), 'main.bicep');
  const vault = declaredStagingRoles(read('staging-keyvault.bicep'), 'staging-keyvault.bicep');
  assert.deepEqual([...main.unresolved, ...vault.unresolved], []);
  const suffixes = [...main.declared, ...vault.declared].map((d) => d.scopeSuffix);
  for (const expected of ['/containers/staging-user-content', '/containers/staging-community', '/containers/staging-analytics']) {
    assert.ok(suffixes.includes(expected), `main.bicep should declare a staging grant on ${expected}`);
  }
  assert.ok(suffixes.some((s) => s.startsWith('/vaults/')), 'staging-keyvault.bicep should declare the vault grant');
  assert.ok(suffixes.every((s) => !s.startsWith('/storageaccounts/')), 'staging must hold no account-scope role (TL p/104#95)');
});

// The failing arm, proven on a recorded read (TL t/707#5 condition 4). The file beside this test is
// the live `az role assignment list --assignee <staging principal> --all` of 2026-11-25T23:57Z,
// reduced to the fields the check reads, with the subscription id zeroed. On that day the staging
// identity held one grant Bicep did not declare: 237665b7, made by hand on staging-brief-exports
// (t/92#18). The Bicep of that day is modelled by dropping any staging-brief-exports declaration
// from the real templates, so the test holds before and after that grant is adopted in main.bicep.
const RECORDED = new URL('./staging-role-drift.recorded-20261125.json', import.meta.url);
const HAND_MADE = '237665b7-8bde-42b5-b8d7-7eaa9959f88d';
const repoBicep = (name) => fileURLToPath(new URL(`../../../deploy/azure/${name}`, import.meta.url));

test('recorded read of 2026-11-25: the hand-made staging-brief-exports grant is the one undeclared assignment', () => {
  const recorded = JSON.parse(readFileSync(RECORDED, 'utf8'));
  assert.equal(recorded.length, 5);
  const sources = ['main.bicep', 'staging-keyvault.bicep'].map((n) => declaredStagingRoles(readFileSync(repoBicep(n), 'utf8'), n));
  const declared = sources.flatMap((s) => s.declared).filter((d) => d.scopeSuffix !== '/containers/staging-brief-exports');
  assert.equal(declared.length, 4, 'three staging containers and the staging vault were declared that day');

  const v = roleDriftVerdict({ declared, unresolved: sources.flatMap((s) => s.unresolved), live: recorded });
  assert.equal(v.ok, false);
  assert.deepEqual(v.undeclared.map((u) => u.name), [HAND_MADE]);
  assert.deepEqual(v.missing, [], 'the other four recorded assignments each match a declaration');
  assert.match(v.summary, /^1 role assignment\(s\) on the staging identity are not declared in Bicep: Storage Blob Data Contributor on .*\/containers\/staging-brief-exports \(237665b7-/);
});

test('recorded read of 2026-11-25: with the grant declared, the same read is clean', () => {
  const recorded = JSON.parse(readFileSync(RECORDED, 'utf8'));
  const sources = ['main.bicep', 'staging-keyvault.bicep'].map((n) => declaredStagingRoles(readFileSync(repoBicep(n), 'utf8'), n));
  const declared = sources.flatMap((s) => s.declared).filter((d) => d.scopeSuffix !== '/containers/staging-brief-exports');
  declared.push({ roleId: BLOB, scopeSuffix: '/containers/staging-brief-exports', symbol: 'adopted' });
  const v = roleDriftVerdict({ declared, live: recorded });
  assert.equal(v.ok, true);
  assert.deepEqual(v.missing, []);
});

// The scheduled job acts on the exit code, so prove that too. Given only the vault template, the
// recorded container grants are undeclared: the command must exit 1 and name them on stdout.
test('CLI: an undeclared assignment in the recorded read exits 1 and names it on stdout', () => {
  const script = fileURLToPath(new URL('./staging-role-drift.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [script, fileURLToPath(RECORDED), repoBicep('staging-keyvault.bicep')], { encoding: 'utf8' });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stdout, /4 role assignment\(s\) on the staging identity are not declared in Bicep/);
  assert.ok(run.stdout.includes(HAND_MADE));
});

test('CLI: bad input exits 2, never 0 (missing arguments, unreadable live file)', () => {
  const script = fileURLToPath(new URL('./staging-role-drift.mjs', import.meta.url));
  assert.equal(spawnSync(process.execPath, [script], { encoding: 'utf8' }).status, 2);
  const missing = spawnSync(process.execPath, [script, 'no-such-live.json', repoBicep('staging-keyvault.bicep')], { encoding: 'utf8' });
  assert.equal(missing.status, 2);
});
