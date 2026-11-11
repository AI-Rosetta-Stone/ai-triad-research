// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

export type DocumentFormat = 'pdf' | 'docx' | 'txt' | 'md' | 'html' | 'unsupported';

/**
 * Detect document format from magic bytes and structure validation.
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

  // ZIP (PK magic bytes: 0x50 0x4b)
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    // Not all ZIPs are DOCX - validate DOCX structure
    // DOCX must contain [Content_Types].xml (required by spec)
    if (isValidDocx(bytes)) {
      return 'docx';
    }
    // Otherwise, it's an unsupported ZIP format
    return 'unsupported';
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
 * Validate that a ZIP file is actually a DOCX by checking for required DOCX structure.
 * A DOCX is a ZIP that must contain [Content_Types].xml at the root.
 */
function isValidDocx(bytes: Uint8Array): boolean {
  if (bytes.length < 30) {
    return false;
  }

  // Search for [Content_Types].xml in the ZIP
  // It's typically near the beginning as the first file in the archive
  const searchStr = '[Content_Types].xml';
  const searchBytes = new TextEncoder().encode(searchStr);

  // Check first 10KB for [Content_Types].xml filename
  const searchLimit = Math.min(10000, bytes.length);
  for (let i = 0; i < searchLimit - searchBytes.length; i++) {
    let match = true;
    for (let j = 0; j < searchBytes.length; j++) {
      if (bytes[i + j] !== searchBytes[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      return true;
    }
  }

  return false;
}

/**
 * Detect if text looks like Markdown.
 * Heuristics: frontmatter, headers, lists, code blocks, etc.
 */
function isMarkdown(text: string): boolean {
  // YAML frontmatter
  if (text.startsWith('---\n')) {
    return true;
  }

  // Markdown headers
  if (/^\s*#{1,6}\s+/m.test(text)) {
    return true;
  }

  // Unordered lists
  if (/^\s*[-*+]\s+/m.test(text)) {
    return true;
  }

  // Ordered lists
  if (/^\s*\d+\.\s+/m.test(text)) {
    return true;
  }

  // Code blocks (fenced)
  if (/```/m.test(text)) {
    return true;
  }

  // Links and images
  if (/\[.+\]\(.+\)/.test(text)) {
    return true;
  }

  return false;
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
