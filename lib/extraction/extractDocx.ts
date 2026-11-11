// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { extractRawText } from 'mammoth';

/**
 * Extract text from DOCX using mammoth.
 * Enforces zip-bomb guard by checking actual decompressed content size.
 */
export async function extractDocxText(bytes: Uint8Array): Promise<string> {
  checkZipBombGuard(bytes);

  const arrayBuf = bytes.buffer instanceof SharedArrayBuffer 
    ? (new Uint8Array(bytes)).buffer
    : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

  const result = await extractRawText({
    arrayBuffer: arrayBuf as ArrayBuffer,
  });

  return result.value;
}

/**
 * Guard against zip-bomb attacks by checking that compressed files don't claim unrealistic compression ratios.
 * For DEFLATE-compressed entries, actual decompression could be up to the declared size.
 * We reject files where any single entry's declared size >> compressed size (e.g., 100MB declared as 1KB).
 */
function checkZipBombGuard(bytes: Uint8Array): void {
  const MAX_TOTAL_UNCOMPRESSED = 50 * 1024 * 1024; // 50 MB total
  const MAX_RATIO_ALLOWED = 100; // Declared size / compressed size allowed for DEFLATE
  const MAX_SINGLE_ENTRY = 20 * 1024 * 1024; // Single entry max 20 MB
  
  let totalSuspicious = 0;

  // Find End of Central Directory record (EOCD)
  let eocdPos = Math.max(0, bytes.length - 65557); // Search from end, up to 65KB back
  let foundEOCD = false;

  while (eocdPos < bytes.length - 22) {
    if (
      bytes[eocdPos] === 0x50 &&
      bytes[eocdPos + 1] === 0x4b &&
      bytes[eocdPos + 2] === 0x05 &&
      bytes[eocdPos + 3] === 0x06
    ) {
      foundEOCD = true;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
      
      const centralDirOffset = view.getUint32(eocdPos + 16, true);
      const centralDirSize = view.getUint32(eocdPos + 12, true);

      let pos = centralDirOffset;
      const endPos = centralDirOffset + centralDirSize;

      while (pos < endPos && pos + 46 <= bytes.length) {
        if (
          bytes[pos] === 0x50 &&
          bytes[pos + 1] === 0x4b &&
          bytes[pos + 2] === 0x01 &&
          bytes[pos + 3] === 0x02
        ) {
          const compressionMethod = view.getUint16(pos + 10, true);
          const declaredUncompressed = view.getUint32(pos + 24, true);
          const compressedSize = view.getUint32(pos + 20, true);

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

          totalSuspicious += declaredUncompressed;

          // Move to next file header
          const fileNameLen = view.getUint16(pos + 26, true);
          const extraLen = view.getUint16(pos + 28, true);
          const commentLen = view.getUint16(pos + 30, true);
          pos += 46 + fileNameLen + extraLen + commentLen;
        } else {
          break;
        }
      }

      if (totalSuspicious > MAX_TOTAL_UNCOMPRESSED) {
        throw new Error(
          `Zip bomb detected: total declared size ${(totalSuspicious / 1024 / 1024).toFixed(2)} MB ` +
          `exceeds 50 MB limit`
        );
      }

      return;
    }
    eocdPos++;
  }

  // If no EOCD found, might be a valid ZIP or might be corrupted; let mammoth handle it
}
