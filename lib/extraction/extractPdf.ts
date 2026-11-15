// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { parseIsolated } from './isolatedParse.js';

export interface PdfExtraction {
  text: string;
  warnings: string[];
}

/**
 * Extract text from a PDF in an isolated child process (t/393). The page cap, the page warnings and the encrypted-PDF
 * mapping are in isolated/parseCore.mjs; the 15 s hard kill and the heap ceiling are in isolatedParse.ts.
 * pdfjs-dist 6.x has no eval or new Function path (CVE-2024-4367 class), so there is no eval option to disable.
 */
export async function extractPdfText(bytes: Uint8Array): Promise<PdfExtraction> {
  const { text, warnings } = await parseIsolated('pdf', bytes);
  return { text, warnings };
}
