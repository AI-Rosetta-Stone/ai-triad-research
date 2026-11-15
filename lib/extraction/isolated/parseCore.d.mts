// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Declarations for parseCore.mjs (t/393), so TypeScript callers and tests can import it.

export const MAX_PDF_PAGES: number;
export const PDF_TIME_BUDGET_MS: number;
export const PDF_MEMORY_BUDGET_BYTES: number;
export const MAX_REPLY_CHARS: number;

export function defaultMemory(): number;

/** An error with a code the parent maps to an ActionableError. */
export class ParseError extends Error {
  readonly code: 'TIMEOUT' | 'MEMORY' | 'FAILED';
  constructor(code: 'TIMEOUT' | 'MEMORY' | 'FAILED', message: string);
}

export interface ParseResult {
  text: string;
  warnings: string[];
}

export function parsePdf(
  bytes: Uint8Array,
  deps: {
    getDocument: (opts: { data: Uint8Array }) => { promise: Promise<any> };
    now?: () => number;
    memory?: () => number;
  },
): Promise<ParseResult>;

export function parseDocx(
  bytes: Uint8Array,
  deps: { extractRawText: (opts: { buffer: Buffer }) => Promise<{ value: string }> },
): Promise<ParseResult>;
