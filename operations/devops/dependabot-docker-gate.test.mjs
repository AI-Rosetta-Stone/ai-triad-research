// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/315: both arms for the docker auto-merge gate, plus the workflow wiring.
// Run: node --test operations/devops/dependabot-docker-gate.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dockerAutoMergeVerdict, dockerGateComment, DOCKER_GATE_MARKER } from './dependabot-docker-gate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const D = (c) => c.repeat(64);
const from = (ref, d, stage = '') => `FROM ${ref}@sha256:${d}${stage ? ` AS ${stage}` : ''}`;
const file = (filename, pairs) => ({
  filename,
  patch: ['@@ -1,3 +1,3 @@', ...pairs.flatMap(([a, b]) => [`-${a}`, `+${b}`])].join('\n'),
});

test('a digest-only bump (same image:tag, new digest) is armed', () => {
  const v = dockerAutoMergeVerdict({ files: [file('taxonomy-editor/Dockerfile', [[from('node:22-slim', D('a'), 'build'), from('node:22-slim', D('b'), 'build')]])] });
  assert.equal(v.arm, true, v.reason);
});

test('a tag bump (python 3.12 -> 3.15, the #5015 shape) is NOT armed, and the reason names the change', () => {
  const v = dockerAutoMergeVerdict({ files: [file('.devcontainer/Dockerfile', [[from('python:3.12-slim-trixie', D('a')), from('python:3.15-slim-trixie', D('b'))]])] });
  assert.equal(v.arm, false);
  assert.match(v.reason, /^not a digest-only update: .*python:3\.12-slim-trixie -> python:3\.15-slim-trixie/);
});

test('a mixed multi-FROM diff with one tag change is NOT armed', () => {
  const v = dockerAutoMergeVerdict({ files: [file('Dockerfile', [
    [from('node:22-slim', D('a'), 'build'), from('node:22-slim', D('b'), 'build')],
    [from('python:3.12-slim', D('c'), 'py'), from('python:3.13-slim', D('d'), 'py')],
  ])] });
  assert.equal(v.arm, false);
});

test('fail closed: unreadable or possibly-truncated file lists are never armed', () => {
  assert.equal(dockerAutoMergeVerdict({ files: null }).arm, false);
  const good = [file('Dockerfile', [[from('node:22-slim', D('a')), from('node:22-slim', D('b'))]])];
  assert.equal(dockerAutoMergeVerdict({ files: good, truncated: true }).arm, false);
  assert.equal(dockerAutoMergeVerdict({ files: [] }).arm, false);
});

test('the comment carries the reason and a per-head marker', () => {
  const body = dockerGateComment({ headSha: 'abc123', reason: 'not a digest-only update: image/tag changed a -> b' });
  assert.match(body, /not a digest-only update: image\/tag changed a -> b/);
  assert.ok(body.includes(`${DOCKER_GATE_MARKER}abc123 -->`));
});

// ── workflow wiring (dependabot-auto-merge.yml) ──
const WF = readFileSync(path.join(here, '..', '..', '.github', 'workflows', 'dependabot-auto-merge.yml'), 'utf8').replace(/\r\n/g, '\n');

test('workflow: the arm step requires the docker gate for the docker ecosystem; other ecosystems unchanged', () => {
  const arm = WF.slice(WF.indexOf('- name: Arm auto-merge for minor/patch bumps'));
  assert.match(arm, /steps\.meta\.outputs\.update-type == 'version-update:semver-minor'/);
  assert.match(arm, /steps\.meta\.outputs\.update-type == 'version-update:semver-patch'/);
  assert.match(arm, /steps\.meta\.outputs\.package-ecosystem != 'docker' \|\| steps\.docker_gate\.outputs\.arm == 'true'/);
});

test('workflow: the gate loads the predicate from the trusted default branch, never the PR head', () => {
  assert.match(WF, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(WF, /persist-credentials: false/);
  assert.match(WF, /operations\/devops\/dependabot-docker-gate\.mjs/);
  assert.match(WF, /operations\/devops\/docker\/docker-digest-only\.mjs/);
});
