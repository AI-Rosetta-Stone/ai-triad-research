// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect } from 'vitest';
import {
  InquiryRequestSchema,
  InquiryResultSchema,
  InquiryTitleSchema,
  ResolvedDerivationSchema,
  inquiryDisplayTitle,
  type InquiryResult,
} from './schema.js';
import { parseInquiryResult } from './parse.js';
import { toPublicInquiryShare } from './publicShare.js';
import { makeValidResult } from './__fixtures__/validResult.js';

const QUESTION = 'Test question?';
const baseRequest = { question: QUESTION, fidelity: 'standard' as const };
const minimalDerivation = {
  fidelity: 'standard' as const,
  models: { debate: 'gemini-3.5-pro', evaluator: 'gemini-3.5-pro' },
  rounds: 6,
  callBudget: 200,
};

function resultWith(patch: { title?: unknown; request?: Record<string, unknown>; derivation?: Record<string, unknown> }): Record<string, unknown> {
  const r = makeValidResult();
  if ('title' in patch) r.title = patch.title;
  if (patch.request) r.request = { ...(r.request as object), ...patch.request };
  if (patch.derivation) r.derivation = { ...(r.derivation as object), ...patch.derivation };
  return r;
}

describe('title field (t/4891)', () => {
  describe('InquiryTitleSchema (strict, for writers)', () => {
    it('accepts 1–200 chars and trims', () => {
      expect(InquiryTitleSchema.parse('  My title  ')).toBe('My title');
      expect(InquiryTitleSchema.safeParse('x'.repeat(200)).success).toBe(true);
    });

    it('rejects empty, whitespace-only and over-200-char titles', () => {
      expect(InquiryTitleSchema.safeParse('').success).toBe(false);
      expect(InquiryTitleSchema.safeParse('   ').success).toBe(false);
      expect(InquiryTitleSchema.safeParse('x'.repeat(201)).success).toBe(false);
    });
  });

  describe('InquiryRequestSchema title', () => {
    it('accepts a valid title and trims it', () => {
      const r = InquiryRequestSchema.parse({ ...baseRequest, title: '  My Inquiry Title ' });
      expect(r.title).toBe('My Inquiry Title');
    });

    it('allows absent title (optional)', () => {
      const r = InquiryRequestSchema.parse(baseRequest);
      expect(r.title).toBeUndefined();
    });

    it('treats empty and whitespace-only titles as no title', () => {
      for (const title of ['', '   ']) {
        const r = InquiryRequestSchema.parse({ ...baseRequest, title });
        expect(r.title, JSON.stringify(title)).toBeUndefined();
      }
    });

    it('rejects title exceeding max length (201 chars)', () => {
      expect(InquiryRequestSchema.safeParse({ ...baseRequest, title: 'x'.repeat(201) }).success).toBe(false);
    });

    it('rejects non-string title', () => {
      expect(InquiryRequestSchema.safeParse({ ...baseRequest, title: 123 }).success).toBe(false);
    });
  });

  describe('ResolvedDerivationSchema title', () => {
    it('stamps a title string or null', () => {
      expect(ResolvedDerivationSchema.parse({ ...minimalDerivation, title: 'T' }).title).toBe('T');
      expect(ResolvedDerivationSchema.parse({ ...minimalDerivation, title: null }).title).toBeNull();
    });

    it('allows absent title', () => {
      expect(ResolvedDerivationSchema.parse(minimalDerivation).title).toBeUndefined();
    });

    it('normalises a blank title to null', () => {
      expect(ResolvedDerivationSchema.parse({ ...minimalDerivation, title: '' }).title).toBeNull();
      expect(ResolvedDerivationSchema.parse({ ...minimalDerivation, title: '  ' }).title).toBeNull();
    });

    it('rejects title exceeding max length', () => {
      expect(ResolvedDerivationSchema.safeParse({ ...minimalDerivation, title: 'x'.repeat(201) }).success).toBe(false);
    });
  });

  describe('InquiryResultSchema top-level title (field of record for rename)', () => {
    it('accepts results with and without title', () => {
      expect(InquiryResultSchema.parse(makeValidResult()).title).toBeUndefined();
      expect(InquiryResultSchema.parse(resultWith({ title: ' Renamed ' })).title).toBe('Renamed');
    });

    it('treats a blank stored title as no title', () => {
      expect(InquiryResultSchema.parse(resultWith({ title: '' })).title).toBeUndefined();
    });

    it('rejects an over-200-char title', () => {
      expect(InquiryResultSchema.safeParse(resultWith({ title: 'x'.repeat(201) })).success).toBe(false);
    });
  });

  // TL t/4891#2 condition 1: the store parses on every read, so a stored blank title must still load.
  describe('REGRESSION: stored results with blank titles stay openable', () => {
    it('loads a stored result carrying derivation.title: "" and request.title: ""', () => {
      const stored = resultWith({ request: { title: '' }, derivation: { title: '' } });
      const result = parseInquiryResult(stored);
      expect(result.derivation.title).toBeNull();
      expect(result.request.title).toBeUndefined();
      expect(inquiryDisplayTitle(result)).toBe(result.request.question);
    });
  });

  describe('inquiryDisplayTitle', () => {
    const request = { ...baseRequest, title: 'Requested title' };

    it('tier 1: prefers the renamed top-level title', () => {
      expect(inquiryDisplayTitle({ title: 'Renamed', request })).toBe('Renamed');
    });

    it('tier 2: falls back to request.title', () => {
      expect(inquiryDisplayTitle({ request })).toBe('Requested title');
    });

    it('tier 3: falls back to the question as asked', () => {
      expect(inquiryDisplayTitle({ request: baseRequest })).toBe(QUESTION);
    });
  });

  describe('public share uses the display title (t/4891#3)', () => {
    it('shares a renamed question under its new name, leaving the question unchanged', () => {
      const result = parseInquiryResult(resultWith({ title: 'Renamed' })) as InquiryResult;
      const share = toPublicInquiryShare(result);
      expect(share.request.title).toBe('Renamed');
      expect(share.request.question).toBe(result.request.question);
    });

    it('omits the share title when it would just repeat the question', () => {
      const share = toPublicInquiryShare(parseInquiryResult(makeValidResult()));
      expect('title' in share.request).toBe(false);
    });
  });
});
