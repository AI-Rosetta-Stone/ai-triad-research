// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/393: the isolated child process. The parent forks this file with a heap ceiling and a hard kill, sends one
// message { kind: 'pdf' | 'docx', bytes }, and gets one message back. Nothing else crosses the boundary: no paths, no
// options, no callbacks. A crash or out-of-memory kill loses only this process.

import { parsePdf, parseDocx, ParseError, MAX_REPLY_CHARS } from './parseCore.mjs';
import { htmlTextFromBytes, plainTextFromBytes } from './textCore.mjs';

/** Map a thrown error to the code the parent understands. */
function codeOf(error) {
  if (error instanceof ParseError) return error.code;
  if (error?.name === 'PasswordException') return 'ENCRYPTED';
  return 'FAILED';
}

process.once('message', async (message) => {
  let reply;
  try {
    const { kind, bytes } = message;
    let result;
    if (kind === 'pdf') {
      const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
      result = await parsePdf(bytes, { getDocument });
    } else if (kind === 'docx') {
      const { extractRawText } = await import('mammoth');
      result = await parseDocx(bytes, { extractRawText });
    } else if (kind === 'html') {
      // t/426: HTML is linear, but it is untrusted input, so it runs in the sandbox like PDF and DOCX.
      result = { text: htmlTextFromBytes(bytes), warnings: [] };
    } else if (kind === 'text') {
      result = { text: plainTextFromBytes(bytes), warnings: [] };
    } else {
      throw new Error(`unknown kind: ${kind}`);
    }
    // The reply is capped: a longer text is cut here with a warning, so the parent never receives an oversized message.
    let text = result.text;
    let warnings = result.warnings;
    if (text.length > MAX_REPLY_CHARS) {
      text = text.slice(0, MAX_REPLY_CHARS);
      warnings = [...warnings, `extracted text was cut to ${MAX_REPLY_CHARS} characters`];
    }
    reply = { ok: true, text, warnings, rss: process.memoryUsage().rss };
  } catch (error) {
    reply = { ok: false, code: codeOf(error), message: error?.message ?? String(error) };
  }
  process.send(reply, () => process.exit(0));
});
