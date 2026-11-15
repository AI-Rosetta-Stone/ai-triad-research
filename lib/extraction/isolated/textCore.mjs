// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/426: HTML and plain-text document extraction as plain JavaScript, so the isolated child can run it (child.mjs). The
// HTML pass is the linear one already on main and must not change behaviour. extractHtml.ts and extractPlain.ts re-export
// these for in-process callers and tests. Parsing untrusted input goes through the child (../isolatedParse.ts).
// URL-mode HTML (lib/url-fetch) is not here: it is t/390's change and stays in its own ticket.

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};
const MAX_ENTITY_BODY = 10; // longest body between '&' and ';' we accept, e.g. "#x10FFFF"
const DROPPED_ELEMENTS = new Set(['script', 'style', 'head', 'noscript']);

/**
 * Plain text (TXT, MD) with UTF-8 and UTF-16 BOM detection. UTF-8 invalid sequences are replaced, never thrown.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function plainTextFromBytes(bytes) {
  if (bytes.length >= 2) {
    // UTF-16 LE BOM: 0xFF 0xFE
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      try {
        return new TextDecoder('utf-16le').decode(bytes.slice(2));
      } catch {
        // Fall through
      }
    }
    // UTF-16 BE BOM: 0xFE 0xFF
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      try {
        return new TextDecoder('utf-16be').decode(bytes.slice(2));
      } catch {
        // Fall through
      }
    }
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

/**
 * HTML bytes to plain text, for document extraction: every tag becomes a space, script/style/head/noscript are dropped.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function htmlTextFromBytes(bytes) {
  const html = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  return collapseWhitespace(decodeEntities(stripTags(html)));
}

// Decodes in one left-to-right pass. Each decoded reference is written once and never re-scanned,
// so "&amp;lt;" becomes "&lt;". Unknown or malformed references are kept as written.
export function decodeEntities(s) {
  const out = [];
  let copyFrom = 0;
  let amp = s.indexOf('&');
  while (amp !== -1) {
    const semi = entityEnd(s, amp + 1);
    const decoded = semi === -1 ? null : decodeEntityBody(s.slice(amp + 1, semi));
    if (decoded === null) {
      amp = s.indexOf('&', amp + 1);
      continue;
    }
    out.push(s.slice(copyFrom, amp), decoded);
    copyFrom = semi + 1;
    amp = s.indexOf('&', copyFrom);
  }
  out.push(s.slice(copyFrom));
  return out.join('');
}

// Index of the ';' that closes a reference starting at `start`, or -1. Looks at most MAX_ENTITY_BODY characters.
function entityEnd(s, start) {
  const limit = Math.min(s.length, start + MAX_ENTITY_BODY + 1);
  for (let i = start; i < limit; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x3b) {
      return i; // ';'
    }
    const isLetterOrDigit = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
    if (!isLetterOrDigit && c !== 0x23) {
      return -1; // '#'
    }
  }
  return -1;
}

function decodeEntityBody(body) {
  if (body.startsWith('#')) {
    const hex = body[1] === 'x' || body[1] === 'X';
    const digits = body.slice(hex ? 2 : 1);
    if (!allDigits(digits, hex)) {
      return null;
    }
    const codePoint = parseInt(digits, hex ? 16 : 10);
    if (codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      return null;
    }
    return String.fromCodePoint(codePoint);
  }
  return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : null;
}

// True for a non-empty run of decimal digits (or hex digits when `hex`).
function allDigits(s, hex) {
  if (s.length === 0) {
    return false;
  }
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const isDecimal = c >= 48 && c <= 57;
    const isHex = (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
    if (!isDecimal && !(hex && isHex)) {
      return false;
    }
  }
  return true;
}

function stripTags(html) {
  // ASCII-only lowercasing keeps indices aligned with `html`; toLowerCase() can change length.
  const lower = html.replace(/[A-Z]+/g, (m) => m.toLowerCase());
  const out = [];
  const elementsWithoutClose = new Set(); // no closing tag at or after the current position
  let noGreaterThan = false; // no '>' at or after the current position
  let copyFrom = 0;
  let pos = 0;

  for (let lt = html.indexOf('<'); lt !== -1; lt = html.indexOf('<', pos)) {
    const gt = noGreaterThan ? -1 : html.indexOf('>', lt + 1);
    if (gt === -1) {
      // An unterminated "<" is ordinary text.
      noGreaterThan = true;
      pos = lt + 1;
      continue;
    }

    const name = readTagName(lower, lt + 1);
    let end = gt + 1;
    if (DROPPED_ELEMENTS.has(name) && !elementsWithoutClose.has(name)) {
      const close = findClosingTag(lower, name, gt + 1);
      if (close === -1) {
        // Unclosed: drop only the opening tag and keep the content, as before.
        elementsWithoutClose.add(name);
      } else {
        const closeGt = html.indexOf('>', close);
        end = closeGt === -1 ? html.length : closeGt + 1;
      }
    }

    out.push(html.slice(copyFrom, lt), ' ');
    copyFrom = end;
    pos = end;
  }

  out.push(html.slice(copyFrom));
  return out.join('');
}

function isNameChar(code) {
  // a-z, 0-9, '-'
  return (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 45;
}

// Returns the lowercase element name at `start`. Stops at the first non-name character,
// so "<header>" reads as "header", not "head".
function readTagName(lower, start) {
  let end = start;
  while (end < lower.length && isNameChar(lower.charCodeAt(end))) end++;
  return lower.slice(start, end);
}

// Returns the index of "</name" followed by a non-name character, or -1.
function findClosingTag(lower, name, from) {
  const needle = `</${name}`;
  let idx = lower.indexOf(needle, from);
  while (idx !== -1 && isNameChar(lower.charCodeAt(idx + needle.length))) {
    idx = lower.indexOf(needle, idx + 1);
  }
  return idx;
}

function collapseWhitespace(s) {
  return s.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
}
