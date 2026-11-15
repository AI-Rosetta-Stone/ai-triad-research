// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/276: the web side of "Upload document". The picked File's bytes are posted to the server's
// extractor. file.text() corrupted PDF and DOCX, so the File itself is sent, never its text.
// The 10 MB cap here is a client courtesy; the server enforces it too and is authoritative.
// The transport is passed in so this module does not import web-bridge (no cycle).

export const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;
const DOCUMENT_EXTENSIONS = ['pdf', 'docx', 'txt', 'md'];

/** Opens the browser file picker. Resolves null when the user cancels. */
export function pickBrowserDocument(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown';
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

/**
 * Posts the File as a binary body and returns the extracted text.
 * `send` performs the request (session recovery, timeout, no retry: an upload is not safe to replay);
 * `assertOk` throws the bridge's standard error for a non-2xx response.
 */
export async function extractDocumentText(file: File, deps: {
  send: (init: RequestInit) => Promise<Response>;
  assertOk: (res: Response) => Promise<void>;
}): Promise<string> {
  checkDocumentFile(file);
  const res = await deps.send({
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Document-Name': encodeURIComponent(file.name) },
    body: file,
  });
  await deps.assertOk(res);
  const body = await res.json() as { text: string };
  return body.text;
}
