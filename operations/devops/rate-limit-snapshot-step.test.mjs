// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/314 (t/313 observability): the rate-limit snapshot step is inline in every per-PR guard
// (some guards have no checkout), so this test is what keeps it ONE helper:
//   1. every guard workflow carries operations/devops/rate-limit-snapshot-step.yml verbatim, as
//      the last step of its guard job;
//   2. the step's script, run under bash against a fake `gh`, records the numbers when it can
//      read them and only WARNs (exit 0, no summary) when it can't.
// Run: node --test operations/devops/rate-limit-snapshot-step.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { SNAPSHOT_TARGETS, jobBlock } from './rate-limit-snapshot-targets.mjs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const lf = (s) => s.replace(/\r\n/g, '\n');
const CANONICAL = lf(readFileSync(path.join(here, 'rate-limit-snapshot-step.yml'), 'utf8'));
// t/318: the target list (file + job) is shared with the insertion helper, so the jobs that carry
// the step and the jobs this test checks can never drift apart.
test('every target job carries the canonical rate-limit snapshot step verbatim, as its final step', () => {
  for (const [file, job] of SNAPSHOT_TARGETS) {
    const text = lf(readFileSync(path.join(root, '.github', 'workflows', file), 'utf8'));
    const block = jobBlock(text, job);
    assert.ok(block, `${file}: job '${job}' not found`);
    assert.ok(block.endsWith(CANONICAL.trimEnd()), `${file}:${job}: the snapshot step is missing, differs from operations/devops/rate-limit-snapshot-step.yml, or is not the job's last step (it records end-of-job usage)`);
  }
});

test('jobBlock finds a job between its key and the next job, excluding trailing blank lines', () => {
  const wf = 'name: x\non: push\njobs:\n  a:\n    runs-on: u\n    steps:\n      - run: one\n\n  b:\n    steps:\n      - run: two\n';
  assert.equal(jobBlock(wf, 'a'), '  a:\n    runs-on: u\n    steps:\n      - run: one');
  assert.equal(jobBlock(wf, 'b'), '  b:\n    steps:\n      - run: two');
  assert.equal(jobBlock(wf, 'c'), null);
});

test('the canonical step can never fail or block a guard', () => {
  assert.match(CANONICAL, /^ {8}continue-on-error: true$/m);
  assert.match(CANONICAL, /^ {8}if: \$\{\{ !cancelled\(\) \}\}$/m);
  // Second-Opinion (#5029): continue-on-error does not cover a HANG. Without a step timeout a
  // stalled `gh api` holds a required guard pending for the 360-minute job default.
  assert.match(CANONICAL, /^ {8}timeout-minutes: 1$/m);
});

// ── run the step's script under bash with a fake `gh` ──
function runScript(step = CANONICAL) {
  const lines = step.split('\n');
  const start = lines.findIndex((l) => /^ {8}run: \|$/.test(l));
  return lines.slice(start + 1).filter((l) => l.startsWith('          ') || l === '').map((l) => l.slice(10)).join('\n');
}

function bashPath() {
  for (const p of ['/bin/bash', '/usr/bin/bash', 'C:\\Program Files\\Git\\bin\\bash.exe']) if (existsSync(p)) return p;
  try { return execFileSync(process.platform === 'win32' ? 'where' : 'which', ['bash'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim(); } catch { return null; }
}
const BASH = bashPath();

function runWithFakeGh(ghBody, step = CANONICAL) {
  const dir = mkdtempSync(path.join(tmpdir(), 't314-'));
  try {
    writeFileSync(path.join(dir, 'gh'), `#!/usr/bin/env bash\n${ghBody}\n`);
    chmodSync(path.join(dir, 'gh'), 0o755);
    writeFileSync(path.join(dir, 'step.sh'), runScript(step));
    const summary = path.join(dir, 'summary.md');
    // Git Bash on Windows: a `C:/...` entry would split PATH at the drive colon, so use the MSYS
    // form `/c/...`. Linux paths are unchanged.
    const fwd = (p) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):\//, (_, d) => `/${d.toLowerCase()}/`);
    const r = spawnSync(BASH, ['-c', `export PATH="${fwd(dir)}:$PATH"; bash "${fwd(path.join(dir, 'step.sh'))}"`], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_STEP_SUMMARY: fwd(summary), GITHUB_WORKFLOW: 'joint-gv-guard', GITHUB_JOB: 'joint-gv-guard' },
    });
    return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? ''), summary: existsSync(summary) ? readFileSync(summary, 'utf8') : '' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('readable /rate_limit: one greppable log line and a summary table, exit 0', { skip: !BASH && 'no bash' }, () => {
  const r = runWithFakeGh(`echo '812,188,1000,1794371400,40,4960,5000'`);
  assert.equal(r.code, 0);
  assert.match(r.out, /t\/314 rate-limit: workflow=joint-gv-guard job=joint-gv-guard core used=812 remaining=188 limit=1000 reset=\d\d:\d\d:\d\dZ graphql used=40 remaining=4960 limit=5000/);
  assert.match(r.summary, /\| REST core \| 812 \| 188 \| 1000 \|/);
  assert.match(r.summary, /\| GraphQL \| 40 \| 4960 \| 5000 \|/);
});

test('gh fails (e.g. the quota itself is gone): WARN only, exit 0, no summary', { skip: !BASH && 'no bash' }, () => {
  const r = runWithFakeGh(`echo 'HTTP 403: API rate limit exceeded for installation' >&2; exit 1`);
  assert.equal(r.code, 0);
  assert.match(r.out, /::warning::t\/314: could not read GET \/rate_limit/);
  assert.equal(r.summary, '');
});

test('gh prints something that is not seven numbers: WARN only, never a bogus table', { skip: !BASH && 'no bash' }, () => {
  const r = runWithFakeGh(`echo 'unexpected shape of response from server'`);
  assert.equal(r.code, 0);
  assert.match(r.out, /::warning::t\/314/);
  assert.equal(r.summary, '');
});

// Quality, #5028 review: with whitespace-split reads an EMPTY field shifted the later values
// (used=6 remaining=7 limit="") and still passed a concatenated-digits check.
test('an empty field (e.g. graphql.used missing) WARNs instead of shifting later values into the wrong columns', { skip: !BASH && 'no bash' }, () => {
  const r = runWithFakeGh(`echo '812,188,1000,1794371400,,4960,5000'`);
  assert.equal(r.code, 0);
  assert.match(r.out, /::warning::t\/314/);
  assert.doesNotMatch(r.out, /t\/314 rate-limit:/);
  assert.equal(r.summary, '');
});

test('null (jq tostring -> "null") or an extra field WARNs, never a table', { skip: !BASH && 'no bash' }, () => {
  for (const line of ['812,188,1000,1794371400,null,4960,5000', '812,188,1000,1794371400,40,4960,5000,9']) {
    const r = runWithFakeGh(`echo '${line}'`);
    assert.equal(r.code, 0, line);
    assert.match(r.out, /::warning::t\/314/, line);
    assert.equal(r.summary, '', line);
  }
});

// ── t/318 (TL p/9#46): the App-token variant, for the enqueue sweep's own pool ──
const APP_STEP = lf(readFileSync(path.join(here, 'rate-limit-snapshot-step-app.yml'), 'utf8'));
const stepOf = (s) => s.slice(s.indexOf('      - name: '));
// The ONLY allowed differences from the canonical step. Anything else (e.g. a parse fix landed in
// one copy but not the other) fails parity.
function toAppVariant(canonicalStep) {
  return canonicalStep
    .replace('      - name: Rate-limit snapshot (t/314)', '      - name: Rate-limit snapshot, App token (t/318)')
    .replace("        if: ${{ !cancelled() }}", "        if: ${{ !cancelled() && steps.app.outputs.token != '' }}")
    .replace('          GH_TOKEN: ${{ github.token }}', '          GH_TOKEN: ${{ steps.app.outputs.token }}')
    .replace('echo "t/314 rate-limit: workflow=', 'echo "t/314 rate-limit: pool=app workflow=')
    .replace('### GITHUB_TOKEN rate limit at end of job (t/314)', '### GitHub App installation token rate limit at end of job (t/318)')
    .replace('::warning::t/314: could not read GET /rate_limit, so no rate-limit snapshot', '::warning::t/318: could not read GET /rate_limit with the App token, so no App-pool snapshot');
}

test('App variant = canonical step with only the token and label substitutions (parity)', () => {
  assert.equal(stepOf(APP_STEP), toAppVariant(stepOf(CANONICAL)));
  assert.match(APP_STEP, /^ {8}continue-on-error: true$/m);
  assert.match(APP_STEP, /^ {8}timeout-minutes: 1$/m);
});

test('enqueue-sweep: the App variant sits immediately before the canonical step at the end of the sweep job', () => {
  const block = jobBlock(lf(readFileSync(path.join(root, '.github', 'workflows', 'enqueue-sweep.yml'), 'utf8')), 'sweep');
  assert.ok(block.endsWith(`${APP_STEP.trimEnd()}\n\n${CANONICAL.trimEnd()}`), 'enqueue-sweep.yml sweep: expected <App variant><blank line><canonical step> at the end of the job');
});

test('App variant script: readable /rate_limit logs a pool=app line, exit 0', { skip: !BASH && 'no bash' }, () => {
  const r = runWithFakeGh(`echo '120,4880,5000,1794371400,900,4100,5000'`, APP_STEP);
  assert.equal(r.code, 0);
  assert.match(r.out, /t\/314 rate-limit: pool=app workflow=joint-gv-guard job=joint-gv-guard core used=120 remaining=4880 limit=5000/);
  assert.match(r.summary, /GitHub App installation token rate limit/);
});
