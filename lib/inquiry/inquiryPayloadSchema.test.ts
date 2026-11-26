// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect } from 'vitest';
import { inquiryPayloadSchema, HttpUrlSchema } from './inquiryPayloadSchema.js';
import { makeValidResult, makeDriftedResult } from './__fixtures__/validResult.js';
import { toCommunityInquiryResult } from './communityProjection.js';

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

// t/285 (TL p/35#89): the community projection drops questionDrift.warning, so it must pass the upload schema.
describe('inquiryPayloadSchema with questionDrift (t/285)', () => {
  it('accepts a community-projected drifted result (warning dropped)', () => {
    const projected = toCommunityInquiryResult(makeDriftedResult() as any);
    const parsed = inquiryPayloadSchema.safeParse({ result: projected, note: 'n' });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.result.questionDrift).toEqual({
      debatedTopic: 'How should AI regulation be designed?',
    });
  });

  // TL t/285#55: a new Ask result reaches the upload as it was stored, with no projection by the caller. The schema
  // strips the gated leaves itself, so the parse succeeds and its OUTPUT (what the desktop uploads) carries none.
  it('accepts an unprojected new result and strips the three gated leaves from its output', () => {
    const stored = makeDriftedResult();
    // The fixture is a stored result: it carries all three gated leaves.
    const raw = JSON.stringify(stored);
    expect(raw).toContain('"warning"');
    expect(raw).toContain('"answeredLiteralQuestion"');
    expect(raw).toContain('"answerNote"');

    const parsed = inquiryPayloadSchema.safeParse({ result: stored, note: '' });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const out = JSON.stringify(parsed.data);
    expect(out).not.toContain('"warning"');
    expect(out).not.toContain('"answeredLiteralQuestion"');
    expect(out).not.toContain('"answerNote"');
    // What is not gated survives.
    expect(parsed.data.result.questionDrift).toEqual({ debatedTopic: 'How should AI regulation be designed?' });
    expect(parsed.data.result.campVerdicts[0].verdict).toBe((stored.campVerdicts as { verdict: string }[])[0].verdict);
    // The caller's object is not mutated.
    expect(JSON.stringify(stored)).toBe(raw);
  });

  it('strips only the three named leaves: any other unknown key is still refused', () => {
    const stored = makeDriftedResult() as Record<string, any>;
    const strayOnDrift = { ...stored, questionDrift: { ...stored.questionDrift, laterGatedField: true } };
    const strayOnCamp = { ...stored, campVerdicts: stored.campVerdicts.map((cv: object) => ({ ...cv, modelExtra: 'x' })) };
    const strayOnAnswer = { ...stored, directAnswer: { text: 'Yes.', agreement: 'consensus', modelExtra: 'x' } };
    const strayOnResult = { ...stored, somethingNew: 1 };
    for (const result of [strayOnDrift, strayOnCamp, strayOnAnswer, strayOnResult]) {
      expect(inquiryPayloadSchema.safeParse({ result, note: '' }).success).toBe(false);
    }
  });

  it('leaves a malformed body for the strict check to refuse, without throwing', () => {
    for (const body of [null, 'x', [], { result: null, note: '' }, { result: { campVerdicts: 'no' }, note: '' }]) {
      expect(() => inquiryPayloadSchema.safeParse(body)).not.toThrow();
      expect(inquiryPayloadSchema.safeParse(body).success).toBe(false);
    }
  });

  it('still accepts a result with no questionDrift block at all', () => {
    expect(inquiryPayloadSchema.safeParse({ result: makeValidResult(), note: '' }).success).toBe(true);
  });
});
