// @vitest-environment node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/3289 — loadDictionary() Fallback-Path Logging: WARN on missing/unreadable dict dir.
// Verifies:
//   (1) Missing standardized dir → WARN with cause='dir-missing'
//   (2) Dir present but 0 .json files → WARN with cause='empty-listing'
//   (3) Happy path → no WARN, returns terms

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks (hoisted before imports) ──

let recordedEvents: Array<{ level?: string; message?: string; data?: Record<string, unknown> }> = [];
vi.mock('../../../../lib/flight-recorder/index.js', () => ({
  getGlobalRecorder: () => ({ record: (ev: unknown) => { recordedEvents.push(ev as never); } }),
  redactRecord: (r: unknown) => r,
}));

import { loadDictionary, setBackend } from '../storage/fileIO.js';
import type { StorageBackend } from '../storage/storageBackend.js';
import { FilesystemBackend } from '../storage/filesystemBackend.js';
import * as os from 'node:os';

// ── Helpers ──

function makeBackend(
  listFn: (dir: string) => Promise<string[]>,
  readFn: (p: string) => Promise<string | null> = async () => null,
): StorageBackend {
  return { listDirectory: listFn, readFile: readFn } as unknown as StorageBackend;
}

// ── Tests ──

describe('loadDictionary — Fallback-Path Logging (t/3289)', () => {
  beforeEach(() => {
    recordedEvents = [];
  });

  afterEach(() => {
    setBackend(new FilesystemBackend({ root: os.tmpdir() }));
  });

  it('emits WARN with cause=dir-missing when standardized dir listing throws ENOENT', async () => {
    const enoent = Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    setBackend(makeBackend(async (dir) => {
      if (dir.includes('standardized')) throw enoent;
      return [];
    }));

    const result = await loadDictionary();

    expect(result.standardized).toEqual([]);
    const stdWarn = recordedEvents.find(e =>
      e.message?.includes('standardized') && e.message?.includes('dir-missing'),
    );
    expect(stdWarn).toBeDefined();
    expect(stdWarn?.level).toBe('warn');
    expect(stdWarn?.data?.cause).toBe('dir-missing');
  });

  it('emits WARN with cause=empty-listing when standardized dir has zero .json files', async () => {
    setBackend(makeBackend(async () => []));

    const result = await loadDictionary();

    expect(result.standardized).toEqual([]);
    const stdWarn = recordedEvents.find(e =>
      e.message?.includes('standardized') && e.message?.includes('empty-listing'),
    );
    expect(stdWarn).toBeDefined();
    expect(stdWarn?.level).toBe('warn');
    expect(stdWarn?.data?.cause).toBe('empty-listing');
  });

  it('does not emit WARN when terms load successfully', async () => {
    setBackend(makeBackend(
      async () => ['term1.json'],
      async () => JSON.stringify({ id: 'term1', label: 'Test' }),
    ));

    const result = await loadDictionary();

    expect(result.standardized).toHaveLength(1);
    expect(recordedEvents.filter(e => e.level === 'warn')).toHaveLength(0);
  });
});
