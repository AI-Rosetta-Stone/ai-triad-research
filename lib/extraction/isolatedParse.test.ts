// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/393 (TL t/393#3): the isolated child process. Four tests, as the ticket lists them:
//   1. a worst-ratio 5 MB XML part stays inside the child's heap ceiling;
//   2. Quality's 151 KB bomb is refused, and the parent's memory does not move;
//   3. a child that runs out of memory yields EXTRACTION_MEMORY_LIMIT, and the parent stays up;
//   4. a parse that never returns is killed at about 15 s.

import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { parseIsolated, runChildForTests, resolveFromModule, CHILD_HEAP_MB, ISOLATED_TIMEOUT_MS } from './isolatedParse.js';
import { extractDocumentText } from './extractDocumentText.js';

const SPIN_CHILD = resolveFromModule('./isolated/__fixtures__/spin-child.mjs');
const OOM_CHILD = resolveFromModule('./isolated/__fixtures__/oom-child.mjs');

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '</Types>';

const RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '</Relationships>';

/** A DOCX whose document part is `paragraphs` empty paragraphs: tiny when deflated, large to parse. */
async function docxWithParagraphs(paragraphs: number, extraParts: Record<string, string> = {}): Promise<Uint8Array> {
  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    '<w:p/>'.repeat(paragraphs) +
    '</w:body></w:document>';
  const zip = new JSZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.file('_rels/.rels', RELS);
  zip.file('word/document.xml', documentXml);
  for (const [name, xml] of Object.entries(extraParts)) zip.file(name, xml);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

describe('isolated parse (t/393)', () => {
  it('1. a worst-ratio XML part just under the 5 MB cap stays inside the child heap ceiling', async () => {
    // 4.9 MB of "<w:p/>": under the per-part cap, so the parent hands it to the child. The child must either parse it
    // inside its ceiling, or be stopped by the ceiling. It must never take the parent down.
    const bytes = await docxWithParagraphs(Math.floor((4.9 * 1024 * 1024) / 6));
    const outcome = await extractDocumentText(bytes, 'worst.docx').then(
      (result) => ({ ok: true as const, result }),
      (error) => ({ ok: false as const, error }),
    );
    if (outcome.ok) {
      expect(outcome.result.format).toBe('docx');
    } else {
      expect(outcome.error.code).toBe('EXTRACTION_MEMORY_LIMIT');
    }
    expect(CHILD_HEAP_MB).toBe(256);
  }, 120_000);

  it("2. Quality's 151 KB bomb (19 MB document, 15 MB footnotes, 15 MB endnotes) is refused with the parent's memory unchanged", async () => {
    const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    const part = (root: string, paragraphs: number) => `<?xml version="1.0"?><w:${root} ${NS}>${'<w:p/>'.repeat(paragraphs)}</w:${root}>`;
    const zip = new JSZip();
    zip.file('[Content_Types].xml', CONTENT_TYPES);
    zip.file('_rels/.rels', RELS);
    zip.file('word/document.xml', part('document', 3_200_000)); // about 19 MB of XML
    zip.file('word/footnotes.xml', part('footnotes', 2_500_000)); // about 15 MB
    zip.file('word/endnotes.xml', part('endnotes', 2_500_000)); // about 15 MB
    const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    expect(bytes.length).toBeLessThan(160 * 1024); // the compressed bomb is small, as Quality measured

    const before = process.memoryUsage().rss;
    const started = performance.now();
    const err = await extractDocumentText(bytes, 'quality-bomb.docx').catch((e) => e);
    const elapsed = performance.now() - started;
    const growthMb = (process.memoryUsage().rss - before) / 1024 / 1024;

    expect(err.code).toBe('SIZE_LIMIT_EXCEEDED');
    expect(err.message).toContain('XML part');
    expect(growthMb).toBeLessThan(200);
    expect(elapsed).toBeLessThan(30_000);
  }, 120_000);

  it('3. a child that runs out of memory yields EXTRACTION_MEMORY_LIMIT, and the parent stays up', async () => {
    const err = await runChildForTests(OOM_CHILD, 'pdf', new Uint8Array([0x25, 0x50, 0x44, 0x46])).catch((e) => e);
    // Reaching this line means the parent survived the child's out-of-memory death.
    expect(err.code).toBe('EXTRACTION_MEMORY_LIMIT');
  }, 120_000);

  it('4. a parse that never returns is killed at about 15 s', async () => {
    expect(ISOLATED_TIMEOUT_MS).toBe(15_000);
    const started = performance.now();
    const err = await runChildForTests(SPIN_CHILD, 'pdf', new Uint8Array([0x25, 0x50, 0x44, 0x46])).catch((e) => e);
    const elapsed = performance.now() - started;
    expect(err.code).toBe('EXTRACTION_TIMEOUT');
    expect(elapsed).toBeGreaterThan(14_000);
    expect(elapsed).toBeLessThan(20_000);
  }, 60_000);
});

// Security p/102#81: the child runs untrusted files, so it must not see the server's environment, must work in an empty
// directory, and must not read files outside its sandbox. The probe child reports what it can see.
describe('isolated parse sandbox (Security p/102#81)', () => {
  const PROBE_CHILD = resolveFromModule('./isolated/__fixtures__/probe-child.mjs');
  const OVERSIZE_CHILD = resolveFromModule('./isolated/__fixtures__/oversize-child.mjs');

  it('the child gets no server environment: a sentinel variable is unreachable', async () => {
    process.env.T393_SENTINEL = 'server-secret';
    try {
      const { text } = await runChildForTests(PROBE_CHILD, 'pdf', new TextEncoder().encode(join(tmpdir(), 'no-such-file')));
      const report = JSON.parse(text);
      expect(report.sentinelSeen).toBe(false);
      // The child gets only what the OS adds to a child with an empty environment (on Windows). None of the server's
      // variables crosses, and no key with a secret-looking name appears at all.
      const WINDOWS_DEFAULTS = [
        'HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'PATH', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERDOMAIN',
        'USERNAME', 'USERPROFILE', 'WINDIR',
      ];
      const allowed = process.platform === 'win32' ? WINDOWS_DEFAULTS : [];
      const unexpected = report.envKeys.filter((k: string) => !allowed.includes(k));
      expect(unexpected).toEqual([]);
      expect(report.envKeys.filter((k: string) => /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|^AI_|^T393_/i.test(k))).toEqual([]);
    } finally {
      delete process.env.T393_SENTINEL;
    }
  }, 60_000);

  it('the child runs in an empty temporary directory of its own, not the server working directory', async () => {
    const { text } = await runChildForTests(PROBE_CHILD, 'pdf', new TextEncoder().encode(join(tmpdir(), 'no-such-file')));
    const report = JSON.parse(text);
    expect(report.cwd.startsWith(tmpdir())).toBe(true);
    expect(basename(report.cwd).startsWith('t393-')).toBe(true);
    expect(report.cwd).not.toBe(process.cwd());
    // The working directory is removed after the parse.
    expect(existsSync(report.cwd)).toBe(false);
  }, 60_000);

  it('a file outside the sandbox is unreachable from the child (permission model)', async () => {
    const outside = join(tmpdir(), `t393-outside-${process.pid}-${Date.now()}.txt`);
    writeFileSync(outside, 'server-only contents');
    try {
      const { text } = await runChildForTests(PROBE_CHILD, 'pdf', new TextEncoder().encode(outside));
      expect(JSON.parse(text).outsideReadable).toBe(false);
    } finally {
      rmSync(outside, { force: true });
    }
  }, 60_000);

  // Security p/232#18: the child must not write, spawn a process, or open a network connection.
  it('the child cannot write a file, spawn a process, or open a network connection', async () => {
    const ESCAPE_CHILD = resolveFromModule('./isolated/__fixtures__/escape-probe-child.mjs');
    const target = join(tmpdir(), `t393-escape-${process.pid}-${Date.now()}.txt`);
    try {
      const { text } = await runChildForTests(ESCAPE_CHILD, 'pdf', new TextEncoder().encode(target));
      const report = JSON.parse(text);
      expect(report.write).toBe('ERR_ACCESS_DENIED');
      expect(report.writeCwd).toBe('ERR_ACCESS_DENIED');
      expect(report.spawn).toBe('ERR_ACCESS_DENIED');
      expect(report.net).toBe('ERR_ACCESS_DENIED');
      expect(existsSync(target)).toBe(false);
    } finally {
      rmSync(target, { force: true });
    }
  }, 60_000);

  it('a reply over the text limit is refused by the parent', async () => {
    const err = await runChildForTests(OVERSIZE_CHILD, 'pdf', new Uint8Array([0x25])).catch((e) => e);
    expect(err.code).toBe('EXTRACTION_FAILED');
    expect(err.problem).toMatch(/more text than the limit/);
  }, 60_000);
});
