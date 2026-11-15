// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/426: the plain-text decoder is plain JavaScript in isolated/textCore.mjs, so the isolated child can run it. This
// module re-exports it for in-process callers and tests.

import { plainTextFromBytes } from './isolated/textCore.mjs';

/**
 * Extract text from plain text files (TXT, MD). Handles UTF-8 and UTF-16 with BOM detection.
 * Document extraction runs this in the isolated child instead (t/426).
 */
export function extractPlainText(bytes: Uint8Array): string {
  return plainTextFromBytes(bytes);
}
