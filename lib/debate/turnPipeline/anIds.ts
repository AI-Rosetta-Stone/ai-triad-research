// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/487: argument-network ids (AN-<n>) in prose. The ids are internal. A plan may carry one in the
// leading "ATTACK [AN-n]:" tag, which the claim-map card reads. Anywhere else an id is either an
// invented reference or card data leaking into text a later stage, or a reader, will see. These
// helpers take the ids out of prose without breaking the sentence.

/** An id in brackets or parentheses (with one leading space), or a bare id. */
const AN_IN_PROSE = /\s?[[(]\s*(AN-\d+)\s*[\])]|\b(AN-\d+)\b/g;

/** What a bare id is replaced with, so "answers AN-7's point" still reads as a sentence. */
export const AN_ID_WORDS = 'an earlier argument';

/**
 * Mask every AN id in the text except those in `keep`. A bracketed or parenthesised id is removed
 * with its brackets. A bare id becomes AN_ID_WORDS. Returns the new text and the ids masked, in
 * order, repeats included. Text with no AN id to mask is returned unchanged.
 */
export function maskAnIds(text: string, keep: ReadonlySet<string> = new Set()): { text: string; masked: string[] } {
  const masked: string[] = [];
  const out = text.replace(AN_IN_PROSE, (match: string, bracketed: string | undefined, bare: string | undefined) => {
    const id = bracketed ?? bare!;
    if (keep.has(id)) return match;
    masked.push(id);
    return bracketed ? '' : AN_ID_WORDS;
  });
  return { text: masked.length > 0 ? out : text, masked };
}
