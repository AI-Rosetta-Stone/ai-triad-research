// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi } from 'vitest';

vi.mock('./InquiryTagPicker', () => ({
  tagSummaryLabel: (sel: { tag: string }) => (sel.tag === 'critical' ? 'Critical' : sel.tag),
}));

const {
  truncateLabel, modelLabel, modelSummarySegment, tagSummarySegment, fidelitySummarySegment, optionsChangeCount,
} = await import('./InquiryOptionsSummary');

const OPTIONS = [
  { value: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
  { value: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite' },
];

describe('truncateLabel', () => {
  it('leaves short strings alone', () => {
    expect(truncateLabel('Quick')).toBe('Quick');
  });

  it('truncates at ~32 chars with an ellipsis', () => {
    const long = 'A'.repeat(50);
    const result = truncateLabel(long);
    expect(result.length).toBe(32);
    expect(result.endsWith('…')).toBe(true);
  });
});

describe('modelLabel', () => {
  it('resolves a known model value to its display label', () => {
    expect(modelLabel('claude-sonnet-5', OPTIONS)).toBe('Claude Sonnet 5');
  });

  it('falls back to the raw value for an unknown model', () => {
    expect(modelLabel('unknown-model', OPTIONS)).toBe('unknown-model');
  });
});

describe('modelSummarySegment', () => {
  it('shows just the model when debaters and evaluator match', () => {
    expect(modelSummarySegment('claude-sonnet-5', 'claude-sonnet-5', OPTIONS)).toBe('Claude Sonnet 5');
  });

  it('shows both when they differ', () => {
    expect(modelSummarySegment('claude-sonnet-5', 'gemini-3.5-flash-lite', OPTIONS))
      .toBe('Debaters Claude Sonnet 5 · Evaluator Gemini 3.5 Flash Lite');
  });
});

describe('tagSummarySegment', () => {
  it('reads "Untagged" with no selection', () => {
    expect(tagSummarySegment(undefined, undefined)).toBe('Untagged');
  });

  it('shows the tag label in scope mode', () => {
    expect(tagSummarySegment({ pov: 'skeptic', tag: 'critical', mode: 'scope' }, undefined)).toBe('Critical');
  });

  it('appends "(prioritize)" in prioritize mode', () => {
    expect(tagSummarySegment({ pov: 'skeptic', tag: 'critical', mode: 'prioritize' }, undefined)).toBe('Critical (prioritize)');
  });

  it('a blocked reason wins over the normal tag text', () => {
    expect(tagSummarySegment({ pov: 'skeptic', tag: 'critical', mode: 'scope' }, 'too small')).toBe('POV tag: too small');
  });
});

describe('fidelitySummarySegment', () => {
  it('returns the display label', () => {
    expect(fidelitySummarySegment('standard')).toBe('Standard');
  });
});

describe('optionsChangeCount', () => {
  // p/29#186 fix 1: the store's default fidelity is Standard, not Quick (Design's own spec error).
  it('is 0 at every default', () => {
    expect(optionsChangeCount('standard', undefined, undefined, undefined)).toBe(0);
  });

  it('counts a non-default fidelity', () => {
    expect(optionsChangeCount('deep', undefined, undefined, undefined)).toBe(1);
    expect(optionsChangeCount('quick', undefined, undefined, undefined)).toBe(1);
  });

  it('counts each model override separately', () => {
    expect(optionsChangeCount('standard', 'claude-sonnet-5', 'gemini-3.5-flash-lite', undefined)).toBe(2);
  });

  it('counts a tag selection', () => {
    expect(optionsChangeCount('standard', undefined, undefined, { pov: 'skeptic', tag: 'critical', mode: 'scope' })).toBe(1);
  });

  it('sums all four when everything differs', () => {
    expect(optionsChangeCount('deep', 'claude-sonnet-5', 'gemini-3.5-flash-lite', { pov: 'skeptic', tag: 'critical', mode: 'scope' })).toBe(4);
  });
});
