// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/537 (TL review): the protected list must not fall behind the workflows. This walks every
// workflow that produces a required check (or a verdict the enqueue reads), extracts each
// operations/devops script it names, and fails if one is not covered by isGateFile.
//
// The first walk below is the original t/537 one (operations/devops scripts only, test files
// skipped). t/543 adds two wider walks:
//   - every repo file a required-check workflow (or a composite action) names must be protected
//     by isGateFile or listed in CODE_UNDER_TEST (deliberately unprotected product code or tests);
//   - every repo file a protected script imports, dot-sources, sources or runs, transitively
//     through protected files, must be protected or listed in CODE_UNDER_TEST. The walk does not
//     descend into CODE_UNDER_TEST files: what product code loads is product code.
// The extraction and the resolver live in gate-path-walk.mjs (limits listed there).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODE_UNDER_TEST, GATE_SCRIPTS, VERDICT_SCRIPTS, WORKFLOW_RUN_SCRIPTS, isGateFile } from './gate-file-change.mjs';
import { listRepoFiles, localDependenciesOf, pathsNamedInWorkflow, readRepoText, walkDependencies } from './gate-path-walk.mjs';

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

// ---------------------------------------------------------------------------------------------
// t/543: the wider walks.

let repoFiles = null;
const files = () => (repoFiles ??= listRepoFiles(REPO_ROOT));
const classified = (p) => isGateFile(p) || CODE_UNDER_TEST.includes(p);
const NEXT = 'classify each one in gate-file-change.mjs: VERDICT_SCRIPTS (or GATE_SCRIPTS/WORKFLOW_RUN_SCRIPTS under ' +
  'operations/devops) when it decides or can change a check verdict without product code changing; CODE_UNDER_TEST ' +
  '(with a one-line reason) when it is product code or a test of it';

/** The six workflows plus every composite action under .github/actions (they run inside those workflows). */
export function workflowLikeFiles(fileSet) {
  const actions = [...fileSet].filter((f) => /^\.github\/actions\/.+\/action\.ya?ml$/.test(f)).sort();
  return [...REQUIRED_CHECK_WORKFLOWS.map((w) => `.github/workflows/${w}`), ...actions];
}

test('t/543: every repo file a required-check workflow or composite action names is protected or CODE_UNDER_TEST', () => {
  const fileSet = files();
  const unclassified = [];
  let seen = 0;
  for (const w of workflowLikeFiles(fileSet)) {
    const text = readRepoText(REPO_ROOT, w);
    assert.ok(text != null, `${w} could not be read`);
    for (const { path: p, line } of pathsNamedInWorkflow(text, fileSet)) {
      seen += 1;
      if (!classified(p)) unclassified.push(`${p}  (named in ${w}:${line})`);
    }
  }
  assert.ok(seen > 100, `the walk found only ${seen} named repo file(s); the extraction is broken`);
  assert.deepEqual(unclassified, [], `unclassified repo files named in required-check workflows; ${NEXT}`);
});

test('t/543: every file a protected script loads or runs, transitively, is protected or CODE_UNDER_TEST', () => {
  const fileSet = files();
  const starts = [...fileSet].filter(isGateFile).sort();
  const read = (f) => {
    const text = readRepoText(REPO_ROOT, f);
    if (text == null) console.warn(`WARN gate-file-change.test: git tracks ${f} but it could not be read; its imports are not walked`);
    return text;
  };
  const edges = starts.reduce((n, f) => n + localDependenciesOf(f, read(f) ?? '', fileSet).length, 0);
  assert.ok(edges > 50, `the protected files load only ${edges} repo file(s) between them; the resolver is broken`);
  const reached = walkDependencies(starts, read, fileSet, { descend: isGateFile });
  const unclassified = [...reached].filter(([p]) => !classified(p)).map(([p, from]) => `${p}  (loaded by ${from})`).sort();
  assert.deepEqual(unclassified, [], `unprotected files loaded by protected scripts; ${NEXT}`);
});

test('t/543: every VERDICT_SCRIPTS and CODE_UNDER_TEST entry exists, once, and no path is both protected and CODE_UNDER_TEST', () => {
  const fileSet = files();
  for (const p of [...VERDICT_SCRIPTS, ...CODE_UNDER_TEST]) {
    assert.ok(fileSet.has(p), `${p} is listed in gate-file-change.mjs but git does not track it (deleted or renamed?)`);
  }
  const dupes = (xs) => xs.filter((x, i) => xs.indexOf(x) !== i);
  assert.deepEqual(dupes(VERDICT_SCRIPTS), [], 'VERDICT_SCRIPTS lists a path twice');
  assert.deepEqual(dupes(CODE_UNDER_TEST), [], 'CODE_UNDER_TEST lists a path twice');
  assert.deepEqual(CODE_UNDER_TEST.filter(isGateFile), [], 'these CODE_UNDER_TEST paths are also protected; keep each path in one class');
  assert.deepEqual(VERDICT_SCRIPTS.filter((p) => p.startsWith('operations/devops/') || p.startsWith('.github/')), [],
    'VERDICT_SCRIPTS is for paths outside operations/devops and .github; use GATE_SCRIPTS/WORKFLOW_RUN_SCRIPTS or GATE_PREFIXES');
});

test('t/543: the new prefixes and a VERDICT_SCRIPTS entry are protected; CODE_UNDER_TEST is not', () => {
  assert.equal(isGateFile('.github/scripts/check-control-chars.mjs'), true);
  assert.equal(isGateFile('.github/codeql/codeql-config.yml'), true);
  assert.equal(isGateFile('./scripts/check-quality-gates.sh'), true);
  assert.equal(isGateFile(CODE_UNDER_TEST[0]), false);
});
