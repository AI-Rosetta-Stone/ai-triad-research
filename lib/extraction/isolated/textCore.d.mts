// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Declarations for textCore.mjs (t/426).

export function plainTextFromBytes(bytes: Uint8Array): string;
export function htmlTextFromBytes(bytes: Uint8Array): string;
export function decodeEntities(s: string): string;
export function htmlToTextLinear(html: string, options?: { blockNewlines?: boolean }): string;
export function htmlTitleLinear(html: string): string | undefined;
