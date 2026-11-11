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

  it('decodes named, decimal and hex character references once', () => {
    const html =
      'Tom &amp; Jerry &lt;3 &quot;hi&quot; &#39;x&#39; &#x41;&#66; caf&nbsp;e &amp;lt; ' +
      '&unknown; &#99999999; &#xD800; &#0;';
    expect(extractHtmlText(encode(html))).toBe(
      `Tom & Jerry <3 "hi" 'x' AB caf e &lt; &unknown; &#99999999; &#xD800; &#0;`
    );
  });

  it('handles 100k "&" with no ";" in linear time', () => {
    const bytes = encode('&#'.repeat(50_000) + '&'.repeat(50_000));
    const start = performance.now();
    extractHtmlText(bytes);
    expect(performance.now() - start).toBeLessThan(1000);
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
