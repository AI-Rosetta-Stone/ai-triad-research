// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Canonical cross-stack entity reference (t/1767 §5 contract). Single home for the
// ref-kind discriminated union — consumed by the server (getEntity) and the renderer
// (resolveRef / DetailPane, t/1775, which IMPORTS this and never forks it). Shipped
// interface-first so the five consumers build in parallel.

// Result payloads reuse the type that already owns each kind's data (never restated —
// that would fork the contract). PovNode/SituationNode live in lib/debate; imported
// type-only (erased at runtime, no runtime coupling). A neutral lib/taxonomy home for
// those record types is a future TL architecture call (t/1767#27).
import type { PovNode, SituationNode } from '../debate/taxonomyTypes.js';
import type { Organization } from '../organizations/types.js';
import type { ColloquialTerm } from '../dictionary/types.js';
import type { PolicyAction } from '../policy/types.js';

/** The kinds of linkable target an EntityRef can point at. */
export type EntityRefKind = 'node' | 'situation' | 'policy' | 'entity' | 'organization' | 'term';

/**
 * A typed reference to any linkable target — POV nodes / situations / policies /
 * entities / vocabulary terms. Discriminated on `kind` for exhaustive kind-dispatch
 * (`switch (ref.kind)`); each variant carries the raw `id`/token. New kinds extend
 * the union without touching existing variants.
 */
export type EntityRef =
  | { kind: 'node'; id: string }        // {pov}-{category}-NNN, e.g. acc-desires-001
  | { kind: 'situation'; id: string }   // sit-NNN (legacy cc-NNN)
  | { kind: 'policy'; id: string }      // pol-*
  | { kind: 'entity'; id: string }        // ent-* — new §3 entity record (entities.json)
  | { kind: 'organization'; id: string }  // org-* — existing Organization record (organizations.json)
  | { kind: 'term'; id: string };         // vocabulary; wire form `term:<slug>`

/** POV / BDI-category node id: {acc|saf|skp}-{beliefs|desires|intentions}-NNN. */
const NODE_ID_RE = /^(?:acc|saf|skp)-(?:beliefs|desires|intentions)-\d+$/;

/**
 * Map a raw id/token to a typed {@link EntityRef} by its prefix/shape. Returns `null`
 * for any unrecognized or ambiguous token — the reference is left unlinked, never
 * guessed (refusal discipline, t/1767 §2). Prefixes are mutually exclusive, so match
 * order is not significant; the node pattern is checked last as the only regex form.
 */
export function parseEntityRef(raw: string): EntityRef | null {
  if (!raw) return null;
  if (raw.startsWith('term:')) return { kind: 'term', id: raw };
  if (raw.startsWith('sit-') || raw.startsWith('cc-')) return { kind: 'situation', id: raw };
  if (raw.startsWith('pol-')) return { kind: 'policy', id: raw };
  if (raw.startsWith('org-')) return { kind: 'organization', id: raw };
  if (raw.startsWith('ent-')) return { kind: 'entity', id: raw };
  if (NODE_ID_RE.test(raw)) return { kind: 'node', id: raw };
  return null;
}

/** Type guard for a valid {@link EntityRefKind} string. */
export function isEntityRefKind(x: string): x is EntityRefKind {
  return x === 'node' || x === 'situation' || x === 'policy' ||
    x === 'entity' || x === 'organization' || x === 'term';
}

// ── Entity record (§3) + getEntity result union (§5, t/1767) ─────────────────────

export type EntityType = 'person' | 'artifact' | 'event' | 'legislation' | 'institution';
export type DolceCategory =
  | 'agentive-physical-object' | 'non-agentive-functional-artifact'
  | 'perdurant' | 'normative-description' | 'non-agentive-social-object';

/**
 * Provenance of an Entity's `description` (t/3131). Drives the person-approval gate in
 * Import-Entity: a `person` is approvable only when this is `human-edited`/`human-authored`
 * (or ABSENT with a non-empty description — grandfathered as human-authored, since the LLM
 * never drafted person descriptions before t/3131). `ai-drafted` is proposable but NOT
 * approvable until a human edits it. Any AI-drafting path for a person description MUST stamp
 * `ai-drafted` at draft time — the grandfather rule (absent ⟺ legacy human-authored) rests
 * entirely on no un-stamped AI draft ever existing (TL t/3131#2 safety condition).
 */
export type EntityDescriptionProvenance = 'ai-drafted' | 'human-edited' | 'human-authored';

/**
 * How a link (an `entity_refs[]` entry on a claim or BDI node) matched its target relative to the
 * register (R4.2) — lets downstream consumers (conflict detection, FOL export) tell an exact match
 * from a subsumption hop. `exact` = the surface names the target; the others = matched via ≤1–2
 * relation hops. Shared match-level VOCABULARY only; the link-record shape and the direction
 * semantics of each label are ASSIGNED by the resolution pass (t/3124) — see there for what each
 * label means at assignment time. Split out of t/3119 to land early (pure enum, no relations/
 * allowlist coupling — CL p/3#156), unblocking the t/3157 node link-refs + t/3124.
 */
export type EntityMatchLevel = 'exact' | 'instance_of' | 'subclass' | 'superclass' | 'related';

/**
 * Confirmation state of a link (t/3157, CL p/3#153). LOAD-BEARING — it's what lets a precise link
 * coexist with a speculative one without contaminating it: `linked` = confirmed (a surface/exact/
 * alias match, or a human/threshold-confirmed embedding hit); `proposed` = an unconfirmed embedding
 * candidate that must NOT count until confirmed (the "Andreessen cos-matches 45 nodes it doesn't
 * mention" problem). Required on every link ref — an unstatused ref is indistinguishable from a
 * confirmed one, which is the failure this field exists to prevent.
 */
export type EntityLinkStatus = 'linked' | 'proposed';

/**
 * A resolved link from a container (a BDI node's `entity_refs[]` — t/3157 — or a claim's
 * `entity_refs[]` — t/3124) to a register entity. ONE shape serves both containers (CL p/3#154).
 * `ref` is the raw `ent-*` token (parsed on read via {@link parseEntityRef}); `method` records how
 * it was found; `match_level` how it matched relative to the register ({@link EntityMatchLevel});
 * `link_confidence` the method-dependent score (exact/alias = 1.0; embedding = cosine); `status`
 * gates whether it counts. Assignment semantics (which label/method/status) are owned by the
 * resolution pass (t/3124) — this is the persisted shape only.
 */
export interface EntityLinkRef {
  ref: string;                                   // ent-* raw token
  surface: string;                               // matched surface form
  method: 'exact' | 'alias' | 'embedding';
  link_confidence: number;                       // [0,1] — method-dependent: 1.0 for exact/alias, cosine for embedding
  match_level: EntityMatchLevel;
  status: EntityLinkStatus;
}

/**
 * A resolved link from a BDI node's `concept_refs[]` to a dictionary concept (`term:*`) — t/3157.
 * Parallel to {@link EntityLinkRef} but simpler: NO `match_level`, because a concept ref already
 * names a kind/class, so there is no subsumption hop to record (CL p/3#154). `method` is narrower
 * (a concept is matched by surface or embedding, never an alias table).
 */
export interface ConceptLinkRef {
  ref: string;                                   // term:<slug> raw token
  surface: string;
  method: 'surface' | 'embedding';
  link_confidence: number;                       // [0,1] — method-dependent: 1.0 for exact/alias, cosine for embedding
  status: EntityLinkStatus;
}

/**
 * A DOLCE-typed relation between two register entities (or an entity and a `term:*` type) — R4.1.
 * The three types are kept explicitly DISTINCT (CL DOLCE review, t/3119#2):
 * - `instance_of` — a particular → its type. This is the bridge that crosses `ent-*` → `term:*`
 *   (a particular entity is an instance of a vocabulary kind). NOT interchangeable with subclass.
 * - `subclass_of` — a type → its supertype (type-level subsumption, e.g. one term narrows another).
 * - `part_of` — generic mereology (a particular part_of a particular, a sub-event part_of a
 *   perdurant). Constitution is deliberately excluded (CL §7.2); `part_of` must NEVER be used to
 *   encode an instance/subclass hop.
 */
export type EntityRelationType = 'instance_of' | 'subclass_of' | 'part_of';

/**
 * One relation edge on an {@link Entity}. `target` is a RAW `ent-*` | `term:<slug>` token (parsed on
 * read via {@link parseEntityRef}, like `Mention.entity_ref` — never persist a pre-parsed form).
 *
 * INVARIANT (R4.3, enforced WRITE-SIDE — not by this type): the relation graph is a shallow DAG —
 * acyclic, depth ≤ 3, `target` well-formed. A TypeScript interface cannot prevent a cycle or an
 * over-depth graph, so enforcement lives at the relation-authoring path (Import-Entity when a
 * relation is added) + the entity audit-cycle sweep, NOT here (TL t/3119, p/342#204). The DAG/
 * depth/target validator is a separate ticket (t/3170) that hard-BLOCKS any relations-populating
 * work — no path may persist an unvalidated `relations[]` (fast-follow enforced, not intended).
 */
export interface EntityRelation {
  type: EntityRelationType;
  target: string;                 // ent-* | term:<slug> raw token (parsed via parseEntityRef)
}

/** The new entity record (ent-*), stored in entities.json. */
export interface Entity {
  id: string;                     // ent-NNN
  name: string;
  aliases: string[];
  entity_type: EntityType;
  dolce_category: DolceCategory;
  /** Genus-differentia: "A [type] that [differentia]...". For a `person`, AI may draft it but
   *  approval requires a human edit — see `description_provenance` and the Import-Entity gate (t/3131). */
  description: string;
  /** Provenance of `description` — gates person approval (t/3131). Absent = legacy/unset
   *  (grandfathered as human-authored when the description is non-empty). See {@link EntityDescriptionProvenance}. */
  description_provenance?: EntityDescriptionProvenance;
  external_refs?: { label: string; url: string }[];
  source_refs?: string[];         // doc_ids
  /** Per doc in `source_refs`, why it is there (t/4404): 'quote-attributed' (its facts hold the entity's
   *  supporting quote), 'mention-verified' (its snapshot names the entity), or the recall steps
   *  'mention-verified-loose' / 'summary-mention'. Written by Invoke-EntityExtraction. NO consumer branches
   *  on it (PS Get-EntityReport reads only `source_refs_status`). THE EXEMPTION LAPSES the moment a consumer
   *  branches on it: that first branching reader is a T1 change. */
  source_refs_basis?: Record<string, 'quote-attributed' | 'mention-verified' | 'mention-verified-loose' | 'summary-mention'>;
  /** 'none-matched' = attribution checked every listed doc and none holds the quote or names the entity, so
   *  `source_refs` is empty on purpose; absent = not computed (pre-t/4404). Branching reader: PS
   *  Get-EntityReport (none-matched is its own category, not a provenance orphan). */
  source_refs_status?: 'attributed' | 'none-matched';
  /** DOLCE-typed relation edges (instance_of/subclass_of/part_of) to other entities/terms (R4.1).
   *  Optional; shallow-DAG + depth≤3 + acyclic invariant is enforced write-side, NOT by this type —
   *  see {@link EntityRelation}. Currently ACCEPTED-BUT-DROPPED by Import-Entity (allowlisted, not
   *  persisted) until the relation-authoring path + DAG validator land (t/3119 fast-follow). */
  relations?: EntityRelation[];
  status: 'proposed' | 'approved' | 'deprecated';
  /** Set ⇒ this record is a merge tombstone; resolve to the canonical id (Section 7).
   *  INVARIANT (t/4450, CL t/4450#2): set ⇒ `status === 'deprecated'`, and the record carries no vector.
   *  Enforced at the writer (PS Import-Entity); readers still resolve merged_into as defence in depth,
   *  and Get-EntityReport's tombstone-status section flags a record written before the invariant. */
  merged_into?: string;
  discovered_by?: { usage_id?: string; model?: string };
  confidence?: number;
  created_at: string;
  last_modified: string;
}

/** Summary row for the entity list/browser (t/1883). Derived from Entity — never forked. */
export type EntitySummary = Pick<Entity, 'id' | 'name' | 'aliases' | 'entity_type' | 'status' | 'confidence' | 'last_modified'>;
/** Query params for GET /api/entities / listEntities (v1: accepted, client-side-filtered — TL t/1766#7 Q6). */
export interface EntityListQuery { search?: string; sort?: string; type?: string; status?: string }

/** Common envelope. `redirected_from` is set when a merged_into tombstone was followed. */
export interface EntityDetailBase { ref: EntityRef; redirected_from?: string }

/**
 * Result of resolving an EntityRef, discriminated on the SAME `kind` field as EntityRef
 * so one switch covers both. Each payload REUSES the type that already owns that data;
 * only `entity` introduces a new shape. `not_found` is a member of the union, not an
 * exception — a resolve miss is a designed outcome. Kind set is `EntityRefKind | 'not_found'`,
 * and `record` is ABSENT (not null) on `not_found` so a pane can't render an empty record.
 */
export type EntityDetail =
  | (EntityDetailBase & { kind: 'node'; record: PovNode })
  | (EntityDetailBase & { kind: 'situation'; record: SituationNode })
  | (EntityDetailBase & { kind: 'policy'; record: PolicyAction })
  | (EntityDetailBase & { kind: 'organization'; record: Organization })
  | (EntityDetailBase & { kind: 'entity'; record: Entity })
  | (EntityDetailBase & { kind: 'term'; record: ColloquialTerm })
  | (EntityDetailBase & { kind: 'not_found' });
