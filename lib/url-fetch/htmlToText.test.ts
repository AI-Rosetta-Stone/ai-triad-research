// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/390: URL mode's HTML-to-text is linear. The regex chain it replaced took quadratic time on unclosed tags, and a
// fetched page is attacker-controlled. The slow cases below each finish well under a second now.

import { describe, it, expect } from 'vitest';
import { htmlToText } from './fetchUrlForPrompt.js';

/** Runs `fn` and returns how long it took, in milliseconds. */
async function timed(fn: () => Promise<unknown>): Promise<number> {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}

describe('htmlToText is linear on attacker-controlled HTML (t/390)', () => {
  it('100k "<" with no ">" completes in under 1 s', async () => {
    expect(await timed(() => htmlToText('<'.repeat(100_000)))).toBeLessThan(1000);
  });

  it('25k unclosed <script> tags complete in under 1 s', async () => {
    expect(await timed(() => htmlToText('<script>x'.repeat(25_000)))).toBeLessThan(1000);
  });

  it('25k unclosed <head> tags complete in under 1 s', async () => {
    expect(await timed(() => htmlToText('<head>x'.repeat(25_000)))).toBeLessThan(1000);
  });

  it('25k unclosed <style> and <br tags complete in under 1 s', async () => {
    expect(await timed(() => htmlToText('<style>x<br'.repeat(12_500)))).toBeLessThan(1000);
  });

  it('25k "<title" tags with no ">" complete in under 1 s', async () => {
    expect(await timed(() => htmlToText('<title'.repeat(25_000)))).toBeLessThan(1000);
  });
});

describe('htmlToText keeps what URL mode needs', () => {
  it('keeps paragraph breaks from block closers and <br>', async () => {
    expect((await htmlToText('<p>One</p><p>Two<br>Three</p>')).text).toBe('One\nTwo\nThree');
  });

  it('drops script, style and head contents, but keeps <header> text', async () => {
    const html = '<head><title>T</title></head><header>Keep</header><script>var x=1;</script><style>p{}</style>Body';
    const { text } = await htmlToText(html);
    expect(text).toContain('Keep');
    expect(text).toContain('Body');
    expect(text).not.toContain('var x');
    expect(text).not.toContain('p{}');
  });

  it('reads the document title and decodes entities once', async () => {
    const { title, text } = await htmlToText('<title>Tom &amp; Jerry</title><p>&lt;b&gt; &amp;lt;</p>');
    expect(title).toBe('Tom & Jerry');
    // The title text stays in the body, as the converter it replaces did.
    expect(text).toBe('Tom & Jerry <b> &lt;');
  });

  it('returns no title when there is none', async () => {
    expect((await htmlToText('<p>no title here</p>')).title).toBeUndefined();
  });
});
