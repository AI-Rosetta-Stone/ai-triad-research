// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * `sources-index.json` schema (t/4334#18, TL decision on t/4334).
 *
 * Hosted (github-api mode) reads only `ai-triad-data`, so it has no access
 * to `ai-triad-sources` — `getSourcesDir()` resolving a sibling-repo path
 * that backend's single-repo tree doesn't cover, silently returning no
 * entries (the t/4334 AC1 incident). This file is PowerShell's precomputed
 * index of `ai-triad-sources`, written into `ai-triad-data` by
 * `Export-SourcesIndex` (`scripts/AITriad/Public/Export-SourcesIndex.ps1`,
 * #3558) so the server can read it through the existing backend instead of
 * needing a second cross-repo one.
 *
 * Reference implementation / source of truth for the exact mapping:
 * `scripts/AITriad/Private/Get-SourcesIndexEntry.ps1`. This file is the TS
 * mirror of that same contract — if they diverge, the PS file wins and this
 * one is wrong.
 *
 * **Byte-stability (so a scheduled regeneration run doesn't commit noise
 * when nothing changed):** documents sorted ordinally by `id`, a fixed key
 * order per document, LF line endings, no `generated_at` timestamp —
 * `source_commit` (the `ai-triad-sources` HEAD sha, or `null` if it isn't a
 * git checkout) plus `schema_version` identify the input instead.
 *
 * **Absent fields are omitted, never `null`** — keeps the file small and
 * every key's presence meaningful (a reader checks `'title' in entry`, not
 * `entry.title !== null`).
 *
 * **Exclusions:** source directories whose name starts with `.` or `_`
 * (`.git`, `.claude`, `_inbox`) are skipped entirely — not indexed, not
 * counted.
 *
 * **Path:** `{dataRoot}/{taxonomy_dir}/sources-index.json` — the same
 * `taxonomy_dir` (default `taxonomy/Origin`) both runtimes already resolve
 * from `.aitriad.json` (TS: `loadDataConfig().taxonomy_dir` via
 * `resolveDataPath`; PS: `Get-TaxonomyDir`), so neither side hardcodes it
 * independently.
 */

/** One `provenance[]` entry (spec `source-identity.md` section 0/3) —
 *  identical shape to `SourceProvenanceEntry` in `types.ts`, duplicated here
 *  rather than imported so this file has no dependency on the grouping
 *  algorithm's module, only on the index's own on-disk shape. Fields are
 *  omitted when empty/absent, per this schema's omit-don't-null rule. */
export interface SourcesIndexProvenanceEntry {
  scheme?: string;
  id?: string;
  confidence?: string;
}

/**
 * One document's record in `sources-index.json`. Every field past `id` is
 * **optional and omitted, never `null`,** when the source value is
 * absent/empty in `ai-triad-sources/<id>/metadata.json`. A source directory
 * with no readable `metadata.json` at all produces a record with only `id`
 * and (if computable) `content_sha256` — never a title fallback to the bare
 * id, since that's exactly the ambiguous-identity case the v2 source-
 * identity spec's conditional suffix rule treats conservatively (t/4334#15).
 *
 * **Key order on disk** (also the order below): `id`, then the source-card
 * fields (t/4333's PI scope addition), then the identity fields
 * (`docs/specs/source-identity.md`).
 */
export interface SourcesIndexEntry {
  id: string;

  // ── Source-card fields (t/4333 PI scope addition) ──
  title?: string;
  url?: string;
  resolved_url?: string;
  authors?: string[];
  date_published?: string;
  one_liner?: string;
  topic_tags?: string[];

  // ── Identity fields (docs/specs/source-identity.md) ──
  /** The recorded `content_sha256` from `metadata.json`, or else the spec
   *  section-1 hash computed from `snapshot.md` — omitted (not `null`) when
   *  neither is available: an empty/placeholder body, or (spec 1.3 v4) a
   *  body under the 100-word floor. A reader must NOT fall back to treating
   *  this doc's hash as "equal to every other hash-less doc" — absent means
   *  no hash identity, same as the live `SourceIdentityMeta.content_sha256`
   *  contract in `types.ts`. */
  content_sha256?: string;
  provenance?: SourcesIndexProvenanceEntry[];
  same_as?: string;
  parent_doc_id?: string;
  /** t/4337 C1 (not yet written by any ingester as of this schema's first
   *  version) — the id of the document this one is a corpus-cleanup-
   *  confirmed duplicate of. Readers should treat it like `same_as` once a
   *  consumer exists (t/4357); the field is reserved here so the schema
   *  doesn't need a version bump when that lands. */
  duplicate_of?: string;
}

/** The whole file. `docs` is sorted ordinally by `id` (byte-stability). */
export interface SourcesIndexFile {
  schema_version: number;
  /** The `ai-triad-sources` HEAD commit sha the index was built from, or
   *  `null` if the generator couldn't resolve one (not a git checkout). A
   *  reader comparing this against a known-good value is how "stale" is
   *  defined for the WARN-and-fallback rule (t/4334#18 point 3) — this
   *  schema doesn't itself define what "stale" triggers against; that's the
   *  reader's concern, tracked separately. */
  source_commit: string | null;
  doc_count: number;
  docs: SourcesIndexEntry[];
}

export const SOURCES_INDEX_SCHEMA_VERSION = 1;
export const SOURCES_INDEX_FILENAME = 'sources-index.json';
