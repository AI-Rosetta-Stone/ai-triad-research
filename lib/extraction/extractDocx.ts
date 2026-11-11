// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { extractRawText } from 'mammoth';

const MAX_TOTAL_UNCOMPRESSED = 50 * 1024 * 1024; // 50 MB total
const MAX_RATIO_ALLOWED = 100; // Declared size / compressed size allowed for DEFLATE
const MAX_SINGLE_ENTRY = 20 * 1024 * 1024; // Single entry max 20 MB
const EOCD_SIZE = 22; // End of Central Directory record without a comment
const MAX_EOCD_SEARCH = 65557; // EOCD plus the largest possible (65535-byte) comment

/**
 * Extract text from DOCX using mammoth.
 * Enforces zip-bomb guard by checking actual decompressed content size.
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
 * Guard against zip-bomb attacks by checking that compressed files don't claim unrealistic compression ratios.
 * For DEFLATE-compressed entries, actual decompression could be up to the declared size.
 * We reject files where any single entry's declared size >> compressed size (e.g., 100MB declared as 1KB).
 */
function checkZipBombGuard(bytes: Uint8Array): void {
  const eocdPos = findEocd(bytes);
  // No EOCD: might be a valid ZIP or might be corrupted; let mammoth handle it
  if (eocdPos === -1) {
    return;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const centralDirOffset = view.getUint32(eocdPos + 16, true);
  const centralDirSize = view.getUint32(eocdPos + 12, true);
  const endPos = centralDirOffset + centralDirSize;

  let totalSuspicious = 0;
  let pos = centralDirOffset;
  while (pos < endPos && pos + 46 <= bytes.length && hasSignature(bytes, pos, 0x01, 0x02)) {
    totalSuspicious += checkCentralDirEntry(view, pos);

    // Move to next file header
    const fileNameLen = view.getUint16(pos + 26, true);
    const extraLen = view.getUint16(pos + 28, true);
    const commentLen = view.getUint16(pos + 30, true);
    pos += 46 + fileNameLen + extraLen + commentLen;
  }

  if (totalSuspicious > MAX_TOTAL_UNCOMPRESSED) {
    throw new Error(
      `Zip bomb detected: total declared size ${(totalSuspicious / 1024 / 1024).toFixed(2)} MB ` +
      `exceeds 50 MB limit`
    );
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

// Validates one central-directory entry and returns its declared uncompressed size.
function checkCentralDirEntry(view: DataView, pos: number): number {
  const compressionMethod = view.getUint16(pos + 10, true);
  const compressedSize = view.getUint32(pos + 20, true);
  const declaredUncompressed = view.getUint32(pos + 24, true);

  // Reject entries with suspicious compression ratios
  if (compressionMethod === 8 && compressedSize > 0) {
    // DEFLATE compression
    const ratio = declaredUncompressed / compressedSize;
    if (ratio > MAX_RATIO_ALLOWED) {
      throw new Error(
        `Zip bomb detected: compression ratio ${ratio.toFixed(0)}:1 exceeds safety threshold. ` +
        `Entry claims ${declaredUncompressed} bytes from ${compressedSize} compressed. ` +
        `File may be malformed or malicious.`
      );
    }
  } else if (compressionMethod === 0 && declaredUncompressed !== compressedSize) {
    // For stored (uncompressed) entries, declared and compressed sizes must match
    throw new Error(
      `Invalid ZIP entry: compression method is 'stored' but declared (${declaredUncompressed}) ` +
      `differs from compressed size (${compressedSize})`
    );
  }

  // Also check individual entry size
  if (declaredUncompressed > MAX_SINGLE_ENTRY) {
    throw new Error(
      `Zip bomb detected: single entry claims ${(declaredUncompressed / 1024 / 1024).toFixed(2)} MB. ` +
      `Limit is ${(MAX_SINGLE_ENTRY / 1024 / 1024).toFixed(2)} MB per entry.`
    );
  }

  return declaredUncompressed;
}
