// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

export interface DocumentExtractionResult {
  text: string;
  format: 'pdf' | 'docx' | 'txt' | 'md' | 'html';
  warnings: string[];
}

export type DocumentExtractionCode =
  | 'UNSUPPORTED_FORMAT'
  | 'ENCRYPTED_DOCUMENT'
  | 'EMPTY_DOCUMENT'
  | 'SIZE_LIMIT_EXCEEDED'
  | 'CORRUPT_DOCUMENT'
  | 'EXTRACTION_FAILED'
  | 'EXTRACTION_TIMEOUT'
  | 'EXTRACTION_MEMORY_LIMIT'
  | 'EXTRACTION_BUSY';

/**
 * HTTP status codes for extraction errors.
 * - 413 Payload Too Large: SIZE_LIMIT_EXCEEDED
 * - 415 Unsupported Media Type: UNSUPPORTED_FORMAT
 * - 429 Too Many Requests: EXTRACTION_BUSY (the isolated-child slots and queue are full; t/274)
 * - 422 Unprocessable Entity: all others (ENCRYPTED, EMPTY, CORRUPT, EXTRACTION_FAILED, and the isolated-parse
 *   TIMEOUT and MEMORY_LIMIT codes from t/393)
 */
export const extractionErrorStatus: Record<DocumentExtractionCode, number> = {
  SIZE_LIMIT_EXCEEDED: 413,
  UNSUPPORTED_FORMAT: 415,
  ENCRYPTED_DOCUMENT: 422,
  EMPTY_DOCUMENT: 422,
  CORRUPT_DOCUMENT: 422,
  EXTRACTION_FAILED: 422,
  EXTRACTION_TIMEOUT: 422,
  EXTRACTION_MEMORY_LIMIT: 422,
  EXTRACTION_BUSY: 429,
};
