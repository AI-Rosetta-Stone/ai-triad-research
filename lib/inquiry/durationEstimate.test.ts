// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect } from 'vitest';
import { estimateInquiryDuration, type InquiryFidelity } from './durationEstimate.js';

describe('estimateInquiryDuration', () => {
  describe('fidelity fallback behavior', () => {
    it('returns Quick estimate for known fidelity', () => {
      const result = estimateInquiryDuration({
        fidelity: 'Quick',
        debaterModel: 'gemini-3.5-flash-lite',
      });
      expect(result).toEqual({ lowMin: 1, highMin: 3 });
    });

    it('returns Standard estimate for known fidelity', () => {
      const result = estimateInquiryDuration({
        fidelity: 'Standard',
        debaterModel: 'gemini-3.5-pro',
      });
      expect(result).toEqual({ lowMin: 3, highMin: 8 });
    });

    it('returns Deep estimate for known fidelity', () => {
      const result = estimateInquiryDuration({
        fidelity: 'Deep',
        debaterModel: 'claude-opus-5.5',
      });
      expect(result).toEqual({ lowMin: 5, highMin: 15 });
    });

    it('falls back to fidelity default for unknown model', () => {
      const result = estimateInquiryDuration({
        fidelity: 'Quick',
        debaterModel: 'unknown-model-xyz',
      });
      expect(result).toEqual({ lowMin: 1, highMin: 3 });
    });

    it('rejects invalid fidelity', () => {
      expect(() =>
        estimateInquiryDuration({
          fidelity: 'Invalid' as InquiryFidelity,
          debaterModel: 'gemini-3.5-flash-lite',
        }),
      ).toThrow(/Unknown fidelity/);
    });
  });

  describe('placeholder seeding', () => {
    it('acknowledges placeholder values via conservative estimates', () => {
      // These are placeholder estimates; test documents that they exist and are reasonable.
      // Once Azure p50/p90 table arrives on t/4751, this test will be updated to match real data.
      const quickResult = estimateInquiryDuration({
        fidelity: 'Quick',
        debaterModel: 'gemini-3.5-flash-lite',
      });
      expect(quickResult.lowMin).toBeGreaterThan(0);
      expect(quickResult.highMin).toBeGreaterThan(quickResult.lowMin);

      const deepResult = estimateInquiryDuration({
        fidelity: 'Deep',
        debaterModel: 'claude-opus-5.5',
      });
      expect(deepResult.lowMin).toBeGreaterThanOrEqual(quickResult.lowMin);
      expect(deepResult.highMin).toBeGreaterThan(quickResult.highMin);
    });
  });
});
