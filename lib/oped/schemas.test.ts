// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect } from 'vitest';
import { parseOpEdSet } from './schemas.js';

// ── Fixture helpers ────────────────────────────────────────────────────────────

function makeGrounding(overrides: Record<string, unknown> = {}) {
  return {
    node_id: 'saf-bel-001',
    label: 'AI is dangerous',
    category: 'Belief',
    pov: 'safetyist',
    relevance: '0.9100',
    how_reflected: 'cited in opening paragraph',
    ...overrides,
  };
}

function makeMember(overrides: Record<string, unknown> = {}) {
  return {
    pov: 'safetyist',
    status: 'complete',
    headline: 'Audits Are Overdue',
    subtitle: 'The safety case',
    body: 'Essay body text.',
    wordCount: 3,
    grounding: [makeGrounding()],
    ...overrides,
  };
}

function makeSet(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    set_id: 'set-abc-123',
    topic: 'Mandatory AI audits',
    params: { wordCount: 800, model: 'gemini-3.7-flash' },
    created_at: '2026-08-13T00:00:00.000Z',
    opeds: [makeMember()],
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('parseOpEdSet', () => {
  it('accepts a valid canonical OpEdSet', () => {
    const set = makeSet();
    expect(() => parseOpEdSet(set)).not.toThrow();
    const result = parseOpEdSet(set);
    expect(result.set_id).toBe('set-abc-123');
  });

  it('rejects short-code pov (acc/saf/skp) — names the offending field', () => {
    const bad = makeSet({ opeds: [makeMember({ pov: 'acc' })] });
    expect(() => parseOpEdSet(bad)).toThrow(/opeds\.0\.pov/);
  });

  it('rejects PascalCase grounding field (Id instead of node_id)', () => {
    const badGrounding = { Id: 'saf-bel-001', label: 'test', category: 'Belief', pov: 'safetyist', relevance: '0.9', how_reflected: 'used' };
    const bad = makeSet({ opeds: [makeMember({ grounding: [badGrounding] })] });
    expect(() => parseOpEdSet(bad)).toThrow();
  });

  it('accepts a partial set with complete + failed members (partial-set contract)', () => {
    const failedMember = makeMember({
      status: 'failed',
      headline: undefined,
      subtitle: undefined,
      body: undefined,
      wordCount: undefined,
      grounding: [],
    });
    const mixed = makeSet({ opeds: [makeMember(), failedMember] });
    expect(() => parseOpEdSet(mixed)).not.toThrow();
    const result = parseOpEdSet(mixed);
    expect(result.opeds).toHaveLength(2);
    expect(result.opeds[1].status).toBe('failed');
    expect(result.opeds[1].headline).toBe('');
  });

  it('rejects schema_version other than 1', () => {
    const bad = makeSet({ schema_version: 2 });
    expect(() => parseOpEdSet(bad)).toThrow();
  });
});

// ── t/2917 Step-7 prevention #2: claims/document_claims survive the store round-trip ──
// The op-ed-claims recurrence (t/2897) was "claims never reach the persisted set". The live
// test proves the extraction chain PRODUCES claims; this no-AI test proves they SURVIVE the
// store's serialize → Zod-reparse persist path (the half the live test doesn't isolate). A
// schema regression that silently drops `claims` or `grounding[].document_claims` fails here.
describe('parseOpEdSet — claims + document_claims survive save/reparse (t/2917)', () => {
  const CLAIMS = [
    { text: 'Safety incidents doubled year over year', paragraph: 1 },
    { text: 'Only three frontier labs share proactively', paragraph: 3 },
  ];
  const DOC_CLAIMS = ['Safety incidents doubled year over year', 'Only three frontier labs share proactively'];

  it('round-trips claims (text+paragraph) and grounding.document_claims through the exact serialize→Zod persist path', () => {
    const set = makeSet({
      opeds: [makeMember({
        claims: CLAIMS,
        grounding: [makeGrounding({ document_claims: DOC_CLAIMS })],
      })],
    });
    // Same path opedIO/opedStore use on persist: JSON serialize → JSON parse → parseOpEdSet (Zod).
    const round = parseOpEdSet(JSON.parse(JSON.stringify(set)));
    expect(round.opeds[0].claims).toEqual(CLAIMS);
    expect(round.opeds[0].grounding[0].document_claims).toEqual(DOC_CLAIMS);
  });

  it('a member with no claims and grounding without document_claims still parses (fields optional)', () => {
    const set = makeSet(); // makeMember() has no claims, makeGrounding() has no document_claims
    const round = parseOpEdSet(JSON.parse(JSON.stringify(set)));
    expect(round.opeds[0].claims).toBeUndefined();
    expect(round.opeds[0].grounding[0].document_claims).toBeUndefined();
  });
});

describe('parseOpEdSet — editing_meta and coherence_meta survive save/reparse (t/435)', () => {
  it('round-trips both observability records through the serialize→Zod persist path', () => {
    const editing = { edited: true, fk_before: 14.2, fk_after: 11.8, checks_failed_after: ['word-band'] };
    const coherence = {
      any_flagged: true,
      checks_fired: ['C1'],
      flags: [{ check_id: 'C1', span_a: 'first claim', span_b: 'second claim', why: 'contradiction' }],
      judge_model: 'gemini-3.7-flash',
      body_length_before: 800,
      body_length_after: 790,
      rewritten: true,
      checks_still_flagged_after: [],
    };
    const set = makeSet({ opeds: [makeMember({ editing_meta: editing, coherence_meta: coherence })] });
    const round = parseOpEdSet(JSON.parse(JSON.stringify(set)));
    expect(round.opeds[0].editing_meta).toEqual(editing);
    expect(round.opeds[0].coherence_meta).toEqual(coherence);
  });
});
