// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/667 (incident): every workflow that runs operations/devops modules from a PARTIAL copy of the repo
// must carry each module's whole local import closure. #5522 made tier-check-predicate.mjs import
// ./role-review-verdicts.mjs; merge-approval.yml's sparse checkout did not list it, so the check
// failed with ERR_MODULE_NOT_FOUND on every PR and on main. These tests read each workflow's own list
// (the sparse-checkout block, or the files it writes into its temp dir) and walk the real imports
// (gate-path-walk.mjs), failing by name on a module the workflow would not have.
// Run: node --test operations/devops/workflow-module-closure.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listRepoFiles, readRepoText, walkDependencies } from './gate-path-walk.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILES = new Set(listRepoFiles(ROOT));
const read = (rel) => readRepoText(ROOT, rel);
const wf = (name) => fs.readFileSync(path.join(ROOT, '.github', 'workflows', name), 'utf8');

/** The import closure of `starts` (repo-relative), starts included. */
function closure(starts) {
  return new Set([...starts, ...walkDependencies(starts, read, FILES).keys()]);
}

/** PURE. The paths of the first `sparse-checkout: |` block after `marker`. */
export function sparseList(yml, marker) {
  const at = yml.indexOf(marker);
  assert.ok(at >= 0, `marker not found: ${marker}`);
  const m = /sparse-checkout: \|\n((?:[ \t]+\S[^\n]*\n)+)/.exec(yml.slice(at));
  assert.ok(m, `no sparse-checkout block after ${marker}`);
  return m[1].split('\n').map((l) => l.trim()).filter(Boolean);
}

test('merge-approval.yml: its sparse checkout holds the whole import closure of the modules its Evaluate step imports', () => {
  const yml = wf('merge-approval.yml');
  const listed = new Set(sparseList(yml, 'Check out the default branch only'));
  // The modules the Evaluate step imports from the checkout dir (`path.join(dir, '<file>')`).
  const entries = [...yml.matchAll(/import\(pathToFileURL\(path\.join\(dir, '([^']+\.mjs)'\)\)/g)].map((m) => `operations/devops/${m[1]}`);
  assert.ok(entries.includes('operations/devops/merge-approval-run.mjs'), `entries: ${entries.join(', ')}`);
  const missing = [...closure(entries)].filter((f) => !listed.has(f));
  assert.deepEqual(missing, [], `merge-approval.yml's sparse-checkout lacks: ${missing.join(', ')}`);
});

for (const [workflow, predicate] of [['tier-check.yml', 'tier-check-predicate.mjs'], ['t1-approval-guard.yml', 't1-approval-guard-predicate.mjs']]) {
  test(`${workflow}: the temp dir it loads ${predicate} from gets every module the predicate imports`, () => {
    const yml = wf(workflow);
    // Files the workflow writes beside the predicate: path.join(tmpDir, '<file>').
    const written = new Set([...yml.matchAll(/path\.join\(tmpDir, '([^']+\.mjs)'\)/g)].map((m) => `operations/devops/${m[1]}`));
    assert.ok(written.has(`operations/devops/${predicate}`), `${workflow} does not write ${predicate} into tmpDir`);
    // t/674 item 4: tier-check.yml walks the predicate's local import closure from the base tip at run time
    // (every module it finds is written to tmpDir), so no list can go stale. Pin that the walk is there.
    if (/const closure = new Map\(\[\['tier-check-predicate\.mjs'/.test(yml)) {
      assert.match(yml, /matchAll\(\/\(\?:from\|import\)\\s\*\['"\]\\\.\\\/\(\[A-Za-z0-9\._-\]\+\\\.mjs\)/, 'the walk follows ./x.mjs imports');
      assert.match(yml, /for \(const \[name, text\] of closure\) fs\.writeFileSync\(path\.join\(tmpDir, name\), text\)/, 'every module found is written to tmpDir');
      return;
    }
    const missing = [...closure([`operations/devops/${predicate}`])].filter((f) => !written.has(f));
    assert.deepEqual(missing, [], `${workflow} does not copy into tmpDir: ${missing.join(', ')}`);
  });
}

test('red arm: without role-review-verdicts.mjs the merge-approval list is reported as missing it, by name', () => {
  const yml = wf('merge-approval.yml').replace(/\n[ \t]+operations\/devops\/role-review-verdicts\.mjs/, '');
  const listed = new Set(sparseList(yml, 'Check out the default branch only'));
  const missing = [...closure(['operations/devops/merge-approval-run.mjs'])].filter((f) => !listed.has(f));
  assert.deepEqual(missing, ['operations/devops/role-review-verdicts.mjs']);
});
