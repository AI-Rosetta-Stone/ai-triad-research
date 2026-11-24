// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/486 (observability follow-up to t/484; written by Security, landed by DevOps): read-only
// snapshot of GitHub App installations for the org, diffed against the previous snapshot.
// Alert-only: never changes an installation, never mints a token, never reads the audit log.
// It runs from an agent session with the gh login already on the machine. No workflow runs it and
// it needs no new credential.
//
// WHERE SNAPSHOTS GO: <snapshotDir> is a folder you name, and it must be OUTSIDE this repository
// and OUTSIDE ai-triad-data. Snapshots list the org's App installations and their permissions,
// and this repository is public. The folder in use is C:\tmp\c\app-snapshots\snapshots (t/486#5).
// Never commit a snapshot file.
//
// Usage:
//   node installation-snapshot.mjs run  <snapshotDir> [--org AI-Rosetta-Stone] [--from-file <json>]
//   node installation-snapshot.mjs diff <previous.json> <current.json>
//   node installation-snapshot.mjs selftest
// Exit codes: 0 ok (no change, first snapshot, or today's snapshot already exists: nothing is
// written or compared), 2 change found (alert), 3 fail-closed (incomplete read or unreadable
// previous snapshot; no file written), 4 no change but the previous snapshot is more than 2 days
// old (a missed run).
// Tests: installation-snapshot.test.mjs (fixtures only, no gh call).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const FIELDS = ['id', 'app_slug', 'updated_at', 'created_at', 'repository_selection', 'permissions', 'suspended_at'];

// Project one API record onto the fields we keep. Anything else (tokens, secrets, unknown fields) is dropped.
export function project(rec) {
  const out = {};
  for (const k of FIELDS) out[k] = rec[k] ?? null;
  return out;
}

// Diff two snapshots. Returns a list of alert strings; empty when nothing changed.
export function diffSnapshots(prev, cur) {
  const alerts = [];
  const p = new Map(prev.installations.map((r) => [r.id, r]));
  const c = new Map(cur.installations.map((r) => [r.id, r]));
  for (const id of c.keys()) if (!p.has(id)) alerts.push(`new installation ${id} (${c.get(id).app_slug})`);
  for (const id of p.keys()) if (!c.has(id)) alerts.push(`removed installation ${id} (${p.get(id).app_slug})`);
  for (const [id, cr] of c) {
    const pr = p.get(id);
    if (!pr) continue;
    for (const k of FIELDS) {
      if (k === 'id' || k === 'app_slug') continue;
      const a = JSON.stringify(pr[k]);
      const b = JSON.stringify(cr[k]);
      if (a !== b) alerts.push(`${cr.app_slug} (${id}): ${k} changed ${a} -> ${b}`);
    }
  }
  return alerts;
}

// Read every page of the org installations list. Throws (fail closed) on any error or an incomplete read.
export function readInstallations(org, fromFile) {
  if (fromFile) return JSON.parse(fs.readFileSync(fromFile, 'utf8')).installations.map(project);
  let raw;
  try {
    raw = execFileSync('gh', ['api', `orgs/${org}/installations?per_page=100`, '--paginate', '--jq', '.installations[]'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  } catch (err) {
    throw new Error(`read failed: ${String(err.message).split('\n')[0]}`);
  }
  const recs = raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  if (recs.length === 0) throw new Error('read returned zero installations (treated as incomplete)');
  return recs.map(project).sort((a, b) => a.id - b.id);
}

function listSnapshots(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^snapshot-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
}

function dayOf(name) { return name.slice(9, 19); }

export function run(snapDir, org, fromFile) {
  fs.mkdirSync(snapDir, { recursive: true });
  const names = listSnapshots(snapDir);
  const today = new Date().toISOString().slice(0, 10);
  let installations;
  try {
    installations = readInstallations(org, fromFile);
  } catch (err) {
    console.error(`FAIL-CLOSED: ${err.message}. No snapshot written.`);
    return 3;
  }
  const snap = { taken_on: today, source: fromFile ? `fixture ${fromFile}` : `gh api orgs/${org}/installations`, count: installations.length, installations };
  let prev = null;
  if (names.length > 0) {
    try { prev = JSON.parse(fs.readFileSync(path.join(snapDir, names[names.length - 1]), 'utf8')); }
    catch (err) { console.error(`FAIL-CLOSED: previous snapshot unreadable: ${err.message}`); return 3; }
  }
  const lastDay = names.length ? dayOf(names[names.length - 1]) : null;
  const missed = lastDay && (Date.parse(today) - Date.parse(lastDay)) > 2 * 86_400_000;
  const file = path.join(snapDir, `snapshot-${today}.json`);
  if (fs.existsSync(file)) { console.error(`already have ${file}; nothing written`); return 0; }
  fs.writeFileSync(file, JSON.stringify(snap, null, 2) + '\n');
  if (!prev) { console.log(`first snapshot written: ${file} (${installations.length} installations)`); return 0; }
  const alerts = diffSnapshots(prev, snap);
  if (missed) console.log(`MISSED RUN: previous snapshot is from ${lastDay}; the gap is reported here.`);
  if (alerts.length) { for (const a of alerts) console.log(`ALERT: ${a}`); return 2; }
  console.log(`no change since ${lastDay}: ${file}`);
  return missed ? 4 : 0;
}

export function selftest() {
  const base = { installations: [
    { id: 1, app_slug: 'a', updated_at: 'x', created_at: 'c', repository_selection: 'selected', permissions: { contents: 'read' }, suspended_at: null },
    { id: 2, app_slug: 'b', updated_at: 'y', created_at: 'c', repository_selection: 'all', permissions: { contents: 'write' }, suspended_at: null },
  ] };
  const oneField = structuredClone(base); oneField.installations[0].updated_at = 'z';
  const same = structuredClone(base);
  const perm = structuredClone(base); perm.installations[1].permissions = { contents: 'read' };
  const checks = [
    ['identical pair raises no alert', diffSnapshots(base, same).length === 0],
    ['one-field change (updated_at) raises exactly one alert', diffSnapshots(base, oneField).length === 1],
    ['permission change raises one alert', diffSnapshots(base, perm).length === 1],
    ['projection drops token-like fields', !('token' in project({ id: 1, token: 'x', app_slug: 'a' }))],
  ];
  let ok = true;
  for (const [name, pass] of checks) { console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`); ok = ok && pass; }
  return ok ? 0 : 1;
}

const [, , cmd, ...rest] = process.argv;
if (cmd === 'selftest') process.exit(selftest());
if (cmd === 'diff') {
  const alerts = diffSnapshots(JSON.parse(fs.readFileSync(rest[0], 'utf8')), JSON.parse(fs.readFileSync(rest[1], 'utf8')));
  for (const a of alerts) console.log(`ALERT: ${a}`);
  process.exit(alerts.length ? 2 : 0);
}
if (cmd === 'run') {
  const org = rest.includes('--org') ? rest[rest.indexOf('--org') + 1] : 'AI-Rosetta-Stone';
  const ff = rest.includes('--from-file') ? rest[rest.indexOf('--from-file') + 1] : null;
  process.exit(run(rest[0], org, ff));
}
console.error('usage: installation-snapshot.mjs run|diff|selftest ...');
process.exit(3);
