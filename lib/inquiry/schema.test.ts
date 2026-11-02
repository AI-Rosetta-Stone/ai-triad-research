// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect } from 'vitest';
import {
  InquiryRequestSchema,
  StoredInquiryRequestSchema,
  TrustStateSchema,
  InquiryResultSchema,
  INQUIRY_SCHEMA_VERSION,
} from './schema.js';
import { parseInquiryResult } from './parse.js';
import { makeValidResult } from './__fixtures__/validResult.js';

describe('InquiryRequestSchema — strict input boundary (t/3574#2)', () => {
  it('accepts a valid request', () => {
    expect(InquiryRequestSchema.safeParse({ question: 'q', fidelity: 'quick' }).success).toBe(true);
  });

  it('REJECTS a mistyped key rather than silently dropping it (the ungrounded-run bug)', () => {
    // `situationID` (wrong case) must fail loudly — accepting+dropping it would run ungrounded.
    const r = InquiryRequestSchema.safeParse({ question: 'q', fidelity: 'quick', situationID: 'sit-1' });
    expect(r.success).toBe(false);
  });

  it('rejects an unknown fidelity (closed enum)', () => {
    expect(InquiryRequestSchema.safeParse({ question: 'q', fidelity: 'exhaustive' }).success).toBe(false);
  });
});

describe('InquiryRequestSchema — optional model override (t/3574#3)', () => {
  it('accepts an explicit model override', () => {
    const r = InquiryRequestSchema.safeParse({
      question: 'q',
      fidelity: 'deep',
      models: { debaters: 'gemini-3.1-pro-preview', evaluator: 'claude-opus-4-8' },
    });
    expect(r.success).toBe(true);
  });

  it('accepts a partial / empty override (both sub-fields optional)', () => {
    expect(InquiryRequestSchema.safeParse({ question: 'q', fidelity: 'deep', models: {} }).success).toBe(true);
    expect(InquiryRequestSchema.safeParse({ question: 'q', fidelity: 'deep', models: { debaters: 'x' } }).success).toBe(true);
  });

  it('does NOT bake in a model-id enum — an arbitrary id parses here; membership is a boundary check', () => {
    // The contract is z.string() so a not-yet-registered id is structurally valid; ai-models.json
    // membership is validated at the ServerAPI boundary, not in this schema (t/3574#3, t/3560).
    expect(InquiryRequestSchema.safeParse({ question: 'q', fidelity: 'deep', models: { evaluator: 'a-future-model' } }).success).toBe(true);
  });
});

describe('StoredInquiryRequestSchema — tolerant embedded copy (t/3574#2)', () => {
  it('keeps an unknown field (a newer build may have added it to the request)', () => {
    const r = StoredInquiryRequestSchema.safeParse({ question: 'q', fidelity: 'deep', futureField: 42 });
    expect(r.success).toBe(true);
    expect(r.success && (r.data as Record<string, unknown>).futureField).toBe(42);
  });
});

describe('TrustStateSchema — reason mandatory (ADR §6)', () => {
  it('accepts a verdict that carries its reason', () => {
    expect(TrustStateSchema.safeParse({ verdict: 'censored', reason: 'api_ceiling truncated convergence' }).success).toBe(true);
  });

  it('rejects a bare verdict with no reason', () => {
    expect(TrustStateSchema.safeParse({ verdict: 'censored' }).success).toBe(false);
    expect(TrustStateSchema.safeParse({ verdict: 'censored', reason: '' }).success).toBe(false);
  });
});

describe('InquiryResultSchema — node snapshot + derivation stamp present (ADR §4/§5)', () => {
  it('a fully-formed result validates and carries inline node snapshots + the resolved receipt', () => {
    const r = InquiryResultSchema.safeParse(makeValidResult());
    expect(r.success).toBe(true);
    if (r.success) {
      // §5: node ref carries an inline label+camp snapshot, not just an id
      expect(r.data.campVerdicts[0].nodes[0].label).toBeTruthy();
      expect(r.data.campVerdicts[0].nodes[0].camp).toBe('skp');
      // §4: the receipt records resolved facts (models actually used, call budget), not just the label
      expect(r.data.derivation.callBudget).toBe(200);
      expect(r.data.derivation.models.debate).toBe('gemini-3.1-pro-preview');
      // note c: ratio display survives as a string a bare number could not express
      expect(r.data.calibration[0].displayValue).toBe('72 / 84');
    }
  });
});

describe('InquiryResultSchema — debateId raw-run reference (t/3641)', () => {
  it('accepts a stamped string debateId and exposes it typed', () => {
    const r = InquiryResultSchema.safeParse({ ...makeValidResult(), debateId: 'debate-abc123' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.debateId).toBe('debate-abc123');
  });

  it('accepts absence — old debateId-less records still parse (optional → no schemaVersion bump)', () => {
    const base = makeValidResult();
    expect('debateId' in base).toBe(false); // fixture has none, mirroring a pre-t/3641 persisted result
    const r = InquiryResultSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.debateId).toBeUndefined();
  });

  it('REJECTS an explicit null — .optional() admits undefined, not null (TL e/203#4, SO e/203#5)', () => {
    // Ruling: null is unreachable (every result has a session), so a producer must OMIT the key, never
    // stamp null. Pinning that null FAILS validation catches a null-emitting producer loudly at the
    // boundary rather than letting it silently poison a persisted, shareable artifact.
    const r = InquiryResultSchema.safeParse({ ...makeValidResult(), debateId: null });
    expect(r.success).toBe(false);
  });

  it('rejects a non-string debateId', () => {
    const r = InquiryResultSchema.safeParse({ ...makeValidResult(), debateId: 42 });
    expect(r.success).toBe(false);
  });

  it('parseInquiryResult round-trips a present id, tolerates absence, and refuses null', () => {
    expect(parseInquiryResult({ ...makeValidResult(), debateId: 'debate-x' }).debateId).toBe('debate-x');
    expect(parseInquiryResult(makeValidResult()).debateId).toBeUndefined();
    expect(() => parseInquiryResult({ ...makeValidResult(), debateId: null })).toThrow();
  });
});
