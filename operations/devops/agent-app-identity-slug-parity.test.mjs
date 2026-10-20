// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Parity: the reviewer bot login the t1-approval-guard workflow trusts
// (REVIEWER_APP_LOGIN) must be the GitHub App slug AgentAppToken.psm1 actually
// mints tokens for (t/4096#65, TL follow-up). If the two drift apart, the guard
// silently stops recognizing real reviewer-App approvals (or starts trusting a
// stale/wrong bot login) with no test to catch it. This reads both real files
// (test == runtime), so they cannot drift apart silently.
// Run:  node --test operations/devops/agent-app-identity-slug-parity.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GUARD_WORKFLOW = path.join(ROOT, '.github', 'workflows', 't1-approval-guard.yml');
const APP_TOKEN_MODULE = path.join(ROOT, 'operations', 'devops', 'AgentAppToken.psm1');

function reviewerAppLoginFromGuard() {
  const text = readFileSync(GUARD_WORKFLOW, 'utf8');
  const m = text.match(/REVIEWER_APP_LOGIN\s*=\s*'([^']+)'/);
  assert.ok(m, 'REVIEWER_APP_LOGIN not found in t1-approval-guard.yml — did the constant get renamed?');
  return m[1];
}

function reviewerSlugFromAppToken() {
  const text = readFileSync(APP_TOKEN_MODULE, 'utf8');
  const m = text.match(/reviewer\s*=\s*@\{[^}]*Slug\s*=\s*'([^']+)'/s);
  assert.ok(m, "reviewer role Slug not found in AgentAppToken.psm1 — did \$script:AgentApps change shape?");
  return m[1];
}

test('t1-approval-guard REVIEWER_APP_LOGIN matches the reviewer App slug AgentAppToken.psm1 mints for', () => {
  const guardLogin = reviewerAppLoginFromGuard();
  const tokenSlug = reviewerSlugFromAppToken();
  assert.equal(guardLogin, `${tokenSlug}[bot]`,
    `guard trusts '${guardLogin}' but AgentAppToken.psm1 mints tokens for '${tokenSlug}' -- these must name the same bot`);
});

test('red arm: a renamed reviewer slug would make the parity check above fail', () => {
  // Proves this suite can fail: had the module's slug drifted (e.g. an org-move rename),
  // the guard's hardcoded login would stop matching real reviewer-App reviews.
  const guardLogin = reviewerAppLoginFromGuard();
  const driftedSlug = 'ai-triad-reviewer-jpsnover-renamed';
  assert.notEqual(guardLogin, `${driftedSlug}[bot]`);
});
