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

describe('formatFactCheckContent (t/4726)', () => {
  it('wraps the claim in italics with the quote marks inside the emphasis', () => {
    const content = formatFactCheckContent('Disputed', 'AI will take all jobs', 'No consensus exists.', '');
    expect(content).toBe('**Fact Check: Disputed**\n\n*"AI will take all jobs"*\n\nNo consensus exists.');
  });

  it('a claim containing * or _ still renders as valid, unbroken emphasis', () => {
    const content = formatFactCheckContent('Supported', 'models trained on *all* the_data', 'Explanation.', '');
    expect(content).toContain('*"models trained on \\*all\\* the\\_data"*');
  });

  it('appends the caller\'s webNote unchanged after the explanation', () => {
    const webNote = '\n\n*Web sources consulted: a, b*';
    const content = formatFactCheckContent('Disputed', 'claim', 'explanation', webNote);
    expect(content.endsWith(webNote)).toBe(true);
  });

  it('matches the exact shape both call sites build (bold verdict, blank line, italic quote, blank line, explanation)', () => {
    const content = formatFactCheckContent('Supported', 'x', 'y', '');
    expect(content.split('\n\n')).toEqual(['**Fact Check: Supported**', '*"x"*', 'y']);
  });
});
