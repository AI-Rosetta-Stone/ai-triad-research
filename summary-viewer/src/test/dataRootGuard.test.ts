// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Live-fire test (t/4463): proves the guard fires when a write is aimed at the protected data root.
// Phase 1 is warn-only — the write is attempted after the WARN; we catch any fs error.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DATA_ROOT_TEST_WRITE_TOKEN, protectedDataRoot } from '../../../lib/test-support/dataRootGuard.js';

describe('data-root guard (live-fire)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('emits DATA-ROOT-TEST-WRITE when writeFileSync targets the protected root', () => {
    // Use a path whose parent doesn't exist: the guard WARNs, then the underlying writeFileSync
    // throws ENOENT — nothing is written to the real data repo in either worktree or dev runs.
    const anchorDir = path.join(protectedDataRoot(), '__guard_livefire__');
    expect(fs.existsSync(anchorDir), '__guard_livefire__ must not exist before the test').toBe(false);
    const target = path.join(anchorDir, 'missing', 'x.json');
    expect(() => fs.writeFileSync(target, '')).toThrow(/ENOENT/);
    const fired = warnSpy.mock.calls.some((args: unknown[]) => String(args[0]).includes(DATA_ROOT_TEST_WRITE_TOKEN));
    expect(fired, 'DATA-ROOT-TEST-WRITE WARN not emitted for writeFileSync under protected root').toBe(true);
    // Guard anchor dir must not exist (confirms nothing was created).
    expect(fs.existsSync(path.join(protectedDataRoot(), '__guard_livefire__'))).toBe(false);
  });
});
