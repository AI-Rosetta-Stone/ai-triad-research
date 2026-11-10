// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/274: Document extraction route — accept uploaded document, extract text with format inference.
// Requires sign-in. Enforces 10 MB body limit. Maps ActionableError from shared lib to HTTP response.
// Stub: extractDocumentText not yet integrated (blocking t/273 merge).

import type { Router } from '../httpKit.js';
import { json, error } from '../httpKit.js';
import type { ServerCtx } from './context.js';

const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Extract text from an uploaded document.
 * POST /api/documents/extract
 *
 * Request body: multipart/form-data with file upload OR raw binary with X-File-Name header.
 * Response: { text: string, format: string, warnings: string[] }
 *
 * Errors (mapped from shared lib's extractDocumentText):
 * - 413 Payload Too Large (body > 10 MB)
 * - 415 Unsupported Media Type (format not recognized)
 * - 422 Unprocessable Entity (extraction failed)
 *
 * t/274 (t/271 feature, blocked on t/273 for extractDocumentText interface)
 */
export function registerDocumentsRoutes(r: Router, _ctx: ServerCtx): void {
  const { post } = r;

  post('/api/documents/extract', async (_req, res) => {
    // t/274: Stub implementation. Once t/273 lands and extractDocumentText is available,
    // integrate the shared lib call here.
    //
    // Expected flow (pseudo-code):
    // 1. Check Authorization header → 401 if missing (sign-in required)
    // 2. Collect request body with MAX_DOCUMENT_BYTES limit (413 if exceeded)
    // 3. Extract fileName from X-File-Name header or multipart metadata
    // 4. Call extractDocumentText(bodyBuffer, fileName)
    // 5. Catch ActionableError, map code→httpStatus (413/415/422) to response
    // 6. Return { text, format, warnings } on success (200)

    // Placeholder response for now
    json(res, {
      text: '[stub: document extraction not yet implemented; waiting for t/273 interface]',
      format: 'unknown',
      warnings: ['This endpoint is a stub and will be wired on t/273 merge.'],
    });
  });
}
