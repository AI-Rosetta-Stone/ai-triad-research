// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Shared node→source index types (t/4334/t/4333) — the server
 * (`taxonomy-editor/src/server/storage/fileIO.ts`) and Electron
 * (`taxonomy-editor/src/main/fileIO.ts`) builds share this shape and the
 * canonical-document-id algorithm below, so the two produce identical
 * `canonicalDocId` groupings for the same data (the Electron/web parity
 * requirement, `docs/dual-build-bridge.md`).
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

/** Per-document fields the canonical-id algorithm needs — a slice of each
 *  document's full metadata, not the whole `metadata.json`. */
export interface CanonicalIdDocMeta {
  url: string | null;
  title: string;
}

const SUFFIX_RE = /^(.+)-(\d+)$/;

/** Lowercase, `+` → space (ingestion sometimes URL-encodes titles), strip
 *  punctuation, collapse whitespace. Deliberately simple — "no fuzzy
 *  matching beyond this" is the explicit design constraint (t/4333): a false
 *  merge of two different documents is worse than a duplicate row. */
export function normalizeTitleForCanonicalId(title: string): string {
  return title
    .toLowerCase()
    .replace(/\+/g, ' ')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** `host + path`, trailing slash stripped, lowercased. Falls back to a plain
 *  lowercase/trim compare for a string that doesn't parse as a URL (ingestion
 *  metadata is free-form). Empty string and null both mean "no URL". */
export function normalizeUrlForCanonicalId(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const normalized = `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}`.toLowerCase();
    return normalized || null;
  } catch {
    const trimmed = url.trim().toLowerCase().replace(/\/+$/, '');
    return trimmed || null;
  }
}

/**
 * t/4334 — the canonical-key algorithm, in the order t/4333 specifies:
 *  1. an explicit parent/chunk link — not present in today's ingestion output
 *     (confirmed against the corpus, t/4334#1); this tier is a no-op hook for
 *     when ingestion adds one, never guessed at.
 *  2. a normalized source URL matching another document's.
 *  3. a `-N` suffix whose base id exists (the same document, split into
 *     processing parts under one slug).
 *  4. a normalized title matching another document's.
 * "No fuzzy matching beyond that" (t/4333): two documents that are the same
 * article reprinted at different outlets, with different URLs and titles
 * that don't normalize to the same string, stay two separate canonical ids —
 * ruled on explicitly (TL, t/4334#2) rather than risking a false merge.
 *
 * Takes the full known doc-id set at once (not a per-reference streaming
 * call) because tiers 2-4 require comparing a document against every OTHER
 * known document, not just itself. Deterministic: ties resolve to the
 * lexicographically-first doc id as the representative, so both the server
 * and Electron builds (which may list files in different orders) agree.
 *
 * Known limitation, not fuzzy-matching risk: a doc id that structurally ends
 * in `-<digits>` (e.g. a title that itself ends in a year) is indistinguishable
 * from a true split-part suffix if an unrelated doc happens to exist at the
 * stripped base id. Accepted per the "no fuzzy matching" design — exact
 * structural match only, same precision/recall tradeoff the ticket requires
 * for every other tier.
 */
export function computeCanonicalDocIds(
  docIds: string[], meta: Record<string, CanonicalIdDocMeta>,
): Record<string, string> {
  const docIdSet = new Set(docIds);
  const sorted = [...docIds].sort();

  const urlRep: Record<string, string> = {};
  const titleRep: Record<string, string> = {};
  for (const id of sorted) {
    const u = normalizeUrlForCanonicalId(meta[id]?.url ?? null);
    if (u && !(u in urlRep)) urlRep[u] = id;
    const t = normalizeTitleForCanonicalId(meta[id]?.title ?? id);
    if (t && !(t in titleRep)) titleRep[t] = id;
  }

  const resolved = new Map<string, string>();
  function resolve(id: string, depth: number): string {
    const cached = resolved.get(id);
    if (cached !== undefined) return cached;
    if (depth > 10) return id; // cycle guard — never expected, never trusted

    const u = normalizeUrlForCanonicalId(meta[id]?.url ?? null);
    if (u && urlRep[u] !== id) { const r = resolve(urlRep[u], depth + 1); resolved.set(id, r); return r; }

    const suffixMatch = id.match(SUFFIX_RE);
    if (suffixMatch && docIdSet.has(suffixMatch[1])) {
      const r = resolve(suffixMatch[1], depth + 1); resolved.set(id, r); return r;
    }

    const t = normalizeTitleForCanonicalId(meta[id]?.title ?? id);
    if (t && titleRep[t] !== id) { const r = resolve(titleRep[t], depth + 1); resolved.set(id, r); return r; }

    resolved.set(id, id);
    return id;
  }

  const canonical: Record<string, string> = {};
  for (const id of docIds) canonical[id] = resolve(id, 0);
  return canonical;
}
