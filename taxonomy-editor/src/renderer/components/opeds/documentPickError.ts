// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/632: the plain line the Document field shows when a pick fails (Design p/25#159). The web bridge already throws
// a plain line (webDocumentUpload.ts). On desktop, a failure in main reaches the renderer as Electron's IPC wrapper
// around an ActionableError dump ("Error invoking remote method 'pick-document-file': ActionableError: Goal: …"),
// which carries the user's paths. That text is never shown: the cause is read from it and mapped to Design's copy,
// and the caller records the raw text with a WARN.
//  - A fault in the app (a parser module missing, a permission or child-process failure, IPC) must not blame the
//    file: it gets the "problem in the app, not the file" line.
//  - A cause in the file keeps the file-specific line; "no text" or "unreadable" keeps the scanned-PDF line.

export const SCANNED_PDF_LINE = "Couldn't read text from this file. If it's a scanned PDF it has no text layer: try a text-based PDF or another format.";

const APP_FAULT_MARK = 'because of a problem in the app, not the file.';

export function appFaultLine(name?: string): string {
  const what = name ? `“${name}”` : 'this file';
  return `Couldn't read ${what} ${APP_FAULT_MARK} Try again later, or start from a topic or web page.`;
}

/** True when the shown line is the app-fault line, so the Start reason can point away from the file (Design t/632#4). */
export function isAppFaultLine(line: string | null | undefined): boolean {
  return !!line && line.includes(APP_FAULT_MARK);
}

/** True when the text is not a plain user-facing line: Electron's IPC wrapper, or an ActionableError dump. */
function isRawErrorText(text: string): boolean {
  return /Error invoking remote method/.test(text) || /\bGoal:\s/.test(text) || /\bResolve:\s/.test(text);
}

/** A failure that isn't caused by the file: missing modules, file-system permissions, the isolated child dying
 *  without a reply (isolatedParse: "the extraction process exited (N) without a result"), busy. */
const APP_FAULT = /ENOENT|Cannot find module|MODULE_NOT_FOUND|EACCES|EPERM|ERR_ACCESS_DENIED|spawn|isolated|EXTRACTION_BUSY|EXTRACTION_MEMORY_LIMIT|extraction process exited/i;

function lineForRaw(text: string, name?: string): string {
  if (/password-protected|encrypted/i.test(text)) return 'This file is password-protected. Remove the password, then choose it again.';
  if (/exceeds 10 MB|SIZE_LIMIT_EXCEEDED/.test(text)) return 'This file is over the 10 MB limit.';
  if (/not supported|Could not determine file format|UNSUPPORTED_FORMAT/.test(text)) return "This file isn't a supported file type. Choose a PDF, Word (.docx), text or Markdown file.";
  if (/no extractable text|EMPTY_DOCUMENT/.test(text)) return 'This file has no readable text.';
  if (APP_FAULT.test(text)) return appFaultLine(name);
  return SCANNED_PDF_LINE;
}

/** The line to show for a failed pick: a plain message as given, anything raw mapped to Design's copy. */
export function documentPickErrorLine(err: unknown, name?: string): string {
  const text = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  if (!text.trim()) return SCANNED_PDF_LINE;
  return isRawErrorText(text) ? lineForRaw(text, name) : text;
}
