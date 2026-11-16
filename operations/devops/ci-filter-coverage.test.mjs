// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/391 (SO p/59#60): drift test for the merge-group scope. A devops-only batch sets full=false
// (SHARED_RE does not match operations/devops/**), so every job that runs an operations/devops
// script must be gated by a changes filter that covers that script. Otherwise the job is silently
// skipped on a devops-only change. This test reads ci.yml and checks that for every job:
//   - each operations/devops file the job runs (wildcards expanded against the real tree) is
//     matched by a `changes` filter that the job's `if:` uses; or
//   - the job has no gate (no `if:`, or `always()`), so it runs on every event.
// `full` is not a filter key: it is handled by ci-merge-group-scope.sh, and a full run covers all.
//
// Run: node --test operations/devops/ci-filter-coverage.test.mjs
// Table: node operations/devops/ci-filter-coverage.test.mjs --table

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const ciYml = readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8').replace(/\r\n/g, '\n');
const DEVOPS_DIR = path.join(root, 'operations', 'devops');

/** Glob → RegExp for the filter syntax used in ci.yml: `**` any depth, `*` within a segment. */
function globToRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') { re += '/?'; i++; } }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** The `changes` job's filters: key → globs. Parsed from the `filters: |` block. */
export function parseFilters(yml) {
  const lines = yml.split('\n');
  const start = lines.findIndex((l) => /^\s+filters: \|\s*$/.test(l));
  if (start < 0) throw new Error('ci.yml: no `filters: |` block found');
  const indent = lines[start].search(/\S/) + 2;
  const filters = {};
  let key = null;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') continue;
    const ind = l.search(/\S/);
    if (ind < indent) break; // the block ends at the first less-indented line
    if (l.trim().startsWith('#')) continue;
    const k = /^\s+([\w-]+):\s*$/.exec(l);
    if (k && ind === indent) { key = k[1]; filters[key] = []; continue; }
    const g = /^\s+- '([^']+)'/.exec(l);
    if (g && key) filters[key].push(g[1]);
  }
  return filters;
}

/** Top-level jobs under `jobs:`: name → { body, ifText }. */
export function parseJobs(yml) {
  const lines = yml.split('\n');
  const jobsAt = lines.findIndex((l) => l === 'jobs:');
  const jobs = {};
  let name = null;
  let body = [];
  const flush = () => {
    if (!name) return;
    const text = body.join('\n');
    const ifm = /^ {4}if: (.*)$/m.exec(text);
    let ifText = '';
    if (ifm) {
      // A folded (`>-`) or plain `if:` runs until the next line indented at 4 or less.
      const parts = [];
      const bl = body;
      const idx = bl.findIndex((l) => /^ {4}if: /.test(l));
      parts.push(bl[idx].replace(/^ {4}if: /, ''));
      for (let j = idx + 1; j < bl.length && (bl[j].trim() === '' || /^ {6,}/.test(bl[j])); j++) parts.push(bl[j].trim());
      ifText = parts.join(' ').replace(/^>-\s*/, '');
    }
    jobs[name] = { body: text, ifText };
  };
  for (let i = jobsAt + 1; i < lines.length; i++) {
    const l = lines[i];
    const jm = /^ {2}([A-Za-z][\w-]*):\s*$/.exec(l);
    if (jm) { flush(); name = jm[1]; body = []; continue; }
    if (/^[A-Za-z]/.test(l)) { flush(); name = null; break; }
    if (name) body.push(l);
  }
  flush();
  return jobs;
}

/** The `changes` keys a job's `if:` reads (`needs.changes.outputs.<key>`), excluding `full`. */
export function gateKeys(ifText) {
  return [...ifText.matchAll(/needs\.changes\.outputs\.([\w-]+)/g)].map((m) => m[1]).filter((k) => k !== 'full');
}

/** The operations/devops files a job runs, wildcards expanded against the real tree. */
export function devopsFilesFor(jobBody) {
  const files = new Set();
  const realFiles = readdirSync(DEVOPS_DIR);
  for (const raw of jobBody.split('\n')) {
    // Skip comments, the `- 'glob'` items of a filters list (globs, not script calls), and a line
    // that reads a file from the BASE tip with `git show` (dockerfile-trivy loads gate-verdict.mjs
    // that way): that file is never executed from the PR head, so a change to it does not run it.
    if (/^\s*#/.test(raw) || /^\s*\/\//.test(raw) || /^\s*- '/.test(raw) || /git show /.test(raw)) continue;
    for (const m of raw.matchAll(/operations\/devops\/([\w.*\/-]+)/g)) {
      const rel = m[1].replace(/[),;"'`]+$/, '');
      if (rel.includes('*')) {
        const re = globToRe(rel);
        for (const f of realFiles) if (re.test(f)) files.add(f);
      } else {
        files.add(rel);
      }
    }
  }
  return [...files].sort();
}

/** One row per (job, devops file): the job, its gate keys, the file, and whether a key covers it. */
export function coverage(yml = ciYml) {
  const filters = parseFilters(yml);
  const jobs = parseJobs(yml);
  const rows = [];
  for (const [name, job] of Object.entries(jobs)) {
    if (name === 'changes') continue; // the filter source: its own globs are not script calls
    const files = devopsFilesFor(job.body);
    if (files.length === 0) continue;
    const keys = gateKeys(job.ifText);
    // No file-filter key in `if:` (none, or event-only): the job runs on every devops-only change.
    const ungated = keys.length === 0;
    for (const f of files) {
      const rel = f.startsWith('operations/devops/') ? f : `operations/devops/${f}`;
      const short = rel.replace(/^operations\/devops\//, '');
      let by = null;
      if (ungated) by = 'ungated';
      else {
        for (const k of keys) {
          const globs = filters[k] ?? [];
          if (globs.some((g) => globToRe(g).test(rel))) { by = k; break; }
        }
      }
      rows.push({ job: name, gate: ungated ? '(none)' : keys.join(',') || '(none)', file: short, covered: by !== null, by });
    }
  }
  return rows;
}

test('every operations/devops file a CI job runs is covered by a filter that job is gated on', () => {
  const rows = coverage();
  assert.ok(rows.length > 0, 'the parser found no devops script calls: the parser is broken, not the coverage');
  const uncovered = rows.filter((r) => !r.covered);
  assert.deepEqual(
    uncovered.map((r) => `${r.job} runs ${r.file} but its gate (${r.gate}) does not cover it`),
    [],
    'a devops-only change would skip the job that runs these',
  );
});

test('check-vitest-shard-blobs.sh is covered by the test-electron-coverage gate (t/391 SO p/59#58)', () => {
  const row = coverage().find((r) => r.job === 'test-electron-coverage' && r.file === 'check-vitest-shard-blobs.sh');
  assert.ok(row, 'test-electron-coverage must call check-vitest-shard-blobs.sh (the parser sees it)');
  assert.equal(row.covered, true);
});

test('parser sanity: the powershell filter covers operations/devops/**, and the complexity-budget job is gated on it', () => {
  const filters = parseFilters(ciYml);
  assert.ok(filters.powershell.some((g) => globToRe(g).test('operations/devops/ci-merge-group-scope.sh')));
  const cb = parseJobs(ciYml)['complexity-budget'];
  assert.ok(gateKeys(cb.ifText).includes('powershell'));
});

// `node ci-filter-coverage.test.mjs --table` prints the markdown table for the PR body.
if (process.argv.includes('--table')) {
  const rows = coverage();
  console.log('| job | gate | devops file | covered by |');
  console.log('|---|---|---|---|');
  for (const r of rows) console.log(`| ${r.job} | ${r.gate} | ${r.file} | ${r.covered ? r.by : 'NOT COVERED'} |`);
}
