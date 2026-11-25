// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/393: PDF and DOCX parsing runs in a child process, not in the server's own process (TL p/35#65). The child parses
// untrusted files, so the boundary is more than resource limits (Security p/102#81):
//   - a minimal environment: none of the server's keys or tokens reach the child;
//   - an empty temporary working directory, removed after the parse;
//   - Node's permission model: no child processes, no network, no writes, and reads only under lib/ and the pnpm store
//     that holds the parsers;
//   - a heap ceiling, a hard SIGKILL at the timeout, and a reply size cap;
//   - one message in and one message out over IPC, with stdout ignored and stderr read.
// The parent maps every outcome to an ActionableError.

import { fork } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ActionableError } from '../debate/errors.js';

/** Hard kill for a parse (TL t/393): a crafted file cannot hold the caller longer than this. */
export const ISOLATED_TIMEOUT_MS = 15_000;
/**
 * The child's V8 heap ceiling (TL t/393). This caps the JavaScript heap only. Buffers and decoded PDF streams sit outside
 * it, so the PDF path has its own memory check between pages (parseCore.mjs) and the DOCX path has the input budget.
 */
export const CHILD_HEAP_MB = 256;
/** The largest text the child may return. The caller truncates to 500k characters anyway. */
export const MAX_REPLY_CHARS = 2_000_000;

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
/** lib/ — the one source tree the child may read. */
const LIB_ROOT = resolve(dirname(CHILD_PATH), '..', '..');

export interface IsolatedParseResult {
  text: string;
  warnings: string[];
  /** The child's resident memory when it finished, for tests and diagnostics. */
  childRss?: number;
}

interface IsolatedParseOptions {
  /** The hard-kill timeout. Production always uses ISOLATED_TIMEOUT_MS; only runChildForTests changes it. */
  timeoutMs?: number;
}

/** The environment the child gets: nothing from the server, except SYSTEMROOT on Windows (Node needs it to start). */
export function childEnvironment(): Record<string, string> {
  if (process.platform !== 'win32') return {};
  return process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {};
}

/**
 * The directory that holds the parsers' own dependencies: the pnpm store (`node_modules/.pnpm`) when lib/ is installed
 * with pnpm, which it is; otherwise lib/node_modules. Read-only, and it holds dependency code only.
 */
function parserStoreRoot(): string {
  return parserStoreRootFor(CHILD_PATH);
}

/**
 * t/631: the store for the parsers as the child will find them, resolved from the child's own location. In the source
 * tree that is lib's pnpm store. In a packed app (app.asar.unpacked) it is the node_modules next to the app's code,
 * because lib/node_modules does not exist there. Exported so a test can run it against a packed-style layout.
 */
export function parserStoreRootFor(fromFile: string): string {
  const req = createRequire(fromFile);
  const pdfjs = realpathSync(req.resolve('pdfjs-dist/package.json'));
  // pnpm store: the .pnpm directory holds every package the parsers need, with their dependencies.
  for (let current = pdfjs; ; current = dirname(current)) {
    if (basename(current) === '.pnpm') return current;
    if (dirname(current) === current) break;
  }
  // No pnpm store (a packed app): the node_modules directory that holds pdfjs-dist.
  for (let current = pdfjs; ; current = dirname(current)) {
    if (basename(current) === 'node_modules') return current;
    if (dirname(current) === current) break;
  }
  throw new Error(`pdfjs-dist resolved to ${pdfjs} without a node_modules directory`);
}

/**
 * The child's Node permission flags: read access to lib/ and the parsers' store, and nothing else. Child processes,
 * network access and writes are denied by the permission model when --permission is set.
 */
export function childPermissionArgs(): string[] {
  // The child loads modules by their real paths. Behind a junction or symlink the given path and the real path differ,
  // so both are granted; otherwise the child cannot read its own files (Quality, t/393).
  const libPaths = new Set([LIB_ROOT, realpathSync(LIB_ROOT)]);
  const grants = [...libPaths, parserStoreRoot()].map((path) => `--allow-fs-read=${path}`);
  return ['--permission', ...grants];
}

/**
 * Parse a PDF or DOCX in a sandboxed child process with a heap ceiling and a hard kill.
 * @param kind   'pdf' or 'docx' (DOCX bytes must already be bounded by the caller)
 * @param bytes  the document bytes
 */
/**
 * Parse a PDF or DOCX in the sandboxed child process, with the heap ceiling and the hard kill. This is the only entry
 * production code uses: the child is always the one in this module, and the timer is always ISOLATED_TIMEOUT_MS.
 * @param kind   'pdf', 'docx', 'html' or 'text' (DOCX bytes must already be bounded by the caller)
 * @param bytes  the document bytes
 */
export function parseIsolated(kind: IsolatedKind, bytes: Uint8Array): Promise<IsolatedParseResult> {
  return runChild(CHILD_PATH, kind, bytes, {});
}

/** The parses the child runs (t/426 added html and text). */
export type IsolatedKind = 'pdf' | 'docx' | 'html' | 'text';

/**
 * TESTS ONLY. Runs a different child script (a probe, a hang, an out-of-memory test child) through the same sandbox and
 * the same fork options. Production code must not call this; it exists so the tests can exercise the boundary.
 */
export function runChildForTests(
  childPath: string,
  kind: IsolatedKind,
  bytes: Uint8Array,
  options: IsolatedParseOptions = {},
): Promise<IsolatedParseResult> {
  return runChild(childPath, kind, bytes, options);
}

/** The most isolated children that may run at once, across all callers in this process (t/274, Security p/232#22). */
export const MAX_CONCURRENT_CHILDREN = 2;
/** The most parses that may wait for a slot. Beyond this a parse is refused with EXTRACTION_BUSY, not queued. */
export const MAX_QUEUED_PARSES = 8;

let activeChildren = 0;
const waitingParses: Array<() => void> = [];

/**
 * Wait for a child slot. The grant is shared by every caller in this process, so the cap holds across callers.
 * Returns the release function, which must be called exactly once when the child is gone.
 */
function acquireChildSlot(): Promise<() => void> {
  return new Promise((resolvePromise, reject) => {
    const grant = () => {
      activeChildren++;
      let released = false;
      resolvePromise(() => {
        if (released) return;
        released = true;
        activeChildren--;
        waitingParses.shift()?.();
      });
    };
    if (activeChildren < MAX_CONCURRENT_CHILDREN) {
      grant();
    } else if (waitingParses.length < MAX_QUEUED_PARSES) {
      waitingParses.push(grant);
    } else {
      reject(isolatedError('EXTRACTION_BUSY', 'too many extractions are running at once; try again in a moment'));
    }
  });
}

/** Children running and parses waiting, for tests and diagnostics. */
export function childSlotStats(): { active: number; queued: number } {
  return { active: activeChildren, queued: waitingParses.length };
}

function runChild(
  childPath: string,
  kind: IsolatedKind,
  bytes: Uint8Array,
  options: IsolatedParseOptions,
): Promise<IsolatedParseResult> {
  return acquireChildSlot().then((release) => spawnChild(childPath, kind, bytes, options).finally(release));
}

// The child itself. The 15 s timer starts here, once the parse holds its slot, so time spent waiting is not charged.
function spawnChild(
  childPath: string,
  kind: IsolatedKind,
  bytes: Uint8Array,
  options: IsolatedParseOptions,
): Promise<IsolatedParseResult> {
  return new Promise((resolvePromise, reject) => {
    // An empty working directory for this parse only. It is removed once the child is gone.
    const workDir = mkdtempSync(join(tmpdir(), 't393-'));
    const child = fork(childPath, [], {
      execArgv: [...childPermissionArgs(), `--max-old-space-size=${CHILD_HEAP_MB}`],
      env: childEnvironment(),
      cwd: workDir,
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'], // stdout is ignored, not piped, so nothing can block the child on it
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
    // The working directory can only go once the child has exited: Windows will not remove a directory a live process
    // is in. So removal happens on exit, after any reply, and is best effort.
    const removeWorkDir = () => {
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch {
        // A leftover empty directory in the temp folder is harmless; the parse result does not depend on it.
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs ?? ISOLATED_TIMEOUT_MS);

    // The reply is held until the child exits, so the result is returned only after the sandbox is torn down.
    let reply: any;
    child.on('message', (message: any) => {
      reply = message;
    });

    child.on('error', (error) => {
      removeWorkDir();
      settle(() => reject(isolatedError('EXTRACTION_FAILED', `the extraction process could not start: ${error.message}`)));
    });

    child.on('exit', (code, signal) => {
      removeWorkDir();
      settle(() => {
        if (timedOut) {
          reject(isolatedError('EXTRACTION_TIMEOUT', `extraction exceeded the ${(options.timeoutMs ?? ISOLATED_TIMEOUT_MS) / 1000} s limit and was stopped`));
        } else if (reply && !reply.ok) {
          reject(mapChildError(reply.code, reply.message));
        } else if (reply) {
          if (typeof reply.text !== 'string' || reply.text.length > MAX_REPLY_CHARS) {
            reject(isolatedError('EXTRACTION_FAILED', 'the extraction process returned more text than the limit allows'));
          } else {
            resolvePromise({ text: reply.text, warnings: reply.warnings, childRss: reply.rss });
          }
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
  if (code === 'MEMORY') return isolatedError('EXTRACTION_MEMORY_LIMIT', message);
  return isolatedError('EXTRACTION_FAILED', message);
}

function isolatedError(
  code: 'EXTRACTION_FAILED' | 'EXTRACTION_TIMEOUT' | 'EXTRACTION_MEMORY_LIMIT' | 'EXTRACTION_BUSY',
  problem: string,
): ActionableError {
  return new ActionableError({
    goal: 'Extract text from document',
    problem,
    location: 'lib/extraction:parseIsolated',
    nextSteps: ['Try a smaller document', 'Export the document as plain text or DOCX'],
    code,
    httpStatus: code === 'EXTRACTION_BUSY' ? 429 : 422,
  });
}
