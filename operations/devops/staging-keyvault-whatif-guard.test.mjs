// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/92: both arms of the staging Key Vault what-if guard.
// Run: node --test operations/devops/staging-keyvault-whatif-guard.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { checkWhatIf, KV_SECRETS_OFFICER_ROLE_ID } from './staging-keyvault-whatif-guard.mjs';

const SUB = '/subscriptions/ba91d835-ea25-49fe-9a86-a2694201ae21';
const VAULT = `${SUB}/resourceGroups/ai-triad/providers/Microsoft.KeyVault/vaults/kv-ait-stg-kvwl3nywge4iw`;
const SHARED = `${SUB}/resourceGroups/ai-triad/providers/Microsoft.KeyVault/vaults/kv-ait-kvwl3nywge4iw`;
const roleDef = (id) => `${SUB}/providers/Microsoft.Authorization/roleDefinitions/${id}`;
const role = (scope = VAULT, def = KV_SECRETS_OFFICER_ROLE_ID) => ({
  changeType: 'Create',
  resourceId: `${scope}/providers/Microsoft.Authorization/roleAssignments/0b3c9f8e-1111-2222-3333-444455556666`,
  after: { properties: { roleDefinitionId: roleDef(def) } },
});
const clean = () => ({
  status: 'Succeeded',
  error: null,
  changes: [
    { changeType: 'Create', resourceId: VAULT },
    { changeType: 'Create', resourceId: `${VAULT}/providers/Microsoft.Insights/diagnosticSettings/kv-audit-logs` },
    role(),
    // A resource-group what-if lists every other resource as Ignore, the shared vault included.
    { changeType: 'Ignore', resourceId: SHARED },
    { changeType: 'Ignore', resourceId: `${SUB}/resourceGroups/ai-triad/providers/Microsoft.App/containerApps/taxonomy-editor-staging` },
  ],
});

test('PASS: exactly the vault, its diagnostics and one Secrets Officer role; Ignore lines (shared vault too) are not findings', () => {
  const v = checkWhatIf(clean());
  assert.equal(v.pass, true, v.reasons.join('; '));
});

test('STOP: any Modify or Delete, including on the shared vault', () => {
  for (const changeType of ['Modify', 'Delete', 'Deploy']) {
    const r = clean();
    r.changes.push({ changeType, resourceId: SHARED });
    const v = checkWhatIf(r);
    assert.equal(v.pass, false, changeType);
    assert.ok(v.reasons.some((x) => x.includes('names the shared vault')), changeType);
  }
});

test('STOP: a role assignment with another role (Secrets User) or on another scope (the shared vault)', () => {
  const wrongRole = clean(); wrongRole.changes[2] = role(VAULT, '4633458b-17de-408a-b874-0445c86b69e6');
  assert.match(checkWhatIf(wrongRole).reasons.join('; '), /not Key Vault Secrets Officer/);
  const wrongScope = clean(); wrongScope.changes[2] = role(SHARED);
  const v = checkWhatIf(wrongScope);
  assert.equal(v.pass, false);
  assert.ok(v.reasons.some((x) => /unexpected Create/.test(x)));
  assert.ok(v.reasons.some((x) => /expected exactly 1 role assignment/.test(x)));
});

test('STOP: an extra Create, a missing Create, or a second role', () => {
  const extra = clean(); extra.changes.push({ changeType: 'Create', resourceId: `${SUB}/resourceGroups/ai-triad/providers/Microsoft.Storage/storageAccounts/x` });
  assert.match(checkWhatIf(extra).reasons.join('; '), /unexpected Create/);
  const missing = clean(); missing.changes.splice(1, 1);
  assert.match(checkWhatIf(missing).reasons.join('; '), /kv-audit-logs diagnostic setting, got 0/);
  const twoRoles = clean(); twoRoles.changes.push(role());
  assert.match(checkWhatIf(twoRoles).reasons.join('; '), /exactly 1 role assignment on the staging vault, got 2/);
});

test('STOP: a failed status, a non-null error, no changes array, an unreadable role definition, or a non-object', () => {
  const failed = clean(); failed.status = 'Failed';
  assert.equal(checkWhatIf(failed).pass, false);
  const errored = clean(); errored.error = { code: 'X' };
  assert.equal(checkWhatIf(errored).pass, false);
  assert.equal(checkWhatIf({ status: 'Succeeded', error: null }).pass, false);
  const noDef = clean(); delete noDef.changes[2].after;
  assert.match(checkWhatIf(noDef).reasons.join('; '), /unreadable/);
  for (const bad of [null, undefined, 'x', 42]) assert.equal(checkWhatIf(bad).pass, false, String(bad));
});

test('the staging vault name never matches the shared-vault check (kv-ait-stg-... is not kv-ait-...)', () => {
  const v = checkWhatIf(clean());
  assert.ok(!v.reasons.some((x) => x.includes('shared vault')));
});

// t/92 (SO p/44#99): main.bicep pins staging's AZURE_KEYVAULT_URL to a literal (so the env sync can
// enforce it, and prod never depends on the staging vault). The literal must name the vault the
// staging module creates, and the shared vault must never be allowed.
test('main.bicep stagingKeyVaultUrl is @allowed-pinned to exactly the vault staging-keyvault.bicep creates', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const path = (await import('node:path')).default;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const main = readFileSync(path.join(root, 'deploy', 'azure', 'main.bicep'), 'utf8');
  const mod = readFileSync(path.join(root, 'deploy', 'azure', 'staging-keyvault.bicep'), 'utf8');
  const vaultName = /param vaultName string = '([^']+)'/.exec(mod)?.[1];
  assert.equal(vaultName, 'kv-ait-stg-kvwl3nywge4iw');
  const expected = `https://${vaultName}.vault.azure.net/`;
  const allowed = /@allowed\(\[\s*'([^']+)'\s*\]\)\s*param stagingKeyVaultUrl string = '([^']+)'/.exec(main);
  assert.ok(allowed, 'stagingKeyVaultUrl must carry a single-value @allowed');
  assert.equal(allowed[1], expected, '@allowed value');
  assert.equal(allowed[2], expected, 'default value');
  assert.match(main, /\{ name: 'AZURE_KEYVAULT_URL', value: stagingKeyVaultUrl \}/, 'staging override uses the pinned param');
  assert.doesNotMatch(main, /existing[^\n]*kv-ait-stg|stagingKeyVault\b[^\n]*existing/, 'main.bicep must not reference the staging vault as existing');
  assert.doesNotMatch(main, /empty\(githubAppPrivateKeySecretNameStaging\)/, 'no fallback to the prod key name');
});
