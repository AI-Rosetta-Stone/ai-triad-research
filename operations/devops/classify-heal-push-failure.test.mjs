// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Run: node --test operations/devops/classify-heal-push-failure.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { classifyHealPushFailure } from './classify-heal-push-failure.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('matching stderr: "could not read Username" is credential_rejected', () => {
  assert.equal(classifyHealPushFailure(
    "remote: Invalid username or password.\nfatal: could not read Username for 'https://github.com': terminal prompts disabled\n",
  ), 'credential_rejected');
});

test('matching stderr: git\'s "returned error: 403" wording is credential_rejected', () => {
  assert.equal(classifyHealPushFailure(
    "fatal: unable to access 'https://github.com/...': The requested URL returned error: 403\n",
  ), 'credential_rejected');
});

test('matching stderr: "Permission to <repo> denied to <actor>" is credential_rejected', () => {
  assert.equal(classifyHealPushFailure(
    'remote: Permission to AI-Rosetta-Stone/ai-triad-research.git denied to dependabot-heal.\n',
  ), 'credential_rejected');
});

test('matching stderr: "Authentication failed" is credential_rejected', () => {
  assert.equal(classifyHealPushFailure(
    "fatal: Authentication failed for 'https://github.com/AI-Rosetta-Stone/ai-triad-research.git/'\n",
  ), 'credential_rejected');
});

test('non-matching stderr: a non-fast-forward rejection is "other"', () => {
  assert.equal(classifyHealPushFailure(
    "To https://github.com/AI-Rosetta-Stone/ai-triad-research.git\n ! [rejected]  HEAD -> branch (non-fast-forward)\nerror: failed to push some refs\n",
  ), 'other');
});

test('non-matching stderr: a network failure is "other"', () => {
  assert.equal(classifyHealPushFailure(
    "fatal: unable to access 'https://github.com/...': Could not resolve host: github.com\n",
  ), 'other');
});

test('empty/null/undefined output is "other" (never throws, never misclassifies as credential_rejected)', () => {
  assert.equal(classifyHealPushFailure(''), 'other');
  assert.equal(classifyHealPushFailure(null), 'other');
  assert.equal(classifyHealPushFailure(undefined), 'other');
});

// FAULT CHECK (Quality, p/780#52): a bare "403" boundary-matched on non-digit characters still
// matched inside a hex commit SHA like "9c1a403e" -- 'c'/'e' are non-digits, satisfying a
// `[^0-9]` boundary on either side even though they're ordinary hex digits, not separators.
// Fixed by matching git's actual, specific wording instead of a bare number.
test('FAULT CHECK: a non-fast-forward rejection containing a hex SHA with "403" inside it (e.g. 9c1a403e) does not false-positive', () => {
  assert.equal(classifyHealPushFailure(
    'To https://github.com/AI-Rosetta-Stone/ai-triad-research.git\n' +
    ' ! [rejected]  main -> main (fetch first)\n' +
    "error: failed to push some refs to 'https://github.com/...'\n" +
    'hint: Updates were rejected because the remote contains work that you do\n' +
    'hint: not have locally. This is usually caused by another repository pushing\n' +
    'hint: to the same ref. You may want to first integrate the remote changes\n' +
    '(e.g., \'git pull ...\') before pushing again.\n' +
    'remote commit 9c1a403e is ahead of local HEAD\n',
  ), 'other');
});

test('FAULT CHECK: "403" embedded in a longer decimal number (e.g. 14035, 4033) does not false-positive', () => {
  assert.equal(classifyHealPushFailure('14035 insertions, 4033 deletions'), 'other');
});

test('FAULT CHECK: a plain, unrelated git error containing none of the three patterns stays "other"', () => {
  assert.equal(classifyHealPushFailure('error: src refspec HEAD does not match any'), 'other');
});

// CLI wiring: the workflow invokes this as `node classify-heal-push-failure.mjs` reading stdin.
test('CLI: reads stdin and prints the classification with no trailing newline', () => {
  const scriptPath = fileURLToPath(new URL('./classify-heal-push-failure.mjs', import.meta.url));
  const out = execFileSync('node', [scriptPath], { input: 'fatal: could not read Username for ...', encoding: 'utf8' });
  assert.equal(out, 'credential_rejected');
});

test('CLI: "other" case via stdin', () => {
  const scriptPath = fileURLToPath(new URL('./classify-heal-push-failure.mjs', import.meta.url));
  const out = execFileSync('node', [scriptPath], { input: 'error: failed to push some refs', encoding: 'utf8' });
  assert.equal(out, 'other');
});

// Workflow wiring (t/4137 item 3): the "Commit and push heal" step actually invokes this
// predicate and emits the two distinct error messages -- guards against the step drifting
// away from this module (e.g. someone inlining a different regex ad hoc).
test('workflow wiring: dependabot-lockfile-heal.yml invokes classify-heal-push-failure.mjs and names both error messages', () => {
  const workflow = readFileSync(join(__dirname, '..', '..', '.github', 'workflows', 'dependabot-lockfile-heal.yml'), 'utf8');
  const pushStart = workflow.indexOf('Commit and push heal');
  assert.ok(pushStart > -1, 'step "Commit and push heal" not found');
  const nextStepIdx = workflow.indexOf('\n      - name:', pushStart);
  const stepBody = workflow.slice(pushStart, nextStepIdx > -1 ? nextStepIdx : workflow.length);
  assert.match(stepBody, /node operations\/devops\/classify-heal-push-failure\.mjs/);
  assert.match(stepBody, /::error::heal credential rejected/);
  assert.match(stepBody, /::error::heal push failed/);
  // Quality must-fix (p/780#52): the step must capture the push's real exit code with
  // `&&`/`||`, never the `if ! CMD; then ... $? ...` shape -- `$?` inside that block always
  // reads 0 (entering the then-branch already means the negation evaluated true), so the
  // step would always log "exit 0" on a genuine push failure. Empirically confirmed: see the
  // bash-level proof in the PR description.
  assert.match(stepBody, /&&\s*PUSH_EXIT=0\s*\|\|\s*PUSH_EXIT=\$\?/);
  assert.doesNotMatch(stepBody, /if\s*!\s*PUSH_OUTPUT=/, 'the buggy if-!-then shape must not reappear');
});
