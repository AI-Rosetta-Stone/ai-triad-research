// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

export type DocumentFormat = 'pdf' | 'docx' | 'txt' | 'md' | 'html';

/**
 * Detect document format from magic bytes.
 * Prioritizes magic bytes over extension to prevent spoofing.
 */
export function detectFormat(bytes: Uint8Array): DocumentFormat {
  if (bytes.length < 2) {
    throw new Error('File too small to detect format');
  }

  // PDF: %PDF (0x25 0x50 0x44 0x46)
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    return 'pdf';
  }

  // ZIP (DOCX is ZIP with [Content_Types].xml and word/document.xml)
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    // 0x50 0x4b = 'PK'
    return 'docx';
  }

  // Try to decode as text to detect HTML/MD/TXT
  const text = decodeText(bytes);

  // HTML: <!DOCTYPE, <html>, or <?xml
  if (
    /^\s*<!DOCTYPE\s/i.test(text) ||
    /^\s*<html/i.test(text) ||
    /^\s*<\?xml/i.test(text)
  ) {
    return 'html';
  }

  // MD: heuristics (frontmatter, headers, common markdown patterns)
  if (isMarkdown(text)) {
    return 'md';
  }

  // TXT: fallback for plain text
  return 'txt';
}

/**
 * Attempt to decode bytes as UTF-8 or UTF-16.
 * Falls back to UTF-8 with replacement characters if decoding fails.
 */
function decodeText(bytes: Uint8Array): string {
  // Check for UTF-16 BOM
  if (bytes.length >= 2) {
    // UTF-16 LE BOM: 0xFF 0xFE
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      try {
        return new TextDecoder('utf-16le').decode(bytes.slice(2));
      } catch {
        // Fall through
      }
    }
    // UTF-16 BE BOM: 0xFE 0xFF
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      try {
        return new TextDecoder('utf-16be').decode(bytes.slice(2));
      } catch {
        // Fall through
      }
    }
  }

  // Try UTF-8 (with replacement for invalid sequences)
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    // Fallback: use utf-8 with replacements
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
}

/**
 * Heuristic detection for Markdown format.
 * Looks for common Markdown markers.
 */
function isMarkdown(text: string): boolean {
  const lines = text.split('\n').slice(0, 20); // Check first 20 lines

  for (const line of lines) {
    // YAML frontmatter
    if (line === '---') {
      return true;
    }

    // Markdown headers
    if (/^\#+\s/.test(line)) {
      return true;
    }

    // Markdown lists
    if (/^[-*+]\s/.test(line) || /^\d+\.\s/.test(line)) {
      return true;
    }

    // Code fences
    if (/^```/.test(line)) {
      return true;
    }

    // Bold/italic
    if (/\*\*|__|\*|_|~~/.test(line)) {
      return true;
    }

    // Links
    if (/\[.*\]\(.*\)/.test(line)) {
      return true;
    }
  }

  return false;
}
