// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/** The end-of-run summary that makes dataRootGuard hits visible on a green vitest run (t/59). */

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_ROOT_GUARD_HITS_FILE_ENV, type DataRootGuardRecord } from './dataRootGuard.js';
import setup, { summarizeGuardHits, MAX_LISTED_TARGETS } from './dataRootGuardGlobalSetup.js';

const installed: DataRootGuardRecord = { kind: 'installed', pid: 1, mode: 'warn', roots: ['/data'] };
const hit = (target: string, test: string | null = '/repo/lib/debate/a.test.ts', op = 'fs.appendFileSync'): DataRootGuardRecord =>
  ({ kind: 'hit', pid: 1, op, target, protectedRoot: '/data', test });
const jsonl = (...recs: DataRootGuardRecord[]) => recs.map(r => JSON.stringify(r)).join('\n') + '\n';

describe('summarizeGuardHits', () => {
  it('a clean run with the guard installed reports 0 hits and re-emits the installed marker', () => {
    const s = summarizeGuardHits(jsonl(installed), 'h.jsonl');
    expect(s).toMatchObject({ installed: true, hits: 0 });
    expect(s.lines[0]).toBe('DATA-ROOT-GUARD-SUMMARY hits=0 unique=0 testFiles=0 livefire=0 hitsFile=h.jsonl');
    expect(s.lines.at(-1)).toBe('DATA-ROOT-GUARD-INSTALLED mode=warn roots=["/data"]');
  });

  it('no installed marker is "guard not installed", never a clean 0', () => {
    const s = summarizeGuardHits('', 'h.jsonl');
    expect(s.installed).toBe(false);
    expect(s.lines).toHaveLength(1);
    expect(s.lines[0]).toMatch(/guard not installed.*NOT a clean result/);
  });

  it('collapses repeated writes to one line per (op, target) with a count and the test files, busiest first', () => {
    const log = '/data/calibration/calibration-log.jsonl';
    const recs = [installed, ...Array.from({ length: 3 }, () => hit(log)), hit(log, '/repo/lib/debate/b.test.ts'), hit('/data/other.json')];
    const s = summarizeGuardHits(jsonl(...recs), 'h.jsonl');
    expect(s.hits).toBe(5);
    expect(s.lines[0]).toMatch(/^DATA-ROOT-GUARD-SUMMARY hits=5 unique=2 testFiles=2 livefire=0 /);
    expect(s.lines[1]).toMatch(new RegExp(`^DATA-ROOT-TEST-WRITE count=4 op=fs\\.appendFileSync target=${log} protectedRoot=/data tests=`));
    expect(s.lines[2]).toMatch(/^DATA-ROOT-TEST-WRITE count=1 op=fs\.appendFileSync target=\/data\/other\.json /);
  });

  it('live-fire control hits are counted separately, not listed as offenders', () => {
    const s = summarizeGuardHits(jsonl(installed, hit('/data/__guard_livefire__/missing/x.json')), 'h.jsonl');
    expect(s).toMatchObject({ hits: 0, livefire: 1 });
    expect(s.lines.filter(l => l.startsWith('DATA-ROOT-TEST-WRITE'))).toEqual([]);
  });

  it(`lists at most ${MAX_LISTED_TARGETS} targets and points at the file for the rest`, () => {
    const recs = [installed, ...Array.from({ length: MAX_LISTED_TARGETS + 3 }, (_, i) => hit(`/data/f${i}.json`))];
    const s = summarizeGuardHits(jsonl(...recs), 'h.jsonl');
    expect(s.lines.filter(l => l.startsWith('DATA-ROOT-TEST-WRITE'))).toHaveLength(MAX_LISTED_TARGETS);
    expect(s.lines).toContain('DATA-ROOT-GUARD-SUMMARY … and 3 more target(s) in h.jsonl');
  });

  it('an unparseable line is reported, not fatal', () => {
    const s = summarizeGuardHits(jsonl(installed, hit('/data/x.json')) + '{truncated\n', 'h.jsonl');
    expect(s.hits).toBe(1);
    expect(s.lines).toContain('DATA-ROOT-GUARD-SUMMARY WARN: 1 unparseable line(s) in h.jsonl');
  });
});

describe('globalSetup', () => {
  const saved = process.env[DATA_ROOT_GUARD_HITS_FILE_ENV];
  afterEach(() => {
    if (saved === undefined) delete process.env[DATA_ROOT_GUARD_HITS_FILE_ENV];
    else process.env[DATA_ROOT_GUARD_HITS_FILE_ENV] = saved;
    vi.restoreAllMocks();
  });

  it('truncates a preset hits file, exports it, and prints the summary at teardown, keeping the file', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 't59-')), 'hits.jsonl');
    fs.writeFileSync(file, jsonl(hit('/data/stale.json'))); // a previous run's hits
    process.env[DATA_ROOT_GUARD_HITS_FILE_ENV] = file;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const teardown = setup();
    expect(fs.readFileSync(file, 'utf-8')).toBe('');
    fs.appendFileSync(file, jsonl(installed, hit('/data/new.json')));
    teardown();
    const printed = String(log.mock.calls[0][0]);
    expect(printed).toContain('DATA-ROOT-GUARD-SUMMARY hits=1 unique=1');
    expect(printed).toContain('target=/data/new.json');
    expect(printed).not.toContain('stale');
    expect(fs.existsSync(file)).toBe(true);
  });

  it('without a preset, uses a file in a private temp dir and deletes the dir after a clean run', () => {
    delete process.env[DATA_ROOT_GUARD_HITS_FILE_ENV];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const teardown = setup();
    const file = process.env[DATA_ROOT_GUARD_HITS_FILE_ENV]!;
    expect(path.basename(path.dirname(file))).toMatch(/^data-root-guard-.{6}$/); // a private mkdtemp dir
    expect(path.dirname(path.dirname(file))).toBe(path.resolve(os.tmpdir()));
    fs.appendFileSync(file, jsonl(installed));
    teardown();
    expect(fs.existsSync(path.dirname(file))).toBe(false);
  });
});
