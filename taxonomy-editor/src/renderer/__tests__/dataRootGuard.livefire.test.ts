// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4462 live-fire (t/4454#3 condition 4): this config's setupFiles installed the data-root guard, so a write
// under the real data root WARNs. The test does NOT install the guard itself: it passes only if the wiring works.
// Safe by construction: the target's parent directory doesn't exist, so the write fails with ENOENT after the
// WARN, and nothing is written to the real repo.

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_ROOT_TEST_WRITE_TOKEN, protectedDataRoot } from '../../../../lib/test-support/dataRootGuard';

describe('data-root guard is wired into this config (t/4462)', () => {
  it('a write under the real data root WARNs with the token, target and caller', () => {
    const dir = path.join(protectedDataRoot(), '__guard_livefire__', 'missing');
    expect(fs.existsSync(dir)).toBe(false); // the ENOENT that keeps this harmless
    const target = path.join(dir, 'x.json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(() => fs.writeFileSync(target, '{}')).toThrow(/ENOENT/);
      const line = warn.mock.calls.map(c => String(c[0])).find(m => m.startsWith(DATA_ROOT_TEST_WRITE_TOKEN));
      expect(line).toBeDefined();
      expect(line).toContain('op=fs.writeFileSync');
      expect(line).toContain(`target=${target}`);
      expect(line).toContain('dataRootGuard.livefire.test'); // the caller
    } finally {
      warn.mockRestore();
    }
  });
});
