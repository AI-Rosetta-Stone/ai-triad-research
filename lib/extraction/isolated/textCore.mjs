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
// Block-level closers and <br> become line breaks in blockNewlines mode (URL mode), so paragraphs survive.
const BLOCK_CLOSERS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'tr', 'blockquote']);

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

/**
 * HTML to plain text, linear in the input size, for URL mode (t/390). `blockNewlines` keeps paragraph and line breaks
 * (block closers and <br> become "\n"); without it every tag becomes a space, as for document extraction.
 * Script, style, head and noscript contents are dropped. Entities are decoded once, after stripping.
 * @param {string} html
 * @param {{ blockNewlines?: boolean }} [options]
 * @returns {string}
 */
export function htmlToTextLinear(html, options = {}) {
  if (options.blockNewlines !== true) return collapseWhitespace(decodeEntities(stripTags(html)));
  const text = decodeEntities(stripTags(html, true));
  return text
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The document <title>, linear (t/390): the first "<title ...>text</title>" with no tag inside the text. Entities are
 * decoded. A title whose text contains a tag is treated as absent, as the regex it replaces did.
 * @param {string} html
 * @returns {string | undefined}
 */
export function htmlTitleLinear(html) {
  const lower = html.replace(/[A-Z]+/g, (m) => m.toLowerCase());
  // t/446: "<titlebar>" and "</titles>" are other elements. The name must end at '>', '/' or whitespace.
  const open = nextTagNamed(lower, '<title', 0);
  if (open === -1) return undefined;
  const gt = html.indexOf('>', open + 6);
  if (gt === -1) return undefined;
  const close = nextTagNamed(lower, '</title', gt + 1);
  if (close === -1) return undefined;
  const raw = html.slice(gt + 1, close);
  if (raw.includes('<')) return undefined;
  return decodeEntities(raw.trim());
}

// Index of the first `prefix` at or after `from` whose name ends there: the next character is '>', '/' or whitespace.
// Each search resumes after the rejected match, so the scan stays linear.
function nextTagNamed(lower, prefix, from) {
  let at = lower.indexOf(prefix, from);
  while (at !== -1) {
    const next = lower.charCodeAt(at + prefix.length);
    // '>' 0x3e, '/' 0x2f, space, tab, LF, CR, FF
    if (next === 0x3e || next === 0x2f || next === 0x20 || next === 0x09 || next === 0x0a || next === 0x0d || next === 0x0c) {
      return at;
    }
    at = lower.indexOf(prefix, at + 1);
  }
  return -1;
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

/** True when the tag at `lt` is a line break in blockNewlines mode: a block closer, or <br>. */
function breaksLine(lower, lt) {
  const closing = lower.charCodeAt(lt + 1) === 0x2f; // '/'
  const name = readTagName(lower, lt + (closing ? 2 : 1));
  return closing ? BLOCK_CLOSERS.has(name) : name === 'br';
}

function stripTags(html, blockNewlines = false) {
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
    let separator = blockNewlines && breaksLine(lower, lt) ? '\n' : ' ';
    if (DROPPED_ELEMENTS.has(name) && !elementsWithoutClose.has(name)) {
      separator = ' ';
      const close = findClosingTag(lower, name, gt + 1);
      if (close === -1) {
        // Unclosed: drop only the opening tag and keep the content, as before.
        elementsWithoutClose.add(name);
      } else {
        const closeGt = html.indexOf('>', close);
        end = closeGt === -1 ? html.length : closeGt + 1;
      }
    }

    out.push(html.slice(copyFrom, lt), separator);
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
