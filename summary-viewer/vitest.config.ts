// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { defineConfig } from 'vitest/config';

// Minimal vitest setup (t/1682). summary-viewer had zero test infra, which is why
// the t/1677 prefix-map-vs-validator drift shipped silently. Node environment —
// the current tests are pure main-process logic (no DOM). Add jsdom here if a
// renderer test needs it later.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['./src/test/setupDataRootGuard.ts'],
  },
});
