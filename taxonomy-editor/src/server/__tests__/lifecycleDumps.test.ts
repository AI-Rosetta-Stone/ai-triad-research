// @vitest-environment node
// t/613: shutdown and crash dumps are capped. After each write, only the newest 200 that are under 14 days old remain;
// other files in the folder are untouched; a failed delete is a WARN, never a throw.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const h = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../logger.js', () => ({ log: { server: { info: vi.fn(), warn: h.warn, error: vi.fn(), debug: vi.fn() } } }));

import { writeLifecycleDump, pruneLifecycleDumps } from '../lifecycleDumps.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 25, 12, 0, 0);
let dir: string;
const touch = (name: string) => fs.writeFileSync(path.join(dir, name), '{}\n');
const names = () => fs.readdirSync(dir).sort();

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 't613-')); h.warn.mockClear(); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('t/613: lifecycle dump retention', () => {
  it('keeps at most the newest maxCount, counting the dump just written', () => {
    for (let i = 1; i <= 5; i++) touch(`server-shutdown-${NOW - i * 60_000}.jsonl`);
    const r = writeLifecycleDump(dir, 'crash', '{"x":1}\n', { now: NOW, maxCount: 3 });
    expect(r.written).toBe(path.join(dir, `server-crash-${NOW}.jsonl`));
    expect(r.pruned).toBe(3);
    expect(names()).toEqual([`server-crash-${NOW}.jsonl`, `server-shutdown-${NOW - 60_000}.jsonl`, `server-shutdown-${NOW - 120_000}.jsonl`].sort());
  });

  it('removes dumps older than maxAgeMs even under the count cap', () => {
    touch(`server-crash-${NOW - 15 * DAY}.jsonl`);
    touch(`server-shutdown-${NOW - 13 * DAY}.jsonl`);
    const r = pruneLifecycleDumps(dir, { now: NOW });
    expect(r.pruned).toBe(1);
    expect(names()).toEqual([`server-shutdown-${NOW - 13 * DAY}.jsonl`]);
  });

  it('defaults: newest 200 under 14 days (250 recent dumps leave 200)', () => {
    for (let i = 0; i < 250; i++) touch(`server-shutdown-${NOW - i * 1000}.jsonl`);
    pruneLifecycleDumps(dir, { now: NOW });
    expect(names()).toHaveLength(200);
  });

  it('leaves every other file in the folder alone', () => {
    touch(`server-crash-${NOW - 20 * DAY}.jsonl`);
    for (const other of ['flight-recorder-2026-01-01.jsonl', 'server-flight-recorder-2026-01-01.jsonl', 'client-abc.jsonl', 'notes.txt']) touch(other);
    pruneLifecycleDumps(dir, { now: NOW });
    expect(names()).toEqual(['client-abc.jsonl', 'flight-recorder-2026-01-01.jsonl', 'notes.txt', 'server-flight-recorder-2026-01-01.jsonl']);
  });

  it('a failing delete is a WARN, not a throw, and the dump is still written', () => {
    for (let i = 1; i <= 4; i++) touch(`server-shutdown-${NOW - i * 60_000}.jsonl`);
    const unlink = vi.fn(() => { throw new Error('EPERM'); });
    let r: ReturnType<typeof writeLifecycleDump> | undefined;
    expect(() => { r = writeLifecycleDump(dir, 'shutdown', '{}\n', { now: NOW, maxCount: 2, unlink }); }).not.toThrow();
    expect(r!.written).not.toBeNull();
    expect(r!.pruneFailures).toBe(3);
    expect(r!.pruned).toBe(0);
    expect(h.warn).toHaveBeenCalled();
  });

  it('an unwritable dump directory is a WARN, not a throw', () => {
    const fileNotDir = path.join(dir, 'occupied');
    fs.writeFileSync(fileNotDir, 'x');
    let r: ReturnType<typeof writeLifecycleDump> | undefined;
    expect(() => { r = writeLifecycleDump(path.join(fileNotDir, 'sub'), 'crash', '{}\n', { now: NOW }); }).not.toThrow();
    expect(r!.written).toBeNull();
    expect(h.warn).toHaveBeenCalled();
  });
});
