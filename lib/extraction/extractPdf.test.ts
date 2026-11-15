// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/393: the PDF page logic lives in isolated/parseCore.mjs and runs inside the child process. These tests exercise that
// logic in-process with a stub getDocument, so page counts and timing are deterministic. The process-level behaviour
// (the hard kill, the heap ceiling) is in isolatedParse.test.ts.

import { describe, it, expect } from 'vitest';
import { parsePdf, MAX_PDF_PAGES, PDF_TIME_BUDGET_MS, PDF_MEMORY_BUDGET_BYTES, ParseError } from './isolated/parseCore.mjs';
import { extractDocumentText } from './extractDocumentText.js';

/** A stub pdfjs document with `numPages` pages whose text is "page <n>". */
function stubDocument(numPages: number) {
  return {
    memory: () => 0, // the test process's own memory is not the parse's; the memory check has its own test below
    getDocument: () => ({
      promise: Promise.resolve({
        numPages,
        getPage: async (n: number) => ({
          getTextContent: async () => ({ items: [{ str: `page ${n}` }] }),
        }),
      }),
    }),
  };
}

const pdfBytes = () => new TextEncoder().encode('%PDF-1.4 stub');

describe('PDF page logic (parseCore)', () => {
  it('extracts every page of a short PDF with no warnings', async () => {
    const result = await parsePdf(pdfBytes(), stubDocument(3));
    expect(result.text).toBe('page 1\npage 2\npage 3');
    expect(result.warnings).toEqual([]);
  });

  it('stops at the page cap and warns', async () => {
    expect(MAX_PDF_PAGES).toBe(500);
    const result = await parsePdf(pdfBytes(), stubDocument(600));
    expect(result.text).toContain('page 500');
    expect(result.text).not.toContain('page 501');
    expect(result.warnings.some((w) => w.includes('600') && w.includes('500'))).toBe(true);
  });

  it('fails with a TIMEOUT ParseError when the time budget is spent between pages', async () => {
    // Each clock read advances 1 s, so the budget runs out after about 15 pages.
    let now = 0;
    const clock = () => (now += 1000);
    const err = await parsePdf(pdfBytes(), { ...stubDocument(100), now: clock }).catch((e) => e);
    expect(err).toBeInstanceOf(ParseError);
    expect(err.code).toBe('TIMEOUT');
    expect(err.message).toMatch(/time budget/);
    expect(PDF_TIME_BUDGET_MS).toBe(15_000);
  });

  it('fails with a MEMORY ParseError when the parse holds more than the memory budget between pages', async () => {
    const err = await parsePdf(pdfBytes(), { ...stubDocument(50), memory: () => PDF_MEMORY_BUDGET_BYTES + 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(ParseError);
    expect(err.code).toBe('MEMORY');
    expect(err.message).toMatch(/MB/);
  });

  it('rethrows a PasswordException so an encrypted PDF is recognised', async () => {
    const encrypted = {
      memory: () => 0,
      getDocument: () => ({
        promise: Promise.reject(Object.assign(new Error('No password given'), { name: 'PasswordException' })),
      }),
    };
    const err = await parsePdf(pdfBytes(), encrypted).catch((e) => e);
    expect(err.name).toBe('PasswordException');
  });

  it('turns a failing page into a warning and keeps the other pages', async () => {
    const flaky = {
      memory: () => 0,
      getDocument: () => ({
        promise: Promise.resolve({
          numPages: 2,
          getPage: async (n: number) => {
            if (n === 1) throw new Error('broken page');
            return { getTextContent: async () => ({ items: [{ str: 'ok' }] }) };
          },
        }),
      }),
    };
    const result = await parsePdf(pdfBytes(), flaky);
    expect(result.text).toBe('ok');
    expect(result.warnings.some((w) => w.includes('page 1'))).toBe(true);
  });
});

describe('PDF through the isolated child (extractDocumentText)', () => {
  it('a stub that is not a real PDF is refused as a failed extraction, not a crash', async () => {
    const err = await extractDocumentText(pdfBytes(), 'stub.pdf').catch((e) => e);
    expect(err.code).toBe('EXTRACTION_FAILED');
  });
});
