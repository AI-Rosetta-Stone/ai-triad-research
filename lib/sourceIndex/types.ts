// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Shared node→source index types (t/4334/t/4333) and the source-identity
 * algorithm pinned by `docs/specs/source-identity.md` (t/4344) — content
 * hash, URL key, and canonical grouping. The PowerShell ingester
 * (`scripts/AITriad/Private/SourceIdentity.ps1`) implements the same spec;
 * both must pass every case in `tests/fixtures/source-identity-cases.json`
 * (see `sourceIdentityFixture.test.ts`). **To change a rule: edit the spec
 * and the fixture first, in one PR, then update both implementations —
 * never change one implementation alone.**
 */

export interface SourceReference {
  docId: string;
  /** t/4334: the id of the document this reference actually belongs to, after
   *  collapsing processing artifacts (split parts, re-ingested copies) into
   *  one id per real document. Equal to `docId` when nothing collapses. */
  canonicalDocId: string;
  title: string;
  pov: string;
  stance: string;
  point: string;
  verbatim: string;
  excerptContext: string;
  url: string | null;
  sourceType: string;
  datePublished: string;
}

export type NodeSourceIndex = Record<string, SourceReference[]>;

/**
 * t/4333 scope addition (PI, p/548#306): the "source card" header for an
 * expanded document — one per `canonicalDocId`, not one per reference, so the
 * same title/authors/etc. aren't repeated once per split part.
 */
export interface SourceCardMeta {
  title: string;
  url: string | null;
  authors: string[];
  datePublished: string;
  topicTags: string[];
  /** AI-extracted at import; absent on older documents (field coverage is
   *  reported separately, t/4334 point 2 of the card scope addition). */
  oneLiner: string | null;
}

// ═══════════════════════════════════════════════════════════════════════
// Source-identity spec (docs/specs/source-identity.md, t/4344)
// ═══════════════════════════════════════════════════════════════════════

/** A `provenance[]` entry, as read from `metadata.json`. */
export interface SourceProvenanceEntry {
  scheme?: string;
  confidence?: string;
  id?: string;
}

/** The `metadata.json` fields the identity algorithm reads (spec section 0). */
export interface SourceIdentityMeta {
  title?: string | null;
  url?: string | null;
  resolved_url?: string | null;
  provenance?: SourceProvenanceEntry[];
  /** Recorded at ingest (t/4337). Distinct from a *computed* snapshot hash —
   *  see `SourceIdentityDoc.snapshotSha256` and spec section 4.0. */
  content_sha256?: string | null;
  same_as?: string | null;
  parent_doc_id?: string | null;
  /** t/4337 C1 (spec section 6) — a reviewed corpus-cleanup mark, never
   *  inferred. An empty string is the same as absent. Validated and
   *  resolved by `groupSourceIdentities`/`resolveDuplicateOf` below, never
   *  by the caller. */
  duplicate_of?: string | null;
}

/** One document as input to `groupSourceIdentities` (spec section 4). */
export interface SourceIdentityDoc {
  id: string;
  metadata: SourceIdentityMeta;
  /** The section-1 hash computed from `snapshot.md`, for a document with no
   *  *recorded* `metadata.content_sha256` (spec 4.0). Only a recorded hash
   *  can veto a suffix edge (4.4) — pass this only when there's no recorded
   *  one, so computed-hash "conversion noise" differences never veto. */
  snapshotSha256?: string | null;
}

/** Spec 4.5: a pair sharing a trusted URL key, kept from joining by the 4.3
 *  conflict veto (differing effective hashes AND differing titles). */
export interface SourceUrlConflict {
  url_key: string;
  ids: [string, string];
}

/** Spec section 6.1: the first check a `duplicate_of` mark fails, or absent
 *  for a valid mark. `self`: the target is the document itself. `missing_target`:
 *  the target isn't in the input set. `chain`: the target carries a mark of
 *  its own (one hop only — no chains, no cycles). `conflict`: the target is a
 *  valid mark in this group, but not the group's chosen canonical (4.6 rule 1
 *  — the ordinal-smallest of the group's valid targets). */
export type DuplicateOfErrorKind = 'self' | 'missing_target' | 'chain' | 'conflict';

/** Spec 6.1: one invalid `duplicate_of` mark, reported for a human — never
 *  thrown. Sorted by `id`, ordinal. */
export interface DuplicateOfError {
  id: string;
  target: string;
  kind: DuplicateOfErrorKind;
}

export interface SourceIdentityGroupResult {
  /** docId → canonical id in its connected component: a group with a valid
   *  `duplicate_of` mark uses the mark's target (spec 4.6 rule 1); any other
   *  group uses the ordinal-smallest id in it (rule 2). */
  canonical: Record<string, string>;
  /** Equal non-empty title keys spanning 2+ groups — a report for a human
   *  (t/4337's cleanup pass), never a merge (spec 4.5). Each inner array is
   *  one collision's doc ids, ordinal-sorted; collisions are sorted by their
   *  first id. */
  titleCollisions: string[][];
  /** Pairs vetoed from joining on a shared URL key (spec 4.3/4.5) — reported
   *  even if other edges still put both documents in one group. Sorted by
   *  `url_key`, then by `ids`, all ordinal. */
  urlConflicts: SourceUrlConflict[];
  /** Spec 6.2: docId → the id a by-id lookup should actually use — the
   *  mark's target when `docId` has a *valid* mark, `docId` itself
   *  otherwise. Reads the mark only, never grouping: an unmarked group
   *  member resolves to itself even when its group's canonical is another
   *  document (t/4357, p/803#2/#4 — the mark-only cleanup's blast radius
   *  stays exactly the one document a human signed off on). */
  resolved: Record<string, string>;
  /** Spec 6.3: the documents with no valid `duplicate_of` mark, ordinal-
   *  sorted — what selection, evidence retrieval and the node-source index
   *  should iterate, instead of every doc id. */
  selectable: string[];
  /** Spec 6.1: every invalid mark, sorted by `id`, ordinal. WARN on these;
   *  never throw — an invalid mark is visible (reported) and harmless
   *  (treated as absent everywhere), not a build failure. */
  duplicateOfErrors: DuplicateOfError[];
}

const BOM = '﻿';
const SNAPSHOT_HEADER_START = '<!--\n  AI Triad Research Project';
const SUFFIX_RE = /^(.+)-(\d+)$/;
const TRACKING_PARAM_EXACT = new Set(['fbclid', 'gclid', 'mc_cid', 'mc_eid']);
const SEARCH_CONFIDENCE = 'search';
const BINARY_PLACEHOLDER_RE = /^# [^\n]*\n\n\[Binary file — no text extraction available\]$/;
const MIN_HASH_BODY_WORDS = 100;

/** Spec 1.3 (version 4): word count for the 100-word hash-identity floor.
 *  Splits on runs of ASCII whitespace only (not Unicode `\s` — .NET and JS
 *  disagree on that set) and counts the non-empty tokens. */
function countAsciiWhitespaceWords(body: string): number {
  const tokens = body.split(/[ \t\n\r\f\v]+/).filter(t => t !== '');
  return tokens.length;
}

/**
 * Spec section 1.1-1.2: the body text `content_sha256` is computed over.
 * Strips a leading BOM, normalizes line endings, removes the
 * `Add-SnapshotHeader` provenance block if present, applies Unicode NFC,
 * strips trailing spaces/tabs per line, and drops leading/trailing blank
 * lines. Interior blank lines, and non-ASCII whitespace, are kept.
 */
export function normalizeSnapshotBody(text: string): string {
  let t = text;
  if (t.startsWith(BOM)) t = t.slice(1);
  t = t.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  if (t.startsWith(SNAPSHOT_HEADER_START)) {
    const close = t.indexOf('\n-->\n');
    if (close >= 0) {
      const rule = t.indexOf('\n---\n', close);
      if (rule >= 0) t = t.slice(rule + '\n---\n'.length);
    }
  }

  t = t.normalize('NFC');
  const lines = t.split('\n').map(line => line.replace(/[ \t]+$/, ''));
  while (lines.length > 0 && lines[0] === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

/**
 * Spec section 1: `content_sha256` (lowercase hex) for raw snapshot text, or
 * `null` when the body is empty or an extraction-failure placeholder (1.3) —
 * never a hash of nothing, never a hash that collides two different
 * failures. `digest` defaults to Node's `crypto.createHash`; callers in a
 * non-Node runtime (there are none today) can supply their own.
 */
export function computeSourceContentHash(
  text: string, digest: (utf8Bytes: Uint8Array) => string,
): string | null {
  const body = normalizeSnapshotBody(text);
  if (body === '') return null;
  if (body.startsWith('# PDF EXTRACTION FAILED')) return null;
  if (BINARY_PLACEHOLDER_RE.test(body)) return null;
  if (countAsciiWhitespaceWords(body) < MIN_HASH_BODY_WORDS) return null;
  return digest(new TextEncoder().encode(body));
}

/** Spec section 2: the normalized URL identity key, or `null` if `url` isn't
 *  an absolute http(s) URL. Purely textual (no percent-decoding, no IDN
 *  conversion) so .NET and JS parsers can't diverge. Only the scheme and
 *  host are case-folded — the path and query keep their original case,
 *  because e.g. a YouTube `?v=` id is case-sensitive. */
export function normalizeUrlForCanonicalId(url: string | null | undefined): string | null {
  if (url === null || url === undefined) return null;
  const m = /^(https?):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(String(url).trim());
  if (!m) return null;

  let authority = m[2];
  const at = authority.lastIndexOf('@');
  if (at >= 0) authority = authority.slice(at + 1);
  authority = authority.toLowerCase().replace(/:(80|443)$/, '');
  if (authority.startsWith('www.')) authority = authority.slice(4);
  if (authority === '') return null;

  const path = m[3].replace(/\/+$/, '');

  let query = '';
  if (m[4] !== undefined) {
    const params = m[4]
      .slice(1)
      .split('&')
      .filter(p => p !== '')
      .filter((p) => {
        const name = p.split('=')[0].toLowerCase();
        return !name.startsWith('utm_') && !TRACKING_PARAM_EXACT.has(name);
      })
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)); // ordinal: UTF-16 code units
    if (params.length > 0) query = `?${params.join('&')}`;
  }

  return authority + path + query;
}

/** Spec section 3: the trusted URL keys of one document's metadata — `url`
 *  then `resolved_url`, normalized and de-duplicated (first occurrence
 *  wins), minus any key that matches a `scheme:"url", confidence:"search"`
 *  provenance entry (a post-ingest guess, not an asserted address). */
export function trustedSourceUrlKeys(meta: SourceIdentityMeta | null | undefined): string[] {
  if (!meta) return [];
  const untrusted = new Set<string>();
  for (const p of meta.provenance ?? []) {
    if (p && p.scheme === 'url' && p.confidence === SEARCH_CONFIDENCE) {
      const k = normalizeUrlForCanonicalId(p.id);
      if (k) untrusted.add(k);
    }
  }
  const out: string[] = [];
  for (const field of ['url', 'resolved_url'] as const) {
    const k = normalizeUrlForCanonicalId(meta[field]);
    if (k && !untrusted.has(k) && !out.includes(k)) out.push(k);
  }
  return out;
}

/** Spec section 4.5: lowercase, `+`→space, keep only ASCII `[a-z0-9_]` and
 *  ASCII whitespace, collapse whitespace runs, trim. Deliberately ASCII-only
 *  — .NET `\w` is Unicode-aware and JS `\w` is ASCII, so this spells out the
 *  character class explicitly rather than relying on either runtime's
 *  default, and the two implementations can't diverge on a non-ASCII title.
 *  A missing/empty title gives an empty key (no id fallback — an empty key
 *  never produces an edge or a collision). */
export function normalizeTitleForCanonicalId(title: string | null | undefined): string {
  if (!title) return '';
  return title
    .toLowerCase()
    .replace(/\+/g, ' ')
    .replace(/[^a-z0-9_ \t\n\r\f\v]/g, '')
    .replace(/[ \t\n\r\f\v]+/g, ' ')
    .trim();
}

/** Union-find over doc ids, ordinal-smallest-id-wins on union (spec 4.6). */
class DocIdUnionFind {
  private readonly parent = new Map<string, string>();
  constructor(ids: Iterable<string>) { for (const id of ids) this.parent.set(id, id); }

  find(x: string): string {
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    let cur = x;
    while (this.parent.get(cur) !== root) { const next = this.parent.get(cur)!; this.parent.set(cur, root); cur = next; }
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    if (ra < rb) this.parent.set(rb, ra); else this.parent.set(ra, rb);
  }
}

/** Unions every doc sharing a non-empty key under `tier`, first-seen-wins. */
function unionByKey(uf: DocIdUnionFind, byKey: Map<string, string>, tier: string, key: string | null | undefined, id: string): void {
  if (!key) return;
  const k = `${tier}\0${key}`;
  const existing = byKey.get(k);
  if (existing !== undefined) uf.union(existing, id); else byKey.set(k, id);
}

function effectiveHash(doc: SourceIdentityDoc): string | null {
  return doc.metadata.content_sha256 ?? doc.snapshotSha256 ?? null;
}

/** Spec 4.4: `X-N` joins its base `X` only if the title keys are equal and
 *  non-empty, neither side's trusted URLs conflict (a URL on only one side,
 *  or a search-provenance one, is not a conflict), and neither side's
 *  *recorded* hash conflicts (a recorded hash on only one side, or differing
 *  *computed* snapshot hashes, is not a conflict — those are conversion
 *  noise, not evidence of a different document). */
function suffixEdgeAllowed(
  titleKeys: Map<string, string>, urlKeys: Map<string, string[]>, recordedHashes: Map<string, string | null>,
  id: string, base: string,
): boolean {
  const sameTitle = titleKeys.get(id) !== '' && titleKeys.get(id) === titleKeys.get(base);
  if (!sameTitle) return false;

  const a = urlKeys.get(id) ?? [];
  const b = urlKeys.get(base) ?? [];
  const urlConflict = a.length > 0 && b.length > 0 && !a.some(u => b.includes(u));
  if (urlConflict) return false;

  const ha = recordedHashes.get(id) ?? null;
  const hb = recordedHashes.get(base) ?? null;
  const hashConflict = !!ha && !!hb && ha !== hb;
  return !hashConflict;
}

/**
 * Spec section 4 — canonical grouping. The groups are the connected
 * components over every edge, from every tier together (a union, never
 * "first matching tier"), so the result doesn't depend on tier-check order
 * or file listing order:
 *  1. (strong) an explicit `parent_doc_id`/`same_as` link, ignored if the
 *     target id isn't in the input set;
 *  2. (strong) an equal content hash (recorded, or else computed — 4.0/4.2);
 *  3. (strong) an equal trusted URL key (4.3);
 *  4. (conditional) a `-N` suffix joins its base only under 4.4's three
 *     conditions — never unconditionally, so a genuine slug collision
 *     (t/4337 can mint one deliberately) or a coincidental `foo-2026`/`foo`
 *     pair stays separate;
 *  5. a title alone adds **no edge** — only a `title_collision` report
 *     (4.5), since generic or non-ASCII-reduced titles would otherwise chain
 *     unrelated documents together.
 */
type DocDerivedFields = {
  titleKeys: Map<string, string>; urlKeys: Map<string, string[]>;
  recordedHashes: Map<string, string | null>; effectiveHashes: Map<string, string | null>;
};

function computeDerivedFields(docs: SourceIdentityDoc[]): DocDerivedFields {
  const titleKeys = new Map<string, string>();
  const urlKeys = new Map<string, string[]>();
  const recordedHashes = new Map<string, string | null>();
  const effectiveHashes = new Map<string, string | null>();
  for (const d of docs) {
    titleKeys.set(d.id, normalizeTitleForCanonicalId(d.metadata.title));
    urlKeys.set(d.id, trustedSourceUrlKeys(d.metadata));
    recordedHashes.set(d.id, d.metadata.content_sha256 ?? null);
    effectiveHashes.set(d.id, effectiveHash(d));
  }
  return { titleKeys, urlKeys, recordedHashes, effectiveHashes };
}

/** Spec 4.3's veto: a pair sharing a URL key does NOT join when both their
 *  effective hashes AND their titles differ (both sides must have a
 *  non-empty/present value on each axis for it to count as "differing"). */
function urlPairVetoed(derived: DocDerivedFields, a: string, b: string): boolean {
  const ha = derived.effectiveHashes.get(a) ?? null;
  const hb = derived.effectiveHashes.get(b) ?? null;
  const hashesDiffer = !!ha && !!hb && ha !== hb;

  const ta = derived.titleKeys.get(a) ?? '';
  const tb = derived.titleKeys.get(b) ?? '';
  const titlesDiffer = ta !== '' && tb !== '' && ta !== tb;

  return hashesDiffer && titlesDiffer;
}

/** Spec 4.3/4.5: URL edges are pairwise, not first-seen-wins grouping — every
 *  pair sharing a trusted key is considered independently, so one vetoed
 *  pair doesn't block others sharing the same key. Mutates `uf` for allowed
 *  pairs and returns every vetoed pair as a `url_conflict`. */
function unionUrlEdgesPairwise(uf: DocIdUnionFind, derived: DocDerivedFields): SourceUrlConflict[] {
  const idsByKey = new Map<string, string[]>();
  for (const [id, keys] of derived.urlKeys) {
    for (const key of keys) {
      const bucket = idsByKey.get(key);
      if (bucket) bucket.push(id); else idsByKey.set(key, [id]);
    }
  }

  const conflicts: SourceUrlConflict[] = [];
  for (const [key, ids] of idsByKey) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const [a, b] = ids[i] < ids[j] ? [ids[i], ids[j]] : [ids[j], ids[i]];
        if (urlPairVetoed(derived, a, b)) conflicts.push({ url_key: key, ids: [a, b] });
        else uf.union(a, b);
      }
    }
  }
  return conflicts;
}

function unionAllEdges(uf: DocIdUnionFind, known: Set<string>, docs: SourceIdentityDoc[], derived: DocDerivedFields): SourceUrlConflict[] {
  const { titleKeys, urlKeys, recordedHashes } = derived;
  const byKey = new Map<string, string>();
  for (const d of docs) {
    for (const link of ['parent_doc_id', 'same_as', 'duplicate_of'] as const) {
      const target = d.metadata[link];
      // Spec 6.1: an invalid mark (e.g. a chain) still makes this edge — it
      // only loses its effect on the canonical, the resolver and selection.
      if (target && known.has(target)) uf.union(d.id, target);
    }
    unionByKey(uf, byKey, 'hash', effectiveHash(d), d.id);

    const suffixMatch = d.id.match(SUFFIX_RE);
    if (suffixMatch && known.has(suffixMatch[1]) && suffixEdgeAllowed(titleKeys, urlKeys, recordedHashes, d.id, suffixMatch[1])) {
      uf.union(d.id, suffixMatch[1]);
    }
  }
  return unionUrlEdgesPairwise(uf, derived);
}

/** Spec 4.5's report: equal non-empty title keys spanning 2+ already-resolved
 *  groups, ordinal-sorted within each collision and across collisions. */
function findTitleCollisions(ids: string[], titleKeys: Map<string, string>, canonical: Record<string, string>): string[][] {
  const byTitle = new Map<string, string[]>();
  for (const id of ids) {
    const key = titleKeys.get(id)!;
    if (key === '') continue;
    const bucket = byTitle.get(key);
    if (bucket) bucket.push(id); else byTitle.set(key, [id]);
  }
  const collisions: string[][] = [];
  for (const members of byTitle.values()) {
    const distinctGroups = new Set(members.map(id => canonical[id]));
    if (distinctGroups.size >= 2) collisions.push([...members].sort());
  }
  collisions.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return collisions;
}

/** Spec 4.5: sorted by `url_key`, then by `ids`, all ordinal. */
function sortUrlConflicts(conflicts: SourceUrlConflict[]): SourceUrlConflict[] {
  return [...conflicts].sort((a, b) => {
    if (a.url_key !== b.url_key) return a.url_key < b.url_key ? -1 : 1;
    if (a.ids[0] !== b.ids[0]) return a.ids[0] < b.ids[0] ? -1 : 1;
    return a.ids[1] < b.ids[1] ? -1 : a.ids[1] > b.ids[1] ? 1 : 0;
  });
}

/** Spec 6.1, checks 1-3 only (`self`/`missing_target`/`chain`) — `conflict`
 *  (check 4) needs the group's canonical, which isn't known until after
 *  this pass (spec's "evaluate in two passes" note, #3589). */
function classifyMarks(docs: SourceIdentityDoc[]): { mark: Map<string, string>; kind: Map<string, DuplicateOfErrorKind> } {
  const known = new Set(docs.map(d => d.id));
  const byId = new Map(docs.map(d => [d.id, d] as const));
  const mark = new Map<string, string>();
  const kind = new Map<string, DuplicateOfErrorKind>();
  for (const d of docs) {
    const target = d.metadata.duplicate_of;
    if (!target) continue; // spec: an empty string is the same as absent
    mark.set(d.id, target);
    if (target === d.id) kind.set(d.id, 'self');
    else if (!known.has(target)) kind.set(d.id, 'missing_target');
    else if (byId.get(target)!.metadata.duplicate_of) kind.set(d.id, 'chain'); // one hop only
  }
  return { mark, kind };
}

/** Spec 6.1 check 4 (`conflict`) and 4.6 rule 1: the group's canonical
 *  target is the ordinal-smallest target among its still-valid marks;
 *  every other valid mark in the group becomes a `conflict`. Mutates
 *  `kind` in place with any newly-found `conflict`s. */
function resolveGroupTargets(
  mark: Map<string, string>, kind: Map<string, DuplicateOfErrorKind>, canonical: Record<string, string>,
): Map<string, string> {
  const groupTarget = new Map<string, string>();
  for (const [id, target] of mark) {
    if (kind.has(id)) continue;
    const root = canonical[id];
    const existing = groupTarget.get(root);
    if (existing === undefined || target < existing) groupTarget.set(root, target);
  }
  for (const [id, target] of mark) {
    if (!kind.has(id) && target !== groupTarget.get(canonical[id])) kind.set(id, 'conflict');
  }
  return groupTarget;
}

/** Spec section 6 — validates every `duplicate_of` mark against `canonical`
 *  (the grouping `unionAllEdges` already produced, duplicate_of edges
 *  included), then overrides a marked group's canonical to its valid
 *  target (4.6 rule 1) and derives the one-hop resolver, the selectable
 *  set and the error report. Mutates nothing — returns overrides for the
 *  caller to apply, so the pre-override `canonical` (grouping alone) is
 *  never silently lost mid-function. */
function resolveDuplicateOfMarks(
  docs: SourceIdentityDoc[], canonical: Record<string, string>,
): { canonicalOverrides: Record<string, string>; resolved: Record<string, string>; selectable: string[]; duplicateOfErrors: DuplicateOfError[] } {
  const known = docs.map(d => d.id);
  const { mark, kind } = classifyMarks(docs);
  const groupTarget = resolveGroupTargets(mark, kind, canonical);

  const canonicalOverrides: Record<string, string> = {};
  for (const id of known) {
    const override = groupTarget.get(canonical[id]);
    if (override !== undefined) canonicalOverrides[id] = override;
  }

  const resolved: Record<string, string> = {};
  const selectable: string[] = [];
  const duplicateOfErrors: DuplicateOfError[] = [];
  for (const id of [...known].sort()) {
    const valid = mark.has(id) && !kind.has(id);
    resolved[id] = valid ? mark.get(id)! : id;
    if (!valid) selectable.push(id);
    const errKind = kind.get(id);
    if (errKind) duplicateOfErrors.push({ id, target: mark.get(id)!, kind: errKind });
  }

  return { canonicalOverrides, resolved, selectable, duplicateOfErrors };
}

export function groupSourceIdentities(docs: SourceIdentityDoc[]): SourceIdentityGroupResult {
  const ids = docs.map(d => d.id);
  const known = new Set(ids);
  const uf = new DocIdUnionFind(ids);

  const derived = computeDerivedFields(docs);
  const urlConflicts = unionAllEdges(uf, known, docs, derived);

  const canonical: Record<string, string> = {};
  for (const id of ids) canonical[id] = uf.find(id);

  const titleCollisions = findTitleCollisions(ids, derived.titleKeys, canonical);

  const { canonicalOverrides, resolved, selectable, duplicateOfErrors } = resolveDuplicateOfMarks(docs, canonical);
  for (const [id, override] of Object.entries(canonicalOverrides)) canonical[id] = override;

  return { canonical, titleCollisions, urlConflicts: sortUrlConflicts(urlConflicts), resolved, selectable, duplicateOfErrors };
}

// ═══════════════════════════════════════════════════════════════════════
// Back-compat shim (t/4344 superseded this) — ElectronMain's t/4341
// (`src/main/fileIO.ts`, PR #3510) consumes this exact shape already.
// Deprecated: migrate to `groupSourceIdentities`/`SourceIdentityMeta`, which
// add the content-hash tier, the conditional suffix edge, and the
// title-collision report this shim can't surface (a follow-up, not blocking
// — this shim is correct, just narrower).
// ═══════════════════════════════════════════════════════════════════════

/** @deprecated Use `SourceIdentityMeta` (t/4344). Kept only for the shim below. */
export interface CanonicalIdDocMeta {
  url: string | null;
  title: string;
}

/** @deprecated Use `groupSourceIdentities` (t/4344) — this wraps it with the
 *  old, narrower input/output shape (no content hash, `same_as`,
 *  `parent_doc_id` or title-collision report).
 *
 * t/4334#11 (TL): the shim's caller (ElectronMain) has no `provenance` data,
 * so it can never *prove* a URL is trustworthy — unlike the real spec, where
 * an absent provenance entry defaults to trusted (section 3.2 only
 * untrusts a URL with *positive* evidence of a `confidence:"search"` guess).
 * **The shim inverts that default: a URL is never trusted here**, since
 * "no evidence either way" means "unverified," not "verified." The URL
 * field is therefore never forwarded to `groupSourceIdentities` — this shim
 * groups on the suffix (conditional) and the title-collision report only,
 * never falsely merging two documents on a URL that might be a search guess. */
export function computeCanonicalDocIds(
  docIds: string[], meta: Record<string, CanonicalIdDocMeta>,
): Record<string, string> {
  const docs: SourceIdentityDoc[] = docIds.map(id => ({
    id,
    // url intentionally omitted — see the note above.
    metadata: { title: meta[id]?.title ?? id, url: null },
  }));
  return groupSourceIdentities(docs).canonical;
}
