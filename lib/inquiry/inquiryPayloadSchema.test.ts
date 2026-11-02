// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect } from 'vitest';
import { inquiryPayloadSchema, HttpUrlSchema } from './inquiryPayloadSchema.js';
import { makeValidResult } from './schema.test.js';

describe('HttpUrlSchema', () => {
  it('accepts valid HTTP URLs', () => {
    expect(HttpUrlSchema.parse('http://example.com')).toBe('http://example.com');
  });

  it('accepts valid HTTPS URLs', () => {
    expect(HttpUrlSchema.parse('https://example.com/path?query=1')).toBe(
      'https://example.com/path?query=1'
    );
  });

  it('rejects javascript: URLs', () => {
    expect(() => HttpUrlSchema.parse('javascript:alert(1)')).toThrow();
  });

  it('rejects data: URLs', () => {
    expect(() =>
      HttpUrlSchema.parse('data:text/html,<script>alert(1)</script>')
    ).toThrow();
  });

  it('rejects non-URL strings', () => {
    expect(() => HttpUrlSchema.parse('not a url')).toThrow();
  });

  it('rejects file: protocol', () => {
    expect(() => HttpUrlSchema.parse('file:///etc/test')).toThrow();
  });
});

describe('inquiryPayloadSchema', () => {
  const validResult = makeValidResult();

  describe('valid payloads', () => {
    it('accepts valid payload with result and note', () => {
      const payload = { result: validResult, note: 'Test note' };
      const parsed = inquiryPayloadSchema.parse(payload);
      expect(parsed.note).toBe('Test note');
    });

    it('accepts empty note string', () => {
      const payload = { result: validResult, note: '' };
      const parsed = inquiryPayloadSchema.parse(payload);
      expect(parsed.note).toBe('');
    });

    it('accepts note at max length (5000 chars)', () => {
      const longNote = 'x'.repeat(5000);
      const payload = { result: validResult, note: longNote };
      const parsed = inquiryPayloadSchema.parse(payload);
      expect(parsed.note.length).toBe(5000);
    });
  });

  describe('note validation', () => {
    it('rejects note exceeding 5000 chars', () => {
      const tooLongNote = 'x'.repeat(5001);
      const payload = { result: validResult, note: tooLongNote };
      expect(() => inquiryPayloadSchema.parse(payload)).toThrow();
    });

    it('defaults note to empty string when omitted', () => {
      const payload = { result: validResult };
      const parsed = inquiryPayloadSchema.parse(payload);
      expect(parsed.note).toBe('');
    });
  });

  describe('strict mode enforcement', () => {
    it('round-trip: valid payload stays valid', () => {
      const payload = { result: validResult, note: 'Test' };
      const parsed = inquiryPayloadSchema.parse(payload);
      // Re-parse the result: should still validate with strict
      const reparsed = inquiryPayloadSchema.parse({
        result: parsed.result,
        note: parsed.note,
      });
      expect(reparsed.note).toBe('Test');
    });

    it('rejects extra top-level fields (payload-level strict)', () => {
      const payload = {
        result: validResult,
        note: 'Test',
        extraField: 'should fail',
      };
      expect(() => inquiryPayloadSchema.parse(payload as any)).toThrow();
    });

    it('rejects extra fields on result object (result.strict())', () => {
      const resultWithExtra = { ...validResult, extraResultField: 'bad' };
      const payload = { result: resultWithExtra, note: 'Test' };
      expect(() => inquiryPayloadSchema.parse(payload as any)).toThrow();
    });
  });

  describe('required fields', () => {
    it('requires result field', () => {
      expect(() =>
        inquiryPayloadSchema.parse({ note: 'test' })
      ).toThrow();
    });

    it('accepts payload with only result (note optional with default)', () => {
      const parsed = inquiryPayloadSchema.parse({ result: validResult });
      expect(parsed.result).toBeTruthy();
      expect(parsed.note).toBe('');
    });
  });
});
