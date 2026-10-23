// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { defineConfig } from 'vitest/config';

// Minimal vitest setup (t/2534), mirroring summary-viewer's (t/1682). poviewer
// had zero test infra; added alongside the path-traversal / key-exposure
// hardening so its regression tests run in CI (`pnpm run --if-present test`).
// Node environment — the current tests are pure main-process logic (no DOM).
// Add jsdom here if a renderer test needs it later.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['./test-setup.ts'], // t/4462: data-root write guard
  },
});
