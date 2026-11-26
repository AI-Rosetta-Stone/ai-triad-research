// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/631: the packed-extract gate. The positive run needs a packed desktop build (the DevOps packed-extract CI job runs
// it against app.asar). Here we check the gate's failure path: with no packed layout, the check must exit non-zero, so
// a missing or broken packed app can never pass the job.

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'packed-extract-check.cjs');
const fixtures = join(here, 'packed-fixtures');

describe('packed-extract-check gate (t/631)', () => {
  it('fails (non-zero) when there is no packed app.asar to extract from', () => {
    const empty = mkdtempSync(join(tmpdir(), 'no-packed-app-'));
    try {
      const run = spawnSync(process.execPath, [script, empty, fixtures], { encoding: 'utf8' });
      expect(run.status).not.toBe(0);
      expect(run.stdout).toMatch(/FATAL/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
