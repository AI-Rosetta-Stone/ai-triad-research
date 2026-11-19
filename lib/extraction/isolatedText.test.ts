// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/426: HTML and plain text run in the isolated child, like PDF and DOCX. These tests show that the child really
// runs them (the reply carries the child's memory reading), and that a hostile HTML input stays inside the limits.

import { describe, it, expect } from 'vitest';
import { parseIsolated } from './isolatedParse.js';
import { extractDocumentText } from './extractDocumentText.js';

const encode = (s: string) => new TextEncoder().encode(s);

describe('HTML and plain text run in the isolated child (t/426)', () => {
  it('HTML is parsed in the child: the reply carries the child memory reading', async () => {
    const result = await parseIsolated('html', encode('<p>Hello <b>world</b></p>'));
    expect(result.text).toBe('Hello world');
    expect(result.childRss).toBeGreaterThan(0);
  });

  it('plain text is parsed in the child: the reply carries the child memory reading', async () => {
    const result = await parseIsolated('text', encode('Plain text, UTF-8'));
    expect(result.text).toBe('Plain text, UTF-8');
    expect(result.childRss).toBeGreaterThan(0);
  });

  it('UTF-16 with a BOM is decoded in the child', async () => {
    const utf16 = new Uint8Array([0xff, 0xfe, 0x48, 0x00, 0x69, 0x00]); // "Hi" in UTF-16 LE, with BOM
    const result = await parseIsolated('text', utf16);
    expect(result.text).toBe('Hi');
  });

  it('a 10 MB hostile HTML input is either parsed inside the sandbox limits or stopped with a memory error; the parent survives', async () => {
    // Many small elements, unclosed tags and entity runs: the shape that exercised the quadratic paths. 10 MB is the
    // document size limit, so this is the largest input the sandbox can be asked to parse.
    const unit = '<p>x &amp; <b>y <script>z'; // unclosed script in each unit
    // A doctype, so format detection classifies it as HTML rather than plain text.
    const hostile = '<!DOCTYPE html>' + unit.repeat(Math.floor((10 * 1024 * 1024) / unit.length));
    const started = performance.now();
    const outcome = await extractDocumentText(encode(hostile), 'hostile.html').then(
      (r) => ({ ok: true as const, r }),
      (e) => ({ ok: false as const, e }),
    );
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(15_000);
    if (outcome.ok) {
      expect(outcome.r.format).toBe('html');
      expect(outcome.r.text.length).toBeGreaterThan(0);
    } else {
      expect(['EXTRACTION_MEMORY_LIMIT', 'SIZE_LIMIT_EXCEEDED', 'EXTRACTION_FAILED']).toContain(outcome.e.code);
    }
  }, 60_000);
});
