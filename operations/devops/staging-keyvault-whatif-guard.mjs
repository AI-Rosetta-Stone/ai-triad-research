// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/92 (TL p/12#227): decides whether a what-if of deploy/azure/staging-keyvault.bicep may proceed.
// Same approach as staging-data-account-whatif-guard.mjs: it parses the JSON changeType values and does
// not search the text. A resource-group what-if lists EVERY resource in the group as "Ignore"
// (including the shared prod vault), so Ignore is never a finding. Only Create, Modify, Delete and
// Deploy count.
//
// Allowed, exactly three Creates (TL: "only the staging vault, its diagnostics and the one role"):
//   - the vault kv-ait-stg-kvwl3nywge4iw
//   - its diagnostic setting kv-audit-logs
//   - one role assignment scoped to that vault, Key Vault Secrets Officer
// Anything else fails closed: any Modify/Delete/Deploy, an extra or missing Create, a role assignment
// with another role or another scope, anything naming the shared vault kv-ait-kvwl3nywge4iw, a status
// other than Succeeded, or a non-null error.
//
// The role must also grant staging's identity and no other (SO p/44#102): the workflow reads the staging
// app's principal id live and passes it; an unresolved or different principalId stops.
//
// A SECOND apply fails closed by design: once the vault exists the what-if shows NoChange, not three
// Creates. Re-applying is not a routine operation; a deliberate change to the vault goes through review.
//
// Usage: node staging-keyvault-whatif-guard.mjs <what-if.json> <staging principal id>   (exit 0 = pass, 1 = stop)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SHARED_VAULT = 'kv-ait-kvwl3nywge4iw';
export const STAGING_VAULT = 'kv-ait-stg-kvwl3nywge4iw';
export const KV_SECRETS_OFFICER_ROLE_ID = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7';
const RG = 'ai-triad';
const VAULT_ID = `/resourcegroups/${RG}/providers/microsoft.keyvault/vaults/${STAGING_VAULT}`;
const DIAG_ID = `${VAULT_ID}/providers/microsoft.insights/diagnosticsettings/kv-audit-logs`;
const ROLE_PREFIX = `${VAULT_ID}/providers/microsoft.authorization/roleassignments/`;

const normalise = (id) => String(id ?? '').toLowerCase().replace(/^\/subscriptions\/[^/]+/, '');
/** True when `id` names the SHARED vault (exact segment match, so kv-ait-stg-... never matches). */
const namesSharedVault = (id) => /\/vaults\/kv-ait-kvwl3nywge4iw(\/|$)/i.test(String(id ?? ''));

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PURE. Returns { pass, reasons[] } for a parsed what-if result object.
 * expectedPrincipalId (SO p/44#102): the staging app's identity, read live by the workflow. When given,
 * the role's principalId must equal it; an unreadable or unresolved principalId fails closed.
 */
export function checkWhatIf(result, { expectedPrincipalId = null } = {}) {
  const reasons = [];
  if (!result || typeof result !== 'object') return { pass: false, reasons: ['what-if output is not an object'] };
  if (result.error) reasons.push(`what-if reported an error: ${JSON.stringify(result.error)}`);
  if (result.status !== 'Succeeded') reasons.push(`what-if status is '${result.status}', not 'Succeeded'`);
  if (!Array.isArray(result.changes)) reasons.push('what-if output has no changes array');

  const changes = Array.isArray(result.changes) ? result.changes : [];
  const counted = changes.filter((c) => ['Create', 'Modify', 'Delete', 'Deploy'].includes(c.changeType));
  for (const c of counted) {
    if (c.changeType !== 'Create') reasons.push(`${c.changeType} on ${c.resourceId}: only Create is allowed`);
  }
  const creates = counted.filter((c) => c.changeType === 'Create');
  let vault = 0; let diag = 0; let roles = 0;
  for (const c of creates) {
    const id = normalise(c.resourceId);
    if (id === VAULT_ID) { vault += 1; continue; }
    if (id === DIAG_ID) { diag += 1; continue; }
    if (id.startsWith(ROLE_PREFIX) && !id.slice(ROLE_PREFIX.length).includes('/')) {
      roles += 1;
      const roleDef = String(c.after?.properties?.roleDefinitionId ?? '').toLowerCase();
      if (!roleDef.endsWith(`/roledefinitions/${KV_SECRETS_OFFICER_ROLE_ID}`)) {
        reasons.push(`role assignment ${id} is not Key Vault Secrets Officer (roleDefinitionId '${roleDef || 'unreadable'}')`);
      }
      if (expectedPrincipalId !== null) {
        const principal = String(c.after?.properties?.principalId ?? '');
        if (!GUID_RE.test(principal)) {
          reasons.push(`role assignment ${id}: principalId '${principal || 'unreadable'}' is not a resolved id, cannot confirm it is staging's identity`);
        } else if (principal.toLowerCase() !== String(expectedPrincipalId).toLowerCase()) {
          reasons.push(`role assignment ${id} grants principal ${principal}, not staging's identity ${expectedPrincipalId}`);
        }
      }
      continue;
    }
    reasons.push(`unexpected Create: ${id}`);
  }
  if (vault !== 1) reasons.push(`expected exactly 1 Create of the staging vault ${STAGING_VAULT}, got ${vault}`);
  if (diag !== 1) reasons.push(`expected exactly 1 Create of the vault's kv-audit-logs diagnostic setting, got ${diag}`);
  if (roles !== 1) reasons.push(`expected exactly 1 role assignment on the staging vault, got ${roles}`);
  for (const c of changes) {
    if (c.changeType === 'Ignore') continue;
    if (namesSharedVault(c.resourceId)) reasons.push(`${c.changeType} names the shared vault ${SHARED_VAULT}: stop`);
  }
  return { pass: reasons.length === 0, reasons };
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCli) {
  const [file, expectedPrincipalId] = process.argv.slice(2);
  if (!file || !expectedPrincipalId || !GUID_RE.test(expectedPrincipalId)) {
    console.error('usage: staging-keyvault-whatif-guard.mjs <what-if.json> <staging app principal id (GUID)>');
    console.error('::error::what-if guard: the staging principal id is missing or not a GUID. Nothing is applied.');
    process.exit(1);
  }
  let parsed;
  try { parsed = JSON.parse(readFileSync(file, 'utf8')); } catch (err) {
    console.error(`::error::what-if guard: could not read or parse ${file} (${err.message}). Nothing is applied.`);
    process.exit(1);
  }
  const verdict = checkWhatIf(parsed, { expectedPrincipalId });
  if (verdict.pass) {
    console.log(`what-if guard PASS: exactly the three expected Creates (vault ${STAGING_VAULT}, its kv-audit-logs, one Secrets Officer role); Ignore lines not counted.`);
  } else {
    for (const r of verdict.reasons) console.error(`::error::what-if guard: ${r}`);
    console.error('what-if guard STOP: nothing is applied.');
    process.exit(1);
  }
}
