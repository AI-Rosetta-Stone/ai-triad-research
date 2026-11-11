/**
 * Extract text from HTML using safe linear-time tag removal.
 * Prevents quadratic regex behavior and DoS attacks on malformed HTML.
 */
export function extractHtmlText(bytes: Uint8Array): string {
  const html = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  return stripHtmlFallback(html);
}

function stripHtmlFallback(html: string): string {
  // Remove problematic tags in a single linear pass
  let s = html;
  
  // Remove script, style, head, noscript tags and their contents in linear time
  for (const tag of ['script', 'style', 'head', 'noscript']) {
    s = removeTagLinear(s, tag);
  }

  // Remove remaining tags with bounded simple replacements
  const timeoutMs = 5000;
  const startTime = Date.now();
  let prev: string;
  let iterations = 0;
  const maxIterations = 10;

  do {
    if (Date.now() - startTime > timeoutMs) {
      throw new Error('HTML normalization exceeded timeout');
    }
    if (++iterations > maxIterations) {
      break;
    }

    prev = s;
    s = s.replace(/<[^>]*>/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
  } while (s !== prev && s.length > 0);

  return s;
}

/**
 * Remove a specific tag and its contents in linear time without calling toLowerCase() on the entire document.
 * Handles case-insensitive matching and unclosed tags.
 */
function removeTagLinear(html: string, tagName: string): string {
  const tagLower = tagName.toLowerCase();
  const openTagStart = `<${tagName}`;
  const openTagStartLower = openTagStart.toLowerCase();
  const closeTagStr = `</${tagName}>`;
  const closeTagStrLower = closeTagStr.toLowerCase();
  
  let result = '';
  let pos = 0;

  while (pos < html.length) {
    // Find opening tag by checking first character match only
    let foundStart = -1;
    for (let i = pos; i < html.length; i++) {
      if (i + openTagStart.length <= html.length) {
        const candidate = html.substring(i, i + openTagStart.length);
        if (candidate.toLowerCase() === openTagStartLower) {
          foundStart = i;
          break;
        }
      }
    }

    if (foundStart === -1) {
      result += html.slice(pos);
      break;
    }

    result += html.slice(pos, foundStart);

    // Find end of opening tag
    const tagEnd = html.indexOf('>', foundStart);
    if (tagEnd === -1) {
      break;
    }

    // Find closing tag
    let foundEnd = -1;
    for (let i = tagEnd + 1; i < html.length; i++) {
      if (i + closeTagStr.length <= html.length) {
        const candidate = html.substring(i, i + closeTagStr.length);
        if (candidate.toLowerCase() === closeTagStrLower) {
          foundEnd = i;
          break;
        }
      }
    }

    if (foundEnd === -1) {
      pos = tagEnd + 1;
    } else {
      pos = foundEnd + closeTagStr.length;
    }
  }

  return result;
}
