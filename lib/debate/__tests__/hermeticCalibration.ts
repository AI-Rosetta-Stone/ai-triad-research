// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Hermetic calibration I/O for tests that drive DebateEngine.run() (t/57).
//
// Without this, every completed mock debate appends a row to the REAL
// ai-triad-data calibration/core + users/local logs (the optimizer and
// replication-gate source of truth), and runPostDebateCalibration reads and
// parses the whole core log (~200 MB locally), which is what pushed
// full-pipeline-equivalence past 5s under full-suite load.
//
// Usage (vi.mock is hoisted, so load the factory inside it):
//   vi.mock('./calibrationLogger.js', async (importOriginal) =>
//     (await import('./__tests__/hermeticCalibration.js')).hermeticCalibrationLogger(importOriginal));
//
// hermeticCalibration.test.ts fails any test file that runs the engine without it.

import { vi } from 'vitest';
import type * as CalibrationLogger from '../calibrationLogger.js';

export async function hermeticCalibrationLogger(
  importOriginal: () => Promise<unknown>,
): Promise<typeof CalibrationLogger> {
  const actual = (await importOriginal()) as typeof CalibrationLogger;
  return {
    ...actual,
    appendCalibrationLog: vi.fn(),
    readCalibrationLog: vi.fn(() => []),
  };
}
