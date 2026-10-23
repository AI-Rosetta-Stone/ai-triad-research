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
    const target = path.join(protectedDataRoot(), '.drg-canary-sv');
    try {
      fs.writeFileSync(target, '');
      // Clean up if the write somehow succeeded (e.g. data root present on dev machine).
      try { fs.unlinkSync(target); } catch { /* best effort */ }
    } catch {
      // Write failure is expected when the data root doesn't exist in this worktree.
      // The guard still fires before the underlying attempt.
    }
    const fired = warnSpy.mock.calls.some(args => String(args[0]).includes(DATA_ROOT_TEST_WRITE_TOKEN));
    expect(fired, 'DATA-ROOT-TEST-WRITE WARN not emitted for writeFileSync under protected root').toBe(true);
  });
});
