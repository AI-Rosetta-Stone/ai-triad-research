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
  // t/799 step 3: a job that MINTS an App installation token holds a write credential as surely as one that reads a secret
  if (/uses:\s*actions\/create-github-app-token@/.test(jobCode)) why.push('a minted GitHub App token');
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
  assert.deepEqual(secretAccess(byName.push, head).sort(), ['a minted GitHub App token', 'secrets.HEAL_APP_CLIENT_ID', 'secrets.HEAL_APP_PRIVATE_KEY']);
  // each App secret is read exactly twice, both in the push job: once in the job-level HEAL_APP_CONFIGURED boolean (which carries no value) and once in the mint step
  const code = codeOnly(read('dependabot-lockfile-heal.yml'));
  for (const name of ['HEAL_APP_CLIENT_ID', 'HEAL_APP_PRIVATE_KEY']) assert.equal((code.match(new RegExp(`secrets\\.${name}\\b`, 'g')) ?? []).length, 2, name);
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
  assert.ok(push.indexOf('Validate the artifact') < push.indexOf('Mint the heal App token'), 'validation precedes the credential');
  for (const f of ['taxonomy-editor/THIRD-PARTY-NOTICES.txt', 'taxonomy-editor/pnpm-lock.yaml', 'taxonomy-editor/src/renderer/data/oss-licenses.json']) assert.ok(push.includes(f), f);
  assert.match(push, /\$ACTUAL_FILES" != "\$EXPECTED_FILES"/, 'exactly the three paths');
  assert.match(push, /find "\$HEAL" ! -type f ! -type d/, 'regular files only');
  assert.match(push, /-size \+25M/);
  assert.match(push, /\$NOW_HEAD" != "\$EXPECTED_HEAD"/, 'the PR head must still be the SHA this run was started for');
  assert.match(push, /if: steps\.validate\.outputs\.ok == 'true' && env\.HEAL_APP_CONFIGURED == 'true'/);
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

// continuous-deploy.yml:evaluate checks out workflow_run.head_sha with `issues: write` on its GITHUB_TOKEN. `branches: [main]` matches
// the head branch NAME, so a fork PR from a fork's own `main` also triggers it (t/801): that alone does NOT make the SHA a commit on
// main. What keeps PR content out is the job's own `if:` (an allowlist of workflow_run events plus head repository == this
// repository), pinned in continuous-deploy-workflow.test.mjs and re-pinned below. It is log-only; a known, reviewed exception.
// Remove it from this list if the job stops checking out the head SHA.
const KNOWN_BASELINE = ['continuous-deploy.yml:evaluate'];

test('t/799, t/801: the baseline exception (continuous-deploy.yml) keeps its trigger AND the if: that excludes forks and pull_request runs', () => {
  const text = read('continuous-deploy.yml');
  const { head } = splitWorkflow(text);
  assert.match(head, /workflow_run:\s*\n\s+workflows: \["CI"\]\s*\n\s+types: \[completed\]\s*\n\s+branches: \[main\]/);
  assert.match(text, /contains\(fromJSON\('\["push","schedule","workflow_dispatch"\]'\), github\.event\.workflow_run\.event\)/);
  assert.match(text, /github\.event\.workflow_run\.head_repository\.full_name == github\.repository/);
});

// ── t/799 step 3 (Security t/799#8): the credential is a short-lived GitHub App installation token minted in the push job ──

const HEAL = () => read('dependabot-lockfile-heal.yml');
const jobsOf = () => { const { head, jobs } = splitWorkflow(HEAL()); return { head, push: jobs.find((j) => j.name === 'push'), prepare: jobs.find((j) => j.name === 'prepare') }; };

test('t/799 step 3: DEPENDABOT_HEAL_PAT is not referenced anywhere in the file (code, comments or messages)', () => {
  assert.doesNotMatch(HEAL(), /DEPENDABOT_HEAL_PAT/);
  assert.doesNotMatch(HEAL(), /secrets\.[A-Z_]*PAT\b/);
});

test('t/799 step 3: prepare references neither App secret nor the minted token, and no PR checkout shares a job with either', () => {
  const { head, prepare, push } = jobsOf();
  for (const name of ['HEAL_APP_CLIENT_ID', 'HEAL_APP_PRIVATE_KEY']) {
    assert.doesNotMatch(prepare.text, new RegExp(name), `prepare must not mention ${name}`);
    assert.doesNotMatch(prepare.text, /create-github-app-token|steps\.app\.outputs\.token|HEAL_APP_CONFIGURED/);
  }
  assert.deepEqual(secretAccess(prepare, head), []);
  assert.ok(prContentCheckouts(prepare, head).length > 0);
  // the whole-file rule, for BOTH secrets and the minted token: no job has a PR-content checkout and any of them
  assert.deepEqual(isolationViolations(HEAL()), []);
  assert.deepEqual(prContentCheckouts(push, head), []);
});

test('t/799 step 3: the push job mints AFTER the validate step and RIGHT BEFORE the push step, with the pinned action and the narrow inputs', () => {
  const { push } = jobsOf();
  const code = codeOnly(push.text);
  const names = [...code.matchAll(/^\s+- name: (.+)$/gm)].map((m) => m[1].trim());
  const iValidate = names.indexOf('Validate the artifact and the PR head');
  const iMint = names.indexOf('Mint the heal App token');
  const iPush = names.indexOf('Commit and push heal');
  assert.ok(iValidate >= 0 && iMint > iValidate, 'the mint comes after validate');
  assert.equal(iPush, iMint + 1, 'the push step follows the mint immediately');
  const mint = code.slice(code.indexOf('- name: Mint the heal App token'), code.indexOf('- name: Commit and push heal'));
  assert.match(mint, /uses: actions\/create-github-app-token@f418cff399f7aef4c2f0ad47e25ca7a6abbdd6fc  # v3\.4\.0/, 'the SHA the repo already pins');
  assert.match(mint, /id: app\b/);
  assert.match(mint, /if: steps\.validate\.outputs\.ok == 'true' && env\.HEAL_APP_CONFIGURED == 'true'/);
  assert.match(mint, /client-id: \$\{\{ secrets\.HEAL_APP_CLIENT_ID \}\}/);
  assert.match(mint, /private-key: \$\{\{ secrets\.HEAL_APP_PRIVATE_KEY \}\}/);
  assert.match(mint, /repositories: \$\{\{ github\.event\.repository\.name \}\}/);
  assert.match(mint, /permission-contents: write/);
  assert.equal((mint.match(/permission-/g) ?? []).length, 1, 'contents: write and nothing else');
  // the pinned SHA is the one every other workflow uses
  const others = fs.readdirSync(WF_DIR).filter((x) => x.endsWith('.yml') && x !== 'dependabot-lockfile-heal.yml')
    .flatMap((x) => [...read(x).matchAll(/create-github-app-token@([0-9a-f]{40})/g)].map((m) => m[1]));
  assert.ok(others.length > 0 && others.every((sha) => sha === 'f418cff399f7aef4c2f0ad47e25ca7a6abbdd6fc'), 'the repo pins one SHA');
});

test('t/799 step 3: the push step takes the minted token through env, and the token is used nowhere else', () => {
  const { push } = jobsOf();
  const code = codeOnly(push.text);
  const step = code.slice(code.indexOf('- name: Commit and push heal'));
  assert.match(step, /env:\s*\n\s+GH_TOKEN: \$\{\{ steps\.app\.outputs\.token \}\}/);
  assert.equal((code.match(/steps\.app\.outputs\.token/g) ?? []).length, 1, 'referenced once, in that env');
  assert.doesNotMatch(step.split('run: |')[1] ?? '', /\$\{\{/, 'the push script has no inline expression');
  // an empty minted token with the App configured is an error, never a silent skip
  assert.match(step, /if \[ -z "\$GH_TOKEN" \]; then\s*\n\s+echo "::error::[^\n]*\n\s+exit 1/);
});

// The step conditions evaluated for each state of the two inputs (configured?, validated?). Only the operators these files use.
function evalCond(expr, { configured, validated }) {
  const js = expr
    .replace(/env\.HEAL_APP_CONFIGURED/g, `'${configured}'`)
    .replace(/steps\.validate\.outputs\.ok/g, `'${validated}'`);
  assert.doesNotMatch(js, /\b(env|steps|secrets|github)\./, `unmapped: ${js}`);
  return Boolean(new Function(`return (${js});`)());
}
function stepIf(name) {
  const { push } = jobsOf();
  const lines = codeOnly(push.text).split('\n');
  const i = lines.findIndex((l) => l.includes(`- name: ${name}`));
  assert.ok(i >= 0, name);
  const m = lines.slice(i + 1, i + 8).map((l) => /^\s+if: (.+)$/.exec(l)).find(Boolean);
  return m ? m[1] : null;
}

test('t/799 step 3: unset secrets are a WARNING and a green no-op: only the warning step runs; neither the mint nor the push does', () => {
  const { push } = jobsOf();
  // the job-level boolean carries no secret: it only says whether both exist
  assert.match(push.text, /HEAL_APP_CONFIGURED: \$\{\{ secrets\.HEAL_APP_CLIENT_ID != '' && secrets\.HEAL_APP_PRIVATE_KEY != '' \}\}/);
  const mintIf = stepIf('Mint the heal App token');
  const pushIf = stepIf('Commit and push heal');
  const noteIf = stepIf('Heal App not configured (warning, no-op)');
  assert.ok(mintIf && pushIf && noteIf);
  for (const validated of ['true', 'false', '']) {
    const run = { mint: evalCond(mintIf, { configured: 'false', validated }), push: evalCond(pushIf, { configured: 'false', validated }), note: evalCond(noteIf, { configured: 'false', validated }) };
    assert.deepEqual(run, { mint: false, push: false, note: true }, `unconfigured, validated=${validated}`);
  }
  // configured and validated: mint and push run, the notice does not
  assert.deepEqual({ mint: evalCond(mintIf, { configured: 'true', validated: 'true' }), push: evalCond(pushIf, { configured: 'true', validated: 'true' }), note: evalCond(noteIf, { configured: 'true', validated: 'true' }) }, { mint: true, push: true, note: false });
  // configured but the artifact or the head failed validation (ok != 'true'): no mint, no push, no notice: the validate step already said why
  assert.deepEqual({ mint: evalCond(mintIf, { configured: 'true', validated: 'false' }), push: evalCond(pushIf, { configured: 'true', validated: 'false' }), note: evalCond(noteIf, { configured: 'true', validated: 'false' }) }, { mint: false, push: false, note: false });
  // the notice step itself is a green notice, not an error or an exit 1
  const code = codeOnly(push.text);
  const note = code.slice(code.indexOf('- name: Heal App not configured (warning, no-op)'), code.indexOf('- name: Mint the heal App token'));
  assert.match(note, /::warning::t\/799: the heal found drift on PR #\$PR_NUMBER but did NOT heal it/);
  assert.doesNotMatch(note, /::notice::|::error::|\bexit [1-9]/);
});

test('t/799 step 3 arms: a mint in a job with a PR checkout fails the detector; a mint-only job passes; the old PAT shape still fails', () => {
  const withMint = `on:\n  pull_request:\njobs:\n  j:\n    runs-on: x\n    steps:\n      - uses: actions/checkout@a\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n      - uses: actions/create-github-app-token@f418cff399f7aef4c2f0ad47e25ca7a6abbdd6fc\n        with:\n          client-id: x\n`;
  const v = isolationViolations(withMint);
  assert.equal(v.length, 1);
  assert.deepEqual(v[0].secret, ['a minted GitHub App token']);
  const mintOnly = `on:\n  pull_request:\njobs:\n  j:\n    runs-on: x\n    steps:\n      - uses: actions/checkout@a\n        with:\n          ref: \${{ github.event.repository.default_branch }}\n      - uses: actions/create-github-app-token@f418cff399f7aef4c2f0ad47e25ca7a6abbdd6fc\n`;
  assert.deepEqual(isolationViolations(mintOnly), []);
  for (const name of ['HEAL_APP_CLIENT_ID', 'HEAL_APP_PRIVATE_KEY']) {
    const wf = `on:\n  pull_request:\njobs:\n  j:\n    runs-on: x\n    steps:\n      - uses: actions/checkout@a\n        with:\n          ref: \${{ github.head_ref }}\n      - run: echo\n        env:\n          X: \${{ secrets.${name} }}\n`;
    assert.equal(isolationViolations(wf).length, 1, name);
  }
});

// ── t/799 (TL p/9#815): drift detected + App not configured is a WARNING and a step-summary line, only in that case ──

import { spawnSync } from 'node:child_process';
import os from 'node:os';

function unconfiguredStepScript() {
  const { push } = jobsOf();
  const lines = codeOnly(push.text).split('\n');
  const i = lines.findIndex((l) => l.includes('- name: Heal App not configured (warning, no-op)'));
  assert.ok(i >= 0, 'the warning step exists');
  const runAt = lines.findIndex((l, k) => k > i && /^\s+run: \|\s*$/.test(l));
  const indent = lines[runAt + 1].match(/^\s*/)[0];
  const body = [];
  for (let k = runAt + 1; k < lines.length; k++) {
    if (lines[k].trim() !== '' && !lines[k].startsWith(indent)) break;
    body.push(lines[k].slice(indent.length));
  }
  return body.join('\n');
}

const bash = process.platform === 'win32' ? 'bash.exe' : 'bash';
const haveBash = spawnSync(bash, ['-c', 'true']).status === 0;
const posix = (p) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);

test('t/799: the unconfigured step, run in bash, exits 0, emits ::warning:: (never ::notice::) and appends the step-summary line naming both secrets', { skip: !haveBash && 'bash not available' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heal-warn-'));
  const summary = path.join(dir, 'summary.md');
  fs.writeFileSync(summary, 'earlier line\n');
  const r = spawnSync(bash, ['-c', unconfiguredStepScript()], { encoding: 'utf8', env: { ...process.env, PR_NUMBER: '5618', GITHUB_STEP_SUMMARY: posix(summary) } });
  assert.equal(r.status, 0, 'a green no-op');
  const out = r.stdout + r.stderr;
  assert.match(out, /^::warning::t\/799: the heal found drift on PR #5618 but did NOT heal it: HEAL_APP_CLIENT_ID and HEAL_APP_PRIVATE_KEY are not both set/m);
  assert.doesNotMatch(out, /::notice::|::error::/);
  const written = fs.readFileSync(summary, 'utf8');
  assert.match(written, /^earlier line\n/, 'appended, not overwritten');
  assert.match(written, /\*\*Heal skipped on PR #5618:\*\* drift was detected but HEAL_APP_CLIENT_ID \/ HEAL_APP_PRIVATE_KEY are not both set, so nothing was healed/);
});

test('t/799: the warning and the summary line exist ONLY in the unconfigured step; a configured run (mint, push) emits neither', () => {
  const { push } = jobsOf();
  const code = codeOnly(push.text);
  const start = code.indexOf('- name: Heal App not configured (warning, no-op)');
  const end = code.indexOf('- name: Mint the heal App token');
  const before = code.slice(0, start);
  const after = code.slice(end);
  for (const part of [before, after]) {
    assert.doesNotMatch(part, /::warning::t\/799: the heal found drift/, 'the skipped-heal warning is not elsewhere');
    assert.doesNotMatch(part, /Heal skipped on PR/, 'the skipped-heal summary line is not elsewhere');
  }
  // the validate step (before) and the push step (after) never write the skipped-heal summary; the push step does not touch the step summary at all
  const pushStep = after.slice(after.indexOf('- name: Commit and push heal'));
  assert.doesNotMatch(pushStep, /GITHUB_STEP_SUMMARY/);
  // and the unconfigured step is gated on the boolean being NOT true, so a configured run never reaches it
  const noteIf = stepIf('Heal App not configured (warning, no-op)');
  for (const validated of ['true', 'false', '']) assert.equal(evalCond(noteIf, { configured: 'true', validated }), false, `configured, validated=${validated}`);
  for (const validated of ['true', 'false', '']) assert.equal(evalCond(noteIf, { configured: 'false', validated }), true, `unconfigured, validated=${validated}`);
});
