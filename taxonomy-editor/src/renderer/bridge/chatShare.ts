// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Mechanical extraction from web-bridge.ts (mirrors communityAskSubmit.ts's precedent) to
// make room for t/4922's new AppAPI methods without exceeding the file's max-lines ceiling
// (1500, no baseline entry). Built on web-bridge.ts's own fetchWithSessionRecovery, not
// resilientFetch directly — unlike communityAskSubmit's deliberately-unauthenticated
// endpoint, /api/chat/:id/share is owner-only and needs the session-recovery wrapper.

import { fetchWithSessionRecovery } from './web-bridge';
import { categorizeEndpoint } from './resilience';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { ActionableError, errorMessage } from '@lib/debate/errors';
import { nextStepsForStatus } from './httpErrorSteps';

const MUTATION_TIMEOUT_MS = 180_000; // matches web-bridge.ts's own DEFAULT_MUTATION_TIMEOUT_MS

interface ChatShareCreateResponse {
  id: string;
  expires_at: string;
}

async function fetchChatShare(method: 'POST' | 'DELETE', chatId: string, body?: unknown): Promise<{ data: unknown; status: number }> {
  const path = `/api/chat/${encodeURIComponent(chatId)}/share`;
  let res: Response;
  try {
    res = await fetchWithSessionRecovery(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }, {
      timeoutMs: MUTATION_TIMEOUT_MS,
      maxRetries: 0, // non-idempotent create/revoke — never auto-retry a mutation
      critical: true,
      category: categorizeEndpoint(path, method),
    });
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'web-bridge', level: 'error',
      message: `${method} ${path} network error`,
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    throw new ActionableError({
      goal: method === 'POST' ? 'Create a public share link for this chat' : 'Revoke a public share link for this chat',
      problem: `${method} ${path} network error: ${errorMessage(err)}`,
      location: 'chatShare.fetchChatShare',
      nextSteps: ['Check your network connection and try again'],
      innerError: err,
    });
  }
  if (!res.ok) {
    const text = await res.text();
    throw new ActionableError({
      goal: method === 'POST' ? 'Create a public share link for this chat' : 'Revoke a public share link for this chat',
      problem: `${method} ${path} failed with HTTP ${res.status}: ${text}`,
      location: 'chatShare.fetchChatShare',
      nextSteps: nextStepsForStatus(res.status, text),
    });
  }
  return { data: res.status === 204 ? undefined : await res.json(), status: res.status };
}

/** t/4922: the server's create response has no `url`/`isNew` field (TL t/4922#4, correcting
 *  the ticket's original assumption) — `url` is built the same way shareOpEdSet's caller does
 *  (from the returned id), and `isNew` comes from the HTTP status (200 existing / 201 new). */
export async function shareChatRest(
  chatId: string,
  data: { title: string; messages: unknown[]; replace?: boolean },
): Promise<{ shareId: string; url: string; expiresAt: string; isNew: boolean }> {
  const { data: share, status } = await fetchChatShare('POST', chatId, data) as { data: ChatShareCreateResponse; status: number };
  return {
    shareId: share.id,
    url: new URL(`/share/chat/${share.id}`, window.location.origin).href,
    expiresAt: share.expires_at,
    isNew: status === 201,
  };
}

export async function unshareChatRest(chatId: string): Promise<void> {
  await fetchChatShare('DELETE', chatId);
}
