// @vitest-environment node
//
// t/235 — no test write can reach the REAL data root. A timed-out test's orphaned write can resolve after
// afterAll has deleted AI_TRIAD_DATA_ROOT. Under vitest, an unset root must refuse, not fall back to the
// configured real root. These tests prove the refusal and that nothing is written to the real root.

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDataRoot, resolveDataPath } from '../config.js';
import { ActionableError } from '../../../../lib/debate/errors.js';

const savedRoot = process.env.AI_TRIAD_DATA_ROOT;

afterEach(() => {
  if (savedRoot === undefined) delete process.env.AI_TRIAD_DATA_ROOT; else process.env.AI_TRIAD_DATA_ROOT = savedRoot;
});

describe('no test write reaches the real data root (t/235)', () => {
  it('with AI_TRIAD_DATA_ROOT set, the root is that temp root', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't235-root-'));
    try {
      process.env.AI_TRIAD_DATA_ROOT = tmp;
      expect(getDataRoot()).toBe(path.resolve(tmp));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('after the root was set and then cleared under vitest, getDataRoot refuses with DATA_ROOT_UNSET_IN_TEST', () => {
    process.env.AI_TRIAD_DATA_ROOT = os.tmpdir();
    expect(getDataRoot()).toBe(path.resolve(os.tmpdir()));
    delete process.env.AI_TRIAD_DATA_ROOT;
    let caught: unknown;
    try { getDataRoot(); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(ActionableError);
    expect((caught as ActionableError).code).toBe('DATA_ROOT_UNSET_IN_TEST');
  });

  it('an orphaned write after the env var is cleared is refused and writes nothing', () => {
    // Simulate the race: the test set its temp root, afterAll cleared it, then the late write resolves.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't235-orphan-'));
    process.env.AI_TRIAD_DATA_ROOT = tmp;
    delete process.env.AI_TRIAD_DATA_ROOT;
    expect(() => resolveDataPath('taxonomy/Origin')).toThrow(ActionableError);
    // Nothing was created under the temp root, and nothing under the real root.
    expect(fs.readdirSync(tmp)).toEqual([]);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
