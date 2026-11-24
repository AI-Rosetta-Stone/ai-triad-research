// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { ActionableError } from '../debate/errors.js';

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

/** A group member: its exact id and its links, in any order. `kind` and `viaCopy` come from
 *  `groupMembers` (spec 7.1). With no `kind` a member is a marked copy, as on the PowerShell side.
 *  `chunkGeneratedAt` and `chunkModel` are the chunk summary's own provenance (spec 7.6a), optional. */
export interface EvidenceUnionMember<T extends EvidenceLinkLike> {
  id: string;
  links: readonly T[];
  kind?: GroupMemberKind;
  /** For a `chunk_copy`: the marked copy whose chunk this is. */
  viaCopy?: string;
  chunkGeneratedAt?: string;
  chunkModel?: string;
}

/** A kept link, attributed to the canonical. `via` is set only on a link
 *  kept from a marked member; `chunk_of` only on a link kept from a chunk of
 *  the canonical itself (spec 7.6, 7.6a). A link never carries both.
 *
 *  FORENSICS ONLY on the TS side: nothing here, in `nodeSourceIndex.ts`, or
 *  in the Electron equivalent branches on `via` or `chunk_of` to make a decision. THE
 *  EXEMPTION LAPSES the moment a TS consumer reads `via` to make a
 *  decision (routing, filtering, counting). Spec 7.6 already names the one
 *  accepted branching reader project-wide — PowerShell's entity-extraction
 *  skip — any additional branching reader, in either stack, is a contract
 *  change to spec section 7.6, not a silent addition. `chunk_of`,
 *  `chunk_generated_at` and `chunk_model` are provenance too: nothing branches
 *  on them (spec 7.6a). */
export type UnionedEvidenceLink<T extends EvidenceLinkLike> = T & {
  doc: string;
  via?: string;
  chunk_of?: string;
  chunk_generated_at?: string;
  chunk_model?: string;
};

// ── 6.2 resolver and 7.1 group (t/355, R1/R2) ──

/** A document's record in the group index: whether it has a source dir, and its mark. */
export interface EvidenceDoc {
  has_source: boolean;
  mark?: string | null;
}

export type GroupMemberKind = 'copy' | 'chunk_D' | 'chunk_copy';

function docOf(docs: Readonly<Record<string, EvidenceDoc>>, id: string): EvidenceDoc | undefined {
  return Object.prototype.hasOwnProperty.call(docs, id) ? docs[id] : undefined;
}

/** Spec 6.2 (t/355, R1): the base X when `id` is a summary-only chunk `<X>-N` of X, else null. */
export function chunkBase(id: string, docs: Readonly<Record<string, EvidenceDoc>>): string | null {
  const m = /^(.+)-(\d+)$/.exec(id);
  if (!m) return null;
  if (docOf(docs, id)?.has_source) return null;
  const base = m[1];
  return docOf(docs, base)?.has_source ? base : null;
}

/** Spec 6.1: the target of `id`'s mark when it names another document in `docs`, else null. */
function validMark(id: string, docs: Readonly<Record<string, EvidenceDoc>>): string | null {
  const target = docOf(docs, id)?.mark;
  if (typeof target === 'string' && target.length > 0 && target !== id && docOf(docs, target)) return target;
  return null;
}

/** Spec 6.2 (t/355, R1, transitive): the document `id` resolves to. A valid mark, or a chunk's
 *  base, is followed to the end. A cycle is an error. */
export function resolveDocId(
  id: string, docs: Readonly<Record<string, EvidenceDoc>>, seen: readonly string[] = [],
): string {
  if (seen.includes(id)) {
    throw new ActionableError({
      goal: 'Resolve the evidence document for a summary id',
      problem: `The mark or chunk chain loops back to '${id}'.`,
      location: 'lib/sourceIndex/evidenceUnion.ts: resolveDocId',
      nextSteps: ['Remove or correct one mark in the loop (spec 6.1)', 'Check that no chunk names its own copy as its base'],
    });
  }
  const target = validMark(id, docs);
  if (target) return resolveDocId(target, docs, [...seen, id]);
  const base = chunkBase(id, docs);
  if (base) return resolveDocId(base, docs, [...seen, id]);
  return id;
}

function byOrdinal(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The trailing decimal N of a chunk id, for ordering chunks (spec 7.1). */
function chunkNumber(id: string): number {
  const m = /(\d+)$/.exec(id);
  return m ? Number(m[1]) : 0;
}

/**
 * Spec 7.1 (t/355, R2): the members of a canonical's group, excluding the canonical itself.
 * Order: marked copies by ordinal id, then the canonical's own chunks, then each copy's chunks,
 * each set by N ascending. `kind` is `copy`, `chunk_D` (a chunk of the canonical) or `chunk_copy`
 * (a chunk of a marked copy; `viaCopy` is that copy).
 */
export function groupMembers(
  canonical: string, docs: Readonly<Record<string, EvidenceDoc>>,
): Array<{ id: string; kind: GroupMemberKind; viaCopy?: string }> {
  const ids = Object.keys(docs).filter(id => id !== canonical).sort(byOrdinal);
  const byN = (list: string[]) => [...list].sort((a, b) => chunkNumber(a) - chunkNumber(b) || byOrdinal(a, b));
  const copies = ids.filter(id =>
    chunkBase(id, docs) === null && validMark(id, docs) !== null && resolveDocId(id, docs) === canonical);
  const out: Array<{ id: string; kind: GroupMemberKind; viaCopy?: string }> = [];
  for (const c of copies) out.push({ id: c, kind: 'copy' });
  for (const k of byN(ids.filter(id => chunkBase(id, docs) === canonical))) out.push({ id: k, kind: 'chunk_D' });
  for (const c of copies) {
    for (const k of byN(ids.filter(id => chunkBase(id, docs) === c))) out.push({ id: k, kind: 'chunk_copy', viaCopy: c });
  }
  return out;
}

// ── 7.4 union ──

export interface EvidenceLinkLike {
  node: string;
  quote: string;
}

/**
 * Spec 7.4: the de-duplicated union of a duplicate group's links, attributed
 * to the canonical. Generic over the link payload `T` (which must carry at
 * least `node` and `quote`) so a caller's richer link shape — extra display
 * fields a `{node, field, quote}` triple doesn't have — round-trips through
 * untouched.
 *
 * - The canonical's own links are all kept, in order, unchanged, including
 *   repeats — never de-duped against each other.
 * - Marked copies are processed in ordinal id order, then chunks in the order
 *   given (`groupMembers` builds that order), each in its own link order. A
 *   member's link is kept only if it isn't near-equal (7.3) to any link already
 *   kept on that node — the canonical wins ties, because its links are kept first.
 * - Attribution (7.4 step 3): a copy's link carries `via`; a chunk of the canonical
 *   carries `chunk_of`; a chunk of a marked copy carries `via` (the copy). Never both.
 * - De-dup is per node; node order isn't significant.
 */
export function mergeGroupEvidence<T extends EvidenceLinkLike>(
  canonicalId: string, members: readonly EvidenceUnionMember<T>[],
): Record<string, Array<UnionedEvidenceLink<T>>> {
  const canonicalMembers = members.filter(m => m.id === canonicalId);
  const others = members.filter(m => m.id !== canonicalId);
  const isCopy = (m: EvidenceUnionMember<T>) => !m.kind || m.kind === 'copy';
  const copies = others.filter(isCopy).sort((a, b) => byOrdinal(a.id, b.id));
  const chunks = others.filter(m => !isCopy(m));

  const out: Record<string, Array<UnionedEvidenceLink<T>>> = {};
  const keysByNode = new Map<string, string[]>();

  for (const m of [...canonicalMembers, ...copies, ...chunks]) {
    const own = m.id === canonicalId;
    const kind: GroupMemberKind = m.kind ?? 'copy';
    for (const link of m.links) {
      const key = evidenceKey(link.quote);
      if (!out[link.node]) { out[link.node] = []; keysByNode.set(link.node, []); }
      const keys = keysByNode.get(link.node)!;
      if (!own && keys.some(k => evidenceNearEqual(key, k))) continue;
      const entry = { ...link, doc: canonicalId } as UnionedEvidenceLink<T>;
      if (!own) {
        if (kind === 'copy') entry.via = m.id;
        else if (kind === 'chunk_D') entry.chunk_of = m.id;
        else if (kind === 'chunk_copy') entry.via = m.viaCopy;
        if (kind !== 'copy') {
          if (m.chunkGeneratedAt) entry.chunk_generated_at = m.chunkGeneratedAt;
          if (m.chunkModel) entry.chunk_model = m.chunkModel;
        }
      }
      out[link.node].push(entry);
      keys.push(key);
    }
  }

  return out;
}

// ── 7.7 entity-mention containers ──
// Port of Add-EmiUnionContainers/Add-EmiKeyPointContainers/Add-EmiFactualClaimContainers
// (scripts/AITriad/Private/EntityMentionIndexSteps.ps1, PR #3688). No TS reader parses
// `summary:` keys today — this is fixture parity only (t/4419), not wired into any consumer.

const POV_CODE: Record<string, string> = { accelerationist: 'acc', safetyist: 'saf', skeptic: 'skp' };
const POV_ORDER = ['accelerationist', 'safetyist', 'skeptic'] as const;

interface MentionContainerItem {
  /** The suffix after `summary:<doc>#` — e.g. `saf-kp-0`, `fc-1`. */
  suffix: string;
  text: string;
}

/** Spec 7.7: one doc's mention-container items, in `Add-EmiKeyPointContainers` /
 *  `Add-EmiFactualClaimContainers` order. A key_point's text is its `point` field
 *  only — never `verbatim`, unlike the citation quote (spec 7.1). The per-POV
 *  index advances on every key_point, including one with no text: an empty or
 *  absent `point` consumes its index but emits no item. */
function mentionContainerItems(summary: SummaryLike): MentionContainerItem[] {
  const items: MentionContainerItem[] = [];
  const povSummaries = (summary.pov_summaries ?? {}) as Record<string, { key_points?: unknown[] } | null | undefined>;
  for (const pov of POV_ORDER) {
    const keyPoints = povSummaries[pov]?.key_points ?? [];
    let index = 0;
    for (const kp of keyPoints) {
      const point = kp !== null && typeof kp === 'object' ? (kp as Record<string, unknown>).point : undefined;
      if (typeof point === 'string' && point !== '') items.push({ suffix: `${POV_CODE[pov]}-kp-${index}`, text: point });
      index++;
    }
  }
  (summary.factual_claims ?? []).forEach((fc, index) => {
    const claim = fc !== null && typeof fc === 'object' ? (fc as Record<string, unknown>).claim : undefined;
    if (typeof claim === 'string' && claim !== '') items.push({ suffix: `fc-${index}`, text: claim });
  });
  return items;
}

/** Spec 7.7: a derived entity-mention container key (`summary:<canonical>#via-<copy>-…`).
 *  These keys appear or disappear as marks or the union change — nothing may persist a
 *  reference to one; a reader that parses `summary:` keys must handle this form or fail
 *  loudly on it. */
export function isDerivedMentionContainerKey(key: string): boolean {
  return /^summary:[^#]+#via-/.test(key);
}

/**
 * Spec 7.7: the duplicate-group union for entity-mention containers. For each doc other
 * than the canonical (ordinal order), every mention-container item whose text isn't
 * near-equal (7.3) to an item already in the group — the canonical's own items first,
 * then earlier copies' kept items — gets a container in the canonical's namespace:
 * `summary:<canonical>#via-<copy>-<suffix>`. No `summary:<copy>` key is made, and the
 * canonical's own containers (built by the per-doc indexer, not here) never change.
 * Returns only the new `via-` containers, keyed by their full container id.
 */
export function deriveEntityMentionContainers(
  canonicalId: string, summaries: ReadonlyArray<{ id: string; summary: SummaryLike }>,
): Record<string, string> {
  const canonicalEntry = summaries.find(s => s.id === canonicalId);
  const groupKeys: string[] = canonicalEntry ? mentionContainerItems(canonicalEntry.summary).map(i => evidenceKey(i.text)) : [];

  const copies = [...summaries.filter(s => s.id !== canonicalId)].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const containers: Record<string, string> = {};
  for (const copy of copies) {
    for (const item of mentionContainerItems(copy.summary)) {
      const key = evidenceKey(item.text);
      if (groupKeys.some(k => evidenceNearEqual(key, k))) continue;
      groupKeys.push(key);
      containers[`summary:${canonicalId}#via-${copy.id}-${item.suffix}`] = item.text;
    }
  }
  return containers;
}
