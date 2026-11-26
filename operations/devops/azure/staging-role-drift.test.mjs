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
const ACCOUNT = `${SUB}/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/acctx1`;
// Like the real template, the account name is computed at deploy time; the caller supplies it.
const PARAMS = { suffix: 'x1' };
const PATH_A = '/providers/microsoft.storage/storageaccounts/acctx1/blobservices/default/containers/staging-a';
const PATH_VAULT = '/providers/microsoft.keyvault/vaults/kv-stg';

const BICEP = `
param suffix string = uniqueString(resourceGroup().id)
param vaultName string = 'kv-stg'
var blobRole = '${BLOB}'
var officerRole = '${OFFICER}'

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: 'acct\${suffix}'
  sku: { name: 'Standard_ZRS' }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storageAccount
  name: 'default'
}

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
  const { declared, unresolved } = declaredStagingRoles(BICEP, 'x.bicep', PARAMS);
  assert.deepEqual(unresolved, []);
  assert.deepEqual(
    declared.map((d) => [d.symbol, d.roleId, d.scopePath]),
    [
      ['grantStagingA', BLOB, PATH_A],
      ['grantVault', OFFICER, PATH_VAULT],
    ],
  );
});

// SO t/707#14: matching on the last scope segment alone gave a false clean. Each of these has the
// declared role and the declared last segment, on a resource Bicep does not declare.
test('the declared container name under ANOTHER storage account is undeclared', () => {
  const other = `${SUB}/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/otheracct/blobServices/default/containers/staging-a`;
  const declared = declaredStagingRoles(BICEP, 'x.bicep', PARAMS);
  const alone = roleDriftVerdict({ ...declared, live: [live(BLOB, other, 'other-account')] });
  assert.equal(alone.ok, false);
  assert.deepEqual(alone.undeclared.map((u) => u.name), ['other-account']);
  const beside = roleDriftVerdict({ ...declared, live: [LIVE_A, LIVE_VAULT, live(BLOB, other, 'other-account')] });
  assert.equal(beside.ok, false);
  assert.deepEqual(beside.undeclared.map((u) => u.name), ['other-account']);
});

test('the declared container name under the same account in another blob path, or a blob below it, is undeclared', () => {
  const declared = declaredStagingRoles(BICEP, 'x.bicep', PARAMS);
  for (const scope of [
    `${ACCOUNT}/fileServices/default/containers/staging-a`,
    `${ACCOUNT}/blobServices/default/containers/staging-a/blobs/x`,
    `${ACCOUNT}x/blobServices/default/containers/staging-a`,
  ]) {
    const v = roleDriftVerdict({ ...declared, live: [live(BLOB, scope, 'near-miss')] });
    assert.deepEqual(v.undeclared.map((u) => u.name), ['near-miss'], scope);
  }
});

test('the declared vault name on another resource type, or a secret below the vault, is undeclared', () => {
  const declared = declaredStagingRoles(BICEP, 'x.bicep', PARAMS);
  for (const scope of [
    `${SUB}/resourceGroups/rg/providers/Microsoft.RecoveryServices/vaults/kv-stg`,
    `${SUB}/resourceGroups/rg/providers/Microsoft.KeyVault/vaults/other/providers/x/vaults/kv-stg`,
    `${SUB}/resourceGroups/rg/providers/Microsoft.KeyVault/vaults/kv-stg/secrets/s`,
    `${SUB}/providers/Microsoft.KeyVault/vaults/kv-stg`,
  ]) {
    const v = roleDriftVerdict({ ...declared, live: [live(OFFICER, scope, 'not-the-vault')] });
    assert.equal(v.ok, false, scope);
    assert.deepEqual(v.undeclared.map((u) => u.name), ['not-the-vault'], scope);
  }
});

test('one declaration covers one live assignment: a second on the same role and scope is reported', () => {
  const v = roleDriftVerdict({
    ...declaredStagingRoles(BICEP, 'x.bicep', PARAMS),
    live: [LIVE_A, { ...LIVE_A, name: 'a2' }, LIVE_VAULT],
  });
  assert.equal(v.ok, false);
  assert.deepEqual(v.undeclared.map((u) => u.name), ['a2']);
});

test('fails closed: without the deploy-time parameter the account is unknown, so nothing is treated as declared', () => {
  const result = declaredStagingRoles(BICEP, 'x.bicep');
  assert.equal(result.unresolved.length, 1);
  assert.match(result.unresolved[0], /grantStagingA.*cannot be resolved to a full resource path.*'storageAccount'.*--param/);
  assert.deepEqual(result.declared.map((d) => d.symbol), ['grantVault']);
  assert.equal(roleDriftVerdict({ ...result, live: [LIVE_A, LIVE_VAULT] }).ok, false);
});

test('every live grant is declared: ok', () => {
  const v = roleDriftVerdict({ ...declaredStagingRoles(BICEP, 'x.bicep', PARAMS), live: [LIVE_A, LIVE_VAULT] });
  assert.equal(v.ok, true);
  assert.deepEqual(v.undeclared, []);
  assert.deepEqual(v.missing, []);
});

test('a live grant on a container Bicep does not declare for staging: fails and names it', () => {
  const extra = live(BLOB, `${ACCOUNT}/blobServices/default/containers/staging-b`, 'hand-made');
  const v = roleDriftVerdict({ ...declaredStagingRoles(BICEP, 'x.bicep', PARAMS), live: [LIVE_A, LIVE_VAULT, extra] });
  assert.equal(v.ok, false);
  assert.deepEqual(v.undeclared.map((u) => u.name), ['hand-made']);
  assert.match(v.summary, /staging-b \(hand-made\)/);
});

test('the right scope with a different role is undeclared', () => {
  const v = roleDriftVerdict({
    ...declaredStagingRoles(BICEP, 'x.bicep', PARAMS),
    live: [live(OFFICER, LIVE_A.scope, 'wrong-role')],
  });
  assert.equal(v.ok, false);
  assert.deepEqual(v.undeclared.map((u) => u.name), ['wrong-role']);
});

test('a wider scope is undeclared: an account-scope grant does not match a container grant', () => {
  const v = roleDriftVerdict({ ...declaredStagingRoles(BICEP, 'x.bicep', PARAMS), live: [LIVE_A, live(BLOB, ACCOUNT, 'account')] });
  assert.equal(v.ok, false);
  assert.deepEqual(v.undeclared.map((u) => u.name), ['account']);
});

test("a container whose name only ends with a declared name is undeclared ('x-staging-a')", () => {
  const scope = `${ACCOUNT}/blobServices/default/containers/x-staging-a`;
  const v = roleDriftVerdict({ ...declaredStagingRoles(BICEP, 'x.bicep', PARAMS), live: [live(BLOB, scope, 'lookalike')] });
  assert.equal(v.ok, false);
});

test("prod's own grant is not staging's: a live staging grant on prod's container is undeclared", () => {
  const scope = `${ACCOUNT}/blobServices/default/containers/a`;
  const v = roleDriftVerdict({ ...declaredStagingRoles(BICEP, 'x.bicep', PARAMS), live: [live(BLOB, scope, 'on-prod')] });
  assert.equal(v.ok, false);
  assert.deepEqual(v.undeclared.map((u) => u.name), ['on-prod']);
});

test('scope casing differs between Azure reads: still matches', () => {
  const v = roleDriftVerdict({
    ...declaredStagingRoles(BICEP, 'x.bicep', PARAMS),
    live: [{ ...LIVE_A, scope: LIVE_A.scope.toUpperCase() }],
  });
  assert.equal(v.undeclared.length, 0);
});

test('declared but not live is reported and does not fail', () => {
  const v = roleDriftVerdict({ ...declaredStagingRoles(BICEP, 'x.bicep', PARAMS), live: [LIVE_A] });
  assert.equal(v.ok, true);
  assert.equal(v.missing.length, 1);
  assert.match(v.summary, /declared but not live \(not a failure\): grantVault/);
});

test('fails closed: a live list that is not an array', () => {
  for (const bad of [null, undefined, {}, '']) {
    const v = roleDriftVerdict({ ...declaredStagingRoles(BICEP, 'x.bicep', PARAMS), live: bad });
    assert.equal(v.ok, false);
    assert.match(v.summary, /not a JSON array/);
  }
});

test('fails closed: zero assignments read is an error, not clean (TL t/707#5 condition 5)', () => {
  const v = roleDriftVerdict({ ...declaredStagingRoles(BICEP, 'x.bicep', PARAMS), live: [] });
  assert.equal(v.ok, false);
  assert.deepEqual(v.undeclared, []);
  assert.match(v.summary, /zero role assignments.*failed read, not a clean result/);
});

test('fails closed: a live assignment with no scope or role id', () => {
  const v = roleDriftVerdict({ ...declaredStagingRoles(BICEP, 'x.bicep', PARAMS), live: [{ name: 'broken' }] });
  assert.equal(v.ok, false);
  assert.match(v.summary, /'broken' has no usable scope/);
});

test('fails closed: a staging grant whose scope name is computed', () => {
  const text = BICEP.replace("name: 'staging-a'", "name: '${prefix}-a'");
  const result = declaredStagingRoles(text, 'x.bicep', PARAMS);
  assert.equal(result.unresolved.length, 1);
  assert.match(result.unresolved[0], /grantStagingA.*name of 'stagingA' is not a string literal/);
  assert.equal(roleDriftVerdict({ ...result, live: [LIVE_VAULT] }).ok, false);
});

test('fails closed: a scope whose parent is not declared, and a name that calls a function', () => {
  const noParent = declaredStagingRoles(BICEP.replace('parent: storageAccount', 'parent: elsewhere'), 'x.bicep', PARAMS);
  assert.ok(noParent.unresolved.some((u) => /grantStagingA.*parent 'elsewhere' is not a resource declared/.test(u)));

  const computed = declaredStagingRoles(BICEP.replace("name: 'acct${suffix}'", "name: toLower('acct${suffix}')"), 'x.bicep', PARAMS);
  assert.ok(computed.unresolved.some((u) => /grantStagingA.*name of 'storageAccount'/.test(u)));

  const nested = declaredStagingRoles(BICEP.replace("name: 'acct${suffix}'", "name: 'acct${toLower(suffix)}'"), 'x.bicep', PARAMS);
  assert.ok(nested.unresolved.some((u) => /grantStagingA.*name of 'storageAccount'/.test(u)));
});

test('fails closed: an unknown role variable, an undeclared scope, and a missing principalId', () => {
  const unknownRole = declaredStagingRoles(BICEP.replace("var blobRole = '", "var otherRole = '"), 'x.bicep', PARAMS);
  assert.ok(unknownRole.unresolved.some((u) => /grantStagingA.*does not resolve to a role GUID/.test(u)));

  const noScope = declaredStagingRoles(BICEP.replace('scope: stagingA', 'scope: elsewhere'), 'x.bicep', PARAMS);
  assert.ok(noScope.unresolved.some((u) => /scope 'elsewhere' is not a resource/.test(u)));

  const noPrincipal = declaredStagingRoles(BICEP.replace('    principalId: stagingPrincipalId\n', ''), 'x.bicep', PARAMS);
  assert.ok(noPrincipal.unresolved.some((u) => /grantVault.*no principalId/.test(u)));
});

test('a literal assignment name (adopting a hand-made grant, t/707) is still read as declared', () => {
  const text = BICEP.replace(
    'name: guid(stagingA.id, containerAppStaging.id, blobRole)',
    "name: '237665b7-8bde-42b5-b8d7-7eaa9959f88d'",
  );
  const { declared, unresolved } = declaredStagingRoles(text, 'x.bicep', PARAMS);
  assert.deepEqual(unresolved, []);
  assert.equal(declared[0].scopePath, PATH_A);
});

// The real templates. main.bicep names the storage account 'staitriad${uniqueSuffix}', and
// uniqueSuffix is uniqueString(resourceGroup().id): fixed for the life of resource group ai-triad,
// and not computable here. This is the value health-monitor.yml passes with --param; the recorded
// read below proves it is the right one (its account is staitriad + this suffix).
const REAL_PARAMS = { uniqueSuffix: 'kvwl3nywge4iw' };
const REAL_ACCOUNT = '/providers/microsoft.storage/storageaccounts/staitriadkvwl3nywge4iw';
const repoBicep = (name) => fileURLToPath(new URL(`../../../deploy/azure/${name}`, import.meta.url));
const realSources = (params = REAL_PARAMS) =>
  ['main.bicep', 'staging-keyvault.bicep'].map((n) => declaredStagingRoles(readFileSync(repoBicep(n), 'utf8'), n, params));

// Every staging grant in the real templates must resolve, or the scheduled check would fail for a
// reason that is not drift.
test('the repository Bicep resolves with nothing unresolved, to full resource paths', () => {
  const sources = realSources();
  assert.deepEqual(sources.flatMap((s) => s.unresolved), []);
  const paths = sources.flatMap((s) => s.declared).map((d) => d.scopePath);
  for (const container of ['staging-user-content', 'staging-community', 'staging-analytics']) {
    const expected = `${REAL_ACCOUNT}/blobservices/default/containers/${container}`;
    assert.ok(paths.includes(expected), `main.bicep should declare a staging grant on ${expected}`);
  }
  assert.ok(paths.includes('/providers/microsoft.keyvault/vaults/kv-ait-stg-kvwl3nywge4iw'), 'staging-keyvault.bicep should declare the vault grant');
  assert.ok(paths.every((p) => p !== REAL_ACCOUNT), 'staging must hold no account-scope role (TL p/104#95)');
});

test('the repository Bicep without --param: every storage grant is unresolved, none is assumed', () => {
  const sources = realSources({});
  const unresolved = sources.flatMap((s) => s.unresolved);
  assert.ok(unresolved.length >= 3);
  assert.ok(unresolved.every((u) => /cannot be resolved to a full resource path.*'storageAccount'/.test(u)));
  assert.deepEqual(sources.flatMap((s) => s.declared).map((d) => d.scopePath), ['/providers/microsoft.keyvault/vaults/kv-ait-stg-kvwl3nywge4iw']);
});

// The failing arm, proven on a recorded read (TL t/707#5 condition 4). The file beside this test is
// the live `az role assignment list --assignee <staging principal> --all` of 2026-11-25T23:57Z,
// reduced to the fields the check reads, with the subscription id zeroed. On that day the staging
// identity held one grant Bicep did not declare: 237665b7, made by hand on staging-brief-exports
// (t/92#18). The Bicep of that day is modelled by dropping any staging-brief-exports declaration
// from the real templates, so the test holds before and after that grant is adopted in main.bicep.
const RECORDED = new URL('./staging-role-drift.recorded-20261125.json', import.meta.url);
const HAND_MADE = '237665b7-8bde-42b5-b8d7-7eaa9959f88d';
const BRIEF_EXPORTS = `${REAL_ACCOUNT}/blobservices/default/containers/staging-brief-exports`;
const declaredThatDay = () => realSources().flatMap((s) => s.declared).filter((d) => d.scopePath !== BRIEF_EXPORTS);

test('recorded read of 2026-11-25: the hand-made staging-brief-exports grant is the one undeclared assignment', () => {
  const recorded = JSON.parse(readFileSync(RECORDED, 'utf8'));
  assert.equal(recorded.length, 5);
  const declared = declaredThatDay();
  assert.equal(declared.length, 4, 'three staging containers and the staging vault were declared that day');

  const v = roleDriftVerdict({ declared, unresolved: realSources().flatMap((s) => s.unresolved), live: recorded });
  assert.equal(v.ok, false);
  assert.deepEqual(v.undeclared.map((u) => u.name), [HAND_MADE]);
  assert.deepEqual(v.missing, [], 'the other four recorded assignments each match a declaration');
  assert.match(v.summary, /^1 role assignment\(s\) on the staging identity are not declared in Bicep: Storage Blob Data Contributor on .*\/containers\/staging-brief-exports \(237665b7-/);
});

test('recorded read of 2026-11-25: with the grant declared, the same read is clean', () => {
  const recorded = JSON.parse(readFileSync(RECORDED, 'utf8'));
  const declared = [...declaredThatDay(), { roleId: BLOB, scopePath: BRIEF_EXPORTS, symbol: 'adopted' }];
  const v = roleDriftVerdict({ declared, live: recorded });
  assert.equal(v.ok, true);
  assert.deepEqual(v.missing, []);
});

// SO t/707#14, on the real data: the recorded read with one grant moved to another storage account.
// Role and container name are the declared ones; the old suffix match called this clean.
test('recorded read with staging-community moved to another storage account: undeclared, not clean', () => {
  const recorded = JSON.parse(readFileSync(RECORDED, 'utf8'));
  const moved = recorded.map((a) =>
    a.scope.endsWith('/containers/staging-community')
      ? { ...a, name: 'moved', scope: a.scope.replace('staitriadkvwl3nywge4iw', 'someotheraccount') }
      : a,
  );
  assert.ok(moved.some((a) => a.name === 'moved'));
  const declared = [...declaredThatDay(), { roleId: BLOB, scopePath: BRIEF_EXPORTS, symbol: 'adopted' }];
  const v = roleDriftVerdict({ declared, live: moved });
  assert.equal(v.ok, false);
  assert.deepEqual(v.undeclared.map((u) => u.name), ['moved']);
  assert.equal(v.missing.length, 1, 'the declared staging-community grant is then reported as not live');
});

// The scheduled job acts on the exit code, so prove that too.
const SCRIPT = fileURLToPath(new URL('./staging-role-drift.mjs', import.meta.url));
const cli = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

// Given only the vault template, the recorded container grants are undeclared.
test('CLI: an undeclared assignment in the recorded read exits 1 and names it on stdout', () => {
  const run = cli(fileURLToPath(RECORDED), repoBicep('staging-keyvault.bicep'));
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stdout, /4 role assignment\(s\) on the staging identity are not declared in Bicep/);
  assert.ok(run.stdout.includes(HAND_MADE));
});

// Given only main.bicep, the vault grant is undeclared (exit 1 before and after the adoption), and
// the declared containers are matched only because --param resolved the account.
test('CLI: --param resolves the storage account; without it the run cannot evaluate and exits 1', () => {
  const withParam = cli('--param', 'uniqueSuffix=kvwl3nywge4iw', fileURLToPath(RECORDED), repoBicep('main.bicep'));
  assert.equal(withParam.status, 1, withParam.stderr);
  assert.ok(withParam.stdout.includes('c18f71d7-f56e-501a-aa33-e441bd1c446f'), 'the vault grant is undeclared by main.bicep alone');
  assert.ok(!withParam.stdout.includes('6865e584-7148-58a9-9704-1ad4c3b55ec4'), 'staging-user-content is matched');
  assert.doesNotMatch(withParam.stdout, /could not evaluate/);

  const without = cli(fileURLToPath(RECORDED), repoBicep('main.bicep'));
  assert.equal(without.status, 1);
  assert.match(without.stdout, /could not evaluate: .*cannot be resolved to a full resource path/);

  const wrong = cli('--param', 'uniqueSuffix=aaaaaaaaaaaaa', fileURLToPath(RECORDED), repoBicep('main.bicep'), repoBicep('staging-keyvault.bicep'));
  assert.equal(wrong.status, 1);
  assert.ok(wrong.stdout.includes('6865e584-7148-58a9-9704-1ad4c3b55ec4'), 'a wrong suffix matches nothing on the real account');
});

test('CLI: bad input exits 2, never 0 (missing arguments, unreadable live file, malformed --param)', () => {
  assert.equal(cli().status, 2);
  assert.equal(cli('no-such-live.json', repoBicep('staging-keyvault.bicep')).status, 2);
  assert.equal(cli('--param', 'uniqueSuffix', fileURLToPath(RECORDED), repoBicep('staging-keyvault.bicep')).status, 2);
  assert.equal(cli(fileURLToPath(RECORDED), repoBicep('staging-keyvault.bicep'), '--param').status, 2);
});
