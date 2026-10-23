// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { installDataRootGuard } from '../../../lib/test-support/dataRootGuard';

// t/4462 (t/4454 Phase 1): WARN (DATA-ROOT-TEST-WRITE) on any test write under the real ai-triad-data.
// This config also runs most lib/** suites. Idempotent across the per-file setup runs.
installDataRootGuard({ mode: 'warn' });

afterEach(() => {
  cleanup();
});
