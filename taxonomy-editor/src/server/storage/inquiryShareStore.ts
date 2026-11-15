// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Inquiry public-share storage (t/3627, epic t/3618; parent design t/3623#2, SO e/201#2).
// Mirrors `storage/opedShareStore.ts` (t/2727) exactly — Pattern A, publish-on-share.
//
// The field-shape/sanitization work the SO consult was actually about is DONE upstream by
// `toPublicInquiryShare` (lib/inquiry/publicShare.ts, t/3648): constructive projection onto
// the separately-versioned `PublicInquiryShareSchema`, source sanitization, excerpt caps.
// This module is pure persistence plumbing — a thin publish/unpublish/read wrapper — so unlike
// opedShareStore.ts there is no allowlist-picking logic here.
//
// On share, the owner's inquiry result is projected to `PublicInquiryShare` and written to a
// fixed, USER-AGNOSTIC location (public/inquiries/{shareId}.json). The public read path (t/3653)
// reads ONLY from there and NEVER touches users/**, so there is no code path from the
// unauthenticated surface into private user storage. The URL key is a fresh random shareId
// (≠ jobId) so a leaked link is revoked for good by delete + re-share.

import path from 'path';
import { randomUUID } from 'crypto';
import { resolveDataPath } from '../config.js';
import { getStorageUserId, isAnonymousUser } from '../security/userContext.js';
import { getUserContentBackend, assertSafeId } from './fileIO.js';
import { loadInquiryResult } from './inquiryResultStore.js';
import { confirmShareStillRegistered } from './shareRevokeGuard.js';
import { readShareRegistry as readRegistryFile, updateShareRegistry } from './shareRegistry.js';
import { toPublicInquiryShare, PublicInquiryShareReadSchema, type PublicInquiryShare } from '../../../../lib/inquiry/index.js';
import { log } from '../logger.js';

// Public copies live under a fixed, user-agnostic prefix — NEVER under users/{id}/.
const PUBLIC_INQUIRIES_DIR = 'public/inquiries';
// Owner-scoped registry mapping jobId → shareId, so un-share/re-share can find the
// public copy without exposing the jobId in the public URL.
const SHARE_REGISTRY_FILE = 'inquiry-shares.json';

function publicInquiryPath(shareId: string): string {
  return path.join(resolveDataPath(PUBLIC_INQUIRIES_DIR), `${shareId}.json`);
}
function shareRegistryPath(): string {
  return path.join(resolveDataPath(`users/${getStorageUserId()}`), SHARE_REGISTRY_FILE);
}

function readShareRegistry(): Promise<Record<string, string>> {
  return readRegistryFile(getUserContentBackend(), shareRegistryPath());
}
/** t/117: compare-and-swap registry update — see shareRegistry.ts. */
function updateRegistry<T>(mutate: (reg: Record<string, string>) => { changed: boolean; result: T }): Promise<T> {
  return updateShareRegistry(getUserContentBackend(), shareRegistryPath(), 'inquiry', mutate);
}
function confirmInquiryShare(jobId: string, shareId: string): Promise<boolean> {
  return confirmShareStillRegistered({
    kind: 'inquiry', id: jobId, shareId, publicPath: publicInquiryPath(shareId), readRegistry: readShareRegistry,
    backend: getUserContentBackend(),
  });
}

/**
 * Publish an owner's inquiry result to a durable public URL. OWNER-ONLY: `loadInquiryResult`
 * reads under the caller's `getStorageUserId()` scope, so a result the caller doesn't own (or
 * that doesn't exist) yields null → the route returns an indistinguishable 404. Idempotent: an
 * already-shared result refreshes its existing shareId (no dup copy).
 */
export async function publishInquiryShare(jobId: string): Promise<{ shareId: string } | null> {
  assertSafeId(jobId, 'inquiry job id');
  if (isAnonymousUser()) return null; // no durable owner scope to share from
  const result = await loadInquiryResult(jobId);
  if (!result) return null;

  const reg = await readShareRegistry();
  const existing = reg[jobId];
  const shareId = existing ?? randomUUID();
  const share: PublicInquiryShare = toPublicInquiryShare(result);
  await getUserContentBackend().writeFile(publicInquiryPath(shareId), JSON.stringify(share, null, 2));
  if (!existing) {
    // t/117: add only if still absent — a concurrent publish that minted its own shareId wins,
    // and the guard below then removes our copy. On give-up, drop the orphan we just wrote.
    try {
      await updateRegistry((r) => {
        if (r[jobId]) return { changed: false, result: undefined };
        r[jobId] = shareId;
        return { changed: true, result: undefined };
      });
    } catch (err) {
      await getUserContentBackend().deleteFile(publicInquiryPath(shareId)).catch((delErr) => {
        log.server.warn({ err: delErr, shareId }, 'inquiry share orphan cleanup after registry failure failed (best-effort)');
      });
      throw err;
    }
  }
  // t/4937: an unpublish may have raced the write above — never leave a revoked link live.
  if (!(await confirmInquiryShare(jobId, shareId))) return null;
  return { shareId };
}

/**
 * Refresh an EXISTING public share's projection in place (t/4927) — e.g. after a rename, so
 * the public copy's title isn't left stale. Same shareId, same URL; never mints one. Returns
 * false (no-op) if the result isn't shared, which is the "never creates a share" contract —
 * callers must NOT fall back to `publishInquiryShare` on a false return.
 */
export async function refreshInquiryShareIfShared(jobId: string): Promise<boolean> {
  assertSafeId(jobId, 'inquiry job id');
  if (isAnonymousUser()) return false;
  const reg = await readShareRegistry();
  const shareId = reg[jobId];
  if (!shareId) return false;
  const result = await loadInquiryResult(jobId);
  if (!result) return false; // defensive; caller already has the result at this point
  const share: PublicInquiryShare = toPublicInquiryShare(result);
  await getUserContentBackend().writeFile(publicInquiryPath(shareId), JSON.stringify(share, null, 2));
  return confirmInquiryShare(jobId, shareId); // t/4937
}

/**
 * Un-share (owner-only — the registry is owner-scoped): delete the public copy + registry
 * entry. Returns true if a share existed. With the fresh-shareId scheme this is a real
 * revocation — a leaked old link is permanently dead.
 */
export async function unpublishInquiryShare(jobId: string): Promise<boolean> {
  assertSafeId(jobId, 'inquiry job id');
  if (isAnonymousUser()) return false;
  // t/4937: registry entry goes FIRST, so a publish/refresh whose write lands after the delete
  // below re-reads a registry that no longer names this shareId and removes its own copy.
  // t/117: compare-and-swap, so a concurrent registry write can't put the entry back.
  const shareId = await updateRegistry((r) => {
    const current = r[jobId];
    if (!current) return { changed: false, result: undefined };
    delete r[jobId];
    return { changed: true, result: current };
  });
  if (!shareId) return false;
  await getUserContentBackend().deleteFile(publicInquiryPath(shareId)).catch((err) => {
    log.server.warn({ err, shareId }, 'inquiry share public-copy delete failed (best-effort)');
  });
  return true;
}

/**
 * Read a published public inquiry share by shareId — the UNAUTHENTICATED path. Reads ONLY
 * from the user-agnostic public dir; never touches users/**. Returns null if not shared or
 * revoked. The file at rest is already the positive projection (written by publishInquiryShare
 * via toPublicInquiryShare), so no private field can be present. shareId shape is validated by
 * the route (invalidRouteParam, t/3653) before this is called.
 *
 * t/3730: validated against `PublicInquiryShareReadSchema` — a bare `JSON.parse … as T` cast
 * would let a corrupt or partially-written blob type-check and serve structurally-wrong data to
 * an anonymous reader. TOLERANT (passthrough at every nested level) on purpose, never the strict
 * write-side `PublicInquiryShareSchema`: a strict reader would reject a blob written by a NEWER
 * build during the ACA deploy-overlap window (this build's still-draining replica hasn't picked
 * up the field an already-rolled-forward replica just started writing), turning a valid public
 * link into a false 404 on every deploy. A validation failure is a distinct, WARN-worthy event
 * from "file absent" (fallback-logging rule) — it is NOT silent-by-design like a missing file.
 */
export async function loadPublicInquiryShare(shareId: string): Promise<PublicInquiryShare | null> {
  const raw = await getUserContentBackend().readFile(publicInquiryPath(shareId));
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.server.warn({ shareId, err, cause: 'inquiry-share-unparseable' },
      'public inquiry share is not valid JSON — treating as absent (t/3730)');
    return null;
  }

  const result = PublicInquiryShareReadSchema.safeParse(parsed);
  if (!result.success) {
    log.server.warn({ shareId, issues: result.error.issues, cause: 'inquiry-share-schema-invalid' },
      'public inquiry share failed schema validation — treating as absent (t/3730)');
    return null;
  }
  return result.data as PublicInquiryShare;
}
