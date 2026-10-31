// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import crypto from 'crypto';
import { resolveDataPath } from '../config.js';
import { getUserContentBackend, assertSafeId } from '../storage/fileIO.js';
import type { StorageBackend } from '../storage/storageBackend.js';
import { sanitizeUserText, withSanitizeBudget } from '../security/contentSanitizer.js';
import { stripSensitiveKeys as stripSensitiveKeysCore } from '../../../../lib/sanitize/stripSensitiveKeys.js';
import { getStorageUserId, isAnonymousUser } from '../security/userContext.js';
import { log } from '../logger.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import path from 'path';
import { getConfig } from '../runtimeConfig.js';
import { mintCommunityOpedShare, getCommunityOpedShareEntry } from './communityOpedShares.js';
import { writePublicCommunityOpEd, type CommunityOpEdItem } from '../storage/communityOpedShareStore.js';
import {
  loadInquiryResult, listInquiryResults, saveInquiryResult, type InquiryResultSummary,
} from '../storage/inquiryResultStore.js';
import { deriveTruncation } from '../../../../lib/inquiry/index.js';
import type { InquiryResult } from '../../../../lib/inquiry/index.js';
import { CLASSIFICATION, dispositionFor, type Surface } from '../../../../lib/inquiry/fieldClassification.js';
import { AppliedTagSchema, loadPovTagRegistry } from '../../../../lib/schema/povTags.js';
import type { OpEdCommunityEntry } from '../../../../lib/oped/types.js';
import { AI_POVERS } from '../../../../lib/debate/types.js';

// ── Paths ──

function communityChatsDir(): string { return resolveDataPath('community/chats'); }
function communityDebatesDir(): string { return resolveDataPath('community/debates'); }
function communityOpedsDir(): string { return resolveDataPath('community/opeds'); }
function communityInquiriesDir(): string { return resolveDataPath('community/inquiries'); }
function submissionsDir(): string { return resolveDataPath('community/_submissions'); }
function removalsDir(): string { return resolveDataPath('community/_removals'); }

// ── Admin ──

export function getAdminUsers(): string[] {
  return (process.env.ADMIN_USERS || 'jpsnover,jsnover13-at-gmail-com').split(',').map(s => s.trim());
}

export function isAdmin(userId?: string): boolean {
  const uid = userId ?? getStorageUserId();
  return uid !== '_local' && getAdminUsers().includes(uid);
}

// ── Listing index (t/726) ──
//
// Community chats/debates are append-only shared data on `main`. Listing them by
// reading every file (1 listDirectory + N readFile) cost ~51 GitHub API calls /
// 10-15s for 50 items on a cold cache. Instead each directory keeps a sibling
// `_index.json` holding the lean metadata each listing returns; reads serve from
// it (1 read) and a count-based staleness check — listDirectory() uses the
// in-memory repoTree, so it costs 0 API calls — triggers a rebuild when the file
// count drifts. The index is a cache only: a missing/stale index always falls
// back to a full scan, so it can never serve data the directory doesn't have.
//
// This mirrors listDebateSessionsMeta() in fileIO.ts. Submissions are
// intentionally NOT indexed here: their records are mutable (status flips on
// approve/reject) under a split-ref write model (submit → main, approve/reject →
// session branch), so a count-based index would serve stale statuses. They keep
// per-file reads until the write flow is unified or moved to blob storage (t/695).

const COMMUNITY_INDEX_FILE = '_index.json';

// Bump when toEntry shape changes so stale caches are replaced on next list.
const CHAT_INDEX_VERSION = 'chat-v3'; // v2: added model (t/2779); v3: added pover (t/4721)
const DEBATE_INDEX_VERSION = 'debate-v2'; // v2: added model + turn_count (t/2362/t/2384)
const OPED_INDEX_VERSION = 'oped-v3'; // v2: added outlet (t/2993); v3: added tag (t/3991)
const INQUIRY_INDEX_VERSION = 'inquiry-v1'; // t/3621

interface ListingIndexSpec<T> {
  dir: string;
  prefix: string;
  toEntry: (parsed: any) => T;
  malformedMessage: string;
  version: string;
}

interface ListingIndex<T> {
  version: string;
  entries: T[];
}

/** Direct-child item files in `dir` matching `prefix` (excludes `_index.json`). */
async function listIndexedFiles(dir: string, prefix: string): Promise<string[]> {
  const backend = getUserContentBackend();
  return (await backend.listDirectory(dir))
    .filter(f => f.startsWith(prefix) && f.endsWith('.json'));
}

/** Full scan: read every item file, build the lean index, persist it (best-effort). */
async function rebuildListingIndex<T>(spec: ListingIndexSpec<T>): Promise<T[]> {
  const backend = getUserContentBackend();
  const files = await listIndexedFiles(spec.dir, spec.prefix);
  const entries: T[] = [];
  for (const f of files) {
    try {
      const raw = await backend.readFile(path.join(spec.dir, f));
      if (raw === null) continue;
      entries.push(spec.toEntry(JSON.parse(raw)));
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'community',
        level: 'warn',
        message: spec.malformedMessage,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      /* skip malformed */
    }
  }
  // Best-effort: a read-only context (or exhausted API) just keeps full-scanning.
  const index: ListingIndex<T> = { version: spec.version, entries };
  await backend.writeFile(
    path.join(spec.dir, COMMUNITY_INDEX_FILE),
    JSON.stringify(index, null, 2),
  ).catch((err) => { log.server.warn({ err }, 'Community listing index write failed (best-effort)'); });
  return entries;
}

/**
 * Serve a community listing from its `_index.json`, rebuilding when the index is
 * absent (cold start), its version doesn't match the current toEntry schema, or its
 * entry count no longer matches the directory. A version mismatch (toEntry schema
 * change) forces a synchronous rebuild so callers always get up-to-date fields.
 * A count drift returns the cached copy immediately and rebuilds in the background.
 * Returns entries unsorted — callers apply their own sort.
 */
async function listViaIndex<T>(spec: ListingIndexSpec<T>): Promise<T[]> {
  const backend = getUserContentBackend();
  let cached: T[] | null = null;
  try {
    const raw = await backend.readFile(path.join(spec.dir, COMMUNITY_INDEX_FILE));
    if (raw !== null) {
      const parsed = JSON.parse(raw);
      // Old format was a bare array; new format is { version, entries }.
      // Any version mismatch (incl. old format) → cache miss → synchronous rebuild.
      if (!Array.isArray(parsed) && parsed?.version === spec.version) {
        cached = (parsed as ListingIndex<T>).entries;
      }
    }
  } catch { /* telemetry — silent by design */ cached = null; }

  if (cached !== null) {
    try {
      const files = await listIndexedFiles(spec.dir, spec.prefix);
      if (files.length === cached.length) return cached;
      // Count drift — refresh in the background, serve the cached copy now for speed.
      void rebuildListingIndex(spec).catch((err) => { log.server.warn({ err }, 'Background community index rebuild failed'); });
      return cached;
    } catch {
      /* telemetry — silent by design */
      return cached; // tree unavailable — trust the index
    }
  }
  return rebuildListingIndex(spec);
}

// ── Community read ──

interface CommunityChatEntry {
  id: unknown; title: string; created_at: string; updated_at: string;
  mode: string; community_metadata: unknown; chat_model?: string;
}

interface CommunityDebateEntry {
  id: unknown; title: string; created_at: string; updated_at: string;
  phase: string; community_metadata: unknown;
  model?: string; turn_count?: number;
}

type CommunityOpEdTag = NonNullable<OpEdCommunityEntry['tag']>;

interface CommunityOpEdEntry {
  id: unknown; topic: string; created_at: string; updated_at: string;
  community_metadata: unknown;
  camps: string[];
  voice_count: number;
  tag?: CommunityOpEdTag;
}

/**
 * t/3991 (TL t/3960#3 cond 2; SO e/252#2 cond 1): the tagged member's scope, so a list row never labels
 * a one-wing essay as the whole camp's. Named reads only — `{ pov, tag, mode }` from the member's applied
 * tag, `label` (the wing name) from the tag registry. Absent for untagged sets.
 *
 * Two fallbacks, both WARNed (fallback-path logging):
 *  - a tag no longer in the registry (retired after the set was stored) keeps the tag with its id as the
 *    label. Dropping it would show the essay as the whole camp's — the misattribution this field prevents.
 *  - a malformed applied tag is omitted: there is nothing trustworthy to show.
 */
function communityOpEdTag(setId: unknown, opeds: unknown): CommunityOpEdTag | undefined {
  if (!Array.isArray(opeds)) return undefined;
  const tagged = opeds.filter((m): m is { tag: unknown } =>
    !!m && typeof m === 'object' && (m as { tag?: unknown }).tag !== undefined);
  if (tagged.length === 0) return undefined;
  if (tagged.length > 1) {
    log.server.warn({ setId, taggedMembers: tagged.length },
      'Community op-ed index: more than one tagged member (a tag applies to one camp) — using the first');
  }
  const parsed = AppliedTagSchema.safeParse(tagged[0].tag);
  if (!parsed.success) {
    log.server.warn({ setId, issues: parsed.error.issues.map((i) => i.message) },
      'Community op-ed index: malformed applied tag on a member — omitting the tag from the list entry');
    return undefined;
  }
  const { pov, tag, mode } = parsed.data;
  const label = loadPovTagRegistry().povs[pov]?.find((e) => e.id === tag)?.label;
  if (label === undefined) {
    log.server.warn({ setId, pov, tag },
      'Community op-ed index: tag not in the registry (retired?) — showing the tag id as its label');
  }
  return { pov, tag, mode, label: label ?? tag };
}

interface CommunityInquiryEntry {
  id: unknown; question: string; created_at: string; updated_at: string;
  community_metadata: unknown;
  camps: string[];
  verdict_count: number;
}

export async function listCommunityChats(): Promise<unknown[]> {
  const items = await listViaIndex<CommunityChatEntry>({
    dir: communityChatsDir(),
    prefix: 'chat-',
    version: CHAT_INDEX_VERSION,
    malformedMessage: 'Skipping malformed community chat file',
    toEntry: (parsed) => ({
      id: parsed.id,
      title: parsed.title || 'Untitled',
      created_at: parsed.created_at || '',
      updated_at: parsed.updated_at || parsed.created_at || '',
      mode: parsed.mode || '',
      community_metadata: stripOriginalId(parsed.community_metadata || null), // t/856
      ...(typeof parsed.chat_model === 'string' ? { model: parsed.chat_model } : {}),
      // Read-only projection: only a known AI camp id passes through; anything else is dropped.
      ...((AI_POVERS as readonly unknown[]).includes(parsed.pover) ? { pover: parsed.pover } : {}),
    }),
  });
  return [...items].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
}

export async function listCommunityDebates(): Promise<unknown[]> {
  const items = await listViaIndex<CommunityDebateEntry>({
    dir: communityDebatesDir(),
    prefix: 'debate-',
    version: DEBATE_INDEX_VERSION,
    malformedMessage: 'Skipping malformed community debate file',
    toEntry: (parsed) => ({
      id: parsed.id,
      title: parsed.title || parsed.topic?.final || parsed.topic?.original || 'Untitled Debate',
      created_at: parsed.created_at || '',
      updated_at: parsed.updated_at || parsed.created_at || '',
      phase: parsed.phase || 'unknown',
      community_metadata: stripOriginalId(parsed.community_metadata || null), // t/856
      model: typeof parsed.debate_model === 'string' ? parsed.debate_model : undefined,
      turn_count: Array.isArray(parsed.transcript)
        ? parsed.transcript.filter((t: { type: string }) => t.type === 'statement' || t.type === 'opening').length
        : undefined,
    }),
  });
  return [...items].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
}

export async function listCommunityOpEds(): Promise<unknown[]> {
  const items = await listViaIndex<CommunityOpEdEntry>({
    dir: communityOpedsDir(),
    prefix: 'oped-',
    version: OPED_INDEX_VERSION,
    malformedMessage: 'Skipping malformed community op-ed file',
    toEntry: (parsed) => {
      const tag = communityOpEdTag(parsed.id, parsed.opeds);
      return {
        id: parsed.id,
        topic: typeof parsed.topic === 'string' ? parsed.topic || 'Untitled' : 'Untitled',
        created_at: parsed.created_at || '',
        updated_at: parsed.updated_at || parsed.created_at || '',
        community_metadata: stripOriginalId(parsed.community_metadata || null),
        camps: Array.isArray(parsed.opeds)
          ? [...new Set<string>((parsed.opeds as { pov?: string }[]).map(m => m.pov).filter((p): p is string => Boolean(p)))]
          : [],
        voice_count: Array.isArray(parsed.opeds) ? (parsed.opeds as unknown[]).length : 0,
        outlet: typeof parsed.params?.outlet === 'string' ? parsed.params.outlet : undefined,
        ...(tag ? { tag } : {}),
      };
    },
  });
  return [...items].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
}

export async function listCommunityInquiries(): Promise<unknown[]> {
  const items = await listViaIndex<CommunityInquiryEntry>({
    dir: communityInquiriesDir(),
    prefix: 'inquiry-',
    version: INQUIRY_INDEX_VERSION,
    malformedMessage: 'Skipping malformed community inquiry file',
    toEntry: (parsed) => ({
      id: parsed.id,
      question: typeof parsed.request?.question === 'string' ? parsed.request.question || 'Untitled' : 'Untitled',
      created_at: parsed.created_at || '',
      updated_at: parsed.updated_at || parsed.created_at || '',
      community_metadata: stripOriginalId(parsed.community_metadata || null),
      camps: Array.isArray(parsed.campVerdicts)
        ? [...new Set<string>((parsed.campVerdicts as { camp?: string }[]).map(v => v.camp).filter((c): c is string => Boolean(c)))]
        : [],
      verdict_count: Array.isArray(parsed.campVerdicts) ? (parsed.campVerdicts as unknown[]).length : 0,
    }),
  });
  return [...items].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
}

/** Community type union used by the reader/copy/removal surface (plural, matches published dir names). */
type CommunityType = 'chats' | 'debates' | 'opeds' | 'inquiries';

/**
 * t/3650 (SO review of t/3621, e/198#3 condition 1): the dir/prefix selection used to be a ternary
 * chain with an implicit `else` falling through to opeds — TypeScript couldn't catch a missed arm
 * the next time a type is added to the union; it would silently misfile into community/opeds/. An
 * exhaustive switch with an `assertNever` default converts that into a compile error. No behavior
 * change — same dir/prefix per type, just a structure the compiler can verify.
 */
function communityDirAndPrefix(type: CommunityType): { dir: string; prefix: string } {
  switch (type) {
    case 'chats': return { dir: communityChatsDir(), prefix: 'chat-' };
    case 'debates': return { dir: communityDebatesDir(), prefix: 'debate-' };
    case 'opeds': return { dir: communityOpedsDir(), prefix: 'oped-' };
    case 'inquiries': return { dir: communityInquiriesDir(), prefix: 'inquiry-' };
    default: return assertNeverCommunityType(type);
  }
}

function assertNeverCommunityType(type: never): never {
  throw new Error(`Unhandled community type: ${String(type)}`);
}

export async function loadCommunityItem(type: CommunityType, id: string): Promise<unknown | null> {
  assertSafeId(id, 'community id'); // block path traversal (M2)
  const backend = getUserContentBackend();
  const { dir, prefix } = communityDirAndPrefix(type);
  const raw = await backend.readFile(path.join(dir, `${prefix}${id}.json`));
  if (!raw) return null;
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  // t/856: don't expose the pre-share private UUID in public responses.
  if (parsed.community_metadata) parsed.community_metadata = stripOriginalId(parsed.community_metadata);
  return parsed;
}

/**
 * t/3430: discriminates why a lookup failed. `'absent'` = the blob doesn't exist (wrong id,
 * or a genuinely missing record) — ordinary, expected, never corruption. `'empty'` = the blob
 * exists but has no voices (the ADR-001 guard) — a GitHub API silent-empty response or real
 * data corruption; callers should treat this as a signal worth logging.
 */
export type CommunityOpEdLookup =
  | { found: true; item: Record<string, unknown> }
  | { found: false; reason: 'absent' | 'empty' };

/**
 * Internal accessor for a community op-ed — returns the raw parsed item including
 * full community_metadata (not stripped for public exposure). Intended for
 * share-projection callers that need submittedBy and the full voice list.
 * ADR-001 non-empty guard: reason 'empty' means the item has no voices, which indicates
 * a GitHub API silent-empty response rather than a legitimate zero-voice item.
 */
export async function getCommunityOpEd(id: string): Promise<CommunityOpEdLookup> {
  assertSafeId(id, 'community oped id');
  const backend = getUserContentBackend();
  const raw = await backend.readFile(path.join(communityOpedsDir(), `oped-${id}.json`));
  if (raw === null) return { found: false, reason: 'absent' };
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  // ADR-001: GitHub API can return empty content on network hiccups; a real oped always has voices.
  if (!Array.isArray(parsed.opeds) || (parsed.opeds as unknown[]).length === 0) {
    return { found: false, reason: 'empty' };
  }
  return { found: true, item: parsed };
}

/**
 * t/3483: the idempotent mint-and-project sequence, extracted from routes/community.ts's
 * manual-mint handler so the mint-on-approve hook and the one-time backfill can reuse the
 * exact same guard + write path (one path, not three copies to drift). Never throws on
 * absent/empty/malformed — callers get a discriminated `skipped` outcome instead, since
 * both call sites (approve, backfill) need to keep going / not fail on a bad item.
 */
export async function mintAndProjectCommunityOpEd(id: string, submittedBy: string): Promise<
  | { outcome: 'minted'; shareId: string }
  | { outcome: 'already-shared'; shareId: string }
  | { outcome: 'skipped'; reason: 'absent' | 'empty' | 'malformed' }
> {
  const lookup = await getCommunityOpEd(id);
  if (!lookup.found) return { outcome: 'skipped', reason: lookup.reason };

  const it = lookup.item as { topic?: unknown; opeds?: unknown };
  if (!it.topic || !Array.isArray(it.opeds) || it.opeds.length === 0) {
    return { outcome: 'skipped', reason: 'malformed' };
  }

  const alreadyShared = !!(await getCommunityOpedShareEntry(id));
  const shareId = await mintCommunityOpedShare(id, submittedBy);
  await writePublicCommunityOpEd(lookup.item as unknown as CommunityOpEdItem, shareId);
  return { outcome: alreadyShared ? 'already-shared' : 'minted', shareId };
}

/**
 * t/3483 Part C — one-time (safe to re-run) backfill: mints + projects a public share for
 * every existing community op-ed that doesn't have one yet, so the public index
 * (GET /api/public/opeds) is complete immediately rather than waiting on someone to click
 * Share on each item. Sequential, not parallel — a few hundred items is not a latency
 * concern for an admin-triggered one-time op, and it keeps registry-write contention low.
 */
export async function backfillCommunityOpedShares(): Promise<{
  minted: number; alreadyShared: number; skipped: number; skippedIds: string[];
}> {
  const items = await listCommunityOpEds() as { id: string; community_metadata?: { submitted_by_display?: string } }[];
  let minted = 0;
  let alreadyShared = 0;
  const skippedIds: string[] = [];

  for (const it of items) {
    const result = await mintAndProjectCommunityOpEd(it.id, it.community_metadata?.submitted_by_display ?? '');
    if (result.outcome === 'minted') minted++;
    else if (result.outcome === 'already-shared') alreadyShared++;
    else {
      skippedIds.push(it.id);
      log.server.warn({ id: it.id, reason: result.reason }, 'Community op-ed backfill: skipped malformed/empty item');
    }
  }

  log.server.info({ minted, alreadyShared, skipped: skippedIds.length }, 'Community op-ed share backfill complete');
  return { minted, alreadyShared, skipped: skippedIds.length, skippedIds };
}

// ── Submissions ──

interface Submission {
  id: string;
  type: 'chat' | 'debate' | 'oped' | 'inquiry';
  originalId: string;
  submittedBy: string;
  submittedAt: string;
  status: 'pending' | 'approved' | 'rejected';
  note?: string;
  rejectionReason?: string;
  data: unknown;
}

/** t/3650: exhaustive-switch counterpart to communityDirAndPrefix for the singular Submission.type
 *  union (approveSubmission's only caller) — same anti-silent-misfile guard, separate helper because
 *  it's a different union (singular 'chat'/'debate'/... vs. the reader surface's plural). */
function submissionDirAndPrefix(type: Submission['type']): { dir: string; prefix: string } {
  switch (type) {
    case 'chat': return { dir: communityChatsDir(), prefix: 'chat-' };
    case 'debate': return { dir: communityDebatesDir(), prefix: 'debate-' };
    case 'oped': return { dir: communityOpedsDir(), prefix: 'oped-' };
    case 'inquiry': return { dir: communityInquiriesDir(), prefix: 'inquiry-' };
    default: return assertNeverCommunityType(type);
  }
}

export async function submitToCommunity(type: 'chat' | 'debate' | 'oped' | 'inquiry', itemData: unknown, note?: string): Promise<{ submissionId: string }> {
  const userId = getStorageUserId();
  const backend = getUserContentBackend();
  const dir = submissionsDir();

  // Rate limit: max pending submissions per user (t/929: runtime-configurable, default 20)
  const maxPendingPerUser = getConfig().community.maxPendingPerUser;
  const existing = await listSubmissionsForUser(userId);
  const pending = existing.filter(s => s.status === 'pending');
  if (pending.length >= maxPendingPerUser) {
    throw Object.assign(new Error(`Maximum ${maxPendingPerUser} pending submissions allowed`), { statusCode: 429 });
  }

  // L7 (t/720): global pending-queue cap — backstop against many users (or
  // anonymous sessions) collectively exhausting the review queue / storage.
  const GLOBAL_PENDING_CAP = getConfig().community.globalPendingCap; // t/929: runtime-configurable (default 500)
  const allPending = await listSubmissions('pending');
  if (allPending.length >= GLOBAL_PENDING_CAP) {
    throw Object.assign(new Error('Community submission queue is full; please try again later.'), { statusCode: 503 });
  }

  // t/3621: an inquiry submission carries only { id: jobId } — the server loads the stored result
  // itself rather than trusting a client-supplied body. loadInquiryResult is auth-scoped to the
  // calling session's own user (t/3574/ADR-0002 §8), so this also structurally prevents publishing
  // another user's inquiry even if a client sends someone else's jobId. An InquiryResult carries
  // TrustState/calibration/convergence fields the UI renders as platform-generated authority claims
  // (t/3576 generated-not-hand-applied) — never accept those from the client (TL, t/3621#3).
  let dataToStore = itemData;
  if (type === 'inquiry') {
    const jobId = (itemData as { id?: unknown })?.id;
    if (typeof jobId !== 'string' || !jobId) {
      throw Object.assign(new Error('inquiry submission requires { id: jobId }'), { statusCode: 400 });
    }
    const result = await loadInquiryResult(jobId);
    if (!result) throw Object.assign(new Error('Inquiry result not found'), { statusCode: 404 });
    // t/3621 SO review (e/198#3 condition 4): `created_at` is deliberately the RUN date (when the
    // inquiry was executed, from InquiryResultSummary.createdAt) — NOT the community-submission
    // date, which is separately stamped as community_metadata.submitted_at in sanitizeForCommunity.
    // For a research artifact, when the answer was produced is the meaningful sort/display date;
    // when it happened to be shared to Community is not. The two are expected to diverge.
    const summaries = await listInquiryResults();
    const createdAt = summaries.find(s => s.jobId === jobId)?.createdAt ?? new Date().toISOString();
    dataToStore = { ...result, id: jobId, created_at: createdAt };
  }

  const item = dataToStore as { id: string };
  const submissionId = crypto.randomUUID();
  const submission: Submission = {
    id: submissionId,
    type,
    originalId: item.id,
    submittedBy: userId,
    submittedAt: new Date().toISOString(),
    status: 'pending',
    note,
    data: dataToStore,
  };

  // t/700: community submissions live in Azure Blob (no git branches), so the
  // ref:'main' overlay-bypass that was needed on the GitHub backend (t/694) is gone.
  await backend.writeFile(
    path.join(dir, `sub-${submissionId}.json`),
    JSON.stringify(submission, null, 2),
  );

  log.server.info({ submissionId, type, userId }, 'Community submission created');

  // Admin submissions are auto-approved — skip the pending queue.
  if (isAdmin(userId)) {
    await approveSubmission(submissionId);
    log.server.info({ submissionId, type, userId }, 'Admin submission auto-approved');
  }

  return { submissionId };
}

async function listSubmissionsForUser(userId: string): Promise<Submission[]> {
  const backend = getUserContentBackend();
  const dir = submissionsDir();
  const files = (await backend.listDirectory(dir)).filter(f => f.startsWith('sub-') && f.endsWith('.json'));
  const subs: Submission[] = [];
  for (const f of files) {
    try {
      const raw = await backend.readFile(path.join(dir, f));
      if (raw === null) continue;
      const s = JSON.parse(raw) as Submission;
      if (s.submittedBy === userId) subs.push(s);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'community',
        level: 'warn',
        message: 'Skipping malformed submission file (user list)',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      /* skip */
    }
  }
  return subs;
}

export async function listSubmissions(statusFilter?: string): Promise<unknown[]> {
  const backend = getUserContentBackend();
  const dir = submissionsDir();
  const files = (await backend.listDirectory(dir)).filter(f => f.startsWith('sub-') && f.endsWith('.json'));
  const subs: Submission[] = [];
  for (const f of files) {
    try {
      const raw = await backend.readFile(path.join(dir, f));
      if (raw === null) continue;
      const s = JSON.parse(raw) as Submission;
      if (!statusFilter || s.status === statusFilter) subs.push(s);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'community',
        level: 'warn',
        message: 'Skipping malformed submission file (admin list)',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      /* skip */
    }
  }
  return subs.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
}

// t/2037: the traversal + key-set + secret-prefix screen now live in the shared
// lib/sanitize module (byte-identical logic, parity-verified across the server and
// desktop copies before extraction). This is the server binding: inject the pino +
// ALS-aware `sanitizeUserText` as the per-string sanitizer; the `withSanitizeBudget`
// ALS wrap stays OUTSIDE the traversal (server-HTTP-only concern, t/2033#6). Kept as a
// one-arg export so the t/2032 regression suite exercises the real server wiring
// unchanged — a binding wrapper carries no traversal logic, so it can't drift.
export function stripSensitiveKeys(obj: unknown): unknown {
  return stripSensitiveKeysCore(obj, sanitizeUserText);
}

/** t/856: drop the pre-share private UUID from community_metadata before it's
 *  served publicly (kept in the stored file for admin tracing). */
function stripOriginalId(meta: unknown): unknown {
  if (!meta || typeof meta !== 'object') return meta;
  const rest = { ...(meta as Record<string, unknown>) };
  delete rest.original_id;
  return rest;
}

/**
 * t/3651: constructive positive-allowlist projector for an `InquiryResult`-shaped value onto one
 * `fieldClassification` surface (t/3648). A path is a LEAF the instant it appears in `CLASSIFICATION`
 * — matching the matrix's own dotted-path granularity (e.g. `derivation.models` is one atomic leaf
 * while `request.models.debaters`/`.evaluator` are two) — so this needs no independent schema
 * knowledge and stays correct as the matrix's own field boundaries evolve. Replaces
 * `COMMUNITY_DENYLIST_BLIND_SPOTS` (t/3621/e/198#3): a denylist can silently miss a context-sensitive
 * field (`debateId` did); a positive projection derived from the SO-blessed, CI-enforced matrix
 * structurally cannot — an unclassified leaf throws via `dispositionFor` rather than passing through.
 */
function projectInquiryFields(value: unknown, surface: Surface, path: string): unknown {
  if (path in CLASSIFICATION) {
    return dispositionFor(path, surface).include ? value : undefined;
  }
  if (Array.isArray(value)) {
    return value.map((el) => projectInquiryFields(el, surface, path));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const childPath = path ? `${path}.${k}` : k;
      const projected = projectInquiryFields(v, surface, childPath);
      if (projected !== undefined) out[k] = projected;
    }
    return out;
  }
  // A primitive with no classified path above it. fieldClassification.test.ts's exhaustiveness gate
  // guarantees this can't happen for a real InquiryResult (every schema leaf is classified on all
  // three surfaces) — unreachable in practice, not a silent pass-through default.
  return undefined;
}

function sanitizeForCommunity(data: unknown, submittedBy: string, type: Submission['type']): unknown {
  // t/2031: bound the ENTIRE recursive strip/sanitize walk under one wall-time
  // budget so a many-field crafted submission can't amplify per-field sanitize cost
  // into a multi-minute event-loop block (Server Community sign-off e/53#3; the
  // budget is re-entrant-safe, so any nested sanitizeDeep composes rather than
  // reseeding). Behavior-preserving: legit submissions finish in ~ms, far under budget.
  let d = withSanitizeBudget(
    () => stripSensitiveKeys(JSON.parse(JSON.stringify(data))),
  ) as Record<string, unknown>;
  if (type === 'inquiry') {
    // t/3651: `id`/`created_at` are community-projection-owned bridging fields stamped by
    // submitToCommunity (t/3621), not part of InquiryResultSchema — the matrix classifies only
    // contract fields (t/3651#7's "not part of this matrix" note), so they're preserved explicitly
    // rather than dropped as unclassified. `id` is re-minted below regardless.
    const { id, created_at, ...contractFields } = d;
    const projected = projectInquiryFields(contractFields, 'community', '') as Record<string, unknown>;
    // t/3742 (TL p/613#61): a degraded run (censored/api_ceiling) must not surface a synthesized
    // headline to ANY reader, community included — this sanitizer, not generation, is the actual
    // security boundary (generation decides whether to PRODUCE a headline; this decides whether to
    // PUBLISH it). Suppress at construction, mirroring the matrix's own field-classification
    // discipline. WARN on suppress: reaching this path means generation populated the field for a
    // degraded run — a producer bug (t/3735's scope), and it must be loud, not silently corrected.
    if (projected.synthesizedHeadline !== undefined) {
      const { truncated, terminationReason } = deriveTruncation(data as InquiryResult);
      if (truncated) {
        delete projected.synthesizedHeadline;
        log.server.warn(
          { terminationReason },
          'sanitizeForCommunity: suppressed synthesizedHeadline on a degraded-trust inquiry run (producer bug — generation should not have populated it, t/3742)',
        );
      }
    }
    d = { ...projected, id, created_at };
  }
  d.community_metadata = {
    submitted_by_display: submittedBy,
    submitted_at: new Date().toISOString(),
    approved_at: new Date().toISOString(),
    original_id: d.id,
  };
  d.id = crypto.randomUUID();
  return d;
}

/**
 * t/3483 Part B: mint + project the public share at approve time (not submit — the item is
 * unreviewed until now) so it appears on the public index without anyone clicking Share.
 * Never fails the approve: a WARN'd item (thrown error or skipped outcome) is caught by the
 * next backfill run (idempotent).
 */
async function autoShareApprovedOped(communityId: string, submittedBy: string): Promise<void> {
  try {
    const result = await mintAndProjectCommunityOpEd(communityId, submittedBy);
    if (result.outcome === 'skipped') {
      log.server.warn(
        { communityId, reason: result.reason },
        'Community op-ed auto-share on approve skipped — item approved but not indexed; backfill will catch it if fixed',
      );
    }
  } catch (err) {
    log.server.warn(
      { err, communityId },
      'Community op-ed auto-share on approve failed — item approved but not yet indexed; backfill will catch it',
    );
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'community', level: 'warn',
      message: 'Community op-ed auto-share on approve failed',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
  }
}

export async function approveSubmission(
  submissionId: string,
  edits?: Record<string, unknown>,
): Promise<{ communityId: string }> {
  assertSafeId(submissionId, 'submission id'); // t/850: defense-in-depth parity with sibling fns
  const backend = getUserContentBackend();
  const subPath = path.join(submissionsDir(), `sub-${submissionId}.json`);
  const raw = await backend.readFile(subPath);
  if (!raw) throw Object.assign(new Error('Submission not found'), { statusCode: 404 });

  const submission = JSON.parse(raw) as Submission;
  if (submission.status !== 'pending') throw Object.assign(new Error(`Submission already ${submission.status}`), { statusCode: 409 });

  // Edit-on-promote (t/650 AC#4): shallow-merge admin edits (e.g. title /
  // description) onto the data before sanitizing + publishing. The user's stored
  // submission is left as-is — edits affect only the published copy.
  const dataToPublish = (edits && typeof edits === 'object' && submission.data && typeof submission.data === 'object')
    ? { ...(submission.data as Record<string, unknown>), ...edits }
    : submission.data;
  const sanitized = sanitizeForCommunity(dataToPublish, submission.submittedBy, submission.type) as { id: string };
  const { dir, prefix } = submissionDirAndPrefix(submission.type);

  await backend.writeFile(
    path.join(dir, `${prefix}${sanitized.id}.json`),
    JSON.stringify(sanitized, null, 2),
  );

  // Invalidate the listing index so the published item appears immediately on the next list call (t/4611).
  // The index caches directory contents + version; without this, listViaIndex serves the stale cached copy
  // that was built before the item was written, so the newly approved item doesn't appear until the cache TTL expires.
  await invalidateListingIndex(backend, dir);

  // Update submission status
  submission.status = 'approved';
  await backend.writeFile(subPath, JSON.stringify(submission, null, 2));

  log.server.info({ submissionId, communityId: sanitized.id, type: submission.type }, 'Community submission approved');

  if (submission.type === 'oped') {
    await autoShareApprovedOped(sanitized.id, submission.submittedBy);
  }

  return { communityId: sanitized.id };
}

export async function rejectSubmission(submissionId: string, reason?: string): Promise<void> {
  assertSafeId(submissionId, 'submission id'); // t/850: defense-in-depth parity with sibling fns
  const backend = getUserContentBackend();
  const subPath = path.join(submissionsDir(), `sub-${submissionId}.json`);
  const raw = await backend.readFile(subPath);
  if (!raw) throw Object.assign(new Error('Submission not found'), { statusCode: 404 });

  const submission = JSON.parse(raw) as Submission;
  if (submission.status !== 'pending') throw Object.assign(new Error(`Submission already ${submission.status}`), { statusCode: 409 });

  submission.status = 'rejected';
  // Persist the admin's reason so it can surface in a "My Submissions" view (t/650 AC#6).
  if (reason) submission.rejectionReason = reason;
  await backend.writeFile(subPath, JSON.stringify(submission, null, 2));

  log.server.info({ submissionId, type: submission.type }, 'Community submission rejected');
}

export async function copyFromCommunity(type: CommunityType, communityId: string): Promise<{ newId: string }> {
  if (isAnonymousUser()) throw Object.assign(new Error('Anonymous users cannot copy community items'), { statusCode: 403 });

  const item = await loadCommunityItem(type, communityId);
  if (!item) throw Object.assign(new Error('Community item not found'), { statusCode: 404 });

  const copy = JSON.parse(JSON.stringify(item)) as Record<string, unknown>;
  copy.id = crypto.randomUUID();
  copy.copied_from_community = communityId;
  copy.created_at = new Date().toISOString();
  copy.updated_at = new Date().toISOString();

  // Import into user's personal store via fileIO (which routes to user dir).
  // t/3650: exhaustive switch — same anti-silent-misfile guard as communityDirAndPrefix (this
  // chain's implicit `else` used to fall through to the oped/finalizeOpedSet branch).
  switch (type) {
    case 'chats': {
      const { saveChatSession } = await import('../storage/fileIO.js');
      await saveChatSession(copy);
      break;
    }
    case 'debates': {
      const { saveDebateSession } = await import('../storage/fileIO.js');
      await saveDebateSession(copy, 'community-fork');
      break;
    }
    case 'inquiries': {
      // t/3621: re-derive truncated/terminationReason from the copied result (deriveTruncation is
      // pure over calibration trust states) rather than trusting any stale value on the community
      // item — same "re-derive, don't trust a stored/submitted value" discipline as the submit path.
      const result = copy as unknown as InquiryResult;
      const { truncated, terminationReason } = deriveTruncation(result);
      const debateIdRaw = (copy as Record<string, unknown>).debateId;
      const summary: InquiryResultSummary = {
        jobId: copy.id as string,
        question: typeof result.request?.question === 'string' ? result.request.question : '',
        debateId: typeof debateIdRaw === 'string' && debateIdRaw.length > 0 ? debateIdRaw : null,
        truncated,
        terminationReason,
        createdAt: copy.created_at as string,
      };
      await saveInquiryResult(copy.id as string, result, summary);
      break;
    }
    case 'opeds': {
      // Draft: blocked on t/2572 (finalizeOpedSet) landing in storage/fileIO.ts
      const fileIO = await import('../storage/fileIO.js') as Record<string, unknown>;
      await (fileIO['finalizeOpedSet'] as (set: unknown) => Promise<void>)(copy);
      break;
    }
    default: assertNeverCommunityType(type);
  }

  return { newId: copy.id as string };
}

/** Parse a community item's stored JSON, tolerating a malformed file — a removal
 *  must still succeed, so an unparseable body is recorded and treated as empty. */
function parseRemovalItem(raw: string): Record<string, unknown> {
  try { return JSON.parse(raw) as Record<string, unknown>; }
  catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'community', level: 'warn',
      message: 'Removing community item with unparseable JSON',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return {};
  }
}

/** Best-effort human-readable title for a removal audit record, across all four
 *  community item shapes (chat/debate title, oped/debate topic, inquiry question). */
function removalAuditTitle(item: Record<string, unknown>): string {
  const topic = item.topic as { final?: string; original?: string } | string | undefined;
  const question = (item.request as { question?: unknown } | undefined)?.question;
  return (item.title as string)
    || (typeof topic === 'object' ? (topic.final || topic.original) : topic)
    || (typeof topic === 'string' ? topic : undefined)
    || (typeof question === 'string' ? question : undefined)
    || 'Untitled';
}

/** t/3650: singular audit-type label per plural community type — exhaustive, same guard as
 *  communityDirAndPrefix (used to be a ternary chain whose implicit else defaulted to 'oped'). */
function communityAuditType(type: CommunityType): 'chat' | 'debate' | 'oped' | 'inquiry' {
  switch (type) {
    case 'chats': return 'chat';
    case 'debates': return 'debate';
    case 'opeds': return 'oped';
    case 'inquiries': return 'inquiry';
    default: return assertNeverCommunityType(type);
  }
}

/** Build the audit record captured before a community item is hard-deleted (t/748). */
function buildRemovalAudit(
  id: string,
  type: CommunityType,
  item: Record<string, unknown>,
  removedBy: string,
  reason?: string,
): Record<string, unknown> {
  const meta = (item.community_metadata && typeof item.community_metadata === 'object')
    ? item.community_metadata as Record<string, unknown> : {};
  const auditType = communityAuditType(type);
  return {
    id,
    type: auditType,
    title: removalAuditTitle(item),
    submitted_by: (meta.submitted_by_display as string) ?? null,
    removed_by: removedBy,
    removed_at: new Date().toISOString(),
    reason: reason ?? null,
  };
}

/** Drop the cached listing index so a removed item disappears immediately;
 *  best-effort (the count-staleness check self-heals it on the next list). */
async function invalidateListingIndex(backend: StorageBackend, dir: string): Promise<void> {
  try {
    await backend.deleteFile(path.join(dir, COMMUNITY_INDEX_FILE));
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'community', level: 'warn',
      message: 'Failed to clear community listing index after removal (self-heals on next list)',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
  }
}

/**
 * Admin hard-delete of a published community item (t/748). Captures an audit
 * record (community/_removals/rem-{uuid}.json), removes the published file, and
 * clears the cached listing index so the item disappears promptly (the count
 * staleness check would also self-heal it on the next list). The route is the
 * admin gate; callers must already be authorized.
 */
export async function removeCommunityItem(
  type: CommunityType,
  id: string,
  reason?: string,
): Promise<void> {
  assertSafeId(id, 'community id'); // block path traversal
  const backend = getUserContentBackend();
  const { dir, prefix } = communityDirAndPrefix(type);
  const filePath = path.join(dir, `${prefix}${id}.json`);

  const raw = await backend.readFile(filePath);
  if (raw === null) throw Object.assign(new Error('Community item not found'), { statusCode: 404 });

  // Capture metadata for the audit record before deleting. Tolerate a malformed
  // file — removal must still succeed.
  const item = parseRemovalItem(raw);
  const removedBy = getStorageUserId();

  // Hard delete the published file, then write the audit record (so the trail
  // reflects a completed removal), then invalidate the cached listing index.
  await backend.deleteFile(filePath);

  await backend.writeFile(
    path.join(removalsDir(), `rem-${crypto.randomUUID()}.json`),
    JSON.stringify(buildRemovalAudit(id, type, item, removedBy, reason), null, 2),
  );

  // Invalidate the listing index so the removed item drops out immediately.
  await invalidateListingIndex(backend, dir);

  log.server.info({ id, type, removedBy }, 'Community item removed');
}
