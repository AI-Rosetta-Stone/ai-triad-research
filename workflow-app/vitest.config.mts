// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Vitest config (t/3894). Without it vitest picks up vite.config.ts, whose root is
// src/renderer, and never finds the main-process tests in src/main.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: '.',
    include: ['src/**/*.test.ts'],
    setupFiles: ['./test-setup.ts'], // t/4462: data-root write guard
    environment: 'node',
  },
});
