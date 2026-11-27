// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/693: the public attribution of a community item is a pseudonym, never the submitter's storage id.
 *
 * The storage id is the full email address for Google and Entra sign-ins (deriveStorageUserId), so it
 * must not reach `community_metadata.submitted_by_display`, which anonymous visitors can read.
 *
 *   pseudonym = "Contributor-" + first 8 hex of HMAC-SHA256(subkey, storage id)
 *   subkey    = deriveCommunityPseudonymKey()  (a one-way subkey of anon-session-hmac; Security p/238#39)
 *
 * Keyed, so nobody outside the server can recompute it from a guessed address. The subkey is derived on
 * each call and never held here, so it is always the one for the secret installed right now, and there
 * is nothing to wire at boot or re-derive on rotation. It is never logged, returned or serialized.
 *
 * With no secret installed the display is the fixed word "Contributor" (fail closed: never the storage
 * id), with a WARN.
 *
 * Rotation: rotating anon-session-hmac changes the subkey. Stored pseudonyms keep their old value and
 * new publishes get a new one, so one contributor can then appear under two names. Accepted by Security
 * (p/238#39); pseudonyms stable across rotation would need a dedicated secret, a PI credential decision.
 */

import crypto from 'crypto';
import { log } from '../logger.js';
import { deriveCommunityPseudonymKey } from '../security/anonSessionSigning.js';

/** The display used when no secret is installed, and the prefix of every pseudonym. */
export const PSEUDONYM_FALLBACK = 'Contributor';
const PSEUDONYM_HEX_CHARS = 8;

// How many displays the fixed word has stood in for a missing key. A cached listing index built while this
// moved would keep the fixed word after the key loads, so the index builder compares before and after (t/693#29).
let keylessFallbacks = 0;
export function keylessFallbackCount(): number {
  return keylessFallbacks;
}

let warnedUnpersistedIndex = false;
/** WARN, once per process, that a listing index was not cached for want of the pseudonym key. */
export function warnIndexNotPersisted(dir: string): void {
  if (warnedUnpersistedIndex) return;
  warnedUnpersistedIndex = true;
  log.server.warn(`Community listing index for ${dir} not persisted: the pseudonym key is not loaded, so entries show the fixed display. Each list call rebuilds until it loads (warned once per process).`);
}

/**
 * The public display name for a submitter's storage id. Never returns the storage id or any part of it.
 * Call it only at publish time. An empty storage id, or no installed secret, gives the fixed fallback.
 */
export function communityPseudonym(storageUserId: string): string {
  if (!storageUserId) return PSEUDONYM_FALLBACK;
  const subkey = deriveCommunityPseudonymKey();
  if (!subkey) {
    keylessFallbacks++;
    log.server.warn(
      'Community pseudonym key is unavailable (anon-session-hmac is not loaded): publishing the fixed display "Contributor" instead of a per-contributor pseudonym (t/693)',
    );
    return PSEUDONYM_FALLBACK;
  }
  const hex = crypto.createHmac('sha256', subkey).update(storageUserId, 'utf8').digest('hex');
  return `${PSEUDONYM_FALLBACK}-${hex.slice(0, PSEUDONYM_HEX_CHARS)}`;
}

/**
 * t/693: the submitter's storage id for a RAW stored community item (never a projected one, which
 * has the key stripped), or null. It is the owner key for op-ed shares and the admin removal audit.
 * Items published before t/693 have no `owner_storage_id`; until the one-off rewrite gives them one,
 * their `submitted_by_display` still holds the storage id, so that is the fallback, taken with a WARN.
 * The value is never logged.
 */
export function communityItemOwnerKey(item: unknown, id?: string): string | null {
  const meta = (item && typeof item === 'object')
    ? (item as { community_metadata?: unknown }).community_metadata : null;
  if (!meta || typeof meta !== 'object') return null;
  const m = meta as { owner_storage_id?: unknown; submitted_by_display?: unknown };
  if (typeof m.owner_storage_id === 'string' && m.owner_storage_id !== '') return m.owner_storage_id;
  if (typeof m.submitted_by_display === 'string' && m.submitted_by_display !== '') {
    log.server.warn({ id },
      'Community item has no owner_storage_id (published before t/693): using submitted_by_display as the owner key until the rewrite');
    return m.submitted_by_display;
  }
  return null;
}

/**
 * t/856, t/693: `community_metadata` as it is served to any reader (lists, items, the cached listing indexes).
 * A copy; the stored file is not changed.
 * - `original_id` (the pre-share private UUID) and `owner_storage_id` (the storage id) are removed.
 * - An item published before t/693 has no `owner_storage_id`, and its `submitted_by_display` IS the storage
 *   id. It is replaced at read by the same pseudonym the one-off rewrite will store, so those items stop
 *   showing the storage id as soon as this code is deployed, with no data write. Every item written since
 *   t/693 carries `owner_storage_id` and a display that is already a pseudonym, which is left as it is.
 */
export function publicCommunityMetadata(meta: unknown): unknown {
  if (!meta || typeof meta !== 'object') return meta;
  const rest = { ...(meta as Record<string, unknown>) };
  const publishedBeforeT693 = typeof rest.owner_storage_id !== 'string' || rest.owner_storage_id === '';
  if (publishedBeforeT693 && 'submitted_by_display' in rest) {
    rest.submitted_by_display = communityPseudonym(typeof rest.submitted_by_display === 'string' ? rest.submitted_by_display : '');
  }
  delete rest.original_id;
  delete rest.owner_storage_id;
  return rest;
}
