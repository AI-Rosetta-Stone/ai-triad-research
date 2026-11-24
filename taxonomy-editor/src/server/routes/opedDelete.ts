// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/475 (PI decision, TL p/16#239): an anonymous visitor may delete their own op-ed. The gate lets exactly
// DELETE /api/oped-sets/<id> through for anonymous callers (anonRouteDecision). This module is the handler's
// half: it refuses an unkeyed anonymous caller, and deletes only from the caller's own storage key, so another
// visitor's id is not found. Kept out of routes/oped.ts so that file stays under its complexity threshold.

import type { ServerResponse } from 'http';
import { json, error } from '../httpKit.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { deleteOpedSet } from '../storage/opedStore.js';
import { getStorageUserId, isAnonymousUser } from '../security/userContext.js';

export async function deleteOpEdSetRoute(res: ServerResponse, id: string): Promise<void> {
  // An anonymous caller with no session key shares the '_local' store with the local user. Refuse before any delete.
  if (isAnonymousUser() && getStorageUserId() === '_local') {
    error(res, 'Start an anonymous session to delete op-eds: reload the page, or sign in.', 403);
    return;
  }
  try {
    const removed = await deleteOpedSet(id);
    if (!removed) { error(res, 'Op-ed set not found', 404); return; }
    json(res, { ok: true });
  } catch (err) {
    getGlobalRecorder()?.record({ type: 'system.error', component: 'oped', level: 'error', message: 'Failed to delete oped-set', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
    error(res, String(err), 500, err);
  }
}
