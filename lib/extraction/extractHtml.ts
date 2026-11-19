/**
 * Extract text from HTML in one linear pass. The tag and entity passes use no backtracking regex.
 *
 * Every tag becomes a space. The contents of script, style, head and noscript are dropped.
 * Character references (named, &#N; and &#xH;) are decoded after stripping, so "&lt;" becomes text, not a tag.
 * Each index is visited at most once, and a failed lookup is remembered so later lookups
 * never rescan the tail. This keeps unclosed tags from going quadratic (t/273).
 */
export function extractHtmlText(bytes: Uint8Array): string {
  const html = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  return collapseWhitespace(decodeEntities(stripTags(html)));
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};
const MAX_ENTITY_BODY = 10; // longest body between '&' and ';' we accept, e.g. "#x10FFFF"

// Decodes in one left-to-right pass. Each decoded reference is written once and never re-scanned,
// so "&amp;lt;" becomes "&lt;". Unknown or malformed references are kept as written.
function decodeEntities(s: string): string {
  const out: string[] = [];
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

// Index of the ';' that closes a reference starting at `start`, or -1. Looks at most MAX_ENTITY_BODY characters,
// so a run of '&' with no ';' costs constant time each.
function entityEnd(s: string, start: number): number {
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

function decodeEntityBody(body: string): string | null {
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
function allDigits(s: string, hex: boolean): boolean {
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

const DROPPED_ELEMENTS = new Set(['script', 'style', 'head', 'noscript']);
// Block-level closers and <br> become line breaks in blockNewlines mode (URL mode), so paragraphs survive.
const BLOCK_CLOSERS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'tr', 'blockquote']);

/** True when the tag at `lt` is a line break in blockNewlines mode: a block closer, or <br>. */
function breaksLine(lower: string, lt: number): boolean {
  const closing = lower.charCodeAt(lt + 1) === 0x2f; // '/'
  const name = readTagName(lower, lt + (closing ? 2 : 1));
  return closing ? BLOCK_CLOSERS.has(name) : name === 'br';
}

function stripTags(html: string, blockNewlines = false): string {
  // ASCII-only lowercasing keeps indices aligned with `html`; toLowerCase() can change length.
  const lower = html.replace(/[A-Z]+/g, (m) => m.toLowerCase());
  const out: string[] = [];
  const elementsWithoutClose = new Set<string>(); // no closing tag at or after the current position
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

/**
 * HTML to plain text, linear in the input size, for URL mode (t/390). `blockNewlines` keeps paragraph and line breaks
 * (block closers and <br> become "\n"); without it every tag becomes a space, as for document extraction.
 * Script, style, head and noscript contents are dropped. Entities are decoded once, after stripping.
 */
export function htmlToTextLinear(html: string, options: { blockNewlines?: boolean } = {}): string {
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
 */
export function htmlTitleLinear(html: string): string | undefined {
  const lower = html.replace(/[A-Z]+/g, (m) => m.toLowerCase());
  const open = lower.indexOf('<title');
  if (open === -1) return undefined;
  const gt = html.indexOf('>', open + 6);
  if (gt === -1) return undefined;
  const close = lower.indexOf('</title', gt + 1);
  if (close === -1) return undefined;
  const raw = html.slice(gt + 1, close);
  if (raw.includes('<')) return undefined;
  return decodeEntities(raw.trim());
}

/** Decode character references once (exported for the URL-mode converter; see decodeEntities). */
export function decodeHtmlEntities(s: string): string {
  return decodeEntities(s);
}

function isNameChar(code: number): boolean {
  // a-z, 0-9, '-'
  return (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 45;
}

// Returns the lowercase element name at `start`. Stops at the first non-name character,
// so "<header>" reads as "header", not "head".
function readTagName(lower: string, start: number): string {
  let end = start;
  while (end < lower.length && isNameChar(lower.charCodeAt(end))) end++;
  return lower.slice(start, end);
}

// Returns the index of "</name" followed by a non-name character, or -1.
function findClosingTag(lower: string, name: string, from: number): number {
  const needle = `</${name}`;
  let idx = lower.indexOf(needle, from);
  while (idx !== -1 && isNameChar(lower.charCodeAt(idx + needle.length))) {
    idx = lower.indexOf(needle, idx + 1);
  }
  return idx;
}

function collapseWhitespace(s: string): string {
  return s.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
}
