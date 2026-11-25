// @vitest-environment node
// t/494 (PI 2026-11-25, TL p/16#364): free-pool-budget-enforced is a permanent control. A stored expires_at is ignored
// (prod's flag carried 2027-01-02, which would have turned spend control off silently, t/494#20), setting one is
// refused, and the flag is never reported stale. Other flags keep their expiry behaviour.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getFlag, setFlag, deleteFlag, getStaleFlags, _resetFlagCache, PERMANENT_FLAGS } from '../featureFlags.js';

const FLAG = 'free-pool-budget-enforced';
const PAST = '2026-01-01T00:00:00.000Z';
let dataRoot: string;
const saved: Record<string, string | undefined> = {};
const flagsFile = () => path.join(dataRoot, 'admin', 'feature-flags.json');

function writeFlags(flags: Record<string, object>): void {
  fs.mkdirSync(path.dirname(flagsFile()), { recursive: true });
  fs.writeFileSync(flagsFile(), JSON.stringify({ flags }));
  _resetFlagCache();
}
const def = (name: string, extra: object) => ({ name, enabled: true, scope: 'global', created_at: PAST, updated_at: PAST, ...extra });

beforeEach(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flags-perm-'));
  for (const k of ['AI_TRIAD_DATA_ROOT', 'FEATURE_FLAG_ENV']) saved[k] = process.env[k];
  process.env.AI_TRIAD_DATA_ROOT = dataRoot;
  _resetFlagCache();
});
afterEach(() => {
  for (const k of ['AI_TRIAD_DATA_ROOT', 'FEATURE_FLAG_ENV']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  fs.rmSync(dataRoot, { recursive: true, force: true });
  _resetFlagCache();
});

describe('t/494: free-pool-budget-enforced is permanent', () => {
  it('is in PERMANENT_FLAGS', () => {
    expect(PERMANENT_FLAGS.has(FLAG)).toBe(true);
  });

  it('a stored past expires_at does not turn it off (prod had one)', () => {
    writeFlags({ [FLAG]: def(FLAG, { expires_at: PAST }) });
    expect(getFlag(FLAG)).toBe(true);
  });

  it('a non-permanent flag with a past expiry still reads off', () => {
    writeFlags({ 'some-temp-flag': def('some-temp-flag', { expires_at: PAST }) });
    expect(getFlag('some-temp-flag')).toBe(false);
  });

  it('setting an expiry on it is refused (FLAG_PERMANENT), and clearing it with null is allowed', () => {
    expect(() => setFlag(FLAG, { enabled: true, expires_at: '2027-01-02T00:00:00.000Z' })).toThrow(/permanent control/);
    const cleared = setFlag(FLAG, { enabled: true, expires_at: null });
    expect(cleared.expires_at).toBeNull();
    expect(getFlag(FLAG)).toBe(true);
  });

  it('cannot be deleted (it would fall back to the seed, enabled: false), so it stays on', () => {
    writeFlags({ [FLAG]: def(FLAG, {}) });
    expect(() => deleteFlag(FLAG)).toThrow(/cannot be deleted/);
    expect(getFlag(FLAG)).toBe(true);
  });

  it('is never reported stale, even with no expiry and an old updated_at', () => {
    writeFlags({ [FLAG]: def(FLAG, {}), 'old-temp': def('old-temp', {}) });
    const stale = getStaleFlags(30).map(f => f.name);
    expect(stale).toContain('old-temp');
    expect(stale).not.toContain(FLAG);
  });
});
