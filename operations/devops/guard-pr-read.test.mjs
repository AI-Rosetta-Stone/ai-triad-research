// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/369 (t/313): consult-hold-guard and joint-gv-guard read the PR over REST through one inline
// helper (they have no checkout). This test keeps it one helper and proves each failure class:
//   1. both guards carry operations/devops/guard-pr-read.sh verbatim;
//   2. the helper, run under bash with a fake `gh` and a fake `sleep`, classifies primary-quota
//      exhaustion and over-cap secondary limits as the agreed INFRA rate-limit line (the string
//      DevOps & Release's ci-infra-rerun matches), waits retry-after (capped) for secondary limits,
//      backs off 3/6/9s for 5xx, and fails at once on any other 4xx;
//   3. each guard's real step, end to end, still blocks and passes on the REST payload.
// Run: node --test operations/devops/guard-pr-read.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const lf = (s) => s.replace(/\r\n/g, '\n');
const CANONICAL = lf(readFileSync(path.join(here, 'guard-pr-read.sh'), 'utf8')).trimEnd();
const GUARDS = [
  { file: 'consult-hold-guard.yml', step: 'Refuse merge while a consult-hold label is present' },
  { file: 'joint-gv-guard.yml', step: 'Check joint-gv label + auto-merge state' },
];
const wf = (file) => lf(readFileSync(path.join(root, '.github', 'workflows', file), 'utf8'));

/** The `run: |` script of the named step, dedented. */
function stepScript(file, name) {
  const lines = wf(file).split('\n');
  const at = lines.findIndex((l) => l === `      - name: ${name}`);
  assert.ok(at >= 0, `${file}: step '${name}' not found`);
  const run = lines.findIndex((l, i) => i > at && /^ {8}run: \|$/.test(l));
  const body = [];
  for (const l of lines.slice(run + 1)) {
    if (l !== '' && !l.startsWith('          ')) break;
    body.push(l.slice(10));
  }
  return body.join('\n');
}

test('both guards carry the canonical guard-pr-read block verbatim and call it', () => {
  for (const { file, step } of GUARDS) {
    const script = stepScript(file, step);
    assert.ok(script.includes(CANONICAL), `${file}: the guard-pr-read block is missing or differs from operations/devops/guard-pr-read.sh`);
    assert.match(script, /^guard_read_pr [a-z-]+ "\$REPO" "\$PR_NUMBER" "[^"]+"$/m, `${file}: guard_read_pr is never called`);
    assert.doesNotMatch(script.replace(/^\s*#.*$/gm, ''), /gh pr view|graphql/, `${file}: still reads the PR over GraphQL`);
  }
});

// ── run under bash with a fake `gh` (one scripted response per call) and a fake `sleep` ──
function bashPath() {
  for (const p of ['/bin/bash', '/usr/bin/bash', 'C:\\Program Files\\Git\\bin\\bash.exe']) if (existsSync(p)) return p;
  try { return execFileSync(process.platform === 'win32' ? 'where' : 'which', ['bash'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim(); } catch { return null; }
}
const BASH = bashPath();
const skip = !BASH && 'no bash';
// Git Bash on Windows: a `C:/...` PATH entry splits at the drive colon, so use the MSYS form.
const fwd = (p) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):\//, (_, d) => `/${d.toLowerCase()}/`);

const RESET = Date.parse('2026-11-11T14:40:00Z') / 1000;
const PR_OK = JSON.stringify({ number: 7, labels: [], auto_merge: null });
const ok = (body = PR_OK) => ({ status: 200, body });
const primary = (resource = 'core') => ({ status: 403, headers: { 'X-Ratelimit-Remaining': '0', 'X-Ratelimit-Reset': String(RESET), 'X-Ratelimit-Resource': resource }, body: '{"message":"API rate limit exceeded"}' });
const secondary = (retryAfter) => ({ status: 403, headers: { 'X-Ratelimit-Remaining': '4000', ...(retryAfter != null && { 'Retry-After': String(retryAfter) }) }, body: '{"message":"You have exceeded a secondary rate limit."}' });
const http = (status) => ({ status, body: '{"message":"x"}' });
const NETWORK = { network: true };

/** Runs `script` with gh answering `responses` in order. Returns exit code, output, gh call count, sleeps, step outputs. */
function run(script, responses) {
  const dir = mkdtempSync(path.join(tmpdir(), 't369-'));
  try {
    responses.forEach((r, i) => {
      const n = i + 1;
      if (r.network) {
        writeFileSync(path.join(dir, `resp.${n}`), '');
        writeFileSync(path.join(dir, `rc.${n}`), '1');
        return;
      }
      const hdrs = Object.entries(r.headers ?? {}).map(([k, v]) => `${k}: ${v}\r\n`).join('');
      writeFileSync(path.join(dir, `resp.${n}`), `HTTP/2.0 ${r.status} X\r\nContent-Type: application/json\r\n${hdrs}\r\n${r.body}`);
      writeFileSync(path.join(dir, `rc.${n}`), r.status < 400 ? '0' : '1');
    });
    const d = fwd(dir);
    writeFileSync(path.join(dir, 'gh'), `#!/usr/bin/env bash
n=$(( $(cat "${d}/calls" 2>/dev/null || echo 0) + 1 )); echo "$n" >"${d}/calls"
echo "$*" >>"${d}/args"
[ -f "${d}/resp.$n" ] || { echo "fake gh: no response $n" >&2; exit 99; }
cat "${d}/resp.$n"
rc=$(cat "${d}/rc.$n"); [ "$rc" = 0 ] || echo "gh: request failed (fake call $n)" >&2
exit "$rc"
`);
    writeFileSync(path.join(dir, 'sleep'), `#!/usr/bin/env bash\necho "$1" >>"${d}/sleeps"\n`);
    chmodSync(path.join(dir, 'gh'), 0o755);
    chmodSync(path.join(dir, 'sleep'), 0o755);
    writeFileSync(path.join(dir, 'step.sh'), script);
    const r = spawnSync(BASH, ['-c', `export PATH="${d}:$PATH"; bash -eo pipefail "${d}/step.sh"`], {
      encoding: 'utf8',
      env: { ...process.env, RUNNER_TEMP: d, GITHUB_OUTPUT: `${d}/output` },
    });
    const read = (f) => (existsSync(path.join(dir, f)) ? readFileSync(path.join(dir, f), 'utf8') : '');
    return {
      code: r.status,
      out: (r.stdout ?? '') + (r.stderr ?? ''),
      calls: Number(read('calls') || 0),
      args: read('args'),
      sleeps: read('sleeps').split('\n').filter(Boolean).map(Number),
      output: read('output'),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The helper alone, exactly as a guard runs it.
const helper = (responses) => run(`set -euo pipefail\n${CANONICAL}\nguard_read_pr test-guard o/r 7 "a hold"\necho "PR_JSON=$PR_JSON"\n`, responses);
const INFRA = (pool) => `::error::INFRA rate-limit: GitHub API quota exhausted (pool=${pool}), resets=2026-11-11T14:40:00Z; not a policy verdict, re-run after the reset`;

test('200: one REST call, PR_JSON is the body without headers, no sleep', { skip }, () => {
  const r = helper([ok()]);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.calls, 1);
  assert.match(r.args, /^api -i repos\/o\/r\/pulls\/7$/m);
  assert.ok(r.out.includes(`PR_JSON=${PR_OK}`), r.out);
  assert.deepEqual(r.sleeps, []);
});

test('primary quota at 0: the agreed INFRA line + step outputs at once, never sleeps to the reset', { skip }, () => {
  const r = helper([primary()]);
  assert.equal(r.code, 1);
  assert.equal(r.calls, 1);
  assert.deepEqual(r.sleeps, []);
  assert.ok(r.out.includes(INFRA('core')), r.out);
  assert.equal(r.output, 'infra=rate-limit\nresets=2026-11-11T14:40:00Z\n');
});

test('primary at 0 on 429 also classifies; the pool comes from x-ratelimit-resource', { skip }, () => {
  const r = helper([{ ...primary('graphql'), status: 429 }]);
  assert.equal(r.code, 1);
  assert.ok(r.out.includes(INFRA('graphql')), r.out);
});

test('secondary limit with retry-after <= 90: waits exactly retry-after, then succeeds', { skip }, () => {
  const r = helper([secondary(30), ok()]);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.sleeps, [30]);
  assert.equal(r.calls, 2);
  assert.doesNotMatch(r.out, /INFRA rate-limit/);
});

test('secondary limit without retry-after: waits 60s (GitHub guidance), then succeeds', { skip }, () => {
  const r = helper([secondary(null), ok()]);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.sleeps, [60]);
});

test('secondary retry-after over the 90s cap: INFRA line with pool=secondary at once, no sleep', { skip }, () => {
  const before = Math.floor(Date.now() / 1000);
  const r = helper([secondary(120)]);
  assert.equal(r.code, 1);
  assert.deepEqual(r.sleeps, []);
  const m = r.out.match(/::error::INFRA rate-limit: GitHub API quota exhausted \(pool=secondary\), resets=(\S+)Z; not a policy verdict, re-run after the reset/);
  assert.ok(m, r.out);
  const resets = Date.parse(`${m[1]}Z`) / 1000;
  assert.ok(resets >= before + 120 && resets <= before + 130, `resets=${m[1]} is not ~now+120s`);
  assert.match(r.output, /^infra=rate-limit\nresets=\S+Z\n$/);
});

test('secondary limit on all 3 attempts: two capped waits, then the INFRA line', { skip }, () => {
  const r = helper([secondary(5), secondary(5), secondary(5)]);
  assert.equal(r.code, 1);
  assert.deepEqual(r.sleeps, [5, 5]);
  assert.equal(r.calls, 3);
  assert.match(r.out, /INFRA rate-limit: GitHub API quota exhausted \(pool=secondary\)/);
});

test('5xx: 3/6/9s backoff, then a 5xx recovers', { skip }, () => {
  const r = helper([http(502), http(503), ok()]);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.sleeps, [3, 6]);
});

test('5xx on all 3 attempts: fails closed after 3/6/9s, names API/INFRA, NOT the rate-limit class', { skip }, () => {
  const r = helper([http(502), http(504), http(500)]);
  assert.equal(r.code, 1);
  assert.deepEqual(r.sleeps, [3, 6, 9]);
  assert.match(r.out, /::error::test-guard: could NOT read the PR after 3 attempts — API\/INFRA failure, NOT a hold/);
  assert.doesNotMatch(r.out, /INFRA rate-limit/);
  assert.equal(r.output, '');
});

test('no HTTP response at all (network): retried like a 5xx', { skip }, () => {
  const r = helper([NETWORK, ok()]);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.sleeps, [3]);
});

for (const [status, extra] of [[404, {}], [401, {}], [403, { headers: { 'X-Ratelimit-Remaining': '4000' } }]]) {
  test(`HTTP ${status} that is not a rate limit: fails at once, one call, no sleep, not the INFRA class`, { skip }, () => {
    const r = helper([{ ...http(status), ...extra }]);
    assert.equal(r.code, 1);
    assert.equal(r.calls, 1);
    assert.deepEqual(r.sleeps, []);
    assert.match(r.out, new RegExp(`::error::test-guard: could NOT read the PR \\(HTTP ${status}\\) — API failure, NOT a hold`));
    assert.doesNotMatch(r.out, /INFRA rate-limit/);
  });
}

// ── each guard's real step, end to end, on the REST payload (the guards parse it with jq, which
// ubuntu runners carry; skipped where it is absent, e.g. a bare Git Bash) ──
const HAS_JQ = !!BASH && spawnSync(BASH, ['-c', 'command -v jq'], { encoding: 'utf8' }).status === 0;
const skipE2E = skip || (!HAS_JQ && 'no jq');
const guardStep = (file, step) => stepScript(file, step)
  .replaceAll('${{ github.event.pull_request.number }}', '7')
  .replaceAll('${{ github.repository }}', 'o/r');
const pr = (labels, autoMerge) => ok(JSON.stringify({ number: 7, labels: labels.map((name) => ({ name })), auto_merge: autoMerge }));
const consult = (resp) => run(guardStep(...Object.values(GUARDS[0])), resp);
const jointGv = (resp) => run(guardStep(...Object.values(GUARDS[1])), resp);

test('consult-hold-guard: the label blocks; no label passes', { skip: skipE2E }, () => {
  const held = consult([pr(['consult-hold'], null)]);
  assert.equal(held.code, 1);
  assert.match(held.out, /this PR carries the 'consult-hold' label/);
  const clear = consult([pr(['bug'], null)]);
  assert.equal(clear.code, 0, clear.out);
  assert.match(clear.out, /guard OK — no consult-hold label present/);
});

test('joint-gv-guard: joint-gv + auto_merge armed blocks; either alone passes', { skip: skipE2E }, () => {
  const armed = { enabled_by: { login: 'x' }, merge_method: 'squash' };
  const bad = jointGv([pr(['joint-gv'], armed)]);
  assert.equal(bad.code, 1);
  assert.match(bad.out, /joint-gv PR has auto-merge enabled/);
  assert.equal(jointGv([pr(['joint-gv'], null)]).code, 0);
  assert.equal(jointGv([pr([], armed)]).code, 0);
});

test('both guards: a payload without the REST fields is MALFORMED, not a pass', { skip: skipE2E }, () => {
  assert.match(consult([ok('{}')]).out, /payload is MALFORMED \(missing labels\)/);
  const r = jointGv([ok(JSON.stringify({ labels: [] }))]);
  assert.equal(r.code, 1);
  assert.match(r.out, /payload is MALFORMED \(missing labels\/auto_merge\)/);
});

test('both guards: primary exhaustion fails with the agreed INFRA line, not a policy verdict', { skip: skipE2E }, () => {
  for (const go of [consult, jointGv]) {
    const r = go([primary()]);
    assert.equal(r.code, 1);
    assert.ok(r.out.includes(INFRA('core')), r.out);
    assert.doesNotMatch(r.out, /guard OK|carries the 'consult-hold' label|auto-merge enabled/);
  }
});
