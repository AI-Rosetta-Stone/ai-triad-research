// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/834: container.yml installs Trivy from the pinned release tarball with a pinned sha256, not through aquasecurity/setup-trivy
// (whose install.sh hits the github.com web route, which 504s intermittently and is not retried). This pins the shape and runs
// the step's REAL shell in bash with a fake tarball, so a wrong hash, a wrong version and the right shape are all exercised.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONTAINER = path.join(ROOT, '.github', 'workflows', 'container.yml');
const PINNED_SHA = '2ae6fe3ee734b7fdf11335663e18c75ea12dccc76062f09f164a3b0f8be4371a';
const PINNED_VERSION = '0.74.0';

/** PURE. The step blocks of a workflow: [{ name, text }] split on `      - name:` / `      - uses:` list items at 6-space indent. */
export function stepBlocks(yaml) {
  const lines = yaml.replace(/\r\n/g, '\n').split('\n');
  const starts = [];
  lines.forEach((l, i) => { if (/^ {6}- (name|uses|run):/.test(l)) starts.push(i); });
  return starts.map((s, k) => {
    const block = lines.slice(s, k + 1 < starts.length ? starts[k + 1] : lines.length).join('\n');
    const nm = /^ {6}- name:\s*(.+?)\s*$/m.exec(block);
    return { name: nm ? nm[1] : '', text: block };
  });
}

/** PURE. The shape rules: returns the list of violations (empty when container.yml is right). */
export function trivyInstallViolations(yaml) {
  const out = [];
  const steps = stepBlocks(yaml);
  if (steps.some((s) => /uses:\s*aquasecurity\/setup-trivy@/.test(s.text))) out.push('a step still uses aquasecurity/setup-trivy');
  const install = steps.find((s) => /^Install Trivy/.test(s.name));
  if (!install) { out.push('no "Install Trivy" step'); return out; }
  const t = install.text;
  const versionLines = t.split('\n').filter((l) => /^\s+TRIVY_VERSION:/.test(l));
  const shaLines = t.split('\n').filter((l) => /^\s+TRIVY_SHA256:/.test(l));
  if (versionLines.length !== 1 || !new RegExp(`TRIVY_VERSION:\\s*'${PINNED_VERSION.replace(/\./g, '\\.')}'`).test(versionLines[0])) out.push('TRIVY_VERSION is not pinned on exactly one line');
  if (shaLines.length !== 1 || !new RegExp(`TRIVY_SHA256:\\s*'${PINNED_SHA}'`).test(shaLines[0])) out.push('TRIVY_SHA256 is not the pinned hash on exactly one line');
  const run = t.slice(t.indexOf('run: |'));
  if (!/set -euo pipefail/.test(run)) out.push('no set -euo pipefail');
  if (/\|\|\s*true|continue-on-error/.test(t)) out.push('the step swallows a failure (|| true or continue-on-error)');
  const iCheck = run.indexOf('sha256sum -c');
  const iTar = run.indexOf('tar -xzf');
  if (iCheck < 0) out.push('no sha256sum -c');
  if (iTar < 0) out.push('no tar extraction');
  if (iCheck >= 0 && iTar >= 0 && iCheck > iTar) out.push('the hash is checked AFTER extracting');
  if (!/--fail\b/.test(run) || !/--retry 5/.test(run) || !/--retry-all-errors/.test(run)) out.push('curl is not --fail with --retry 5 --retry-all-errors');
  if (/\$\{\{/.test(t)) out.push('the step interpolates ${{ }} (use only step env)');
  const ignored = steps.filter((s) => /uses:\s*aquasecurity\/trivy-action@/.test(s.text));
  for (const s of ignored) if (!/skip-setup-trivy:\s*true/.test(s.text)) out.push(`a trivy-action step lacks skip-setup-trivy: true (${s.name})`);
  return out;
}

test('t/834: the real container.yml installs Trivy from the pinned tarball with a pinned hash', () => {
  assert.deepEqual(trivyInstallViolations(fs.readFileSync(CONTAINER, 'utf8')), []);
});

test('t/834: the old setup-trivy shape, and each broken variant, is a violation', () => {
  const good = fs.readFileSync(CONTAINER, 'utf8');
  const old = good.replace(/      - name: Install Trivy[\s\S]*?(?=\n      # C3 )/, "      - name: Install Trivy\n        uses: aquasecurity/setup-trivy@81e514348e19b6112ce2a7e3ecbafe19c1e1f567  # v0.3.1\n        with:\n          version: v0.74.0\n");
  assert.notEqual(old, good, 'the replacement applied');
  assert.match(trivyInstallViolations(old).join('|'), /setup-trivy/);
  const variants = {
    'wrong hash': good.replace(PINNED_SHA, '0'.repeat(64)),
    'two version lines': good.replace("          TRIVY_VERSION: '0.74.0'\n", "          TRIVY_VERSION: '0.74.0'\n          TRIVY_VERSION: '0.74.0'\n"),
    'swallowed': good.replace('sha256sum -c -', 'sha256sum -c - || true'),
    'no pipefail': good.replace('set -euo pipefail', 'set -eu'),
    'continue-on-error': good.replace('        shell: bash\n        env:\n          TRIVY_VERSION', '        shell: bash\n        continue-on-error: true\n        env:\n          TRIVY_VERSION'),
    'check after extract': good.replace(/( {10}echo "\$TRIVY_SHA256[^\n]*\n)( {10}mkdir[^\n]*\n)( {10}tar[^\n]*\n)/, '$2$3$1'),
    'no retry': good.replace('--retry 5 --retry-all-errors --retry-delay 5 ', ''),
    'trivy-action without skip': good.replace(/ {10}skip-setup-trivy: true\n/, ''),
  };
  for (const [label, text] of Object.entries(variants)) {
    assert.notEqual(text, good, `${label}: the variant applied`);
    assert.ok(trivyInstallViolations(text).length > 0, `${label}: expected a violation`);
  }
});

// ── the step's real shell, in bash, with a fake tarball and curl replaced by a local copy ──

const haveBash = (() => { try { execFileSync('bash', ['-c', 'command -v sha256sum tar gzip']); return true; } catch { return false; } })();
const posix = (p) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);

function stepScript() {
  const install = stepBlocks(fs.readFileSync(CONTAINER, 'utf8')).find((s) => /^Install Trivy/.test(s.name));
  const lines = install.text.split('\n');
  const i = lines.findIndex((l) => /^\s+run:\s*\|/.test(l));
  const indent = lines[i + 1].search(/\S/);
  const body = [];
  for (const l of lines.slice(i + 1)) {
    if (l.trim() !== '' && l.search(/\S/) < indent) break;   // the next step's comments or keys
    body.push(l.slice(indent));
  }
  return body.join('\n');
}

/** Runs the step's shell in a temp dir. `printedVersion` is what the fake `trivy --version` prints. Returns { status, path, stderr }. */
function runStep({ sha, printedVersion = `Version: ${PINNED_VERSION}`, tarballBytes }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't834-'));
  try {
    const src = path.join(dir, 'src'); fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, 'trivy'), `#!/bin/sh\necho '${printedVersion}'\n`, { mode: 0o755 });
    const tgz = path.join(dir, 'fake.tgz');
    execFileSync('tar', ['-czf', posix(tgz), '-C', posix(src), 'trivy']);
    const bytes = tarballBytes ?? fs.readFileSync(tgz);
    fs.writeFileSync(tgz, bytes);
    const runnerTemp = path.join(dir, 'rt'); fs.mkdirSync(runnerTemp);
    const ghPath = path.join(dir, 'github_path'); fs.writeFileSync(ghPath, '');
    const scriptFile = path.join(dir, 'step.sh'); fs.writeFileSync(scriptFile, stepScript());
    const realSha = execFileSync('sha256sum', [posix(tgz)], { encoding: 'utf8' }).split(/\s+/)[0];
    // curl is replaced by a function that copies the local tarball to the -o target (so the step's own curl line is what runs)
    const wrapper = 'curl() { while [ "$#" -gt 0 ]; do if [ "$1" = "-o" ]; then cp "$FAKE_TGZ" "$2"; return 0; fi; shift; done; return 22; }\n. "$STEP"\n';
    const r = spawnSync('bash', ['-c', wrapper], {
      encoding: 'utf8',
      env: { ...process.env, FAKE_TGZ: posix(tgz), STEP: posix(scriptFile), RUNNER_TEMP: posix(runnerTemp), GITHUB_PATH: posix(ghPath), TRIVY_VERSION: PINNED_VERSION, TRIVY_SHA256: sha === 'right' ? realSha : sha },
    });
    return { status: r.status, path: fs.readFileSync(ghPath, 'utf8'), stderr: r.stderr, stdout: r.stdout };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('t/834: the step\'s real shell with the RIGHT hash and version installs and adds the binary dir to GITHUB_PATH', { skip: !haveBash }, () => {
  const r = runStep({ sha: 'right' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.path, /trivy-bin/);
});

test('t/834: a WRONG hash fails the step, non-zero, and nothing is added to GITHUB_PATH', { skip: !haveBash }, () => {
  const r = runStep({ sha: '0'.repeat(64) });
  assert.notEqual(r.status, 0);
  assert.equal(r.path, '', 'GITHUB_PATH untouched');
  assert.match(r.stderr + r.stdout, /FAILED|did NOT match|checksum/i);
});

test('t/834: a version mismatch (the binary prints another version) fails the step and nothing is added to GITHUB_PATH', { skip: !haveBash }, () => {
  const r = runStep({ sha: 'right', printedVersion: 'Version: 0.73.0' });
  assert.notEqual(r.status, 0);
  assert.equal(r.path, '');
  assert.match(r.stderr + r.stdout, /not the pinned version/);
});

test('t/834: a download that returns nothing fails the step (curl --fail path)', { skip: !haveBash }, () => {
  const r = runStep({ sha: 'right', tarballBytes: Buffer.alloc(0) });
  assert.notEqual(r.status, 0);
  assert.equal(r.path, '');
});
