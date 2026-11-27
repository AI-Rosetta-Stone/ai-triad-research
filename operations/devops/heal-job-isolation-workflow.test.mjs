// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/799 (Security t/799#2): PR-controlled code and a secret must never share a job. dependabot-lockfile-heal.yml checked
// the PR out and ran its scripts (`node scripts/...`, `pnpm install`, `npm run licenses`) and, in the same job, handed the
// repo-wide PAT to its last step. It is now two jobs: `prepare` (PR checkout, no secret) and `push` (the secret, no PR
// checkout, no PR code). This detector fails if any job BOTH checks out PR content AND has access to a secret.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WF_DIR = path.join(ROOT, '.github', 'workflows');
const read = (f) => fs.readFileSync(path.join(WF_DIR, f), 'utf8').replace(/\r\n/g, '\n');

/** PURE. The workflow's triggers, its workflow-level text (before `jobs:`), and its jobs as { name, text }. */
export function splitWorkflow(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const jobsAt = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  assert.ok(jobsAt >= 0, 'a jobs: block');
  const head = lines.slice(0, jobsAt).join('\n');
  const jobs = [];
  let cur = null;
  for (const l of lines.slice(jobsAt + 1)) {
    const m = /^ {2}([A-Za-z0-9_-]+):\s*(?:#.*)?$/.exec(l);
    if (m) { cur = { name: m[1], lines: [] }; jobs.push(cur); continue; }
    if (cur) cur.lines.push(l);
  }
  return { head, jobs: jobs.map((j) => ({ name: j.name, text: j.lines.join('\n') })) };
}

const codeOnly = (t) => t.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

function triggers(head) {
  const i = head.split('\n').findIndex((l) => /^on:/.test(l));
  if (i < 0) return [];
  const lines = head.split('\n').slice(i);
  const inline = lines[0].replace(/^on:\s*/, '').trim();
  if (inline) return inline.replace(/[[\]]/g, '').split(',').map((x) => x.trim()).filter(Boolean);
  const out = [];
  for (const l of lines.slice(1)) { const m = /^ {2}([a-z_]+):/.exec(l); if (m) out.push(m[1]); }
  return out;
}

/** PURE. Why this job checks out PR content, or []: a head.sha / head_ref / head.ref / refs/pull checkout, (a checkout with no ref is NOT counted: see below). */
export function prContentCheckouts(job, headText) {
  const lines = codeOnly(job.text).split('\n');
  const why = [];
  lines.forEach((l, i) => {
    if (!/uses:\s*actions\/checkout@/.test(l)) return;
    const indent = l.search(/\S/);
    let ref = null;
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j];
      if (t.trim() !== '' && t.search(/\S/) < indent) break;
      if (/^\s*-\s+(name|uses|run):/.test(t) && t.search(/\S/) <= indent) break;
      const m = /^\s+ref:\s*(.*?)\s*$/.exec(t);
      if (m) ref = m[1];
    }
    // A checkout with NO ref on a `pull_request` workflow is the PR's merge ref too, but it is the ordinary CI pattern and is
    // out of this detector's scope (TL/Lead spec: head.sha, head_ref, refs/pull). Only an explicit PR ref counts here.
    if (ref !== null && /pull_request\.head\.(sha|ref|label)|workflow_run\.head_(sha|branch)|github\.head_ref|refs\/pull\//.test(ref)) why.push(`a checkout of ${ref}`);
  });
  return why;
}

/** PURE. Why this job has secret access, or []: any secrets.X other than GITHUB_TOKEN (job or workflow env), `secrets: inherit`, or a write-scoped token. */
export function secretAccess(job, headText) {
  const why = [];
  const jobCode = codeOnly(job.text);
  const all = `${codeOnly(headText)}\n${jobCode}`;
  for (const m of all.matchAll(/\bsecrets\.([A-Za-z0-9_]+)/g)) if (m[1] !== 'GITHUB_TOKEN') why.push(`secrets.${m[1]}`);
  if (/\bsecrets:\s*inherit\b/.test(jobCode)) why.push('secrets: inherit');
  // a write-scoped GITHUB_TOKEN in a job that exposes it (GH_TOKEN / GITHUB_TOKEN env, or github.token)
  const perms = /^ {4}permissions:\s*\n((?: {6}.*\n?)+)/m.exec(job.text)?.[1] ?? /^permissions:\s*\n((?: {2}.*\n?)+)/m.exec(headText)?.[1] ?? '';
  const writes = [...perms.matchAll(/^\s*([a-z-]+):\s*write\b/gm)].map((m) => m[1]);
  if (writes.length > 0 && /GH_TOKEN|GITHUB_TOKEN|github\.token/.test(jobCode)) why.push(`a ${writes.join('/')}: write GITHUB_TOKEN`);
  return [...new Set(why)];
}

/** PURE. The jobs of a workflow that have BOTH: [{ job, checkout, secret }]. */
export function isolationViolations(text) {
  const { head, jobs } = splitWorkflow(text);
  return jobs
    .map((job) => ({ job: job.name, checkout: prContentCheckouts(job, head), secret: secretAccess(job, head) }))
    .filter((v) => v.checkout.length > 0 && v.secret.length > 0);
}

// ── the heal workflow ──

test('t/799: dependabot-lockfile-heal.yml has no job that both checks out PR content and has a secret', () => {
  assert.deepEqual(isolationViolations(read('dependabot-lockfile-heal.yml')), []);
});

test('t/799: the heal is two jobs: prepare (PR checkout, no secret) and push (the secret, no PR checkout, no PR code)', () => {
  const { head, jobs } = splitWorkflow(read('dependabot-lockfile-heal.yml'));
  const byName = Object.fromEntries(jobs.map((j) => [j.name, j]));
  assert.deepEqual(Object.keys(byName).sort(), ['prepare', 'push']);
  assert.ok(prContentCheckouts(byName.prepare, head).length > 0, 'prepare checks the PR out');
  assert.deepEqual(secretAccess(byName.prepare, head), [], 'prepare holds no secret');
  assert.deepEqual(prContentCheckouts(byName.push, head), [], 'push checks out no PR content');
  assert.deepEqual(secretAccess(byName.push, head), ['secrets.DEPENDABOT_HEAL_PAT']);
  // the credential is referenced exactly once, in the push job's last step
  assert.equal((codeOnly(read('dependabot-lockfile-heal.yml')).match(/secrets\.DEPENDABOT_HEAL_PAT/g) ?? []).length, 1);
});

test('t/799: the push job runs no PR code: no PR file is checked out or run, only the default branch\'s classifier', () => {
  const { jobs } = splitWorkflow(read('dependabot-lockfile-heal.yml'));
  const push = codeOnly(jobs.find((j) => j.name === 'push').text);
  assert.doesNotMatch(push, /\bpnpm (?:install|run|exec|dlx|i)\b|npm (?:run|ci|install)\b|scripts\/sync-standalone|node scripts\//, 'no PR script or package-manager call');
  assert.match(push, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(push, /sparse-checkout:\s*\|\s*\n\s+operations\/devops\/classify-heal-push-failure\.mjs\s*\n/);
  assert.match(push, /git read-tree "\$EXPECTED_HEAD"/, 'the PR head is read into an index only');
  assert.doesNotMatch(push, /git checkout|git switch|git read-tree[^\n]*-u|git merge|git reset --hard|git pull/, 'no working tree of the PR is ever populated');
  // the branch name reaches the script through env, never an inline expression
  assert.doesNotMatch(push.split('\n').filter((l) => /^\s+run:|^\s{10,}\S/.test(l)).join('\n'), /\$\{\{\s*github\.head_ref/);
  assert.match(push, /HEAD_REF: \$\{\{ github\.head_ref \}\}/);
});

test('t/799: the push job validates the artifact shape and that the PR head is unchanged before touching the credential', () => {
  const { jobs } = splitWorkflow(read('dependabot-lockfile-heal.yml'));
  const push = codeOnly(jobs.find((j) => j.name === 'push').text);
  assert.ok(push.indexOf('Validate the artifact') < push.indexOf('secrets.DEPENDABOT_HEAL_PAT'), 'validation precedes the credential');
  for (const f of ['taxonomy-editor/THIRD-PARTY-NOTICES.txt', 'taxonomy-editor/pnpm-lock.yaml', 'taxonomy-editor/src/renderer/data/oss-licenses.json']) assert.ok(push.includes(f), f);
  assert.match(push, /\$ACTUAL_FILES" != "\$EXPECTED_FILES"/, 'exactly the three paths');
  assert.match(push, /find "\$HEAL" ! -type f ! -type d/, 'regular files only');
  assert.match(push, /-size \+25M/);
  assert.match(push, /\$NOW_HEAD" != "\$EXPECTED_HEAD"/, 'the PR head must still be the SHA this run was started for');
  assert.match(push, /if: steps\.validate\.outputs\.ok == 'true'/);
  assert.match(push, /needs: prepare/);
  assert.match(push, /if: needs\.prepare\.outputs\.changed == 'true'/);
});

// ── arms: the detector itself ──

const OLD_SHAPE = `name: Heal
on:
  pull_request:
    types: [opened, synchronize]
permissions:
  contents: read
jobs:
  heal:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@abc  # v6
        with:
          ref: \${{ github.event.pull_request.head.sha }}
      - run: node scripts/sync-standalone-lockfile.mjs
      - name: Commit and push heal
        env:
          GH_TOKEN: \${{ secrets.DEPENDABOT_HEAL_PAT }}
        run: git push
`;

test('t/799 arm: the pre-split shape (PR checkout and the PAT in one job) FAILS the detector, with both reasons named', () => {
  const v = isolationViolations(OLD_SHAPE);
  assert.equal(v.length, 1);
  assert.equal(v[0].job, 'heal');
  assert.match(v[0].checkout[0], /head\.sha/);
  assert.deepEqual(v[0].secret, ['secrets.DEPENDABOT_HEAL_PAT']);
});

test('t/799 arm: each way of reaching PR content, and each way of holding a secret, is caught on its own', () => {
  const wf = (ref, secretLine) => `on:\n  pull_request:\njobs:\n  j:\n    runs-on: x\n    steps:\n      - uses: actions/checkout@a\n${ref === null ? '' : `        with:\n          ref: ${ref}\n`}      - run: echo\n${secretLine}`;
  for (const ref of ['${{ github.head_ref }}', '${{ github.event.pull_request.head.ref }}', 'refs/pull/${{ github.event.number }}/head', '${{ github.event.pull_request.head.sha }}', '${{ github.event.workflow_run.head_branch }}', '${{ github.event.workflow_run.head_sha }}']) {
    assert.equal(isolationViolations(wf(ref, '        env:\n          X: ${{ secrets.ANY }}\n')).length, 1, `checkout ${ref}`);
  }
  for (const secret of ['        env:\n          X: ${{ secrets.RUNNER_PAT }}\n', '        env:\n          GH_TOKEN: ${{ secrets.OTHER }}\n']) {
    assert.equal(isolationViolations(wf('${{ github.head_ref }}', secret)).length, 1, secret);
  }
  assert.equal(isolationViolations(`on:\n  pull_request:\npermissions:\n  contents: write\njobs:\n  j:\n    runs-on: x\n    steps:\n      - uses: actions/checkout@a\n        with:\n          ref: \${{ github.head_ref }}\n      - run: echo\n        env:\n          GH_TOKEN: \${{ github.token }}\n`).length, 1, 'a write-scoped GITHUB_TOKEN counts');
});

test('t/799 arm: the split shape, a default-branch checkout with a secret, a PR checkout with only the read-only GITHUB_TOKEN, and a comment mentioning a secret pass', () => {
  const split = `on:\n  pull_request:\njobs:\n  prepare:\n    runs-on: x\n    permissions:\n      contents: read\n    steps:\n      - uses: actions/checkout@a\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n      - run: node scripts/x.mjs\n  push:\n    needs: prepare\n    runs-on: x\n    steps:\n      - uses: actions/checkout@a\n        with:\n          ref: \${{ github.event.repository.default_branch }}\n      - run: git push\n        env:\n          GH_TOKEN: \${{ secrets.DEPENDABOT_HEAL_PAT }}\n`;
  assert.deepEqual(isolationViolations(split), []);
  const readOnly = `on:\n  pull_request:\npermissions:\n  contents: read\njobs:\n  j:\n    runs-on: x\n    steps:\n      - uses: actions/checkout@a\n        with:\n          ref: \${{ github.head_ref }}\n      - run: gh api x\n        env:\n          GH_TOKEN: \${{ github.token }}\n`;
  assert.deepEqual(isolationViolations(readOnly), []);
  const commented = `on:\n  pull_request:\njobs:\n  j:\n    runs-on: x\n    steps:\n      - uses: actions/checkout@a\n        with:\n          ref: \${{ github.head_ref }}\n      # uses secrets.DEPENDABOT_HEAL_PAT in another job\n      - run: echo\n`;
  assert.deepEqual(isolationViolations(commented), []);
});

// ── the whole repository: a ratchet, so a NEW job cannot join the old pattern unnoticed ──

test('t/799: across every workflow, the jobs that check out PR content and hold a secret are exactly the known baseline', () => {
  const offenders = [];
  for (const f of fs.readdirSync(WF_DIR).filter((x) => x.endsWith('.yml')).sort()) {
    for (const v of isolationViolations(read(f))) offenders.push(`${f}:${v.job}`);
  }
  assert.deepEqual(offenders, KNOWN_BASELINE, 'a job that mixes a PR checkout and a secret was added (or one was fixed: remove it from KNOWN_BASELINE)');
});

// continuous-deploy.yml:evaluate checks out workflow_run.head_sha with `issues: write` on its GITHUB_TOKEN. Its trigger is
// `workflow_run` of CI with `branches: [main]` (so the SHA is a commit on main, never a PR head) and it is log-only; it is a
// known, reviewed exception, not PR content. Remove it from this list if that trigger ever widens (the test below pins it).
const KNOWN_BASELINE = ['continuous-deploy.yml:evaluate'];

test('t/799: the one baseline exception (continuous-deploy.yml) stays limited to main: its workflow_run trigger names branches: [main]', () => {
  const { head } = splitWorkflow(read('continuous-deploy.yml'));
  assert.match(head, /workflow_run:\s*\n\s+workflows: \["CI"\]\s*\n\s+types: \[completed\]\s*\n\s+branches: \[main\]/);
});
