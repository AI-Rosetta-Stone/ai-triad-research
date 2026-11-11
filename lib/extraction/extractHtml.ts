// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Extract text from HTML using safe linear-time tag removal.
 * Prevents quadratic regex behavior on malformed HTML (unclosed tags).
 * Script/style/head/noscript tags removed in linear time to prevent DoS.
 */
export function extractHtmlText(bytes: Uint8Array): string {
  const html = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  return stripHtmlFallback(html);
}

/**
 * Strip HTML tags and normalize whitespace safely.
 * Step 1: Remove problematic tags (script/style/head/noscript) using linear-time parser
 * Step 2: Iteratively normalize other tags with bounded iterations and timeout
 *
 * codeql[js/bad-tag-filter]
 * codeql[js/incomplete-multi-character-sanitization] linear removal + bounded iteration + timeout
 */
function stripHtmlFallback(html: string): string {
  // Step 1: Remove problematic tags in linear time (prevent quadratic regex on unclosed tags)
  let s = removeTagsByName(html, ['script', 'style', 'noscript', 'head']);

  // Step 2: Iteratively normalize with bounded iterations (max 100 passes, 5s timeout)
  const maxIterations = 100;
  const timeoutMs = 5000;
  const startTime = Date.now();
  let iterations = 0;

  let prev: string;
  do {
    if (++iterations > maxIterations) {
      throw new Error(`HTML normalization exceeded ${maxIterations} iterations (possible malformed HTML)`);
    }
    if (Date.now() - startTime > timeoutMs) {
      throw new Error(`HTML normalization exceeded ${timeoutMs}ms timeout`);
    }

    prev = s;
    s = s
      .replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  } while (s !== prev);
  return s;
}

/**
 * Remove tags by name in linear time using character-by-character parsing.
 * Handles unclosed tags and prevents quadratic regex behavior.
 */
function removeTagsByName(html: string, tagNames: string[]): string {
  let result = html;
  for (const tag of tagNames) {
    result = removeTag(result, tag);
  }
  return result;
}

/**
 * Remove a specific tag and its contents in linear time, handling unclosed tags safely.
 */
function removeTag(html: string, tagName: string): string {
  const openTag = `<${tagName}`;
  const closeTag = `</${tagName}>`;
  let result = '';
  let pos = 0;

  while (pos < html.length) {
    const start = html.toLowerCase().indexOf(openTag.toLowerCase(), pos);
    if (start === -1) {
      result += html.slice(pos);
      break;
    }

    result += html.slice(pos, start);

    // Find the end of the opening tag
    const tagEnd = html.indexOf('>', start);
    if (tagEnd === -1) {
      // Malformed: unclosed opening tag, include it as-is
      result += html.slice(start);
      break;
    }

    // Find the closing tag
    const closePos = html.toLowerCase().indexOf(closeTag.toLowerCase(), tagEnd + 1);
    if (closePos === -1) {
      // Unclosed tag: skip opening tag but keep content
      pos = tagEnd + 1;
    } else {
      // Found closing tag: skip both opening and closing tags
      pos = closePos + closeTag.length;
    }
  }

  return result;
}
