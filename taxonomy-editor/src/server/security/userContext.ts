// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Per-request user identity and session context, carried via AsyncLocalStorage
 * so that deep call sites (AI backends, key store, GitHubAPIBackend) can read
 * the authenticated user and session branch without every function having to
 * accept explicit parameters.
 *
 * In Azure, the identity comes from Easy Auth headers (X-MS-CLIENT-PRINCIPAL-*).
 * Locally (or when auth is disabled), callers run outside any user context and
 * consumers fall back to a shared "_local" principal.
 *
 * The branchName field is set lazily: reads start with branchName undefined
 * (resolved to 'main'), and ensureSessionBranch() updates it mid-request on
 * first write so subsequent operations within the same request see the branch.
 */

import { AsyncLocalStorage } from 'async_hooks';

export interface UserContext {
  /** Principal identifier: email, GitHub username, or similar. */
  principalName: string;
  /** Identity provider: 'github', 'google', 'aad', etc. */
  idp: string;
  /** Session branch for GitHubAPIBackend writes. undefined = read from main. */
  branchName?: string;
  /** Filesystem-safe user directory name for per-user data isolation. */
  storageUserId: string;
  /** True when no Easy Auth principal is present (anonymous browsing). */
  isAnonymous: boolean;
  /** UUID from anon_session_id cookie, present only for anonymous web users. */
  anonymousSessionId?: string;
  /**
   * Stable identity key for GitHub/AAD (format: `github:<id>` or `aad:<tid>-<oid>`).
   * undefined for anonymous or other IDPs. t/4706
   * First branching reader: t/4328 (isAdmin() will match against `<idp>:<id>` entries in ADMIN_USERS).
   */
  stableId?: string;
}

const als = new AsyncLocalStorage<UserContext>();

export function runWithUser<T>(ctx: UserContext, fn: () => T): T {
  return als.run(ctx, fn);
}

export function getCurrentUser(): UserContext | null {
  return als.getStore() ?? null;
}

/** Stable id used to partition per-user secrets. '_local' for unauthenticated. */
export function getCurrentUserId(): string {
  return als.getStore()?.principalName || '_local';
}

/** Filesystem-safe directory name for per-user data (chats, debates). */
export function getStorageUserId(): string {
  return als.getStore()?.storageUserId || '_local';
}

/** True when the current request has no authenticated principal. */
export function isAnonymousUser(): boolean {
  return als.getStore()?.isAnonymous ?? true;
}

/** Anonymous session ID from cookie, or undefined if not anonymous. */
export function getAnonymousSessionId(): string | undefined {
  return als.getStore()?.anonymousSessionId;
}

/** Stable identity key for the current request (format: `github:<id>` or `aad:<tid>-<oid>`). undefined for anonymous or other IDPs. t/4706 */
export function getStableId(): string | undefined {
  return als.getStore()?.stableId;
}

/** Session branch name for the current request, or undefined (= main). */
export function getSessionBranchName(): string | undefined {
  return als.getStore()?.branchName;
}

/**
 * Update the session branch for the current request's ALS store.
 * Called by ensureSessionBranch() after lazy branch creation so that
 * subsequent operations within the same async context see the new branch.
 */
export function setSessionBranchName(branchName: string): void {
  const store = als.getStore();
  if (store) {
    store.branchName = branchName;
  }
}

/**
 * Derive a human-readable, filesystem-safe directory name from the user's
 * principal name and identity provider. Deterministic — must never change
 * once deployed, as it maps to on-disk directory paths.
 *
 * GitHub: username lowercase (e.g. "jpsnover")
 * Google/AAD: email normalized — @ → "-at-", . → "-" (e.g. "jsnover13-at-gmail-com")
 */
export function deriveStorageUserId(principalName: string, idp: string): string {
  if (!principalName || principalName === '_local') return '_local';

  const raw = idp === 'github'
    ? principalName.toLowerCase()
    : principalName
      .toLowerCase()
      .replace(/@/g, '-at-')
      .replace(/\./g, '-');

  // Defense-in-depth (t/850): this value becomes a directory name
  // (users/${id}/...). Easy Auth injects real usernames/emails that can't
  // contain separators, but never trust that alone — strip path separators,
  // traversal, and null bytes. Falls back to '_local' if sanitizing empties it.
  return raw.replace(/[/\\\0]/g, '').replace(/\.\.+/g, '') || '_local';
}
