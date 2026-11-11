/**
 * Extract text from HTML in one linear pass. No regex runs on the document.
 *
 * Every tag becomes a space. The contents of script, style, head and noscript are dropped.
 * Each index is visited at most once, and a failed lookup is remembered so later lookups
 * never rescan the tail. This keeps unclosed tags from going quadratic (t/273).
 */
export function extractHtmlText(bytes: Uint8Array): string {
  const html = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  return collapseWhitespace(stripTags(html));
}

const DROPPED_ELEMENTS = new Set(['script', 'style', 'head', 'noscript']);

function stripTags(html: string): string {
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
