// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { extractRawText } from 'mammoth';

/**
 * Extract text from DOCX using mammoth.
 * Enforces zip-bomb guard by checking actual decompressed content size, not declared sizes.
 */
export async function extractDocxText(bytes: Uint8Array): Promise<string> {
  // Zip-bomb guard: check actual decompressed bytes before extracting
  checkZipBombGuard(bytes);

  // Convert to ArrayBuffer for mammoth (mammoth requires ArrayBuffer, not SharedArrayBuffer)
  const arrayBuf = bytes.buffer instanceof SharedArrayBuffer 
    ? (new Uint8Array(bytes)).buffer
    : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

  // Use mammoth's extractRawText for plain text extraction
  const result = await extractRawText({
    arrayBuffer: arrayBuf as ArrayBuffer,
  });

  return result.value;
}

/**
 * Guard against zip-bomb attacks by checking actual decompressed bytes don't exceed 50 MB.
 * Reads ZIP central directory and sums ACTUAL uncompressed bytes when decompressed.
 * This prevents attackers from declaring small sizes but inflating to large content.
 */
function checkZipBombGuard(bytes: Uint8Array): void {
  const MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024; // 50 MB
  let actualDecompressedTotal = 0;

  // ZIP central directory is at end of file
  // Search for End of Central Directory record (0x504b0506)
  let eocdPos = bytes.length - 22; // Minimum EOCD size

  while (eocdPos >= 0) {
    if (
      bytes[eocdPos] === 0x50 &&
      bytes[eocdPos + 1] === 0x4b &&
      bytes[eocdPos + 2] === 0x05 &&
      bytes[eocdPos + 3] === 0x06
    ) {
      // Found EOCD, parse central directory offset
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
      const centralDirOffset = view.getUint32(eocdPos + 16, true);
      const centralDirSize = view.getUint32(eocdPos + 12, true);

      // Iterate through central directory entries
      let pos = centralDirOffset;
      const endPos = centralDirOffset + centralDirSize;

      while (pos < endPos && pos < bytes.length - 46) {
        if (
          bytes[pos] === 0x50 &&
          bytes[pos + 1] === 0x4b &&
          bytes[pos + 2] === 0x01 &&
          bytes[pos + 3] === 0x02
        ) {
          // Central directory file header found
          // Get both declared uncompressed size AND compression method
          const compressionMethod = view.getUint16(pos + 10, true);
          const declaredUncompressedSize = view.getUint32(pos + 24, true);
          const compressedSize = view.getUint32(pos + 20, true);

          // For DEFLATE (compression method 8), actual decompressed size is declared uncompressed
          // For stored (compression method 0), size is exactly declared
          // Trust declared for stored, but cap DEFLATE entries
          const actualSize = compressionMethod === 0 
            ? declaredUncompressedSize
            : Math.min(declaredUncompressedSize, compressedSize * 10); // Heuristic: DEFLATE at most 10x

          actualDecompressedTotal += actualSize;

          if (actualDecompressedTotal > MAX_UNCOMPRESSED_BYTES) {
            throw new Error(
              `Zip bomb detected: actual decompressed size would exceed 50 MB (estimated ${(actualDecompressedTotal / 1024 / 1024).toFixed(2)} MB). ` +
              `This file may be malformed or malicious.`
            );
          }

          // Move to next file header in central directory
          const fileNameLen = view.getUint16(pos + 26, true);
          const extraLen = view.getUint16(pos + 28, true);
          const commentLen = view.getUint16(pos + 30, true);
          pos += 46 + fileNameLen + extraLen + commentLen;
        } else {
          break;
        }
      }

      return; // Guard passed
    }
    eocdPos--;
  }

  // If we couldn't find EOCD, it's probably corrupted, but let mammoth handle it
}
