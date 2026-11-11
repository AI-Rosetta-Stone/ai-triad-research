// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { createDeflateRaw } from 'node:zlib';
import { extractDocumentText } from './extractDocumentText.js';

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

function documentXml(body: string, prolog = ''): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${prolog}` +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body><w:p><w:r><w:t>${body}</w:t></w:r></w:p></w:body></w:document>`
  );
}

// JSZip writes no archive comment, so the end-of-central-directory record ends exactly at the last byte.
async function buildDocx(docXml: string): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.file('_rels/.rels', RELS);
  zip.file('word/document.xml', docXml);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

async function innerErrorOf(bytes: Uint8Array): Promise<Error | undefined> {
  try {
    await extractDocumentText(bytes, 'doc.docx');
  } catch (e: any) {
    return e.innerError ?? e;
  }
  return undefined;
}

describe('DOCX zip-bomb guard', () => {
  it('passes a normal DOCX with no archive comment (off-by-one regression)', async () => {
    const bytes = await buildDocx(documentXml('Hello docx'));
    const result = await extractDocumentText(bytes, 'normal.docx');
    expect(result.format).toBe('docx');
    expect(result.text).toContain('Hello docx');
  });

  it('refuses a DOCX whose entry inflates past the 20 MB per-entry cap', async () => {
    // Honest sizes, but 25 MB of inflated content in one entry.
    const bytes = await buildDocx(documentXml('A'.repeat(25 * 1024 * 1024)));
    const inner = await innerErrorOf(bytes);
    expect(inner?.message).toContain('Zip bomb detected');
  });
});

// Streams `totalBytes` of zeros through raw DEFLATE. The output is small and the input is never held in memory.
async function deflateZeros(totalBytes: number): Promise<Buffer> {
  const deflate = createDeflateRaw();
  const chunks: Buffer[] = [];
  deflate.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve, reject) => {
    deflate.on('end', () => resolve());
    deflate.on('error', reject);
  });
  const block = Buffer.alloc(1024 * 1024);
  for (let written = 0; written < totalBytes; written += block.length) {
    deflate.write(block);
  }
  deflate.end();
  await done;
  return Buffer.concat(chunks);
}

interface RawEntry {
  name: string;
  method: number; // 0 = stored, 8 = DEFLATE
  data: Buffer; // the bytes as stored in the archive
  declaredSize: number; // the uncompressed size written into both headers
}

// Builds a zip from raw entries, so headers can claim any size. JSZip would only write honest sizes.
function rawZip(entries: RawEntry[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBytes = Buffer.from(e.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(e.method, 8);
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.declaredSize, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(e.method, 10);
    central.writeUInt32LE(e.data.length, 20);
    central.writeUInt32LE(e.declaredSize, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, e.data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + e.data.length;
  }
  const centralDir = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDir, eocd]);
}

describe('DOCX zip-bomb guard with patched sizes', () => {
  it('refuses an entry that declares 1 byte but inflates to 400 MB, quickly and without inflating it all', async () => {
    const deflated = await deflateZeros(400 * 1024 * 1024);
    const bytes = rawZip([
      { name: '[Content_Types].xml', method: 0, data: Buffer.from(CONTENT_TYPES), declaredSize: CONTENT_TYPES.length },
      { name: 'word/document.xml', method: 8, data: deflated, declaredSize: 1 },
    ]);

    const start = performance.now();
    const err = await extractDocumentText(bytes, 'patched.docx').catch((e) => e);
    const elapsed = performance.now() - start;

    expect(err.message).toContain('Zip bomb detected');
    expect(elapsed).toBeLessThan(5000);
  });

  it('refuses a bomb with 64 bytes prepended, before any inflation', async () => {
    const deflated = await deflateZeros(400 * 1024 * 1024);
    const archive = rawZip([
      { name: '[Content_Types].xml', method: 0, data: Buffer.from(CONTENT_TYPES), declaredSize: CONTENT_TYPES.length },
      { name: 'word/document.xml', method: 8, data: deflated, declaredSize: 1 },
    ]);
    // Starts with "PK" so format detection reaches the DOCX guard, as a real attacker's file would.
    const bytes = Buffer.concat([Buffer.from('PK'), Buffer.alloc(62, 0x78), archive]);

    const start = performance.now();
    const err = await extractDocumentText(bytes, 'prepended.docx').catch((e) => e);
    const elapsed = performance.now() - start;

    expect(err.code).toBe('CORRUPT_DOCUMENT');
    expect(err.problem).toContain('ambiguous');
    expect(elapsed).toBeLessThan(1000);
  });

  it('refuses a bomb with a fake end-of-central-directory record earlier in the file', async () => {
    const deflated = await deflateZeros(400 * 1024 * 1024);
    const archive = rawZip([
      { name: '[Content_Types].xml', method: 0, data: Buffer.from(CONTENT_TYPES), declaredSize: CONTENT_TYPES.length },
      { name: 'word/document.xml', method: 8, data: deflated, declaredSize: 1 },
    ]);
    // A bare EOCD record (signature, zero entries) in front of the real archive: a reader that takes the first one sees nothing.
    const fakeEocd = Buffer.alloc(22);
    fakeEocd.writeUInt32LE(0x06054b50, 0);
    const bytes = Buffer.concat([fakeEocd, archive]);

    const start = performance.now();
    const err = await extractDocumentText(bytes, 'fake-eocd.docx').catch((e) => e);
    const elapsed = performance.now() - start;

    expect(err.code).toBe('CORRUPT_DOCUMENT');
    expect(err.problem).toContain('ambiguous');
    expect(elapsed).toBeLessThan(1000);
  });
});

describe('DOCX XML parsing', () => {
  it('does not resolve external entities or expand DTD entities', async () => {
    // Four levels of nesting: enough to show expansion, small enough that a vulnerable parser cannot exhaust CI memory.
    const prolog =
      '<!DOCTYPE w:document [' +
      '<!ENTITY xxe SYSTEM "file:///etc/passwd">' +
      '<!ENTITY lol "lol">' +
      '<!ENTITY lol1 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">' +
      '<!ENTITY lol2 "&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;">' +
      '<!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">' +
      '<!ENTITY lol4 "&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;">' +
      ']>';
    const bytes = await buildDocx(documentXml('before &xxe; &lol4; after', prolog));

    const outcome = await extractDocumentText(bytes, 'xxe.docx').then(
      (r) => r.text,
      (e) => `THREW:${e.code}`
    );

    expect(outcome).not.toContain('root:');
    expect(outcome).not.toMatch(/lol{100}/);
    expect(outcome.length).toBeLessThan(1000);
  });
});
