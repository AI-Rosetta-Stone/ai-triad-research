// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Extract text from PDF using pdfjs-dist.
 * Uses lazy import to avoid loading pdfjs until needed.
 * Uses Node legacy build with eval disabled per CVE-2024-4367.
 */
export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  // Lazy import: only load pdfjs when a PDF arrives
  // Use dynamic import to avoid issues with legacy/main build variant resolution
  const pdfjsModule = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { getDocument } = pdfjsModule;

  // Use Node legacy build with no worker and eval disabled per TL spec
  const pdf = await getDocument({
    data: bytes,
    isEvalSupported: false,
  }).promise;

  const texts: string[] = [];

  for (let i = 1; i <= pdf.numPages; i++) {
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

  return texts.join('\n');
}
