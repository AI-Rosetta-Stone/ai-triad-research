// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { countUserJobRecords, findRunningJobByIdempotencyKey } from '../storage/jobCapChecker.js';

vi.mock('../storage/jobRecords.js', () => ({
  listUserJobRecords: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  log: {
    server: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  },
}));

import { listUserJobRecords } from '../storage/jobRecords.js';

type TestRecord = { jobId: string; userId: string; status: string; idempotencyKey?: string };

describe('jobCapChecker (t/182)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('countUserJobRecords', () => {
    it('counts running records using the provided isRunning checker', async () => {
      const records: TestRecord[] = [
        { jobId: '1', userId: 'u1', status: 'running' },
        { jobId: '2', userId: 'u1', status: 'done' },
        { jobId: '3', userId: 'u1', status: 'running' },
      ];
      vi.mocked(listUserJobRecords).mockResolvedValue(records as any);

      const result = await countUserJobRecords(
        'u1',
        'inquiry',
        (r) => (r as TestRecord).status === 'running',
      );

      expect(result).toEqual({ count: 2, error: null });
    });

    it('returns 0 when no records are running', async () => {
      const records: TestRecord[] = [
        { jobId: '1', userId: 'u1', status: 'done' },
        { jobId: '2', userId: 'u1', status: 'failed' },
      ];
      vi.mocked(listUserJobRecords).mockResolvedValue(records as any);

      const result = await countUserJobRecords(
        'u1',
        'inquiry',
        (r) => (r as TestRecord).status === 'running',
      );

      expect(result).toEqual({ count: 0, error: null });
    });

    it('returns empty list when no records exist', async () => {
      vi.mocked(listUserJobRecords).mockResolvedValue([] as any);

      const result = await countUserJobRecords(
        'u1',
        'inquiry',
        (r) => (r as TestRecord).status === 'running',
      );

      expect(result).toEqual({ count: 0, error: null });
    });

    it('fails closed when listUserJobRecords throws', async () => {
      const testError = new Error('storage backend unavailable');
      vi.mocked(listUserJobRecords).mockRejectedValue(testError);

      const result = await countUserJobRecords(
        'u1',
        'inquiry',
        (r) => (r as TestRecord).status === 'running',
      );

      expect(result.count).toBeNull();
      expect(result.error).toEqual({
        reason: 'list_failed',
        kind: 'inquiry',
        userId: 'u1',
        cause: testError,
      });
    });
  });

  describe('findRunningJobByIdempotencyKey', () => {
    it('finds a running job by idempotency key', async () => {
      const records: TestRecord[] = [
        { jobId: '1', userId: 'u1', status: 'running', idempotencyKey: 'key-a' },
        { jobId: '2', userId: 'u1', status: 'done', idempotencyKey: 'key-b' },
      ];
      vi.mocked(listUserJobRecords).mockResolvedValue(records as any);

      const result = await findRunningJobByIdempotencyKey(
        'u1',
        'inquiry',
        'key-a',
        (r) => (r as TestRecord).status === 'running',
      );

      expect(result).toEqual(records[0]);
    });

    it('ignores terminal jobs when checking idempotency', async () => {
      const records: TestRecord[] = [
        { jobId: '1', userId: 'u1', status: 'done', idempotencyKey: 'key-a' },
      ];
      vi.mocked(listUserJobRecords).mockResolvedValue(records as any);

      const result = await findRunningJobByIdempotencyKey(
        'u1',
        'inquiry',
        'key-a',
        (r) => (r as TestRecord).status === 'running',
      );

      expect(result).toBeNull();
    });

    it('returns null when no idempotency key is provided', async () => {
      const result = await findRunningJobByIdempotencyKey(
        'u1',
        'inquiry',
        undefined,
        () => true,
      );

      expect(result).toBeNull();
      expect(vi.mocked(listUserJobRecords)).not.toHaveBeenCalled();
    });

    it('fails closed (returns null) when listUserJobRecords throws', async () => {
      const testError = new Error('storage unavailable');
      vi.mocked(listUserJobRecords).mockRejectedValue(testError);

      const result = await findRunningJobByIdempotencyKey(
        'u1',
        'inquiry',
        'key-a',
        (r) => (r as TestRecord).status === 'running',
      );

      expect(result).toBeNull();
    });
  });
});
