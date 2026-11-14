// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/393: the isolated child process. The parent forks this file with a heap ceiling and a hard kill, sends one
// message { kind: 'pdf' | 'docx', bytes }, and gets one message back. Nothing else crosses the boundary: no paths, no
// options, no callbacks. A crash or out-of-memory kill loses only this process.

import { parsePdf, parseDocx, ParseError } from './parseCore.mjs';

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
    } else {
      throw new Error(`unknown kind: ${kind}`);
    }
    reply = { ok: true, text: result.text, warnings: result.warnings, rss: process.memoryUsage().rss };
  } catch (error) {
    reply = { ok: false, code: codeOf(error), message: error?.message ?? String(error) };
  }
  process.send(reply, () => process.exit(0));
});
