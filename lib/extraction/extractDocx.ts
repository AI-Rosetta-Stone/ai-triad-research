// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type { Readable } from 'node:stream';
import JSZip from 'jszip';
import { ActionableError } from '../debate/errors.js';
import { parseIsolated } from './isolatedParse.js';

const MAX_TOTAL_UNCOMPRESSED = 50 * 1024 * 1024; // 50 MB of actual inflated bytes, all entries together
const MAX_SINGLE_ENTRY = 20 * 1024 * 1024; // 20 MB of actual inflated bytes, per entry
// mammoth's XML parse costs about 150x the bytes it reads, so XML parts get a much tighter budget (t/393).
const MAX_XML_PART = 5 * 1024 * 1024; // 5 MB per .xml / .rels part
const MAX_XML_TOTAL = 10 * 1024 * 1024; // 10 MB of XML parts together
const MAX_ENTRIES = 1000; // refuses directories of tens of thousands of empty entries before any inflation
const EOCD_SIZE = 22; // End of Central Directory record without a comment
const MAX_EOCD_SEARCH = 65557; // EOCD plus the largest possible (65535-byte) comment
const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;

/**
 * Extract text from DOCX.
 *
 * In this process: (1) refuse any archive whose structure two readers could parse differently, and (2) inflate every
 * entry through JSZip, the parser mammoth uses, counting bytes as they come, under the byte caps. Only the bounded
 * content is rebuilt into a fresh archive. In the isolated child (t/393): mammoth parses that archive under the heap
 * ceiling and the hard kill.
 */
export async function extractDocxText(bytes: Uint8Array): Promise<string> {
  checkUnambiguousZip(bytes);
  const bounded = await rebuildWithinCaps(bytes);
  const { text } = await parseIsolated('docx', bounded);
  return text;
}

/**
 * Structural checks, without inflating anything. The archive must have exactly one end-of-central-directory record,
 * a central directory that ends right at it, an entry count that matches the directory, and local headers where the
 * directory says. Anything else is refused, so no reader can see a different archive than the one checked.
 */
function checkUnambiguousZip(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const eocdPos = findSingleEocd(bytes);

  const count = view.getUint16(eocdPos + 10, true);
  const centralDirSize = view.getUint32(eocdPos + 12, true);
  const centralDirOffset = view.getUint32(eocdPos + 16, true);
  if (count === 0 || centralDirOffset === 0xffffffff || centralDirSize === 0xffffffff) {
    throw ambiguousZip('no entries, or a zip64 archive');
  }
  if (count > MAX_ENTRIES) {
    throw zipError('too many entries', `ZIP archive has ${count} entries; the limit is ${MAX_ENTRIES}`);
  }
  // With prepended or appended bytes the directory no longer ends at the EOCD, and readers disagree on the offsets
  if (centralDirOffset + centralDirSize !== eocdPos) {
    throw ambiguousZip('the central directory does not end at the end-of-central-directory record');
  }

  let seen = 0;
  let pos = centralDirOffset;
  while (pos < eocdPos) {
    if (pos + CENTRAL_HEADER_SIZE > eocdPos || !hasSignature(bytes, pos, 0x01, 0x02)) {
      throw ambiguousZip('the central directory is malformed');
    }
    // Each entry's local header must sit where the directory says
    const localPos = view.getUint32(pos + 42, true);
    if (localPos + LOCAL_HEADER_SIZE > bytes.length || !hasSignature(bytes, localPos, 0x03, 0x04)) {
      throw ambiguousZip('an entry has no local header at the offset its directory names');
    }
    seen++;
    // Next central-directory header (APPNOTE 4.4: name length at +28, extra at +30, comment at +32)
    pos += CENTRAL_HEADER_SIZE + view.getUint16(pos + 28, true) + view.getUint16(pos + 30, true) + view.getUint16(pos + 32, true);
  }
  if (pos !== eocdPos || seen !== count) {
    throw ambiguousZip('the entry count does not match the central directory');
  }
}

// Finds the end-of-central-directory record. There must be exactly one: a second one is a way to make two readers
// disagree about which directory to use. Looks at the last 65557 bytes, the window JSZip searches.
function findSingleEocd(bytes: Uint8Array): number {
  const found: number[] = [];
  for (let pos = Math.max(0, bytes.length - MAX_EOCD_SEARCH); pos <= bytes.length - EOCD_SIZE; pos++) {
    if (hasSignature(bytes, pos, 0x05, 0x06)) {
      found.push(pos);
    }
  }
  if (found.length === 0) {
    throw ambiguousZip('no end-of-central-directory record');
  }
  if (found.length > 1) {
    throw ambiguousZip('multiple end-of-central-directory records');
  }
  return found[0];
}

// Checks the "PK" prefix followed by the two given bytes.
function hasSignature(bytes: Uint8Array, pos: number, third: number, fourth: number): boolean {
  return bytes[pos] === 0x50 && bytes[pos + 1] === 0x4b && bytes[pos + 2] === third && bytes[pos + 3] === fourth;
}

/**
 * Loads the archive with JSZip and streams every file entry through a counter. Declared sizes are never read.
 * Returns a fresh STORE archive holding only the verified content, so mammoth never sees the original.
 */
async function rebuildWithinCaps(bytes: Uint8Array): Promise<Uint8Array> {
  let source: JSZip;
  try {
    source = await JSZip.loadAsync(bytes);
  } catch (e: any) {
    throw zipError('archive unreadable', `ZIP archive cannot be read: ${e?.message ?? e}`);
  }

  const out = new JSZip();
  let total = 0;
  let xmlTotal = 0;
  for (const name of Object.keys(source.files)) {
    const entry = source.files[name];
    if (entry.dir) {
      continue;
    }
    // The tightest applicable limit wins. XML parts are what mammoth parses, so they carry the extra limits.
    const limits: Limit[] = [
      { bytes: MAX_SINGLE_ENTRY, label: 'per-entry' },
      { bytes: MAX_TOTAL_UNCOMPRESSED - total, label: 'total' },
    ];
    if (isXmlPart(name)) {
      limits.push({ bytes: MAX_XML_PART, label: 'XML part' }, { bytes: MAX_XML_TOTAL - xmlTotal, label: 'total XML' });
    }
    const limit = limits.reduce((tightest, l) => (l.bytes < tightest.bytes ? l : tightest));
    const data = await readCounted(entry, name, limit);
    total += data.length;
    if (isXmlPart(name)) {
      xmlTotal += data.length;
    }
    out.file(name, data, { binary: true });
  }
  return out.generateAsync({ type: 'uint8array', compression: 'STORE' });
}

interface Limit {
  bytes: number;
  label: string;
}

function isXmlPart(name: string): boolean {
  return /\.(xml|rels)$/i.test(name);
}

// Streams one entry, stopping as soon as it produces more than the limit.
function readCounted(entry: JSZip.JSZipObject, name: string, limit: Limit): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    // JSZip types this as a web ReadableStream; at runtime it is a Node Readable, which has destroy().
    const stream = entry.nodeStream('nodebuffer') as unknown as Readable;
    stream.on('data', (chunk: Uint8Array) => {
      size += chunk.length;
      if (size > limit.bytes) {
        stream.destroy();
        reject(overBudgetError(limit, name));
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => {
      const data = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.length;
      }
      resolve(data);
    });
    stream.on('error', (e: Error) => reject(zipError('DEFLATE data is corrupt', `ZIP entry "${safeEntryName(name)}" cannot be inflated: ${e.message}`)));
  });
}

// Size-cap refusals are SIZE_LIMIT_EXCEEDED (413), like the 10 MB input cap. Everything else is CORRUPT_DOCUMENT (422).
function overBudgetError(limit: Limit, name: string): ActionableError {
  return zipError(
    'inflated size exceeds a limit',
    `Zip bomb detected: entry "${safeEntryName(name)}" pushes the ${limit.label} inflated size past its limit of ${(limit.bytes / 1024 / 1024).toFixed(1)} MB.`,
    'SIZE_LIMIT_EXCEEDED',
    413,
  );
}

function ambiguousZip(detail: string): ActionableError {
  return zipError('ambiguous zip structure', `ZIP structure is ambiguous (${detail}). Refusing to read it`);
}

// Entry names come from the untrusted archive: keep them short and printable before they reach error text.
function safeEntryName(name: string): string {
  return name.replace(/[^\x20-\x7e]/g, '?').slice(0, 80);
}

function zipError(
  reason: string,
  message: string,
  code: 'CORRUPT_DOCUMENT' | 'SIZE_LIMIT_EXCEEDED' = 'CORRUPT_DOCUMENT',
  httpStatus = 422,
): ActionableError {
  return new ActionableError({
    goal: 'Extract text from DOCX document',
    problem: `${message} (${reason})`,
    location: 'lib/extraction:extractDocxText',
    nextSteps: ['Verify the file is a valid, unmodified DOCX', 'Re-save the document in Word and try again'],
    code,
    httpStatus,
  });
}
