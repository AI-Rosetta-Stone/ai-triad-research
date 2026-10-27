// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/1786 (ServerAPI) — GET /api/entity/:ref, the server consumer of the
// cross-stack entity-ref contract (t/1767 §5, shipped in lib/entities/types.ts).
// One public read endpoint (no auth gate, like /api/organizations) that parses a
// raw ref token to a typed EntityRef and resolves it to the record type that
// already owns that kind's data, returning the EntityDetail result union. The
// contract is IMPORTED, never forked — parseEntityRef + EntityDetail come from
// lib/entities/types.js.

import type { Router } from '../httpKit.js';
import type { ServerCtx } from './context.js';
import type { PovNode, SituationNode } from '../../../../lib/debate/taxonomyTypes.js';
import type { PolicyAction } from '../../../../lib/policy/types.js';
import type { ColloquialTerm } from '../../../../lib/dictionary/types.js';
import type { Entity, EntityDetail, EntityRef, EntitySummary } from '../../../../lib/entities/types.js';
import { json, error, param } from '../httpKit.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { parseEntityRef } from '../../../../lib/entities/types.js';
// t/1974: the pure resolve/coerce helpers now live in lib/entities/entityResolve
// (shared byte-identical by the server + ElectronMain transports); imported here
// rather than defined locally so the two copies can't drift.
import { resolveMergedInto, normalizeEntity, coerceStringArray } from '../../../../lib/entities/entityResolve.js';
import { resolveRefsThroughDuplicateOf, type ScopedDocLookup } from '../../../../lib/sourceIndex/types.js';
import * as fileIO from '../storage/fileIO.js';
import { getOrganizationById } from '../organizations.js';
import { loadSourcesIndex } from '../storage/sourcesIndexReader.js';

// Depth cap for the merged_into tombstone chase (Section 7). A well-formed merge
// graph is a short chain; anything past this is corrupt data, not deep nesting.
const MAX_MERGE_DEPTH = 16;

/** Map a POV-node id prefix (acc/saf/skp) to its taxonomy file key. null = unknown. */
function povFileForNodeId(id: string): string | null {
  const prefix = id.split('-')[0];
  if (prefix === 'acc') return 'accelerationist';
  if (prefix === 'saf') return 'safetyist';
  if (prefix === 'skp') return 'skeptic';
  return null;
}

/** A resolve miss — the `not_found` member of the union (no `record` field). */
function notFound(ref: EntityRef, redirectedFrom?: string): EntityDetail {
  return redirectedFrom === undefined
    ? { ref, kind: 'not_found' }
    : { ref, redirected_from: redirectedFrom, kind: 'not_found' };
}

/** Pull the `.nodes` array out of a taxonomy file (both POV + situations files
 *  wrap their records under `nodes`). Tolerates a bare array as a fallback. */
function nodesOf(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  const nodes = (data as { nodes?: unknown })?.nodes;
  return Array.isArray(nodes) ? (nodes as Record<string, unknown>[]) : [];
}

/** Pull the policy-action array out of the registry. Production shape is
 *  `{ policies: [...] }`; also tolerate `{ policy_actions: [...] }` or a bare
 *  array so a schema rename doesn't silently 404 every policy. */
function policiesOf(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  const d = data as { policies?: unknown; policy_actions?: unknown } | null;
  const arr = d?.policies ?? d?.policy_actions;
  return Array.isArray(arr) ? (arr as Record<string, unknown>[]) : [];
}

/** Slugify a colloquial term into the `term:<slug>` wire form: lowercase,
 *  non-alphanumeric runs → single hyphen, trimmed. Deterministic and reversible
 *  enough that "labor displacement" ⇔ "labor-displacement". */
function slugifyTerm(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Load the entity registry (ent-* records) as an id→Entity map. Delegates to the
 * Server-Storage-owned fileIO.readEntityRegistry() (t/1807: 30s TTL cache; returns
 * null when entities.json is absent, which keeps the `entity` branch's not_found
 * semantic stable until the store is populated). Wired live in t/1829 (was the
 * deferred null stub from t/1786).
 */
async function loadEntityRegistry(): Promise<Map<string, Entity> | null> {
  return fileIO.readEntityRegistry();
}

// ── /api/entity/:ref per-kind resolvers ──
// Extracted from the route handler's dispatch switch (ADR-007) so each kind's
// lookup is a small named step and the switch stays flat. Each returns the JSON
// payload — the `{ ref, kind, record }` wrapper or notFound(ref).

async function resolveOrgRef(ref: EntityRef): Promise<unknown> {
  const org = await getOrganizationById(ref.id);
  // Organization has NO merged_into — no tombstone chase here.
  return org ? { ref, kind: 'organization', record: org } : notFound(ref);
}

async function resolvePolicyRef(ref: EntityRef): Promise<unknown> {
  const registry = await fileIO.readPolicyRegistry();
  const found = policiesOf(registry).find(p => p.id === ref.id);
  return found ? { ref, kind: 'policy', record: found as unknown as PolicyAction } : notFound(ref);
}

async function resolveNodeRef(ref: EntityRef): Promise<unknown> {
  const povFile = povFileForNodeId(ref.id);
  if (!povFile) return notFound(ref);
  const data = await fileIO.readTaxonomyFile(povFile);
  const found = nodesOf(data).find(n => n.id === ref.id);
  return found ? { ref, kind: 'node', record: found as unknown as PovNode } : notFound(ref);
}

async function resolveSituationRef(ref: EntityRef): Promise<unknown> {
  // sit-* and cc-* both live in the situations file (readTaxonomyFile
  // resolves situations.json → cross-cutting.json, whichever exists).
  const data = await fileIO.readTaxonomyFile('situations');
  const found = nodesOf(data).find(n => n.id === ref.id);
  return found ? { ref, kind: 'situation', record: found as unknown as SituationNode } : notFound(ref);
}

async function resolveTermRef(ref: EntityRef): Promise<unknown> {
  // Wire form is `term:<slug>`; slug maps to a ColloquialTerm by slugifying its
  // colloquial_term. If two terms collide onto the same slug the mapping is
  // ambiguous → not_found (refusal discipline; never guess a target).
  const slug = ref.id.slice('term:'.length);
  const colloquial = (await fileIO.loadDictionary()).colloquial as ColloquialTerm[];
  const matches = colloquial.filter(t => slugifyTerm(t.colloquial_term ?? '') === slug);
  return matches.length === 1 ? { ref, kind: 'term', record: matches[0] } : notFound(ref);
}

async function resolveEntityRegistryRef(ref: EntityRef): Promise<unknown> {
  // t/1829: ent-* resolves via the entity registry (fileIO.readEntityRegistry,
  // t/1807). resolveMergedInto follows a merge tombstone to the canonical record
  // and stamps redirected_from. Absent store → registry is null → not_found
  // (semantic held stable until entities.json is populated).
  const registry = await loadEntityRegistry();
  if (!registry) return notFound(ref);
  const resolved = resolveMergedInto(ref.id, id => registry.get(id) ?? null, { maxDepth: MAX_MERGE_DEPTH });
  if (!resolved) return notFound(ref);
  // t/1964: normalize polymorphic aliases/source_refs before the detail/mention
  // flow renders them — ent-034 "Claude" (the mention target) has aliases: null.
  const record = normalizeEntity(resolved.record);
  // t/4527: fold source_refs through any valid duplicate_of mark (spec 6.1 checks 1-3) before
  // returning, so the renderer's "Appears in" chips never show a doc already superseded by
  // its canonical. source_refs_basis (keyed by the PRE-fold ids) is deliberately left
  // untouched — out of this ticket's scope, PS's Get-EntityReport is its only reader today.
  if (record.source_refs && record.source_refs.length > 0) {
    const sourcesIndex = await loadSourcesIndex();
    if (sourcesIndex) {
      const lookup = new Map<string, ScopedDocLookup>(sourcesIndex.docs.map(d => [d.id, d]));
      record.source_refs = resolveRefsThroughDuplicateOf(record.source_refs, id => lookup.get(id));
    }
  }
  return resolved.redirectedFrom === undefined
    ? { ref, kind: 'entity', record }
    : { ref, redirected_from: resolved.redirectedFrom, kind: 'entity', record };
}

/** Dispatch an entity ref to its per-kind resolver, returning the JSON payload.
 *  Exhaustive over EntityRefKind — the `never` default fails to COMPILE if a new
 *  kind is added without a resolver (t/1786 fast-follow, TL). */
async function resolveEntityByRef(ref: EntityRef): Promise<unknown> {
  switch (ref.kind) {
    case 'organization': return resolveOrgRef(ref);
    case 'policy': return resolvePolicyRef(ref);
    case 'node': return resolveNodeRef(ref);
    case 'situation': return resolveSituationRef(ref);
    case 'term': return resolveTermRef(ref);
    case 'entity': return resolveEntityRegistryRef(ref);
    default: {
      const _exhaustive: never = ref;
      throw new Error(`Unhandled entity ref kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

export function registerEntityRoutes(r: Router, _ctx: ServerCtx): void {
  const { get } = r;

  // GET /api/entities — session-gated list of entity summary rows for the browser.
  get('/api/entities', async (req, res) => {
    try {
      // v1: client-side filter (TL t/1766#7 Q6) — accept search/sort/type/status query
      // params for forward-compat but return the full summary list. readEntityRegistry
      // (t/1807) returns null when entities.json is absent → [] (never crash, ADR-001).
      const reg = await fileIO.readEntityRegistry();
      const rows: EntitySummary[] = reg
        ? [...reg.values()].map(e => ({
            // t/1964: aliases is polymorphic in the store (array | null | string) — coerce
            // so EntityBrowserPanel's `e.aliases.some(...)` off the summary never crashes.
            id: e.id, name: e.name, aliases: coerceStringArray(e.aliases),
            entity_type: e.entity_type, status: e.status,
            confidence: e.confidence, last_modified: e.last_modified,
          }))
        : [];
      json(res, rows);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'server', level: 'error',
        message: 'Failed to list entities',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, String(err), 500, err);
    }
  });

  // GET /api/entity/:ref — public read: resolve any entity-ref token to its record.
  get('/api/entity/:ref', async (req, res) => {
    const raw = param(req, 'ref', '/api/entity/:ref');
    try {
      const ref = parseEntityRef(raw);
      // Malformed / unrecognized token = a client bug (an unbuildable ref should
      // never be requested) → 400, not a not_found result.
      if (!ref) { error(res, `Malformed or unrecognized entity ref: "${raw}"`, 400); return; }

      json(res, await resolveEntityByRef(ref));
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'server', level: 'error',
        message: `Failed to resolve entity ref "${raw}"`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, String(err), 500, err);
    }
  });
}
