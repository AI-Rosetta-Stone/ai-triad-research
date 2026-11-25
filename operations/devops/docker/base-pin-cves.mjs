// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/605 (TL p/9#585, Lead p/233#154): does a base-pin drift fix a CVE that REACHES the shipped image?
//
// check-base-pin-drift.yml used to open its own re-pin PR on every drift, spending a PR-budget unit on
// a train-sized change (#5504, whose CVEs were all npm's, which the runtime image strips). Now:
//   - route `issue` (one updating issue, no PR) when the drift fixes no CVE, or only CVEs in what the
//     runtime stage removes;
//   - route `pr` (its own security PR, CVE ids in the body) when a fixed CVE reaches the shipped image;
//   - route `pr` with an UNDECIDABLE note on ANY failure: the Trivy DB download, an image pull, a scan
//     timeout or error, unparseable JSON, or a finding the classifier can't place.
//
// SOURCE: Trivy, the same setup-trivy pin as base-image.yml, run on the PINNED base digest and the
// LATEST base digest (HIGH/CRITICAL, fixable only). The shipped image can't be scanned on the new base
// until it's built (Lead p/233#154). A CVE is FIXED when it is in the pinned scan and not the latest.
//
// BUILD-ONLY means the runtime stage of taxonomy-editor/Dockerfile removes it: a path it `rm`s (e.g.
// /usr/local/lib/node_modules/npm, t/3135) or an OS package it purges (apt, t/4874). STRIP_PATHS and
// STRIP_PACKAGES must equal what parseRuntimeRemovals reads from the Dockerfile; a test pins that, so a
// new or removed strip can't silently change routing.
//
//   node base-pin-cves.mjs scan <pinned-digest> <latest-digest>   -> $GITHUB_OUTPUT route=, undecidable=,
//                                                                   runtime_cves=, buildonly_cves=
//   node base-pin-cves.mjs section <issue|pr>                     -> Markdown on stdout, from env
//       ROUTE, UNDECIDABLE, RUNTIME_CVES, BUILDONLY_CVES, CVES_RESULT (the cves job's result)
//
// Pure core: parseRuntimeRemovals, vulnsOf, fixedVulns, classifyVuln, classify, cveSection.
// Impure shim: scanBoth (trivy injectable).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { IMAGE } from './repin-tier.mjs';

export const STRIP_PATHS = Object.freeze([
  '/etc/apt',
  '/tmp/ms-prod.deb',
  '/usr/local/bin/npm',
  '/usr/local/bin/npx',
  '/usr/local/lib/node_modules/npm',
  '/var/cache/apt',
  '/var/lib/apt',
]);
export const STRIP_PACKAGES = Object.freeze(['apt', 'libapt-pkg7.0']);

export const SCAN_TIMEOUT_MS = 6 * 60 * 1000; // trivy's own --timeout is 5m; this catches a hang
export const DB_TIMEOUT_MS = 5 * 60 * 1000;
export const DB_ATTEMPTS = 3;

/**
 * PURE. The removals in the runtime stage (from its `FROM ... AS runtime` to the next FROM or EOF):
 * every path an `rm` names and every package an `apt-get purge|remove` names. Sorted, deduped.
 */
export function parseRuntimeRemovals(dockerfileText) {
  const lines = String(dockerfileText).split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*FROM\s+\S+\s+AS\s+runtime\s*$/i.test(l));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^\s*FROM\s/i.test(lines[i])) { end = i; break; }
  // Comments out, continuations joined, so one RUN is one line.
  const stage = lines.slice(start + 1, end).filter((l) => !/^\s*#/.test(l)).join('\n').replace(/\\\n/g, ' ');
  const paths = new Set();
  const packages = new Set();
  for (const segment of stage.split(/&&|;|\n|\|\|/)) {
    const words = segment.trim().replace(/^RUN\s+/i, '').split(/\s+/).filter(Boolean);
    if (words[0] === 'rm') for (const w of words.slice(1)) { if (!w.startsWith('-')) paths.add(w); }
    const verb = words.findIndex((w, i) => i > 0 && /^(purge|remove)$/.test(w) && /^apt(-get)?$/.test(words[i - 1]));
    if (verb > 0) for (const w of words.slice(verb + 1)) { if (!w.startsWith('-')) packages.add(w); }
  }
  return { paths: [...paths].sort(), packages: [...packages].sort() };
}

/** PURE. Every vulnerability in a Trivy JSON report, flattened. Throws on a report it can't read. */
export function vulnsOf(report) {
  if (!report || typeof report !== 'object' || !('SchemaVersion' in report)) throw new Error('not a Trivy JSON report (no SchemaVersion)');
  const results = report.Results ?? [];
  if (!Array.isArray(results)) throw new Error('Results is not an array');
  return results.flatMap((r) => (r.Vulnerabilities ?? []).map((v) => ({
    id: v.VulnerabilityID, pkg: v.PkgName, pkgPath: v.PkgPath ?? null, cls: r.Class, target: r.Target,
  })));
}

const vulnKey = (v) => `${v.id}|${v.pkg}|${v.pkgPath ?? ''}`;

/** PURE. Vulns in the pinned report and not in the latest one: what the drift fixes. */
export function fixedVulns(pinnedReport, latestReport) {
  const latest = new Set(vulnsOf(latestReport).map(vulnKey));
  const seen = new Set();
  return vulnsOf(pinnedReport).filter((v) => { const k = vulnKey(v); if (latest.has(k) || seen.has(k)) return false; seen.add(k); return true; });
}

const underStrip = (pkgPath) => {
  const p = `/${String(pkgPath).replace(/^\/+/, '')}`;
  return STRIP_PATHS.some((s) => p === s || p.startsWith(`${s}/`));
};

/** PURE. 'runtime' | 'build-only' | { undecidable: why } for one fixed vuln. */
export function classifyVuln(v) {
  if (v.cls === 'os-pkgs') return STRIP_PACKAGES.includes(v.pkg) ? 'build-only' : 'runtime';
  if (v.cls === 'lang-pkgs') {
    if (!v.pkgPath) return { undecidable: `${v.id} in ${v.pkg} has no PkgPath, so where it lives is unknown` };
    return underStrip(v.pkgPath) ? 'build-only' : 'runtime';
  }
  return { undecidable: `${v.id} in ${v.pkg}: unknown result class ${JSON.stringify(v.cls)}` };
}

/**
 * PURE. The route. `failures`: [string] from the scans; `reports`: { pinned, latest } parsed JSON.
 * Returns { route: 'issue'|'pr', undecidable: [why], runtime: [ids], buildOnly: [ids] }.
 */
export function classify({ failures = [], reports = {} }) {
  const undecidable = [...failures];
  let fixed = [];
  if (!undecidable.length) {
    try { fixed = fixedVulns(reports.pinned, reports.latest); } catch (err) { undecidable.push(`unreadable report: ${err.message}`); }
  }
  const runtime = new Set();
  const buildOnly = new Set();
  for (const v of fixed) {
    const c = classifyVuln(v);
    if (c === 'runtime') runtime.add(v.id);
    else if (c === 'build-only') buildOnly.add(v.id);
    else undecidable.push(c.undecidable);
  }
  for (const id of runtime) buildOnly.delete(id); // a CVE in both places reaches the image
  return {
    route: undecidable.length || runtime.size ? 'pr' : 'issue',
    undecidable,
    runtime: [...runtime].sort(),
    buildOnly: [...buildOnly].sort(),
  };
}

/** PURE. A one-line reason for a failed trivy run. */
export function scanFailure(which, r) {
  if (r.timedOut) return `scan-timeout:${which}`;
  const line = String(r.stderr ?? '').trim().split('\n').filter(Boolean).pop() ?? '';
  if (/MANIFEST_UNKNOWN|unable to (find|inspect|pull)|pull access denied|denied|unauthorized|not found|no such image/i.test(r.stderr ?? '')) return `image-pull:${which}: ${line.slice(0, 200)}`;
  return `scan-failed:${which} (exit ${r.status}): ${line.slice(0, 200)}`;
}

/**
 * Impure (trivy injectable: (args, timeoutMs) -> { status, stdout, stderr, timedOut }). Downloads the DB
 * once, then scans the pinned and latest digests. Never throws: failures are returned.
 */
export function scanBoth({ pinnedDigest, latestDigest, trivy, pause = () => {}, dbAttempts = DB_ATTEMPTS }) {
  const failures = [];
  const reports = {};
  // The DB download is infra, not a finding: retry it like ci.yml's dockerfile-trivy (3 attempts, 15 s apart).
  let db;
  for (let attempt = 1; attempt <= dbAttempts; attempt++) {
    db = trivy(['image', '--download-db-only', '--quiet'], DB_TIMEOUT_MS);
    if (!db.timedOut && db.status === 0) break;
    if (attempt < dbAttempts) { console.log(`::warning::WARN: base-pin-cves: Trivy DB download failed (attempt ${attempt}/${dbAttempts}); retrying in 15 s.`); pause(15000); }
  }
  if (db.timedOut || db.status !== 0) {
    failures.push(`trivy-db-download: ${db.timedOut ? 'timed out' : String(db.stderr ?? '').trim().split('\n').pop()?.slice(0, 200)} (after ${dbAttempts} attempts)`);
    return { failures, reports };
  }
  for (const [which, digest] of [['pinned', pinnedDigest], ['latest', latestDigest]]) {
    if (!/^sha256:[0-9a-f]{64}$/.test(String(digest))) { failures.push(`bad-digest:${which}: ${JSON.stringify(digest)}`); continue; }
    const r = trivy(['image', '--quiet', '--skip-db-update', '--scanners', 'vuln', '--format', 'json', '--severity', 'HIGH,CRITICAL',
      '--ignore-unfixed', '--timeout', '5m', `${IMAGE}@${digest}`], SCAN_TIMEOUT_MS);
    if (r.timedOut || r.status !== 0) { failures.push(scanFailure(which, r)); continue; }
    try { reports[which] = JSON.parse(r.stdout); } catch (err) { failures.push(`json-unparseable:${which}: ${err.message.slice(0, 120)}`); }
  }
  return { failures, reports };
}

/** PURE. The $GITHUB_OUTPUT lines (one line each; ';' and ',' joined, CR/LF stripped). */
export function outputLines(c) {
  const one = (s) => String(s).replace(/[\r\n]+/g, ' ');
  return [`route=${c.route}`, `undecidable=${one(c.undecidable.join('; '))}`, `runtime_cves=${c.runtime.join(',')}`, `buildonly_cves=${c.buildOnly.join(',')}`];
}

/**
 * PURE. The Markdown for the issue or PR body, from the cves job's outputs and result. A cves job that
 * did not succeed is undecidable (no outputs to trust).
 */
export function cveSection({ kind, route, undecidable, runtime, buildOnly, jobResult }) {
  const list = (s) => String(s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const why = jobResult === 'success' ? String(undecidable ?? '').trim() : `the cves job did not complete (result: ${jobResult || 'none'})`;
  const rt = list(runtime);
  const bo = list(buildOnly);
  const out = ['', '## CVEs this drift fixes (t/605)', '',
    'Source: Trivy (HIGH/CRITICAL, fixable) on the pinned and the latest `ai-triad-base` digests; a CVE is fixed when it is in the pinned scan and not the latest.'];
  if (why) out.push('', `**Undecidable, so treated as reaching the shipped image:** ${why}.`);
  out.push('', `- Reaches the shipped image: ${rt.length ? rt.join(', ') : 'none'}`,
    `- Build-only (the runtime stage removes it): ${bo.length ? bo.join(', ') : 'none'}`);
  if (kind === 'pr') {
    out.push('', why || rt.length
      ? 'This drift opens its own PR as a security fix (t/605); it can take a Tech Lead or Security `budget-exempt:` review.'
      : 'Note: the CVE check routed this drift to an issue, so this PR comes from the fallback path.');
  } else {
    out.push('', `Route: ${route === 'issue' ? 'issue (no CVE reaches the shipped image): batch the re-pin into a train' : 'pr'}.`);
  }
  return `${out.join('\n')}\n`;
}

function appendOutput(text) {
  const target = process.env.GITHUB_OUTPUT;
  if (target) fs.appendFileSync(target, text); else process.stdout.write(text);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'scan') {
    const [pinnedDigest, latestDigest] = rest;
    const trivy = (args, timeoutMs) => {
      const r = spawnSync('trivy', args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024 });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr || (r.error ? String(r.error.message) : ''), timedOut: r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM' };
    };
    const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    const c = classify(scanBoth({ pinnedDigest, latestDigest, trivy, pause }));
    for (const u of c.undecidable) console.log(`::warning::WARN: base-pin-cves: undecidable, routing to a PR: ${u}`);
    console.log(`route=${c.route} runtime=${c.runtime.join(',') || 'none'} build-only=${c.buildOnly.join(',') || 'none'}`);
    appendOutput(`${outputLines(c).join('\n')}\n`);
  } else if (cmd === 'section') {
    const e = process.env;
    process.stdout.write(cveSection({ kind: rest[0], route: e.ROUTE, undecidable: e.UNDECIDABLE, runtime: e.RUNTIME_CVES, buildOnly: e.BUILDONLY_CVES, jobResult: e.CVES_RESULT }));
  } else {
    console.error('usage: base-pin-cves.mjs scan <pinned-digest> <latest-digest> | section <issue|pr>');
    process.exit(2);
  }
}
