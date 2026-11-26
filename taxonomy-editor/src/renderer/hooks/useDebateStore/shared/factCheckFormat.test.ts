// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect } from 'vitest';
import { escapeMarkdownEmphasis, formatFactCheckContent } from './factCheckFormat';

describe('escapeMarkdownEmphasis', () => {
  it('leaves plain text alone', () => {
    expect(escapeMarkdownEmphasis('a plain claim')).toBe('a plain claim');
  });

  it('escapes asterisks', () => {
    expect(escapeMarkdownEmphasis('AI will *definitely* win')).toBe('AI will \\*definitely\\* win');
  });

  it('escapes underscores', () => {
    expect(escapeMarkdownEmphasis('the_model always wins')).toBe('the\\_model always wins');
  });

  it('escapes a literal backslash too, so an already-escaped char isn\'t double-escaped oddly', () => {
    expect(escapeMarkdownEmphasis('a\\*b')).toBe('a\\\\\\*b');
  });

  it('trims edge whitespace', () => {
    expect(escapeMarkdownEmphasis('  spaced out  ')).toBe('spaced out');
  });
});

describe('formatFactCheckContent (t/4726, t/766)', () => {
  it('wraps the claim in italics with the quote marks inside the emphasis', () => {
    const content = formatFactCheckContent('AI will take all jobs', 'No consensus exists.');
    expect(content).toBe('*"AI will take all jobs"*\n\nNo consensus exists.');
  });

  it('a claim containing * or _ still renders as valid, unbroken emphasis', () => {
    const content = formatFactCheckContent('models trained on *all* the_data', 'Explanation.');
    expect(content).toContain('*"models trained on \\*all\\* the\\_data"*');
  });

  it('writes no title line and no web note (t/766, card spec section 5)', () => {
    const content = formatFactCheckContent('x', 'y');
    expect(content).not.toContain('Fact Check');
    expect(content).not.toContain('Web sources');
    expect(content.split('\n\n')).toEqual(['*"x"*', 'y']);
  });
});
