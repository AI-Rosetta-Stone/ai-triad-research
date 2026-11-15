// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Op-ed public-share storage (t/2727; design t/2723#3, SO-approved e/106#2).
//
// Pattern A — publish-on-share. On share, the owner's op-ed set is projected to a
// POSITIVE field allowlist and written to a fixed, USER-AGNOSTIC location
// (public/opeds/{shareId}.json). The public read path reads ONLY from there and
// NEVER touches users/**, so there is no code path from the unauthenticated surface
// into private user storage. The URL key is a fresh random shareId (≠ the storage
// setId) so a leaked link is revoked for good by delete + re-share.

import path from 'path';
import { randomUUID } from 'crypto';
import { resolveDataPath } from '../config.js';
import type { OpEdSet, OpEdMember, OpEdGroundingRef } from '../../../../lib/oped/types.js';
import { getStorageUserId, isAnonymousUser, runWithUser, type UserContext } from '../security/userContext.js';
import { getUserContentBackend, assertSafeId, isSafeId, readTaxonomyFile } from './fileIO.js';
import { loadOpedSet } from './opedStore.js';
import { confirmShareStillRegistered } from './shareRevokeGuard.js';
import { readShareRegistry as readRegistryFile, updateShareRegistry } from './shareRegistry.js';
import { log } from '../logger.js';
import { AppliedTagSchema, type TagMode } from '../../../../lib/schema/povTags.js';

// t/3488 (SO-fixed contract t/3487#1, TL amendment t/3488#2): description excerpt
// length cap, defined at the pick site per SO condition 1.
const GROUNDING_EXCERPT_MAX_CHARS = 280;

// t/3645 (SO parity retrofit, e/201 — the same class of gap flagged for the inquiry
// share's `evidenceLayers.sources`): `relevance`/`how_reflected`/`document_claims`
// are unconstrained free text at the type + zod-schema level (lib/oped/types.ts,
// lib/oped/schemas.ts) — LLM- or source-document-derived, no length/count cap ever
// enforced upstream. Capped here at the public-projection boundary, same silent-
// truncation precedent as GROUNDING_EXCERPT_MAX_CHARS (routine sanitization, not a
// failure path — no WARN on truncation, consistent with description_excerpt above).
const GROUNDING_FREE_TEXT_MAX_CHARS = 280;
const DOCUMENT_CLAIM_MAX_CHARS = 280;
const DOCUMENT_CLAIMS_MAX_COUNT = 10;

// Public copies live under a fixed, user-agnostic prefix — NEVER under users/{id}/.
const PUBLIC_OPEDS_DIR = 'public/opeds';
// Owner-scoped registry mapping setId → shareId, so un-share/re-share can find the
// public copy without exposing the setId in the public URL.
const SHARE_REGISTRY_FILE = 'oped-shares.json';

function publicOpedPath(shareId: string): string {
  return path.join(resolveDataPath(PUBLIC_OPEDS_DIR), `${shareId}.json`);
}
function shareRegistryPath(): string {
  return path.join(resolveDataPath(`users/${getStorageUserId()}`), SHARE_REGISTRY_FILE);
}

// ── Public wire shape — POSITIVE allowlist, the info-leak control ─────────────
// Only these fields ever reach the public copy at rest. Generation params (model,
// prompts, thesis, authorBio, newsHook), grounding internals,
// userId, and the storage set_id are all STRIPPED — never a spread/denylist.
// `soul` is STRIPPED too (t/3990; TL e/254#4, t/3960#8): it records which soul file
// voiced the member — an internal file path and hash, the same class as `debateId`
// on the inquiry share. It identifies internals, not the essay, so a public reader
// has no use for it and a prober would.
export interface PublicOpEdMember {
  pov: string;
  status: string;
  headline: string;
  subtitle: string;
  body: string;
  wordCount: number;
  grounding: OpEdGroundingRef[];
  /** t/3990: present only on a tagged member — see PublicOpEdMemberTag. */
  tag?: PublicOpEdMemberTag;
}
/**
 * t/3990 (SO e/254#6, mirroring e/252 cond 1): the tagged member's scope, so a Scope op-ed is not
 * published as the whole camp's voice when it is one wing's. Copied by named field reads from the
 * member's applied tag — never a spread. Count meanings per mode live on `AppliedTagSchema`
 * (`APPLIED_TAG_COUNT_MEANING`): in Prioritize `excludedUntagged` is 0 by construction and means
 * "this mode excludes nothing", NOT full coverage — readers show the exclusion count only for Scope.
 */
export interface PublicOpEdMemberTag {
  pov: string;
  tag: string;
  mode: TagMode;
  included: number;
  excludedUntagged: number;
}
// t/3488 (SO cond 1): explicit five-field pick, never `{...node}`. `pov`/`category`
// come from the grounding ref (the citing voice's classification — situation
// nodes carry neither field natively); `id`/`label`/`description_excerpt` are
// resolved fresh from the taxonomy node so the snapshot reflects real data.
export interface PublicGroundingNode {
  id: string;
  label: string;
  pov: string;
  category: string;
  description_excerpt: string;
}
export interface PublicOpEd {
  schema_version: 1 | 2;
  shareId: string;
  topic: string;
  outlet: string | null;
  created_at: string;
  opeds: PublicOpEdMember[];
  grounding_nodes: Record<string, PublicGroundingNode>;
  grounded_at: string;
}

function truncateExcerpt(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max).trimEnd()}…` : trimmed;
}

/**
 * Resolve one grounding ref's node from taxonomy data. Mirrors the in-app
 * resolution order (OpEdReader.tsx GroundingDetailCard, t/3488#2 TL amendment):
 * sit-* ids resolve from the situations file; everything else resolves from the
 * ref's own pov file (accelerationist/safetyist/skeptic). Returns null if the
 * node isn't found or the backing file can't be read — caller WARNs and skips.
 */
async function resolveGroundingNode(
  ref: OpEdGroundingRef,
  cache: Map<string, Map<string, { label: string; description: string }>>,
): Promise<{ label: string; description: string } | null> {
  const fileKey = ref.node_id?.startsWith('sit-') ? 'situations' : ref.pov;
  let nodesById = cache.get(fileKey);
  if (!nodesById) {
    nodesById = new Map();
    try {
      const data = await readTaxonomyFile(fileKey);
      const nodes = Array.isArray((data as { nodes?: unknown })?.nodes)
        ? (data as { nodes: Array<{ id: string; label?: string; description?: string }> }).nodes
        : [];
      for (const n of nodes) {
        if (n?.id) nodesById.set(n.id, { label: String(n.label ?? ''), description: String(n.description ?? '') });
      }
    } catch (err) {
      log.server.warn({ fileKey, err, cause: 'grounding-taxonomy-file-unreadable' },
        'skipping grounding nodes from an unreadable taxonomy file in public op-ed projection (t/3488)');
    }
    cache.set(fileKey, nodesById);
  }
  return nodesById.get(ref.node_id) ?? null;
}

/**
 * Build the grounding_nodes{} snapshot map for every unique node_id referenced
 * across all members. Unresolvable refs are WARNed and OMITTED (never written
 * as null/undefined) — SO cond 3, fallback-logging rule. Rebuilt from scratch on
 * every call, so a full rewrite is always a full replace — SO cond 2.
 */
async function buildGroundingNodes(members: OpEdMember[]): Promise<Record<string, PublicGroundingNode>> {
  const allRefs = members.flatMap(m => (Array.isArray(m.grounding) ? m.grounding : []));
  const cache = new Map<string, Map<string, { label: string; description: string }>>();
  const result: Record<string, PublicGroundingNode> = {};
  for (const ref of allRefs) {
    if (!ref?.node_id || result[ref.node_id]) continue; // already resolved this id
    const node = await resolveGroundingNode(ref, cache);
    if (!node) {
      log.server.warn({ node_id: ref.node_id, pov: ref.pov, cause: 'grounding-node-unresolvable' },
        'skipping unresolvable grounding node in public op-ed projection (t/3488)');
      continue;
    }
    result[ref.node_id] = {
      id: ref.node_id,
      label: node.label,
      pov: ref.pov,
      category: ref.category,
      description_excerpt: truncateExcerpt(node.description, GROUNDING_EXCERPT_MAX_CHARS),
    };
  }
  return result;
}

/**
 * t/3990: project a member's applied tag (if any) by NAMED field reads — the stored `tag` is a
 * passthrough-tolerant record, so a spread would carry any future field into the public copy.
 * Validated with `AppliedTagSchema` first: a malformed tag is omitted with a WARN (fallback-path
 * logging) — there is nothing trustworthy to show, and the member itself still projects.
 */
function projectMemberTag(m: OpEdMember): PublicOpEdMemberTag | undefined {
  if (m.tag === undefined) return undefined;
  const parsed = AppliedTagSchema.safeParse(m.tag);
  if (!parsed.success) {
    log.server.warn({ pov: m.pov, issues: parsed.error.issues.map(i => i.message), cause: 'oped-share-tag-malformed' },
      'malformed applied tag on an op-ed member — omitting it from the public projection (t/3990)');
    return undefined;
  }
  const { pov, tag, mode, included, excludedUntagged } = parsed.data;
  return { pov, tag, mode, included, excludedUntagged };
}

/** Build the public projection by EXPLICIT field — never `{...set}` or a delete-keys denylist. */
export async function projectPublicOpEd(set: OpEdSet, shareId: string): Promise<PublicOpEd> {
  const members = Array.isArray(set.opeds) ? set.opeds : [];
  return {
    schema_version: 2,
    shareId,
    topic: String(set.topic ?? ''),
    outlet: set.params?.outlet ?? null, // editorial context, public-safe
    created_at: String(set.created_at ?? ''),
    opeds: members.map((m: OpEdMember) => {
      const tag = projectMemberTag(m);
      return {
        pov: m.pov,
        status: m.status,
        headline: String(m.headline ?? ''),
        subtitle: String(m.subtitle ?? ''),
        body: String(m.body ?? ''),
        wordCount: typeof m.wordCount === 'number' ? m.wordCount : 0,
        grounding: (Array.isArray(m.grounding) ? m.grounding : []).map(g => ({
          node_id: g.node_id,
          label: g.label,
          category: g.category,
          pov: g.pov,
          relevance: truncateExcerpt(String(g.relevance ?? ''), GROUNDING_FREE_TEXT_MAX_CHARS),
          how_reflected: truncateExcerpt(String(g.how_reflected ?? ''), GROUNDING_FREE_TEXT_MAX_CHARS),
          ...(g.document_claims?.length
            ? { document_claims: g.document_claims.slice(0, DOCUMENT_CLAIMS_MAX_COUNT)
              .map(c => truncateExcerpt(String(c ?? ''), DOCUMENT_CLAIM_MAX_CHARS)) }
            : {}),
        })),
        ...(tag ? { tag } : {}),
      };
    }),
    grounding_nodes: await buildGroundingNodes(members),
    grounded_at: new Date().toISOString(),
  };
}

function readShareRegistry(): Promise<Record<string, string>> {
  return readRegistryFile(getUserContentBackend(), shareRegistryPath());
}
/** t/117: compare-and-swap registry update — see shareRegistry.ts. */
function updateRegistry<T>(mutate: (reg: Record<string, string>) => { changed: boolean; result: T }): Promise<T> {
  return updateShareRegistry(getUserContentBackend(), shareRegistryPath(), 'oped', mutate);
}
function confirmOpedShare(setId: string, shareId: string): Promise<boolean> {
  return confirmShareStillRegistered({
    kind: 'oped', id: setId, shareId, publicPath: publicOpedPath(shareId), readRegistry: readShareRegistry,
    backend: getUserContentBackend(),
  });
}

/**
 * Publish an owner's op-ed set to a durable public URL. OWNER-ONLY: `loadOpedSet`
 * reads under the caller's `getStorageUserId()` scope, so a set the caller doesn't
 * own (or that doesn't exist) yields null → the route returns an indistinguishable
 * 404. Idempotent: an already-shared set refreshes its existing shareId (no dup copy).
 */
export async function publishOpedShare(setId: string): Promise<{ shareId: string } | null> {
  assertSafeId(setId, 'oped-set id');
  if (isAnonymousUser()) return null; // no durable owner scope to share from
  const set = (await loadOpedSet(setId)) as OpEdSet | null;
  if (!set) return null;

  const reg = await readShareRegistry();
  const existing = reg[setId];
  const shareId = existing ?? randomUUID();
  await getUserContentBackend().writeFile(
    publicOpedPath(shareId),
    JSON.stringify(await projectPublicOpEd(set, shareId), null, 2),
  );
  if (!existing) {
    // t/117: add only if still absent — a concurrent publish that minted its own shareId wins,
    // and the guard below then removes our copy. On give-up, drop the orphan we just wrote.
    try {
      await updateRegistry((r) => {
        if (r[setId]) return { changed: false, result: undefined };
        r[setId] = shareId;
        return { changed: true, result: undefined };
      });
    } catch (err) {
      await getUserContentBackend().deleteFile(publicOpedPath(shareId)).catch((delErr) => {
        log.server.warn({ err: delErr, shareId }, 'oped share orphan cleanup after registry failure failed (best-effort)');
      });
      throw err;
    }
  }
  // t/4937: an unpublish may have raced the write above — never leave a revoked link live.
  if (!(await confirmOpedShare(setId, shareId))) return null;
  return { shareId };
}

/**
 * Refresh an EXISTING public share's projection in place (t/4927) — e.g. after a rename, so
 * the public copy's topic isn't left stale. Same shareId, same URL; never mints one. Returns
 * false (no-op) if the set isn't shared, which is the "never creates a share" contract —
 * callers must NOT fall back to `publishOpedShare` on a false return.
 */
export async function refreshOpedShareIfShared(setId: string): Promise<boolean> {
  assertSafeId(setId, 'oped-set id');
  if (isAnonymousUser()) return false;
  const reg = await readShareRegistry();
  const shareId = reg[setId];
  if (!shareId) return false;
  const set = (await loadOpedSet(setId)) as OpEdSet | null;
  if (!set) return false; // defensive; caller already has the set at this point
  await getUserContentBackend().writeFile(
    publicOpedPath(shareId),
    JSON.stringify(await projectPublicOpEd(set, shareId), null, 2),
  );
  return confirmOpedShare(setId, shareId); // t/4937
}

/**
 * Un-share (owner-only — the registry is owner-scoped): delete the public copy +
 * registry entry. Returns true if a share existed. With the fresh-shareId scheme this
 * is a real revocation — a leaked old link is permanently dead.
 */
export async function unpublishOpedShare(setId: string): Promise<boolean> {
  assertSafeId(setId, 'oped-set id');
  if (isAnonymousUser()) return false;
  // t/4937: registry entry goes FIRST, so a publish/refresh whose write lands after the delete
  // below re-reads a registry that no longer names this shareId and removes its own copy.
  // t/117: compare-and-swap, so a concurrent registry write can't put the entry back.
  const shareId = await updateRegistry((r) => {
    const current = r[setId];
    if (!current) return { changed: false, result: undefined };
    delete r[setId];
    return { changed: true, result: current };
  });
  if (!shareId) return false;
  await getUserContentBackend().deleteFile(publicOpedPath(shareId)).catch((err) => {
    log.server.warn({ err, shareId }, 'oped share public-copy delete failed (best-effort)');
  });
  return true;
}

/**
 * t/3490 — one-time (safe to re-run) backfill: re-projects every existing owner-scoped
 * public share by replaying publishOpedShare() for each users/{id}/oped-shares.json
 * registry entry. projectPublicOpEd() is a full overwrite (SO cond 2), so this alone
 * upgrades every pre-t/3488 share from schema_version 1 to 2 (grounding embed) — no
 * migration logic needed. Mirrors Server Community's precedent for the sibling
 * population (t/3483 backfillCommunityOpedShares). Sequential across users (an
 * admin-triggered one-time op, not latency-sensitive); per-item failures are recorded
 * and do not abort the run.
 */
export async function backfillOwnOpedShares(): Promise<{
  reprojected: number; skipped: number; skippedDetails: { userId: string; setId: string; reason: string }[];
}> {
  const backend = getUserContentBackend();
  const userIds = await backend.listDirectory(resolveDataPath('users'));
  let reprojected = 0;
  const skippedDetails: { userId: string; setId: string; reason: string }[] = [];

  for (const userId of userIds) {
    if (!isSafeId(userId)) {
      skippedDetails.push({ userId, setId: '', reason: 'unsafe-user-dir-name' });
      log.server.warn({ userId, cause: 'own-oped-share-backfill-unsafe-user-dir' },
        'skipping own op-ed share backfill for an unsafe users/ directory entry (t/3490)');
      continue;
    }
    const ctx: UserContext = { principalName: userId, idp: 'backfill', storageUserId: userId, isAnonymous: false };
    const reg = await runWithUser(ctx, () => readShareRegistry());

    for (const setId of Object.keys(reg)) {
      try {
        const result = await runWithUser(ctx, () => publishOpedShare(setId));
        if (result) {
          reprojected++;
        } else {
          skippedDetails.push({ userId, setId, reason: 'set-not-found' });
          log.server.warn({ userId, setId, cause: 'own-oped-share-backfill-set-missing' },
            'skipping own op-ed share backfill item whose set no longer exists (t/3490)');
        }
      } catch (err) {
        skippedDetails.push({ userId, setId, reason: String(err) });
        log.server.warn({ userId, setId, err, cause: 'own-oped-share-backfill-item-failed' },
          'skipping own op-ed share backfill item that failed to re-project (t/3490)');
      }
    }
  }

  log.server.info({ reprojected, skipped: skippedDetails.length }, 'Own op-ed share backfill complete (t/3490)');
  return { reprojected, skipped: skippedDetails.length, skippedDetails };
}

/**
 * Read a published public op-ed by shareId — the UNAUTHENTICATED path. Reads ONLY
 * from the user-agnostic public dir; never touches users/**. Returns null if not
 * shared or revoked. The file at rest is already the positive projection (written by
 * publishOpedShare), so no private field can be present. shareId shape is validated
 * by the route (invalidRouteParam) before this is called.
 */
export async function loadPublicOpedShare(shareId: string): Promise<PublicOpEd | null> {
  const raw = await getUserContentBackend().readFile(publicOpedPath(shareId));
  if (raw === null) return null;
  try { return JSON.parse(raw) as PublicOpEd; } catch { /* telemetry — silent by design */ return null; }
}
