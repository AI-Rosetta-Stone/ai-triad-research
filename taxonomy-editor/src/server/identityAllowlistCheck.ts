// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4505 (t/4504 observability follow-up): in t/4504, ADMIN_USERS/READ_ONLY_PRINCIPALS
// entries that no current sign-in can produce (because IDENTITY_MAP doesn't cover them)
// failed SILENTLY — the guard just never matched. This module surfaces that gap at boot
// and on /health, instead of waiting for someone to notice a missing admin or a writable
// read-only account. The reachability rule itself lives in principalName.ts's
// canProducePrincipal — this module only iterates the two allowlists and calls it.

import { canProducePrincipal, identityMapSize } from './principalName.js';
import { log } from './logger.js';

export interface UnreachableAllowlistEntry {
  source: 'ADMIN_USERS' | 'READ_ONLY_PRINCIPALS';
  idp: 'github' | 'aad' | null; // null for ADMIN_USERS, which carries no idp prefix
  name: string;
  reason: string;
}

const EMAIL_RE = /@/;

/**
 * An unprefixed ADMIN_USERS entry is reachable if it's a verified Google email (Google's
 * principal name IS the email, never map-derived — principalName.ts:31-34), or if some
 * github/aad sign-in can produce it. Anything else — a bare legacy name like `jpsnover`
 * with no IDENTITY_MAP entry — is unreachable.
 */
function isReachableAdminUser(name: string): boolean {
  if (EMAIL_RE.test(name)) return true;
  return canProducePrincipal('github', name) || canProducePrincipal('aad', name);
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
    if (!isReachableAdminUser(name)) {
      out.push({ source: 'ADMIN_USERS', idp: null, name, reason: 'no map entry for legacy aad/github name, and not a Google email' });
    }
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
