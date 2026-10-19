// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// POV tags 5b (t/3965; SO e/252 conds 1-4): the Inquiry request's `tagSelection`, the applied-tag record
// `derivation.tag`, and their path through the stored result, the public share and the exports.

import { describe, it, expect, vi } from 'vitest';

// The committed registry ships empty until the tag souls land (t/3956). Give the live boundary one
// Skeptic tag so the accept path is exercised; the empty-registry message is covered in povTags.test.ts.
vi.mock('../../debate/soul-docs/pov-tags.json', () => ({
  default: {
    version: 1,
    povs: { skeptic: [{ id: 'critical', label: 'Critical', soul_doc: 'skeptic.critical', description: 'Critical wing' }] },
  },
}));

import { InquiryRequestSchema, InquiryResultSchema, StoredInquiryRequestSchema, type InquiryResult } from '../schema.js';
import { PublicInquiryShareReadSchema, toPublicInquiryShare } from '../publicShare.js';
import { inquiryToMarkdown, inquiryToPrintHtml } from '../inquiryExport.js';

const SKEPTIC_CRITICAL = { pov: 'skeptic', tag: 'critical', mode: 'scope' } as const;
const APPLIED = { ...SKEPTIC_CRITICAL, included: 12, excludedUntagged: 31 };

function result(tagged: boolean): InquiryResult {
  return InquiryResultSchema.parse({
    schemaVersion: 1,
    request: { question: 'Should X?', fidelity: 'standard', ...(tagged ? { tagSelection: SKEPTIC_CRITICAL } : {}) },
    campVerdicts: [], convergences: [], evidenceLayers: [], unresolvedGaps: [], calibration: [],
    derivation: { fidelity: 'standard', models: { debate: 'm' }, rounds: 3, callBudget: 50, ...(tagged ? { tag: APPLIED } : {}) },
    grounding: { nodesByCamp: {} },
    singleRunCaveat: 'One run is not a finding.',
  });
}

describe('InquiryRequestSchema.tagSelection (live boundary)', () => {
  const base = { question: 'q', fidelity: 'quick' } as const;

  it('accepts a request with no tagSelection, unchanged from before', () => {
    expect(InquiryRequestSchema.safeParse(base).success).toBe(true);
  });

  it('accepts a registered tag for its own POV', () => {
    expect(InquiryRequestSchema.safeParse({ ...base, tagSelection: SKEPTIC_CRITICAL }).success).toBe(true);
    expect(InquiryRequestSchema.safeParse({ ...base, tagSelection: { ...SKEPTIC_CRITICAL, mode: 'prioritize' } }).success).toBe(true);
  });

  it('REJECTS an unknown tag, or a tag under the wrong POV, at tagSelection.tag (SO cond 4)', () => {
    for (const tagSelection of [{ ...SKEPTIC_CRITICAL, tag: 'nonexistent' }, { ...SKEPTIC_CRITICAL, pov: 'safetyist' }]) {
      const r = InquiryRequestSchema.safeParse({ ...base, tagSelection });
      expect(r.success, JSON.stringify(tagSelection)).toBe(false);
      expect(r.error?.issues[0].path).toEqual(['tagSelection', 'tag']);
    }
  });

  it('REJECTS a half selection, an unknown key, and an invalid pov or mode (both-or-neither by construction)', () => {
    for (const tagSelection of [
      { pov: 'skeptic', tag: 'critical' },
      { ...SKEPTIC_CRITICAL, mod: 'scope' },
      { ...SKEPTIC_CRITICAL, pov: 'cc' },
      { ...SKEPTIC_CRITICAL, mode: 'filter' },
    ]) {
      expect(InquiryRequestSchema.safeParse({ ...base, tagSelection }).success, JSON.stringify(tagSelection)).toBe(false);
    }
  });
});

describe('the stored copy stays readable', () => {
  it('accepts a tag the registry no longer lists, and a field a newer build added', () => {
    const r = StoredInquiryRequestSchema.safeParse({ question: 'q', fidelity: 'quick', tagSelection: { ...SKEPTIC_CRITICAL, tag: 'retired', weight: 2 } });
    expect(r.success).toBe(true);
  });

  it('a result carries both the ask and what ran', () => {
    const r = result(true);
    expect(r.request.tagSelection).toEqual(SKEPTIC_CRITICAL);
    expect(r.derivation.tag).toEqual(APPLIED);
  });
});

describe('public share (SO conds 1-2, e/252#5)', () => {
  it('INCLUDES the tag and the applied counts', () => {
    const share = toPublicInquiryShare(result(true));
    expect(share.request.tagSelection).toEqual(SKEPTIC_CRITICAL);
    expect(share.derivation.tag).toEqual(APPLIED);
    expect(PublicInquiryShareReadSchema.safeParse(share).success).toBe(true);
  });

  it('copies only the named tag fields, never an extra one from the passthrough stored copy', () => {
    const r = result(true);
    (r.request.tagSelection as Record<string, unknown>).internalNote = 'secret';
    expect(JSON.stringify(toPublicInquiryShare(r))).not.toContain('internalNote');
  });

  it('an untagged share has no tag keys at all', () => {
    const json = JSON.stringify(toPublicInquiryShare(result(false)));
    expect(json).not.toContain('tagSelection');
    expect(json).not.toContain('"tag"');
  });
});

describe('exports state the scope', () => {
  it('Markdown and print HTML show the applied tag with counts; untagged exports do not', () => {
    for (const out of [inquiryToMarkdown(result(true)), inquiryToPrintHtml(result(true))]) {
      expect(out).toContain('Tag: skeptic/critical (scope)');
      expect(out).toContain('31 not tagged critical excluded');
      expect(out).not.toContain('untagged excluded'); // t/4275: the count includes nodes carrying another tag
    }
    expect(inquiryToMarkdown(result(false))).not.toContain('Tag');
  });

  it('a tag that was asked for but not recorded as applied says so', () => {
    const r = result(true);
    delete r.derivation.tag;
    expect(inquiryToMarkdown(r)).toContain('Tag requested: skeptic/critical (scope)');
  });
});
