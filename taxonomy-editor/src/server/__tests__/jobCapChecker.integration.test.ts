import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  reserveSubmissionSlot,
  releaseSubmissionReservation,
  clearSubmissionPendingForTesting,
} from '../storage/jobCapChecker.js';

describe('t/182 integration — reservation API prevents concurrent submissions', () => {
  beforeEach(() => {
    clearSubmissionPendingForTesting();
  });

  describe('(c) Concurrent POSTs at cap-1 give 202 and 429', () => {
    it('inquiry: first POST reserves (202), second POST rejected (429)', () => {
      const userId = 'user-inquiry-1';

      // First POST: reserve successfully
      const firstReserve = reserveSubmissionSlot(userId, 'inquiry', undefined);
      expect(firstReserve).toBe(true);

      // Second concurrent POST: cannot reserve (slot held by first)
      const secondReserve = reserveSubmissionSlot(userId, 'inquiry', undefined);
      expect(secondReserve).toBe(false);

      // After first POST finishes, release
      releaseSubmissionReservation(userId, 'inquiry', undefined);

      // Third POST: can now reserve (slot is free)
      const thirdReserve = reserveSubmissionSlot(userId, 'inquiry', undefined);
      expect(thirdReserve).toBe(true);
    });

    it('export on different debates: first POST reserves, second rejected (cap is per-user)', () => {
      const userId = 'user-export-1';
      const debate1 = 'debate-1';
      const debate2 = 'debate-2';

      // Reserve for first export (debate1)
      // Note: key is (userId, 'brief-export', undefined), not per-debate
      const firstReserve = reserveSubmissionSlot(userId, 'brief-export', undefined);
      expect(firstReserve).toBe(true);

      // Try reserve for second export on DIFFERENT debate (debate2)
      // Should still fail because cap is per-user across all debates
      const secondReserve = reserveSubmissionSlot(userId, 'brief-export', undefined);
      expect(secondReserve).toBe(false);

      releaseSubmissionReservation(userId, 'brief-export', undefined);

      // Third POST should now succeed
      const thirdReserve = reserveSubmissionSlot(userId, 'brief-export', undefined);
      expect(thirdReserve).toBe(true);
    });
  });

  describe('(d) New POST after job finishes starts new job', () => {
    it('inquiry: after release, new POST succeeds', () => {
      const userId = 'user-inquiry-2';

      // First inquiry
      const first = reserveSubmissionSlot(userId, 'inquiry', undefined);
      expect(first).toBe(true);
      releaseSubmissionReservation(userId, 'inquiry', undefined);

      // Second inquiry (after first finishes)
      const second = reserveSubmissionSlot(userId, 'inquiry', undefined);
      expect(second).toBe(true);
      releaseSubmissionReservation(userId, 'inquiry', undefined);

      // Third inquiry
      const third = reserveSubmissionSlot(userId, 'inquiry', undefined);
      expect(third).toBe(true);
    });

    it('export: after release, new POST succeeds', () => {
      const userId = 'user-export-2';

      // First export
      const first = reserveSubmissionSlot(userId, 'brief-export', undefined);
      expect(first).toBe(true);
      releaseSubmissionReservation(userId, 'brief-export', undefined);

      // Second export
      const second = reserveSubmissionSlot(userId, 'brief-export', undefined);
      expect(second).toBe(true);
      releaseSubmissionReservation(userId, 'brief-export', undefined);

      // Third export
      const third = reserveSubmissionSlot(userId, 'brief-export', undefined);
      expect(third).toBe(true);
    });
  });
});
