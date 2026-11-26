// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Element-wise salvage of a JSON array inside a response that failed to parse as a whole (t/774).
 *
 * Before, the fallback parsed each named array in one piece, so a single malformed element (a model
 * glitch such as `Noriginal_disagreement":`) dropped the whole list, and a synthesis showed no
 * agreements at all: a false statement about the debate. Here each top-level element is parsed on
 * its own; good elements are kept and each bad one is reported by index and reason.
 */

export interface DroppedElement { index: number; reason: string }

export interface ArraySalvage {
  /** The key was present in the text with an opening bracket. */
  found: boolean;
  items: unknown[];
  dropped: DroppedElement[];
  /** Indexes of items kept only after the missing-opening-quote repair. */
  repaired: number[];
}

/** A property name that lost its opening quote at the start of a line: `   Nfield": ...` -> `   "Nfield": ...`. */
function repairMissingOpeningQuote(el: string): string {
  return el.replace(/(^|\n)([ \t]*)([A-Za-z_][A-Za-z0-9_]*)"(\s*:)/g, '$1$2"$3"$4');
}

/** Odd number of unescaped quotes on the line containing `i`: a malformed line (the t/774 glitch). */
function lineHasOddQuotes(text: string, i: number): boolean {
  const from = text.lastIndexOf('\n', i - 1) + 1;
  const toNl = text.indexOf('\n', i);
  const line = text.slice(from, toNl < 0 ? text.length : toNl);
  return (line.replace(/\\./g, '').match(/"/g)?.length ?? 0) % 2 === 1;
}

/**
 * Top-level element slices of the array opening at `start` ('['), string-aware. `closed` is false
 * when truncated. A JSON string can't span lines, so string state resets at each newline, and on a
 * line with an odd number of quotes (malformed, e.g. a field name that lost its opening quote)
 * brackets are counted without string tracking, so the stray quote can't swallow the line's
 * closing brace or the rest of the response.
 */
function splitTopLevel(text: string, start: number): { elements: string[]; closed: boolean } {
  const elements: string[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let oddLine = lineHasOddQuotes(text, start);
  let elemStart = start + 1;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n') { inString = false; escaped = false; oddLine = lineHasOddQuotes(text, i + 1); continue; }
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = !oddLine;
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) {
        elements.push(text.slice(elemStart, i));
        return { elements: elements.map(e => e.trim()).filter(Boolean), closed: true };
      }
    } else if (ch === ',' && depth === 1) {
      elements.push(text.slice(elemStart, i));
      elemStart = i + 1;
    }
  }
  elements.push(text.slice(elemStart));
  return { elements: elements.map(e => e.trim()).filter(Boolean), closed: false };
}

function parseError(err: unknown): string {
  return String(err instanceof Error ? err.message : err).slice(0, 120);
}

/** Salvage the array under `key` (`"key": [ ... ]`) element by element. */
export function salvageJsonArray(text: string, key: string): ArraySalvage {
  const m = new RegExp(`"${key}"\\s*:\\s*\\[`).exec(text);
  if (!m) return { found: false, items: [], dropped: [], repaired: [] };
  const start = m.index + m[0].length - 1;
  const { elements, closed } = splitTopLevel(text, start);
  const items: unknown[] = [];
  const dropped: DroppedElement[] = [];
  const repaired: number[] = [];
  elements.forEach((el, index) => {
    const last = index === elements.length - 1;
    try { items.push(JSON.parse(el)); return; } catch (err) {
      if (!closed && last) { dropped.push({ index, reason: 'truncated' }); return; }
      try { items.push(JSON.parse(repairMissingOpeningQuote(el))); repaired.push(index); }
      catch { dropped.push({ index, reason: parseError(err) }); }
    }
  });
  return { found: true, items, dropped, repaired };
}
