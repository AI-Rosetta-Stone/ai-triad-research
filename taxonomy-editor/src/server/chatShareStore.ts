// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4787: storage/registry logic for public chat shares, split out of
// routes/chatShare.ts (SO p/835#25) to keep the route file's complexity under the
// local/complexity-budget threshold — createShare's CAS retry loop alone was 21-22.
// Route handlers in routes/chatShare.ts call into this module; it owns every read,
// write, and CAS precondition for share blobs and the per-user registry.

import path from 'path';
import { randomBytes } from 'crypto';
import { getGlobalRecorder } from '../../../lib/flight-recorder/index.js';
import { ActionableError } from '../../../lib/debate/errors.js';
import { checkRate } from './security/rateLimiter.js';
import { getStorageUserId } from './security/userContext.js';
import { resolveDataPath } from './config.js';
import { getUserContentBackend, assertSafeId } from './storage/fileIO.js';
import { gitBlobSha } from './storage/gitBlobSha.js';
import { CHAT_SHARE_CONFIG } from './config/chatShareConfig.js';

// ── Configuration (t/4787 P5, K5: externalized) ──
const CHAT_SHARE_MAX_ACTIVE = CHAT_SHARE_CONFIG.MAX_ACTIVE;
const CHAT_SHARE_CREATES_PER_HOUR = CHAT_SHARE_CONFIG.CREATES_PER_HOUR;
const CHAT_SHARE_TTL_DAYS = CHAT_SHARE_CONFIG.TTL_DAYS;
const PUBLIC_CHAT_SHARES_DIR = 'public/chat-shares';
// Bounds on what one share may publish, so the public surface can't be used to park
// arbitrarily large blobs under the app's domain (TL review of #4499).
export const CHAT_SHARE_MAX_MESSAGES = 500;
export const CHAT_SHARE_MAX_TOTAL_CHARS = 1_000_000;

/** K1: Generate 128-bit share ID (randomBytes base64url, no padding). */
function generateShareId(): string {
  return randomBytes(16).toString('base64url');
}

// ── Types ──

export interface SnapshotMessage {
  role: 'user' | 'assistant' | 'acc' | 'saf' | 'skp';
  content: string;
  timestamp: string;
}

export interface ChatSnapshot {
  id: string;
  title: string;
  messages: SnapshotMessage[];
  created_at: string;
}

export interface PublicChatShare {
  id: string;
  chatId: string;
  userId: string;
  snapshot: ChatSnapshot;
  created_at: string;
  expires_at: string;
}

/** What an anonymous reader may see: the conversation only. Never the owner's userId or the
 *  owner's chatId (t/4787 P3: "no emails, user ids or internal data"). */
export interface PublicChatShareView {
  id: string;
  title: string;
  messages: SnapshotMessage[];
  created_at: string;
  expires_at: string;
}

export function toPublicView(share: PublicChatShare): PublicChatShareView {
  return {
    id: share.id,
    title: share.snapshot.title,
    messages: share.snapshot.messages,
    created_at: share.created_at,
    expires_at: share.expires_at,
  };
}

// ── Storage paths ──

function publicSharePath(shareId: string): string {
  assertSafeId(shareId, 'chat share id');
  return path.join(resolveDataPath(PUBLIC_CHAT_SHARES_DIR), `${shareId}.json`);
}

function shareRegistryPath(): string {
  return path.join(resolveDataPath(`users/${getStorageUserId()}`), 'chat-shares.json');
}

function stripSensitiveKeys(messages: unknown[]): SnapshotMessage[] {
  return (messages as Array<Record<string, unknown>>).map((msg) => {
    const role = msg.role as string;
    // Only allow specific speaker values (drop 'cc' per t/4787)
    if (!['user', 'assistant', 'acc', 'saf', 'skp'].includes(role)) {
      throw new ActionableError({
        goal: 'Create chat share with valid messages',
        problem: `Invalid speaker role '${role}' — must be user|assistant|acc|saf|skp`,
        location: 'stripSensitiveKeys',
        nextSteps: ['Verify message speaker roles before sharing'],
      });
    }
    return {
      role: role as SnapshotMessage['role'],
      content: String(msg.content ?? ''),
      timestamp: String(msg.timestamp ?? new Date().toISOString()),
    };
  });
}

// Chat sessions are stored on the client side only. The server receives the chat
// data (title, messages) in the request body and snapshots it.

async function saveShare(share: PublicChatShare): Promise<void> {
  const backend = getUserContentBackend();
  const shareBlob = JSON.stringify(share, null, 2) + '\n';
  await backend.writeFile(publicSharePath(share.id), shareBlob);
}

export async function loadShare(shareId: string): Promise<PublicChatShare | null> {
  try {
    const backend = getUserContentBackend();
    const content = await backend.readFile(publicSharePath(shareId), { optional: true });
    if (!content) return null;

    const share = JSON.parse(content) as PublicChatShare;
    // K4: Check expiration and delete expired blobs
    if (new Date(share.expires_at) < new Date()) {
      await revokeShare(shareId);
      return null;
    }
    return share;
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'chat-share',
      level: 'warn',
      message: 'Failed to load chat share',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return null;
  }
}

export async function revokeShare(shareId: string): Promise<void> {
  try {
    const backend = getUserContentBackend();
    await backend.deleteFile(publicSharePath(shareId));
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'chat-share',
      level: 'warn',
      message: 'Share does not exist (idempotent delete)',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
  }
}

/** Registry shares mapping. */
interface Registry {
  shares: Record<string, string>; // chatId → shareId
}

/** Registry read with baseSha for CAS (K3: race condition prevention). */
interface RegistryRead {
  registry: Registry;
  baseSha: string; // gitBlobSha of the content read (for CAS precondition)
}

export async function readRegistry(): Promise<RegistryRead> {
  const backend = getUserContentBackend();
  const content = await backend.readFile(shareRegistryPath(), { optional: true });
  // K3: baseSha '' is the CAS precondition for "file does not exist" (matches
  // FilesystemBackend.writeFile: currentSha = current === null ? '' : gitBlobSha(current)).
  // Using gitBlobSha('') here instead made every first write on an absent registry
  // conflict against the real on-disk '' sentinel, forcing it through the retry loop
  // until it exhausted — the root cause of the K1-K7 PR's 500s (verified via CI logs).
  if (!content) return { registry: { shares: {} }, baseSha: '' };

  try {
    const parsed = JSON.parse(content) as any;
    const registry: Registry = { shares: parsed.shares || parsed };
    const baseSha = gitBlobSha(content);
    return { registry, baseSha };
  } catch (err) {
    // R-D (SO p/835#21): a corrupt registry must fail closed, not be silently treated as
    // empty — the old behavior returned {shares:{}} here, so the next create/revoke/prune
    // would cheerfully overwrite the corrupt file with fresh data, destroying whatever of
    // the original was still recoverable and masking the corruption as a normal write.
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'chat-share',
      level: 'error',
      message: 'Chat share registry is corrupt — refusing to overwrite',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    throw new ActionableError({
      goal: 'Read the chat share registry',
      problem: 'The registry file is corrupt (invalid JSON) and cannot be safely read or overwritten.',
      location: 'readRegistry',
      nextSteps: ['Inspect and manually repair or restore the registry file from backup', 'Do not retry until the file is valid JSON'],
      innerError: err,
    });
  }
}

/** R-B (SO p/835#21): write the registry with CAS even when the result is empty — never
 *  `deleteFile` unconditionally. An unconditional delete has no baseSha precondition, so a
 *  concurrent create that landed between our read and this delete gets silently wiped. An
 *  empty registry is represented as `{"shares":{}}`, not file-absence. */
export async function writeRegistryCas(registry: { shares: Record<string, string> }, baseSha: string): Promise<void> {
  const backend = getUserContentBackend();
  const newContent = JSON.stringify(registry) + '\n';
  await backend.writeFile(shareRegistryPath(), newContent, { baseSha });
}

/** K4: Remove expired entries from registry (prune during preflight). */
export async function pruneExpiredRegistry(): Promise<void> {
  try {
    const { registry, baseSha } = await readRegistry();
    let dirty = false;
    for (const [chatId, shareId] of Object.entries(registry.shares)) {
      const share = await loadShare(shareId);
      if (!share) {
        delete registry.shares[chatId];
        dirty = true;
      }
    }
    if (dirty) {
      try {
        await writeRegistryCas(registry, baseSha);
      } catch (err: unknown) {
        const writeErr = err as any;
        if (!(writeErr.code === 'WRITE_CONFLICT' || writeErr.message?.includes('412'))) {
          getGlobalRecorder()?.record({
            type: 'system.error',
            component: 'chat-share',
            level: 'warn',
            message: 'Prune registry write failed',
            error: { name: (writeErr as Error).name ?? 'Error', message: String(writeErr), stack: (writeErr as Error).stack },
          });
          throw writeErr;
        }
        // K3: Conflict on prune is non-critical; skip
      }
    }
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'chat-share',
      level: 'warn',
      message: 'Failed to prune registry',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
  }
}

/** The caller's live share for this chat, if any (P1: idempotence). */
export async function findExistingShare(chatId: string): Promise<PublicChatShare | null> {
  try {
    const { registry } = await readRegistry();
    const existingShareId = registry.shares[chatId];
    return existingShareId ? await loadShare(existingShareId) : null;
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'chat-share',
      level: 'warn',
      message: 'Failed to check existing share; treating it as absent',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return null;
  }
}

/** Returns a reason the content can't be shared, or null when it's within bounds. */
export function contentTooLarge(messages: unknown[]): string | null {
  if (messages.length > CHAT_SHARE_MAX_MESSAGES) return `at most ${CHAT_SHARE_MAX_MESSAGES} messages can be shared`;
  const total = messages.reduce<number>((n, m) => n + String((m as Record<string, unknown>)?.content ?? '').length, 0);
  if (total > CHAT_SHARE_MAX_TOTAL_CHARS) return `at most ${CHAT_SHARE_MAX_TOTAL_CHARS} characters can be shared`;
  return null;
}

/** Everything that can answer a create request before a new share is written, in order:
 *  size bounds, P1 idempotence (an existing live share is returned as-is and doesn't count
 *  against the create rate limit), the P5 active-share cap (a replace swaps one for one, so
 *  it's only refused when the chat had no share before), then the P5 create rate limit.
 *  Returns null when a new share should be created. */
export async function createPreflight(
  chatId: string,
  userId: string,
  replace: boolean,
  messages: unknown[],
): Promise<{ status: number; payload: unknown } | null> {
  const tooLarge = contentTooLarge(messages);
  if (tooLarge) return { status: 413, payload: { error: `Chat too large to share: ${tooLarge}` } };

  if (!replace) {
    const existing = await findExistingShare(chatId);
    if (existing) return { status: 200, payload: existing };
  }

  // K4: Prune expired entries before checking cap
  await pruneExpiredRegistry();

  const { registry } = await readRegistry();
  // K5: Cap violation returns 429 (not 409)
  const chatCount = Object.keys(registry.shares).length;
  if (!(chatId in registry.shares) && chatCount >= CHAT_SHARE_MAX_ACTIVE) {
    return { status: 429, payload: { error: `At most ${CHAT_SHARE_MAX_ACTIVE} chats can be shared at once; revoke one first`, retryAfterMs: 3600_000 } };
  }

  const rateCheck = checkRate(`chat-share-create:${userId}`, CHAT_SHARE_CREATES_PER_HOUR, 3600_000);
  if (!rateCheck.allowed) {
    return { status: 429, payload: { error: 'Share creation rate limit exceeded', retryAfterMs: rateCheck.retryAfterMs } };
  }
  return null;
}

/** On a write conflict, check whether another writer already won for this chat and, if
 *  their share is still live, hand their share back instead of retrying. Returns the
 *  winner's share to return to the caller, or null to signal "retry with our own blob
 *  still intact" (R-A, SO p/835#21: never revoke our own blob here — only once a live
 *  winner is confirmed, right before returning it). */
async function resolveCreateConflict(chatId: string, shareId: string): Promise<PublicChatShare | null> {
  const { registry: current } = await readRegistry();
  const otherShareId = current.shares[chatId];
  if (otherShareId && otherShareId !== shareId) {
    const otherShare = await loadShare(otherShareId);
    if (otherShare) {
      // Winner's share is live: only now is it safe to abandon ours.
      await revokeShare(shareId);
      return otherShare;
    }
    // Winner's entry was stale/expired — fall through and retry with our own blob intact.
  }
  return null;
}

/** One registry-write attempt for createShare's retry loop: read, CAS-write, and on
 *  success revoke the chat's previous share (R-C: only after the commit succeeds).
 *  Returns the share on success, or 'conflict'/'other-error' to drive the caller's
 *  retry/throw decision without a second level of try/catch in createShare itself. */
async function attemptCreateWrite(
  chatId: string,
  shareId: string,
  share: PublicChatShare,
  backend: ReturnType<typeof getUserContentBackend>,
): Promise<PublicChatShare | 'conflict'> {
  const { registry, baseSha } = await readRegistry();
  const previousShareId = registry.shares[chatId];
  registry.shares[chatId] = shareId;
  const newContent = JSON.stringify(registry) + '\n';

  try {
    await backend.writeFile(shareRegistryPath(), newContent, { baseSha });
    // R-C (SO p/835#21): only revoke the previous share AFTER the registry commit
    // succeeds. Revoking it first meant a failed/conflicting CAS write could leave
    // the registry still pointing at an already-deleted blob.
    if (previousShareId && previousShareId !== shareId) await revokeShare(previousShareId);
    return share;
  } catch (writeErr: unknown) {
    const err = writeErr as any;
    if (err.code === 'WRITE_CONFLICT' || err.message?.includes('412') || err.message?.includes('WRITE_CONFLICT')) {
      return 'conflict';
    }
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'chat-share',
      level: 'warn',
      message: 'Registry write error (not conflict)',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    throw writeErr;
  }
}

export async function createShare(
  chatId: string,
  userId: string,
  chatData: { title: string; messages: unknown[] },
): Promise<PublicChatShare> {
  // K1: Generate new share with 128-bit ID
  const shareId = generateShareId();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + CHAT_SHARE_TTL_DAYS * 24 * 60 * 60 * 1000);

  const share: PublicChatShare = {
    id: shareId,
    chatId,
    userId,
    snapshot: {
      id: chatId,
      title: chatData.title ?? 'Untitled',
      messages: stripSensitiveKeys(chatData.messages ?? []),
      created_at: now.toISOString(),
    },
    created_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
  };

  await saveShare(share);

  // K3: Registry write with CAS + retry, orphan cleanup. K5: assertSafeId on registry key.
  assertSafeId(chatId, 'chat id for registry key');
  const backend = getUserContentBackend();

  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await attemptCreateWrite(chatId, shareId, share, backend);
    if (result !== 'conflict') return result;

    // Conflict: another POST may have won. Hand back their share if it's live; otherwise
    // retry with our own blob intact (R-A: never revoke it until a winner is confirmed).
    const winner = await resolveCreateConflict(chatId, shareId);
    if (winner) return winner;
  }

  // R-E (SO p/835#23): reaching here means every attempt hit a conflict with no live
  // winner to hand off to. Our own blob is still on disk and unreferenced by any
  // registry entry — an orphaned, unrevocable public share unless we clean it up here
  // before giving up.
  getGlobalRecorder()?.record({
    type: 'system.error',
    component: 'chat-share',
    level: 'warn',
    message: 'Failed to update share registry after retries (no live winner); revoking orphaned blob',
    error: { name: 'Error', message: 'Registry write exceeded max retries', stack: new Error().stack },
  });
  await revokeShare(shareId);
  throw new ActionableError({
    goal: 'Create chat share',
    problem: 'Registry write exceeded max retries',
    location: 'createShare',
    nextSteps: ['Retry the request'],
  });
}
