// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * t/2026: the `dump-flight-recorder` retention cleanup previously swallowed failures with a
 * "telemetry — silent by design" comment, but it isn't telemetry — a failed prune (old dumps
 * not reclaimed) is a real operational fact. It now records a warn-level event and still
 * returns the dump path (cleanup failure must not fail the write). Drives the real handler by
 * mocking `electron` (capture the handler; app.getPath → a temp dir) and forcing the retention
 * `readdirSync` to throw.
 */
const H = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMPDIR || '/tmp';
  return {
    handlers: new Map<string, (...a: unknown[]) => unknown>(),
    root: `${base}/frd-${process.pid}-${Date.now()}`,
    events: [] as Record<string, unknown>[],
  };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (...a: unknown[]) => unknown) => { H.handlers.set(ch, fn); },
    on: () => {}, once: () => {}, removeListener: () => {},
  },
  app: { getPath: (name: string) => path.join(H.root, name) },
  shell: { openPath: () => Promise.resolve('') },
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('../fileIO.js', () => ({ PROJECT_ROOT: H.root }));

import { registerFlightRecorderHandlers } from '../ipc/flightRecorderHandlers.js';
import { setGlobalRecorder } from '../../../../lib/flight-recorder/index.js';

function invoke(channel: string, ...args: unknown[]): unknown {
  const fn = H.handlers.get(channel);
  if (!fn) throw new Error(`${channel} not registered`);
  return fn({}, ...args);
}

beforeEach(() => {
  H.handlers.clear();
  H.events.length = 0;
  fs.rmSync(H.root, { recursive: true, force: true });
  setGlobalRecorder({ record: (e: Record<string, unknown>) => { H.events.push(e); } } as never);
  registerFlightRecorderHandlers();
});
afterEach(() => {
  setGlobalRecorder(null as never);
  fs.rmSync(H.root, { recursive: true, force: true });
});

describe('dump-flight-recorder retention-cleanup failure recording (t/2026)', () => {
  it('records a warn event when retention cleanup throws, and still returns the dump path', () => {
    // Force the retention pass to fail (readdirSync is the first fs call inside its try).
    const spy = vi.spyOn(fs, 'readdirSync').mockImplementation(() => { throw new Error('readdir boom'); });
    try {
      const result = invoke('dump-flight-recorder', '{"t":"debate.turn"}\n') as { filePath: string; filename: string };

      // The dump write succeeded despite the cleanup failure (best-effort, non-fatal).
      expect(result.filename).toMatch(/^flight-recorder-.*\.jsonl$/);
      expect(fs.existsSync(result.filePath)).toBe(true);

      // …and the failure was recorded at warn level, not swallowed silently.
      const rec = H.events.find(e => e.component === 'ipc-flight-recorder');
      expect(rec).toBeDefined();
      expect(rec?.level).toBe('warn');
      expect(rec?.message).toContain('retention cleanup failed');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('dump-flight-recorder profile redaction (t/418)', () => {
  it('writes the dump with user-profile paths redacted, including in main-process stack traces', () => {
    // A main-process stack frame carries the raw profile path; the dump on disk must not.
    const ndjson = JSON.stringify({
      type: 'system.error',
      error: { stack: 'Error: boom\n    at C:\\Users\\jsnov\\repos\\app\\main.ts:12:3' },
    });
    const { filePath } = invoke('dump-flight-recorder', ndjson) as { filePath: string };
    const written = fs.readFileSync(filePath, 'utf-8');
    expect(written).not.toContain('jsnov');
    expect(written).toContain('%USERPROFILE%');
  });
});
