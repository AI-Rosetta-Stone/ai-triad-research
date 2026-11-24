// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/419: the lib-only timeout ceiling selects lib test files and nothing else, and this (renderer)
// file keeps vitest's default timeouts.

import { describe, expect, inject, it } from 'vitest';
import { isLibTestFile } from './lib-timeout-setup';

describe('isLibTestFile (t/419)', () => {
  const lib = 'C:\\repo\\lib';

  it('selects files under lib/, either slash style', () => {
    expect(isLibTestFile('C:/repo/lib/debate/debateEngine.test.ts', lib)).toBe(true);
    expect(isLibTestFile('C:\\repo\\lib\\extraction\\extractDocx.test.ts', lib)).toBe(true);
    expect(isLibTestFile('/repo/lib/x.test.ts', '/repo/lib/')).toBe(true);
  });

  it('does not select renderer, server or a sibling that only shares the prefix', () => {
    expect(isLibTestFile('C:/repo/taxonomy-editor/src/renderer/App.test.tsx', lib)).toBe(false);
    expect(isLibTestFile('C:/repo/taxonomy-editor/src/server/__tests__/x.test.ts', lib)).toBe(false);
    expect(isLibTestFile('C:/repo/library/x.test.ts', lib)).toBe(false);
  });

  it('never selects when the path or the lib dir is missing', () => {
    expect(isLibTestFile(undefined, lib)).toBe(false);
    expect(isLibTestFile('C:/repo/lib/x.test.ts', undefined)).toBe(false);
  });

  it('vite.config.ts provides the lib dir, and this renderer file is not under it', () => {
    const libDir = inject('libTestDir');
    expect(libDir).toMatch(/[\\/]lib$/);
    expect(isLibTestFile(expect.getState().testPath, libDir)).toBe(false);
  });
});
