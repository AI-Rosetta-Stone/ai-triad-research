// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect } from 'vitest';
import { extractHtmlText } from './extractHtml.js';
import { extractDocumentText } from './extractDocumentText.js';

const encode = (s: string) => new TextEncoder().encode(s);

describe('HTML extraction', () => {
  it('extracts a normal small HTML document through extractDocumentText (missing-break regression)', async () => {
    const html =
      '<!DOCTYPE html><html><head><title>Ignored</title><style>p{color:red}</style></head>' +
      '<body><p>Hello <b>world</b></p><header>Top</header></body></html>';
    const result = await extractDocumentText(encode(html), 'page.html');
    expect(result.format).toBe('html');
    expect(result.text).toBe('Hello world Top');
  });

  it('drops only <head>, not <header>', () => {
    expect(extractHtmlText(encode('<header>Keep me</header><head>Drop me</head>'))).toBe('Keep me');
  });

  it('handles 100k "<" with no ">" in linear time', () => {
    const bytes = encode('<'.repeat(100_000));
    const start = performance.now();
    extractHtmlText(bytes);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it('handles many unclosed <script> tags in linear time', () => {
    const bytes = encode('<script>x'.repeat(25_000));
    const start = performance.now();
    extractHtmlText(bytes);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
