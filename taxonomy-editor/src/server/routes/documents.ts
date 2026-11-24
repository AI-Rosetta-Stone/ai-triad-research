// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/274 (t/271 scope change): POST /api/documents/extract — pick-time extraction of an uploaded document.
// The body is a raw binary (application/octet-stream) with the filename in X-Document-Name. This route reads
// its own stream (it is listed in STREAMED_BODY_ROUTES in server.ts), so the 10 MB cap is enforced before the
// upload is buffered. Sign-in is required. PDF and DOCX parse in t/393's isolated child (the extractor
// handles that), so this route does not refuse them. Raw bytes are never written to disk or logs: the log
// records only the name, size and format.

import type { Router } from '../httpKit.js';
import type { ServerCtx } from './context.js';
import type { IncomingMessage, ServerResponse } from 'http';
import { json } from '../httpKit.js';
import { getCurrentUser } from '../security/userContext.js';
import { log } from '../logger.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { ActionableError } from '../../../../lib/debate/errors.js';
import { extractDocumentText } from '../../../../lib/extraction/index.js';
import { extractionErrorStatus, type DocumentExtractionCode } from '../../../../lib/extraction/types.js';

const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024; // 10 MB, the same cap as the extractor
const MAX_NAME_CHARS = 255;

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  if (status === 413) res.setHeader('Connection', 'close'); // the unread rest of an oversize upload is discarded
  json(res, { error: message, code }, status);
}

/** Reads the request body, stopping at the cap. Returns null when the cap is exceeded. */
async function readCapped(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_DOCUMENT_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function decodeName(raw: string | undefined): string | null {
  if (!raw) return null;
  let name: string;
  try { name = decodeURIComponent(raw); } catch { /* telemetry — silent by design: a malformed header is a client error, answered 400 */ return null; }
  name = name.trim();
  if (name.length === 0 || name.length > MAX_NAME_CHARS) return null;
  return name;
}

export function registerDocumentsRoutes(r: Router, _ctx: ServerCtx): void {
  const { post } = r;

  post('/api/documents/extract', async (req, res) => {
    const user = getCurrentUser();
    if (!user || user.isAnonymous) { sendError(res, 401, 'UNAUTHENTICATED', 'Sign in to upload a document'); return; }

    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > MAX_DOCUMENT_BYTES) { sendError(res, 413, 'SIZE_LIMIT_EXCEEDED', 'Document exceeds the 10 MB limit'); return; }

    const name = decodeName(req.headers['x-document-name'] as string | undefined);
    if (name === null) { sendError(res, 400, 'BAD_REQUEST', 'X-Document-Name is required (URI-encoded, 1 to 255 characters)'); return; }

    try {
      const bytes = await readCapped(req);
      if (bytes === null) { sendError(res, 413, 'SIZE_LIMIT_EXCEEDED', 'Document exceeds the 10 MB limit'); return; }
      if (bytes.length === 0) { sendError(res, 400, 'BAD_REQUEST', 'The upload is empty'); return; }

      const result = await extractDocumentText(new Uint8Array(bytes), name);
      log.api.info({ component: 'api', route: 'documents-extract', name, size: bytes.length, format: result.format }, 'document extracted');
      const words = result.text.split(/\s+/).filter(Boolean).length;
      json(res, { text: result.text, format: result.format, words, warnings: result.warnings }, 200);
    } catch (err) {
      if (err instanceof ActionableError && err.code && err.code in extractionErrorStatus) {
        const code = err.code as DocumentExtractionCode;
        sendError(res, extractionErrorStatus[code], code, err.message);
        return;
      }
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'api', level: 'error', message: 'POST /api/documents/extract failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      sendError(res, 500, 'EXTRACTION_FAILED', 'Document extraction failed');
    }
  });
}
