// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4788: storage/registry logic for public debate shares. Structurally mirrors
// chatShareStore.ts (t/4787) — same CAS registry, same R-A through R-F retry/orphan-cleanup
// fixes, same K1-K6 shape — but the snapshot comes from the server-loaded debate session
// (SO D1, p/835#36), never from the request body: debates are already server-stored, so
// there's no client-supplied-content surface (chat's K7 problem) to guard against, and no
// provenance label is needed on the public view.

import path from 'path';
import { randomBytes } from 'crypto';
import { getGlobalRecorder } from '../../../lib/flight-recorder/index.js';
import { ActionableError } from '../../../lib/debate/errors.js';
import { checkRate } from './security/rateLimiter.js';
import { getStorageUserId } from './security/userContext.js';
import { resolveDataPath } from './config.js';
import { getUserContentBackend, assertSafeId } from './storage/fileIO.js';
import { gitBlobSha } from './storage/gitBlobSha.js';
import { loadDebateSession } from './storage/debateStore.js';
import { DEBATE_SHARE_CONFIG } from './config/debateShareConfig.js';

// ── Configuration (K5: externalized) ──
const DEBATE_SHARE_MAX_ACTIVE = DEBATE_SHARE_CONFIG.MAX_ACTIVE;
const DEBATE_SHARE_CREATES_PER_HOUR = DEBATE_SHARE_CONFIG.CREATES_PER_HOUR;
const DEBATE_SHARE_TTL_DAYS = DEBATE_SHARE_CONFIG.TTL_DAYS;
const PUBLIC_DEBATE_SHARES_DIR = 'public/debate-shares';

/** K1: Generate 128-bit share ID (randomBytes base64url, no padding). */
function generateShareId(): string {
  return randomBytes(16).toString('base64url');
}

// ── Types ──

/** D4 (SO p/835#37): the real SpeakerId enum plus the two non-pover speaker tags a
 *  TranscriptEntry can carry. Allowlisted, not passed through free-form. */
const ALLOWED_SPEAKERS = new Set(['accelerationist', 'safetyist', 'skeptic', 'user', 'system', 'moderator']);
/** D4: the real TranscriptEntry.type enum. Allowlisted, not passed through free-form. */
const ALLOWED_ENTRY_TYPES = new Set([
  'clarification', 'answer', 'opening', 'statement', 'question', 'concluding',
  'probing', 'fact-check', 'reflection', 'system', 'intervention',
]);

export interface SnapshotTranscriptEntry {
  speaker: string;
  type: string;
  content: string;
  timestamp: string;
}

/** D2 (SO p/835#36): only these reader-facing synthesis keys are ever published. The raw
 *  SynthesisPhaseResult also carries `rawResponses` (raw LLM output), `elapsed_ms`, and
 *  `data.{taxonomy_coverage,argument_map,taxonomy_proposals,taxonomy_modifications,preferences}`
 *  — editorial/internal fields that must never reach the public view. */
const SYNTHESIS_ALLOWED_KEYS = [
  'areas_of_agreement', 'areas_of_disagreement', 'cruxes',
  'unresolved_questions', 'policy_implications', 'topic_resolution',
] as const;

export interface DebateSnapshot {
  id: string;
  topic: string;
  activePovers: string[];
  transcript: SnapshotTranscriptEntry[];
  /** D3 (SO p/835#37): share-level flag, true if ANY transcript entry was degraded.
   *  Per-entry degraded/caveats are dropped — this single flag plus synthesis suppression
   *  (below) is the disclosure. */
  degraded: boolean;
  /** D2/D3: allowlisted synthesis keys only, and ABSENT (not just empty) when `degraded` is
   *  true — a degraded debate must not publish looking like a clean, complete one. */
  synthesis?: Record<string, unknown>;
  created_at: string;
}

export interface PublicDebateShare {
  id: string;
  debateId: string;
  userId: string;
  snapshot: DebateSnapshot;
  created_at: string;
  expires_at: string;
}

/** What an anonymous reader may see. Never the owner's userId or debateId. */
export interface PublicDebateShareView {
  id: string;
  snapshot: DebateSnapshot;
  created_at: string;
  expires_at: string;
}

export function toPublicView(share: PublicDebateShare): PublicDebateShareView {
  return {
    id: share.id,
    snapshot: share.snapshot,
    created_at: share.created_at,
    expires_at: share.expires_at,
  };
}

// ── Storage paths ──

function publicSharePath(shareId: string): string {
  assertSafeId(shareId, 'debate share id');
  return path.join(resolveDataPath(PUBLIC_DEBATE_SHARES_DIR), `${shareId}.json`);
}

function shareRegistryPath(): string {
  return path.join(resolveDataPath(`users/${getStorageUserId()}`), 'debate-shares.json');
}

/** Allowlist a transcript entry's speaker/type (D4) and drop everything except
 *  speaker/type/content/timestamp (diagnostics, raw prompts, model internals). */
function projectTranscriptEntry(entry: Record<string, unknown>): SnapshotTranscriptEntry {
  const speaker = String(entry.speaker ?? '');
  const type = String(entry.type ?? '');
  if (!ALLOWED_SPEAKERS.has(speaker)) {
    throw new ActionableError({
      goal: 'Create debate share with a valid transcript',
      problem: `Invalid speaker '${speaker}' on a transcript entry`,
      location: 'projectTranscriptEntry',
      nextSteps: ['Verify the debate session is well-formed'],
    });
  }
  if (!ALLOWED_ENTRY_TYPES.has(type)) {
    throw new ActionableError({
      goal: 'Create debate share with a valid transcript',
      problem: `Invalid entry type '${type}' on a transcript entry`,
      location: 'projectTranscriptEntry',
      nextSteps: ['Verify the debate session is well-formed'],
    });
  }
  return {
    speaker, type,
    content: String(entry.content ?? ''),
    timestamp: String(entry.timestamp ?? new Date().toISOString()),
  };
}

/** D2: allowlist-project the synthesis data object to only reader-facing keys. Returns
 *  undefined when there's nothing allowlisted to publish (absent, not an empty object, so
 *  a consumer can distinguish "no synthesis yet" from "synthesis ran but had no agreement
 *  points" — the latter is a real, if unusual, debate outcome). */
function projectSynthesis(data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!data) return undefined;
  const out: Record<string, unknown> = {};
  for (const key of SYNTHESIS_ALLOWED_KEYS) {
    if (key in data) out[key] = data[key];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Build the share's snapshot from a server-loaded debate session (D1: never from a
 *  request body). Finds the synthesis on the concluding entry's `metadata.synthesis`
 *  (SynthesisPhaseResult shape — the only place it's stored; it's not a top-level session
 *  field) and projects it through the D2 allowlist. */
function buildSnapshot(debateId: string, session: Record<string, unknown>): DebateSnapshot {
  const rawTranscript = Array.isArray(session.transcript) ? session.transcript as Record<string, unknown>[] : [];
  const transcript = rawTranscript.map(projectTranscriptEntry);
  const degraded = rawTranscript.some(e => e.degraded === true);

  let synthesisData: Record<string, unknown> | undefined;
  for (const entry of rawTranscript) {
    const metadata = entry.metadata as Record<string, unknown> | undefined;
    const synthesis = metadata?.synthesis as { data?: Record<string, unknown> } | undefined;
    if (synthesis?.data) { synthesisData = synthesis.data; break; }
  }

  const topic = session.topic as { final?: string } | undefined;

  return {
    id: debateId,
    topic: String(topic?.final ?? ''),
    activePovers: Array.isArray(session.active_povers) ? session.active_povers.map(String) : [],
    transcript,
    degraded,
    // D3: suppress synthesis entirely when degraded — never publish a degraded debate
    // looking clean and complete.
    synthesis: degraded ? undefined : projectSynthesis(synthesisData),
    created_at: new Date().toISOString(),
  };
}

async function saveShare(share: PublicDebateShare): Promise<void> {
  const backend = getUserContentBackend();
  const shareBlob = JSON.stringify(share, null, 2) + '\n';
  await backend.writeFile(publicSharePath(share.id), shareBlob);
}

export async function loadShare(shareId: string): Promise<PublicDebateShare | null> {
  try {
    const backend = getUserContentBackend();
    const content = await backend.readFile(publicSharePath(shareId), { optional: true });
    if (!content) return null;

    const share = JSON.parse(content) as PublicDebateShare;
    // K4: Check expiration and delete expired blobs
    if (new Date(share.expires_at) < new Date()) {
      await revokeShare(shareId);
      return null;
    }
    return share;
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'debate-share',
      level: 'warn',
      message: 'Failed to load debate share',
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
      component: 'debate-share',
      level: 'warn',
      message: 'Share does not exist (idempotent delete)',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
  }
}

/** Registry shares mapping. */
interface Registry {
  shares: Record<string, string>; // debateId → shareId
}

/** Registry read with baseSha for CAS (K3: race condition prevention). */
interface RegistryRead {
  registry: Registry;
  baseSha: string; // gitBlobSha of the content read (for CAS precondition)
}

export async function readRegistry(): Promise<RegistryRead> {
  const backend = getUserContentBackend();
  const content = await backend.readFile(shareRegistryPath(), { optional: true });
  // K3 (t/4787 root-cause fix, carried forward): baseSha '' is the CAS precondition for
  // "file does not exist" — matches FilesystemBackend.writeFile's
  // currentSha = current === null ? '' : gitBlobSha(current). Using gitBlobSha('') here
  // instead makes every first write on an absent registry conflict against the real
  // on-disk '' sentinel, exhausting the retry loop into a 500.
  if (!content) return { registry: { shares: {} }, baseSha: '' };

  try {
    const parsed = JSON.parse(content) as any;
    const registry: Registry = { shares: parsed.shares || parsed };
    const baseSha = gitBlobSha(content);
    return { registry, baseSha };
  } catch (err) {
    // R-D (carried forward from t/4787): a corrupt registry must fail closed, not be
    // silently treated as empty, or the next write would overwrite it with fresh data.
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'debate-share',
      level: 'error',
      message: 'Debate share registry is corrupt — refusing to overwrite',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    throw new ActionableError({
      goal: 'Read the debate share registry',
      problem: 'The registry file is corrupt (invalid JSON) and cannot be safely read or overwritten.',
      location: 'readRegistry',
      nextSteps: ['Inspect and manually repair or restore the registry file from backup', 'Do not retry until the file is valid JSON'],
      innerError: err,
    });
  }
}

/** R-B (carried forward from t/4787): write the registry with CAS even when the result is
 *  empty — never `deleteFile` unconditionally, which has no baseSha precondition and can
 *  wipe a concurrent create's entry. An empty registry is `{"shares":{}}`, not file-absence. */
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
    for (const [debateId, shareId] of Object.entries(registry.shares)) {
      const share = await loadShare(shareId);
      if (!share) {
        delete registry.shares[debateId];
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
            component: 'debate-share',
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
      component: 'debate-share',
      level: 'warn',
      message: 'Failed to prune registry',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
  }
}

/** The caller's live share for this debate, if any (P1: idempotence). */
export async function findExistingShare(debateId: string): Promise<PublicDebateShare | null> {
  try {
    const { registry } = await readRegistry();
    const existingShareId = registry.shares[debateId];
    return existingShareId ? await loadShare(existingShareId) : null;
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'debate-share',
      level: 'warn',
      message: 'Failed to check existing share; treating it as absent',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return null;
  }
}

/** Everything that can answer a create request before a new share is written, in order:
 *  P1 idempotence (an existing live share is returned as-is and doesn't count against the
 *  create rate limit), the active-share cap (a replace swaps one for one, so it's only
 *  refused when the debate had no share before), then the create rate limit. Returns null
 *  when a new share should be created. D1: no size-bound check — there's no client body. */
export async function createPreflight(
  debateId: string,
  userId: string,
  replace: boolean,
): Promise<{ status: number; payload: unknown } | null> {
  if (!replace) {
    const existing = await findExistingShare(debateId);
    if (existing) return { status: 200, payload: existing };
  }

  // K4: Prune expired entries before checking cap
  await pruneExpiredRegistry();

  const { registry } = await readRegistry();
  // K5: Cap violation returns 429 (not 409)
  const debateCount = Object.keys(registry.shares).length;
  if (!(debateId in registry.shares) && debateCount >= DEBATE_SHARE_MAX_ACTIVE) {
    return { status: 429, payload: { error: `At most ${DEBATE_SHARE_MAX_ACTIVE} debates can be shared at once; revoke one first`, retryAfterMs: 3600_000 } };
  }

  const rateCheck = checkRate(`debate-share-create:${userId}`, DEBATE_SHARE_CREATES_PER_HOUR, 3600_000);
  if (!rateCheck.allowed) {
    return { status: 429, payload: { error: 'Share creation rate limit exceeded', retryAfterMs: rateCheck.retryAfterMs } };
  }
  return null;
}

/** R-A (carried forward from t/4787): on a write conflict, check whether another writer
 *  already won for this debate and, if their share is still live, hand it back instead of
 *  retrying. Returns the winner's share, or null to signal "retry with our own blob intact"
 *  — never revoke our own blob here, only once a live winner is confirmed. */
async function resolveCreateConflict(debateId: string, shareId: string): Promise<PublicDebateShare | null> {
  const { registry: current } = await readRegistry();
  const otherShareId = current.shares[debateId];
  if (otherShareId && otherShareId !== shareId) {
    const otherShare = await loadShare(otherShareId);
    if (otherShare) {
      await revokeShare(shareId);
      return otherShare;
    }
  }
  return null;
}

/** One registry-write attempt for createShare's retry loop. R-C (carried forward): only
 *  revoke the previous share AFTER the registry commit succeeds. */
async function attemptCreateWrite(
  debateId: string,
  shareId: string,
  share: PublicDebateShare,
  backend: ReturnType<typeof getUserContentBackend>,
): Promise<PublicDebateShare | 'conflict'> {
  const { registry, baseSha } = await readRegistry();
  const previousShareId = registry.shares[debateId];
  registry.shares[debateId] = shareId;
  const newContent = JSON.stringify(registry) + '\n';

  try {
    await backend.writeFile(shareRegistryPath(), newContent, { baseSha });
    if (previousShareId && previousShareId !== shareId) await revokeShare(previousShareId);
    return share;
  } catch (writeErr: unknown) {
    const err = writeErr as any;
    if (err.code === 'WRITE_CONFLICT' || err.message?.includes('412') || err.message?.includes('WRITE_CONFLICT')) {
      return 'conflict';
    }
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'debate-share',
      level: 'warn',
      message: 'Registry write error (not conflict)',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    throw writeErr;
  }
}

/** D1 (SO p/835#36): loads the debate session SERVER-SIDE via loadDebateSession, which is
 *  already scoped to the caller's own storage (owner-checked implicitly, same as chat's
 *  store functions) and throws on not-found/not-owned. Never accepts transcript/synthesis
 *  from the request — removes chat's K7 problem (fabricated "camp said X" pages) entirely. */
export async function createShare(debateId: string, userId: string): Promise<PublicDebateShare> {
  assertSafeId(debateId, 'debate id');
  const rawSession = await loadDebateSession(debateId) as Record<string, unknown>;

  const shareId = generateShareId();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + DEBATE_SHARE_TTL_DAYS * 24 * 60 * 60 * 1000);

  const share: PublicDebateShare = {
    id: shareId,
    debateId,
    userId,
    snapshot: buildSnapshot(debateId, rawSession),
    created_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
  };

  await saveShare(share);

  const backend = getUserContentBackend();

  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await attemptCreateWrite(debateId, shareId, share, backend);
      if (result !== 'conflict') return result;

      const winner = await resolveCreateConflict(debateId, shareId);
      if (winner) return winner;
    }
  } catch (err) {
    // R-F (carried forward): a non-conflict error must still revoke the blob we already
    // saved before propagating.
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'debate-share',
      level: 'warn',
      message: 'Non-conflict error creating debate share; revoking the just-saved blob',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    await revokeShare(shareId);
    throw err;
  }

  // R-E (carried forward): exhausted retries with no live winner — revoke the orphaned blob.
  getGlobalRecorder()?.record({
    type: 'system.error',
    component: 'debate-share',
    level: 'warn',
    message: 'Failed to update share registry after retries (no live winner); revoking orphaned blob',
    error: { name: 'Error', message: 'Registry write exceeded max retries', stack: new Error().stack },
  });
  await revokeShare(shareId);
  throw new ActionableError({
    goal: 'Create debate share',
    problem: 'Registry write exceeded max retries',
    location: 'createShare',
    nextSteps: ['Retry the request'],
  });
}
