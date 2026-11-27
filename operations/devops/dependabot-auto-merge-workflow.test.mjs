// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/797: dependabot-auto-merge.yml armed #5618 with `no-auto-enqueue` on it, because a `pull_request` run takes its
// workflow file from the PR's merge ref and #5618's base predated the label guard (#5614): it ran the OLD, unguarded
// copy. The workflow now runs on `pull_request_target` (the base branch's file), arms only when a PERSON removes the
// label, and reads the live labels through the API. These tests pin the trigger, the absence of any PR checkout or
// PR-code execution, the permissions, the absence of PR strings in `run:`, and each event's behaviour by evaluating the
// workflow's own `if:` conditions and its label-read script.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEXT = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'dependabot-auto-merge.yml'), 'utf8').replace(/\r\n/g, '\n');
const LINES = TEXT.split('\n');

// ── a tiny reader for this one file ──

/** The text of a block-scalar or plain value that starts at `lines[i]` after `key:`, joined as one line (YAML `>-`). */
function valueAt(lines, i, key) {
  const first = lines[i].replace(new RegExp(`^\\s*${key}:\\s*`), '');
  if (first !== '>-' && first !== '|') return first.trim();
  const indent = lines[i].search(/\S/);
  const out = [];
  for (let j = i + 1; j < lines.length && (lines[j].trim() === '' || lines[j].search(/\S/) > indent); j++) out.push(lines[j].trim());
  return out.join(first === '>-' ? ' ' : '\n').trim();
}

function stepBlock(name) {
  const start = LINES.findIndex((l) => new RegExp(`^\\s*-\\s+name:\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(l));
  assert.ok(start >= 0, `step "${name}" exists`);
  const indent = LINES[start].search(/\S/);
  let end = start + 1;
  while (end < LINES.length && (LINES[end].trim() === '' || LINES[end].search(/\S/) > indent)) end++;
  return LINES.slice(start, end);
}

function keyValue(block, key) {
  const i = block.findIndex((l) => new RegExp(`^\\s+${key}:`).test(l));
  return i < 0 ? null : valueAt(block, i, key);
}

const JOB_IF = (() => { const i = LINES.findIndex((l) => /^ {4}if:/.test(l)); assert.ok(i >= 0, 'the job has an if'); return valueAt(LINES, i, 'if'); })();
const ARM_BLOCK = stepBlock('Arm auto-merge for minor/patch bumps');
const ARM_IF = keyValue(ARM_BLOCK, 'if');
const LABEL_BLOCK = stepBlock("Read the PR's live labels (fail closed)");

/** Evaluates a workflow `if:` expression against fake contexts. Only the operators this file uses (== != && || ! ()). */
function evalIf(expr, { event = {}, actor = '', repository = 'o/r', steps = {} }) {
  const get = (obj, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), obj);
  const js = expr
    .replace(/github\.event\.([\w.]+)/g, (_, p) => `get(event, '${p}')`)
    .replace(/github\.actor/g, 'actor')
    .replace(/github\.repository/g, 'repository')
    .replace(/steps\.([\w-]+)\.outputs\.([\w-]+)/g, (_, s, o) => `get(steps, '${s}.outputs.${o}')`);
  assert.doesNotMatch(js, /\b(github|secrets|env)\./, `unmapped context in: ${js}`);
  return Boolean(new Function('get', 'event', 'actor', 'repository', 'steps', `return (${js});`)(get, event, actor, repository, steps));
}

const prEvent = (over = {}) => ({
  action: 'unlabeled',
  label: { name: 'no-auto-enqueue' },
  sender: { type: 'User', login: 'a-human' },
  repository: { default_branch: 'main' },
  pull_request: { number: 5618, user: { login: 'dependabot[bot]' }, head: { repo: { full_name: 'o/r' } }, base: { ref: 'main' } },
  ...over,
});
const jobRuns = (event, actor = 'a-human') => evalIf(JOB_IF, { event, actor, repository: 'o/r' });

// ── trigger, checkout, permissions, strings ──

test('t/797: the trigger is pull_request_target on unlabeled only (the base branch\'s copy runs; opened, synchronize and reopened never fire it)', () => {
  const i = LINES.findIndex((l) => /^on:/.test(l));
  const onBlock = [];
  for (let j = i + 1; j < LINES.length && (LINES[j] === '' || /^\s/.test(LINES[j]) || LINES[j].startsWith('#')); j++) onBlock.push(LINES[j]);
  const onText = onBlock.join('\n');
  assert.match(onText, /^ {2}pull_request_target:\s*$/m);
  assert.match(onText, /^ {4}types: \[unlabeled\]\s*$/m);
  assert.doesNotMatch(onText, /pull_request:\s*$/m, 'no plain pull_request trigger (it would run the PR-side copy)');
  assert.deepEqual(onBlock.filter((l) => /^ {2}[a-z_]+:/.test(l)).map((l) => l.trim()), ['pull_request_target:']);
  for (const bad of ['opened', 'synchronize', 'reopened', 'labeled', 'edited']) assert.doesNotMatch(onText, new RegExp(`\\b${bad}\\b`), `${bad} is not a trigger type`);
});

test('t/797: no step checks out the PR head or runs PR code; the only checkout is the default branch, with no credentials', () => {
  const checkouts = LINES.map((l, i) => [l, i]).filter(([l]) => /uses:\s*actions\/checkout@/.test(l));
  assert.equal(checkouts.length, 1, 'one checkout, for the docker gate');
  const block = stepBlock('Check out the docker gate from the default branch (t/315)').join('\n');
  assert.match(block, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(block, /persist-credentials: false/);
  assert.match(block, /sparse-checkout:[\s\S]*operations\/devops\/dependabot-docker-gate\.mjs/);
  // the PR's head or merge ref is named nowhere as a ref, a path or a script source
  assert.doesNotMatch(TEXT, /github\.head_ref|pull_request\.head\.(?:sha|ref)|refs\/pull\/|github\.event\.pull_request\.merge/);
  // the only \`run:\` is the arm step; no other step executes shell
  const runs = LINES.filter((l) => /^\s+run:/.test(l));
  assert.equal(runs.length, 1, 'exactly one run: step');
  assert.match(ARM_BLOCK.join('\n'), /run: gh pr merge --auto --squash "\$PR_URL"/);
});

test('t/797: permissions are minimal and set at the workflow level', () => {
  const i = LINES.findIndex((l) => /^permissions:/.test(l));
  assert.ok(i >= 0);
  const perms = [];
  for (let j = i + 1; j < LINES.length && /^ {2}\S/.test(LINES[j]); j++) perms.push(LINES[j].trim());
  assert.deepEqual(perms.sort(), ['contents: write', 'pull-requests: write'].sort());
  assert.equal(LINES.filter((l) => /^\s*permissions:/.test(l)).length, 1, 'no job widens it');
});

test('t/797: no PR-controlled string (title, body, branch, label text) reaches a run: script, an env value, or a secret-bearing expression', () => {
  const armEnv = ARM_BLOCK.join('\n');
  assert.doesNotMatch(armEnv.split('run:')[1].split('\n')[0], /\$\{\{/, 'the run line holds no expression');
  assert.match(armEnv, /PR_URL: \$\{\{ github\.server_url \}\}\/\$\{\{ github\.repository \}\}\/pull\/\$\{\{ github\.event\.pull_request\.number \}\}/);
  assert.match(armEnv, /GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  // no expression anywhere reads a PR string
  const PR_STRINGS = /github\.event\.(?:pull_request\.(?:title|body|head\.ref|head\.label|labels|user\.login)|label\.name|issue|comment)\b[^}]*\}\}/;
  const withoutIf = LINES.filter((l, i) => !/^\s+if:/.test(l) && !isInsideIf(i)).join('\n');
  assert.doesNotMatch(withoutIf, PR_STRINGS, 'PR strings appear only in the job `if:` comparisons');
  assert.doesNotMatch(TEXT, /github\.event\.pull_request\.number[^\n]*\bsecrets\b|secrets[^\n]*github\.event\.pull_request\.(?:title|body)/);
});

function isInsideIf(i) {
  for (let j = i; j >= 0; j--) {
    if (/^\s+if:\s*>-?\s*$/.test(LINES[j])) return LINES.slice(j + 1, i + 1).every((l) => l.trim() === '' || l.search(/\S/) > LINES[j].search(/\S/));
    if (/^\s*-\s+name:|^\S/.test(LINES[j])) return false;
  }
  return false;
}

// ── the job's own if: per event ──

test('t/797: a person removing no-auto-enqueue from a Dependabot PR runs the job', () => {
  assert.equal(jobRuns(prEvent()), true);
});

test('t/797: opened, synchronize, reopened and labeled are not in the trigger, and an unlabeled of ANOTHER label does not run the job', () => {
  assert.equal(jobRuns(prEvent({ label: { name: 'dependencies' } })), false);
  assert.equal(jobRuns(prEvent({ label: { name: 'javascript' } })), false);
  assert.equal(jobRuns(prEvent({ label: undefined })), false);
});

test('t/797: an unlabeled by a bot is refused (sender type Bot, dependabot[bot] or github-actions[bot] as the actor)', () => {
  assert.equal(jobRuns(prEvent({ sender: { type: 'Bot', login: 'some-app[bot]' } }), 'some-app[bot]'), false);
  assert.equal(jobRuns(prEvent({ sender: { type: 'User', login: 'x' } }), 'dependabot[bot]'), false);
  assert.equal(jobRuns(prEvent({ sender: { type: 'User', login: 'x' } }), 'github-actions[bot]'), false);
  assert.equal(jobRuns(prEvent({ sender: { type: 'Organization', login: 'x' } })), false);
  assert.equal(jobRuns(prEvent({ sender: undefined })), false);
});

test('t/797: only a Dependabot PR from this repository into the default branch is released', () => {
  const pr = prEvent().pull_request;
  assert.equal(jobRuns(prEvent({ pull_request: { ...pr, user: { login: 'a-human' } } })), false, 'a human PR');
  assert.equal(jobRuns(prEvent({ pull_request: { ...pr, user: { login: 'dependabot-helper[bot]' } } })), false, 'a lookalike author');
  assert.equal(jobRuns(prEvent({ pull_request: { ...pr, head: { repo: { full_name: 'fork/r' } } } })), false, 'a fork head');
  assert.equal(jobRuns(prEvent({ pull_request: { ...pr, head: { repo: null } } })), false, 'an unreadable head repo');
  assert.equal(jobRuns(prEvent({ pull_request: { ...pr, base: { ref: 'epic/x' } } })), false, 'a non-default base');
});

// ── the live-label read, fail closed ──

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
function labelScript() {
  const i = LABEL_BLOCK.findIndex((l) => /^\s+script:\s*\|/.test(l));
  assert.ok(i >= 0, 'the label step has a script');
  const indent = LABEL_BLOCK[i].search(/\S/);
  return LABEL_BLOCK.slice(i + 1).map((l) => l.slice(indent + 2)).join('\n');
}
async function runLabelScript({ labels, error = null }) {
  const out = { failed: [], outputs: {}, info: [] };
  const github = {
    rest: { issues: { listLabelsOnIssue: Symbol('listLabelsOnIssue') } },
    paginate: async (fn) => { assert.equal(fn, github.rest.issues.listLabelsOnIssue); if (error) throw error; return labels.map((name) => ({ name })); },
  };
  const core = { setFailed: (m) => out.failed.push(m), setOutput: (k, v) => { out.outputs[k] = v; }, info: (m) => out.info.push(m), warning: () => {} };
  const context = { repo: { owner: 'o', repo: 'r' }, payload: { pull_request: { number: 5618 } } };
  let threw = null;
  try { await new AsyncFunction('github', 'context', 'core', labelScript())(github, context, core); } catch (e) { threw = e; }
  return { ...out, threw };
}

test('t/797: live labels without no-auto-enqueue: the step succeeds and reports held=false', async () => {
  const r = await runLabelScript({ labels: ['dependencies', 'javascript'] });
  assert.deepEqual(r.failed, []);
  assert.equal(r.outputs.held, 'false');
  assert.equal(r.threw, null);
});

test('t/797: no-auto-enqueue back on the PR (live API read): the step fails and nothing arms', async () => {
  const r = await runLabelScript({ labels: ['dependencies', 'no-auto-enqueue'] });
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0], /no-auto-enqueue is on the PR again/);
  assert.equal(r.outputs.held, 'true');
});

test('t/797: a label-read error or a list that may be cut short fails closed (the step throws or fails; nothing arms)', async () => {
  const err = await runLabelScript({ labels: [], error: new Error('HTTP 403 rate limit') });
  assert.ok(err.threw, 'the API error propagates, failing the step');
  assert.equal(err.outputs.held, undefined, 'and no held=false is ever reported');
  const many = await runLabelScript({ labels: Array.from({ length: 100 }, (_, i) => `l${i}`) });
  assert.equal(many.failed.length >= 1, true);
});

// ── the arm step's own if: ──

const armRuns = (steps) => evalIf(ARM_IF, { steps });
const S = (over = {}) => ({ labels: { outputs: { held: 'false' } }, meta: { outputs: { 'update-type': 'version-update:semver-minor', 'package-ecosystem': 'npm_and_yarn' } }, docker_gate: { outputs: {} }, ...over });

test('t/797: the arm step arms a live-clear minor or patch bump', () => {
  assert.equal(armRuns(S()), true);
  assert.equal(armRuns(S({ meta: { outputs: { 'update-type': 'version-update:semver-patch', 'package-ecosystem': 'npm_and_yarn' } } })), true);
});

test('t/797: it does not arm a major bump, a held PR, or a PR whose label read did not report (failed, skipped)', () => {
  assert.equal(armRuns(S({ meta: { outputs: { 'update-type': 'version-update:semver-major', 'package-ecosystem': 'npm_and_yarn' } } })), false);
  assert.equal(armRuns(S({ labels: { outputs: { held: 'true' } } })), false);
  assert.equal(armRuns(S({ labels: { outputs: {} } })), false, 'the label step failed or was skipped: no output');
  assert.equal(armRuns({ meta: S().meta }), false, 'no label step at all');
});

test('t/797: the docker digest-only gate still decides a docker bump', () => {
  const docker = { meta: { outputs: { 'update-type': 'version-update:semver-patch', 'package-ecosystem': 'docker' } } };
  assert.equal(armRuns(S({ ...docker, docker_gate: { outputs: { arm: 'false' } } })), false);
  assert.equal(armRuns(S({ ...docker, docker_gate: { outputs: {} } })), false);
  assert.equal(armRuns(S({ ...docker, docker_gate: { outputs: { arm: 'true' } } })), true);
});
