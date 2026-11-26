// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Tests for packed-extract-gate.mjs (t/660) and for the ci.yml job that runs it.
// Run: node --test operations/devops/packed-extract-gate.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GATE, pickExecutable, evaluatePackedExtract, inspectPackedApp, runCheck, runCli } from './packed-extract-gate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CI = readFileSync(join(HERE, '..', '..', '.github', 'workflows', 'ci.yml'), 'utf8').replace(/\r\n/g, '\n');

const file = (name, mode = 0o644) => ({ name, isFile: true, mode });
const dir = (name) => ({ name, isFile: false, mode: 0o755 });

// ── pickExecutable ──

test('pickExecutable: Linux takes the one extensionless executable and ignores the helpers', () => {
  const entries = [
    dir('resources'), dir('locales'),
    file('taxonomy-editor', 0o755), file('chrome-sandbox', 0o4755), file('chrome_crashpad_handler', 0o755),
    file('libffmpeg.so', 0o755), file('icudtl.dat'), file('LICENSE.electron.txt'), file('version'),
  ];
  assert.deepEqual(pickExecutable(entries, 'linux'), { exe: 'taxonomy-editor' });
});

test('pickExecutable: Windows takes the one .exe', () => {
  const entries = [dir('resources'), file('AI Triad Taxonomy Editor.exe'), file('ffmpeg.dll'), file('LICENSES.chromium.html')];
  assert.deepEqual(pickExecutable(entries, 'win32'), { exe: 'AI Triad Taxonomy Editor.exe' });
});

test('pickExecutable: none or several candidates is an error naming them, never a guess', () => {
  assert.match(pickExecutable([dir('resources'), file('version')], 'linux').error, /no executable found/);
  const two = pickExecutable([file('app-a', 0o755), file('app-b', 0o755)], 'linux');
  assert.match(two.error, /2 executables found, expected one: app-a, app-b/);
});

// ── evaluatePackedExtract: the three verdicts ──

test('PASS: exit 0 with an extraction line', () => {
  const v = evaluatePackedExtract({ status: 0, ms: 812, output: 't276-fixture-text.pdf: OK format=pdf words=12\nt276-fixture-image-only.pdf: THREW code=NO_TEXT problem=no text layer inner=\n' });
  assert.equal(v.verdict, 'PASS');
  assert.equal(v.gate, GATE);
  assert.match(v.reason, /1 fixture\(s\) extracted through the packed app in 812 ms/);
});

test('FAIL: a non-zero exit, with the THREW line in the reason', () => {
  const v = evaluatePackedExtract({ status: 1, ms: 300, output: "t276-fixture-text.pdf: THREW code=PARSER_UNAVAILABLE problem=Cannot find package 'pdfjs-dist' inner=\n" });
  assert.equal(v.verdict, 'FAIL');
  assert.match(v.reason, /exited 1 in 300 ms: t276-fixture-text\.pdf: THREW code=PARSER_UNAVAILABLE/);
});

test('FAIL: a FATAL import error from the packed app is a failure, not unreadable', () => {
  const v = evaluatePackedExtract({ status: 1, output: 'FATAL Error: Cannot find module app.asar/dist/main/lib/extraction/extractDocumentText.js\n' });
  assert.equal(v.verdict, 'FAIL');
  assert.match(v.reason, /FATAL Error: Cannot find module/);
});

test('GATE-UNREADABLE: every way of having no answer, each with its reason', () => {
  const cases = [
    [{ problem: 'the check script is not in this checkout: lib/extraction/packed-extract-check.cjs' }, /check script is not in this checkout/],
    [{ spawnError: Object.assign(new Error('spawn x ENOENT'), { code: 'ENOENT' }), status: null }, /could not be started: target not found/],
    [{ timedOut: true, status: null, signal: 'SIGTERM', ms: 120000 }, /did not finish in 120000 ms and was killed/],
    [{ status: null, signal: 'SIGSEGV' }, /no exit code \(signal SIGSEGV\)/],
    [{ status: 0, output: 'something else entirely\n' }, /exited 0 but printed no/],
    [{ status: 0, output: '' }, /exited 0 but printed no/],
  ];
  for (const [input, reason] of cases) {
    const v = evaluatePackedExtract(input);
    assert.equal(v.verdict, 'GATE-UNREADABLE', JSON.stringify(input));
    assert.match(v.reason, reason);
  }
});

// ── inspectPackedApp against a real directory tree ──

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'packed-extract-'));
  const unpacked = join(root, 'linux-unpacked');
  mkdirSync(join(unpacked, 'resources'), { recursive: true });
  const check = join(root, 'check.cjs');
  const fixtures = join(root, 'fixtures');
  mkdirSync(fixtures);
  return { root, unpacked, check, fixtures };
}

test('inspectPackedApp: names what is missing, in the order a reader would fix it', () => {
  const s = scratch();
  assert.match(inspectPackedApp(s, 'win32').problem, /check script is not in this checkout/);
  writeFileSync(s.check, '');
  assert.match(inspectPackedApp({ ...s, fixtures: join(s.root, 'nope') }, 'win32').problem, /fixtures dir is not in this checkout/);
  assert.match(inspectPackedApp({ ...s, unpacked: join(s.root, 'nope') }, 'win32').problem, /packed build is missing/);
  assert.match(inspectPackedApp(s, 'win32').problem, /no app\.asar under/);
  writeFileSync(join(s.unpacked, 'resources', 'app.asar'), 'x');
  assert.match(inspectPackedApp(s, 'win32').problem, /no executable found/);
  writeFileSync(join(s.unpacked, 'App.exe'), 'x');
  const ok = inspectPackedApp(s, 'win32');
  assert.equal(ok.exe, join(s.unpacked, 'App.exe'));
  assert.equal(ok.resources, join(s.unpacked, 'resources'));
});

test('inspectPackedApp: on POSIX the execute bit picks the binary', { skip: process.platform === 'win32' && 'Windows has no execute bit' }, () => {
  const s = scratch();
  writeFileSync(s.check, '');
  writeFileSync(join(s.unpacked, 'resources', 'app.asar'), 'x');
  writeFileSync(join(s.unpacked, 'version'), '1');
  writeFileSync(join(s.unpacked, 'taxonomy-editor'), 'x');
  chmodSync(join(s.unpacked, 'taxonomy-editor'), 0o755);
  assert.equal(inspectPackedApp(s, process.platform).exe, join(s.unpacked, 'taxonomy-editor'));
});

// ── runCheck + runCli with a real child process (node stands in for the packed binary) ──

function fakeCheck(body) {
  const s = scratch();
  writeFileSync(s.check, body);
  return s;
}
const CHECK_OK = `
if (process.env.ELECTRON_RUN_AS_NODE !== '1') { console.log('FATAL ELECTRON_RUN_AS_NODE not set'); process.exit(1); }
const [resources, fixtures] = process.argv.slice(2);
if (!resources || !fixtures) { console.log('FATAL missing args'); process.exit(1); }
console.log('t276-fixture-text.pdf: OK format=pdf words=12');
`;
const CHECK_THREW = `console.log("t276-fixture-text.pdf: THREW code=PARSER_UNAVAILABLE problem=Cannot find package 'pdfjs-dist' inner="); process.exitCode = 1;`;

function cli(s, body, extra = []) {
  const logs = [];
  const written = {};
  const code = runCli(['--unpacked', s.unpacked, '--check', s.check, '--fixtures', s.fixtures, ...extra], {
    // The real inspect needs a real packed app; node itself stands in for the executable here.
    inspect: body === null ? undefined : () => ({ exe: process.execPath, resources: join(s.unpacked, 'resources') }),
    log: (l) => logs.push(l),
    env: { GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: 'out', GITHUB_STEP_SUMMARY: 'sum' },
    append: (f, t) => { written[f] = (written[f] ?? '') + t; },
  });
  return { code, logs, written };
}

test('runCheck: sets ELECTRON_RUN_AS_NODE=1 and passes <check> <resources> <fixtures>', () => {
  const s = fakeCheck(CHECK_OK);
  const r = runCheck({ exe: process.execPath, check: s.check, resources: 'R', fixtures: 'F', timeoutSec: 60 });
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /t276-fixture-text\.pdf: OK format=pdf/);
  assert.equal(typeof r.ms, 'number');
});

test('runCheck: a missing executable is a spawn error, not a throw', () => {
  const s = fakeCheck(CHECK_OK);
  const r = runCheck({ exe: join(s.root, 'no-such-binary'), check: s.check, resources: 'R', fixtures: 'F', timeoutSec: 5 });
  assert.ok(r.spawnError);
  assert.equal(evaluatePackedExtract(r).verdict, 'GATE-UNREADABLE');
});

test('runCheck: a check that hangs is killed and reported as timed out', () => {
  const s = fakeCheck('setInterval(() => {}, 1000);');
  const r = runCheck({ exe: process.execPath, check: s.check, resources: 'R', fixtures: 'F', timeoutSec: 1 });
  assert.equal(r.timedOut, true);
  assert.match(evaluatePackedExtract(r).reason, /was killed \(timeout\)/);
});

test('runCli PASS: exit 0, verdict in the log, the step outputs and the summary, no annotation', () => {
  const { code, logs, written } = cli(fakeCheck(CHECK_OK), CHECK_OK);
  assert.equal(code, 0);
  assert.ok(logs.some((l) => l.startsWith(`GATE-VERDICT ${GATE}: PASS - `)), logs.join('\n'));
  assert.ok(logs.some((l) => /check wall time \d+ ms/.test(l)));
  assert.ok(!logs.some((l) => l.startsWith('::')));
  assert.match(written.out, /^gate=packed-extract-check\nverdict=PASS\nreason=/);
  assert.match(written.sum, /\*\*PASS\*\*/);
});

test('runCli FAIL: exit 1 and an ::error:: annotation', () => {
  const { code, logs, written } = cli(fakeCheck(CHECK_THREW), CHECK_THREW);
  assert.equal(code, 1);
  assert.ok(logs.some((l) => l.startsWith('::error title=FAIL::packed-extract-check: ')), logs.join('\n'));
  assert.match(written.out, /verdict=FAIL/);
});

test('runCli GATE-UNREADABLE: exit 0 with a WARN and a ::warning::, exit 2 with --strict', () => {
  const s = scratch(); // no check script, no app.asar, no executable: the real inspect refuses
  const plain = cli(s, null);
  assert.equal(plain.code, 0);
  assert.ok(plain.logs.some((l) => l.startsWith('WARN: packed-extract-gate did not run the check (the check script is not in this checkout')), plain.logs.join('\n'));
  assert.ok(plain.logs.some((l) => l.startsWith('::warning title=GATE-UNREADABLE::')));
  assert.match(plain.written.out, /verdict=GATE-UNREADABLE/);
  assert.equal(cli(s, null, ['--strict']).code, 2);
});

// ── the ci.yml job ──

function jobBlock(name) {
  const L = CI.split('\n');
  const s = L.indexOf(`  ${name}:`);
  if (s < 0) return null;
  let e = s + 1;
  while (e < L.length && !/^ {2}\S/.test(L[e])) e++;
  return L.slice(s, e).join('\n');
}

test('ci.yml: the packed-extract-check job packs taxonomy-editor and runs the gate script on the result', () => {
  const job = jobBlock('packed-extract-check');
  assert.ok(job, 'ci.yml has no packed-extract-check job');
  assert.match(job, /working-directory: taxonomy-editor\n\s+run: pnpm run build\n/);
  assert.match(job, /pnpm exec electron-builder --linux --dir --publish never/);
  assert.match(job, /node operations\/devops\/packed-extract-gate\.mjs \\\n\s+--unpacked taxonomy-editor\/release\/linux-unpacked \\\n\s+--check lib\/extraction\/packed-extract-check\.cjs \\\n\s+--fixtures lib\/extraction\/packed-fixtures\n/);
  // The check step itself must be able to fail the job: no continue-on-error anywhere in it.
  assert.doesNotMatch(job, /continue-on-error/);
  // It gets no token: it builds and runs PR code.
  assert.doesNotMatch(job, /GH_TOKEN|GITHUB_TOKEN|secrets\./);
  assert.match(job, /\n {4}timeout-minutes: \d+/);
});

test('ci.yml: packed-extract-check is never-gating: not in ci-gate needs, listed in its comment, skipped on merge_group', () => {
  const needs = CI.match(/ {2}ci-gate:\n {4}name: ci-gate\n {4}needs: \[([^\]]+)\]/);
  assert.ok(needs, 'ci-gate header not found');
  assert.ok(!needs[1].split(',').map((x) => x.trim()).includes('packed-extract-check'), 'promoting it to blocking is a separate T2 change (t/660)');
  assert.match(CI, /cannot hold a\n {4}# merge-queue batch back: [a-z0-9, \n#-]*\bpacked-extract-check\b[a-z0-9, \n#-]*\. /);
  const job = jobBlock('packed-extract-check');
  assert.match(job, /always\(\) && !cancelled\(\) &&\n\s+github\.event_name != 'merge_group' && \(github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch' \|\| needs\.changes\.outputs\.electron == 'true'\)/);
});

test("ci.yml: the electron filter includes the gate script, so a change to it runs the job", () => {
  const filter = CI.match(/\n {12}electron:\n((?: {14}.*\n)+)/);
  assert.ok(filter, 'electron filter not found');
  assert.match(filter[1], /- 'operations\/devops\/packed-extract-gate\.mjs'/);
});
