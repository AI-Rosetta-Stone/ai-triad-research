// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/537 (TL review): the protected list must not fall behind the workflows. This walks every
// workflow that produces a required check (or a verdict the enqueue reads), extracts each
// operations/devops script it names, and fails if one is not covered by isGateFile.
//
// Scope and limits, on purpose:
//   - Test files (*.test.mjs, *.Tests.ps1) are not required to be listed: they are the checks'
//     subject matter, reviewed as code.
//   - Only scripts NAMED in the workflow text are found. A module that a listed script imports
//     is not; GATE_SCRIPTS lists those by hand for the enqueue path.
//   - Scripts outside operations/devops are not walked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GATE_SCRIPTS, WORKFLOW_RUN_SCRIPTS, isGateFile } from './gate-file-change.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// The workflows whose results gate a merge: the four required contexts (ci-gate in ci.yml,
// CodeQL Analysis in codeql.yml, joint-gv-guard, consult-hold-guard) and the two the enqueue
// wrapper reads (t1-approval-guard, tier-check), and merge-approval (t/537, App-posted).
export const REQUIRED_CHECK_WORKFLOWS = [
  'ci.yml', 'codeql.yml', 'joint-gv-guard.yml', 'consult-hold-guard.yml', 't1-approval-guard.yml', 'tier-check.yml',
  'merge-approval.yml',
];

const SCRIPT_REF = /operations\/devops\/[A-Za-z0-9_./-]*\.(?:mjs|cjs|js|ps1|psm1|sh|py|json|ya?ml)\b/g;
const isTestFile = (p) => /\.test\.mjs$|\.Tests\.ps1$/.test(p);

/** Every operations/devops script named in a workflow's text, without test files. */
export function scriptsNamedIn(text) {
  return [...new Set(text.match(SCRIPT_REF) ?? [])].filter((p) => !isTestFile(p)).sort();
}

test('every required-check workflow exists (a renamed workflow must be re-listed here)', () => {
  for (const w of REQUIRED_CHECK_WORKFLOWS) {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, '.github', 'workflows', w)), `.github/workflows/${w} is missing`);
  }
});

test('every operations/devops script a required-check workflow names is protected', () => {
  const missing = [];
  let seen = 0;
  for (const w of REQUIRED_CHECK_WORKFLOWS) {
    const text = fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', w), 'utf8');
    for (const ref of scriptsNamedIn(text)) {
      seen += 1;
      if (!isGateFile(ref)) missing.push(`${w}: ${ref}`);
    }
  }
  assert.ok(seen > 20, `the walk found only ${seen} script reference(s); the extraction is broken`);
  assert.deepEqual(missing, [], 'add these to WORKFLOW_RUN_SCRIPTS in gate-file-change.mjs');
});

test('the walk finds a script that is named, and would report one that is not listed', () => {
  const found = scriptsNamedIn('run: node operations/devops/not-listed-anywhere.mjs\n  pwsh operations/devops/GateVerdict.ps1\n  node --test operations/devops/x.test.mjs');
  assert.deepEqual(found, ['operations/devops/GateVerdict.ps1', 'operations/devops/not-listed-anywhere.mjs']);
  assert.equal(isGateFile('operations/devops/not-listed-anywhere.mjs'), false);
  assert.equal(isGateFile('operations/devops/GateVerdict.ps1'), true);
});

test('the four scripts the TL named are protected', () => {
  for (const p of ['guard-pr-read.sh', 'GateVerdict.ps1', 'FlakeVerdict.ps1', 'cl-path-check-predicate.mjs']) {
    assert.equal(isGateFile(`operations/devops/${p}`), true, p);
  }
});

test('every listed script exists (a deleted or renamed script must leave the list)', () => {
  for (const p of [...GATE_SCRIPTS, ...WORKFLOW_RUN_SCRIPTS]) {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, p)), `${p} is listed but does not exist`);
  }
});
