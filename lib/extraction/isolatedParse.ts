// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/393: PDF and DOCX parsing runs in a child process, not in the server's own process (TL p/35#65). A crafted file
// can hang a parser or exhaust its heap. The parent bounds both: a SIGKILL at the timeout, and a heap ceiling on the
// child. An out-of-memory kill loses only the child. The parent maps every outcome to an ActionableError.

import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ActionableError } from '../debate/errors.js';

/** Hard kill for a parse (TL t/393): a crafted file cannot hold the caller longer than this. */
export const ISOLATED_TIMEOUT_MS = 15_000;
/** The child's V8 heap ceiling (TL t/393). Buffers sit outside the heap, so the input budget bounds them too. */
export const CHILD_HEAP_MB = 256;

/**
 * A path next to this module, given relative to it (e.g. './isolated/child.mjs'). Under vitest the module's own URL
 * can be a dev-server URL rather than a file: URL, so the pathname is used then, with vite's /@fs/ prefix removed.
 * Node always gives a file: URL. Exported so the tests locate their fixtures the same way.
 */
export function resolveFromModule(relative: string): string {
  const url = new URL(relative, import.meta.url);
  if (url.protocol === 'file:') return fileURLToPath(url);
  return decodeURIComponent(url.pathname).replace(/^\/@fs\//, '');
}

const CHILD_PATH = resolveFromModule('./isolated/child.mjs');

export interface IsolatedParseResult {
  text: string;
  warnings: string[];
  /** The child's resident memory when it finished, for tests and diagnostics. */
  childRss?: number;
}

export interface IsolatedParseOptions {
  /** Override the hard-kill timeout (tests). Defaults to ISOLATED_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Run a different child entry (tests: a child that hangs or exhausts its heap). Defaults to child.mjs. */
  childPath?: string;
}

/**
 * Parse a PDF or DOCX in a child process with a heap ceiling and a hard kill.
 * @param kind   'pdf' or 'docx' (DOCX bytes must already be bounded by the caller)
 * @param bytes  the document bytes
 */
export function parseIsolated(
  kind: 'pdf' | 'docx',
  bytes: Uint8Array,
  options: IsolatedParseOptions = {},
): Promise<IsolatedParseResult> {
  return new Promise((resolve, reject) => {
    const child = fork(options.childPath ?? CHILD_PATH, [], {
      execArgv: [`--max-old-space-size=${CHILD_HEAP_MB}`],
      serialization: 'advanced',
      silent: true,
      windowsHide: true, // a GUI parent (Electron) must not flash a console window for the child
    });

    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000); // keep the tail: V8's OOM message is printed last
    });

    let settled = false;
    let timedOut = false;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs ?? ISOLATED_TIMEOUT_MS);

    child.on('message', (reply: any) => {
      settle(() => {
        if (reply.ok) resolve({ text: reply.text, warnings: reply.warnings, childRss: reply.rss });
        else reject(mapChildError(reply.code, reply.message));
      });
    });

    child.on('error', (error) => {
      settle(() => reject(isolatedError('EXTRACTION_FAILED', `the extraction process could not start: ${error.message}`)));
    });

    child.on('exit', (code, signal) => {
      settle(() => {
        if (timedOut) {
          reject(isolatedError('EXTRACTION_TIMEOUT', `extraction exceeded the ${(options.timeoutMs ?? ISOLATED_TIMEOUT_MS) / 1000} s limit and was stopped`));
        } else if (/heap out of memory/i.test(stderr)) {
          reject(isolatedError('EXTRACTION_MEMORY_LIMIT', `extraction ran out of memory (limit ${CHILD_HEAP_MB} MB) and was stopped`));
        } else {
          reject(isolatedError('EXTRACTION_FAILED', `the extraction process exited (${signal ?? code}) without a result`));
        }
      });
    });

    child.send({ kind, bytes });
  });
}

function mapChildError(code: string, message: string): ActionableError {
  if (code === 'ENCRYPTED') {
    return new ActionableError({
      goal: 'Extract text from PDF',
      problem: 'PDF is password-protected or encrypted',
      location: 'lib/extraction:parseIsolated',
      nextSteps: ['Remove password protection', 'Use an unencrypted version of the PDF'],
      code: 'ENCRYPTED_DOCUMENT',
      httpStatus: 422,
    });
  }
  if (code === 'TIMEOUT') return isolatedError('EXTRACTION_TIMEOUT', message);
  return isolatedError('EXTRACTION_FAILED', message);
}

function isolatedError(code: 'EXTRACTION_FAILED' | 'EXTRACTION_TIMEOUT' | 'EXTRACTION_MEMORY_LIMIT', problem: string): ActionableError {
  return new ActionableError({
    goal: 'Extract text from document',
    problem,
    location: 'lib/extraction:parseIsolated',
    nextSteps: ['Try a smaller document', 'Export the document as plain text or DOCX'],
    code,
    httpStatus: 422,
  });
}
