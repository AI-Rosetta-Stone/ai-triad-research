// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect } from 'vitest';
import { parseInquiryResult } from './parse.js';
import { INQUIRY_SCHEMA_VERSION } from './schema.js';
import { ActionableError } from '../debate/errors.js';
import { makeValidResult } from './__fixtures__/validResult.js';
import * as barrel from './index.js';

describe('lib/inquiry barrel (index.ts) — the contract surface five consumers import', () => {
  it('re-exports the parser, version, and the four named schemas', () => {
    expect(typeof barrel.parseInquiryResult).toBe('function');
    expect(barrel.INQUIRY_SCHEMA_VERSION).toBe(INQUIRY_SCHEMA_VERSION);
    expect(barrel.InquiryRequestSchema).toBeTruthy();
    expect(barrel.InquiryResultSchema).toBeTruthy();
    expect(barrel.TrustStateSchema).toBeTruthy();
    expect(barrel.GroundingEnvelopeSchema).toBeTruthy();
  });
});

describe('parseInquiryResult — version policy (ADR §3, t/3574)', () => {
  it('same major: returns a valid result', () => {
    const out = parseInquiryResult(makeValidResult());
    expect(out.request.question).toBe('What counts as an AI harm?');
    expect(out.schemaVersion).toBe(INQUIRY_SCHEMA_VERSION);
  });

  it('same major: TOLERANT read — an unknown field survives the round-trip (not stripped)', () => {
    const raw = { ...makeValidResult(), aFieldFromAFutureMinor: { note: 'keep me' } };
    const out = parseInquiryResult(raw) as Record<string, unknown>;
    expect(out.aFieldFromAFutureMinor).toEqual({ note: 'keep me' });
  });

  it('newer major: REFUSES loudly with ActionableError, does not render', () => {
    const raw = { ...makeValidResult(), schemaVersion: INQUIRY_SCHEMA_VERSION + 1 };
    let thrown: unknown;
    try {
      parseInquiryResult(raw);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ActionableError);
    expect((thrown as ActionableError).problem).toMatch(/newer than this build/i);
  });

  it('older version: routes to the migrate seam, which refuses loudly (no migration in v1)', () => {
    const raw = { ...makeValidResult(), schemaVersion: INQUIRY_SCHEMA_VERSION - 1 };
    expect(() => parseInquiryResult(raw)).toThrow(ActionableError);
  });

  it('malformed same-major payload: refused with ActionableError carrying the zod issues', () => {
    const bad = makeValidResult();
    delete (bad as Record<string, unknown>).derivation; // drop a required field
    let thrown: unknown;
    try {
      parseInquiryResult(bad);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ActionableError);
    expect((thrown as ActionableError).problem).toMatch(/failed schema validation/i);
  });

  it('missing schemaVersion is refused (a result must carry a version)', () => {
    const noVersion = makeValidResult();
    delete (noVersion as Record<string, unknown>).schemaVersion;
    expect(() => parseInquiryResult(noVersion)).toThrow(ActionableError);
  });

  it('mandatory TrustState.reason is enforced through the parser', () => {
    const bad = makeValidResult() as Record<string, unknown>;
    (bad.calibration as Array<Record<string, unknown>>)[0].trust = { verdict: 'censored' }; // no reason
    expect(() => parseInquiryResult(bad)).toThrow(ActionableError);
  });
});

// t/3643 (SO e/203#3): pin the schema-versioning INVARIANT, not just the parser's per-record behaviour.
// The rule at schema.ts:19-22 — "add an optional field → NO bump; change what a v1 reader would misread
// → bump" — is load-bearing because a WRONG bump is a self-inflicted READ OUTAGE: parseInquiryResult's
// newer-major arm refuses loudly (pinned by the 'newer major' test above), so bumping schemaVersion for
// a merely-additive field makes every deployed build reject every newly-written result across all five
// consumers — and migrate() throws (pinned by the 'older version' test above), so there is no downgrade
// path either. The rule has been hand-applied correctly twice (t/3585, t/3641); this converts "correct
// by careful reading" into "enforced." Unit test only — deliberately NOT a CI gate (t/3643 scope).
describe('schemaVersion invariant — additive-never-bumps (t/3643)', () => {
  it('READ-OUTAGE TRIPWIRE: INQUIRY_SCHEMA_VERSION is 1 — a bump is a BREAKING change, not a routine tick', () => {
    // The instruction lives in the ASSERTION MESSAGE, not just this comment: a red test shows the message,
    // and a bare "expected 2 to be 1" just gets the number edited to make it green (TL p/342#397, the same
    // lesson as the export guard). So whoever trips this reads WHY before touching it.
    expect(
      INQUIRY_SCHEMA_VERSION,
      'schemaVersion changed. If the change that bumped it is ADDITIVE (a new OPTIONAL field), REVERT the ' +
      'bump — additive-never-bumps (schema.ts:19-22): parse.ts refuses newer majors, so a bump makes every ' +
      'deployed build REJECT every newly-written result across all five consumers (a self-inflicted read ' +
      'outage), and migrate() throws so there is no downgrade path. Only bump for a change a v1 reader would ' +
      'MISREAD, and land a parse.ts migration FIRST. If the bump is genuinely breaking, update this number ' +
      'together with the sibling "newer major"/"older version" tests — deliberately, not to green a red test.',
    ).toBe(1);
  });

  it('additive-optional field needs NO bump — present or absent, a record parses at the same version', () => {
    // `debateId` is a declared OPTIONAL field (t/3641). A record omitting it and one carrying it BOTH
    // parse at the current version — the proof that adding an optional field requires no schemaVersion bump.
    const base = makeValidResult();
    expect('debateId' in base).toBe(false); // fixture predates the optional field
    expect(parseInquiryResult(base).schemaVersion).toBe(INQUIRY_SCHEMA_VERSION);
    const withOptional = parseInquiryResult({ ...base, debateId: 'debate-xyz' }) as Record<string, unknown>;
    expect(withOptional.schemaVersion).toBe(INQUIRY_SCHEMA_VERSION);
    expect(withOptional.debateId).toBe('debate-xyz');
  });
});
