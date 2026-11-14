// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/393: the parse logic that runs inside the isolated child process (child.mjs). It is plain JavaScript with no
// imports, so the child can run it without a TypeScript loader, and tests can run it in-process with a stub parser.
// The parent (../isolatedParse.ts) owns the process: fork, the heap ceiling, the hard kill and the error mapping.

export const MAX_PDF_PAGES = 500;
// Checked between pages as defence in depth. The hard kill in the parent is the real bound (a single page can hang).
export const PDF_TIME_BUDGET_MS = 15_000;

/** An error with a code the parent maps to an ActionableError. */
export class ParseError extends Error {
  /** @param {string} code  'TIMEOUT' | 'FAILED' */
  constructor(code, message) {
    super(message);
    this.name = 'ParseError';
    this.code = code;
  }
}

/**
 * Extract text from a PDF. Pages that fail are reported as warnings, not thrown, except an encrypted PDF.
 * @param {Uint8Array} bytes
 * @param {{ getDocument: (opts: object) => { promise: Promise<any> }, now?: () => number }} deps
 * @returns {Promise<{ text: string, warnings: string[] }>}
 */
export async function parsePdf(bytes, { getDocument, now = Date.now }) {
  const startedAt = now();
  const pdf = await getDocument({ data: bytes }).promise;

  const warnings = [];
  const pageCount = Math.min(pdf.numPages, MAX_PDF_PAGES);
  if (pdf.numPages > MAX_PDF_PAGES) {
    warnings.push(`PDF has ${pdf.numPages} pages; extracted only the first ${MAX_PDF_PAGES}`);
  }

  const texts = [];
  for (let i = 1; i <= pageCount; i++) {
    if (now() - startedAt > PDF_TIME_BUDGET_MS) {
      throw new ParseError(
        'TIMEOUT',
        `PDF extraction exceeded the ${PDF_TIME_BUDGET_MS / 1000} s time budget after ${i - 1} of ${pageCount} pages`,
      );
    }
    try {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      texts.push(content.items.filter((item) => 'str' in item).map((item) => item.str).join(''));
    } catch (e) {
      // A PasswordException is the encrypted-PDF signal, and the whole document fails with it.
      if (e?.name === 'PasswordException') throw e;
      warnings.push(`Failed to extract page ${i}: ${e?.message ?? e}`);
    }
  }
  return { text: texts.join('\n'), warnings };
}

/**
 * Extract text from a DOCX that the parent has already bounded (see extractDocx.ts). mammoth runs here, so its
 * memory use is inside the child's heap ceiling.
 * @param {Uint8Array} bytes
 * @param {{ extractRawText: (opts: { buffer: Buffer }) => Promise<{ value: string }> }} deps
 * @returns {Promise<{ text: string, warnings: string[] }>}
 */
export async function parseDocx(bytes, { extractRawText }) {
  // mammoth's Node entry reads `buffer`; `arrayBuffer` is browser-only.
  const result = await extractRawText({ buffer: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) });
  return { text: result.value, warnings: [] };
}
