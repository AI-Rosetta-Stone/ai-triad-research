// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
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

  it('refuses a crafted high-ratio DOCX with no archive comment', async () => {
    // 5 MB of one character deflates to a few KB: a ratio far above the 100:1 limit.
    const bytes = await buildDocx(documentXml('A'.repeat(5 * 1024 * 1024)));
    const inner = await innerErrorOf(bytes);
    expect(inner?.message).toContain('Zip bomb detected');
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
