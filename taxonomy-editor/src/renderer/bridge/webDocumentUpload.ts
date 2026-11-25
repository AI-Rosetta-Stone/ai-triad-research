// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/276: the web side of "Upload document". The picked File's bytes are posted to the server's
// extractor. file.text() corrupted PDF and DOCX, so the File itself is sent, never its text.
// The 10 MB cap here is a client courtesy; the server enforces it too and is authoritative.
// The transport is passed in so this module does not import web-bridge (no cycle).

import { getGlobalRecorder } from '@lib/flight-recorder/index';

export const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;
// html/htm stay accepted: the server still extracts them, and the old picker offered them.
const DOCUMENT_EXTENSIONS = ['pdf', 'docx', 'html', 'htm', 'txt', 'md'];

/** Opens the browser file picker. Resolves null when the user cancels. */
export function pickBrowserDocument(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pdf,.docx,.html,.htm,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/html,text/plain,text/markdown';
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/** Refuses an unsupported type or an oversize file before anything is uploaded. */
export function checkDocumentFile(file: File): void {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (!DOCUMENT_EXTENSIONS.includes(ext)) {
    throw new Error(`“${file.name}” isn't a supported file type. Choose a PDF, Word (.docx), text or Markdown file.`);
  }
  if (file.size > DOCUMENT_MAX_BYTES) {
    throw new Error(`“${file.name}” is ${(file.size / (1024 * 1024)).toFixed(1)} MB. The limit is 10 MB.`);
  }
}

/** The plain line the Document field shows for a failed extraction. The server's own `error` text is an
 *  ActionableError dump (Goal / Error / Location / Resolve), so it is never shown; the status and code pick
 *  the copy instead. */
export function documentExtractErrorMessage(status: number, code: string | undefined, fileName: string): string {
  if (status === 401) return 'Sign in to upload a document.';
  if (status === 413 || code === 'SIZE_LIMIT_EXCEEDED') return `“${fileName}” is over the 10 MB limit.`;
  if (status === 415 || code === 'UNSUPPORTED_FORMAT') return `“${fileName}” isn't a supported file type. Choose a PDF, Word (.docx), text or Markdown file.`;
  if (code === 'ENCRYPTED_DOCUMENT') return `“${fileName}” is password-protected. Remove the password, then choose it again.`;
  if (code === 'EMPTY_DOCUMENT') return 'This file has no readable text.';
  if (status === 429 || code === 'EXTRACTION_BUSY') return 'The server is busy reading other documents. Try again in a minute.';
  return "Couldn't read text from this file. If it's a scanned PDF it has no text layer: try a text-based PDF or another format.";
}

/**
 * Posts the File as a binary body and returns the extracted text.
 * `send` performs the request (session recovery, timeout, no retry: an upload is not safe to replay).
 * A non-2xx answer throws an Error whose message is the plain line from documentExtractErrorMessage;
 * The raw status, code and server text go to the flight recorder with a WARN.
 */
export async function extractDocumentText(file: File, deps: {
  send: (init: RequestInit) => Promise<Response>;
}): Promise<string> {
  checkDocumentFile(file);
  const res = await deps.send({
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Document-Name': encodeURIComponent(file.name) },
    body: file,
  });
  if (!res.ok) {
    let parsed: { code?: unknown; error?: unknown } = {};
    try {
      parsed = await res.json() as { code?: unknown; error?: unknown };
    } catch { /* telemetry — silent by design: a non-JSON error body still gets the status-based line below */ }
    const code = typeof parsed.code === 'string' ? parsed.code : undefined;
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'web-bridge', level: 'warn',
      message: `WARN: POST /api/documents/extract failed with HTTP ${res.status}${code ? ` (${code})` : ''}; showing the plain line, not the server text`,
      error: { name: 'DocumentExtractError', message: typeof parsed.error === 'string' ? parsed.error : `HTTP ${res.status}`, stack: undefined },
    });
    throw new Error(documentExtractErrorMessage(res.status, code, file.name));
  }
  // A 200 that isn't JSON is the sign-in page served in place of the API (an expired session behind
  // the auth proxy). Parsing it would surface a raw SyntaxError, so it gets the sign-in line (Quality p/57#90).
  if (!(res.headers.get('content-type') ?? '').includes('application/json')) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'web-bridge', level: 'warn',
      message: `WARN: POST /api/documents/extract answered ${res.status} with ${res.headers.get('content-type') ?? 'no content-type'}; treating it as a lost session`,
    });
    throw new Error(documentExtractErrorMessage(401, undefined, file.name));
  }
  const body = await res.json() as { text: string };
  return body.text;
}
