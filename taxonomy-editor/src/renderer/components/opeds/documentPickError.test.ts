// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/632 (Design p/25#159): a failed document pick never shows Electron's IPC wrapper, an ActionableError dump or a
// path. An app fault says so instead of blaming the file; a cause in the file keeps the file's line.
import { describe, it, expect } from 'vitest';
import { documentPickErrorLine, appFaultLine, SCANNED_PDF_LINE } from './documentPickError';
import { fileNameOf } from './NewOpEdSource';

describe('t/632: fileNameOf (the chip and sourceName never carry a path)', () => {
  it.each([
    ['C:\\Users\\someone\\Documents\\brief.pdf', 'brief.pdf'],
    ['/home/someone/docs/brief.docx', 'brief.docx'],
    ['brief.md', 'brief.md'],
    ['', undefined],
    [undefined, undefined],
  ])('%s -> %s', (input, expected) => {
    expect(fileNameOf(input)).toBe(expected);
  });
});

// The exact text the packed desktop app produced in the t/276 live check (path anonymised to the same shape).
const IPC_ENOENT = "Error invoking remote method 'pick-document-file': ActionableError: \n  Goal:     Extract text from PDF document\n  Error:    Failed to extract text from document\n  Inner error: ENOENT, dist\\main\\lib\\node_modules\\pdfjs-dist not found in C:\\Users\\someone\\app\\resources\\app.asar\n  Location: lib/extraction:extract*Text\n  Resolve:\n  1. Verify the document is not corrupted";
const ipc = (problem: string, inner = '') => `Error invoking remote method 'pick-document-file': ActionableError: \n  Goal:     Extract text from PDF document\n  Error:    ${problem}${inner ? `\n  Inner error: ${inner}` : ''}\n  Location: lib/extraction\n  Resolve:\n  1. Try again`;

const PATH_SEGMENT = /[A-Za-z]:\\|\\\\|\/[A-Za-z0-9_.-]+\//;

describe('t/632: documentPickErrorLine', () => {
  it('the live-check failure (parser module missing) is an app fault, not the file', () => {
    const line = documentPickErrorLine(new Error(IPC_ENOENT));
    expect(line).toBe(appFaultLine());
    expect(line).not.toMatch(/scanned PDF/);
  });

  it.each([
    ['Document contains no extractable text', '', 'This file has no readable text.'],
    ['PDF is password-protected or encrypted', '', 'This file is password-protected. Remove the password, then choose it again.'],
    ['Document exceeds 10 MB size limit (12.40 MB)', '', 'This file is over the 10 MB limit.'],
    ['File format is not supported (not a valid DOCX, or an unknown archive or binary type)', '', "This file isn't a supported file type. Choose a PDF, Word (.docx), text or Markdown file."],
    ['Failed to extract text from document', 'Invalid PDF structure', SCANNED_PDF_LINE],
    ['Failed to extract text from document', "Cannot find module 'mammoth'", appFaultLine()],
    ['Failed to extract text from document', 'spawn EPERM', appFaultLine()],
  ])('%s / %s', (problem, inner, expected) => {
    expect(documentPickErrorLine(new Error(ipc(problem, inner)))).toBe(expected);
  });

  it('a plain line (the web bridge already words it) is shown as given', () => {
    const plain = '“brief.pdf” is over the 10 MB limit.';
    expect(documentPickErrorLine(new Error(plain))).toBe(plain);
  });

  it('names the file in the app-fault line when the name is known', () => {
    expect(documentPickErrorLine(new Error(IPC_ENOENT), 'brief.pdf')).toBe('Couldn’t read “brief.pdf” because of a problem in the app, not the file. Try again later, or start from a topic or web page.'.replace('Couldn’t', "Couldn't"));
  });

  it('never shows a path, the IPC wrapper or ActionableError text', () => {
    const inputs = [IPC_ENOENT, ipc('Failed to extract text from document', '/home/someone/x/y'), ipc('Failed', 'C:\\Users\\a\\b'), '', 'Goal: x Resolve: y'];
    for (const input of inputs) {
      const line = documentPickErrorLine(new Error(input));
      expect(line).not.toMatch(PATH_SEGMENT);
      expect(line).not.toMatch(/Error invoking remote method|ActionableError|Goal:|Resolve:|Inner error/);
    }
  });
});
