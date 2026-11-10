// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { extractRawText } from 'mammoth';

/**
 * Extract text from DOCX using mammoth.
 * Also enforces zip-bomb guard: uncompressed entries ≤ 50 MB total.
 */
export async function extractDocxText(bytes: Uint8Array): Promise<string> {
  // Zip-bomb guard: check uncompressed size before extracting
  checkZipBombGuard(bytes);

  // Use mammoth's extractRawText for plain text extraction
  const result = await extractRawText({
    arrayBuffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  });

  return result.value;
}

/**
 * Guard against zip-bomb attacks by checking uncompressed entries don't exceed 50 MB total.
 * Reads ZIP central directory to sum uncompressed sizes.
 */
function checkZipBombGuard(bytes: Uint8Array): void {
  const MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024; // 50 MB

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

      // Sum uncompressed sizes from central directory
      let uncompressedTotal = 0;
      let pos = centralDirOffset;
      const endPos = centralDirOffset + centralDirSize;

      while (pos < endPos) {
        if (
          bytes[pos] === 0x50 &&
          bytes[pos + 1] === 0x4b &&
          bytes[pos + 2] === 0x01 &&
          bytes[pos + 3] === 0x02
        ) {
          // Central directory file header
          const uncompressedSize = view.getUint32(pos + 24, true);
          uncompressedTotal += uncompressedSize;

          if (uncompressedTotal > MAX_UNCOMPRESSED_BYTES) {
            throw new Error(
              `Zip bomb detected: uncompressed size exceeds 50 MB (${(uncompressedTotal / 1024 / 1024).toFixed(2)} MB)`
            );
          }

          // Move to next file header
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
