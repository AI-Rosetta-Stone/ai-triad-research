// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * vitest `globalSetup` companion to dataRootGuard.ts (t/59): makes warn-mode hits visible on a GREEN run.
 *
 * vitest 5 drops console output from passing tests, so the guard's per-hit WARN only shows when the offending
 * test also fails; t/57's ~43k calibration-log writes went unseen for that reason. This module runs in the
 * vitest main process: setup points DATA_ROOT_GUARD_HITS_FILE at a fresh file (workers inherit the env and
 * append each hit to it), and teardown reads it back and prints the summary to stdout, pass or fail:
 *
 *   DATA-ROOT-GUARD-SUMMARY hits=<n> unique=<n> testFiles=<n> livefire=<n> hitsFile=<path>
 *   DATA-ROOT-TEST-WRITE count=<n> op=<op> target=<path> protectedRoot=<path> tests=<a.test.ts,…>
 *   DATA-ROOT-GUARD-INSTALLED mode=<mode> roots=[…]
 *
 * CI's tee'd-log grep reads these lines into the step summary. Hits under `__guard_livefire__` are the wiring
 * tests' positive control: counted as `livefire`, not listed as offenders. A preset DATA_ROOT_GUARD_HITS_FILE
 * (CI, to keep the file as an artifact) is used and kept; otherwise the temp file is deleted when it is clean.
 *
 * NODE-ONLY. Wire it as `test.globalSetup` in a vitest config whose setupFiles install the guard.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DATA_ROOT_GUARD_HITS_FILE_ENV, DATA_ROOT_GUARD_INSTALLED_TOKEN, DATA_ROOT_LIVEFIRE_DIR, DATA_ROOT_TEST_WRITE_TOKEN,
  type DataRootGuardRecord,
} from './dataRootGuard.js';

export const DATA_ROOT_GUARD_SUMMARY_TOKEN = 'DATA-ROOT-GUARD-SUMMARY';
/** Offender lines printed at most; the hits file holds the rest. */
export const MAX_LISTED_TARGETS = 50;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface DataRootGuardSummary {
  installed: boolean;
  hits: number;
  livefire: number;
  /** One line per summary row, ready to print. */
  lines: string[];
}

/** Repo-relative, forward-slashed, for short stable test names in the summary. */
function relTest(file: string | null): string {
  if (!file) return '(outside vitest)';
  const rel = path.relative(REPO_ROOT, file);
  return (rel.startsWith('..') || path.isAbsolute(rel) ? file : rel).split(path.sep).join('/');
}

function isLivefire(target: string): boolean {
  return target.split(/[\\/]/).includes(DATA_ROOT_LIVEFIRE_DIR);
}

/** Summarize a hits file's text. Pure: exported for the unit test. Unparseable lines are counted and reported. */
export function summarizeGuardHits(text: string, hitsFile: string): DataRootGuardSummary {
  let installed: Extract<DataRootGuardRecord, { kind: 'installed' }> | null = null;
  let hits = 0;
  let livefire = 0;
  let malformed = 0;
  const byTarget = new Map<string, { op: string; target: string; protectedRoot: string; count: number; tests: Set<string> }>();
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    let rec: DataRootGuardRecord;
    try {
      rec = JSON.parse(raw) as DataRootGuardRecord;
    } catch {
      malformed++;
      continue;
    }
    if (rec.kind === 'installed') {
      installed ??= rec;
    } else if (rec.kind === 'hit') {
      if (isLivefire(rec.target)) { livefire++; continue; }
      hits++;
      const key = `${rec.op}\u0000${rec.target}`;
      const row = byTarget.get(key) ?? { op: rec.op, target: rec.target, protectedRoot: rec.protectedRoot, count: 0, tests: new Set<string>() };
      row.count++;
      row.tests.add(relTest(rec.test));
      byTarget.set(key, row);
    }
  }

  const testFiles = new Set([...byTarget.values()].flatMap(r => [...r.tests]));
  const lines: string[] = [];
  if (!installed) {
    lines.push(`${DATA_ROOT_GUARD_SUMMARY_TOKEN} guard not installed: no worker recorded ${DATA_ROOT_GUARD_INSTALLED_TOKEN} in ${hitsFile}; 0 hits is NOT a clean result`);
  } else {
    lines.push(`${DATA_ROOT_GUARD_SUMMARY_TOKEN} hits=${hits} unique=${byTarget.size} testFiles=${testFiles.size} livefire=${livefire} hitsFile=${hitsFile}`);
  }
  if (malformed > 0) lines.push(`${DATA_ROOT_GUARD_SUMMARY_TOKEN} WARN: ${malformed} unparseable line(s) in ${hitsFile}`);
  const rows = [...byTarget.values()].sort((a, b) => b.count - a.count || a.target.localeCompare(b.target));
  for (const r of rows.slice(0, MAX_LISTED_TARGETS)) {
    lines.push(`${DATA_ROOT_TEST_WRITE_TOKEN} count=${r.count} op=${r.op} target=${r.target} protectedRoot=${r.protectedRoot} tests=${[...r.tests].sort().join(',')}`);
  }
  if (rows.length > MAX_LISTED_TARGETS) {
    lines.push(`${DATA_ROOT_GUARD_SUMMARY_TOKEN} … and ${rows.length - MAX_LISTED_TARGETS} more target(s) in ${hitsFile}`);
  }
  // Re-emitted from the main process: the workers' own marker is console output, hidden when their tests pass.
  if (installed) lines.push(`${DATA_ROOT_GUARD_INSTALLED_TOKEN} mode=${installed.mode} roots=${JSON.stringify(installed.roots)}`);
  return { installed: installed !== null, hits, livefire, lines };
}

/** vitest globalSetup: returns the teardown. */
export default function setup(): () => void {
  const preset = process.env[DATA_ROOT_GUARD_HITS_FILE_ENV];
  // No preset: a private mkdtemp directory (0700, unpredictable name), never a guessable name in the shared
  // temp dir (CodeQL js/insecure-temporary-file).
  const tempDir = preset ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'data-root-guard-'));
  const hitsFile = preset || path.join(tempDir!, 'hits.jsonl');
  if (preset) fs.mkdirSync(path.dirname(hitsFile), { recursive: true });
  fs.writeFileSync(hitsFile, ''); // a fresh file per run: a preset path may hold a previous run's hits
  process.env[DATA_ROOT_GUARD_HITS_FILE_ENV] = hitsFile;

  return () => {
    let text = '';
    try {
      text = fs.readFileSync(hitsFile, 'utf-8');
    } catch (err) {
      console.warn(`${DATA_ROOT_GUARD_SUMMARY_TOKEN} WARN: could not read ${hitsFile} (${String(err)}); reporting it as guard not installed`);
    }
    const summary = summarizeGuardHits(text, hitsFile);
    console.log(['', ...summary.lines].join('\n'));
    if (tempDir && summary.installed && summary.hits === 0) fs.rmSync(tempDir, { recursive: true, force: true });
  };
}
