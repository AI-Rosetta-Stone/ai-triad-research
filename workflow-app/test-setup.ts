// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4462 (t/4454 Phase 1): WARN (DATA-ROOT-TEST-WRITE) on any workflow-app test write under the real ai-triad-data.
import { installDataRootGuard } from '../lib/test-support/dataRootGuard';

installDataRootGuard({ mode: 'warn' });
