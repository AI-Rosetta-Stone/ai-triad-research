// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/486: tests for installation-snapshot.mjs. The script dispatches on its CLI arguments and exits,
// so it is driven as a child process, the way it is used. Nothing here calls gh or the network:
// `run` reads its installations from a fixture file (--from-file).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'installation-snapshot.mjs');
const today = () => new Date().toISOString().slice(0, 10);

function cli(...args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function installation(over = {}) {
  return {
    id: 1, app_slug: 'app-a', updated_at: '2026-10-20T10:29:19Z', created_at: '2026-10-20T10:00:00Z',
    repository_selection: 'selected', permissions: { contents: 'read', metadata: 'read' }, suspended_at: null, ...over,
  };
}

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 't486-'));
}

function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj));
  return file;
}

test('selftest passes: four PASS lines, exit 0', () => {
  const r = cli('selftest');
  assert.equal(r.code, 0, r.out);
  assert.equal((r.out.match(/^PASS /gm) ?? []).length, 4, r.out);
  assert.doesNotMatch(r.out, /^FAIL /m);
});

test('run: first snapshot is written and exits 0; a field that is not kept is dropped', () => {
  const dir = tmp();
  const fixture = writeJson(path.join(dir, 'fixture.json'), { installations: [installation({ access_tokens_url: 'x', token: 'secret' })] });
  const snapDir = path.join(dir, 'snaps');
  const r = cli('run', snapDir, '--from-file', fixture);
  assert.equal(r.code, 0, r.out);
  const written = JSON.parse(fs.readFileSync(path.join(snapDir, `snapshot-${today()}.json`), 'utf8'));
  assert.equal(written.count, 1);
  assert.deepEqual(Object.keys(written.installations[0]).sort(),
    ['app_slug', 'created_at', 'id', 'permissions', 'repository_selection', 'suspended_at', 'updated_at']);
});

test('run: a changed updated_at against an earlier snapshot exits 2 with one ALERT naming the field', () => {
  const dir = tmp();
  const snapDir = path.join(dir, 'snaps');
  fs.mkdirSync(snapDir);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  writeJson(path.join(snapDir, `snapshot-${yesterday}.json`), { taken_on: yesterday, installations: [installation()] });
  const fixture = writeJson(path.join(dir, 'fixture.json'), { installations: [installation({ updated_at: '2026-11-24T13:24:31Z' })] });
  const r = cli('run', snapDir, '--from-file', fixture);
  assert.equal(r.code, 2, r.out);
  const alerts = r.out.match(/^ALERT: .*$/gm) ?? [];
  assert.equal(alerts.length, 1, r.out);
  assert.match(alerts[0], /app-a \(1\): updated_at changed/);
});

test('run: no change against an earlier snapshot exits 0', () => {
  const dir = tmp();
  const snapDir = path.join(dir, 'snaps');
  fs.mkdirSync(snapDir);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  writeJson(path.join(snapDir, `snapshot-${yesterday}.json`), { taken_on: yesterday, installations: [installation()] });
  const fixture = writeJson(path.join(dir, 'fixture.json'), { installations: [installation()] });
  const r = cli('run', snapDir, '--from-file', fixture);
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /ALERT/);
});

const snapshotFiles = (snapDir) => fs.readdirSync(snapDir).filter((f) => f.startsWith('snapshot-')).sort();

test('run, same day: a second run with no change writes nothing and exits 0', () => {
  const dir = tmp();
  const snapDir = path.join(dir, 'snaps');
  const fixture = writeJson(path.join(dir, 'fixture.json'), { installations: [installation()] });
  assert.equal(cli('run', snapDir, '--from-file', fixture).code, 0);
  const r = cli('run', snapDir, '--from-file', fixture);
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /ALERT/);
  assert.deepEqual(snapshotFiles(snapDir), [`snapshot-${today()}.json`]);
});

test('run, same day: a change after the first run exits 2, writes a timestamped file, keeps the first (t/486#7)', () => {
  const dir = tmp();
  const snapDir = path.join(dir, 'snaps');
  const before = writeJson(path.join(dir, 'before.json'), { installations: [installation()] });
  const after = writeJson(path.join(dir, 'after.json'), { installations: [installation({ updated_at: '2026-11-24T13:24:31Z' })] });
  assert.equal(cli('run', snapDir, '--from-file', before).code, 0);
  const firstBytes = fs.readFileSync(path.join(snapDir, `snapshot-${today()}.json`), 'utf8');

  const r = cli('run', snapDir, '--from-file', after);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /ALERT: app-a \(1\): updated_at changed/);
  const files = snapshotFiles(snapDir);
  assert.equal(files.length, 2, files.join(', '));
  assert.equal(files[0], `snapshot-${today()}.json`, 'the day file sorts first');
  assert.match(files[1], new RegExp(`^snapshot-${today()}T\\d{4}Z\\.json$`));
  assert.equal(fs.readFileSync(path.join(snapDir, files[0]), 'utf8'), firstBytes, 'the first file is not overwritten');
  assert.equal(JSON.parse(fs.readFileSync(path.join(snapDir, files[1]), 'utf8')).installations[0].updated_at, '2026-11-24T13:24:31Z');

  // The next run is compared with the LATEST file (the timestamped one), so the same state is quiet...
  const quiet = cli('run', snapDir, '--from-file', after);
  assert.equal(quiet.code, 0, quiet.out);
  assert.equal(snapshotFiles(snapDir).length, 2);
  // ...and going back to the first state is a change again, not a match with the day file.
  const back = cli('run', snapDir, '--from-file', before);
  assert.match(back.out, /ALERT: app-a \(1\): updated_at changed/);
  const n = snapshotFiles(snapDir).length;
  // Same minute as the timestamped file: fails closed without overwriting. Next minute: a third file.
  assert.ok((back.code === 3 && n === 2) || (back.code === 2 && n === 3), `code ${back.code}, files ${n}: ${back.out}`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(snapDir, files[1]), 'utf8')).installations[0].updated_at, '2026-11-24T13:24:31Z', 'the timestamped file is not overwritten');
});

test('run: an unreadable previous snapshot fails closed (exit 3) and writes nothing', () => {
  const dir = tmp();
  const snapDir = path.join(dir, 'snaps');
  fs.mkdirSync(snapDir);
  fs.writeFileSync(path.join(snapDir, 'snapshot-2026-01-01.json'), '{ not json');
  const fixture = writeJson(path.join(dir, 'fixture.json'), { installations: [installation()] });
  const r = cli('run', snapDir, '--from-file', fixture);
  assert.equal(r.code, 3, r.out);
  assert.match(r.out, /FAIL-CLOSED/);
  assert.equal(fs.existsSync(path.join(snapDir, `snapshot-${today()}.json`)), false);
});

test('run: an unreadable source fails closed (exit 3) and writes nothing', () => {
  const dir = tmp();
  const snapDir = path.join(dir, 'snaps');
  const r = cli('run', snapDir, '--from-file', path.join(dir, 'missing.json'));
  assert.equal(r.code, 3, r.out);
  assert.equal(fs.existsSync(path.join(snapDir, `snapshot-${today()}.json`)), false);
});

test('diff: a removed and an added installation are both reported, exit 2', () => {
  const dir = tmp();
  const a = writeJson(path.join(dir, 'a.json'), { installations: [installation({ id: 1 })] });
  const b = writeJson(path.join(dir, 'b.json'), { installations: [installation({ id: 2, app_slug: 'app-b' })] });
  const r = cli('diff', a, b);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /ALERT: new installation 2 \(app-b\)/);
  assert.match(r.out, /ALERT: removed installation 1 \(app-a\)/);
});

test('no command prints usage and exits 3', () => {
  const r = cli();
  assert.equal(r.code, 3);
  assert.match(r.out, /usage:/);
});
