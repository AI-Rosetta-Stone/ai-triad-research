// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect } from 'vitest';
import { InquiryRequestSchema, ResolvedDerivationSchema } from './schema.js';

describe('title field (t/4891)', () => {
  describe('InquiryRequestSchema title validation', () => {
    it('accepts valid title within max length (200)', () => {
      const request = {
        question: 'Test question?',
        fidelity: 'standard' as const,
        title: 'My Inquiry Title',
      };
      expect(InquiryRequestSchema.safeParse(request).success).toBe(true);
    });

    it('accepts empty string title', () => {
      const request = {
        question: 'Test question?',
        fidelity: 'standard' as const,
        title: '',
      };
      expect(InquiryRequestSchema.safeParse(request).success).toBe(true);
    });

    it('accepts title at max length boundary (200 chars)', () => {
      const request = {
        question: 'Test question?',
        fidelity: 'standard' as const,
        title: 'x'.repeat(200),
      };
      expect(InquiryRequestSchema.safeParse(request).success).toBe(true);
    });

    it('rejects title exceeding max length (201 chars)', () => {
      const request = {
        question: 'Test question?',
        fidelity: 'standard' as const,
        title: 'x'.repeat(201),
      };
      expect(InquiryRequestSchema.safeParse(request).success).toBe(false);
    });

    it('allows absent title (optional)', () => {
      const request = {
        question: 'Test question?',
        fidelity: 'standard' as const,
      };
      expect(InquiryRequestSchema.safeParse(request).success).toBe(true);
    });

    it('rejects non-string title', () => {
      const request = {
        question: 'Test question?',
        fidelity: 'standard' as const,
        title: 123,
      };
      expect(InquiryRequestSchema.safeParse(request).success).toBe(false);
    });
  });

  describe('ResolvedDerivationSchema title', () => {
    const minimalDerivation = {
      fidelity: 'standard' as const,
      models: { debate: 'gemini-3.5-pro', evaluator: 'gemini-3.5-pro' },
      rounds: 6,
      callBudget: 200,
    };

    it('stamps title string in derivation', () => {
      const derivation = { ...minimalDerivation, title: 'Resolved Title' };
      const result = ResolvedDerivationSchema.safeParse(derivation);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.title).toBe('Resolved Title');
      }
    });

    it('stamps null title in derivation', () => {
      const derivation = { ...minimalDerivation, title: null };
      const result = ResolvedDerivationSchema.safeParse(derivation);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.title).toBeNull();
      }
    });

    it('allows absent title in derivation', () => {
      const result = ResolvedDerivationSchema.safeParse(minimalDerivation);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.title).toBeUndefined();
      }
    });

    it('rejects title exceeding max length', () => {
      const derivation = { ...minimalDerivation, title: 'x'.repeat(201) };
      expect(ResolvedDerivationSchema.safeParse(derivation).success).toBe(false);
    });

    it('accepts empty string title in derivation', () => {
      const derivation = { ...minimalDerivation, title: '' };
      const result = ResolvedDerivationSchema.safeParse(derivation);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.title).toBe('');
      }
    });
  });

  describe('backward compatibility', () => {
    it('parses old InquiryRequest without title field', () => {
      const oldRequest = {
        question: 'Test question?',
        fidelity: 'standard' as const,
      };
      const result = InquiryRequestSchema.safeParse(oldRequest);
      expect(result.success).toBe(true);
    });

    it('parses old ResolvedDerivation without title field', () => {
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
