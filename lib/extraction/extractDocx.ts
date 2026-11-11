// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { inflateRawSync } from 'node:zlib';
import { extractRawText } from 'mammoth';
import { ActionableError } from '../debate/errors.js';

const MAX_TOTAL_UNCOMPRESSED = 50 * 1024 * 1024; // 50 MB of actual inflated bytes, all entries together
const MAX_SINGLE_ENTRY = 20 * 1024 * 1024; // 20 MB of actual inflated bytes, per entry
const MAX_RATIO_ALLOWED = 100; // Actual inflated size / compressed size for DEFLATE
const EOCD_SIZE = 22; // End of Central Directory record without a comment
const MAX_EOCD_SEARCH = 65557; // EOCD plus the largest possible (65535-byte) comment
const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

/**
 * Extract text from DOCX using mammoth.
 * The zip-bomb guard inflates each entry under a byte budget before mammoth sees the file.
 */
export async function extractDocxText(bytes: Uint8Array): Promise<string> {
  checkZipBombGuard(bytes);

  // mammoth's Node entry reads `buffer`; `arrayBuffer` is browser-only and was rejected with "Could not find file in options".
  const result = await extractRawText({
    buffer: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
  });

  return result.value;
}

/**
 * Inflate every central-directory entry and count the bytes actually produced. Declared sizes are never trusted:
 * a patched header can claim 1 byte for a 400 MB payload. Inflation stops at the budget, so memory stays bounded.
 */
function checkZipBombGuard(bytes: Uint8Array): void {
  const eocdPos = findEocd(bytes);
  // No EOCD: not a readable zip, so mammoth will reject it
  if (eocdPos === -1) {
    return;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const centralDirOffset = view.getUint32(eocdPos + 16, true);
  const centralDirSize = view.getUint32(eocdPos + 12, true);
  const endPos = centralDirOffset + centralDirSize;

  let totalInflated = 0;
  let pos = centralDirOffset;
  while (pos < endPos && pos + CENTRAL_HEADER_SIZE <= bytes.length && hasSignature(bytes, pos, 0x01, 0x02)) {
    totalInflated += inflateCentralDirEntry(bytes, view, pos, MAX_TOTAL_UNCOMPRESSED - totalInflated);

    // Move to the next central-directory header (APPNOTE 4.4: name length at +28, extra at +30, comment at +32)
    pos += CENTRAL_HEADER_SIZE + view.getUint16(pos + 28, true) + view.getUint16(pos + 30, true) + view.getUint16(pos + 32, true);
  }
}

// Scan from the end of the archive for "PK\x05\x06". The first match from the window start is the EOCD.
// The record is 22 bytes, so a comment-less archive has it at length - 22: the bound is inclusive.
function findEocd(bytes: Uint8Array): number {
  for (let pos = Math.max(0, bytes.length - MAX_EOCD_SEARCH); pos <= bytes.length - EOCD_SIZE; pos++) {
    if (hasSignature(bytes, pos, 0x05, 0x06)) {
      return pos;
    }
  }
  return -1;
}

// Checks the "PK" prefix followed by the two given bytes.
function hasSignature(bytes: Uint8Array, pos: number, third: number, fourth: number): boolean {
  return bytes[pos] === 0x50 && bytes[pos + 1] === 0x4b && bytes[pos + 2] === third && bytes[pos + 3] === fourth;
}

// Inflates one entry, enforcing the per-entry cap and the bytes left in the total budget. Returns the actual size.
function inflateCentralDirEntry(bytes: Uint8Array, view: DataView, cdPos: number, remainingTotal: number): number {
  const method = view.getUint16(cdPos + 10, true);
  const compressedSize = view.getUint32(cdPos + 20, true);
  const localPos = view.getUint32(cdPos + 42, true);
  const data = readEntryData(bytes, view, localPos, compressedSize);

  const cap = Math.min(MAX_SINGLE_ENTRY, remainingTotal);
  const actual = inflatedSize(method, data, cap);

  if (method === METHOD_DEFLATE && compressedSize > 0 && actual / compressedSize > MAX_RATIO_ALLOWED) {
    throw zipError(
      'compression ratio exceeds the safety threshold',
      `Zip bomb detected: compression ratio ${(actual / compressedSize).toFixed(0)}:1 exceeds ${MAX_RATIO_ALLOWED}:1. ` +
      `Entry inflates to ${actual} bytes from ${compressedSize} compressed. File may be malformed or malicious.`
    );
  }
  return actual;
}

// Returns the entry's compressed bytes, located through its local header.
function readEntryData(bytes: Uint8Array, view: DataView, localPos: number, size: number): Uint8Array {
  if (localPos + LOCAL_HEADER_SIZE > bytes.length || !hasSignature(bytes, localPos, 0x03, 0x04)) {
    throw zipError('local header missing', 'ZIP entry has no local file header at the offset its directory names');
  }
  const start = localPos + LOCAL_HEADER_SIZE + view.getUint16(localPos + 26, true) + view.getUint16(localPos + 28, true);
  if (start + size > bytes.length) {
    throw zipError('entry data past end of file', 'ZIP entry data extends past the end of the file');
  }
  return bytes.subarray(start, start + size);
}

// Actual inflated size, with inflation stopped at `cap` bytes.
function inflatedSize(method: number, data: Uint8Array, cap: number): number {
  if (method !== METHOD_STORED && method !== METHOD_DEFLATE) {
    throw zipError('unsupported compression method', `ZIP entry uses compression method ${method}; only stored and DEFLATE are accepted`);
  }
  if (cap <= 0) {
    throw overBudgetError(MAX_TOTAL_UNCOMPRESSED);
  }
  if (method === METHOD_STORED) {
    if (data.length > cap) {
      throw overBudgetError(cap);
    }
    return data.length;
  }
  try {
    return inflateRawSync(data, { maxOutputLength: cap }).length;
  } catch (e: any) {
    if (e?.code === 'ERR_BUFFER_TOO_LARGE') {
      throw overBudgetError(cap);
    }
    throw zipError('DEFLATE data is corrupt', `ZIP entry cannot be inflated: ${e?.message ?? e}`);
  }
}

function overBudgetError(cap: number): ActionableError {
  if (cap === MAX_SINGLE_ENTRY) {
    return zipError(
      'single entry inflates past the limit',
      `Zip bomb detected: a single entry inflates past ${MAX_SINGLE_ENTRY / 1024 / 1024} MB. Limit is ${MAX_SINGLE_ENTRY / 1024 / 1024} MB per entry.`
    );
  }
  return zipError(
    'total inflated size exceeds the limit',
    `Zip bomb detected: total inflated size exceeds ${MAX_TOTAL_UNCOMPRESSED / 1024 / 1024} MB.`
  );
}

function zipError(reason: string, message: string): ActionableError {
  return new ActionableError({
    goal: 'Extract text from DOCX document',
    problem: `${message} (${reason})`,
    location: 'lib/extraction:checkZipBombGuard',
    nextSteps: ['Verify the file is a valid, unmodified DOCX', 'Re-save the document in Word and try again'],
    httpStatus: 422,
  });
}
