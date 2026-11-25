// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * t/576: concurrent checkForDataUpdates calls must share one `git fetch`.
 * Two overlapping fetches in the data repo raced for the same ref lock
 * (t/417#1). `electron` (net.fetch), `child_process` (git) and `fileIO`
 * (data root) are mocked; the data root is a temp dir with a `.git` folder.
 */

let tmpDir = '';
const gitCalls: string[][] = [];
let releaseFetch: (() => void) | null = null;

vi.mock('electron', () => ({
  net: { fetch: async () => ({ ok: true, status: 200 }) },
}));

vi.mock('../fileIO.js', () => ({
  resolveDataPath: () => tmpDir,
}));

vi.mock('child_process', () => ({
  execFile: (
    _cmd: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    gitCalls.push(args);
    if (args[0] === 'fetch') {
      // Hold the fetch open until the test releases it, so calls overlap.
      releaseFetch = () => cb(null, '', '');
      return;
    }
    cb(null, 'abc123\n', '');
  },
}));

import { checkForDataUpdates } from '../dataUpdateChecker.js';

const fetchCount = () => gitCalls.filter((a) => a[0] === 'fetch').length;

async function waitForFetch(): Promise<void> {
  for (let i = 0; i < 50 && !releaseFetch; i++) await new Promise((r) => setTimeout(r, 1));
  if (!releaseFetch) throw new Error('git fetch was never started');
}

describe('checkForDataUpdates single-flight (t/576)', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't576-'));
    fs.mkdirSync(path.join(tmpDir, '.git'));
    gitCalls.length = 0;
    releaseFetch = null;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('runs one git fetch for two concurrent calls, and both get the same result', async () => {
    const a = checkForDataUpdates();
    const b = checkForDataUpdates();
    await waitForFetch();
    releaseFetch!();
    const [ra, rb] = await Promise.all([a, b]);

    expect(fetchCount()).toBe(1);
    expect(ra).toBe(rb);
    expect(ra).toMatchObject({ available: false, currentCommit: 'abc123', remoteCommit: 'abc123' });
    expect(ra.error).toBeUndefined();
  });

  it('starts a fresh fetch for a call made after the previous check settled', async () => {
    const first = checkForDataUpdates();
    await waitForFetch();
    releaseFetch!();
    await first;

    releaseFetch = null;
    const second = checkForDataUpdates();
    await waitForFetch();
    releaseFetch!();
    await second;

    expect(fetchCount()).toBe(2);
  });
});
