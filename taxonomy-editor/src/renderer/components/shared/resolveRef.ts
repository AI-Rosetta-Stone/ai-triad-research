// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type { EntityRef, EntityDetail } from '@lib/entities/types';
import type { PolicyAction } from '@lib/policy/types';
import { api } from '@bridge';
import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';
import { allNodesById } from '../../hooks/useTaxonomyStore/superseded';

/**
 * Resolve an {@link EntityRef} to its {@link EntityDetail} for the DetailPane
 * (t/1775, TL-approved t/1775#4). This is the renderer half of the same contract
 * the server's `GET /api/entity/:ref` implements — one `switch (ref.kind)` covers both.
 *
 * **Hybrid strategy:**
 * - `node` / `situation` / `policy` → resolved CLIENT-SIDE from the taxonomy store
 *   (already loaded in both web and electron builds; no round-trip). Mirrors the
 *   store's own `lookupPinnedData` / `getLabelForId` lookups.
 * - `entity` / `organization` / `term` → SERVER-ONLY records, resolved via the
 *   `getEntity` bridge. The server follows merge tombstones and stamps
 *   `redirected_from` on the result — the DetailPane honors that.
 *
 * A resolve miss is a designed outcome, not an error: it returns
 * `{ kind: 'not_found', ref }` (matching the server's `notFound` result).
 *
 * @param ref A parsed, valid ref. Callers parse raw tokens with `parseEntityRef`
 *   first and skip rendering a link when it returns `null` (refusal discipline lives
 *   in the parse layer, so `not_found` here always carries a real `ref`).
 */
export async function resolveRef(ref: EntityRef): Promise<EntityDetail> {
  switch (ref.kind) {
    case 'node':
      return resolveNode(ref);
    case 'situation':
      return resolveSituation(ref);
    case 'policy':
      return resolvePolicy(ref);
    case 'entity':
    case 'organization':
    case 'term':
      // Server-only records — the bridge hits GET /api/entity/:ref. `ref.id` is the
      // raw token (for `term`, the full `term:<slug>` form parseEntityRef produced).
      return api.getEntity(ref.id);
    default: {
      // Exhaustiveness guard (mirrors the server's entity.ts:216-224). If EntityRef
      // grows a kind, `ref` here stops being `never` and this fails to COMPILE —
      // forcing the new kind onto an explicit client- or bridge-resolution path
      // rather than silently falling through. Unreachable today.
      const _exhaustive: never = ref;
      throw new Error(`Unhandled entity ref kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

function resolveNode(ref: Extract<EntityRef, { kind: 'node' }>): EntityDetail {
  // t/4355: a citation shows the exact node it cited, superseded or not (historical display).
  const node = allNodesById(useTaxonomyStore.getState()).get(ref.id);
  return node ? { kind: 'node', ref, record: node } : { kind: 'not_found', ref };
}

function resolveSituation(ref: Extract<EntityRef, { kind: 'situation' }>): EntityDetail {
  const node = useTaxonomyStore.getState().situations?.nodes.find(n => n.id === ref.id);
  return node ? { kind: 'situation', ref, record: node } : { kind: 'not_found', ref };
}

function resolvePolicy(ref: Extract<EntityRef, { kind: 'policy' }>): EntityDetail {
  // The store holds the lighter PolicyRegistryEntry; PolicyAction requires only
  // id+action (the rest optional), so the entry satisfies it structurally — the
  // same source shape the server returns for pol-* (entity.ts:161-165).
  const entry = useTaxonomyStore.getState().policyRegistry?.find(p => p.id === ref.id);
  return entry
    ? { kind: 'policy', ref, record: entry as PolicyAction }
    : { kind: 'not_found', ref };
}
