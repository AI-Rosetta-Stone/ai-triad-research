// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// vitest setupFiles shim for t/4463. Installs the Phase-1 warn-only guard so any
// test write that hits the real ai-triad-data root logs DATA-ROOT-TEST-WRITE.
// Rule lives in the shared helper (lib/test-support/dataRootGuard.ts) — keep this file minimal.
import { installDataRootGuard } from '../../../lib/test-support/dataRootGuard.js';

installDataRootGuard({ mode: 'warn' });
