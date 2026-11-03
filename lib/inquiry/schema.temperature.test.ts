// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect } from 'vitest';
import { InquiryRequestSchema, ResolvedDerivationSchema } from './schema.js';

describe('temperature field (t/4771)', () => {
  describe('InquiryRequestSchema temperature validation', () => {
    it('accepts valid temperature in range [0, 2]', () => {
      const request = {
        question: 'Test question?',
        fidelity: 'standard' as const,
        temperature: 1.5,
      };
      expect(InquiryRequestSchema.safeParse(request).success).toBe(true);
    });

    it('accepts temperature at lower bound (0)', () => {
      const request = {
        question: 'Test question?',
        fidelity: 'standard' as const,
        temperature: 0,
      };
      expect(InquiryRequestSchema.safeParse(request).success).toBe(true);
    });

    it('accepts temperature at upper bound (2)', () => {
      const request = {
        question: 'Test question?',
        fidelity: 'standard' as const,
        temperature: 2,
      };
      expect(InquiryRequestSchema.safeParse(request).success).toBe(true);
    });

    it('rejects temperature below 0', () => {
      const request = {
        question: 'Test question?',
        fidelity: 'standard' as const,
        temperature: -0.1,
      };
      expect(InquiryRequestSchema.safeParse(request).success).toBe(false);
    });

    it('rejects temperature above 2', () => {
      const request = {
        question: 'Test question?',
        fidelity: 'standard' as const,
        temperature: 2.1,
      };
      expect(InquiryRequestSchema.safeParse(request).success).toBe(false);
    });

    it('allows absent temperature (optional)', () => {
      const request = {
        question: 'Test question?',
        fidelity: 'standard' as const,
      };
      expect(InquiryRequestSchema.safeParse(request).success).toBe(true);
    });
  });

  describe('ResolvedDerivationSchema temperature', () => {
    const minimalDerivation = {
      fidelity: 'standard' as const,
      models: { debate: 'gemini-3.5-pro', evaluator: 'gemini-3.5-pro' },
      rounds: 6,
      callBudget: 200,
    };

    it('stamps temperature in derivation', () => {
      const derivation = { ...minimalDerivation, temperature: 1.2 };
      const result = ResolvedDerivationSchema.safeParse(derivation);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.temperature).toBe(1.2);
      }
    });

    it('allows absent temperature in derivation', () => {
      const result = ResolvedDerivationSchema.safeParse(minimalDerivation);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.temperature).toBeUndefined();
      }
    });

    it('rejects out-of-range temperature', () => {
      const derivation = { ...minimalDerivation, temperature: 2.5 };
      expect(ResolvedDerivationSchema.safeParse(derivation).success).toBe(false);
    });
  });

  describe('backward compatibility', () => {
    it('parses old ResolvedDerivation without temperature field', () => {
      const oldDerivation = {
        fidelity: 'standard' as const,
        models: { debate: 'gemini-3.5-pro', evaluator: 'gemini-3.5-pro' },
        rounds: 6,
        callBudget: 200,
      };
      const result = ResolvedDerivationSchema.safeParse(oldDerivation);
      expect(result.success).toBe(true);
    });
  });
});
