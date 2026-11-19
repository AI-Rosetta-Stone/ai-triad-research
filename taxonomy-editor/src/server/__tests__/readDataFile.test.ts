// @vitest-environment node
//
// Unit tests for readDataFile() — sole sanctioned data-root reader (t/3092).

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoist mock fns so vi.mock factories can reference them.
const { mockRecord, mockReadBinaryFile, mockFsReadFile } = vi.hoisted(() => ({
  mockRecord: vi.fn(),
  mockReadBinaryFile: vi.fn(),
  mockFsReadFile: vi.fn(),
}));

vi.mock('../../../../lib/flight-recorder/index.js', () => ({
  getGlobalRecorder: () => ({ record: mockRecord }),
}));

vi.mock('../storage/fileIO.js', () => ({
  getBackend: () => ({ readBinaryFile: mockReadBinaryFile }),
}));

vi.mock('fs/promises', () => ({ default: { readFile: mockFsReadFile, realpath: vi.fn(async (p: string) => p) } })); // t/432

vi.mock('../config.js', () => ({
  resolveDataPath: (rel: string) => `/data/root/${rel}`,
}));

import { readDataFile } from '../storage/readDataFile.js';
import { ActionableError } from '../../../../lib/debate/errors.js';

const RESOLVED = '/data/root/some/file.json';

beforeEach(() => {
  vi.clearAllMocks();
});

// ── 1. Normal read — backend returns content ─────────────────────────────────

describe('readDataFile — normal read', () => {
  it('returns Buffer from backend for a non-empty result', async () => {
    const content = Buffer.from('{"nodes":[]}');
    mockReadBinaryFile.mockResolvedValue(content);

    const result = await readDataFile('some/file.json');

    expect(result).toBe(content);
    expect(mockReadBinaryFile).toHaveBeenCalledWith(RESOLVED);
    expect(mockRecord).not.toHaveBeenCalled();
  });
});

// ── 2. Large-file branch — raw fs.readFile at resolveDataPath result ─────────

describe('readDataFile — largeFile branch', () => {
  it('reads via fs.readFile(resolveDataPath(relPath)) when largeFile:true', async () => {
    const content = Buffer.from('x'.repeat(1024));
    mockFsReadFile.mockResolvedValue(content);

    const result = await readDataFile('some/file.json', { largeFile: true });

    expect(result).toBe(content);
    expect(mockFsReadFile).toHaveBeenCalledWith(RESOLVED);
    expect(mockReadBinaryFile).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });
});

// ── 3. Empty-buffer guard ────────────────────────────────────────────────────

describe('readDataFile — empty buffer guard', () => {
  it('throws ActionableError and records FR event when backend returns empty Buffer', async () => {
    mockReadBinaryFile.mockResolvedValue(Buffer.alloc(0));

    await expect(readDataFile('some/file.json')).rejects.toThrow(ActionableError);

    expect(mockRecord).toHaveBeenCalledOnce();
    expect(mockRecord.mock.calls[0][0]).toMatchObject({
      type: 'data_read_empty',
      component: 'read-data-file',
      level: 'error',
    });
  });
});

// ── 4. Missing-file guard ────────────────────────────────────────────────────

describe('readDataFile — missing file guard', () => {
  it('throws ActionableError and records FR event when backend returns null', async () => {
    mockReadBinaryFile.mockResolvedValue(null);

    await expect(readDataFile('some/file.json')).rejects.toThrow(ActionableError);

    expect(mockRecord).toHaveBeenCalledOnce();
    expect(mockRecord.mock.calls[0][0]).toMatchObject({
      type: 'data_read_empty',
      component: 'read-data-file',
      level: 'error',
      message: expect.stringContaining('missing'),
    });
  });

  it('throws ActionableError and records FR event on ENOENT in largeFile branch', async () => {
    const err = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
    mockFsReadFile.mockRejectedValue(err);

    await expect(readDataFile('some/file.json', { largeFile: true })).rejects.toThrow(ActionableError);

    expect(mockRecord).toHaveBeenCalledOnce();
    expect(mockRecord.mock.calls[0][0]).toMatchObject({
      type: 'data_read_empty',
      message: expect.stringContaining('missing'),
    });
  });
});

// ── 5. Non-empty-but-invalid — validator arm (t/3085 class) ─────────────────

describe('readDataFile — validator arm', () => {
  it('throws ActionableError and records FR event when validate() rejects non-empty content', async () => {
    // A stale/short file: non-empty, non-ENOENT, but node count too low (t/3085 class).
    const staleContent = Buffer.from('{"nodes":[],"meta":"stale"}');
    mockReadBinaryFile.mockResolvedValue(staleContent);

    const validate = (buf: Buffer) => {
      const parsed = JSON.parse(buf.toString()) as { nodes: unknown[] };
      if (parsed.nodes.length < 100) throw new Error('node count too low: got 0, want ≥100');
    };

    await expect(readDataFile('some/file.json', { validate })).rejects.toThrow(ActionableError);

    expect(mockRecord).toHaveBeenCalledOnce();
    expect(mockRecord.mock.calls[0][0]).toMatchObject({
      type: 'data_read_empty',
      component: 'read-data-file',
      level: 'error',
      message: expect.stringContaining('validation failed'),
    });
  });
});
