// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Shared node→source index types (t/4334/t/4333) — the server
 * (`taxonomy-editor/src/server/storage/fileIO.ts`) and Electron
 * (`taxonomy-editor/src/main/fileIO.ts`) builds share this shape and the
 * canonical-document-id algorithm below, so the two produce identical
 * `canonicalDocId` groupings for the same data (the Electron/web parity
 * requirement, `docs/dual-build-bridge.md`).
 *
 * Canonicalization field names, shared with PowerShell's ingestion-side
 * dedupe (t/4337), agreed with TL p/801#1 — see `CANONICALIZATION_SPEC.md`
 * in this directory for the full spec and corpus fixtures:
 *   - `content_sha256` → `contentSha256` (exact content hash)
 *   - `same_as`        → `sameAs`        (explicit curated cross-doc link)
 *   - `parent_doc_id`  → `parentDocId`   (explicit parent/chunk link)
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
  /** The `scheme: "url"` provenance entry's `confidence` for `url`, when one
   *  exists. `'search'` means the URL was discovered via search, not
   *  asserted by the source itself or verified — corpus-wide, ~43% of
   *  sources carry `confidence: "search"` on their url provenance, and a
   *  search-discovered URL is a citation the ingestion pipeline found, not
   *  necessarily the document's own canonical address (two unrelated videos
   *  cited from two unrelated articles both resolve through
   *  `youtube.com/watch`, distinguished only by `?v=`). Never used for tier 2
   *  matching (TL p/801#1); absent/other values are trusted. */
  urlConfidence?: string | null;
  /** t/4337 `content_sha256` — an exact hash of the raw ingested content.
   *  Two doc ids with the same hash are unambiguously the same document;
   *  checked before every other tier. */
  contentSha256?: string | null;
  /** t/4337 `same_as` — an explicit, curated pointer to another doc id this
   *  one is the same document as (e.g. a reprint at a different outlet, the
   *  case TL ruled must never be fuzzy-matched by URL/title alone). */
  sameAs?: string | null;
  /** t/4337 `parent_doc_id` — an explicit pointer to the parent/chunk-source
   *  doc id. Tier 1 of the original spec (t/4333); previously a no-op hook
   *  since no ingestion output set it, now real. */
  parentDocId?: string | null;
}

const SUFFIX_RE = /^(.+)-(\d+)$/;
const SEARCH_CONFIDENCE = 'search';

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

const TRACKING_PARAM_EXACT = new Set(['fbclid', 'gclid']);
function isTrackingParam(key: string): boolean {
  return key.startsWith('utm_') || TRACKING_PARAM_EXACT.has(key);
}

/**
 * `host + path + sorted query` (fragment always dropped), lowercased.
 *
 * t/4334 (PowerShell p/783#6, confirmed against the real corpus — e.g. two
 * distinct YouTube videos both ingested as `youtube.com/watch`, distinguished
 * only by `?v=`): the query string is kept, not dropped, because on sites
 * where the query *is* the item id (YouTube `?v=`, Hacker News `?id=`, Google
 * Scholar `?user=`), dropping it collapses genuinely different documents —
 * exactly the false merge t/4333 rules out. Tracking params (`utm_*`,
 * `fbclid`, `gclid`) are stripped before sorting, since those vary per-share
 * without identifying a different document. Params are sorted by key so two
 * URLs differing only in parameter order still normalize identically.
 *
 * Falls back to a plain lowercase/trim compare for a string that doesn't
 * parse as a URL (ingestion metadata is free-form). Empty string and null
 * both mean "no URL".
 */
export function normalizeUrlForCanonicalId(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    // t/4334 (PowerShell p/801#2, agreed): only the scheme and host are
    // case-folded. The path and query keep their original case — a YouTube
    // `?v=` id, for example, is case-sensitive, so lowercasing it would
    // itself cause a false merge between two different videos.
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    const pathname = u.pathname.replace(/\/+$/, '');
    const params = [...u.searchParams.entries()]
      .filter(([key]) => !isTrackingParam(key))
      .sort(([a], [b]) => a.localeCompare(b));
    const query = params.length > 0 ? `?${params.map(([k, v]) => `${k}=${v}`).join('&')}` : '';
    const normalized = `${host}${pathname}${query}`;
    return normalized || null;
  } catch {
    const trimmed = url.trim().replace(/\/+$/, '');
    return trimmed || null;
  }
}

/**
 * t/4334 — the canonical-key algorithm, revised per TL p/801#1 after the
 * query-string false merge (PowerShell p/783#6), tier order pinned by the
 * shared spec (t/4344). In order of preference:
 *  0. an explicit `parentDocId` link.
 *  1. an explicit `sameAs` link (a curated cross-outlet/reprint alias —
 *     TL's answer to "what if the PI wants reprints merged": never fuzzy
 *     titles, always an explicit link, t/4334#2).
 *  2. an exact `contentSha256` match — the strongest *inferred* signal
 *     (no human/pipeline assertion needed, unlike tiers 0-1, but still
 *     zero false-merge risk since it's byte-exact).
 *  3. a normalized URL match — **skipped when the URL's own provenance
 *     confidence is `'search'`** (see `normalizeUrlForCanonicalId`'s doc).
 *  4. a `-N` suffix whose base id exists (the same document, split into
 *     processing parts under one slug).
 *  5. a normalized title match.
 * "No fuzzy matching beyond that" (t/4333): two documents that are the same
 * article reprinted at different outlets, with different URLs and titles
 * that don't normalize to the same string and no explicit `sameAs` link,
 * stay two separate canonical ids.
 *
 * Takes the full known doc-id set at once (not a per-reference streaming
 * call) because tiers 3-5 require comparing a document against every OTHER
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
/** One tier's check for a single doc id: returns the id it should resolve
 *  toward under this tier, or `null` if this tier doesn't apply. Splitting
 *  each tier into its own small closure (rather than one long if/else chain)
 *  keeps `resolve` itself a trivial loop — the tier *order* is the only thing
 *  that encodes the preference list, each tier's own logic stays simple. */
type TierLookup = (id: string) => string | null;

function buildTierLookups(
  meta: Record<string, CanonicalIdDocMeta>, docIdSet: Set<string>,
  hashRep: Record<string, string>, urlRep: Record<string, string>, titleRep: Record<string, string>,
): TierLookup[] {
  return [
    // 0. explicit parent/chunk link.
    (id) => { const p = meta[id]?.parentDocId; return (p && docIdSet.has(p) && p !== id) ? p : null; },
    // 1. explicit same-document link.
    (id) => { const s = meta[id]?.sameAs; return (s && docIdSet.has(s) && s !== id) ? s : null; },
    // 2. exact content hash.
    (id) => { const h = meta[id]?.contentSha256; return (h && hashRep[h] !== id) ? hashRep[h] : null; },
    // 3. normalized URL — skipped for search-provenance URLs.
    (id) => {
      if (meta[id]?.urlConfidence === SEARCH_CONFIDENCE) return null;
      const u = normalizeUrlForCanonicalId(meta[id]?.url ?? null);
      return (u && urlRep[u] !== id) ? urlRep[u] : null;
    },
    // 4. -N suffix whose base id exists.
    (id) => { const m = id.match(SUFFIX_RE); return (m && docIdSet.has(m[1])) ? m[1] : null; },
    // 5. normalized title.
    (id) => { const t = normalizeTitleForCanonicalId(meta[id]?.title ?? id); return (t && titleRep[t] !== id) ? titleRep[t] : null; },
  ];
}

function resolveCanonicalId(id: string, depth: number, tiers: TierLookup[], resolved: Map<string, string>): string {
  const cached = resolved.get(id);
  if (cached !== undefined) return cached;
  if (depth > 10) return id; // cycle guard — never expected, never trusted

  for (const tier of tiers) {
    const target = tier(id);
    if (target === null) continue;
    const r = resolveCanonicalId(target, depth + 1, tiers, resolved);
    resolved.set(id, r);
    return r;
  }
  resolved.set(id, id);
  return id;
}

/** First-seen (in sorted order, for determinism) representative doc id per
 *  content hash / normalized URL (search-provenance ones excluded) / title. */
function buildRepresentativeMaps(
  sortedDocIds: string[], meta: Record<string, CanonicalIdDocMeta>,
): { hashRep: Record<string, string>; urlRep: Record<string, string>; titleRep: Record<string, string> } {
  const hashRep: Record<string, string> = {};
  const urlRep: Record<string, string> = {};
  const titleRep: Record<string, string> = {};
  for (const id of sortedDocIds) {
    const hash = meta[id]?.contentSha256;
    if (hash && !(hash in hashRep)) hashRep[hash] = id;
    if (meta[id]?.urlConfidence !== SEARCH_CONFIDENCE) {
      const u = normalizeUrlForCanonicalId(meta[id]?.url ?? null);
      if (u && !(u in urlRep)) urlRep[u] = id;
    }
    const t = normalizeTitleForCanonicalId(meta[id]?.title ?? id);
    if (t && !(t in titleRep)) titleRep[t] = id;
  }
  return { hashRep, urlRep, titleRep };
}

export function computeCanonicalDocIds(
  docIds: string[], meta: Record<string, CanonicalIdDocMeta>,
): Record<string, string> {
  const docIdSet = new Set(docIds);
  const { hashRep, urlRep, titleRep } = buildRepresentativeMaps([...docIds].sort(), meta);

  const tiers = buildTierLookups(meta, docIdSet, hashRep, urlRep, titleRep);
  const resolved = new Map<string, string>();
  const canonical: Record<string, string> = {};
  for (const id of docIds) canonical[id] = resolveCanonicalId(id, 0, tiers, resolved);
  return canonical;
}
