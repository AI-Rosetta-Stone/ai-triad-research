// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/238: end-to-end arms for ci.yml's `record-base-ref` retry loop. The test extracts the step's REAL
// `run: |` block from ci.yml and runs it under bash with a fake `gh` (which answers from a scripted
// list of outcomes) and a fake `sleep` (which records its argument) first on PATH. So these exercise
// the code the workflow actually executes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, chmodSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

/** The `run: |` block of ci.yml's "Post base-ref-record commit status" step, dedented. */
function extractRun() {
  const lines = readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8').split('\n');
  const from = lines.findIndex((l) => l.trim() === '- name: Post base-ref-record commit status');
  assert.ok(from >= 0, 'ci.yml: no "Post base-ref-record commit status" step');
  const start = lines.findIndex((l, i) => i > from && /^\s*run:\s*\|\s*$/.test(l));
  const body = [];
  let indent = null;
  for (const l of lines.slice(start + 1)) {
    if (l.trim() === '') { body.push(''); continue; }
    const ind = l.match(/^ */)[0].length;
    if (indent === null) indent = ind;
    if (ind < indent) break;
    body.push(l.slice(indent));
  }
  return body.join('\n');
}

const bash = process.platform === 'win32' ? 'bash.exe' : 'bash';
const haveBash = spawnSync(bash, ['-c', 'true']).status === 0;

/**
 * Runs the step. `outcomes` is the scripted answer of each POST, in order: 'ok', or
 * { status, message } for a failure (gh prints `gh: <message> (HTTP <status>)` and exits 1).
 * `resetIn` is what `gh api rate_limit` reports, in seconds from now ('' for unreadable).
 */
function runStep(outcomes, { resetIn = 10 } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'record-base-ref-'));
  const posix = (p) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
  const d = posix(dir);
  writeFileSync(path.join(dir, 'outcomes'), outcomes.map((o) => (o === 'ok' ? 'ok' : `${o.status}|${o.message}`)).join('\n') + '\n');
  writeFileSync(path.join(dir, 'gh'), [
    '#!/bin/bash',
    `if [ "$2" = "rate_limit" ]; then`,
    resetIn === '' ? '  exit 1' : `  echo $(( $(date +%s) + ${resetIn} )); exit 0`,
    'fi',
    `n=$(cat "${d}/count" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${d}/count"`,
    `line=$(sed -n "\${n}p" "${d}/outcomes"); [ -z "$line" ] && line=$(tail -n 1 "${d}/outcomes")`,
    'if [ "$line" = ok ]; then echo "{}"; exit 0; fi',
    'echo "gh: ${line#*|} (HTTP ${line%%|*})" >&2; exit 1',
  ].join('\n'));
  writeFileSync(path.join(dir, 'sleep'), `#!/bin/bash\necho "$1" >> "${d}/sleeps"\n`);
  chmodSync(path.join(dir, 'gh'), 0o755);
  chmodSync(path.join(dir, 'sleep'), 0o755);
  writeFileSync(path.join(dir, 'step.sh'), extractRun());
  const r = spawnSync(bash, [`${d}/step.sh`], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}`, REPO: 'o/r', HEAD_SHA: 'headsha', BASE_REF: 'main' },
  });
  const read = (f) => (existsSync(path.join(dir, f)) ? readFileSync(path.join(dir, f), 'utf8').trim() : '');
  return {
    code: r.status,
    out: `${r.stdout}${r.stderr}`,
    posts: Number(read('count') || 0),
    sleeps: read('sleeps') ? read('sleeps').split('\n').map(Number) : [],
  };
}

const RATE = { status: 403, message: 'API rate limit exceeded for installation ID 1' };

test('t/238 record-base-ref CONTROL: success posts once, no WARN, exit 0', { skip: !haveBash && 'bash not available' }, () => {
  const r = runStep(['ok']);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.posts, 1);
  assert.deepEqual(r.sleeps, []);
  assert.doesNotMatch(r.out, /WARN/);
});

test('t/238 record-base-ref: a rate limit waits for the core reset, then posts', { skip: !haveBash && 'bash not available' }, () => {
  const r = runStep([RATE, 'ok'], { resetIn: 10 });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.posts, 2);
  assert.equal(r.sleeps.length, 1);
  assert.ok(r.sleeps[0] >= 10 && r.sleeps[0] <= 13, `waited ${r.sleeps[0]}s for a reset 10s away`);
  assert.match(r.out, /::warning::WARN record-base-ref: attempt 1 hit a rate limit -- waiting \d+s for the reset/);
});

test('t/238 record-base-ref: an unreadable reset waits 30 s', { skip: !haveBash && 'bash not available' }, () => {
  const r = runStep([RATE, 'ok'], { resetIn: '' });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.sleeps, [30]);
});

test('t/238 record-base-ref: a reset past the 300 s cap fails at once, naming it', { skip: !haveBash && 'bash not available' }, () => {
  const r = runStep([RATE, 'ok'], { resetIn: 3000 });
  assert.equal(r.code, 1);
  assert.equal(r.posts, 1);
  assert.deepEqual(r.sleeps, []);
  assert.match(r.out, /::error::record-base-ref: rate limited and the reset is \d+s away, past the 300s cap/);
});

test('t/238 record-base-ref: a 5xx backs off 5 s, then 10 s, and fails closed after 3 attempts', { skip: !haveBash && 'bash not available' }, () => {
  const r = runStep([{ status: 502, message: 'Bad Gateway' }]);
  assert.equal(r.code, 1);
  assert.equal(r.posts, 3);
  assert.deepEqual(r.sleeps, [5, 10]);
  assert.match(r.out, /::error::record-base-ref: could not post the status after 3 attempts/);
});

test('t/238 record-base-ref: a permission 403 is not retried', { skip: !haveBash && 'bash not available' }, () => {
  const r = runStep([{ status: 403, message: 'Resource not accessible by integration' }, 'ok']);
  assert.equal(r.code, 1);
  assert.equal(r.posts, 1);
  assert.deepEqual(r.sleeps, []);
  assert.match(r.out, /::error::record-base-ref: not retryable/);
});
