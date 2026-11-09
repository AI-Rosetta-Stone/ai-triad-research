// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Gate (t/57): every lib/debate test that drives DebateEngine.run() must keep
// calibration I/O off the real data root, either through hermeticCalibrationLogger
// or its own calibrationLogger mock that stubs BOTH appendCalibrationLog and
// readCalibrationLog. A new engine-run test that forgets would silently append
// mock debates to ai-triad-data/calibration/core (warn-only guard output is
// hidden for passing tests, t/57#3).

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEBATE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...testFiles(p));
    else if (/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

function isHermetic(src: string): boolean {
  if (src.includes('hermeticCalibrationLogger(')) return true;
  const mocksLogger = /vi\.mock\(\s*['"](\.\.?\/)+calibrationLogger\.js['"]/.test(src);
  return mocksLogger
    && /appendCalibrationLog:\s*vi\.fn/.test(src)
    && /readCalibrationLog:\s*vi\.fn/.test(src);
}

describe('engine-run tests keep calibration I/O hermetic (t/57)', () => {
  const engineRunFiles = testFiles(DEBATE_DIR).filter(f => {
    const src = fs.readFileSync(f, 'utf-8');
    return /new DebateEngine\(/.test(src) && /\.run\(\)/.test(src);
  });

  it('finds the engine-run test files (scan is not vacuous)', () => {
    expect(engineRunFiles.length).toBeGreaterThanOrEqual(10);
  });

  it('every engine-run test file mocks calibration I/O', () => {
    const offenders = engineRunFiles
      .filter(f => !isHermetic(fs.readFileSync(f, 'utf-8')))
      .map(f => path.relative(DEBATE_DIR, f));
    expect(offenders, 'add the hermeticCalibrationLogger vi.mock (see __tests__/hermeticCalibration.ts)').toEqual([]);
  });
});
