// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/709: when the debate-tested sweep reads 0 debate session files it must say `no input (0 files)` (a ::warning:: and a summary line)
// and must not claim a clean lag reading. The shipped shell of the sweep step and the post-sweep step is extracted from the workflow
// and run in bash with a fake `pnpm` that prints a canned sweep output, so this exercises the real text.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { noInputMessages, sessionFileCount } from './debate-tested-input.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', '..');
const WF = path.join(ROOT, '.github', 'workflows', 'debate-tested-sweep.yml');
const bash = process.platform === 'win32' ? 'bash.exe' : 'bash';
const haveBash = spawnSync(bash, ['-c', 'true']).status === 0;
const opts = { skip: !haveBash && 'bash not available' };
const posix = (p) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);

function stepRun(namePattern) {
  const lines = readFileSync(WF, 'utf8').replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => namePattern.test(l));
  assert.notEqual(start, -1, `step ${namePattern} not found`);
  const runAt = lines.findIndex((l, i) => i > start && /^\s+run: \|\s*$/.test(l));
  const indent = lines[runAt + 1].match(/^\s*/)[0];
  const body = [];
  for (let i = runAt + 1; i < lines.length; i++) {
    if (lines[i].trim() !== '' && !lines[i].startsWith(indent)) break;
    body.push(lines[i].slice(indent.length));
  }
  return body.join('\n');
}
const SWEEP = () => stepRun(/- name: Run debate-tested backfill \(--write\)/);
const POST = () => stepRun(/- name: Post-sweep assert-visible/);

/** Runs a step's shell with a fake pnpm that prints `sweepOutput`. */
function runStep(script, { sweepOutput, filesOutput }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dts-'));
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(dir, 'canned.txt'), sweepOutput);
  writeFileSync(path.join(bin, 'pnpm'), `#!/usr/bin/env bash\ncat "${posix(path.join(dir, 'canned.txt'))}"\n`);
  chmodSync(path.join(bin, 'pnpm'), 0o755);
  const out = path.join(dir, 'output.txt');
  const sum = path.join(dir, 'summary.txt');
  writeFileSync(out, ''); writeFileSync(sum, '');
  const subst = script.replaceAll('${{ steps.sweep.outputs.files }}', filesOutput ?? '');
  const r = spawnSync(bash, ['-c', subst], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, PATH: `${posix(bin)}:${process.env.PATH}`, GITHUB_OUTPUT: posix(out), GITHUB_STEP_SUMMARY: posix(sum), AI_TRIAD_DATA_ROOT: '/nonexistent' },
  });
  return { code: r.status, text: `${r.stdout}${r.stderr}`, outputs: readFileSync(out, 'utf8'), summary: readFileSync(sum, 'utf8') };
}

const sweepOut = (files, created = 0, lag = 0) => `Found ${files} debate session files\n\nBACKFILL SUMMARY\nSessions processed: ${files}\nEntries created: ${created}\n\n  Cited nodes (BDI): 0  |  Harvested: 0  |  Lag: ${lag}\n`;

test('t/709 pure: the file count is read from the single "Found N debate session files" line, never guessed', () => {
  assert.equal(sessionFileCount('Found 308 debate session files\n'), 308);
  assert.equal(sessionFileCount('noise\nFound 0 debate session files\nmore'), 0);
  for (const bad of ['', 'Found debate session files', 'Found 3 sessions', 'x Found 3 debate session files', 'Found 3 debate session files\nFound 4 debate session files', undefined, null, 'Found 99999999999999999999 debate session files']) {
    assert.equal(sessionFileCount(bad), null, JSON.stringify(bad));
  }
  const m = noInputMessages();
  assert.match(m.warning, /^::warning::/);
  assert.match(m.summary, /no input \(0 files\)/);
});

test('t/709: a sweep that reads 0 files warns "no input (0 files)", writes the summary line and reports files=0', opts, () => {
  const r = runStep(SWEEP(), { sweepOutput: sweepOut(0) });
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /::warning::t\/709: the debate-tested sweep read 0 debate session files \(no input\)/);
  assert.match(r.summary, /\*\*no input \(0 files\)\*\*/);
  assert.match(r.outputs, /^files=0$/m);
  assert.match(r.outputs, /^created=0$/m);
});

test('t/709: a sweep that reads files has no no-input warning or summary and reports the count', opts, () => {
  const r = runStep(SWEEP(), { sweepOutput: sweepOut(308) });
  assert.equal(r.code, 0, r.text);
  assert.doesNotMatch(r.text, /::warning::t\/709/);
  assert.equal(r.summary, '');
  assert.match(r.outputs, /^files=308$/m);
});

test('t/709 fail closed: a sweep output without the "Found N debate session files" line is an error, never "files=0" or a pass', opts, () => {
  for (const out of ['Entries created: 0\nLag: 0\n', '', 'Found 3 debate session files\nFound 4 debate session files\n']) {
    const r = runStep(SWEEP(), { sweepOutput: out });
    assert.equal(r.code, 1, JSON.stringify(out));
    assert.match(r.text, /::error::t\/709: could not read the 'Found N debate session files' line/);
    assert.doesNotMatch(r.outputs, /^files=/m);
  }
});

test('t/709: the post-sweep lag assertion is not evaluated on no input: it warns, summarises, exits 0 and never claims lag=0', opts, () => {
  const r = runStep(POST(), { sweepOutput: sweepOut(0), filesOutput: '0' });
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /::warning::t\/709: no input \(0 files\): the post-sweep lag assertion was NOT evaluated/);
  assert.match(r.summary, /no input \(0 files\)/);
  assert.doesNotMatch(r.text, /Post-sweep lag=0|data repo reflects the sweep|post-sweep lag=/);
});

test('t/709: with input the post-sweep assertion is unchanged: lag 0 passes, a lag above 0 or an unparsed lag fails', opts, () => {
  const ok = runStep(POST(), { sweepOutput: sweepOut(308, 0, 0), filesOutput: '308' });
  assert.equal(ok.code, 0, ok.text);
  assert.match(ok.text, /Post-sweep lag=0 — data repo reflects the sweep/);
  const lagging = runStep(POST(), { sweepOutput: sweepOut(308, 0, 4), filesOutput: '308' });
  assert.equal(lagging.code, 1);
  assert.match(lagging.text, /Post-sweep debate-tested lag=4/);
  const unparsed = runStep(POST(), { sweepOutput: 'Found 308 debate session files\n', filesOutput: '308' });
  assert.equal(unparsed.code, 1, 'an unparsed lag still fails (the original rule)');
});

test('t/709: an empty or missing files output (the step did not run) does NOT take the no-input path: the original assertion runs', opts, () => {
  const r = runStep(POST(), { sweepOutput: sweepOut(5, 0, 2), filesOutput: '' });
  assert.equal(r.code, 1, 'lag 2 fails as before');
});

test('t/709: the workflow wires the helper, the output and the header note', () => {
  const text = readFileSync(WF, 'utf8');
  assert.match(text, /node operations\/devops\/debate-tested-input\.mjs/);
  assert.match(text, /echo "files=\$files" >> "\$GITHUB_OUTPUT"/);
  assert.match(text, /steps\.sweep\.outputs\.files/);
  assert.match(text, /t\/709: a run that reads 0 debate files is reported as `no input \(0 files\)`/);
});
