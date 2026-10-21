// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Read-side repair of console-code-page mojibake in snapshot bodies (t/4394).
 *
 * PDF snapshots written before PR #3671 may contain one of two variants:
 *   - 'cp1252-as-cp437': Python wrote CP1252 bytes; markitdown stdout was decoded as CP437.
 *     U+2019 (') appears as U+00C6 (Æ), curly quotes as ô/ö, dashes as û/ù.
 *   - 'utf8-as-cp437': Python wrote UTF-8 bytes; stdout decoded as CP437.
 *     U+2019 (') appears as ΓÇÖ (U+0393 U+00C7 U+00D6).
 *
 * Both invert exactly: re-encode the body's char values back to CP437 bytes, then decode
 * as the encoding Python actually wrote (UTF-8 or CP1252).
 *
 * The wrapper (HTML comment + metadata block before the first '---' rule line) is clean UTF-8
 * written by our tooling, never by markitdown. It is never touched.
 *
 * READ PATHS ONLY. Never apply this to a hashing path — content_sha256 is computed over
 * the snapshot as written on disk (source-identity spec 1.1).
 *
 * Reference: scripts/AITriad/Private/Repair-SnapshotMojibake.ps1 (PR #3671, t/4394).
 * Conformance: mirrors the 12 gate cases in tests/Repair-SnapshotMojibake.Tests.ps1.
 */

export type MojibakedVariant = 'none' | 'utf8-as-cp437' | 'cp1252-as-cp437';

export interface SnapshotRepairResult {
  text: string;
  variant: MojibakedVariant;
}

// ── CP437 byte 0x80..0xFF → Unicode code point ────────────────────────────
// One entry per byte, indexed as byte - 0x80. Source: IBM Code Page 437.

const CP437_HIGH: readonly number[] = [
  // 0x80-0x8F: Latin extended (Western European)
  0x00C7, 0x00FC, 0x00E9, 0x00E2, 0x00E4, 0x00E0, 0x00E5, 0x00E7,
  0x00EA, 0x00EB, 0x00E8, 0x00EF, 0x00EE, 0x00EC, 0x00C4, 0x00C5,
  // 0x90-0x9F
  0x00C9, 0x00E6, 0x00C6, 0x00F4, 0x00F6, 0x00F2, 0x00FB, 0x00F9,
  0x00FF, 0x00D6, 0x00DC, 0x00A2, 0x00A3, 0x00A5, 0x20A7, 0x0192,
  // 0xA0-0xAF: Latin extended + special
  0x00E1, 0x00ED, 0x00F3, 0x00FA, 0x00F1, 0x00D1, 0x00AA, 0x00BA,
  0x00BF, 0x2310, 0x00AC, 0x00BD, 0x00BC, 0x00A1, 0x00AB, 0x00BB,
  // 0xB0-0xBF: shade blocks + box-drawing (single-line)
  0x2591, 0x2592, 0x2593, 0x2502, 0x2524, 0x2561, 0x2562, 0x2556,
  0x2555, 0x2563, 0x2551, 0x2557, 0x255D, 0x255C, 0x255B, 0x2510,
  // 0xC0-0xCF: box-drawing (mixed single/double)
  0x2514, 0x2534, 0x252C, 0x251C, 0x2500, 0x253C, 0x255E, 0x255F,
  0x255A, 0x2554, 0x2569, 0x2566, 0x2560, 0x2550, 0x256C, 0x2567,
  // 0xD0-0xDF: box-drawing + block elements
  0x2568, 0x2564, 0x2565, 0x2559, 0x2558, 0x2552, 0x2553, 0x256B,
  0x256A, 0x2518, 0x250C, 0x2588, 0x2584, 0x258C, 0x2590, 0x2580,
  // 0xE0-0xEF: Greek letters + misc math
  0x03B1, 0x00DF, 0x0393, 0x03C0, 0x03A3, 0x03C3, 0x00B5, 0x03C4,
  0x03A6, 0x0398, 0x03A9, 0x03B4, 0x221E, 0x03C6, 0x03B5, 0x2229,
  // 0xF0-0xFF: math symbols + special
  0x2261, 0x00B1, 0x2265, 0x2264, 0x2320, 0x2321, 0x00F7, 0x2248,
  0x00B0, 0x2219, 0x00B7, 0x221A, 0x207F, 0x00B2, 0x25A0, 0x00A0,
];

// Inverse map: Unicode code point → CP437 byte (for 0x80-0xFF range only).
const CP437_INVERSE = new Map<number, number>(
  CP437_HIGH.map((cp, i) => [cp, 0x80 + i]),
);

/** Returns the CP437 byte for a char code, or -1 if the char is not in CP437. */
function charCodeToCp437(code: number): number {
  if (code <= 0x7F) return code; // ASCII identity
  return CP437_INVERSE.get(code) ?? -1;
}

// ── CP1252 byte 0x80-0x9F → Unicode code point ────────────────────────────
// null = byte undefined in CP1252 (0x81, 0x8D, 0x8F, 0x90, 0x9D).

const CP1252_HIGH_SUPPLEMENT: readonly (number | null)[] = [
  // 0x80-0x8F
  0x20AC, null,   0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021,
  0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, null,   0x017D, null,
  // 0x90-0x9F
  null,   0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014,
  0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, null,   0x017E, 0x0178,
];

/** Decode a CP1252 byte to a Unicode code point, or null for undefined bytes. */
function cp1252ByteToCodePoint(byte: number): number | null {
  if (byte <= 0x7F) return byte;
  if (byte <= 0x9F) return CP1252_HIGH_SUPPLEMENT[byte - 0x80] ?? null;
  return byte; // 0xA0-0xFF identical to Latin-1 / Unicode BMP
}

// ── Smart punctuation sets (gate logic) ───────────────────────────────────

const SMART_CHARS = new Set([0x2019, 0x201C, 0x201D, 0x2013, 0x2014]);

// CP437 representations of CP1252 smart-punctuation bytes (0x91-0x97):
// 0x91→æ 0x92→Æ 0x93→ô 0x94→ö 0x96→û 0x97→ù; also 0xE9→Θ (é in CP1252)
const VARIANT_A_CHARS = new Set([0x00C6, 0x00E6, 0x00F4, 0x00F6, 0x00FB, 0x00F9, 0x0398]);

// Two-character B-arm signature: Γ (U+0393, CP437 0xE2) + Ç (U+00C7, CP437 0x80).
// The first two bytes of any UTF-8 char whose lead byte is 0xE2 (e.g. U+2019 = E2 80 99).
const B_LEAD = 'ΓÇ';

// ── Lenient UTF-8 decoder ─────────────────────────────────────────────────

/**
 * Decode CP437 bytes as UTF-8, keeping the original CP437-mapped character for
 * each invalid or incomplete sequence. One byte per char — guaranteed by the gate.
 */
function lenientUtf8Decode(bytes: Uint8Array, originalBody: string): string {
  const parts: string[] = [];
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i];
    if (b0 < 0x80) { parts.push(String.fromCharCode(b0)); i++; continue; }

    let seqLen = 0;
    if (b0 >= 0xC2 && b0 <= 0xDF) seqLen = 2;
    else if (b0 >= 0xE0 && b0 <= 0xEF) seqLen = 3;
    else if (b0 >= 0xF0 && b0 <= 0xF4) seqLen = 4;

    if (seqLen > 0 && i + seqLen <= bytes.length) {
      try {
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes.slice(i, i + seqLen));
        parts.push(decoded);
        i += seqLen;
        continue;
      } catch { /* invalid sequence — keep original char below */ }
    }
    // Keep the CP437-mapped char for this byte position (one byte = one char by gate invariant).
    parts.push(originalBody[i]);
    i++;
  }
  return parts.join('');
}

// ── Helpers ───────────────────────────────────────────────────────────────

/** Split at the first YAML-rule separator; wrapper (head) is clean UTF-8 and never touched. */
function splitAtFirstRule(text: string): { head: string; body: string } {
  const m = /\r?\n---\r?\n/.exec(text);
  return m
    ? { head: text.slice(0, m.index + m[0].length), body: text.slice(m.index + m[0].length) }
    : { head: '', body: text };
}

// ── Main export ───────────────────────────────────────────────────────────

/**
 * Lossless read-side repair of console-code-page mojibake in a snapshot body.
 * Returns the repaired text and the detected variant ('none' if clean).
 */
export function repairSnapshotMojibake(text: string): SnapshotRepairResult {
  if (!text) return { text, variant: 'none' };

  // 1. Split at the first '\n---\n' rule: the wrapper is clean UTF-8, never touched.
  const { head, body } = splitAtFirstRule(text);

  // 2. Only a body with non-ASCII that is wholly CP437-encodable can be this mojibake.
  if (!/[^\x00-\x7F]/.test(body)) return { text, variant: 'none' };

  const bytes = new Uint8Array(body.length);
  for (let i = 0; i < body.length; i++) {
    const b = charCodeToCp437(body.charCodeAt(i));
    if (b < 0) return { text, variant: 'none' };
    bytes[i] = b;
  }

  // 3. Strict UTF-8: decode bytes as UTF-8. Checked first — its bytes often also decode
  //    as CP1252, which would be wrong.
  try {
    const asUtf8 = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (asUtf8 !== body) return { text: head + asUtf8, variant: 'utf8-as-cp437' };
  } catch { /* not valid strict UTF-8 — fall through */ }

  // 3b. Lenient UTF-8: only when there are ≥3 ΓÇ (U+0393 U+00C7) signatures.
  //     Handles corpus docs where one broken byte made the strict arm reject the whole body.
  let bLeadCount = 0;
  let scanPos = 0;
  while ((scanPos = body.indexOf(B_LEAD, scanPos)) !== -1) { bLeadCount++; scanPos += B_LEAD.length; }

  if (bLeadCount >= 3) {
    const lenient = lenientUtf8Decode(bytes, body);
    if (lenient !== body) return { text: head + lenient, variant: 'utf8-as-cp437' };
  }

  // 4. CP1252: decode the CP437 bytes as CP1252. Gate: smart punctuation must increase,
  //    the body must contain a Variant-A char, and the result must show typographic evidence.
  const cp1252Parts: string[] = [];
  for (const b of bytes) {
    const cp = cp1252ByteToCodePoint(b);
    if (cp === null) return { text, variant: 'none' };
    cp1252Parts.push(String.fromCodePoint(cp));
  }
  const asCp1252 = cp1252Parts.join('');

  const smartGain = countSmartChars(asCp1252) > countSmartChars(body);
  const hasVariantAChar = [...body].some(c => VARIANT_A_CHARS.has(c.codePointAt(0) ?? -1));
  if (smartGain && hasVariantAChar && isTypographic(asCp1252)) {
    return { text: head + asCp1252, variant: 'cp1252-as-cp437' };
  }

  return { text, variant: 'none' };
}

function countSmartChars(s: string): number {
  let n = 0;
  for (const c of s) if (SMART_CHARS.has(c.codePointAt(0) ?? -1)) n++;
  return n;
}

function isTypographic(s: string): boolean {
  if (/[A-Za-z]’[A-Za-z]/.test(s)) return true;                // in-word apostrophe
  if (s.includes('“') && s.includes('”')) return true;    // both curly double quotes
  if (/[A-Za-z]—[A-Za-z]/.test(s)) return true;               // em dash between letters
  if (/ [–—] /.test(s)) return true;            // spaced en/em dash — match " – " or " — "
  if (/\d–\d/.test(s)) return true;                            // en dash between digits
  return false;
}
