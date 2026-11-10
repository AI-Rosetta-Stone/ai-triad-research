// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4505 (t/4504 observability follow-up): in t/4504, ADMIN_USERS/READ_ONLY_PRINCIPALS
// entries that no current sign-in can produce (because IDENTITY_MAP doesn't cover them)
// failed SILENTLY — the guard just never matched. This module surfaces that gap at boot
// and on /health, instead of waiting for someone to notice a missing admin or a writable
// read-only account. The reachability rules live in principalName.ts (canProducePrincipal for
// READ_ONLY_PRINCIPALS names, canProduceStableId for ADMIN_USERS stableIds); this module only
// iterates the two allowlists and calls them.

import { canProducePrincipal, canProduceStableId, identityMapSize } from './principalName.js';
import { log } from './logger.js';

export interface UnreachableAllowlistEntry {
  source: 'ADMIN_USERS' | 'READ_ONLY_PRINCIPALS';
  idp: 'github' | 'aad' | null; // null for ADMIN_USERS: `name` is the whole entry, prefix included
  name: string;
  reason: string;
}

/**
 * t/43: an ADMIN_USERS entry is unreachable unless isAdminStableId could match it. Since t/4328
 * and t/4706 that's only an idp-qualified entry (`github:<id>`, `aad:<tid>-<oid>`, `google:<id>`)
 * that some sign-in records as its stableId. A bare entry (a legacy name, an email) never
 * matches, whatever IDENTITY_MAP says. The t/4505 rule here predated qualified entries and
 * flagged them instead.
 */
function adminUserUnreachableReason(name: string): string | null {
  if (!name.includes(':')) return 'bare entry with no idp: prefix; isAdminStableId never matches it (t/4328)';
  if (!canProduceStableId(name)) {
    // t/47: say which shape was wrong — a login, a bare oid, or a non-numeric id is the likely operator slip.
    const idp = name.slice(0, name.indexOf(':')).toLowerCase();
    if (idp === 'github') return 'github: id must be the numeric GitHub user id, not a login; no sign-in records this stableId';
    if (idp === 'aad') return 'aad: id must be <tenant-guid>-<object-guid>; no sign-in records this stableId';
    if (idp === 'google') return 'google: id must be a numeric user id (1-128 digits); no sign-in records this stableId';
    return 'idp-qualified, but no sign-in records this stableId (expected github:<id>, aad:<tid>-<oid>, or google:<id>)';
  }
  return null;
}

/** Pure, I/O-free: the two allowlists in, the entries no sign-in can currently produce out. */
export function findUnreachableAllowlistEntries(
  adminUsers: readonly string[],
  readOnlyPrincipalEntries: ReadonlySet<string>,
): UnreachableAllowlistEntry[] {
  const out: UnreachableAllowlistEntry[] = [];
  for (const raw of adminUsers) {
    const name = raw.trim();
    if (!name) continue;
    const reason = adminUserUnreachableReason(name);
    if (reason) out.push({ source: 'ADMIN_USERS', idp: null, name, reason });
  }
  for (const entry of readOnlyPrincipalEntries) {
    const sep = entry.indexOf(':');
    if (sep <= 0) continue;
    const idp = entry.slice(0, sep);
    const name = entry.slice(sep + 1);
    if ((idp === 'github' || idp === 'aad') && !canProducePrincipal(idp, name)) {
      out.push({ source: 'READ_ONLY_PRINCIPALS', idp, name, reason: `no map entry for legacy ${idp} name` });
    }
  }
  return out;
}

/**
 * Boot-only: WARN once with the count, the entry names + reasons (operator config, not
 * user data — safe to log), and whether IDENTITY_MAP is empty. Returns the count so the
 * caller can log it alongside the rest of the boot sequence if it wants to.
 */
export function logUnreachableAllowlistEntriesAtBoot(
  adminUsers: readonly string[],
  readOnlyPrincipalEntries: ReadonlySet<string>,
): number {
  const unreachable = findUnreachableAllowlistEntries(adminUsers, readOnlyPrincipalEntries);
  if (unreachable.length > 0) {
    log.security.warn(
      { component: 'identity-allowlist', count: unreachable.length, identityMapEmpty: identityMapSize() === 0, entries: unreachable },
      'Allowlist entries unreachable under the current IDENTITY_MAP — no sign-in can produce them',
    );
  }
  return unreachable.length;
}
