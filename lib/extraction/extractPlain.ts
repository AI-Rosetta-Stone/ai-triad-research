// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Extract text from plain text files (TXT, MD).
 * Handles UTF-8 and UTF-16 with BOM detection.
 */
export function extractPlainText(bytes: Uint8Array): string {
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

  // UTF-8 (with replacement for invalid sequences)
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}
