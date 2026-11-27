// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/799 (Security p/131#101, t/799#2): `actions/checkout ref: ${{ github.head_ref }}` takes the branch TIP at run time, so
// a re-run of an earlier event (or a writer's later push) runs a different tree from the one the event saw. Every checkout
// of PR content takes `github.event.pull_request.head.sha` (immutable per event). This pins it across all workflows.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WF_DIR = path.join(ROOT, '.github', 'workflows');
const files = fs.readdirSync(WF_DIR).filter((f) => f.endsWith('.yml')).sort();

/** PURE. Every `actions/checkout` step's `with:` refs: [{ file, line, ref }]. */
export function checkoutRefs(file, text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  lines.forEach((l, i) => {
    if (!/uses:\s*actions\/checkout@/.test(l)) return;
    const indent = l.search(/\S/);
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j];
      if (t.trim() !== '' && t.search(/\S/) < indent) break;
      if (/^\s*-\s+(name|uses|run):/.test(t) && t.search(/\S/) <= indent) break;
      const m = /^\s+ref:\s*(.*?)\s*(?:#.*)?$/.exec(t);
      if (m) out.push({ file, line: j + 1, ref: m[1] });
    }
  });
  return out;
}

/** PURE. The refs that name a PR's head by branch name (or its pull ref): a tip that moves. */
export function movingPrRefs(refs) {
  return refs.filter(({ ref }) => /github\.head_ref|pull_request\.head\.ref|pull_request\.head\.label|workflow_run\.head_branch|refs\/pull\/|github\.ref_name|github\.ref\b/.test(ref));
}

test('t/799: no workflow checks out a PR by branch name or pull ref; every PR-content checkout is the event\'s head.sha', () => {
  const all = files.flatMap((f) => checkoutRefs(f, fs.readFileSync(path.join(WF_DIR, f), 'utf8')));
  assert.ok(all.length > 10, 'the scan found the checkouts');
  assert.deepEqual(movingPrRefs(all).map((r) => `${r.file}:${r.line} ref: ${r.ref}`), []);
});

test('t/799: dependabot-lockfile-heal.yml and stray-file-guard.yml check the PR out by github.event.pull_request.head.sha', () => {
  const SHA = '${{ github.event.pull_request.head.sha }}';
  const DEFAULT = '${{ github.event.repository.default_branch }}';
  const heal = checkoutRefs('dependabot-lockfile-heal.yml', fs.readFileSync(path.join(WF_DIR, 'dependabot-lockfile-heal.yml'), 'utf8')).map((r) => r.ref);
  // the prepare job checks the PR out by SHA; the push job checks out only the default branch's classifier (t/799 fix 2)
  assert.deepEqual(heal.sort(), [DEFAULT, SHA].sort());
  const stray = checkoutRefs('stray-file-guard.yml', fs.readFileSync(path.join(WF_DIR, 'stray-file-guard.yml'), 'utf8')).map((r) => r.ref);
  assert.deepEqual(stray, [SHA]);
});

test('t/799 arms: the scan catches a branch-name ref, a pull ref and a ref_name ref, and passes head.sha, the base branch and no ref', () => {
  const wf = (ref) => `jobs:\n  a:\n    steps:\n      - uses: actions/checkout@abc  # v6\n        with:\n${ref ? `          ref: ${ref}\n` : ''}          fetch-depth: 0\n      - run: echo hi\n`;
  for (const bad of ['${{ github.head_ref }}', '${{ github.event.pull_request.head.ref }}', 'refs/pull/${{ github.event.number }}/head', '${{ github.ref_name }}', '${{ github.event.workflow_run.head_branch }}']) {
    assert.equal(movingPrRefs(checkoutRefs('x.yml', wf(bad))).length, 1, bad);
  }
  for (const ok of ['${{ github.event.pull_request.head.sha }}', '${{ github.event.repository.default_branch }}', 'main', null]) {
    assert.equal(movingPrRefs(checkoutRefs('x.yml', wf(ok))).length, 0, String(ok));
  }
  // a `ref:` that belongs to a LATER step is not read as this checkout's
  const later = 'jobs:\n  a:\n    steps:\n      - uses: actions/checkout@abc\n      - uses: other/action@v1\n        with:\n          ref: ${{ github.head_ref }}\n';
  assert.equal(checkoutRefs('x.yml', later).length, 0);
});
