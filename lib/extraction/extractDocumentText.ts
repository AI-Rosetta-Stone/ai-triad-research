// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { ActionableError } from '../debate/errors.js';
import { detectFormat, type DocumentFormat } from './format.js';
import { extractPdfText } from './extractPdf.js';
import { extractDocxText } from './extractDocx.js';
import { extractPlainText } from './extractPlain.js';
import { extractHtmlText } from './extractHtml.js';
import type { DocumentExtractionResult, DocumentExtractionCode } from './types.js';
import { extractionErrorStatus } from './types.js';

const SIZE_LIMIT_BYTES = 10 * 1024 * 1024; // 10 MB
const TEXT_LIMIT_CHARS = 500_000;
const SANITIZER_CHUNK_SIZE = 32_000; // sanitizeText caps at 32 KB; process in chunks

export async function extractDocumentText(
  bytes: Uint8Array,
  fileName: string
): Promise<DocumentExtractionResult> {
  // Size check before parsing
  if (bytes.length > SIZE_LIMIT_BYTES) {
    throw createError('SIZE_LIMIT_EXCEEDED', {
      goal: 'Extract text from a document',
      problem: `Document exceeds 10 MB size limit (${(bytes.length / 1024 / 1024).toFixed(2)} MB)`,
      location: 'lib/extraction:extractDocumentText',
      nextSteps: ['Use a smaller document', 'Try uploading a summary instead'],
      httpStatus: extractionErrorStatus.SIZE_LIMIT_EXCEEDED,
    });
  }

  // Detect format from magic bytes
  let format: DocumentFormat;
  try {
    format = detectFormat(bytes);
  } catch (e) {
    throw createError('UNSUPPORTED_FORMAT', {
      goal: 'Identify document format',
      problem: `Could not determine file format for "${fileName}"`,
      location: 'lib/extraction:detectFormat',
      nextSteps: [
        'Verify the file is a valid PDF, DOCX, TXT, MD, or HTML document',
        'Check the file is not corrupted',
      ],
      innerError: e,
      httpStatus: extractionErrorStatus.UNSUPPORTED_FORMAT,
    });
  }

  // Extract text based on format
  let extractedText: string;
  const warnings: string[] = [];

  try {
    switch (format) {
      case 'pdf':
        extractedText = await extractPdfText(bytes);
        break;
      case 'docx':
        extractedText = await extractDocxText(bytes);
        break;
      case 'txt':
      case 'md':
        extractedText = extractPlainText(bytes);
        break;
      case 'html':
        extractedText = extractHtmlText(bytes);
      case 'unsupported':
        throw createError('UNSUPPORTED_FORMAT', {
          goal: 'Extract text from document',
          problem: 'File format is not supported (detected as ZIP but not a valid DOCX, or unknown archive type)',
          location: 'lib/extraction:extractDocumentText',
          nextSteps: ['Verify the file is a valid PDF, DOCX, plain text, or HTML file', 'Convert to a supported format first'],
        });
        break;
      default:
        const _exhaustive: never = format;
        throw new Error(`Unhandled format: ${_exhaustive}`);
    }
  } catch (e) {
    // Check for encrypted PDF
    if (format === 'pdf' && e instanceof Error && e.name === 'PasswordException') {
      throw createError('ENCRYPTED_DOCUMENT', {
        goal: 'Extract text from PDF',
        problem: 'PDF is password-protected or encrypted',
        location: 'lib/extraction:extractPdfText',
        nextSteps: ['Remove password protection', 'Use an unencrypted version of the PDF'],
        innerError: e,
        httpStatus: extractionErrorStatus.ENCRYPTED_DOCUMENT,
      });
    }

    throw createError('EXTRACTION_FAILED', {
      goal: `Extract text from ${format.toUpperCase()} document`,
      problem: `Failed to extract text from document`,
      location: 'lib/extraction:extract*Text',
      nextSteps: [
        'Verify the document is not corrupted',
        'Try a different document',
        'Check that the file format matches the extension',
      ],
      innerError: e,
      httpStatus: extractionErrorStatus.EXTRACTION_FAILED,
    });
  }

  // Check for empty content
  const trimmed = extractedText.trim();
  if (trimmed.length === 0) {
    throw createError('EMPTY_DOCUMENT', {
      goal: 'Extract text from document',
      problem: 'Document contains no extractable text',
      location: 'lib/extraction:extractDocumentText',
      nextSteps: ['Verify the document contains readable text', 'Try a different document'],
      httpStatus: extractionErrorStatus.EMPTY_DOCUMENT,
    });
  }

  // Cap the output text length before sanitization
  let cappedText = trimmed;
  if (trimmed.length > TEXT_LIMIT_CHARS) {
    cappedText = trimmed.slice(0, TEXT_LIMIT_CHARS);
  }

  // Simple text sanitization: remove null bytes and control characters (32 KB limit per chunk)
  const sanitized = sanitizeTextInChunks(cappedText);

  if (trimmed.length > TEXT_LIMIT_CHARS) {
    warnings.push(`Text truncated from ${trimmed.length} to ${TEXT_LIMIT_CHARS} characters`);
  }

  return {
    text: sanitized,
    format,
    warnings,
  };
}

function sanitizeTextInChunks(text: string): string {
  if (text.length <= SANITIZER_CHUNK_SIZE) {
    return sanitizeChunk(text);
  }

  // Process in chunks respecting 32 KB limit
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += SANITIZER_CHUNK_SIZE) {
    const chunk = text.slice(i, i + SANITIZER_CHUNK_SIZE);
    chunks.push(sanitizeChunk(chunk));
  }
  return chunks.join('');
}

function sanitizeChunk(chunk: string): string {
  // Remove null bytes and control characters (except whitespace)
  return chunk.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F]/g, '');
}

function createError(
  code: DocumentExtractionCode,
  opts: {
    goal: string;
    problem: string;
    location: string;
    nextSteps: string[];
    innerError?: unknown;
    httpStatus?: number;
  }
): ActionableError {
  const error = new ActionableError({
    goal: opts.goal,
    problem: opts.problem,
    location: opts.location,
    nextSteps: opts.nextSteps,
    innerError: opts.innerError instanceof Error ? opts.innerError : undefined,
    code,
    httpStatus: opts.httpStatus,
  });
  return error;
}
