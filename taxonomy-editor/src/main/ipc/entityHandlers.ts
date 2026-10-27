// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Entity-resolve handler (t/1809) — the Electron/desktop transport for the
// getEntity bridge method (t/1775). Mirrors the web transport
// `taxonomy-editor/src/server/routes/entity.ts` (GET /api/entity/:ref) so desktop
// and web resolve refs identically. The cross-stack contract (parseEntityRef +
// EntityDetail) is IMPORTED from lib/entities/types, never forked; the resolution
// helpers below mirror that route's private helpers, but the data reads use the
// main-process fileIO/organizations equivalents (sync) rather than the server's
// async storage layer.

import { ipcMain } from 'electron';
import fs from 'fs';
import path from 'path';
import { readTaxonomyFile, readPolicyRegistry, getDataRootPath, readEntities, loadDuplicateOfLookup } from '../fileIO.js';
import { getOrganizationById } from '../organizations.js';
import { parseEntityRef } from '../../../../lib/entities/types.js';
import { resolveMergedInto, normalizeEntity } from '../../../../lib/entities/entityResolve.js';
import { resolveRefsThroughDuplicateOf } from '../../../../lib/sourceIndex/types.js';
import type { EntityDetail, EntityRef, EntitySummary, EntityListQuery } from '../../../../lib/entities/types.js';
import type { PovNode, SituationNode } from '../../../../lib/debate/taxonomyTypes.js';
import type { PolicyAction } from '../../../../lib/policy/types.js';
import type { ColloquialTerm } from '../../../../lib/dictionary/types.js';
import { ActionableError } from '../../../../lib/debate/errors.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';

// ── Helpers mirroring server/routes/entity.ts (keep in sync with that route) ──

/** Map a POV-node id prefix (acc/saf/skp) to its taxonomy file key. null = unknown. */
function povFileForNodeId(id: string): string | null {
  const prefix = id.split('-')[0];
  if (prefix === 'acc') return 'accelerationist';
  if (prefix === 'saf') return 'safetyist';
  if (prefix === 'skp') return 'skeptic';
  return null;
}

/** A resolve miss — the `not_found` member of the union (no `record` field). */
function notFound(ref: EntityRef): EntityDetail {
  return { ref, kind: 'not_found' };
}

/** Pull the `.nodes` array out of a taxonomy file (POV + situations files wrap
 *  records under `nodes`). Tolerates a bare array as a fallback. */
function nodesOf(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  const nodes = (data as { nodes?: unknown })?.nodes;
  return Array.isArray(nodes) ? (nodes as Record<string, unknown>[]) : [];
}

/** Pull the policy-action array out of the registry. Production shape is
 *  `{ policies: [...] }`; also tolerate `{ policy_actions: [...] }` or a bare array. */
function policiesOf(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  const d = data as { policies?: unknown; policy_actions?: unknown } | null;
  const arr = d?.policies ?? d?.policy_actions;
  return Array.isArray(arr) ? (arr as Record<string, unknown>[]) : [];
}

/** Slugify a colloquial term into the `term:<slug>` wire form: lowercase,
 *  non-alphanumeric runs → single hyphen, trimmed. */
function slugifyTerm(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Load colloquial dictionary terms from `<dataRoot>/dictionary/colloquial/*.json`.
 *  Mirrors the server's `fileIO.loadDictionary().colloquial`; the main process has
 *  no single loader, so this reads the dir directly (same read the load-dictionary
 *  IPC handler performs). Best-effort: malformed files are skipped. */
function loadColloquialTerms(): ColloquialTerm[] {
  const colDir = path.join(getDataRootPath(), 'dictionary', 'colloquial');
  if (!fs.existsSync(colDir)) return [];
  const terms: ColloquialTerm[] = [];
  for (const f of fs.readdirSync(colDir).filter(n => n.endsWith('.json'))) {
    try {
      terms.push(JSON.parse(fs.readFileSync(path.join(colDir, f), 'utf-8')) as ColloquialTerm);
    } catch { /* telemetry — silent by design; skip malformed */ }
  }
  return terms;
}

// Depth cap passed to the shared resolveMergedInto (lib/entities/entityResolve, t/1974).
// Matches server/routes/entity.ts's MAX_MERGE_DEPTH.
const MAX_MERGE_DEPTH = 16;

// resolveMergedInto / normalizeEntity / coerceStringArray now live in
// lib/entities/entityResolve.ts (t/1974) — imported above, shared with the server route
// so the merge-follow + polymorphic-field coercion can't drift between transports (t/1984,
// replacing the sync mirror that t/1898 added).

/** Resolve a parsed EntityRef to its record, returning the EntityDetail union (a miss →
 *  not_found). Extracted verbatim from the entity-resolve handler's switch (t/1914). */
function resolveEntityRef(ref: EntityRef): EntityDetail {
  switch (ref.kind) {
    case 'organization': {
      const org = getOrganizationById(ref.id);
      // Organization has NO merged_into — no tombstone chase here.
      return org ? { ref, kind: 'organization', record: org } : notFound(ref);
    }

    case 'policy': {
      const found = policiesOf(readPolicyRegistry()).find(p => p.id === ref.id);
      return found ? { ref, kind: 'policy', record: found as unknown as PolicyAction } : notFound(ref);
    }

    case 'node': {
      const povFile = povFileForNodeId(ref.id);
      if (!povFile) return notFound(ref);
      const found = nodesOf(readTaxonomyFile(povFile)).find(n => n.id === ref.id);
      return found ? { ref, kind: 'node', record: found as unknown as PovNode } : notFound(ref);
    }

    case 'situation': {
      // sit-* and cc-* both live in the situations file (readTaxonomyFile
      // resolves situations.json → cross-cutting.json, whichever exists).
      const found = nodesOf(readTaxonomyFile('situations')).find(n => n.id === ref.id);
      return found ? { ref, kind: 'situation', record: found as unknown as SituationNode } : notFound(ref);
    }

    case 'term': {
      // Wire form is `term:<slug>`; slug maps to a ColloquialTerm by slugifying
      // its colloquial_term. Ambiguous slug (≥2 matches) → not_found (never guess).
      const slug = ref.id.slice('term:'.length);
      const matches = loadColloquialTerms().filter(t => slugifyTerm(t.colloquial_term ?? '') === slug);
      return matches.length === 1 ? { ref, kind: 'term', record: matches[0] } : notFound(ref);
    }

    case 'entity': {
      // ent-* resolves via the entity registry (readEntities, t/1889). Un-defers the old
      // stub now that entities.json ships — the server route did the same in t/1829; this
      // is the desktop mirror (t/1898#12). Build an id→Entity map, follow the merged_into
      // tombstone to the canonical record, and stamp redirected_from. An absent/empty store
      // → empty map → lookup miss → not_found (same semantic the server's null-registry has).
      const registry = new Map(readEntities().map((e) => [e.id, e] as const));
      const resolved = resolveMergedInto(ref.id, (id) => registry.get(id) ?? null, { maxDepth: MAX_MERGE_DEPTH });
      if (!resolved) return notFound(ref);
      // t/1964: normalize polymorphic aliases/source_refs before the detail/mention flow
      // renders them — ent-034 "Claude" (the mention target) has aliases: null.
      const record = normalizeEntity(resolved.record);
      // t/4528 (mirrors server routes/entity.ts's resolveEntityRegistryRef, t/4527): fold
      // source_refs through any valid duplicate_of mark before returning, so the renderer's
      // "Appears in" chips never show a doc already superseded by its canonical.
      // source_refs_basis (keyed by the PRE-fold ids) is deliberately left untouched — out of
      // this ticket's scope, PS's Get-EntityReport is its only reader today.
      if (record.source_refs && record.source_refs.length > 0) {
        const lookup = loadDuplicateOfLookup();
        record.source_refs = resolveRefsThroughDuplicateOf(record.source_refs, id => lookup[id]);
      }
      return resolved.redirectedFrom === undefined
        ? { ref, kind: 'entity', record }
        : { ref, redirected_from: resolved.redirectedFrom, kind: 'entity', record };
    }

    default: {
      // Exhaustiveness guard (mirrors entity.ts): if EntityRefKind grows, `ref`
      // stops being `never` and this fails to COMPILE, forcing the new kind to be
      // handled. Unreachable today; if ever hit, routes through the handler's catch.
      const _exhaustive: never = ref;
      throw new Error(`Unhandled entity ref kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

export function registerEntityHandlers(): void {
  // entity-resolve — desktop mirror of GET /api/entity/:ref. Resolves a raw ref
  // token to its record, returning the EntityDetail union (miss → not_found).
  ipcMain.handle('entity-resolve', (_event, raw: string): EntityDetail => {
    const ref = parseEntityRef(raw);
    // Malformed / unrecognized token = a client bug (an unbuildable ref should
    // never be requested). The web route answers 400; here we throw so getEntity
    // rejects. Thrown OUTSIDE the try below so it is NOT flight-recorded — this is
    // a 400-equivalent client error, not a system fault (mirrors entity.ts, whose
    // 400 path does not record; only the 500 catch does).
    if (!ref) {
      throw new ActionableError({
        goal: 'Resolve an entity ref in desktop mode',
        problem: `Malformed or unrecognized entity ref: "${raw}"`,
        location: 'ipc/entityHandlers.ts entity-resolve',
        nextSteps: ['Pass a ref parseEntityRef recognizes (node / situation / policy / org- / ent- / term:)'],
      });
    }

    try {
      return resolveEntityRef(ref);
    } catch (err) {
      // 500-equivalent: a genuine resolution fault (corrupt data / unexpected). The
      // web route's 500 catch records here too; the malformed 400 above does not.
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'ipc-entity-resolve', level: 'error',
        message: `Failed to resolve entity ref "${raw}"`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      throw err;
    }
  });

  // list-entities — desktop mirror of GET /api/entities (t/1889). Returns the full
  // list of entity summary rows (the 7-field EntitySummary pick) for the entity
  // browser. v1 is client-side filtering (TL t/1766#7 Q6): the query is accepted for
  // forward-compat but the full list is returned unchanged; moving filtering here
  // later is a same-contract change. readEntities returns [] when entities.json is
  // absent or malformed, so this never crashes (ADR-001 graceful-degrade). Keep the
  // row shape identical to the server route's map so web and desktop agree.
  ipcMain.handle('list-entities', (_event, _query?: EntityListQuery): EntitySummary[] => {
    return readEntities().map((e): EntitySummary => ({
      id: e.id,
      name: e.name,
      aliases: e.aliases,
      entity_type: e.entity_type,
      status: e.status,
      confidence: e.confidence,
      last_modified: e.last_modified,
    }));
  });
}
