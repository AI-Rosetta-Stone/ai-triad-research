// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/463 (SO p/59#115, TL p/9#383): decides whether a what-if of deploy/azure/staging-data-account.bicep
// may proceed. It parses the JSON changeType values; it does not search the text. The what-if of a
// resource group lists EVERY resource in it as changeType "Ignore" (including the prod account), so
// Ignore lines are never a finding. Only Create, Modify, Delete and Deploy count.
//
// Allowed set, exactly: two Create changes, the new account staitriadstg19 and its share
// taxonomy-data-staging. Anything else (any Modify or Delete, any extra Create, any change that names
// the prod account, a failed status, or a non-null error) fails closed.
//
// Usage: node staging-data-account-whatif-guard.mjs <what-if.json>   (exit 0 = pass, 1 = stop)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PROD_ACCOUNT = 'staitriadkvwl3nywge4iw';
const RG = 'ai-triad';
const ACCOUNT = 'staitriadstg19';
const SHARE = 'taxonomy-data-staging';
const EXPECTED_CREATES = [
  `/resourceGroups/${RG}/providers/Microsoft.Storage/storageAccounts/${ACCOUNT}`,
  `/resourceGroups/${RG}/providers/Microsoft.Storage/storageAccounts/${ACCOUNT}/fileServices/default/shares/${SHARE}`,
];

const normalise = (id) => String(id ?? '').toLowerCase().replace(/^\/subscriptions\/[^/]+/, '');

/** PURE. Returns { pass, reasons[] } for a parsed what-if result object. */
export function checkWhatIf(result) {
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
  const creates = counted.filter((c) => c.changeType === 'Create').map((c) => normalise(c.resourceId));
  const expected = EXPECTED_CREATES.map(normalise);
  for (const id of creates) {
    if (!expected.includes(id)) reasons.push(`unexpected Create: ${id}`);
  }
  for (const id of expected) {
    if (!creates.includes(id)) reasons.push(`expected Create missing: ${id}`);
  }
  for (const c of changes) {
    if (c.changeType === 'Ignore') continue;
    if (String(c.resourceId ?? '').toLowerCase().includes(PROD_ACCOUNT)) {
      reasons.push(`${c.changeType} names the prod account ${PROD_ACCOUNT}: stop`);
    }
  }
  return { pass: reasons.length === 0, reasons };
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCli) {
  const file = process.argv[2];
  if (!file) { console.error('usage: staging-data-account-whatif-guard.mjs <what-if.json>'); process.exit(1); }
  const verdict = checkWhatIf(JSON.parse(readFileSync(file, 'utf8')));
  if (verdict.pass) {
    console.log('what-if guard PASS: exactly the two expected Creates (staitriadstg19 and its share); Ignore lines not counted.');
  } else {
    for (const r of verdict.reasons) console.error(`::error::what-if guard: ${r}`);
    console.error('what-if guard STOP: nothing is applied.');
    process.exit(1);
  }
}
