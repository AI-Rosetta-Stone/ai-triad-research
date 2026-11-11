// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Extract text from HTML using the stable stripHtmlFallback implementation.
 * Reuses the same approach as lib/debate URL mode for consistency.
 * Strips script/style/head/noscript tags via a stability loop that guarantees termination.
 */
export function extractHtmlText(bytes: Uint8Array): string {
  const html = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  return stripHtmlFallback(html);
}

/**
 * Strip HTML tags and normalize whitespace.
 * Uses a do-while loop that strips iteratively until stable (no further removals possible).
 * Termination is guaranteed because lazy matching always removes the shortest match,
 * so the string strictly shrinks toward a fixed point.
 *
 * codeql[js/bad-tag-filter]
 * codeql[js/incomplete-multi-character-sanitization] do-while exits on stability; termination guaranteed
 */
function stripHtmlFallback(html: string): string {
  let s = html;
  let prev: string;
  do {
    prev = s;
    s = s
      .replace(/<script[\s\S]*?<\/script[^>]*>/gi, '')
      .replace(/<style[\s\S]*?<\/style[^>]*>/gi, '')
      .replace(/<noscript[\s\S]*?<\/noscript[^>]*>/gi, '')
      .replace(/<head[\s\S]*?<\/head[^>]*>/gi, '')
      .replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  } while (s !== prev);
  return s;
}
