// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Community op-ed public-share projection store (t/3315).
//
// Pattern-A publish-on-share for COMMUNITY items. Reuses projectPublicOpEd from
// opedShareStore for the positive-allowlist projection — the registry (community-
// scoped, atomic RMW) is owned by Server Community. This store owns only the
// public-copy write/delete for community items at public/opeds/{shareId}.json,
// the same user-agnostic location as own-op-ed shares.
//
// Privacy: community_metadata, submitted_by_display, original_id, submitted_at
// are ALL stripped by the positive allowlist (never a spread/denylist).
// TL t/3315#9 condition 4: non-empty guard prevents a false-empty read from
// minting a vacuous public copy (ADR-001 class, t/2648).

import path from 'path';
import type { OpEdSet } from '../../../../lib/oped/types.js';
import { ActionableError } from '../../../../lib/debate/errors.js';
import { resolveDataPath } from '../config.js';
import { assertSafeId, getUserContentBackend } from './fileIO.js';
import { projectPublicOpEd, type PublicOpEd } from './opedShareStore.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';

const PUBLIC_OPEDS_DIR = 'public/opeds';

function publicCommunityOpedPath(shareId: string): string {
  return path.join(resolveDataPath(PUBLIC_OPEDS_DIR), `${shareId}.json`);
}

// Community items extend OpEdSet with submission-context fields.
// We name them explicitly so the negative test can assert they are absent
// from the public projection. projectPublicOpEd strips them via positive allowlist.
export type CommunityOpEdItem = OpEdSet & {
  community_metadata?: unknown;
  submitted_by_display?: string;
  original_id?: string;
  submitted_at?: string;
};

/**
 * Project a community op-ed item through the positive allowlist and write the
 * resulting public copy to public/opeds/{shareId}.json. The registry (community-
 * scoped idempotent shareId) is managed by Server Community — this function writes
 * ONLY the public projection.
 *
 * TL t/3315#9 condition 4: throws BEFORE projecting if the item is missing required
 * fields — prevents minting a vacuous public copy from a silent-empty backend read.
 */
export async function writePublicCommunityOpEd(
  item: CommunityOpEdItem,
  shareId: string,
): Promise<void> {
  assertSafeId(shareId, 'community oped shareId');

  if (!item.topic || !Array.isArray(item.opeds) || item.opeds.length === 0) {
    throw new ActionableError({
      goal: 'Publish community op-ed public copy',
      problem: 'Community op-ed item is empty or missing required fields — will not mint a vacuous public copy.',
      location: 'communityOpedShareStore.writePublicCommunityOpEd',
      nextSteps: [
        'Verify getCommunityOpEd returned a valid, non-empty item',
        'Check for false-empty reads from the GitHub API backend (t/3300)',
      ],
    });
  }

  const projection = await projectPublicOpEd(item as OpEdSet, shareId);
  await getUserContentBackend().writeFile(
    publicCommunityOpedPath(shareId),
    JSON.stringify(projection, null, 2),
  );
}

/**
 * Delete a community op-ed's public copy (revocation path). Best-effort — never
 * throws, so a caller mid-revocation isn't blocked by this cleanup step (the registry
 * entry, cleared by the caller before this runs, already makes the share unresolvable
 * via the normal mint/list path). Called after the registry entry is cleared so the
 * public copy can no longer be resolved by a shareId.
 *
 * t/4894 security-review finding: `deleteFile` is already documented as a no-op on a
 * missing file (storageBackend.ts), so this catch exists for GENUINE failures (storage
 * down, permission error), not the missing-file case its old comment named. Swallowing
 * those silently meant `GET /api/public/oped/:shareId` could keep serving a 'removed'
 * item's content indefinitely with zero record anywhere that cleanup needs retrying —
 * defeating the point of a revocation path. WARN instead, still never throwing.
 */
export async function deletePublicCommunityOpEd(shareId: string): Promise<void> {
  assertSafeId(shareId, 'community oped shareId');
  await getUserContentBackend().deleteFile(publicCommunityOpedPath(shareId)).catch((err: unknown) => {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'community-oped-share-store', level: 'warn',
      message: `Failed to delete public community op-ed copy for shareId ${shareId} — the public link may remain reachable; this does not block the caller's revocation`,
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
  });
}

export type { PublicOpEd };
