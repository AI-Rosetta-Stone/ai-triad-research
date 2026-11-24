// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/463 (SO p/59#115): the what-if guard, tested against a REAL what-if output (fixture captured
// 2026-11-23 from the staging-only module, read-only). Run: node --test operations/devops/staging-data-account-whatif-guard.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkWhatIf, PROD_ACCOUNT } from './staging-data-account-whatif-guard.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const real = JSON.parse(readFileSync(path.join(here, 'fixtures', 'staging-data-account-whatif.json'), 'utf8'));
const clone = () => structuredClone(real);
const ACCOUNT_ID = real.changes.find((c) => c.changeType === 'Create' && !c.resourceId.includes('/shares/')).resourceId;
const SHARE_ID = real.changes.find((c) => c.changeType === 'Create' && c.resourceId.includes('/shares/')).resourceId;

test('the real what-if output passes: exactly the two expected Creates, Ignore lines not counted', () => {
  const v = checkWhatIf(clone());
  assert.equal(v.pass, true, v.reasons.join('; '));
});

test('the real output contains the prod account as an Ignore line, and that alone does not stop the run', () => {
  const ignores = real.changes.filter((c) => c.changeType === 'Ignore' && c.resourceId.includes(PROD_ACCOUNT));
  assert.ok(ignores.length >= 1, 'fixture should contain the prod account as Ignore');
  assert.equal(checkWhatIf(clone()).pass, true);
});

test('a Delete anywhere fails the run', () => {
  const r = clone();
  r.changes.push({ changeType: 'Delete', resourceId: '/subscriptions/x/resourceGroups/ai-triad/providers/Microsoft.App/containerApps/taxonomy-editor' });
  const v = checkWhatIf(r);
  assert.equal(v.pass, false);
  assert.match(v.reasons.join(' '), /Delete/);
});

test('a Modify anywhere fails the run', () => {
  const r = clone();
  r.changes.push({ changeType: 'Modify', resourceId: '/subscriptions/x/resourceGroups/ai-triad/providers/Microsoft.Storage/storageAccounts/staitriadkvwl3nywge4iw' });
  const v = checkWhatIf(r);
  assert.equal(v.pass, false);
  assert.match(v.reasons.join(' '), /Modify/);
});

test('a Create of the prod account fails the run (it is not an expected Create)', () => {
  const r = clone();
  r.changes.push({ changeType: 'Create', resourceId: `/subscriptions/x/resourceGroups/ai-triad/providers/Microsoft.Storage/storageAccounts/${PROD_ACCOUNT}` });
  const v = checkWhatIf(r);
  assert.equal(v.pass, false);
  assert.match(v.reasons.join(' '), /unexpected Create/);
});

test('an extra Create fails the run, even when it is not the prod account', () => {
  const r = clone();
  r.changes.push({ changeType: 'Create', resourceId: '/subscriptions/x/resourceGroups/ai-triad/providers/Microsoft.Storage/storageAccounts/staitriadstg19/fileServices/default/shares/extra' });
  assert.equal(checkWhatIf(r).pass, false);
});

test('a missing expected Create fails the run (the share is absent)', () => {
  const r = clone();
  r.changes = r.changes.filter((c) => c.resourceId !== SHARE_ID);
  const v = checkWhatIf(r);
  assert.equal(v.pass, false);
  assert.match(v.reasons.join(' '), /expected Create missing/);
});

test('a what-if error or a non-Succeeded status fails the run', () => {
  const e = clone(); e.error = { code: 'X', message: 'boom' };
  assert.equal(checkWhatIf(e).pass, false);
  const s = clone(); s.status = 'Failed';
  assert.equal(checkWhatIf(s).pass, false);
});

test('a missing changes array fails closed', () => {
  const r = clone(); delete r.changes;
  assert.equal(checkWhatIf(r).pass, false);
});

test('the two expected Creates are the account and its share, both on staitriadstg19 (sanity)', () => {
  assert.match(ACCOUNT_ID, /storageAccounts\/staitriadstg19$/);
  assert.match(SHARE_ID, /storageAccounts\/staitriadstg19\/fileServices\/default\/shares\/taxonomy-data-staging$/);
});
