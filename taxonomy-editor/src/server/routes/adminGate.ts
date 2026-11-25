// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/592 (incident t/579, root fix 2): handler-level admin checks for routes that the anonymous gate (#5500) refuses to
// anonymous callers but that had no check of their own, so a signed-in non-admin could read them. Same rule as the
// flight-recorder routes (#5489): admin on a hosted server; single-operator local mode (AUTH_DISABLED=1 outside
// production) keeps access, since there the operator is the owner.

import type http from 'http';
import { requireAdmin } from '../community/admin/reviewRegistry.js';
import { isAuthDisabledMode, isAnonymousRequest, deriveStorageUserId } from '../security/userContext.js';

/** Admin on a hosted server; the operator in AUTH_DISABLED local mode. Writes 403 and returns false otherwise. */
export function requireAdminOrOperator(res: http.ServerResponse): boolean {
  if (isAuthDisabledMode()) return true;
  return requireAdmin(res);
}

/** The id an unauthenticated request derives to ('_local' principal), which is the owner's own id, never a visitor's.
 *  Computed on call, not at module load, so importing this module has no side effects. */
export function localDerivedId(): string {
  return deriveStorageUserId('_local', '_local');
}

/** True when a signed-in, non-anonymous caller asks for their own id, and that id is not the '_local' one. */
export function isOwnSignedInId(requested: string | undefined, callerId: string): boolean {
  return requested !== undefined && !isAnonymousRequest() && callerId !== localDerivedId() && requested === callerId;
}

/** 403 in the same shape as requireAdmin, for a branch that refuses without the admin check. */
export function forbid(res: http.ServerResponse): void {
  res.writeHead(403, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Forbidden' }));
}
