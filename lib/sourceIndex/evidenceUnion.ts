// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Evidence union across a duplicate group: `docs/specs/source-identity.md`
 * section 7, fixture `tests/fixtures/evidence-union-cases.json` (t/4337#60,
 * SO e/347#2, TL e/347#3). Pure functions, no I/O. The PowerShell
 * implementation in `scripts/AITriad/Private/EvidenceUnion.ps1` asserts the
 * same fixture — change the spec and fixture first, then update both.
 */

// ── 7.2 de-duplication key ──

// Variant B (UTF-8 read as cp437), applied before variant A: its sequences
// contain U+00F4/U+00F6, which variant A's singles would otherwise consume
// first. Ordered pairs, not a map — JS Map keys are exact by default here,
// but keeping the PS shape (ordered pairs applied in sequence) avoids any
// doubt about collision/ordering parity between the two implementations.
const MOJIBAKE_SEQUENCES: ReadonlyArray<readonly [string, string]> = [
  ['ΓÇÖ', "'"],   // ΓÇÖ — right single quote
  ['ΓÇÿ', "'"],   // ΓÇÿ — left single quote
  ['ΓÇ£', '"'],   // ΓÇ£ — left double quote
  ['ΓÇ¥', '"'],   // ΓÇ¥ — right double quote
  ['ΓÇô', '-'],   // ΓÇô — en dash
  ['ΓÇö', '-'],   // ΓÇö — em dash
  ['ΓÇª', '...'], // ΓÇª — ellipsis
];
const MOJIBAKE_SINGLES: ReadonlyArray<readonly [string, string]> = [
  ['Æ', "'"], ['æ', "'"], // Æ, æ
  ['ô', '"'], ['ö', '"'], // ô, ö
  ['û', '-'], ['ù', '-'], // û, ù
];
const TYPOGRAPHY: ReadonlyArray<readonly [string, string]> = [
  ['‘', "'"], ['’', "'"],
  ['“', '"'], ['”', '"'],
  ['–', '-'], ['—', '-'],
];
const NON_LETTER_DIGIT_RE = /[^\p{L}\p{Nd}]/gu;
const WHITESPACE_RUN_RE = / +/g;

/** Spec 7.2: the de-duplication key of a quote. Used only to compare
 *  quotes — a displayed or stored quote is never the key. A non-string
 *  input (a malformed real-data field the type annotation doesn't
 *  guarantee against) keys as empty — the safe failure mode, since an
 *  empty key is never near-equal to anything and so never suppresses a
 *  link; it only loses the ability to de-dup that one entry. */
export function evidenceKey(quote: string): string {
  if (typeof quote !== 'string' || !quote) return '';
  let s = quote;
  for (const [from, to] of MOJIBAKE_SEQUENCES) s = s.replaceAll(from, to);
  for (const [from, to] of MOJIBAKE_SINGLES) s = s.replaceAll(from, to);
  s = s.normalize('NFKC');
  for (const [from, to] of TYPOGRAPHY) s = s.replaceAll(from, to);
  s = s.toLowerCase();
  s = s.replace(NON_LETTER_DIGIT_RE, ' ');
  return s.replace(WHITESPACE_RUN_RE, ' ').trim();
}

// ── 7.3 near-equal ──

/** Unit-cost Levenshtein distance over UTF-16 code units (spec 7.3 arm 3) —
 *  what JS string indexing already counts, so no conversion is needed. */
function levenshtein(a: string, b: string): number {
  const la = a.length, lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;
  let prev = new Array<number>(lb + 1);
  let cur = new Array<number>(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    const ca = a[i - 1];
    for (let j = 1; j <= lb; j++) {
      const cost = ca === b[j - 1] ? 0 : 1;
      let v = prev[j] + 1;
      if (cur[j - 1] + 1 < v) v = cur[j - 1] + 1;
      if (prev[j - 1] + cost < v) v = prev[j - 1] + cost;
      cur[j] = v;
    }
    [prev, cur] = [cur, prev];
  }
  return prev[lb];
}

/** Spec 7.3: are two de-duplication keys near-equal? Integer thresholds
 *  only, so floating-point rounding can't split the stacks at a boundary. */
export function evidenceNearEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const ta = new Set(a.split(' '));
  const tb = new Set(b.split(' '));
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  if (5 * inter >= 4 * union) return true;
  const m = Math.max(a.length, b.length);
  // Exact shortcut: lev >= |len(a) - len(b)|, so if even that bound fails
  // the threshold, skip the DP.
  if (20 * (m - Math.abs(a.length - b.length)) < 17 * m) return false;
  return 20 * (m - levenshtein(a, b)) >= 17 * m;
}

// ── 7.1 group and links ──

export type EvidenceField = 'key_point' | 'factual_claim' | 'unmapped_concept';

/** One `(node, quote)` link extracted from a summary (spec 7.1). */
export interface EvidenceLink {
  node: string;
  field: EvidenceField;
  quote: string;
}

function isNode(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function firstNonEmptyText(obj: unknown, names: readonly string[]): string {
  if (obj === null || typeof obj !== 'object') return '';
  const rec = obj as Record<string, unknown>;
  for (const name of names) {
    const v = rec[name];
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return '';
}

/** The shape of a summary JSON file the C9 link fields read from
 *  (`scripts/data-mutations/t4337/c9-link-fields.json`). Loosely typed:
 *  real summary files carry many more fields this function ignores. */
export interface SummaryLike {
  pov_summaries?: Record<string, { key_points?: unknown[] } | null | undefined>;
  factual_claims?: unknown[];
  unmapped_concepts?: unknown[];
}

function keyPointLinks(summary: SummaryLike): EvidenceLink[] {
  const links: EvidenceLink[] = [];
  for (const povData of Object.values(summary.pov_summaries ?? {})) {
    for (const kp of (povData?.key_points ?? []) as unknown[]) {
      if (kp === null || typeof kp !== 'object') continue;
      const rec = kp as Record<string, unknown>;
      const node = rec.taxonomy_node_id;
      if (isNode(node)) links.push({ node, field: 'key_point', quote: firstNonEmptyText(rec, ['verbatim', 'point']) });
    }
  }
  return links;
}

function factualClaimLinks(summary: SummaryLike): EvidenceLink[] {
  const links: EvidenceLink[] = [];
  for (const fc of summary.factual_claims ?? []) {
    if (fc === null || typeof fc !== 'object') continue;
    const rec = fc as Record<string, unknown>;
    const quote = firstNonEmptyText(rec, ['claim']);
    for (const field of ['linked_taxonomy_nodes', 'potential_taxonomy_nodes'] as const) {
      for (const node of (rec[field] ?? []) as unknown[]) {
        if (isNode(node)) links.push({ node, field: 'factual_claim', quote });
      }
    }
  }
  return links;
}

function unmappedConceptLinks(summary: SummaryLike): EvidenceLink[] {
  const links: EvidenceLink[] = [];
  for (const uc of summary.unmapped_concepts ?? []) {
    if (uc === null || typeof uc !== 'object') continue;
    const rec = uc as Record<string, unknown>;
    const node = rec.resolved_node_id;
    if (isNode(node)) {
      links.push({
        node, field: 'unmapped_concept',
        quote: firstNonEmptyText(rec, ['verbatim', 'suggested_description', 'description', 'concept', 'suggested_label']),
      });
    }
  }
  return links;
}

/** Spec 7.1: the `(node, quote)` links of one summary, in file order —
 *  `pov_summaries` key order, then each field's array order. */
export function extractSummaryEvidenceLinks(summary: SummaryLike | null | undefined): EvidenceLink[] {
  if (!summary) return [];
  return [...keyPointLinks(summary), ...factualClaimLinks(summary), ...unmappedConceptLinks(summary)];
}

// ── 7.4 union ──

export interface EvidenceLinkLike {
  node: string;
  quote: string;
}

/** A group member: its exact id and its links, in any order — spec 7.1
 *  order (the canonical first, then marked members by ordinal id) is
 *  applied inside `mergeGroupEvidence`, not by the caller. */
export interface EvidenceUnionMember<T extends EvidenceLinkLike> {
  id: string;
  links: readonly T[];
}

/** A kept link, attributed to the canonical. `via` is set only on a link
 *  kept from a marked member — provenance, never shown, never stored over
 *  an exact id (spec 7.6).
 *
 *  FORENSICS ONLY on the TS side: nothing here, in `nodeSourceIndex.ts`, or
 *  in the Electron equivalent branches on `via` to make a decision. THE
 *  EXEMPTION LAPSES the moment a TS consumer reads `via` to make a
 *  decision (routing, filtering, counting). Spec 7.6 already names the one
 *  accepted branching reader project-wide — PowerShell's entity-extraction
 *  skip — any additional branching reader, in either stack, is a contract
 *  change to spec section 7.6, not a silent addition. */
export type UnionedEvidenceLink<T extends EvidenceLinkLike> = T & { doc: string; via?: string };

/**
 * Spec 7.4: the de-duplicated union of a duplicate group's links, attributed
 * to the canonical. Generic over the link payload `T` (which must carry at
 * least `node` and `quote`) so a caller's richer link shape — extra display
 * fields a `{node, field, quote}` triple doesn't have — round-trips through
 * untouched.
 *
 * - The canonical's own links are all kept, in order, unchanged, including
 *   repeats — never de-duped against each other.
 * - Marked members are processed in ordinal id order (not the order passed
 *   in), each in its own link order. A member's link is kept only if it
 *   isn't near-equal (7.3) to any link already kept on that node — the
 *   canonical wins ties, because its links are kept first.
 * - De-dup is per node; node order isn't significant.
 */
export function mergeGroupEvidence<T extends EvidenceLinkLike>(
  canonicalId: string, members: readonly EvidenceUnionMember<T>[],
): Record<string, Array<UnionedEvidenceLink<T>>> {
  const canonicalMembers = members.filter(m => m.id === canonicalId);
  const marked = [...members.filter(m => m.id !== canonicalId)].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const out: Record<string, Array<UnionedEvidenceLink<T>>> = {};
  const keysByNode = new Map<string, string[]>();

  for (const m of [...canonicalMembers, ...marked]) {
    const own = m.id === canonicalId;
    for (const link of m.links) {
      const key = evidenceKey(link.quote);
      if (!out[link.node]) { out[link.node] = []; keysByNode.set(link.node, []); }
      const keys = keysByNode.get(link.node)!;
      if (!own && keys.some(k => evidenceNearEqual(key, k))) continue;
      const entry = { ...link, doc: canonicalId } as UnionedEvidenceLink<T>;
      if (!own) entry.via = m.id;
      out[link.node].push(entry);
      keys.push(key);
    }
  }

  return out;
}
