// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/419: a longer test and hook ceiling for the shared lib suites ONLY. Renderer, main and server
// tests keep vitest's defaults (5 s per test, 10 s per hook).
//
// Why: the full lib run (`npx vitest run ../lib` from taxonomy-editor) on a loaded Windows host at
// 703dfb186 failed 19 tests in 13 files: 16 TestTimeoutError at the 5 s default and 1
// HookTimeoutError at the 10 s default (t/419#7). Which tests time out depends on load: 4
// sharedPrimitiveLint, 1 extractDocx and 11 under lib/debate in that run, a different set in the
// first report (t/285#27). They pass in isolation, so a per-test timeout would chase a moving set.
// Linux CI is green without this; the failures are a local full-suite gate problem.
//
// Scope (Quality, p/119#79): this file is in setupFiles for every test, but it only raises the
// ceilings when the file being run lives under the repo's lib/ directory (`libTestDir`, provided
// by vite.config.ts). vi.setConfig applies to the current test file only, so nothing leaks into
// the next file. A real hang in lib still fails, at 60 s instead of 5 s.

import { expect, inject, vi } from 'vitest';

declare module 'vitest' {
  export interface ProvidedContext {
    libTestDir: string;
  }
}

export const LIB_TEST_TIMEOUT_MS = 60_000;
export const LIB_HOOK_TIMEOUT_MS = 60_000;

const norm = (p: string): string => {
  const s = p.replace(/\\/g, '/').replace(/\/?$/, '/');
  return process.platform === 'win32' ? s.toLowerCase() : s;
};

/** True when `testPath` is a test file under `libDir` (the repo's lib/ directory). */
export function isLibTestFile(testPath: string | undefined, libDir: string | undefined): boolean {
  if (!testPath || !libDir) return false;
  return norm(testPath).startsWith(norm(libDir));
}

const libDir = inject('libTestDir');
if (!libDir) {
  console.warn('WARN: lib-timeout-setup: libTestDir was not provided by vite.config.ts; lib tests keep the 5 s default (t/419).');
} else if (isLibTestFile(expect.getState().testPath, libDir)) {
  vi.setConfig({ testTimeout: LIB_TEST_TIMEOUT_MS, hookTimeout: LIB_HOOK_TIMEOUT_MS });
}
