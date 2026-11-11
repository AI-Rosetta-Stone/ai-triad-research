// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type { Readable } from 'node:stream';
import JSZip from 'jszip';
import { extractRawText } from 'mammoth';
import { ActionableError } from '../debate/errors.js';

const MAX_TOTAL_UNCOMPRESSED = 50 * 1024 * 1024; // 50 MB of actual inflated bytes, all entries together
const MAX_SINGLE_ENTRY = 20 * 1024 * 1024; // 20 MB of actual inflated bytes, per entry
const EOCD_SIZE = 22; // End of Central Directory record without a comment
const MAX_EOCD_SEARCH = 65557; // EOCD plus the largest possible (65535-byte) comment
const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;

/**
 * Extract text from DOCX using mammoth.
 *
 * Two layers, in order:
 * 1. Refuse any archive whose structure two parsers could read differently (prepended bytes, two EOCD records).
 * 2. Inflate every entry through JSZip, the parser mammoth uses, counting bytes as they are produced. Inflation
 *    stops at the caps. The bounded content is rebuilt into a fresh archive, and only that goes to mammoth.
 */
export async function extractDocxText(bytes: Uint8Array): Promise<string> {
  checkUnambiguousZip(bytes);
  const bounded = await rebuildWithinCaps(bytes);

  // mammoth's Node entry reads `buffer`; `arrayBuffer` is browser-only and was rejected with "Could not find file in options".
  const result = await extractRawText({
    buffer: Buffer.from(bounded.buffer, bounded.byteOffset, bounded.byteLength),
  });

  return result.value;
}

/**
 * Structural checks, without inflating anything. The archive must have exactly one end-of-central-directory record,
 * a central directory that ends right at it, and an entry count that matches the directory. Anything else is refused,
 * so no reader can see a different archive than the one checked.
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
 * Returns a fresh STORE archive holding only the verified content, so mammoth never inflates the original.
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
  for (const name of Object.keys(source.files)) {
    const entry = source.files[name];
    if (entry.dir) {
      continue;
    }
    const cap = Math.min(MAX_SINGLE_ENTRY, MAX_TOTAL_UNCOMPRESSED - total);
    const data = await readCounted(entry, name, cap);
    total += data.length;
    out.file(name, data, { binary: true });
  }
  return out.generateAsync({ type: 'uint8array', compression: 'STORE' });
}

// Streams one entry, stopping as soon as it produces more than `cap` bytes.
function readCounted(entry: JSZip.JSZipObject, name: string, cap: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    // JSZip types this as a web ReadableStream; at runtime it is a Node Readable, which has destroy().
    const stream = entry.nodeStream('nodebuffer') as unknown as Readable;
    stream.on('data', (chunk: Uint8Array) => {
      size += chunk.length;
      if (size > cap) {
        stream.destroy();
        reject(overBudgetError(cap, name));
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
    stream.on('error', (e: Error) => reject(zipError('DEFLATE data is corrupt', `ZIP entry "${name}" cannot be inflated: ${e.message}`)));
  });
}

function overBudgetError(cap: number, name: string): ActionableError {
  if (cap === MAX_SINGLE_ENTRY) {
    return zipError(
      'single entry inflates past the limit',
      `Zip bomb detected: entry "${name}" inflates past ${MAX_SINGLE_ENTRY / 1024 / 1024} MB. Limit is ${MAX_SINGLE_ENTRY / 1024 / 1024} MB per entry.`
    );
  }
  return zipError(
    'total inflated size exceeds the limit',
    `Zip bomb detected: total inflated size exceeds ${MAX_TOTAL_UNCOMPRESSED / 1024 / 1024} MB at entry "${name}".`
  );
}

function ambiguousZip(detail: string): ActionableError {
  return zipError('ambiguous zip structure', `ZIP structure is ambiguous (${detail}). Refusing to read it`);
}

function zipError(reason: string, message: string): ActionableError {
  return new ActionableError({
    goal: 'Extract text from DOCX document',
    problem: `${message} (${reason})`,
    location: 'lib/extraction:extractDocxText',
    nextSteps: ['Verify the file is a valid, unmodified DOCX', 'Re-save the document in Word and try again'],
    code: 'CORRUPT_DOCUMENT',
    httpStatus: 422,
  });
}
