// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { extractDocumentText } from './extractDocumentText.js';

// pdfjs is replaced with a stub so page count and timing are deterministic.
const pdfStub = vi.hoisted(() => ({ numPages: 0, getPageCalls: 0 }));

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: pdfStub.numPages,
      getPage: async (n: number) => {
        pdfStub.getPageCalls++;
        return { getTextContent: async () => ({ items: [{ str: `page ${n}` }] }) };
      },
    }),
  }),
}));

const pdfBytes = () => new TextEncoder().encode('%PDF-1.4 stub');

describe('PDF extraction', () => {
  beforeEach(() => {
    pdfStub.numPages = 0;
    pdfStub.getPageCalls = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('extracts every page of a short PDF with no warnings', async () => {
    pdfStub.numPages = 3;
    const result = await extractDocumentText(pdfBytes(), 'short.pdf');
    expect(result.text).toBe('page 1\npage 2\npage 3');
    expect(result.warnings).toEqual([]);
  });

  it('stops at 500 pages and warns', async () => {
    pdfStub.numPages = 600;
    const result = await extractDocumentText(pdfBytes(), 'long.pdf');
    expect(pdfStub.getPageCalls).toBe(500);
    expect(result.text).toContain('page 500');
    expect(result.text).not.toContain('page 501');
    expect(result.warnings.some((w) => w.includes('600') && w.includes('500'))).toBe(true);
  });

  it('fails with a clear error when the 15 s time budget is spent', async () => {
    pdfStub.numPages = 100;
    // Each clock read advances 1 s, so the budget runs out after about 15 pages.
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 1000));

    const err = await extractDocumentText(pdfBytes(), 'slow.pdf').catch((e) => e);
    expect(err.code).toBe('EXTRACTION_FAILED');
    expect(err.problem).toMatch(/time budget/);
    expect(pdfStub.getPageCalls).toBeLessThan(100);
  });
});
