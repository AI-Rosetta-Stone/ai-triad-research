// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/426: the HTML converter is plain JavaScript in isolated/textCore.mjs, so the isolated child can run it. This module
// keeps the in-process entry point for callers and tests. Untrusted HTML goes through the child (extractDocumentText.ts).

import { decodeEntities, htmlTextFromBytes } from './isolated/textCore.mjs';

// t/390: the linear URL-mode converter and title reader live in the same plain-JS core (one implementation).
export { htmlToTextLinear, htmlTitleLinear } from './isolated/textCore.mjs';

/** Decode character references once (exported for the URL-mode converter; see decodeEntities in textCore.mjs). */
export function decodeHtmlEntities(s: string): string {
  return decodeEntities(s);
}

/** HTML bytes to plain text, in-process. Document extraction runs this in the isolated child instead (t/426). */
export function extractHtmlText(bytes: Uint8Array): string {
  return htmlTextFromBytes(bytes);
}
