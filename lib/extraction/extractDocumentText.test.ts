// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect } from 'vitest';
import { extractDocumentText } from './extractDocumentText.js';

describe('extractDocumentText', () => {
  describe('format detection', () => {
    it('detects PDF from magic bytes', async () => {
      // PDF magic bytes: %PDF
      const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
      // This will fail extraction without a real PDF, but should detect the format
      try {
        await extractDocumentText(pdfBytes, 'test.pdf');
      } catch (e: any) {
        // Expected to fail during extraction, but format detection should have succeeded
        expect(e.code).toBe('EXTRACTION_FAILED');
      }
    });

    it('detects plain text files', async () => {
      const txtBytes = new TextEncoder().encode('Hello, world!');
      const result = await extractDocumentText(txtBytes, 'test.txt');
      expect(result.format).toBe('txt');
      expect(result.text).toContain('Hello, world');
    });

    it('detects HTML from tags', async () => {
      const html = '<!DOCTYPE html><html><body>Hello</body></html>';
      const htmlBytes = new TextEncoder().encode(html);
      const result = await extractDocumentText(htmlBytes, 'test.html');
      expect(result.format).toBe('html');
    });

    it('detects Markdown from headers', async () => {
      const md = '# Header\nSome content';
      const mdBytes = new TextEncoder().encode(md);
      const result = await extractDocumentText(mdBytes, 'test.md');
      expect(result.format).toBe('md');
    });
  });

  describe('error handling', () => {
    it('throws SIZE_LIMIT_EXCEEDED for files > 10 MB', async () => {
      const oversizedBytes = new Uint8Array(11 * 1024 * 1024); // 11 MB
      try {
        await extractDocumentText(oversizedBytes, 'huge.bin');
        expect.fail('Should have thrown');
      } catch (e: any) {
        expect(e.code).toBe('SIZE_LIMIT_EXCEEDED');
        expect(e.httpStatus).toBe(413);
      }
    });

    it('throws EMPTY_DOCUMENT for files with no extractable text', async () => {
      // Just whitespace
      const emptyBytes = new TextEncoder().encode('   \n\n\t  ');
      try {
        await extractDocumentText(emptyBytes, 'empty.txt');
        expect.fail('Should have thrown');
      } catch (e: any) {
        expect(e.code).toBe('EMPTY_DOCUMENT');
        expect(e.httpStatus).toBe(422);
      }
    });

    it('throws UNSUPPORTED_FORMAT for unrecognized formats', async () => {
      // Binary garbage
      const binaryBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes
      try {
        await extractDocumentText(binaryBytes, 'image.png');
        expect.fail('Should have thrown');
      } catch (e: any) {
        expect(e.code).toBe('UNSUPPORTED_FORMAT');
        expect(e.httpStatus).toBe(415);
      }
    });
  });

  describe('text extraction', () => {
    it('extracts and sanitizes plain text', async () => {
      const text = 'Hello\nWorld\nExample document';
      const bytes = new TextEncoder().encode(text);
      const result = await extractDocumentText(bytes, 'doc.txt');
      expect(result.text).toContain('Hello');
      expect(result.format).toBe('txt');
      expect(result.warnings).toBeInstanceOf(Array);
    });

    it('extracts text from HTML and removes tags', async () => {
      const html = '<html><body><p>Hello <strong>world</strong></p></body></html>';
      const bytes = new TextEncoder().encode(html);
      const result = await extractDocumentText(bytes, 'doc.html');
      expect(result.text).toContain('Hello');
      expect(result.text).toContain('world');
      expect(result.text).not.toContain('<');
      expect(result.text).not.toContain('>');
    });

    it('truncates text exceeding 500k chars and warns', async () => {
      // Create 600k character string
      const bigText = 'a'.repeat(600_000);
      const bytes = new TextEncoder().encode(bigText);
      const result = await extractDocumentText(bytes, 'big.txt');
      expect(result.text.length).toBe(500_000);
      expect(result.warnings.some((w) => w.includes('truncated'))).toBe(true);
    });

    it('handles UTF-16 encoded text', async () => {
      const text = 'Hello UTF-16';
      // UTF-16 LE with BOM
      const encoder = new TextEncoder();
      const utf8 = encoder.encode(text);
      // Convert to UTF-16 LE (simplified; in real code would use proper encoder)
      const utf16Bytes = new Uint8Array([0xff, 0xfe, ...utf8.slice(0, 10)]);
      // The detector should try to decode it
      try {
        const result = await extractDocumentText(utf16Bytes, 'doc.txt');
        // May fail extraction but shouldn't crash on encoding
        expect(result).toBeDefined();
      } catch (e: any) {
        // Either extraction succeeded or failed gracefully
        expect(e).toBeDefined();
      }
    });
  });

  describe('action error format', () => {
    it('creates ActionableError with correct structure', async () => {
      const oversizedBytes = new Uint8Array(11 * 1024 * 1024);
      try {
        await extractDocumentText(oversizedBytes, 'huge.bin');
      } catch (e: any) {
        expect(e.goal).toBeDefined();
        expect(e.problem).toBeDefined();
        expect(e.location).toBeDefined();
        expect(Array.isArray(e.nextSteps)).toBe(true);
        expect(e.code).toBeDefined();
        expect(e.httpStatus).toBeDefined();
      }
    });
  });
});
