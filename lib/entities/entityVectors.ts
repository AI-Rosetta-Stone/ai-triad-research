// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// entity_embeddings.json vector-store contract (t/3121, TL ruling t/3121#4). Interface-first:
// the PowerShell writer (Import-Entity + Update-EntityEmbeddings) and the Shared Lib reader
// (nameResolver) both target this shape. Kept separate from the entity RECORD contract (types.ts)
// because it describes a distinct derived store.

/**
 * The per-entity value in entity_embeddings.json under schema v2. `name_vector` embeds the
 * label + aliases and drives the resolution ladder's cosine tie-break; `description_vector`
 * embeds the description and is written now for a FUTURE semantic rung (R6) — not yet wired.
 * Both are all-MiniLM-L6-v2, 384-dim. Mirrors the multi-named-vector precedent `exclusion_vector`
 * (lib/debate/exclusionGuard.ts): an object of named vectors where some are optional/skippable.
 */
export interface EntityVectorRecord {
  name_vector: number[];
  /** Optional — omitted when the entity has no description. Readers MUST tolerate its absence. */
  description_vector?: number[];
}

/**
 * The value stored at `vectors[<id>]` across the schema-version window. Back-compat is MANDATORY
 * (TL t/3121#4): the multi-vector backfill is a human-run data-push, so code is v2 while prod data
 * may still be v1 until the human runs it — no flag day.
 *  - v1 (schema 1.0.0): a flat `number[]` — a single blended name+description vector.
 *  - v2 (schema 2.0.0): an {@link EntityVectorRecord}.
 * Structurally self-describing (array ⟺ v1, object ⟺ v2), so a reader can select the name vector
 * without threading the envelope `_schema_version` per lookup.
 */
export type EntityVectorStored = number[] | EntityVectorRecord;

/** entity_embeddings.json envelope `_schema_version` after the multi-vector upgrade (t/3121). */
export const ENTITY_EMBEDDINGS_SCHEMA_VERSION = '2.0.0';

/**
 * Select the NAME vector from a stored value, handling both v1 (flat array → the vector as-is)
 * and v2 (object → `name_vector`). The single home for the v1/v2 back-compat rule (TL t/3121#4)
 * so every consumer reads it one way. Returns undefined for an absent entry.
 */
export function nameVectorOf(stored: EntityVectorStored | undefined): number[] | undefined {
  if (stored === undefined) return undefined;
  return Array.isArray(stored) ? stored : stored.name_vector;
}

/**
 * The envelope's PS-owned `_src_hashes[<id>]` fingerprint, computed the TS side (t/4458, CL
 * design review t/4458#2) — byte-identical to PowerShell `Get-EntityVectorSource.ps1`'s
 * `SrcHash`: `sha256(utf8("<name>[ <alias1> <alias2> ...]\n<description>"))`. Aliases join
 * with a single space, in the given order (no sorting); an empty alias array, or a single
 * empty-string alias, is the same as no aliases (`-join`/`.join` on either agree: falsy →
 * the name alone). `digest` is injected, matching `computeSourceContentHash`'s convention in
 * `lib/sourceIndex/types.ts` — no bare `crypto` import, so a non-Node caller can supply its own.
 *
 * Parity is pinned by a shared fixture, `tests/fixtures/entity-vector-source-cases.json`,
 * run by both this module's test and PowerShell's own `Get-EntityVectorSource.Tests.ps1`.
 *
 * KNOWN OVER-SKIP (CL t/4458#2 note 3, accepted for this T1): `name_vector` embeds only the
 * name+aliases text, but this hash covers name+aliases+description too, so a description-only
 * edit marks the name vector stale even though it still matches what's embedded. That fails
 * CLOSED (an unnecessary refusal, never a wrong link), so it's accepted here; a per-vector
 * hash on the PowerShell side is the real fix, filed separately and optional (t/4568).
 */
export function computeEntityVectorSourceHash(
  name: string,
  aliases: readonly string[],
  description: string,
  digest: (utf8Bytes: Uint8Array) => string,
): string {
  const aliasText = aliases.join(' ');
  const nameText = aliasText ? `${name} ${aliasText}` : name;
  return digest(new TextEncoder().encode(`${nameText}\n${description}`));
}
