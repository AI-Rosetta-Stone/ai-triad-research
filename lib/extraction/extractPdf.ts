// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { ActionableError } from '../debate/errors.js';

const MAX_PDF_PAGES = 500;
const PDF_TIME_BUDGET_MS = 15_000;

export interface PdfExtraction {
  text: string;
  warnings: string[];
}

/**
 * Extract text from PDF using pdfjs-dist.
 * Uses lazy import to avoid loading pdfjs until needed.
 * Uses the Node legacy build. pdfjs-dist 6.x has no eval or new Function path (CVE-2024-4367 class),
 * and the isEvalSupported option is gone in 6.x, so there is nothing to disable.
 * Stops after MAX_PDF_PAGES (with a warning) and fails if the whole extraction exceeds PDF_TIME_BUDGET_MS.
 */
export async function extractPdfText(bytes: Uint8Array): Promise<PdfExtraction> {
  const startedAt = Date.now();

  // Lazy import: only load pdfjs when a PDF arrives
  // Use dynamic import to avoid issues with legacy/main build variant resolution
  const pdfjsModule = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { getDocument } = pdfjsModule;

  const pdf = await getDocument({ data: bytes }).promise;

  const warnings: string[] = [];
  const pageCount = Math.min(pdf.numPages, MAX_PDF_PAGES);
  if (pdf.numPages > MAX_PDF_PAGES) {
    const message = `PDF has ${pdf.numPages} pages; extracted only the first ${MAX_PDF_PAGES}`;
    console.warn(`WARN: ${message}`);
    warnings.push(message);
  }

  const texts: string[] = [];

  for (let i = 1; i <= pageCount; i++) {
    if (Date.now() - startedAt > PDF_TIME_BUDGET_MS) {
      throw new ActionableError({
        goal: 'Extract text from PDF',
        problem: `PDF extraction exceeded the ${PDF_TIME_BUDGET_MS / 1000} s time budget after ${i - 1} of ${pageCount} pages`,
        location: 'lib/extraction:extractPdfText',
        nextSteps: ['Try a smaller PDF', 'Export the document as plain text or DOCX'],
        code: 'EXTRACTION_FAILED',
        httpStatus: 422,
      });
    }
    try {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items
        .filter((item: any) => 'str' in item)
        .map((item: any) => item.str)
        .join('');
      texts.push(pageText);
    } catch (e: any) {
      // Propagate PasswordException for encrypted PDFs
      if (e.name === 'PasswordException') {
        throw e;
      }
      // Log other errors but continue extracting from other pages
      console.warn(`Failed to extract page ${i}:`, e.message);
    }
  }

  return { text: texts.join('\n'), warnings };
}
