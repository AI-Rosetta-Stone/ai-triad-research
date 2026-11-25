// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/605: route a base-pin drift to an issue or a PR by whether a fixed CVE reaches the shipped image.
// Fixtures: drift with no CVE (issue), an npm-only CVE (issue), a runtime-image CVE (pr), every failure
// (pr, undecidable, named), plus the strip-list drift pin against taxonomy-editor/Dockerfile.
// Run: node --test operations/devops/docker/base-pin-cves.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  classify, classifyVuln, cveSection, fixedVulns, outputLines, parseRuntimeRemovals, scanBoth, scanFailure,
  STRIP_PACKAGES, STRIP_PATHS,
} from './base-pin-cves.mjs';

const DOCKERFILE = fileURLToPath(new URL('../../../taxonomy-editor/Dockerfile', import.meta.url));
const D1 = `sha256:${'1'.repeat(64)}`;
const D2 = `sha256:${'2'.repeat(64)}`;

const report = (...results) => ({ SchemaVersion: 2, ArtifactName: 'x', Results: results });
const os = (...v) => ({ Target: 'ai-triad-base (debian 13.2)', Class: 'os-pkgs', Type: 'debian', Vulnerabilities: v });
const lang = (...v) => ({ Target: 'Node.js', Class: 'lang-pkgs', Type: 'node-pkg', Vulnerabilities: v });
const vuln = (id, pkg, pkgPath) => ({ VulnerabilityID: id, PkgName: pkg, ...(pkgPath ? { PkgPath: pkgPath } : {}), Severity: 'HIGH' });
const NPM_TAR = vuln('CVE-2026-73566', 'tar', 'usr/local/lib/node_modules/npm/node_modules/tar/package.json');
const OPENSSL = vuln('CVE-2026-14456', 'openssl');

// ---- condition (1): the strip list is pinned to the Dockerfile's runtime stage ----
test('DRIFT PIN: STRIP_PATHS and STRIP_PACKAGES equal the runtime stage removals in taxonomy-editor/Dockerfile', () => {
  const parsed = parseRuntimeRemovals(fs.readFileSync(DOCKERFILE, 'utf8'));
  assert.ok(parsed, 'no `FROM ... AS runtime` stage found');
  assert.deepEqual(parsed.paths, [...STRIP_PATHS].sort(),
    'the runtime stage removes different paths than base-pin-cves.mjs STRIP_PATHS: update the list (and re-think the routing) with the Dockerfile change');
  assert.deepEqual(parsed.packages, [...STRIP_PACKAGES].sort(),
    'the runtime stage purges different packages than STRIP_PACKAGES: update the list with the Dockerfile change');
  assert.ok(parsed.paths.includes('/usr/local/lib/node_modules/npm'), 'the npm strip (t/3135) is the reason npm CVEs are build-only');
});

test('the parser sees a new strip, a removed one, a purge, and only the runtime stage', () => {
  const base = 'FROM node AS builder\nRUN rm -rf /build-only\nFROM ghcr.io/x/base:1@sha256:a AS runtime\n';
  assert.deepEqual(parseRuntimeRemovals(`${base}RUN rm -rf /usr/local/lib/node_modules/npm \\\n    /usr/local/bin/npx \\\n  && echo ok\n`),
    { paths: ['/usr/local/bin/npx', '/usr/local/lib/node_modules/npm'], packages: [] });
  assert.deepEqual(parseRuntimeRemovals(`${base}RUN apt-get purge -y --allow-remove-essential apt libapt-pkg7.0 && rm -rf /var/lib/apt\n# rm -rf /commented\n`),
    { paths: ['/var/lib/apt'], packages: ['apt', 'libapt-pkg7.0'] });
  assert.deepEqual(parseRuntimeRemovals(`${base}USER x\n`), { paths: [], packages: [] }, 'the builder stage rm does not count');
  assert.equal(parseRuntimeRemovals('FROM x AS builder\n'), null);
});

// ---- classification ----
test('classifyVuln: npm-bundled = build-only; OS package = runtime, unless purged; app node_modules = runtime', () => {
  assert.equal(classifyVuln({ id: 'a', pkg: 'tar', pkgPath: 'usr/local/lib/node_modules/npm/node_modules/tar/package.json', cls: 'lang-pkgs' }), 'build-only');
  assert.equal(classifyVuln({ id: 'a', pkg: 'openssl', cls: 'os-pkgs' }), 'runtime');
  assert.equal(classifyVuln({ id: 'a', pkg: 'apt', cls: 'os-pkgs' }), 'build-only');
  assert.equal(classifyVuln({ id: 'a', pkg: 'undici', pkgPath: 'app/node_modules/undici/package.json', cls: 'lang-pkgs' }), 'runtime');
  // Segment boundary: npm-foo is not under npm/.
  assert.equal(classifyVuln({ id: 'a', pkg: 'x', pkgPath: 'usr/local/lib/node_modules/npm-foo/package.json', cls: 'lang-pkgs' }), 'runtime');
  assert.match(classifyVuln({ id: 'a', pkg: 'x', cls: 'lang-pkgs' }).undecidable, /no PkgPath/);
  assert.match(classifyVuln({ id: 'a', pkg: 'x', cls: 'secret' }).undecidable, /unknown result class/);
});

test('fixedVulns: in the pinned scan and not the latest; still-present CVEs are not fixed', () => {
  const pinned = report(os(OPENSSL, vuln('CVE-1', 'zlib')), lang(NPM_TAR));
  const latest = report(os(vuln('CVE-1', 'zlib')));
  assert.deepEqual(fixedVulns(pinned, latest).map((v) => v.id).sort(), ['CVE-2026-14456', 'CVE-2026-73566']);
});

// ---- the four fixtures the ticket names ----
test('fixture: drift with no CVE fixed -> issue', () => {
  const r = report(os(vuln('CVE-1', 'zlib')));
  assert.deepEqual(classify({ reports: { pinned: r, latest: r } }), { route: 'issue', undecidable: [], runtime: [], buildOnly: [] });
  assert.equal(classify({ reports: { pinned: report(), latest: report() } }).route, 'issue', 'no Results at all');
});

test('fixture: an npm-only CVE (the #5504 case) -> issue', () => {
  const c = classify({ reports: { pinned: report(lang(NPM_TAR)), latest: report() } });
  assert.deepEqual(c, { route: 'issue', undecidable: [], runtime: [], buildOnly: ['CVE-2026-73566'] });
});

test('fixture: a runtime-image CVE (OS package) -> pr', () => {
  const c = classify({ reports: { pinned: report(os(OPENSSL), lang(NPM_TAR)), latest: report() } });
  assert.deepEqual(c, { route: 'pr', undecidable: [], runtime: ['CVE-2026-14456'], buildOnly: ['CVE-2026-73566'] });
});

test('a CVE both in npm and in the runtime counts as runtime only', () => {
  const both = vuln('CVE-9', 'tar', 'app/node_modules/tar/package.json');
  const c = classify({ reports: { pinned: report(lang(NPM_TAR, { ...both, VulnerabilityID: 'CVE-2026-73566' })), latest: report() } });
  assert.deepEqual([c.route, c.runtime, c.buildOnly], ['pr', ['CVE-2026-73566'], []]);
});

// ---- condition (2): every failure is undecidable -> pr, named ----
function fakeTrivy(plan) {
  const calls = [];
  const trivy = (args) => {
    calls.push(args.join(' '));
    if (args.includes('--download-db-only')) return plan.db ?? { status: 0, stdout: '', stderr: '' };
    const which = args.at(-1).endsWith(D1.slice(7)) ? 'pinned' : 'latest';
    return plan[which] ?? { status: 0, stdout: JSON.stringify(report()), stderr: '' };
  };
  trivy.calls = calls;
  return trivy;
}
const scanned = (plan) => classify(scanBoth({ pinnedDigest: D1, latestDigest: D2, trivy: fakeTrivy(plan) }));

for (const [name, plan, re] of [
  ['the Trivy DB download fails', { db: { status: 1, stderr: 'FATAL failed to download vulnerability DB: 429' } }, /^trivy-db-download: FATAL failed to download vulnerability DB: 429 \(after 3 attempts\)$/],
  ['the Trivy DB download times out', { db: { timedOut: true } }, /^trivy-db-download: timed out \(after 3 attempts\)$/],
  ['the pinned image pull fails', { pinned: { status: 1, stderr: 'unable to find the specified image: MANIFEST_UNKNOWN' } }, /^image-pull:pinned: /],
  ['the latest scan times out', { latest: { timedOut: true } }, /^scan-timeout:latest$/],
  ['the scan errors otherwise', { latest: { status: 2, stderr: 'panic: runtime error' } }, /^scan-failed:latest \(exit 2\): panic: runtime error$/],
  ['the JSON does not parse', { pinned: { status: 0, stdout: '{not json' } }, /^json-unparseable:pinned: /],
  ['the JSON is not a Trivy report', { latest: { status: 0, stdout: '{"foo":1}' } }, /^unreadable report: not a Trivy JSON report/],
  ['a finding has no PkgPath', { pinned: { status: 0, stdout: JSON.stringify(report(lang(vuln('CVE-7', 'x')))) } }, /^CVE-7 in x has no PkgPath/],
]) {
  test(`undecidable -> pr, and named: ${name}`, () => {
    const c = scanned(plan);
    assert.equal(c.route, 'pr');
    assert.ok(c.undecidable.some((u) => re.test(u)), c.undecidable.join(' | '));
  });
}

test('the DB download retries 3 times, 15 s apart, and a later success scans normally', () => {
  let n = 0;
  const pauses = [];
  const trivy = (args) => {
    if (args.includes('--download-db-only')) { n++; return n < 3 ? { status: 1, stderr: 'net' } : { status: 0 }; }
    return { status: 0, stdout: JSON.stringify(report()) };
  };
  const c = classify(scanBoth({ pinnedDigest: D1, latestDigest: D2, trivy, pause: (ms) => pauses.push(ms) }));
  assert.equal(n, 3);
  assert.deepEqual(pauses, [15000, 15000]);
  assert.equal(c.route, 'issue');
});

test('a bad digest is never scanned (it would be an injection into the image ref)', () => {
  const trivy = fakeTrivy({});
  const c = classify(scanBoth({ pinnedDigest: 'sha256:abc; rm -rf /', latestDigest: D2, trivy }));
  assert.equal(c.route, 'pr');
  assert.match(c.undecidable[0], /^bad-digest:pinned/);
  assert.equal(trivy.calls.filter((x) => x.includes('rm -rf')).length, 0);
});

test('the scan argv: same scope as the gate (HIGH/CRITICAL, fixable, vuln scanner), DB downloaded once, digests pinned', () => {
  const trivy = fakeTrivy({});
  scanBoth({ pinnedDigest: D1, latestDigest: D2, trivy });
  assert.equal(trivy.calls[0], 'image --download-db-only --quiet');
  assert.equal(trivy.calls.length, 3);
  for (const c of trivy.calls.slice(1)) {
    assert.match(c, /--skip-db-update --scanners vuln --format json --severity HIGH,CRITICAL --ignore-unfixed --timeout 5m ghcr\.io\/ai-rosetta-stone\/ai-triad-base@sha256:[12]{64}$/);
  }
});

test('scanFailure: pull wording vs other errors', () => {
  assert.match(scanFailure('latest', { status: 1, stderr: 'x\nError: pull access denied' }), /^image-pull:latest: Error: pull access denied/);
  assert.match(scanFailure('latest', { status: 1, stderr: 'boom' }), /^scan-failed:latest \(exit 1\): boom/);
});

// ---- outputs and the body section ----
test('outputLines: one line each, no CR/LF smuggled into $GITHUB_OUTPUT', () => {
  const lines = outputLines({ route: 'pr', undecidable: ['a\nroute=issue', 'b'], runtime: ['CVE-1'], buildOnly: [] });
  assert.deepEqual(lines, ['route=pr', 'undecidable=a route=issue; b', 'runtime_cves=CVE-1', 'buildonly_cves=']);
});

test('cveSection: the PR body names the runtime CVEs; undecidable names the failure; a failed cves job is undecidable', () => {
  const pr = cveSection({ kind: 'pr', route: 'pr', undecidable: '', runtime: 'CVE-2026-14456', buildOnly: 'CVE-2026-73566', jobResult: 'success' });
  assert.match(pr, /Reaches the shipped image: CVE-2026-14456/);
  assert.match(pr, /Build-only \(the runtime stage removes it\): CVE-2026-73566/);
  assert.match(pr, /budget-exempt:/);
  assert.match(cveSection({ kind: 'pr', route: 'pr', undecidable: 'scan-timeout:latest', runtime: '', buildOnly: '', jobResult: 'success' }),
    /\*\*Undecidable, so treated as reaching the shipped image:\*\* scan-timeout:latest\./);
  assert.match(cveSection({ kind: 'pr', jobResult: 'failure' }), /the cves job did not complete \(result: failure\)/);
  assert.match(cveSection({ kind: 'pr', jobResult: '' }), /result: none/);
  const issue = cveSection({ kind: 'issue', route: 'issue', undecidable: '', runtime: '', buildOnly: 'CVE-2026-73566', jobResult: 'success' });
  assert.match(issue, /Route: issue \(no CVE reaches the shipped image\)/);
});

// ---- the workflow's shape (t/605, Lead p/233#154): who holds the key, who routes where ----
const WORKFLOW = fileURLToPath(new URL('../../../.github/workflows/check-base-pin-drift.yml', import.meta.url));
/** The text of each top-level job (2-space keys under `jobs:`). */
function jobsOf(yml) {
  const lines = yml.split(/\r?\n/);
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  const jobs = {};
  let name = null;
  for (const l of lines.slice(start + 1)) {
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(l);
    if (m) { name = m[1]; jobs[name] = ''; continue; }
    if (name && (/^ {4}/.test(l) || l.trim() === '' || /^ {2}#/.test(l))) jobs[name] += `${l}\n`;
  }
  return jobs;
}

test('workflow: four jobs; only `repin` holds the author-app environment and the App key', () => {
  const jobs = jobsOf(fs.readFileSync(WORKFLOW, 'utf8'));
  assert.deepEqual(Object.keys(jobs), ['check', 'cves', 'issue', 'repin']);
  for (const [name, body] of Object.entries(jobs)) {
    const hasEnv = /^\s{4}environment:/m.test(body);
    const hasSecret = /\bsecrets\./.test(body.replace(/^\s*#.*$/gm, ''));
    assert.equal(hasEnv, name === 'repin', `${name}: environment`);
    assert.equal(hasSecret, name === 'repin', `${name}: secrets`);
  }
});

test('workflow: `cves` is read-only, uses the pinned setup-trivy at v0.74.0, and runs the classifier', () => {
  const cves = jobsOf(fs.readFileSync(WORKFLOW, 'utf8')).cves;
  assert.match(cves, /permissions:\n\s+contents: read\n\s+outputs:/, 'contents: read and nothing else');
  assert.match(cves, /aquasecurity\/setup-trivy@81e514348e19b6112ce2a7e3ecbafe19c1e1f567/);
  assert.match(cves, /version: v0\.74\.0/);
  assert.match(cves, /base-pin-cves\.mjs scan "\$PINNED_DIGEST" "\$LATEST_DIGEST"/);
});

test('workflow: issue only on a SUCCESSFUL cves job with route=issue; repin on anything else (always())', () => {
  const jobs = jobsOf(fs.readFileSync(WORKFLOW, 'utf8'));
  assert.match(jobs.issue, /if: needs\.check\.outputs\.verdict == 'FAIL' && needs\.cves\.result == 'success' && needs\.cves\.outputs\.route == 'issue'/);
  assert.match(jobs.repin, /always\(\) && needs\.check\.result == 'success' && needs\.check\.outputs\.verdict == 'FAIL' &&\s+!\(needs\.cves\.result == 'success' && needs\.cves\.outputs\.route == 'issue'\)/);
  assert.match(jobs.repin, /base-pin-cves\.mjs section pr >> "\$RUNNER_TEMP\/pr-body\.md"/, 'the PR body names the CVEs or the failure');
  // One issue: both writers use the same stable title, and check closes it on PASS.
  for (const j of ['issue', 'repin']) assert.match(jobs[j], /--title "Base image pin drift: taxonomy-editor runtime base is stale"/);
  assert.match(jobs.check, /Close drift issue when the pin is current/);
});
