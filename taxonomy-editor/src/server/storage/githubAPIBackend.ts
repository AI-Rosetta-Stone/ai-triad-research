// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * GitHubAPIBackend — GitHub REST API implementation of StorageBackend.
 *
 * Used in Azure container deployment (STORAGE_MODE=github-api). Reads/writes
 * data via GitHub Contents/Blobs/Trees APIs with a local file cache on SSD.
 *
 * Architecture:
 *   - Session context: reads/writes resolve to correct git ref (main vs session branch)
 *   - Two-layer cache: shared main cache + per-user session overlays
 *   - Write-through: cache updated only after 2xx from GitHub
 *   - Retry: 3x exponential backoff + jitter, Retry-After, 401→refresh+retry
 *   - Circuit breaker: adaptive half-open probing (30s→1m→2m→5m cap)
 *   - Flight recorder: 18+ event types for full observability
 *   - SIGUSR2: emergency dump bypasses blocked event loop
 */

import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import type { StorageBackend, WriteIfAbsentResult } from './storageBackend.js';
import { getCredentials, getRepoSlug, type SyncCredentials } from '../security/githubAppAuth.js';
import { ActionableError } from '../../../../lib/debate/errors.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import type { FlightRecorder, RecordInput } from '../../../../lib/flight-recorder/index.js';
import { getCurrentUserId, getSessionBranchName } from '../security/userContext.js';
import { GitHubRestClient, normalizeErrorForEvent, type CircuitState, type ApiResult } from './githubRestClient.js';
import { getDataRoot } from '../config.js';
import { gitBlobSha } from './gitBlobSha.js';
import { writeFramedNdjson, log } from '../logger.js';
import { BlobLease } from './blobLease.js';
import { SharedOverlayStore, type SharedOverlayEntry, type SharedOverlayEntryWithEtag, type SharedOverlayStageExpect } from './sharedOverlayStore.js';
import { BlobServiceClient, type ContainerClient, type BlockBlobClient, RestError } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';

// ── Types ────────────────────────────────────────────────────────────────

export interface SessionContext {
  userId: string;
  branchName?: string;  // null = no session branch, read from main
}

export interface TreeEntry {
  path: string;
  mode: string;
  type: 'blob' | 'tree';
  sha: string;
  size?: number;
}

export interface FileChange {
  path: string;
  content: string;
}

export interface CompareResult {
  ahead_by: number;
  behind_by: number;
  status: 'ahead' | 'behind' | 'diverged' | 'identical';
  files: Array<{ filename: string; status: string; patch?: string }>;
  total_commits: number;
  /** SHA of the merge-base commit of base and head (GitHub `merge_base_commit`).
   *  null when unavailable (no creds / API error). Used for three-way diffs. */
  merge_base_sha: string | null;
}

interface CacheManifest {
  version: 1;
  generation: number;
  lastCommitSha: string;
  lastUpdated: string;
  files: Record<string, { sha: string; etag: string; cachedAt: string }>;
}

export interface GitHubAPIBackendConfig {
  cacheDir: string;
  recorder?: FlightRecorder;
  pollIntervalMs?: number;
  coherencyProbeRate?: number;   // 0.0–1.0, default 0.01
  maxOverlayBytesPerUser?: number; // per-user uncommitted-overlay cap (t/727)
  /** t/4179 (TL design, t/4179#2/#7): cross-replica single-holder poll
   *  coordination via `blobLease.ts`. Omitted, or `maxReplicas <= 1`, keeps
   *  today's behavior unchanged — every replica polls GitHub directly. */
  pollLease?: {
    accountUrl: string;
    container?: string; // default 'poll-coordination'
    maxReplicas: number;
    serviceClient?: BlobServiceClient; // test seam (Azurite)
  };
  /** t/4311 follow-up (read-path + write-through): a `SharedOverlayStore`
   *  for cross-replica overlay read visibility. Omitted → today's
   *  local-map-only behavior, unchanged. Even when supplied, the actual
   *  effect is also gated by `OVERLAY_SHARED_STATE_ENABLED` (env) AND
   *  `OVERLAY_SHARED_STATE_COMMIT_READY` (hardcoded `false` until the
   *  commit-path follow-up PR ships, t/4311#30 R2) — `forceActiveForTesting`
   *  bypasses that second gate for tests exercising this PR's wiring before
   *  the real flag can ever flip; never set outside tests. */
  sharedOverlayState?: {
    store: SharedOverlayStore;
    forceActiveForTesting?: boolean;
    /** t/549 (t/503 PR 1, interface only; used from t/550): the per-user commit lease, in the same
     *  container as the store (one grant scope, t/503#5 ruling 4). `maxHoldMs` caps how long one
     *  commit may keep renewing, so a hung GitHub call lets the lease lapse instead of starving the
     *  user under 'busy' (SO t/503#8 condition 3). */
    commitLock?: {
      accountUrl: string;
      container: string;
      leaseSeconds?: number; // default 60 (the Azure maximum)
      renewEveryMs?: number; // default 20_000
      maxHoldMs?: number; // default 300_000
      serviceClient?: BlobServiceClient; // test seam (Azurite)
    };
  };
}

/** Published to the poll-coordination blob by the current holder. */
interface PollState {
  holderId: string;
  generation: number;
  lastCommitSha: string;
  /** Capped-length history of per-generation changed paths, oldest first —
   *  lets a non-holder catch up without replaying every tick, and lets it
   *  detect a gap (its last-seen generation predates the oldest entry here). */
  changedSinceGeneration: Array<{ generation: number; paths: string[] | null }>; // t/547: null = unknown, invalidate all
  publishedAt: string; // ISO timestamp — staleness detection
}

async function streamToStringForPoll(readable: NodeJS.ReadableStream | undefined): Promise<string> {
  if (!readable) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array | string));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function isBlobNotFoundForPoll(err: unknown): boolean {
  return err instanceof RestError ? (err.statusCode === 404 || err.code === 'BlobNotFound') : false;
}

// ── Constants ────────────────────────────────────────────────────────────

// t/727: cap uncommitted session-overlay memory per user (taxonomy POV files are
// 1–2 MB each; many concurrent editors could otherwise exhaust memory).
const DEFAULT_MAX_OVERLAY_BYTES_PER_USER = 20 * 1024 * 1024; // 20 MB

const POLL_INTERVAL_MS = 60_000;

/** t/505: the ref callers pass to mean "the shared base data, not a session branch". It is the literal
 *  'main' for historical reasons: callers across the server pin reads with `{ ref: 'main' }`. It is NOT
 *  a branch name. The backend maps it to its base branch (GITHUB_BRANCH, default 'main'), so on a
 *  deployment whose base branch is something else (staging) a pinned read reads that branch. Before
 *  this mapping such a read went to the repository's default branch, a different branch from the tree,
 *  the listings and the strict reads. */
export const BASE_BRANCH_REF = 'main';
const ERROR_BUFFER_CAPACITY = 100;

// t/4179 (TL R1/R2/R3): single-holder poll coordination constants.
const POLL_STATE_BLOB = 'poll-state.json';
const POLL_STATE_HISTORY_CAP = 50;
// t/547: GitHub's compare API lists at most 300 files; a list that long may have been cut.
const COMPARE_FILES_CAP = 300;
// A non-holder falls back to direct polling once the published state is
// older than this multiple of the poll interval — fails toward coherence,
// never toward silent staleness (TL t/4179#2 §2 point 2).
const POLL_STATE_STALE_FACTOR = 3;

// t/4215: bounds how long a plain session-branch read can serve stale
// content after a head move the server didn't make (a resync conflict
// resolved on GitHub, another replica) before re-checking the live ref.
const SESSION_READ_CACHE_REVALIDATE_MS = 30_000;

const MANIFEST_FILE = 'manifest.json';

// t/4311 follow-up (read-path + write-through). Raw env flag — never
// consulted directly; see OVERLAY_SHARED_STATE_COMMIT_READY below.
const OVERLAY_SHARED_STATE_ENABLED = process.env.OVERLAY_SHARED_STATE_ENABLED === '1';

// Hardcoded false until the commit-path follow-up PR (t/4311#30 R2) wires
// unstage(ifMatch) into commit/discard/revert. Without that, nothing ever
// clears a shared entry, so turning reads+writes on now would let
// discarded or already-committed content keep serving as "staged" to
// other replicas forever. Flips to true in that later PR, never by env var.
const OVERLAY_SHARED_STATE_COMMIT_READY = false;

/** t/549 (SO t/503#10): a reader re-lists a user's shared overlay entries at least this often even when
 *  `_gen` has not moved, because a stage whose `_gen` bump failed is still acknowledged. */
export const SHARED_OVERLAY_RELIST_MS = 10_000;

/** t/550: attempts for one shared save whose conditional upload keeps losing to concurrent saves, before a 503. */
const SHARED_SAVE_MAX_ATTEMPTS = 5;

/** t/550: what a shared save checks before staging (the caller table on t/503#15). */
type SharedSaveMode = { kind: 'precondition'; baseSha: string } | { kind: 'ifAbsent' } | { kind: 'latestWins' };

/** t/4499: bounded concurrency for readFilesBatch's GraphQL chunks — same
 *  shape as nodeSourceIndex.ts's mapWithConcurrencyLimit, duplicated rather
 *  than shared since it's an 8-line generic and the two call sites (summary
 *  reads, GraphQL chunks) have no other coupling. */
async function mapWithLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** t/4584/t/4586: the reason taxonomy for every `null` `fetchFileFromGitHub`/
 *  `readFileFromMainCache` return — logged unconditionally (a WARN, not just
 *  in `strict` mode) so a dashboard/alert can see every one of these, not
 *  only the ones a `readFileStrict` caller happens to care about. */
type NullReadReason = 'not_found' | 'rate_limited' | 'circuit_open' | 'no_creds' | `status=${number}`;

/** t/4585: the three-way result of a main-pinned raw.githubusercontent.com
 *  attempt. `fallback` means "don't trust this as an answer, fall through
 *  to the existing REST Contents-API path" — covers a genuine raw outage
 *  (429/5xx/network/timeout) AND a raw 404 for a path the tree says exists
 *  (TL condition 1: the exact t/4584 failure class — a read failure must
 *  never silently collapse to "absent"). Only a 404 for a path NOT in the
 *  tree is `not_found` — unless the manifest itself is stale (t/4615, TL
 *  edge case on t/4585#6): a file added to main after the manifest's
 *  `lastCommitSha` is "not in tree" by construction until the next poll,
 *  so a stale manifest can't vouch for a path's absence either. `disabled`
 *  is the rawDisabled early-return's own reason (t/4615 — previously
 *  reused `status=503`, conflating with genuine 503 fallbacks in the
 *  stats). */
type RawFallbackReason = 'raw_404_but_in_tree' | 'raw_404_manifest_stale' | 'status=429' | `status=${number}` | 'network_error' | 'disabled' | 'invalid_path' | 'private_repo';

/** t/372 (CodeQL #6229, #6230): join a repo-relative path under `base` and refuse, before any
 *  write, anything that resolves outside `base`. toRepoPath's `..` check does not reach these
 *  call sites in CodeQL's model, so the cache writes confine their own path. */
async function confineToDir(base: string, rel: string): Promise<string> {
  const root = path.resolve(base);
  const abs = path.resolve(root, rel);
  if (!(isWithinDir(abs, root) && await realpathWithin(abs, root))) {
    throw new ActionableError({
      goal: 'Confine disk cache access to the cache directory',
      problem: `Path escapes the cache directory: ${rel}`,
      location: 'githubAPIBackend.confineToDir',
      nextSteps: ['Use a repo-relative path with no ".." segments, and no symlink inside the cache directory'],
      code: 'PATH_OUTSIDE_ROOT',
      httpStatus: 400,
    });
  }
  // Return the join, not the resolved absolute path: the read side builds keys with path.join,
  // so an in-cache write must keep the same string.
  return path.join(base, rel);
}

/** Lexical containment of `abs` in `root` (case-insensitive on win32). */
function isWithinDir(abs: string, root: string): boolean {
  const a = process.platform === 'win32' ? abs.toLowerCase() : abs;
  const r = process.platform === 'win32' ? root.toLowerCase() : root;
  return a === r || a.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

/** t/432: a symlink or junction already inside the cache directory must not lead out. Resolve the
 *  deepest existing ancestor of `abs` and require it to stay inside the real root. Fails closed on any
 *  error other than "does not exist yet" (containment cannot be proven). A missing root has no symlinks. */
async function realpathWithin(abs: string, root: string): Promise<boolean> {
  let realRoot: string;
  try {
    realRoot = await fs.realpath(root);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true; // telemetry — a missing root has no symlinks
    log.storage.warn({ root, err: String(err) }, 'confineToDir: cannot resolve the cache root; refusing the write (t/432)');
    return false;
  }
  let probe = abs;
  for (;;) {
    try {
      return isWithinDir(await fs.realpath(probe), realRoot);
    } catch (err: unknown) {
      const parent = path.dirname(probe);
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || parent === probe) {
        log.storage.warn({ probe, err: String(err) }, 'confineToDir: cannot verify containment; refusing (t/432)');
        return false;
      }
      // A dangling link is an entry that exists but whose target does not: realpath fails with ENOENT,
      // and a write through it would create the target outside the cache. Refuse it.
      try {
        await fs.lstat(probe);
        log.storage.warn({ probe }, 'confineToDir: dangling link in the cache directory; refusing (t/432)');
        return false;
      } catch (lerr: unknown) {
        if ((lerr as NodeJS.ErrnoException).code !== 'ENOENT') {
          log.storage.warn({ probe, err: String(lerr) }, 'confineToDir: cannot inspect a cache entry; refusing (t/432)');
          return false;
        }
        // telemetry — the entry does not exist at all: an ordinary not-yet-created path
      }
      probe = parent; // telemetry — a not-yet-created ancestor is the normal case
    }
  }
}

/** t/268: why a directory listing returned [] without a genuine answer. */
export type DirListingDegradation = 'non-holder-tree-empty' | 'circuit-breaker-open' | 'api-unavailable' | 'no-credentials';

type RawFetchResult =
  | { kind: 'hit'; content: string; sha: string }
  | { kind: 'not_found' }
  | { kind: 'fallback'; reason: RawFallbackReason };

// ── GitHubAPIBackend ─────────────────────────────────────────────────────

export class GitHubAPIBackend implements StorageBackend {
  readonly backendName = 'github-api';

  private readonly cacheDir: string;
  private readonly recorder: FlightRecorder | null;
  private readonly pollIntervalMs: number;
  private readonly coherencyProbeRate: number;

  // Base branch for this deployment — read from GITHUB_BRANCH env var.
  // Default 'main' keeps prod/local/Electron unchanged when unset.
  private readonly baseBranch: string = process.env.GITHUB_BRANCH ?? 'main';

  // Session context — legacy instance field used only by tests that call
  // setSessionContext() directly. Production reads from AsyncLocalStorage
  // (see userContext.ts). getEffectiveRef/getUserId check ALS first.
  private sessionContext: SessionContext | null = null;

  // In-memory repo tree (path→TreeEntry)
  private repoTree: Map<string, TreeEntry> = new Map();
  private treeSha: string | null = null;

  // Cache manifest
  private manifest: CacheManifest | null = null;

  // Per-user session overlays: userId → (repoPath → content)
  // Tombstone sentinel: overlay entry with this value means "delete this file"
  static readonly TOMBSTONE = '\0__DELETED__\0';
  private sessionOverlays: Map<string, Map<string, string>> = new Map();
  private maxOverlayBytesPerUser: number = DEFAULT_MAX_OVERLAY_BYTES_PER_USER;

  // t/4311 follow-up (read-path + write-through). `sharedOverlayStateActive`
  // is the single effective gate every new code path checks — never the raw
  // env flag directly (see OVERLAY_SHARED_STATE_COMMIT_READY's doc comment).
  // `sharedOverlayReadCache`: userId → the last-synced {gen, entries} this
  // replica has observed from the shared store — the authoritative source
  // for a read once synced (t/4311#30 R1), refreshed whenever `_gen` moves.
  private readonly sharedOverlayStore: SharedOverlayStore | null = null;
  private readonly sharedOverlayStateActive: boolean = false;
  /** t/550: the per-user commit lease settings (sharedOverlayState.commitLock), or null when not configured. */
  private readonly sharedCommitLock: NonNullable<NonNullable<GitHubAPIBackendConfig['sharedOverlayState']>['commitLock']> | null = null;
  // t/549: `listedAt` is when the entries were last listed from the store (0 = never); see SHARED_OVERLAY_RELIST_MS.
  private sharedOverlayReadCache: Map<string, { gen: string | null; entries: Map<string, SharedOverlayEntry>; listedAt: number }> = new Map();
  /** t/550: per (user, path) chain so this replica runs one shared save at a time for a path (SO condition 2). */
  private readonly sharedSaveLocks = new Map<string, Promise<void>>();

  // t/4312: per-path base blob sha, recorded once when a path first enters a
  // clean overlay slot (never reset by a later same-path rewrite — see
  // recordOverlayBaseShaOnce). null = file was absent when staged; 'unknown' =
  // the live lookup failed, which fails CLOSED (always treated as a conflict)
  // rather than silently trusting an unverifiable base.
  private sessionOverlayBaseShas: Map<string, Map<string, string | null | 'unknown'>> = new Map();

  // t/4312 (SO F1): the most recently detected conflicted paths per user —
  // persists across scheduler retries so "Use theirs"/"Keep mine" (below)
  // can resolve "all of them" without the caller having to already know
  // which paths are conflicted.
  private sessionOverlayConflicts: Map<string, Set<string>> = new Map();

  // t/4258/t/4277 (C2): per-user commit serialization. A commit already
  // queued-but-not-started for a user is shared (`commitPending`); the chain
  // (`commitChain`) makes any later call wait for the current run to finish
  // before starting its own — so two PATCH /git/refs/heads/<branch> calls for
  // one user are never in flight at once, and no trigger is silently dropped.
  // @INMEMORY_CACHE_SINGLE_REPLICA (t/4181, Server Storage t/4181#9): this serialization is per-process,
  // so it does not hold across replicas. Remove once t/4311's cross-replica commit lock lands.
  private commitChain: Map<string, Promise<void>> = new Map();
  private commitPending: Map<string, {
    promise: Promise<{ commitSha: string; filesCommitted: number; conflictedPaths?: string[] } | null>;
    resolve: (result: { commitSha: string; filesCommitted: number; conflictedPaths?: string[] } | null) => void;
    reject: (err: unknown) => void;
  }> = new Map();

  // t/4215 (TL design, t/4215#2): userId → (repoPath → content) for a plain
  // readFile() on a session branch, once the overlay has no entry for that
  // path. Unlike readFileWithVersion's always-live read (t/4224), this is
  // called from read-modify-write loops over many paths — filled for free at
  // commitOverlay/mergeBranch, with the branch-head SHA tracked alongside so
  // a stale cache (an out-of-band move the server didn't make) is detected
  // within SESSION_READ_CACHE_REVALIDATE_MS, not served indefinitely.
  private sessionReadCache: Map<string, Map<string, string>> = new Map();
  private sessionReadCacheHeadSha: Map<string, { sha: string; checkedAt: number; checkedAtActivitySeq: number }> = new Map();
  // t/4215 budget addendum (TL t/4215#7): monotonic per-user write-activity
  // counter — gates the plain-read ref-check so an idle/view-only session
  // never pays it. A counter (not a wall-clock timestamp) deliberately,
  // since a write and the read checking against it can land in the same
  // Date.now() millisecond tick; a timestamp-equality comparison would then
  // wrongly read as "no activity since the last check".
  private sessionWriteActivitySeq: Map<string, number> = new Map();
  private sessionWriteActivityCounter = 0;

  // Resilient GitHub HTTP transport — rate limit + circuit breaker live here (t/1698).
  private readonly rest: GitHubRestClient;

  // Secondary error-only ring buffer (100 events)
  private errorBuffer: Array<RecordInput & { _wall: number }> = [];

  // Polling timer
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  // t/4179: single-holder poll coordination (undefined/null → today's
  // unchanged every-replica-polls-directly behavior).
  private readonly pollLeaseContainer: string | undefined;
  private readonly blobLease: BlobLease | null = null;
  private readonly blobLeaseContainerClient: ContainerClient | null = null;
  private readonly pollLeaseDurationSeconds: number = 0;
  private leaseRenewTimer: ReturnType<typeof setInterval> | null = null;
  /** t/547: per tenure, not per process: a new id each time this replica acquires the lease, since its
   *  history restarts then and another holder may have published in between. */
  private holderId = crypto.randomUUID();
  private pollStateGeneration = 0;
  private pollStateHistory: PollState['changedSinceGeneration'] = [];
  private pollLastSeenGeneration = 0;
  private pollLastSeenHolderId: string | null = null;
  /** t/547: the commit this non-holder's manifest was brought to by its last applied poll state. */
  private pollLastSeenCommitSha = '';
  private repoTreeRefillInFlight: Promise<void> | null = null;

  // Coherency probe stats
  private coherencyViolations = 0;

  // t/4298/t/4299/t/4300: counts main-cache misses this process has paid
  // GitHub for since boot — never reset, so it reads as "since cold start".
  private coldCacheMissCount = 0;

  // t/4585: raw.githubusercontent.com cold-boot cache warm. Counts every
  // raw-fetch-falls-back-to-REST event since boot, split by reason so
  // staging measurement can tell whether raw is throttling (429) versus
  // something else (network, 5xx, a tree-present path that 404'd).
  private rawFallbackCounts: Record<string, number> = {};
  // t/4585 TL condition 1: a disable switch, never re-enabled this process's
  // lifetime once tripped — avoids paying a raw miss on every single read
  // if raw starts misbehaving broadly (repo turns private, CDN outage).
  private rawDisabled = false;
  // t/497: the data repo's visibility, from GET /repos/{repo}. null = not known (never read, or the last
  // read failed), which means "try raw as today". Anything other than an explicit 'public' skips raw:
  // the raw fetch is unauthenticated by design, so a private repo answers 404 to every request.
  private repoVisibility: { isPublic: boolean; visibility: string; checkedAt: number } | null = null;
  private repoVisibilityInFlight: Promise<void> | null = null;
  private repoVisibilityLastAttemptAt = 0;
  private rawSkipLogged = false;
  private static readonly REPO_VISIBILITY_TTL_MS = 60 * 60_000;
  private static readonly REPO_VISIBILITY_MIN_RECHECK_MS = 60_000;
  private rawFallbackWindowStart = 0;
  private rawFallbackWindowCount = 0;
  private static readonly RAW_FALLBACK_DISABLE_THRESHOLD_PER_MINUTE = 20;
  // t/4585 TL condition 3: bounds raw's own concurrency so a cold boot's
  // ~1,000 near-simultaneous reads don't fire that many unauthenticated
  // requests at once and trip raw.githubusercontent.com's undocumented
  // per-IP limits (staging and prod share egress characteristics).
  private rawInFlight = 0;
  private rawWaiters: Array<() => void> = [];
  private static readonly RAW_CONCURRENCY_LIMIT = 8;

  // Manifest write mutex — serializes all manifest mutations to prevent
  // concurrent read-modify-write races (see t/479). Without this, parallel
  // readFile() cache misses each call writeToDiskCache() → saveManifest()
  // concurrently, corrupting the shared .tmp file and losing entries.
  private manifestLock: Promise<void> = Promise.resolve();

  // Cached credentials
  private cachedCreds: SyncCredentials | null = null;
  private credsExpiresAt = 0;

  // Data-load state — exposed via getDataLoadStatus() for /healthz (t/2053, t/2059)
  private _dataLoadStatus: 'loading' | 'ready' | 'failed' = 'loading';
  private _dataLoadError: string | null = null;
  // t/482: why the load failed, and when. 'known' is a classified failed load (GitHub unreachable, a
  // zero-blob or wrong-shaped tree): a later poll may recover it. 'unknown' is a throw (t/480): it never
  // recovers without a restart, because the state is unknown and no polling runs.
  private _dataLoadFailure: 'known' | 'unknown' | null = null;
  private _dataLoadFailedAt: number | null = null;
  private recoveryInFlight = false;

  constructor(config: GitHubAPIBackendConfig) {
    this.cacheDir = config.cacheDir;
    this.recorder = config.recorder ?? null;
    this.pollIntervalMs = config.pollIntervalMs ?? POLL_INTERVAL_MS;
    this.coherencyProbeRate = config.coherencyProbeRate ?? 0.01;
    this.maxOverlayBytesPerUser = config.maxOverlayBytesPerUser
      ?? (process.env.OVERLAY_MAX_BYTES_PER_USER ? parseInt(process.env.OVERLAY_MAX_BYTES_PER_USER, 10) : DEFAULT_MAX_OVERLAY_BYTES_PER_USER);

    if (config.pollLease && config.pollLease.maxReplicas > 1) {
      this.pollLeaseContainer = config.pollLease.container ?? 'poll-coordination';
      // Azure Blob leases must be 15-60s; match the poll interval so a
      // renewal cadence of duration/3 (R1) stays sane at both ends.
      this.pollLeaseDurationSeconds = Math.min(60, Math.max(15, Math.round(this.pollIntervalMs / 1000)));
      this.blobLease = new BlobLease({
        accountUrl: config.pollLease.accountUrl,
        container: this.pollLeaseContainer,
        blobName: POLL_STATE_BLOB,
        durationSeconds: this.pollLeaseDurationSeconds,
        serviceClient: config.pollLease.serviceClient,
      });
      const pollService = config.pollLease.serviceClient
        ?? new BlobServiceClient(config.pollLease.accountUrl, new DefaultAzureCredential());
      this.blobLeaseContainerClient = pollService.getContainerClient(this.pollLeaseContainer);
    }

    this.rest = new GitHubRestClient({
      record: (input) => this.recordEvent(input),
      getEtag: (pathAndQuery) => this.getCachedEtag(pathAndQuery),
      refreshCreds: async () => {
        this.cachedCreds = null;
        this.credsExpiresAt = 0;
        return this.getCredsCached();
      },
    });

    const sharedOverlay = GitHubAPIBackend.resolveSharedOverlayState(config);
    this.sharedOverlayStore = sharedOverlay.store;
    this.sharedOverlayStateActive = sharedOverlay.active;
    this.sharedCommitLock = config.sharedOverlayState?.commitLock ?? null;
    if (sharedOverlay.warnInert) {
      log.storage.warn(
        'OVERLAY_SHARED_STATE_ENABLED=1 is set, but OVERLAY_SHARED_STATE_COMMIT_READY is false — '
        + 'shared overlay state is inert until the commit-path follow-up PR ships (t/4311). Local overlay only.',
      );
    }

    this.registerSigHandler();
  }

  /** Extracted from the constructor to keep its complexity under budget
   *  (t/4311 follow-up). Pure function of `config` — no `this` access, so
   *  it can run before `this.sharedOverlayStore`/`sharedOverlayStateActive`
   *  (both `readonly`) are assigned in the constructor body itself. */
  private static resolveSharedOverlayState(config: GitHubAPIBackendConfig): { store: SharedOverlayStore | null; active: boolean; warnInert: boolean } {
    if (!config.sharedOverlayState) return { store: null, active: false, warnInert: false };
    const active = config.sharedOverlayState.forceActiveForTesting
      ?? (OVERLAY_SHARED_STATE_ENABLED && OVERLAY_SHARED_STATE_COMMIT_READY);
    const warnInert = OVERLAY_SHARED_STATE_ENABLED && !OVERLAY_SHARED_STATE_COMMIT_READY && !config.sharedOverlayState.forceActiveForTesting;
    return { store: config.sharedOverlayState.store, active, warnInert };
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /** t/480 (Second Opinion t/470#4, TL t/470#5): an unknown throw during start-up is recorded as a
   *  failed load with its real cause, then re-thrown. Rejecting alone was the quiet option: server.ts
   *  catches the rejection and the process keeps running, while the status stayed 'loading', which
   *  readiness shows as a warm-up and then as a timeout with no cause. The public reason names the error
   *  (name and code); the message stays in the log. Never 'ready' on this path, and
   *  no polling: the state is unknown. The event is system.error, not github.api.error, so a code bug
   *  is not counted as a GitHub outage by the alert. */
  async initialize(): Promise<void> {
    try {
      await this.runInitialize();
    } catch (err: unknown) {
      const name = (err as Error)?.name ?? 'Error';
      const message = (err as Error)?.message ?? String(err);
      this._dataLoadStatus = 'failed';
      this._dataLoadFailure = 'unknown';
      this._dataLoadFailedAt = Date.now();
      // The load error is returned by /readyz, which is anonymous. It carries the error's name and code
      // only: a message can hold a server path (an fs error does). The message and stack go to the log
      // and the recorder below.
      const code = typeof (err as NodeJS.ErrnoException)?.code === 'string' ? ` (${(err as NodeJS.ErrnoException).code})` : '';
      this._dataLoadError = `GitHubAPIBackend.initialize threw ${name}${code}; see the server log for storage.init.error`;
      this.stopPollingTimers();
      this.recordEvent({
        type: 'system.error',
        component: 'storage',
        level: 'error',
        message: 'storage.init.error: GitHubAPIBackend.initialize threw; data load recorded as failed, polling not started',
        error: normalizeErrorForEvent(err),
      });
      log.storage.error({ errName: name, errMessage: message, stack: (err as Error)?.stack },
        'storage.init.error: GitHubAPIBackend.initialize threw; data load recorded as failed, polling not started (t/480)');
      throw err;
    }
  }

  /** The full load from the head commit, for a start that is not a cache hit and for recovery (t/482).
   *  t/463: decide the re-seed first, apply it only after the tree loads. A failed load (fetchRepoTree
   *  false: GitHub unreachable, zero blobs, a wrong-shaped response) leaves the manifest exactly as it
   *  was, in memory and on disk, and returns false. Never reports success on less than the full tree. */
  private async loadFromHead(mainSha: string): Promise<boolean> {
    const cachedSha = this.manifest?.lastCommitSha ?? '';
    const reseed = !!cachedSha && !!mainSha && !(await this.isCommitInHistory(cachedSha));
    const loaded = await this.fetchRepoTree(mainSha);
    if (!loaded) return false;

    if (reseed) this.reseedManifestInMemory();
    // A failed invalidation or manifest write must not undo a loaded tree (t/463).
    if (this.manifest?.lastCommitSha) {
      try {
        await this.invalidateChangedFiles(this.manifest.lastCommitSha, mainSha);
      } catch (err: unknown) {
        log.storage.warn({ err: String(err) }, 'initialize: cache invalidation could not persist; serving from memory (t/463)');
      }
    }
    try {
      await this.updateManifestSha(mainSha);
    } catch (err: unknown) {
      log.storage.warn({ err: String(err) }, 'initialize: manifest could not be persisted; serving from memory (t/463)');
    }
    return true;
  }

  /** t/482: one attempt to recover a replica whose initial load failed for a known reason. It runs the
   *  same load a clean start runs. Success sets ready and logs how long the replica was failed. Anything
   *  less leaves it failed, to try again on the next poll tick. The in-flight flag keeps a load that
   *  outlasts the poll interval from overlapping a second one. */
  private async attemptLoadRecovery(): Promise<void> {
    if (this.recoveryInFlight) return;
    this.recoveryInFlight = true;
    try {
      const mainSha = await this.getLatestCommitSha();
      if (!mainSha || !(await this.loadFromHead(mainSha))) {
        log.storage.debug({ sha: mainSha }, 'storage.init.recovery: load still failing; will retry on the next poll (t/482)');
        return;
      }
      // Only a known failure that is still current may become ready (shutdown or a later throw wins).
      if (this._dataLoadStatus !== 'failed' || this._dataLoadFailure !== 'known') return;
      const failedForMs = this._dataLoadFailedAt === null ? null : Date.now() - this._dataLoadFailedAt;
      this._dataLoadStatus = 'ready';
      this._dataLoadError = null;
      this._dataLoadFailure = null;
      this._dataLoadFailedAt = null;
      this.recordEvent({
        type: 'storage.mode',
        component: 'storage',
        level: 'info',
        message: 'storage.init.recovered: data load succeeded on a poll after a failed start',
        data: { sha: mainSha, failedForMs, treeSize: this.repoTree.size },
      });
      log.storage.warn({ sha: mainSha, failedForMs, treeSize: this.repoTree.size },
        'storage.init.recovered: data load succeeded on a poll after a failed start; the replica is ready (t/482)');
    } catch (err: unknown) {
      log.storage.warn({ errName: (err as Error)?.name ?? 'Error', errMessage: (err as Error)?.message ?? String(err) },
        'storage.init.recovery: attempt threw; the replica stays failed and will retry on the next poll (t/482)');
    } finally {
      this.recoveryInFlight = false;
    }
  }

  /** Clear the poll and lease timers if a failed start-up got as far as creating them. */
  private stopPollingTimers(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.leaseRenewTimer) { clearInterval(this.leaseRenewTimer); this.leaseRenewTimer = null; }
  }

  /** t/505: map the base-branch alias to this deployment's base branch. Any other ref (a real session
   *  branch, a commit SHA) passes through unchanged, and undefined stays undefined so the caller's
   *  own default applies. */
  private resolveReadRef(ref: string | undefined): string | undefined {
    return ref === BASE_BRANCH_REF ? this.baseBranch : ref;
  }

  private async runInitialize(): Promise<void> {
    if (this.baseBranch !== BASE_BRANCH_REF) {
      // t/505: say once, at start-up, that pinned reads do not go to a branch called 'main' here.
      log.storage.info({ baseBranch: this.baseBranch },
        `base branch is '${this.baseBranch}': reads pinned with ref '${BASE_BRANCH_REF}' are mapped to it (t/505)`);
    }
    this.recordEvent({
      type: 'storage.mode',
      component: 'storage',
      level: 'info',
      message: 'GitHubAPIBackend initializing',
      data: { mode: 'github-api', cacheDir: this.cacheDir },
    });

    await fs.mkdir(this.cacheDir, { recursive: true });
    await this.loadManifest();

    const creds = await this.getCredsCached();
    if (!creds) {
      this.recordEvent({
        type: 'storage.fallback',
        component: 'storage',
        level: 'warn',
        message: 'No GitHub credentials available — running in fallback mode',
      });
      // t/4258/t/4281: AGENTS.md mandates a console WARN on every fallback path;
      // recordEvent() alone never reached one. Also feeds alert-fallback-active.
      log.github.warn({}, 'storage.fallback: no GitHub credentials available — running in fallback mode');
      return;
    }

    // t/497: one call per start; the answer is refreshed on a TTL and after an in-tree raw 404.
    await this.refreshRepoVisibility('startup');

    const mainSha = await this.getLatestCommitSha();
    if (this.manifest && this.manifest.lastCommitSha === mainSha) {
      const treeSource = await this.loadTreeOnCacheHit(mainSha);
      this.recordEvent({
        type: 'cache.hit',
        component: 'cache',
        level: 'info',
        message: 'Cache manifest matches main HEAD — serving from cache',
        data: { sha: mainSha, fileCount: Object.keys(this.manifest.files).length, treeSource, treeSize: this.repoTree.size },
      });
      this._dataLoadStatus = 'ready';
    } else {
      // t/482: the load itself is loadFromHead, shared with the recovery step in pollTick, so a recovered
      // replica has passed exactly the checks a clean start passes.
      if (await this.loadFromHead(mainSha)) {
        this._dataLoadStatus = 'ready';
      } else {
        this._dataLoadStatus = 'failed';
        this._dataLoadFailure = 'known';
        this._dataLoadFailedAt = Date.now();
        this._dataLoadError = 'GitHub API data load failed during initialization — check credentials and network';
        this.recordEvent({
          type: 'github.api.error',
          component: 'github-api',
          level: 'error',
          message: 'initialize: data load failed — /healthz will report 503 until recovery',
          data: { sha: mainSha },
        });
        // t/4258/t/4281: recordEvent() alone is console-invisible (FlightRecorder-only);
        // alert-github-api-error-spike (main.bicep) needs "github.api.error" in
        // ContainerAppConsoleLogs_CL to count this as a GitHub-outage/auth-failure signal.
        log.github.error({ sha: mainSha }, 'github.api.error: initialize data load failed — /healthz will report 503 until recovery');
      }
    }

    this.startPolling();
  }

  shutdown(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.leaseRenewTimer) {
      clearInterval(this.leaseRenewTimer);
      this.leaseRenewTimer = null;
    }
    // t/4258/t/4302: this runs BEFORE server.ts's SIGTERM flush
    // (flushOverlaysWithDeadline) even starts, so a non-empty overlay here
    // isn't data loss yet — it's about to be flushed. INFO, not WARN;
    // shutdownOverlayFlush.ts's own post-flush WARN (t/4276) is the one that
    // correctly reports what's still uncommitted after the flush actually
    // ran. Best-effort — logging must never be able to break shutdown itself.
    try {
      this.logUncommittedOverlay(this.uncommittedOverlaySummary(), 'info');
    } catch { /* telemetry — silent by design; never let logging break shutdown */ }
    // Best-effort — so a graceful shutdown hands the lease off immediately
    // rather than making the next holder wait out the full lease duration.
    if (this.blobLease) void this.blobLease.release();
  }

  /**
   * t/4258/t/4276: public access to the uncommitted-overlay summary, for the
   * SIGTERM flush (ServerAPI, p/541#75) to sweep actual overlay contents
   * directly instead of the fileIO.ts scheduler's own pending-commit
   * bookkeeping — and to re-check after the flush, so the deadline WARN
   * reflects what's really still uncommitted (a dirty overlay with no
   * scheduler status would otherwise produce no WARN).
   */
  getUncommittedOverlaySummary(): { userId: string; entryCount: number; paths: string[] }[] {
    return this.uncommittedOverlaySummary();
  }

  /** t/4258: pure summary of uncommitted overlay state — no content, paths capped per user. */
  private uncommittedOverlaySummary(): { userId: string; entryCount: number; paths: string[] }[] {
    const summary: { userId: string; entryCount: number; paths: string[] }[] = [];
    for (const [userId, overlay] of this.sessionOverlays) {
      if (overlay.size === 0) continue;
      summary.push({ userId, entryCount: overlay.size, paths: [...overlay.keys()].slice(0, 20) });
    }
    return summary;
  }

  /**
   * t/4258/t/4302: log + flight-record a non-empty uncommitted-overlay
   * summary. No-op when empty. `level: 'info'` is for a pre-flush notice
   * (nothing lost yet — a flush is about to run); `level: 'warn'` is for a
   * genuine loss (e.g. a failed commitOverlay with no further flush coming).
   */
  private logUncommittedOverlay(
    summary: { userId: string; entryCount: number; paths: string[] }[],
    level: 'info' | 'warn',
    context = 'shutdown',
  ): void {
    if (summary.length === 0) return;
    const totalEntries = summary.reduce((sum, s) => sum + s.entryCount, 0);
    const outcome = level === 'warn' ? '— will be lost' : '— flushing';
    const message = `${totalEntries} uncommitted overlay entries across ${summary.length} user(s) at ${context} (t/4258/t/4302) ${outcome}`;
    log.storage[level]({ context, summary }, message);
    getGlobalRecorder()?.record({
      type: level === 'warn' ? 'system.error' : 'storage.mode', component: 'storage', level, message, data: { context, summary },
    });
  }

  // ── Session context ────────────────────────────────────────────────────

  /** @deprecated Use ALS (runWithUser) in production. Retained for test compatibility. */
  setSessionContext(ctx: SessionContext | null): void {
    this.sessionContext = ctx;
  }

  /** @deprecated Use ALS (getCurrentUser) in production. Retained for test compatibility. */
  getSessionContext(): SessionContext | null {
    return this.sessionContext;
  }

  /** The base branch for this deployment (GITHUB_BRANCH env, default 'main'). */
  getBaseBranch(): string {
    return this.baseBranch;
  }

  /**
   * Resolve the effective git ref for the current request.
   * Priority: AsyncLocalStorage (production) → instance field (tests) → baseBranch.
   */
  private getEffectiveRef(): string {
    return getSessionBranchName() ?? this.sessionContext?.branchName ?? this.baseBranch;
  }

  /**
   * Resolve the effective userId for the current request.
   * Priority: AsyncLocalStorage (production) → instance field (tests) → undefined.
   */
  private getEffectiveUserId(): string | undefined {
    const alsId = getCurrentUserId();
    if (alsId !== '_local') return alsId;
    return this.sessionContext?.userId ?? (alsId === '_local' ? '_local' : undefined);
  }

  /** Whether a session context (ALS or instance field) is active. */
  private hasSessionContext(): boolean {
    return getSessionBranchName() != null || this.sessionContext != null;
  }

  // ── StorageBackend interface ───────────────────────────────────────────

  /**
   * Session-overlay lookup shared by readFile and readFileWithVersion (t/4201,
   * p/775#30) so both check the overlay with identical precedence. Returns
   * `undefined` when there's nothing to consult (base-branch read, no user, or
   * no overlay entry) — distinct from a tombstone, which is a real hit whose
   * value happens to be `GitHubAPIBackend.TOMBSTONE`.
   */
  private checkSessionOverlay(repoPath: string): string | undefined {
    const readBranch = this.getEffectiveRef();
    const readUserId = this.getEffectiveUserId();
    if (readBranch === this.baseBranch || !readUserId) return undefined;

    const overlay = this.sessionOverlays.get(readUserId);
    if (overlay?.has(repoPath)) {
      const val = overlay.get(repoPath)!;
      this.recordEvent({
        type: 'cache.hit',
        component: 'cache',
        level: 'debug',
        message: `Session overlay hit: ${repoPath}`,
        data: { path: repoPath, layer: 'session', userId: readUserId },
      });
      return val;
    }

    return undefined;
  }

  // ── Shared overlay state (t/4311 follow-up) ────────────────────────────
  //
  // `checkSessionOverlay` above stays untouched and local-only — besides
  // serving plain reads when the shared store is inactive, it's also used
  // by writeOverlayWithPrecondition's intra-request race-check (the
  // "landedWhileAwaiting" re-check right before writeToOverlay() below),
  // which exists specifically to detect another write landing in THIS
  // process's local map between an await and the eventual local write.
  // That's a same-replica, same-tick race-closing check, not a
  // cross-replica visibility question — it must never become async or it
  // reintroduces the exact race it was written to close (SO fault C1,
  // e/302#4). The methods below are for genuine user-facing reads only.

  /**
   * The authoritative overlay entries for a user, refreshed from the
   * shared store whenever `_gen` has moved since this replica's last sync
   * (t/4311#30 R1 — the shared store is authoritative once synced, not
   * "local wins on a hit"). Returns `null` on a store outage — callers
   * fall back to the local map for that one read (degrades to today's
   * pre-this-PR, single-replica-correct behavior) rather than failing it.
   */
  private async getSyncedSharedEntries(userId: string): Promise<Map<string, SharedOverlayEntry> | null> {
    if (!this.sharedOverlayStore) return null;
    const cached = this.sharedOverlayReadCache.get(userId);
    try {
      const currentGen = await this.sharedOverlayStore.getGeneration(userId);
      // t/549: an unchanged `_gen` is trusted only for SHARED_OVERLAY_RELIST_MS, the backstop for a
      // stage whose `_gen` bump failed after its entry landed (it is acknowledged, but bumps nothing).
      if (cached && cached.gen === currentGen && Date.now() - cached.listedAt < SHARED_OVERLAY_RELIST_MS) return cached.entries;
      const listed = await this.sharedOverlayStore.listEntries(userId);
      const entries = new Map(listed.map(e => [e.repoPath, e.entry]));
      this.sharedOverlayReadCache.set(userId, { gen: currentGen, entries, listedAt: Date.now() });
      return entries;
    } catch (err) {
      const message = `Shared overlay sync failed; falling back to the local overlay for this read: ${userId}`;
      this.recordEvent({
        type: 'system.error', component: 'github-api', level: 'warn',
        message,
        data: { userId },
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      log.storage.warn({ userId, error: String(err) }, message);
      return null;
    }
  }

  /**
   * One path's effective overlay value for a user-facing read — the shared
   * store's synced entry when active and synced, else the local map
   * (inactive flag, or a store outage per `getSyncedSharedEntries`).
   * Returns `GitHubAPIBackend.TOMBSTONE` for a staged delete either way, so
   * every caller keeps comparing against one sentinel regardless of source.
   *
   * PER-PATH FALLBACK, not a blanket "shared always wins": if the synced
   * shared entries have NO entry for this exact path, fall through to the
   * local map rather than returning `undefined`. Caught during
   * implementation (t/4311#29/#31's posted design didn't call this out):
   * `writeThroughSharedOverlay` is fire-and-forget, so a replica's own
   * write can be visible locally before its `_gen` bump has landed — a
   * plain "shared wins" would make a replica briefly unable to read back
   * its own just-written content. Safe in THIS PR's scope specifically
   * because nothing yet clears a shared entry (commit/discard/revert
   * wiring is the separate, not-yet-landed commit-path follow-up) — so a
   * path present locally but absent from a freshly-synced shared view can
   * only mean "this replica's own write hasn't round-tripped yet," never
   * "someone else's write was already superseded." TL's R1 scenario (write
   * X on A, write Y on B, read on A) is unaffected: the shared store DOES
   * have an entry for that path (B's Y), so the shared value still wins.
   */
  private async readEffectiveOverlayEntry(userId: string, repoPath: string): Promise<string | undefined> {
    if (this.sharedOverlayStateActive) {
      const synced = await this.getSyncedSharedEntries(userId);
      if (synced !== null) {
        const entry = synced.get(repoPath);
        if (entry !== undefined) return entry.content === null ? GitHubAPIBackend.TOMBSTONE : entry.content;
        // No shared entry for this path — fall through to local (see above).
      }
    }
    const overlay = this.sessionOverlays.get(userId);
    return overlay?.get(repoPath);
  }

  /**
   * Cross-replica-aware overlay read for readFile/readFileWithVersion —
   * same ref/user guard and cache.hit event as the old `checkSessionOverlay`
   * had, but backed by `readEffectiveOverlayEntry` so it's shared-store-aware
   * when active.
   */
  private async readOverlayForUserRead(repoPath: string): Promise<string | undefined> {
    const readBranch = this.getEffectiveRef();
    const readUserId = this.getEffectiveUserId();
    if (readBranch === this.baseBranch || !readUserId) return undefined;

    const val = await this.readEffectiveOverlayEntry(readUserId, repoPath);
    if (val !== undefined) {
      this.recordEvent({
        type: 'cache.hit',
        component: 'cache',
        level: 'debug',
        message: `Session overlay hit: ${repoPath}`,
        data: { path: repoPath, layer: 'session', userId: readUserId },
      });
    }
    return val;
  }

  /**
   * Every effective overlay path for a user, as `[repoPath, isTombstone]`
   * pairs — normalizes the shared store's `content === null` convention and
   * the local map's `TOMBSTONE` sentinel into one shape for
   * `mergeOverlayIntoListing`. Returns `null` when there's nothing staged
   * at all (no local entry, and either inactive or a synced-empty shared
   * store).
   *
   * Same per-path fallback as `readEffectiveOverlayEntry` (see its doc
   * comment): the synced shared entries win per path, and any local-only
   * path (this replica's own write still in flight to the store) fills the
   * gaps rather than being dropped.
   */
  private async listEffectiveOverlayPaths(userId: string): Promise<Array<[string, boolean]> | null> {
    const local = this.sessionOverlays.get(userId);
    if (this.sharedOverlayStateActive) {
      const synced = await this.getSyncedSharedEntries(userId);
      if (synced !== null) {
        const pairs: Array<[string, boolean]> = [...synced].map(([p, e]) => [p, e.content === null] as [string, boolean]);
        if (local) {
          for (const [p, v] of local) {
            if (!synced.has(p)) pairs.push([p, v === GitHubAPIBackend.TOMBSTONE]);
          }
        }
        return pairs.length > 0 ? pairs : null;
      }
    }
    if (!local) return null;
    return [...local].map(([p, v]) => [p, v === GitHubAPIBackend.TOMBSTONE] as [string, boolean]);
  }

  /**
   * Mirror a local overlay write into the shared store (t/4311#30 R1/R2) —
   * additive and failure-tolerant: the local map write this follows has
   * already succeeded and is never at risk here. A failure only means
   * another replica may miss this write for now, no worse than today's
   * (pre-this-PR) single-replica-only behavior. Fire-and-forget by design
   * (never awaited by its callers) — every error path below is caught and
   * WARN-logged, never thrown, so the returned promise never rejects.
   * No-op when the flag is inactive.
   *
   * t/549: `SharedOverlayEntry.baseSha` now carries `null` (the file was absent when staged), closing
   * the t/4311#29/#31 known gap. This stays a fire-and-forget `latestWins` stage, inert behind the
   * flag; t/550 (t/503 PR 2) replaces it with the awaited, conditional stage of option 2.
   */
  private async writeThroughSharedOverlay(userId: string, repoPath: string, content: string | null, baseSha: string | null | 'unknown'): Promise<void> {
    if (!this.sharedOverlayStateActive || !this.sharedOverlayStore) return;
    try {
      const entry = { content, baseSha, stagedAt: new Date().toISOString(), stageId: crypto.randomUUID() };
      const result = await this.sharedOverlayStore.stage(userId, repoPath, entry, { latestWins: true });
      // t/549: a later save already holds the path; ours is ordered before it, nothing to cache.
      if (!result.ok && result.reason === 'newer_exists') return;
      if (!result.ok) {
        this.recordEvent({
          type: 'system.error', component: 'github-api', level: 'warn',
          message: `Shared overlay write-through failed (local write already succeeded): ${repoPath}`,
          data: { userId, repoPath },
        });
        return;
      }
      // Update our own cache directly with this write, rather than waiting
      // for a future getGeneration() round trip to notice our own `_gen`
      // bump — avoids a self-inflicted sync on a replica's own
      // write-then-immediate-read (t/4311#30 R1).
      // t/549: a failed `_gen` bump leaves gen null, so the next read re-lists.
      const cached = this.sharedOverlayReadCache.get(userId);
      const entries = cached ? new Map(cached.entries) : new Map<string, SharedOverlayEntry>();
      entries.set(repoPath, entry);
      this.sharedOverlayReadCache.set(userId, { gen: result.gen, entries, listedAt: cached?.listedAt ?? 0 });
    } catch (err) {
      const message = `Shared overlay write-through threw (local write already succeeded): ${repoPath}`;
      this.recordEvent({
        type: 'system.error', component: 'github-api', level: 'warn',
        message,
        data: { userId, repoPath },
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      log.storage.warn({ userId, repoPath, error: String(err) }, message);
    }
  }

  /**
   * Read a file as UTF-8, or null if absent.
   *
   * `opts.ref` pins the GitHub API fallback to a specific ref (e.g. 'main') for
   * shared data that lives on main rather than the caller's session branch —
   * pipeline-generated taxonomy/source/summary data. Without it, a cache miss
   * fetches with the effective session-branch ref, which 404s for shared files
   * (the file doesn't exist on the branch) and burns rate limit. See t/684.
   *
   * t/4510: the session overlay is consulted first ONLY when the call isn't
   * pinned away from the session's own ref (same precedence as `fileExists`,
   * t/4428#2) — an explicit `opts.ref` is asking for that ref's real content,
   * and answering from this session's overlay would defeat the pin. The
   * dozens of genuinely-pipeline-only `{ ref: 'main' }` callers across
   * fileIO.ts/nodeSourceIndex.ts/sourcesIndexReader.ts already follow the
   * established convention of pinning only where nothing writes that path
   * through the session backend (fileIO.ts's readLineageEnrichments comment,
   * TL p/538#161) — for them this is a no-op today (no overlay entry would
   * ever exist at those paths) and closes a latent gap (a future caller
   * accidentally writing to a nominally-pipeline-only path would otherwise
   * silently leak into these reads).
   *
   * `opts.consultOverlayOnPin: true` is the one documented exception —
   * calibrationStore.ts's append-within-request flows (appendIntegrationRecord,
   * promoteAndIntegrate) pin reads to `ref: 'main'` while still needing to see
   * the SAME request's own earlier append, which lands in the session overlay
   * (the effective ref during an active session is the session branch, not
   * 'main'). Passing this explicitly opts back into the pre-t/4510 "overlay
   * regardless of opts.ref" behavior for exactly those call sites.
   */
  /**
   * `opts.forWrite`: this read precedes a write by the caller (t/4215
   * budget addendum, TL t/4215#7) — the session-branch revalidation below
   * always does the live ref-check for it, ignoring both the 30s throttle
   * and the write-activity gate. A plain display read only revalidates if
   * the session has written something since the last check (an idle/
   * view-only session trusts its cache indefinitely instead of paying a ref
   * call it gets no benefit from) — see revalidateSessionReadCache().
   */
  async readFile(
    filePath: string,
    opts?: { ref?: string; optional?: boolean; forWrite?: boolean; consultOverlayOnPin?: boolean },
  ): Promise<string | null> {
    const repoPath = this.toRepoPath(filePath);
    const effectiveRef = this.getEffectiveRef();
    // Pinned ref (e.g. 'main') for shared data; else the effective session ref.
    const ref = this.resolveReadRef(opts?.ref) ?? effectiveRef;

    // t/4510: skip the overlay only when genuinely pinned away from the
    // session's own ref, unless the caller explicitly opts back in (see the
    // docstring above — calibrationStore.ts's append-within-request flows).
    if (ref === effectiveRef || opts?.consultOverlayOnPin) {
      const overlayVal = await this.readOverlayForUserRead(repoPath);
      if (overlayVal !== undefined) {
        return overlayVal === GitHubAPIBackend.TOMBSTONE ? null : overlayVal;
      }
    }

    // t/4215: a session-branch read with no overlay entry must not fall
    // through to main's on-disk cache below — that cache represents main
    // only, so using it here is exactly the bug this fix closes (a read
    // right after a commit showing pre-commit content).
    if (ref !== this.baseBranch) {
      return this.readSessionBranchFile(repoPath, ref, opts?.optional, opts?.forWrite ?? false);
    }

    return this.readFileFromMainCache(repoPath, ref, opts?.optional);
  }

  /** t/4584 (TL design t/4584#2/#4): like `readFile(filePath, { ref: 'main' })`,
   *  for pipeline-curated main-only data that's never legitimately absent on
   *  hosted — a genuine 404 still returns `null`, but no credentials, a
   *  tripped circuit breaker, or any other non-OK GitHub response throw
   *  `{ kind: 'transient', reason }` instead of silently collapsing to the
   *  same `null` the plain path serves. Always `ref: 'main'` — no
   *  session-branch content is ambiguous this way, so this skips the
   *  overlay/session-branch paths entirely (same precedent as
   *  `listDirectoryStrict`, t/3296 A arm). */
  async readFileStrict(filePath: string): Promise<string | null> {
    const repoPath = this.toRepoPath(filePath);
    return this.readFileFromMainCache(repoPath, this.baseBranch, false, true);
  }

  /** t/4584/t/4586: logs the reason behind a null/transient read exactly
   *  once per call site (never per-retry — the retries already happened
   *  inside `GitHubRestClient.request`), console-visible (not just the
   *  FlightRecorder ring buffer, same t/4258/t/4281 precedent as the
   *  rate-limit/circuit-breaker logs in githubRestClient.ts). */
  private logNullReadReason(repoPath: string, reason: NullReadReason, optional: boolean | undefined): void {
    // A real 404 on an `optional` read is the expected, quiet case — the
    // existing convention (`is404Optional` in githubRestClient.ts) already
    // downgrades it; mirror that here instead of WARNing on every optional miss.
    if (reason === 'not_found' && optional) {
      log.github.debug({ path: repoPath, reason }, `fetchFileFromGitHub: null read (${reason})`);
      return;
    }
    log.github.warn({ path: repoPath, reason }, `fetchFileFromGitHub: null read (${reason})`);
  }

  /** The pre-t/4215 main-cache path for readFile, unchanged except for
   *  `strict` (t/4584, TL t/4584#2): a tripped circuit breaker silently
   *  served `null` ("file not available"), indistinguishable from a
   *  genuine absence. The reason is now ALWAYS logged (t/4586); `strict`
   *  additionally throws, for callers that need that distinction
   *  (`readFileStrict`). */
  private async readFileFromMainCache(repoPath: string, ref: string, optional: boolean | undefined, strict = false): Promise<string | null> {
    // t/4778: skip disk cache for strict reads — it may serve stale "absent"
    // markers from a previous revision, causing cold-start 404s on files that
    // exist on main. Always fetch fresh for strict reads (readFileStrict).
    if (!strict) {
      const cached = await this.readFromDiskCache(repoPath);
      if (cached !== null) {
        this.recordEvent({
          type: 'cache.hit',
          component: 'cache',
          level: 'debug',
          message: `Disk cache hit: ${repoPath}`,
          data: { path: repoPath, layer: 'main' },
        });

        // Coherency probe — async, doesn't block the read
        if (Math.random() < this.coherencyProbeRate) {
          this.runCoherencyProbe(repoPath).catch(() => {});
        }

        return cached;
      }
    }

    // Cache miss — fetch from GitHub
    this.coldCacheMissCount++;
    this.recordEvent({
      type: 'cache.miss',
      component: 'cache',
      level: 'info',
      message: `Cache miss: ${repoPath}`,
      data: { path: repoPath, reason: 'missing' },
    });
    // t/4258/t/4281: recordEvent() alone is console-invisible; alert-cache-degraded
    // needs "cache.miss" in Log_s. Info-level, one line per miss — matches this
    // call's own existing level choice. Flagged to TL/DevOps: this is the one fix
    // in this batch with a real log-volume question (every cache miss, not just a
    // degraded state), unlike the other five which only fire in already-abnormal
    // conditions. Revisit sampling/throttling here if ingestion volume proves material.
    log.cache.info({ path: repoPath }, `cache.miss: ${repoPath}`);

    // t/4585: a main-pinned read of the public data repo can be served from
    // raw.githubusercontent.com at the resolved commit SHA — immutable
    // content, no auth, no REST quota. Tried before the REST circuit check
    // below (a different host, unaffected by GitHub REST's circuit state).
    // Gated on having a resolved commit SHA (set at initialize(); a
    // cold-cold boot before the first tree load just skips straight to the
    // existing REST path below, same as pre-t/4585 behavior).
    const mainSha = ref === this.baseBranch ? this.manifest?.lastCommitSha : undefined;
    if (mainSha) {
      const rawResult = await this.fetchFileFromRaw(repoPath, mainSha);
      if (rawResult.kind === 'hit') {
        await this.writeToDiskCache(repoPath, rawResult.content, rawResult.sha, '');
        return rawResult.content;
      }
      if (rawResult.kind === 'not_found') {
        this.logNullReadReason(repoPath, 'not_found', optional);
        return null;
      }
      if (rawResult.reason === 'private_repo') {
        // t/497: a decision, not a failure. Count it, but keep it out of the disable window and out of
        // the per-read WARN; noteRawSkippedForPrivateRepo logs it once.
        this.rawFallbackCounts.private_repo = (this.rawFallbackCounts.private_repo ?? 0) + 1;
        this.noteRawSkippedForPrivateRepo();
      } else {
        this.recordRawFallback(rawResult.reason);
        log.github.warn({ path: repoPath, reason: rawResult.reason },
          `fetchFileFromRaw: falling back to REST (${rawResult.reason})`);
      }
    }

    if (this.rest.isTripped()) {
      this.logNullReadReason(repoPath, 'circuit_open', optional);
      if (strict) {
        throw Object.assign(new Error(`GitHub API circuit breaker open — transient: ${repoPath}`), { kind: 'transient' as const, reason: 'circuit_open' as const });
      }
      return null; // Circuit open — serve null (file not available)
    }

    const result = await this.fetchFileFromGitHub(repoPath, ref, optional, strict);
    if (result === null) return null;

    // Write-through to disk cache
    await this.writeToDiskCache(repoPath, result.content, result.sha, result.etag);
    return result.content;
  }

  /**
   * t/4215 (TL design, t/4215#2): a plain read on a session branch, once the
   * overlay has no entry for this path. Unlike readFileWithVersion's always-
   * live read (t/4224 — low call volume, correctness-critical), this is
   * called from read-modify-write loops over many paths (harvest, policy
   * recount, edges) — a live GitHub call per call would reintroduce the
   * t/4201 cost. Instead: a per-session cache filled for free at
   * commitOverlay/mergeBranch, with the branch-head SHA re-verified against
   * the live ref at most once every SESSION_READ_CACHE_REVALIDATE_MS so an
   * out-of-band move (a resync conflict resolved on GitHub, another replica)
   * is bounded, not missed entirely. A miss, or a stale-head mismatch, does
   * one live fetch for this path.
   */
  private async readSessionBranchFile(repoPath: string, ref: string, optional: boolean | undefined, forWrite: boolean): Promise<string | null> {
    const userId = this.getEffectiveUserId();
    if (!userId) return this.liveReadSessionBranchFile(repoPath, ref, optional);

    const cacheTrustworthy = await this.revalidateSessionReadCache(userId, ref, forWrite);
    if (cacheTrustworthy) {
      const cached = this.sessionReadCache.get(userId)?.get(repoPath);
      if (cached !== undefined) {
        return cached === GitHubAPIBackend.TOMBSTONE ? null : cached;
      }
    }

    return this.liveReadSessionBranchFile(repoPath, ref, optional, userId);
  }

  /**
   * One live fetch for a session-branch path, caching the result for the
   * given user if present. Fails closed on an unavailable fetch (503
   * VERSION_UNAVAILABLE, same as t/4224) — a silent `null` here reads as
   * "file doesn't exist" to read-modify-write callers, which would rebuild
   * the file from empty and overwrite it (worse than a visible error).
   * `optional: true` opts a caller (typically a viewer) into `null` plus a
   * WARN instead, explicitly accepting that degradation.
   */
  private async liveReadSessionBranchFile(
    repoPath: string, ref: string, optional: boolean | undefined, userId?: string,
  ): Promise<string | null> {
    if (this.rest.isTripped()) {
      return this.handleSessionBranchUnavailable(repoPath, ref, optional);
    }

    const status = await this.getSessionBranchFileStatus(repoPath, ref);
    if (status.kind === 'unavailable') {
      return this.handleSessionBranchUnavailable(repoPath, ref, optional);
    }

    if (userId) {
      let cache = this.sessionReadCache.get(userId);
      if (!cache) { cache = new Map(); this.sessionReadCache.set(userId, cache); }
      cache.set(repoPath, status.kind === 'present' ? status.content : GitHubAPIBackend.TOMBSTONE);
    }

    return status.kind === 'present' ? status.content : null;
  }

  private handleSessionBranchUnavailable(repoPath: string, ref: string, optional: boolean | undefined): null {
    if (optional) {
      this.recordEvent({
        type: 'github.api.error', component: 'github-api', level: 'warn',
        message: `readFile(${repoPath}): session-branch lookup failed on ${ref} — returning null for an optional read (not an absent file)`,
        data: { path: repoPath, ref },
      });
      return null;
    }
    this.throwVersionUnavailable(repoPath, ref);
  }

  /**
   * Returns true if sessionReadCache can be trusted for this call (fresh, or
   * still within SESSION_READ_CACHE_REVALIDATE_MS); false if a ref-check
   * failed, in which case the caller must skip the cache and go live for
   * this read (TL: "treat it as a miss, which goes live and fails closed").
   * A genuine head-sha mismatch clears the whole per-user cache rather than
   * guessing which paths changed.
   *
   * t/4215 budget addendum (TL t/4215#7): unthrottled, this ref-check can
   * cost up to 120 calls/hour/session (one per 30s continuously) — close to
   * the cost of saving, and enough to cut the editor ceiling from ~33 to
   * ~18 against the shared GitHub budget. Revalidate only when it can
   * matter:
   *   - the very first check for a session always goes live, regardless of
   *     `forWrite`/activity — there's no baseline yet to trust.
   *   - `forWrite` (a read that precedes a write): always live after that
   *     too, no throttle — correctness for the write that follows depends
   *     on it.
   *   - a plain display read, once a baseline exists: only if the session
   *     has written something since the LAST check (an idle/view-only
   *     session trusts its cache indefinitely — nothing it did could have
   *     gone stale), and even then still no more than once per
   *     SESSION_READ_CACHE_REVALIDATE_MS.
   */
  private async revalidateSessionReadCache(userId: string, ref: string, forWrite: boolean): Promise<boolean> {
    const tracked = this.sessionReadCacheHeadSha.get(userId);

    if (!forWrite && tracked) {
      const currentActivitySeq = this.sessionWriteActivitySeq.get(userId) ?? 0;
      if (currentActivitySeq <= tracked.checkedAtActivitySeq) return true; // nothing written since we last looked — trust the cache
      if (Date.now() - tracked.checkedAt < SESSION_READ_CACHE_REVALIDATE_MS) {
        return true; // activity happened, but still within the throttle window
      }
    }

    const liveSha = await this.getBranchHeadSha(ref);
    if (liveSha === null) {
      return false;
    }

    if (!tracked || tracked.sha !== liveSha) {
      this.sessionReadCache.delete(userId);
    }
    this.sessionReadCacheHeadSha.set(userId, {
      sha: liveSha, checkedAt: Date.now(), checkedAtActivitySeq: this.sessionWriteActivitySeq.get(userId) ?? 0,
    });
    return true;
  }

  private async getBranchHeadSha(branch: string): Promise<string | null> {
    if (this.rest.isTripped()) return null;
    const creds = await this.getCredsCached();
    if (!creds) return null;
    const resp = await this.rest.request(creds, 'GET',
      `/repos/${creds.repo}/git/refs/heads/${branch}`, undefined, undefined, { optional: true });
    if (!resp.ok) return null;
    return (resp.data as { object: { sha: string } }).object.sha;
  }

  /**
   * t/4187: like readFile, but also returns the version (GitHub blob SHA) the
   * content came from — the route's save flow needs to hand this back to the
   * client as the precondition (`ETag`) for its *next* write.
   *
   * Content and version must come from the SAME cache snapshot (TL design
   * review, t/4187#3) — a manifest entry whose `.sha` moved between reading
   * the content and reading the sha would hand the client a version newer
   * than what it's actually editing, reopening the lost update this whole fix
   * closes. Two independent guards, because a mismatch can happen two ways:
   *   1. A concurrent write/eviction moves the manifest entry mid-read —
   *      caught by re-checking the entry after the (async) disk read.
   *   2. The disk file is simply stale relative to its own manifest entry
   *      (e.g. a half-written cache file, or disk/manifest drift) — the
   *      manifest doesn't *move*, so guard 1 alone wouldn't catch it. Caught
   *      by verifying the disk content's own git blob SHA against the
   *      manifest's claimed SHA (TL fault-arm requirement, t/4187#3: "stale
   *      content with a fresh manifest SHA must produce a conflict, not a
   *      silent save").
   * Either guard failing retries rather than returning a torn pair.
   *
   * Checks the session overlay first, same precedence as readFile() — t/4201
   * review (p/775#30): without this, a hosted user's GET after a save served
   * main's stale content instead of the overlay, so every later save in that
   * session got WRITE_CONFLICT until the overlay committed. The overlay's
   * version is its own git blob SHA (gitBlobSha(overlay content)), computed
   * the same way writeFile's overlay fast path does, so a write that follows
   * this read with that version as baseSha matches cleanly.
   *
   * t/4510 (TL t/4510#3): this has the same overlay-before-ref-resolve order
   * readFile() had before its fix — no current caller passes `opts.ref`
   * (confirmed by grep), so it's out of scope for that fix. It MUST get the
   * same precedence rule (skip the overlay when `opts.ref` pins away from
   * the effective ref, with the same `consultOverlayOnPin` escape hatch)
   * before any caller starts pinning a ref here.
   */
  async readFileWithVersion(filePath: string, opts?: { ref?: string }): Promise<{ content: string; version: string } | null> {
    const repoPath = this.toRepoPath(filePath);

    const overlayVal = await this.readOverlayForUserRead(repoPath);
    if (overlayVal !== undefined) {
      return overlayVal === GitHubAPIBackend.TOMBSTONE ? null : { content: overlayVal, version: gitBlobSha(overlayVal) };
    }

    const ref = this.resolveReadRef(opts?.ref) ?? this.getEffectiveRef();

    // t/4224 (TL design, p/538#40/#43): an edit-load on a session branch with
    // no pending overlay entry must read the branch's own current content and
    // version, not main's cache — the manifest/disk-cache path below
    // represents main only, so using it here is exactly the bug this fix
    // closes (an edit-load that silently shows pre-commit, pre-merge, or
    // pre-out-of-band content instead of what the session branch actually
    // holds). Absent (a genuinely missing file) returns null, matching this
    // method's existing contract — only unavailable (a real fetch failure)
    // fails closed with a 503.
    if (ref !== this.baseBranch) {
      const status = await this.getSessionBranchFileStatus(repoPath, ref);
      if (status.kind === 'absent') return null;
      if (status.kind === 'unavailable') this.throwVersionUnavailable(repoPath, ref);
      return { content: status.content, version: status.sha };
    }

    return this.readFileWithVersionFromMainCache(repoPath, ref);
  }

  /**
   * The pre-t/4224 main-cache path for readFileWithVersion, unchanged —
   * split out to keep readFileWithVersion's own complexity down once the
   * session-branch live-read branch above was added.
   */
  private async readFileWithVersionFromMainCache(repoPath: string, ref: string): Promise<{ content: string; version: string } | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const entry = this.manifest?.files[repoPath];
      if (!entry) break; // no cache entry — fall through to a fresh GitHub fetch

      const content = await this.readFromDiskCache(repoPath);
      const after = this.manifest?.files[repoPath];
      if (content !== null && after && after.sha === entry.sha) {
        if (gitBlobSha(content) === entry.sha) {
          return { content, version: entry.sha };
        }
        this.recordEvent({
          type: 'cache.coherency_violation', component: 'cache', level: 'error',
          message: `readFileWithVersion: disk content hash doesn't match its own manifest SHA for ${repoPath} — torn/corrupt cache entry, forcing a fresh fetch`,
          data: { path: repoPath, claimedSha: entry.sha },
        });
        break; // don't retry against the same bad disk state — go straight to a fresh fetch
      }
      // The manifest entry moved (a write or eviction landed mid-read) — the
      // pair we just read is torn. Retry against the new state.
    }

    // Cache miss (or torn-read retries exhausted) — one GitHub response gives
    // content + sha atomically by construction.
    if (this.rest.isTripped()) return null;
    const result = await this.fetchFileFromGitHub(repoPath, ref);
    if (result === null) return null;

    await this.writeToDiskCache(repoPath, result.content, result.sha, result.etag);
    return { content: result.content, version: result.sha };
  }

  // t/4393: the disk cache holds `main` content only (same as readFileFromMainCache/
  // readFileAtRef) — gating it on `ref === this.baseBranch` fixes a latent bug: before
  // this ref param existed, every call used getEffectiveRef() unconditionally and could
  // serve or pollute the main cache from a non-main session branch.
  async readBinaryFile(filePath: string, opts?: { ref?: string }): Promise<Buffer | null> {
    const repoPath = this.toRepoPath(filePath);
    const ref = this.resolveReadRef(opts?.ref) ?? this.getEffectiveRef();

    if (ref === this.baseBranch) {
      const cached = await this.readBinaryFromDiskCache(repoPath);
      if (cached !== null) return cached;
    }

    if (this.rest.isTripped()) return null;

    const result = await this.fetchBinaryFileFromGitHub(repoPath, ref);
    if (result === null) return null;

    if (ref === this.baseBranch) {
      await this.writeBinaryToDiskCache(repoPath, result.content, result.sha, result.etag);
    }
    return result.content;
  }

  async readFileAtRef(repoPath: string, requestedRef: string): Promise<string | null> {
    const ref = this.resolveReadRef(requestedRef) ?? requestedRef;
    if (ref === this.baseBranch) {
      const cached = await this.readFromDiskCache(repoPath);
      if (cached !== null) return cached;
    }
    if (this.rest.isTripped()) return null;
    const result = await this.fetchFileFromGitHub(repoPath, ref);
    if (result === null) return null;
    if (ref === this.baseBranch) {
      await this.writeToDiskCache(repoPath, result.content, result.sha, result.etag);
    }
    return result.content;
  }

  async writeFile(filePath: string, content: string, opts?: { ref?: string; baseSha?: string }): Promise<{ version: string }> {
    const repoPath = this.toRepoPath(filePath);
    // opts.ref pins the write to a specific ref (e.g. 'main') for shared data
    // that must commit straight to main rather than the caller's session branch
    // — e.g. community submissions, which submitters (often without merge rights)
    // need visible to admins immediately (t/694). Without a ref, writes keep the
    // overlay/session-branch semantics that calibration RMW flows depend on.
    const forceRef = opts?.ref;
    const ref = forceRef ?? this.getEffectiveRef();

    // When on a session branch (and no ref is forced), write to overlay only —
    // no API call. The overlay is flushed via commitOverlay() (Trees API batch).
    // t/4187 (Rosetta Stone, p/775#18): this is the path EVERY hosted user save
    // actually takes — the baseSha precondition has to apply here, not just on
    // the direct-commit path below, or the fix protects no one on the web.
    if (!forceRef && ref !== this.baseBranch && this.hasSessionContext()) {
      this.recordEvent({ type: 'cache.hit', component: 'cache', level: 'debug',
        message: `writeFile: overlay fast-path taken: ${repoPath}`, data: { path: repoPath, ref } });
      return this.writeOverlayWithPrecondition(filePath, repoPath, content, ref, opts?.baseSha);
    }

    this.assertDirectWriteAllowed(forceRef, ref, repoPath);

    if (this.rest.isTripped()) {
      throw new ActionableError({
        goal: 'Write file to GitHub',
        problem: 'GitHub API is unavailable (circuit breaker open). Edits temporarily disabled.',
        location: `GitHubAPIBackend.writeFile(${repoPath})`,
        nextSteps: ['Wait for GitHub API to recover', 'Check /health for circuit breaker status'],
      });
    }

    // t/4187: the caller's `baseSha` (the version it last read) is the precondition
    // when supplied — it wins over the server's own cache, which is what actually
    // fixes the N=1 two-tabs case (the cache's SHA is always "correct" from the
    // server's point of view; it's just not what the client saw). Only a direct
    // fileIO caller with no client in the loop (harvest/pipeline writers) falls
    // back to the cache-derived SHA — WARN-logged, never silent.
    let fileSha: string | null;
    if (opts?.baseSha !== undefined) {
      fileSha = opts.baseSha;
    } else {
      fileSha = await this.getFileSha(repoPath, ref);
      this.recordEvent({
        type: 'storage.fallback', component: 'github-api', level: 'warn',
        message: `writeFile(${repoPath}): no baseSha supplied — falling back to the server's cache-derived SHA (direct fileIO caller, not the save route)`,
        data: { path: repoPath, ref },
      });
      log.github.warn({ path: repoPath, ref },
        `storage.fallback: writeFile(${repoPath}) had no baseSha — using the cache-derived SHA`);
    }

    const creds = await this.getCredsCached();
    if (!creds) throw this.noCredsError('writeFile');

    const callId = crypto.randomUUID();
    const encodedContent = Buffer.from(content, 'utf-8').toString('base64');

    const doWrite = async (sha: string | null) => {
      const body: Record<string, unknown> = {
        message: `Update ${repoPath}`,
        content: encodedContent,
        branch: ref,
      };
      if (sha) body.sha = sha;

      const resp = await this.rest.request(creds, 'PUT',
        `/repos/${creds.repo}/contents/${repoPath}`, body, callId);

      // t/4184: NEVER retry a 409 with the same (pre-read) content — the caller
      // computed `content` from a snapshot that's now stale, so re-sending it
      // with a fresh SHA silently overwrites whatever the other writer committed
      // (a lost update, defeating the SHA precondition). `writeFile` receives
      // whole-file content, not a mutator, so a correct read-modify-write isn't
      // possible at this layer — fail loud instead (TL design review, t/4184#1).
      if (resp.status === 409) {
        this.recordEvent({
          type: 'github.api.conflict',
          component: 'github-api',
          level: 'warn',
          message: `409 SHA conflict on ${repoPath} — failing (no retry; would lose the other writer's change)`,
          call_id: callId,
          data: { path: repoPath, ref, staleSha: sha },
        });
        await this.evictPathFromCache(repoPath); // SO C1: next readFile fetches fresh, not the same stale state
        throw this.writeConflictError(repoPath, 'writeFile');
      }

      if (!resp.ok) {
        throw new ActionableError({
          goal: `Write ${repoPath} to GitHub`,
          problem: `GitHub API returned ${resp.status}: ${resp.error}`,
          location: `GitHubAPIBackend.writeFile(${repoPath})`,
          nextSteps: ['Check GitHub API status', 'Retry the operation'],
        });
      }

      return resp;
    };

    const resp = await doWrite(fileSha);

    // Write-through: update cache only after confirmed 2xx
    const respData = resp.data as { content?: { sha?: string } };
    const newSha = respData?.content?.sha ?? '';
    await this.writeToDiskCache(repoPath, content, newSha, '');
    return { version: newSha };
  }

  /**
   * Guard rails for the direct-commit write path (not taken on a session
   * branch — see the overlay fast path above). Split out of writeFile to
   * keep its own complexity down (t/4187 cleanup).
   */
  private assertDirectWriteAllowed(forceRef: string | undefined, ref: string, repoPath: string): void {
    // A forced ref that differs from the configured base branch would bypass
    // base-branch isolation (e.g. forced 'main' on a staging deployment leaks to prod).
    // Zero current consumers (t/2657) — this future-proofs against re-arming the incident.
    if (forceRef && forceRef !== this.baseBranch) {
      throw new ActionableError({
        goal: `Force-write to ref '${forceRef}'`,
        problem: `Forced ref '${forceRef}' does not match the configured base branch '${this.baseBranch}'. This would bypass base-branch isolation and risk writing to the wrong environment.`,
        location: `GitHubAPIBackend.writeFile(${repoPath})`,
        nextSteps: [
          `Set GITHUB_BRANCH=${forceRef} if this deployment should write there`,
          'Or remove opts.ref to use the configured base branch',
        ],
      });
    }

    // Without a forced ref, writes must go to a session branch — caller should
    // create one first. A forced ref is an explicit opt-in to a direct commit.
    if (!forceRef && ref === this.baseBranch && this.hasSessionContext()) {
      throw new ActionableError({
        goal: 'Write file to GitHub',
        problem: `Cannot write directly to ${this.baseBranch}. Create a session branch first.`,
        location: `GitHubAPIBackend.writeFile(${repoPath})`,
        nextSteps: ['Create a session branch via the Session Branch Manager'],
      });
    }
  }

  /**
   * t/4187 (Rosetta Stone, p/775#18): apply the baseSha precondition on the
   * overlay fast path — this is where every hosted user save actually lands,
   * so the precondition has to hold here or it protects no one on the web.
   *
   * "Current version" is the git blob SHA of whatever this user's overlay (or,
   * if nothing's staged yet this session, the last committed content) holds
   * for this path. Computed locally via gitBlobSha — the same hash GitHub
   * would report as `sha` for that exact content, whether or not it's actually
   * been committed. This lets an overlay write be versioned without a round
   * trip, and lets a second overlay write to the same path in the same
   * session (two tabs) detect that the first one already landed.
   */
  private async writeOverlayWithPrecondition(
    filePath: string, repoPath: string, content: string, ref: string, baseSha: string | undefined,
  ): Promise<{ version: string }> {
    // t/4224 (TL design, p/538#40/#43): with no pending overlay entry for
    // this path, the current version must come from the session branch
    // itself — never from getFileSha()'s main-cache fallback, which ignores
    // `ref` and is exactly the bug this fix closes (a save right after a
    // commit, a resync merge, or any other out-of-band move of the branch
    // head would otherwise compare against main's stale SHA instead of the
    // branch's real current content). The precondition CHECK only runs when
    // there's a `baseSha` to check against — a writer with no precondition
    // (p/538#43: harvest, conflicts, edges, any new taxonomy-side file) keeps
    // its existing no-check behavior. But t/4312 still needs this path's base
    // recorded regardless (condition 1), so the live lookup below always
    // happens on first staging even when there's no precondition to validate.
    const existing = this.checkSessionOverlay(repoPath);
    const userId = this.getEffectiveUserId();

    // t/550: with shared state active the save is acknowledged only once the shared store has it.
    if (this.sharedSavesActive(userId)) return this.saveSharedWithOptionalBaseSha(userId, repoPath, content, ref, baseSha);

    if (baseSha === undefined) {
      this.warnNoBaseShaOverlayWrite(repoPath, ref);
      await this.maybeRecordBaseShaForFreshStage(userId, repoPath, ref, existing !== undefined);
    } else {
      let currentVersion: string | null;
      if (existing !== undefined && existing !== GitHubAPIBackend.TOMBSTONE) {
        currentVersion = gitBlobSha(existing);
      } else {
        const status = await this.getSessionBranchFileStatus(repoPath, ref);

        // SO fault (C1, e/302#4): a concurrent save of the same path by the
        // same user (two tabs — exactly the case this precondition exists
        // for) can land its overlay entry while this call was awaiting the
        // live lookup above. Re-check the overlay now, synchronously — from
        // here to writeToOverlay() below there's no more await, so this
        // closes the check-then-write race the first (`existing`) check
        // alone left open.
        const landedWhileAwaiting = this.checkSessionOverlay(repoPath);
        if (landedWhileAwaiting !== undefined) {
          currentVersion = landedWhileAwaiting === GitHubAPIBackend.TOMBSTONE ? null : gitBlobSha(landedWhileAwaiting);
        } else {
          if (status.kind === 'unavailable') this.throwVersionUnavailable(repoPath, ref);
          // 'absent' → null: a baseSha was supplied, so the client expects a
          // file that does not exist on the branch — that mismatch is itself
          // the conflict, same as any other currentVersion !== baseSha below.
          currentVersion = status.kind === 'present' ? status.sha : null;
        }
        // t/4312: this lookup IS the live base — record it (idempotent; a
        // concurrent write that landed first already recorded its own).
        if (userId) this.recordOverlayBaseShaOnce(userId, repoPath, status.kind === 'present' ? status.sha : status.kind === 'absent' ? null : 'unknown');
      }

      if (currentVersion === null || baseSha !== currentVersion) {
        this.recordEvent({
          type: 'github.api.conflict', component: 'github-api', level: 'warn',
          message: `Overlay write conflict on ${repoPath} — staged content moved since the client's last read`,
          data: { path: repoPath, ref, staleSha: baseSha, currentSha: currentVersion },
        });
        throw this.writeConflictError(repoPath, 'writeFile');
      }
    }

    this.writeToOverlay(filePath, content);
    return { version: gitBlobSha(content) };
  }

  /**
   * t/4216 (t/181): atomic create-only write. Same routing as writeFile:
   * - session branch (no forced ref) → stage in the overlay only if neither the overlay nor the
   *   session branch has the path, with the t/4187 synchronous re-check after the branch lookup.
   *   Atomic per PROCESS only: the overlay lives in memory until commitOverlay(), so two replicas
   *   can both stage a create. Hosted job records and drafts live on Blob, not here.
   * - direct commit → a Contents PUT with no `sha`, which GitHub accepts only for a new file;
   *   its 422 "sha wasn't supplied" (or a 409) means the file exists. Atomic across replicas.
   */
  async writeFileIfAbsent(filePath: string, content: string, opts?: { ref?: string }): Promise<WriteIfAbsentResult> {
    const repoPath = this.toRepoPath(filePath);
    const forceRef = opts?.ref;
    const ref = forceRef ?? this.getEffectiveRef();
    if (!forceRef && ref !== this.baseBranch && this.hasSessionContext()) {
      return this.createInOverlayIfAbsent(filePath, repoPath, content, ref);
    }
    this.assertDirectWriteAllowed(forceRef, ref, repoPath);
    return this.createDirectIfAbsent(repoPath, content, ref);
  }

  private async createInOverlayIfAbsent(
    filePath: string, repoPath: string, content: string, ref: string,
  ): Promise<WriteIfAbsentResult> {
    const sharedUser = this.getEffectiveUserId();
    if (this.sharedSavesActive(sharedUser)) {
      return (await this.stageSharedOverlaySave(sharedUser, repoPath, content, ref, { kind: 'ifAbsent' })) === 'exists' ? 'exists' : 'created';
    }
    const isStagedFile = (v: string | undefined) => v !== undefined && v !== GitHubAPIBackend.TOMBSTONE;
    const staged = this.checkSessionOverlay(repoPath);
    if (isStagedFile(staged)) return 'exists';
    // Nothing staged → the session branch decides. A tombstone means deleted this session: absent.
    const status = staged === undefined ? await this.getSessionBranchFileStatus(repoPath, ref) : null;
    if (status?.kind === 'unavailable') this.throwVersionUnavailable(repoPath, ref);
    // t/4187 C1: a same-process create can land while the lookup above was awaiting. From here to
    // writeToOverlay() there is no await, so this re-check closes that window.
    const landed = this.checkSessionOverlay(repoPath);
    if (isStagedFile(landed)) return 'exists';
    if (landed === undefined && status?.kind === 'present') return 'exists';
    const userId = this.getEffectiveUserId();
    if (userId && status) this.recordOverlayBaseShaOnce(userId, repoPath, status.kind === 'present' ? status.sha : null);
    this.writeToOverlay(filePath, content);
    return 'created';
  }

  private async createDirectIfAbsent(repoPath: string, content: string, ref: string): Promise<WriteIfAbsentResult> {
    if (this.rest.isTripped()) {
      throw new ActionableError({
        goal: 'Create file on GitHub',
        problem: 'GitHub API is unavailable (circuit breaker open). Edits temporarily disabled.',
        location: `GitHubAPIBackend.writeFileIfAbsent(${repoPath})`,
        nextSteps: ['Wait for GitHub API to recover', 'Check /health for circuit breaker status'],
      });
    }
    const creds = await this.getCredsCached();
    if (!creds) throw this.noCredsError('writeFileIfAbsent');
    const callId = crypto.randomUUID();
    const resp = await this.rest.request(creds, 'PUT', `/repos/${creds.repo}/contents/${repoPath}`, {
      message: `Create ${repoPath}`,
      content: Buffer.from(content, 'utf-8').toString('base64'),
      branch: ref,
    }, callId);
    // No `sha` in the body: GitHub refuses the PUT for an existing file with 422 "\"sha\" wasn't
    // supplied". Any OTHER 422 is a real validation failure and must not read as 'exists'.
    // t/181 (Quality blocker): 409 means "modified concurrently", possibly on another path or ref,
    // so we must re-read to confirm the file actually exists before returning 'exists'.
    if (resp.status === 409) {
      return this.handleCreateConflict(repoPath, content, ref, creds, callId);
    }
    if (resp.status === 422 && /\bsha\b/i.test(resp.error ?? '')) {
      return this.confirmExistsAfter422(repoPath, ref, resp.error ?? '', callId);
    }
    if (!resp.ok) {
      throw new ActionableError({
        goal: `Create ${repoPath} on GitHub only if absent`,
        problem: `GitHub API returned ${resp.status}: ${resp.error}`,
        location: `GitHubAPIBackend.writeFileIfAbsent(${repoPath})`,
        nextSteps: ['Check GitHub API status', 'Retry the operation'],
      });
    }
    const newSha = (resp.data as { content?: { sha?: string } })?.content?.sha ?? '';
    await this.writeToDiskCache(repoPath, content, newSha, '');
    return 'created';
  }

  /** t/268 (item 3): GitHub's 422 text mentioning "sha" is a hint that the file exists, not proof: the
   *  wording is not a contract, and another validation error could mention sha. Confirm with a read, the
   *  way the 409 path does. Present → 'exists'. Absent → the 422 was a real validation failure: WARN with
   *  the raw message and throw. Unavailable → cannot verify, so fail closed with a 503. */
  private async confirmExistsAfter422(repoPath: string, ref: string, rawError: string, callId: string): Promise<WriteIfAbsentResult> {
    const status = await this.getSessionBranchFileStatus(repoPath, ref);
    if (status.kind === 'present') return 'exists';
    if (status.kind === 'unavailable') {
      log.github.warn({ callId, repoPath, ref, githubMessage: rawError },
        'writeFileIfAbsent: 422 mentions sha but the file could not be read to confirm it exists; failing closed (t/268)');
      throw new ActionableError({
        goal: `Verify whether ${repoPath} exists after GitHub refused the create`,
        problem: 'GitHub API returned 422 for a create without sha, but the file could not be read to confirm it exists.',
        location: `GitHubAPIBackend.writeFileIfAbsent(${repoPath})`,
        nextSteps: ['Retry the operation', 'Check GitHub API status'],
        httpStatus: 503,
        code: 'GITHUB_EXISTS_UNVERIFIED',
      });
    }
    log.github.warn({ callId, repoPath, ref, githubMessage: rawError },
      'writeFileIfAbsent: 422 mentions sha but the file is absent; treating it as a validation failure, not as exists (t/268)');
    throw new ActionableError({
      goal: `Create ${repoPath} on GitHub only if absent`,
      problem: `GitHub API returned 422: ${rawError}`,
      location: `GitHubAPIBackend.writeFileIfAbsent(${repoPath})`,
      nextSteps: ['Check the path and content are valid for the GitHub contents API', 'Retry the operation'],
    });
  }

  private async handleCreateConflict(
    repoPath: string, content: string, ref: string, creds: SyncCredentials, callId: string,
  ): Promise<WriteIfAbsentResult> {
    const status = await this.getSessionBranchFileStatus(repoPath, ref);
    if (status.kind === 'present') return 'exists';
    if (status.kind === 'unavailable') {
      throw new ActionableError({
        goal: `Verify file status after concurrent modification on ${repoPath}`,
        problem: 'GitHub API returned 409 (concurrent modification), but could not verify whether the file exists.',
        location: `GitHubAPIBackend.writeFileIfAbsent(${repoPath})`,
        nextSteps: ['Retry the operation', 'Check GitHub API status'],
        httpStatus: 503,
        code: 'GITHUB_CONFLICT_UNRESOLVED',
      });
    }
    // status.kind === 'absent': the 409 was on a different path or a transient branch state.
    // Retry once before failing. Per AGENTS.md, log the fallback path taken.
    log.github.warn(
      { callId, repoPath, ref },
      `Retrying create on 409 (concurrent modification) after verifying file absent on ${repoPath}`,
    );
    const retryResp = await this.rest.request(creds, 'PUT', `/repos/${creds.repo}/contents/${repoPath}`, {
      message: `Create ${repoPath}`,
      content: Buffer.from(content, 'utf-8').toString('base64'),
      branch: ref,
    }, callId);
    if (retryResp.status === 422 && /\bsha\b/i.test(retryResp.error ?? '')) {
      return this.confirmExistsAfter422(repoPath, ref, retryResp.error ?? '', callId);
    }
    if (retryResp.ok) {
      const newSha = (retryResp.data as { content?: { sha?: string } })?.content?.sha ?? '';
      await this.writeToDiskCache(repoPath, content, newSha, '');
      return 'created';
    }
    // Retry also failed — throw the error
    throw new ActionableError({
      goal: `Create ${repoPath} on GitHub only if absent`,
      problem: `GitHub API returned ${retryResp.status}: ${retryResp.error}`,
      location: `GitHubAPIBackend.writeFileIfAbsent(${repoPath})`,
      nextSteps: ['Check GitHub API status', 'Retry the operation'],
      httpStatus: retryResp.status === 409 ? 409 : undefined,
      code: retryResp.status === 409 ? 'GITHUB_CONCURRENT_WRITE' : undefined,
    });
  }

  async writeBinaryFile(filePath: string, content: Buffer, opts?: { ref?: string }): Promise<void> {
    const repoPath = this.toRepoPath(filePath);
    const ref = opts?.ref ?? this.getEffectiveRef();

    if (this.rest.isTripped()) {
      throw new ActionableError({
        goal: 'Write binary file to GitHub',
        problem: 'GitHub API is unavailable (circuit breaker open). Edits temporarily disabled.',
        location: `GitHubAPIBackend.writeBinaryFile(${repoPath})`,
        nextSteps: ['Wait for GitHub API to recover', 'Check /health for circuit breaker status'],
      });
    }

    const fileSha = await this.getFileSha(repoPath, ref);
    const creds = await this.getCredsCached();
    if (!creds) throw this.noCredsError('writeBinaryFile');

    const callId = crypto.randomUUID();
    const encodedContent = content.toString('base64');

    const doWrite = async (sha: string | null): Promise<{ ok: boolean; status: number; data: unknown }> => {
      const body: Record<string, unknown> = {
        message: `Update ${repoPath}`,
        content: encodedContent,
        branch: ref,
      };
      if (sha) body.sha = sha;

      const resp = await this.rest.request(creds, 'PUT',
        `/repos/${creds.repo}/contents/${repoPath}`, body, callId);

      // t/4184: see writeFile() — never retry a 409 with the same (pre-read)
      // content; it's a lost update, not a recoverable conflict at this layer.
      if (resp.status === 409) {
        this.recordEvent({
          type: 'github.api.conflict',
          component: 'github-api',
          level: 'warn',
          message: `409 SHA conflict on ${repoPath} — failing (no retry; would lose the other writer's change)`,
          call_id: callId,
          data: { path: repoPath, ref, staleSha: sha },
        });
        await this.evictPathFromCache(repoPath); // SO C1
        throw this.writeConflictError(repoPath, 'writeBinaryFile');
      }

      if (!resp.ok) {
        throw new ActionableError({
          goal: `Write binary ${repoPath} to GitHub`,
          problem: `GitHub API returned ${resp.status}: ${resp.error}`,
          location: `GitHubAPIBackend.writeBinaryFile(${repoPath})`,
          nextSteps: ['Check GitHub API status', 'Retry the operation'],
        });
      }

      return resp;
    };

    const resp = await doWrite(fileSha);
    const respData = resp.data as { content?: { sha?: string } };
    const newSha = respData?.content?.sha ?? '';
    await this.writeBinaryToDiskCache(repoPath, content, newSha, '');
  }

  async listDirectory(dirPath: string, opts?: { ref?: string }): Promise<string[]> {
    return (await this.listDirectoryDetailed(dirPath, opts)).names;
  }

  /**
   * t/268 (item 5): listDirectory, plus why the listing is degraded. A degraded listing returned []
   * without a genuine answer (no tree on a non-holder, circuit breaker open, API unavailable, no
   * credentials). A missing directory (404) is a genuine [] and is not degraded. Callers that count
   * records (job caps) must fail closed on a degraded listing, not read it as "no records".
   */
  async listDirectoryDetailed(dirPath: string, opts?: { ref?: string }): Promise<{ names: string[]; degraded: DirListingDegradation | null }> {
    const repoPath = this.toRepoPath(dirPath);
    let degraded: DirListingDegradation | null = null;
    const prefix = repoPath ? repoPath + '/' : '';

    // Build the base listing (direct children) from the in-memory tree, falling
    // back to the GitHub Contents API. Collected as a Set so the session overlay
    // merge below can add/remove entries idempotently.
    const seen = new Set<string>();

    if (this.repoTree.size === 0 && this.blobLease) await this.ensureRepoTreeFilled();

    if (this.repoTree.size > 0) {
      for (const [p] of this.repoTree) {
        if (prefix && !p.startsWith(prefix)) continue;
        const rest = prefix ? p.slice(prefix.length) : p;
        if (!rest) continue;
        // Direct children only — first path segment under the prefix.
        seen.add(rest.split('/')[0]);
      }
    } else if (this.mayFallBackToContentsApi() && !(this.rest.isTripped())) {
      degraded = await this.fetchDirectoryFromAPI(repoPath, opts, seen);
    } else if (!this.mayFallBackToContentsApi()) {
      degraded = 'non-holder-tree-empty';
      // t/4179 R3: a non-holder with an empty tree even after a refill
      // attempt never hits the Contents API per-call — that's the N>1
      // crash-loop pattern t/4201/t/4176 fixed. Degraded [] instead.
      log.server.warn({ dir: repoPath, cause: 'non-holder-tree-empty' }, 'listDirectory returning [] — coordinated non-holder with no tree, avoiding per-call Contents API (t/4179)');
    } else {
      degraded = 'circuit-breaker-open';
      log.server.warn({ dir: repoPath, cause: 'circuit-breaker-open' }, 'listDirectory returning [] — circuit breaker open, may be false-empty (t/3300)');
    }

    // Merge the session overlay so files written this session are visible and
    // tombstoned files are hidden — mirroring readFile()/fileExists() semantics.
    // Without this, submissions written to the overlay (e.g. community submits)
    // are invisible to listDirectory() until the overlay is flushed on commit.
    await this.mergeOverlayIntoListing(prefix, seen);

    return { names: [...seen], degraded };
  }

  /**
   * Validation-scoped probe (t/3296 A arm): like listDirectory but throws on
   * unreachable instead of silently returning []. 3-way outcome taxonomy:
   *   (1) Genuine 200 + empty → returns []          (caller exits, no retry)
   *   (2) Transient (breaker/503/timeout) → throws Error with { kind: 'transient' }
   *   (3) Config / no-creds → throws ActionableError (caller exits, no retry)
   * The regular listDirectory() contract is unchanged — zero cross-caller regression.
   */
  async listDirectoryStrict(dirPath: string, opts?: { ref?: string }): Promise<string[]> {
    if (this.rest.isTripped()) {
      throw Object.assign(new Error('GitHub API circuit breaker open — transient'), { kind: 'transient' as const });
    }
    const creds = await this.getCredsCached();
    if (!creds) {
      throw new ActionableError({
        goal: 'Validate data root via GitHub API',
        problem: 'GitHub App credentials are missing or not configured. The server cannot reach the GitHub repository.',
        location: 'GitHubAPIBackend.listDirectoryStrict',
        nextSteps: [
          'Set GITHUB_APP_ID, GITHUB_PRIVATE_KEY, and GITHUB_REPO environment variables',
          'Verify the GitHub App is installed on the target repository',
        ],
      });
    }
    const ref = this.resolveReadRef(opts?.ref) ?? this.getEffectiveRef();
    const qRef = ref === 'main' ? '' : `?ref=${encodeURIComponent(ref)}`;
    const resp = await this.rest.request(creds, 'GET',
      `/repos/${creds.repo}/contents/${this.toRepoPath(dirPath)}${qRef}`);
    if (!resp.ok) {
      throw Object.assign(
        new Error(`GitHub API returned ${(resp as { status?: number }).status ?? 'unknown'}: ${(resp as { error?: string }).error ?? ''}`),
        { kind: 'transient' as const, status: (resp as { status?: number }).status },
      );
    }
    if (Array.isArray(resp.data)) {
      return (resp.data as Array<{ name: string }>).map(e => e.name);
    }
    return [];
  }

  /** Returns the degradation reason, or null when the listing is genuine (including a 404: the
   *  directory does not exist, which is a real empty answer). */
  private async fetchDirectoryFromAPI(
    repoPath: string, opts: { ref?: string } | undefined, seen: Set<string>,
  ): Promise<DirListingDegradation | null> {
    const creds = await this.getCredsCached();
    if (!creds) {
      log.server.warn({ dir: repoPath, cause: 'no-credentials' }, 'listDirectory returning [] — no GitHub credentials available, may be false-empty (t/3300)');
      return 'no-credentials';
    }
    const ref = this.resolveReadRef(opts?.ref) ?? this.getEffectiveRef();
    const qRef = ref === 'main' ? '' : `?ref=${encodeURIComponent(ref)}`;
    const resp = await this.rest.request(creds, 'GET',
      `/repos/${creds.repo}/contents/${repoPath}${qRef}`);
    if (resp.ok && Array.isArray(resp.data)) {
      for (const e of resp.data as Array<{ name: string }>) seen.add(e.name);
      return null;
    }
    if (resp.ok) return null;
    const status = (resp as { status?: number }).status;
    if (status === 404) return null;
    log.server.warn({ dir: repoPath, status, cause: 'api-non-ok' }, 'listDirectory returning [] — GitHub API non-ok response, may be false-empty (t/3300)');
    return 'api-unavailable';
  }

  /**
   * Merge the active session overlay into a base directory listing (in place).
   * Adds the direct-child segment of each non-tombstoned overlay entry under
   * `prefix`, and removes direct-file children that have been tombstoned.
   * Tombstones for files nested in subdirectories do not remove the subdirectory
   * segment, since other (non-deleted) files may still live under it.
   */
  private async mergeOverlayIntoListing(prefix: string, entries: Set<string>): Promise<void> {
    if (this.getEffectiveRef() === this.baseBranch) return;
    const userId = this.getEffectiveUserId();
    if (!userId) return;
    const pairs = await this.listEffectiveOverlayPaths(userId);
    if (!pairs) return;

    for (const [p, isTombstone] of pairs) {
      if (prefix && !p.startsWith(prefix)) continue;
      const rest = prefix ? p.slice(prefix.length) : p;
      if (!rest) continue;
      const seg = rest.split('/')[0];
      const isDirectFile = !rest.includes('/');
      if (isTombstone) {
        if (isDirectFile) entries.delete(seg);
      } else {
        entries.add(seg);
      }
    }
  }

  async deleteFile(filePath: string): Promise<void> {
    const repoPath = this.toRepoPath(filePath);
    const ref = this.getEffectiveRef();

    // When on a session branch, tombstone in overlay — no API call.
    if (ref !== this.baseBranch && this.hasSessionContext()) {
      await this.deleteFromOverlay(filePath, ref);
      return;
    }

    if (this.rest.isTripped()) {
      throw new ActionableError({
        goal: 'Delete file from GitHub',
        problem: 'GitHub API is unavailable (circuit breaker open). Edits temporarily disabled.',
        location: `GitHubAPIBackend.deleteFile(${repoPath})`,
        nextSteps: ['Wait for GitHub API to recover'],
      });
    }

    const existingSha = await this.getFileSha(repoPath, ref);
    if (!existingSha) return; // File doesn't exist — no-op per StorageBackend contract

    const creds = await this.getCredsCached();
    if (!creds) throw this.noCredsError('deleteFile');

    const resp = await this.rest.request(creds, 'DELETE',
      `/repos/${creds.repo}/contents/${repoPath}`, {
        message: `Delete ${repoPath}`,
        sha: existingSha,
        branch: ref,
      });

    if (!resp.ok && resp.status !== 404) {
      throw new ActionableError({
        goal: `Delete ${repoPath} from GitHub`,
        problem: `GitHub API returned ${resp.status}: ${resp.error}`,
        location: `GitHubAPIBackend.deleteFile(${repoPath})`,
        nextSteps: ['Check GitHub API status', 'Retry the operation'],
      });
    }

    // Write-through: remove from cache after confirmed deletion
    await this.removeFromDiskCache(repoPath);
  }

  async fileExists(filePath: string, opts?: { ref?: string }): Promise<boolean> {
    const repoPath = this.toRepoPath(filePath);
    const effectiveRef = this.getEffectiveRef();
    const ref = this.resolveReadRef(opts?.ref) ?? effectiveRef;

    // Check session overlay — only when this call isn't pinned away from the
    // session's own ref (t/4428#2 condition 1). An explicit opts.ref that
    // differs from the effective ref is asking for that ref's real content,
    // and answering from this session's overlay would defeat the pin.
    const existsUserId = this.getEffectiveUserId();
    if (ref === effectiveRef && effectiveRef !== this.baseBranch && existsUserId) {
      const overlayVal = await this.readEffectiveOverlayEntry(existsUserId, repoPath);
      if (overlayVal !== undefined) return overlayVal !== GitHubAPIBackend.TOMBSTONE;
    }

    // t/4428: the disk-cache manifest and in-memory repoTree represent
    // `baseBranch` only — same reasoning as t/4215/t/4393's "a session read
    // must not fall through to main's cache." A ref other than baseBranch
    // (explicit pin or active session) always goes straight to the
    // Contents-API fallback below, which resolves the real ref.
    if (ref === this.baseBranch && await this.fileExistsInBaseBranchCache(repoPath)) return true;

    // t/4179 R3: a non-holder never falls through to the per-call Contents
    // API below — same reasoning as listDirectory.
    if (!this.mayFallBackToContentsApi()) return false;
    return this.fileExistsViaContentsApi(repoPath, ref);
  }

  /** Extracted from fileExists() to keep its own complexity under budget.
   *  `baseBranch`-only: manifest, then the in-memory tree (file or directory). */
  private async fileExistsInBaseBranchCache(repoPath: string): Promise<boolean> {
    if (this.manifest?.files[repoPath]) return true;

    if (this.repoTree.size === 0 && this.blobLease) await this.ensureRepoTreeFilled();

    if (this.repoTree.has(repoPath)) return true;

    if (this.repoTree.size > 0) {
      const prefix = repoPath + '/';
      for (const [p] of this.repoTree) {
        if (p.startsWith(prefix)) return true;
      }
    }
    return false;
  }

  /** Extracted from fileExists() to keep its own complexity under budget. */
  private async fileExistsViaContentsApi(repoPath: string, ref: string): Promise<boolean> {
    if (this.rest.isTripped()) return false;

    const creds = await this.getCredsCached();
    if (!creds) return false;

    const qRef = ref === this.baseBranch ? '' : `?ref=${encodeURIComponent(ref)}`;
    const resp = await this.rest.request(creds, 'HEAD',
      `/repos/${creds.repo}/contents/${repoPath}${qRef}`);
    return resp.ok;
  }

  // ── GitHub-specific methods ────────────────────────────────────────────

  async getLatestCommitSha(): Promise<string> {
    const creds = await this.getCredsCached();
    if (!creds) return '';

    const resp = await this.rest.request(creds, 'GET',
      `/repos/${creds.repo}/commits/${this.baseBranch}`);
    if (!resp.ok) return '';

    return (resp.data as { sha: string }).sha;
  }

  async getChangedFiles(fromSha: string, toSha: string): Promise<string[]> {
    const creds = await this.getCredsCached();
    if (!creds) return [];

    const resp = await this.rest.request(creds, 'GET',
      `/repos/${creds.repo}/compare/${fromSha}...${toSha}`);

    if (!resp.ok) {
      // Force-push detection: 404 or 422 means cached SHA no longer in history
      if (resp.status === 404 || resp.status === 422) {
        this.recordEvent({
          type: 'cache.invalidate',
          component: 'cache',
          level: 'warn',
          message: 'Force push detected — cached SHA not in history. Full cache invalidation.',
          data: { fromSha, toSha, trigger: 'force-push' },
        });
        await this.fullCacheInvalidation();
      }
      return [];
    }

    const data = resp.data as { files?: Array<{ filename: string }> };
    return (data.files ?? []).map(f => f.filename);
  }

  async getTree(sha: string, recursive?: boolean): Promise<TreeEntry[]> {
    const creds = await this.getCredsCached();
    if (!creds) return [];

    const q = recursive ? '?recursive=1' : '';
    const resp = await this.rest.request(creds, 'GET',
      `/repos/${creds.repo}/git/trees/${sha}${q}`);

    if (!resp.ok) return [];

    // t/470: an OK response with no body, or without a tree array, is a failed load, not a throw.
    // Callers already treat [] as "no tree" (the same answer as !resp.ok).
    const data = resp.data as { tree?: unknown; truncated?: boolean } | null | undefined;
    if (!data || !Array.isArray(data.tree)) {
      log.github.warn({ sha, status: resp.status, bodyType: data === null ? 'null' : typeof data },
        'getTree: OK response without a tree array; treating it as a failed load (t/470)');
      return [];
    }
    const tree = data.tree as TreeEntry[];
    if (data.truncated) {
      this.recordEvent({
        type: 'system.scaling_warning',
        component: 'github-api',
        level: 'warn',
        message: 'Git Trees API returned truncated result (>100,000 entries)',
        data: { sha, entryCount: tree.length },
      });
    }
    return tree;
  }

  // ── Batched blob reads (t/4499, TL design t/4499#18) ────────────────────

  private static readonly BATCH_CHUNK_SIZE = 80;
  /** t/4499#24/#25: at ~925 summary files this is ~12 chunks. 8 ran them in
   *  2 serial waves, leaving `batchFetchMs` ~2x a single wave's latency and
   *  missing the <3s scale-to-zero target in 2/3 measured samples. 16 covers
   *  a cold-start's ~12 chunks in one wave; `graphqlCost` stayed a cheap 12
   *  points total across every measured build, so this doesn't meaningfully
   *  change GitHub's rate-limit exposure — same call count, less serialized. */
  private static readonly BATCH_CHUNK_CONCURRENCY = 16;

  /**
   * t/4499: batched content read for many files on one ref via GitHub's
   * GraphQL API, replacing N individual Contents-API round trips with
   * ~N/80 GraphQL queries (one aliased `object(expression:...)` field per
   * path, chunked to keep a single query a reasonable size). REST has no
   * "get N blobs" verb; a repo tarball can't be scoped to a subtree and
   * would pull the whole ~410MB data repo to read a few hundred summaries
   * (ruled out, t/4499#18).
   *
   * Returns only the paths that resolved to a real, non-truncated blob —
   * a path missing from `contents` (chunk failure, null object, or
   * `isTruncated: true` — GraphQL's blob `text` has a size ceiling) is the
   * caller's job to read itself via `readFile`, never a throw from here.
   * `fallbackCount` is that absence count; `graphqlCost` is the summed
   * GraphQL point cost (a separate budget from REST's 5000/hr), for the
   * caller to log alongside its own phase timing.
   */
  async readFilesBatch(
    filePaths: string[], opts?: { ref?: string },
  ): Promise<{ contents: Map<string, string>; fallbackCount: number; graphqlCost: number }> {
    const contents = new Map<string, string>();
    if (filePaths.length === 0) return { contents, fallbackCount: 0, graphqlCost: 0 };

    const creds = await this.getCredsCached();
    if (!creds) return { contents, fallbackCount: filePaths.length, graphqlCost: 0 };

    const ref = this.resolveReadRef(opts?.ref) ?? this.getEffectiveRef();
    const [owner, name] = creds.repo.split('/');
    // repoPath (the GraphQL expression's path) <-> the caller's original
    // absolute filePath, so the result map is keyed the same way callers
    // pass paths in — same convention as readFile's repoPath/filePath split.
    const byRepoPath = new Map(filePaths.map(fp => [this.toRepoPath(fp), fp]));
    const repoPaths = [...byRepoPath.keys()];

    const chunks: string[][] = [];
    for (let i = 0; i < repoPaths.length; i += GitHubAPIBackend.BATCH_CHUNK_SIZE) {
      chunks.push(repoPaths.slice(i, i + GitHubAPIBackend.BATCH_CHUNK_SIZE));
    }

    let graphqlCost = 0;
    await mapWithLimit(chunks, GitHubAPIBackend.BATCH_CHUNK_CONCURRENCY, async (chunk) => {
      const chunkResult = await this.fetchBlobChunk(creds, owner, name, ref, chunk);
      graphqlCost += chunkResult.cost;
      for (const [repoPath, text] of chunkResult.texts) {
        const fp = byRepoPath.get(repoPath);
        if (fp !== undefined) contents.set(fp, text);
      }
    });

    const fallbackCount = filePaths.length - contents.size;
    if (fallbackCount > 0) {
      this.recordEvent({
        type: 'system.error', component: 'github-api', level: 'warn',
        message: `readFilesBatch: ${fallbackCount}/${filePaths.length} paths fell back to per-file read (chunk failure, null or truncated blob)`,
        data: { requested: filePaths.length, fallbackCount, graphqlCost },
      });
      log.github.warn({ requested: filePaths.length, fallbackCount, graphqlCost },
        'readFilesBatch: some paths fell back to per-file read');
    }
    return { contents, fallbackCount, graphqlCost };
  }

  /** GraphQL variables can't parameterize a per-field `expression` string
   *  (each alias needs its own literal), so every path is inlined directly
   *  — escaped, since paths come from a `listDirectory()` result, not a
   *  fixed literal. Owner/repo come from the backend's own resolved creds,
   *  never user input. */
  private buildBatchQuery(
    owner: string, name: string, ref: string, repoPaths: string[],
  ): { query: string; aliasToPath: Map<string, string> } {
    const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const aliasToPath = new Map<string, string>();
    const fields = repoPaths.map((p, i) => {
      const alias = `b${i}`;
      aliasToPath.set(alias, p);
      return `${alias}: object(expression: "${esc(`${ref}:${p}`)}") { ... on Blob { text isTruncated } }`;
    }).join('\n        ');
    const query = `query {
      repository(owner: "${esc(owner)}", name: "${esc(name)}") {
        ${fields}
      }
      rateLimit { cost }
    }`;
    return { query, aliasToPath };
  }

  private async fetchBlobChunk(
    creds: SyncCredentials, owner: string, name: string, ref: string, repoPaths: string[],
  ): Promise<{ texts: Map<string, string>; cost: number }> {
    const texts = new Map<string, string>();
    const { query, aliasToPath } = this.buildBatchQuery(owner, name, ref, repoPaths);

    let resp: ApiResult;
    try {
      resp = await this.rest.request(creds, 'POST', '/graphql', { query });
    } catch (err) {
      log.github.warn({ chunkSize: repoPaths.length, error: normalizeErrorForEvent(err) },
        'readFilesBatch: GraphQL chunk request threw — this chunk falls back to per-file read');
      this.recordEvent({
        type: 'system.error', component: 'github-api', level: 'warn',
        message: 'readFilesBatch: GraphQL chunk request threw — this chunk falls back to per-file read',
        data: { chunkSize: repoPaths.length },
        error: normalizeErrorForEvent(err),
      });
      return { texts, cost: 0 };
    }
    if (!resp.ok) {
      this.recordEvent({
        type: 'system.error', component: 'github-api', level: 'warn',
        message: `readFilesBatch: GraphQL chunk request failed (${resp.status}) — this chunk falls back to per-file read`,
        data: { chunkSize: repoPaths.length, status: resp.status, error: resp.error },
      });
      return { texts, cost: 0 };
    }

    const body = resp.data as {
      data?: { repository?: Record<string, { text?: string; isTruncated?: boolean } | null>; rateLimit?: { cost: number } };
      errors?: Array<{ message: string }>;
    };
    if (body.errors && body.errors.length > 0) {
      this.recordEvent({
        type: 'system.error', component: 'github-api', level: 'warn',
        message: `readFilesBatch: GraphQL chunk returned ${body.errors.length} error(s) alongside any data`,
        data: { chunkSize: repoPaths.length, errors: body.errors.slice(0, 5).map(e => e.message) },
      });
    }

    const repoData = body.data?.repository;
    if (repoData) {
      for (const [alias, p] of aliasToPath) {
        const blob = repoData[alias];
        if (blob && typeof blob.text === 'string' && !blob.isTruncated) texts.set(p, blob.text);
      }
    }
    return { texts, cost: body.data?.rateLimit?.cost ?? 0 };
  }

  async createBranch(name: string, fromSha?: string): Promise<void> {
    const creds = await this.getCredsCached();
    if (!creds) throw this.noCredsError('createBranch');

    const sha = fromSha ?? await this.getLatestCommitSha();
    const callId = crypto.randomUUID();

    const resp = await this.rest.request(creds, 'POST',
      `/repos/${creds.repo}/git/refs`, {
        ref: `refs/heads/${name}`,
        sha,
      }, callId);

    if (!resp.ok && resp.status !== 422) {
      // 422 = branch already exists — not an error
      throw new ActionableError({
        goal: `Create branch ${name}`,
        problem: `GitHub API returned ${resp.status}: ${resp.error}`,
        location: `GitHubAPIBackend.createBranch(${name})`,
        nextSteps: ['Check if the branch already exists', 'Verify GitHub App permissions'],
      });
    }

    this.recordEvent({
      type: 'branch.create',
      component: 'session',
      level: 'info',
      message: `Branch created: ${name}`,
      call_id: callId,
      data: { branch: name, fromSha: sha, userId: this.getEffectiveUserId() },
    });
  }

  async createCommitFromTree(
    branch: string,
    files: FileChange[],
    message: string,
  ): Promise<string> {
    const creds = await this.getCredsCached();
    if (!creds) throw this.noCredsError('createCommitFromTree');

    const callId = crypto.randomUUID();
    const startMs = Date.now();

    // Step 1: Get current branch ref
    const refResp = await this.rest.request(creds, 'GET',
      `/repos/${creds.repo}/git/refs/heads/${branch}`, undefined, callId);
    if (!refResp.ok) {
      throw new ActionableError({
        goal: `Batch commit to ${branch}`,
        problem: `Failed to get branch ref: ${refResp.status} ${refResp.error}`,
        location: `GitHubAPIBackend.createCommitFromTree step 1`,
        nextSteps: ['Verify branch exists', 'Check GitHub App permissions'],
      });
    }
    const currentSha = ((refResp.data as { object: { sha: string } }).object).sha;

    // Step 2: Create tree with changed files
    const treeEntries = files.map(f => ({
      path: f.path,
      mode: '100644' as const,
      type: 'blob' as const,
      content: f.content,
    }));
    const treeResp = await this.rest.request(creds, 'POST',
      `/repos/${creds.repo}/git/trees`, {
        base_tree: currentSha,
        tree: treeEntries,
      }, callId);
    if (!treeResp.ok) {
      throw new ActionableError({
        goal: `Batch commit to ${branch}`,
        problem: `Failed to create tree: ${treeResp.status} ${treeResp.error}`,
        location: `GitHubAPIBackend.createCommitFromTree step 2`,
        nextSteps: ['Check file paths and content', 'Verify GitHub App permissions'],
      });
    }
    const newTreeSha = (treeResp.data as { sha: string }).sha;

    // Step 3: Create commit pointing to new tree
    const commitResp = await this.rest.request(creds, 'POST',
      `/repos/${creds.repo}/git/commits`, {
        message,
        tree: newTreeSha,
        parents: [currentSha],
      }, callId);
    if (!commitResp.ok) {
      throw new ActionableError({
        goal: `Batch commit to ${branch}`,
        problem: `Failed to create commit: ${commitResp.status} ${commitResp.error}`,
        location: `GitHubAPIBackend.createCommitFromTree step 3`,
        nextSteps: ['Retry the operation — dangling tree is harmless'],
      });
    }
    const commitSha = (commitResp.data as { sha: string }).sha;

    // Step 4: Update branch ref
    const updateResp = await this.rest.request(creds, 'PATCH',
      `/repos/${creds.repo}/git/refs/heads/${branch}`, {
        sha: commitSha,
        force: false,
      }, callId);
    if (!updateResp.ok) {
      throw new ActionableError({
        goal: `Batch commit to ${branch}`,
        problem: `Failed to update branch ref: ${updateResp.status} ${updateResp.error}`,
        location: `GitHubAPIBackend.createCommitFromTree step 4`,
        nextSteps: ['Retry — tree and commit are already created', 'Check for concurrent updates'],
      });
    }

    const durationMs = Date.now() - startMs;
    this.recordEvent({
      type: 'branch.commit',
      component: 'session',
      level: 'info',
      message: `Batch commit to ${branch}: ${files.length} files`,
      call_id: callId,
      duration_ms: durationMs,
      data: { branch, fileCount: files.length, commitSha, durationMs },
    });

    return commitSha;
  }

  /**
   * Flush all pending overlay entries for a user to GitHub via Trees API batch commit.
   * Handles both writes and deletes (tombstones). Clears the overlay only on success.
   * Returns { commitSha, filesCommitted } or null if no pending changes.
   */
  async commitOverlay(
    userId: string, message?: string, opts?: { branchName?: string },
  ): Promise<{ commitSha: string; filesCommitted: number; conflictedPaths?: string[] } | null> {
    // t/4258/t/4277 (C2): a commit already queued-but-not-started for this
    // user absorbs this trigger — join its promise instead of racing a
    // second PATCH /git/refs/heads/<branch> against it. A commit already
    // *running* gets its follow-up queued on commitChain, so this trigger's
    // own pending writes still get committed, just serialized after it.
    const pending = this.commitPending.get(userId);
    if (pending) return pending.promise;

    let resolve!: (result: { commitSha: string; filesCommitted: number; conflictedPaths?: string[] } | null) => void;
    let reject!: (err: unknown) => void;
    const promise = new Promise<{ commitSha: string; filesCommitted: number; conflictedPaths?: string[] } | null>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.commitPending.set(userId, { promise, resolve, reject });

    const prevChain = this.commitChain.get(userId) ?? Promise.resolve();
    const nextChain = prevChain.then(() => {
      // This run now owns the batch — any call from here on starts a new,
      // separately-queued follow-up rather than joining this one. No try/catch
      // here: commitOverlayGuarded already records its own failure (ADR-003)
      // before rethrowing — this is pure promise-settlement plumbing for the
      // manual Promise wrapper above, not a new error path to record.
      this.commitPending.delete(userId);
      return this.commitOverlayGuarded(userId, message, opts?.branchName).then(resolve, reject);
    });
    this.commitChain.set(userId, nextChain);

    return promise;
  }

  private async commitOverlayGuarded(
    userId: string, message?: string, branchName?: string,
  ): Promise<{ commitSha: string; filesCommitted: number; conflictedPaths?: string[] } | null> {
    try {
      return await this.commitOverlayImpl(userId, message, branchName);
    } catch (err) {
      const summary = this.uncommittedOverlaySummary().filter(s => s.userId === userId);
      const warnMsg = `commitOverlay failed for ${userId} — overlay entries remain uncommitted (t/4258)`;
      log.storage.warn({ summary }, warnMsg);
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'storage',
        level: 'warn',
        message: warnMsg,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        data: { summary },
      });
      throw err;
    }
  }

  private async commitOverlayImpl(
    userId: string, message?: string, branchName?: string,
  ): Promise<{ commitSha: string; filesCommitted: number; conflictedPaths?: string[] } | null> {
    // t/550: with shared state active the local map is only a read cache, so its being empty says nothing.
    const entries = this.getOverlayEntries(userId);
    if (!entries && !this.sharedSavesActive(userId)) return null;

    // t/4258/t/4277 (C3a): an explicit branchName is required for callers
    // running outside request scope (a debounced commit timer, a SIGTERM
    // flush) — getEffectiveRef()'s AsyncLocalStorage lookup only resolves
    // inside the request that set it, so a setTimeout callback would
    // silently fall back to baseBranch and hit the guard below on every
    // scheduled commit in production.
    const branch = branchName ?? this.getEffectiveRef();
    if (branch === this.baseBranch) {
      throw new ActionableError({
        goal: 'Commit overlay to GitHub',
        problem: `Cannot commit overlay to base branch '${this.baseBranch}'.`,
        location: 'GitHubAPIBackend.commitOverlay',
        nextSteps: ['Ensure a session branch is active'],
      });
    }
    // t/550: with shared state active the batch comes from the shared store, under the per-user commit lease.
    if (this.sharedSavesActive(userId)) return this.commitSharedOverlay(userId, branch, message);

    const creds = await this.getCredsCached();
    if (!creds) throw this.noCredsError('commitOverlay');

    const callId = crypto.randomUUID();
    const startMs = Date.now();

    // Step 1: Get current branch ref
    const refResp = await this.rest.request(creds, 'GET',
      `/repos/${creds.repo}/git/refs/heads/${branch}`, undefined, callId);
    if (!refResp.ok) {
      throw new ActionableError({
        goal: `Commit overlay to ${branch}`,
        problem: `Failed to get branch ref: ${refResp.status} ${refResp.error}`,
        location: 'GitHubAPIBackend.commitOverlay step 1',
        nextSteps: ['Verify branch exists', 'Check GitHub App permissions'],
      });
    }
    const currentSha = ((refResp.data as { object: { sha: string } }).object).sha;

    // t/4312 (SO condition F2, e/333#2 — TL ruling p/538#94): all-or-nothing
    // per batch. A per-path base-sha fence that only excluded the conflicting
    // paths could leave git cross-file-inconsistent (e.g. a POV file commits
    // while the edges file it's referenced from conflicts and stays out) —
    // durability doesn't need a partial commit, since everything stays
    // staged either way. Any conflict means nothing commits this round.
    if (!entries) return null; // unreachable: the shared path returned above, and a local commit needs entries
    const { conflictedPaths } = await this.partitionOverlayEntriesByBase(creds, userId, entries, currentSha, callId);
    if (conflictedPaths.length > 0) {
      this.recordOverlayConflicts(userId, branch, conflictedPaths);
      this.sessionOverlayConflicts.set(userId, new Set(conflictedPaths)); // t/4312 SO F1: resolvable via discard/rebase below
      return { commitSha: currentSha, filesCommitted: 0, conflictedPaths };
    }
    this.sessionOverlayConflicts.delete(userId); // t/4312 SO F1: a clean commit clears any stale conflict record

    // Step 2: Create tree with writes + deletes
    const treeEntries = this.buildOverlayTreeEntries(entries);
    const commitMsg = message || this.buildOverlayCommitMessage(entries);
    const commitSha = await this.createTreeCommitAndUpdateRef(creds, branch, currentSha, treeEntries, commitMsg, callId);

    const filesCommitted = entries.writes.length + entries.deletes.length;
    const durationMs = Date.now() - startMs;
    this.recordEvent({
      type: 'overlay.commit',
      component: 'session',
      level: 'info',
      message: `Overlay committed to ${branch}: ${entries.writes.length} writes, ${entries.deletes.length} deletes`,
      call_id: callId,
      duration_ms: durationMs,
      data: { branch, writes: entries.writes.length, deletes: entries.deletes.length, commitSha, durationMs },
    });

    // t/4215: populate the session read cache for free — we already have
    // the content and the new branch-head sha from this commit, so a plain
    // readFile() right after this doesn't need to go live at all.
    let readCache = this.sessionReadCache.get(userId);
    if (!readCache) { readCache = new Map(); this.sessionReadCache.set(userId, readCache); }
    for (const w of entries.writes) readCache.set(w.path, w.content);
    for (const d of entries.deletes) readCache.set(d, GitHubAPIBackend.TOMBSTONE);
    this.sessionReadCacheHeadSha.set(userId, {
      sha: commitSha, checkedAt: Date.now(), checkedAtActivitySeq: this.sessionWriteActivitySeq.get(userId) ?? 0,
    });

    // Clear overlay only on success (Tech Lead note #2), and only the
    // entries this commit actually captured (t/4258/t/4277 C1) — anything
    // written during the awaits above stays staged for the next commit.
    // t/4312: also refreshes/clears sessionOverlayBaseShas (conditions 2/3).
    this.clearCommittedOverlayEntries(userId, entries);

    return { commitSha, filesCommitted };
  }

  async createOrUpdatePR(
    branch: string,
    title: string,
    body: string,
  ): Promise<{ number: number; url: string }> {
    const creds = await this.getCredsCached();
    if (!creds) throw this.noCredsError('createOrUpdatePR');

    // Check if PR already exists for this branch
    const listResp = await this.rest.request(creds, 'GET',
      `/repos/${creds.repo}/pulls?head=${encodeURIComponent(creds.repo.split('/')[0])}:${branch}&state=open`);

    if (listResp.ok && Array.isArray(listResp.data) && (listResp.data as unknown[]).length > 0) {
      const existing = (listResp.data as Array<{ number: number; html_url: string }>)[0];
      // Update existing PR
      const updateResp = await this.rest.request(creds, 'PATCH',
        `/repos/${creds.repo}/pulls/${existing.number}`, { title, body });

      this.recordEvent({
        type: 'sync.pr.update',
        component: 'session',
        level: 'info',
        message: `PR #${existing.number} updated`,
        data: { number: existing.number, branch },
      });
      return { number: existing.number, url: updateResp.ok ? existing.html_url : existing.html_url };
    }

    // Create new PR
    const resp = await this.rest.request(creds, 'POST',
      `/repos/${creds.repo}/pulls`, {
        title,
        body,
        head: branch,
        base: this.baseBranch,
      });

    if (!resp.ok) {
      throw new ActionableError({
        goal: `Create PR from ${branch}`,
        problem: `GitHub API returned ${resp.status}: ${resp.error}`,
        location: `GitHubAPIBackend.createOrUpdatePR(${branch})`,
        nextSteps: [`Check if branch has commits ahead of ${this.baseBranch}`, 'Verify GitHub App permissions'],
      });
    }

    const pr = resp.data as { number: number; html_url: string };
    this.recordEvent({
      type: 'sync.pr.create',
      component: 'session',
      level: 'info',
      message: `PR #${pr.number} created`,
      data: { number: pr.number, url: pr.html_url, branch },
    });
    return { number: pr.number, url: pr.html_url };
  }

  async compareBranches(base: string, head: string): Promise<CompareResult> {
    const creds = await this.getCredsCached();
    if (!creds) {
      return { ahead_by: 0, behind_by: 0, status: 'identical', files: [], total_commits: 0, merge_base_sha: null };
    }

    // t/505: callers pass the base-branch alias ('main') for either side. Compare against this
    // deployment's base branch, not a branch that happens to be called 'main'.
    const baseRef = this.resolveReadRef(base) ?? base;
    const headRef = this.resolveReadRef(head) ?? head;
    const resp = await this.rest.request(creds, 'GET',
      `/repos/${creds.repo}/compare/${baseRef}...${headRef}`);

    if (!resp.ok) {
      return { ahead_by: 0, behind_by: 0, status: 'identical', files: [], total_commits: 0, merge_base_sha: null };
    }

    const data = resp.data as {
      ahead_by: number;
      behind_by: number;
      status: string;
      files?: Array<{ filename: string; status: string; patch?: string }>;
      total_commits: number;
      merge_base_commit?: { sha?: string };
    };
    return {
      ahead_by: data.ahead_by,
      behind_by: data.behind_by,
      status: data.status as CompareResult['status'],
      files: (data.files ?? []).map(f => ({
        filename: f.filename,
        status: f.status,
        patch: f.patch,
      })),
      total_commits: data.total_commits,
      merge_base_sha: data.merge_base_commit?.sha ?? null,
    };
  }

  /**
   * Merge the base branch into the given branch via the GitHub Merges API.
   * Returns { ok, sha, conflicts } — conflicts true when the API returns 409.
   */
  async mergeBranch(
    branch: string,
    commitMessage?: string,
  ): Promise<{ ok: boolean; sha: string; conflicts: boolean; message: string }> {
    const creds = await this.getCredsCached();
    if (!creds) throw this.noCredsError('mergeBranch');

    const resp = await this.rest.request(creds, 'POST',
      `/repos/${creds.repo}/merges`, {
        base: branch,
        head: this.baseBranch,
        commit_message: commitMessage ?? `Merge ${this.baseBranch} into ${branch}`,
      });

    if (resp.status === 409) {
      this.recordEvent({
        type: 'sync.conflict', component: 'session', level: 'warn',
        message: `Merge conflict: ${this.baseBranch} into ${branch}`,
        data: { branch },
      });
      return { ok: false, sha: '', conflicts: true, message: 'Merge conflict — resolve on GitHub' };
    }

    if (resp.status === 204) {
      // 204 = already up to date (no merge needed)
      return { ok: true, sha: '', conflicts: false, message: 'Already up to date' };
    }

    if (!resp.ok) {
      throw new ActionableError({
        goal: `Merge ${this.baseBranch} into ${branch}`,
        problem: `GitHub API returned ${resp.status}: ${resp.error}`,
        location: `GitHubAPIBackend.mergeBranch(${branch})`,
        nextSteps: ['Check branch exists on GitHub', 'Verify GitHub App permissions'],
      });
    }

    const data = resp.data as { sha: string };

    // t/4224 (TL design, p/538#40): no baseline to refresh — getSessionBranchVersion()
    // reads the write/edit-load path live on every call, so a merge is covered there
    // without this method needing to know about it.
    //
    // t/4215: the plain-readFile cache is a different story — it IS filled by
    // this method's own content. The merge just moved the head to a tree we
    // don't have path-by-path deltas for, so drop the whole cache (next read
    // per path goes live and refills) and record the new head sha so the
    // revalidation window (SESSION_READ_CACHE_REVALIDATE_MS) resets too.
    const userId = this.getEffectiveUserId();
    if (userId) {
      this.sessionReadCache.delete(userId);
      this.sessionReadCacheHeadSha.set(userId, {
        sha: data.sha, checkedAt: Date.now(), checkedAtActivitySeq: this.sessionWriteActivitySeq.get(userId) ?? 0,
      });
    }

    return { ok: true, sha: data.sha, conflicts: false, message: `Merged main into ${branch}` };
  }

  // ── Path contract ──────────────────────────────────────────────────────

  private toRepoPath(filePath: string): string {
    const refuse = (code: string, problem: string): never => {
      throw new ActionableError({
        goal: 'Validate file path',
        problem,
        location: 'GitHubAPIBackend.toRepoPath',
        nextSteps: ['Use a clean repository-relative path inside the data root'],
        code,
        httpStatus: 400,
      });
    };
    // t/434: a NUL byte never belongs in a path; refuse before anything else looks at it.
    if (filePath.includes('\0')) refuse('INVALID_PATH', `Path contains a NUL byte: "${filePath}"`);

    // t/434: backslash is a separator for Windows callers; normalise before any check.
    let p = filePath.replace(/\\/g, '/');

    // Strip the data-root prefix to get the repo-relative path. Use getDataRoot()
    // (the actual source of incoming absolute paths from fileIO.ts) rather than
    // this.cacheDir (the disk-cache write location) — they can diverge when the
    // cache is on a separate mount (e.g. TAXONOMY_CACHE_DIR != AI_TRIAD_DATA_ROOT),
    // which caused staging github-api reads to 404 (t/2670).
    // t/434: match on a path-segment boundary (`<root>-evil/x` is not inside the root),
    // case-insensitively on win32, and refuse absolute, drive-letter and UNC paths outside it.
    const dataRoot = getDataRoot().replace(/\\/g, '/').replace(/\/+$/, '');
    const ci = process.platform === 'win32';
    const head = ci ? p.toLowerCase() : p;
    const rootCmp = ci ? dataRoot.toLowerCase() : dataRoot;
    if (dataRoot && (head === rootCmp || head.startsWith(rootCmp + '/'))) {
      p = p.slice(dataRoot.length);
    } else if (dataRoot && head.startsWith(rootCmp)) {
      refuse('PATH_OUTSIDE_ROOT', `Path shares the data-root name but is outside it: "${filePath}"`);
    } else if (/^[a-zA-Z]:/.test(p) || p.startsWith('//')) {
      refuse('PATH_OUTSIDE_ROOT', `Absolute, drive-letter or UNC path outside the data root rejected: "${filePath}"`);
    }

    // Strip leading slashes
    p = p.replace(/^\/+/, '');

    // Reject .git paths
    if (p === '.git' || p.startsWith('.git/')) {
      throw new ActionableError({
        goal: 'Validate file path',
        problem: `Path traversal into .git directory rejected: "${filePath}"`,
        location: 'GitHubAPIBackend.toRepoPath',
        nextSteps: ['Use a valid repository file path'],
      });
    }

    // Reject path traversal: `..` as a whole segment only (either separator), so a name such as
    // `foo..json` is a valid file name. confineToDir still keeps any in-root path inside the root.
    if (p.split(/[\\/]/).includes('..')) {
      throw new ActionableError({
        goal: 'Validate file path',
        problem: `Path traversal with ".." rejected: "${filePath}"`,
        location: 'GitHubAPIBackend.toRepoPath',
        nextSteps: ['Use an absolute or clean relative path'],
      });
    }

    return p;
  }

  // ── Manifest mutex ───────────────────────────────────────────────────

  /**
   * Serialize manifest mutations. Callers queue behind the previous holder;
   * the promise chain guarantees FIFO ordering and prevents concurrent
   * saveManifest() calls from stomping each other's .tmp file.
   */
  private async withManifestLock<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>(resolve => { release = resolve; });
    const prev = this.manifestLock;
    this.manifestLock = next;

    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  // ── Disk cache ─────────────────────────────────────────────────────────

  private async loadManifest(): Promise<void> {
    const manifestPath = path.join(this.cacheDir, MANIFEST_FILE);
    try {
      const raw = await fs.readFile(manifestPath, 'utf-8');
      const parsed = JSON.parse(raw);

      // Manifest checksum validation (t/465#4)
      if (!parsed || parsed.version !== 1 || !parsed.lastCommitSha ||
          !parsed.files || typeof parsed.generation !== 'number') {
        this.recordEvent({
          type: 'cache.invalidate',
          component: 'cache',
          level: 'warn',
          message: 'Manifest failed integrity check — treating as cold start',
          data: { reason: 'invalid-structure' },
        });
        this.manifest = null;
        return;
      }

      this.manifest = parsed as CacheManifest;
    } catch {
      /* telemetry — silent by design */
      // Missing or corrupt — cold start
      this.manifest = null;
    }
  }

  private async renameWithRetry(oldPath: string, newPath: string): Promise<void> {
    const maxRetries = 5;
    for (let i = 0; i <= maxRetries; i++) {
      try {
        await fs.rename(oldPath, newPath);
        return;
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if ((code === 'EPERM' || code === 'EACCES') && i < maxRetries) {
          const delayMs = 50 * Math.pow(2, i);
          this.recordEvent({
            type: 'io.retry', component: 'cache', level: 'warn',
            message: `rename failed (${code}), retry ${i + 1}/${maxRetries} after ${delayMs}ms`,
            data: { oldPath, newPath, attempt: i + 1, code, delayMs },
          });
          await new Promise(resolve => setTimeout(resolve, delayMs));
          continue;
        }
        getGlobalRecorder()?.record({
          type: 'system.error', component: 'github-api', level: 'error',
          message: `rename failed permanently (${code})`,
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
          data: { oldPath, newPath, code },
        });
        throw err;
      }
    }
  }

  private async saveManifest(): Promise<void> {
    if (!this.manifest) return;

    const manifestPath = path.join(this.cacheDir, MANIFEST_FILE);
    const tmpPath = manifestPath + '.tmp.' + crypto.randomBytes(8).toString('hex');
    const content = JSON.stringify(this.manifest, null, 2);

    await fs.writeFile(tmpPath, content, 'utf-8');
    await this.renameWithRetry(tmpPath, manifestPath);

    this.recordEvent({
      type: 'cache.manifest.swap',
      component: 'cache',
      level: 'info',
      message: 'Cache manifest updated',
      data: {
        generation: this.manifest.generation,
        fileCount: Object.keys(this.manifest.files).length,
        mainSha: this.manifest.lastCommitSha,
      },
    });
  }

  private async readFromDiskCache(repoPath: string): Promise<string | null> {
    if (!this.manifest?.files[repoPath]) return null;

    const diskPath = await confineToDir(this.cacheDir, repoPath);
    try {
      return await fs.readFile(diskPath, 'utf-8');
    } catch (err: unknown) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'github-api-backend', level: 'warn',
        message: 'readFromDiskCache: cache file unreadable, returning null (cache miss)',
        data: { repoPath, diskPath, error: String(err) },
      });
      return null;
    }
  }

  private async readBinaryFromDiskCache(repoPath: string): Promise<Buffer | null> {
    if (!this.manifest?.files[repoPath]) return null;

    const diskPath = await confineToDir(this.cacheDir, repoPath);
    try {
      return await fs.readFile(diskPath);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'github-api',
        level: 'warn',
        message: 'Failed to read binary file from disk cache',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      return null;
    }
  }

  private async writeToDiskCache(
    repoPath: string, content: string, sha: string, etag: string,
  ): Promise<void> {
    try {
      const diskPath = await confineToDir(this.cacheDir, repoPath);
      await fs.mkdir(path.dirname(diskPath), { recursive: true });

      const tmpPath = diskPath + '.tmp.' + crypto.randomBytes(8).toString('hex');
      await fs.writeFile(tmpPath, content, 'utf-8');
      await this.renameWithRetry(tmpPath, diskPath);

      await this.withManifestLock(async () => {
        if (!this.manifest) {
          this.manifest = {
            version: 1,
            generation: 1,
            lastCommitSha: '',
            lastUpdated: new Date().toISOString(),
            files: {},
          };
        }

        this.manifest.files[repoPath] = {
          sha,
          etag,
          cachedAt: new Date().toISOString(),
        };
        this.manifest.generation++;
        this.manifest.lastUpdated = new Date().toISOString();
        await this.saveManifest();
      });
    } catch (err) {
      // t/4298/t/4299: a disk-cache write-through is an optimization, not
      // the read it follows — staging's share went read-only (taxonomy-data-ro)
      // and this would otherwise crash a read that had already succeeded.
      // Warn and move on; the next read just misses the cache again.
      const message = `Disk cache write-through failed for ${repoPath} — serving the fetched content, but it won't be cached (t/4298/t/4299)`;
      log.storage.warn({ repoPath, error: String(err) }, message);
      this.recordEvent({
        type: 'storage.fallback',
        component: 'storage',
        level: 'warn',
        message,
        error: { name: (err as Error)?.name ?? 'Error', message: String(err), stack: (err as Error)?.stack },
        data: { repoPath },
      });
    }
  }

  private async writeBinaryToDiskCache(
    repoPath: string, content: Buffer, sha: string, etag: string,
  ): Promise<void> {
    try {
      const diskPath = await confineToDir(this.cacheDir, repoPath);
      await fs.mkdir(path.dirname(diskPath), { recursive: true });

      const tmpPath = diskPath + '.tmp.' + crypto.randomBytes(8).toString('hex');
      await fs.writeFile(tmpPath, content);
      await this.renameWithRetry(tmpPath, diskPath);

      await this.withManifestLock(async () => {
        if (!this.manifest) {
          this.manifest = {
            version: 1,
            generation: 1,
            lastCommitSha: '',
            lastUpdated: new Date().toISOString(),
            files: {},
          };
        }

        this.manifest.files[repoPath] = {
          sha,
          etag,
          cachedAt: new Date().toISOString(),
        };
        this.manifest.generation++;
        this.manifest.lastUpdated = new Date().toISOString();
        await this.saveManifest();
      });
    } catch (err) {
      // t/4298/t/4299: see writeToDiskCache's catch — a write-through cache
      // failure must never crash the read it follows.
      const message = `Disk cache write-through failed for ${repoPath} — serving the fetched content, but it won't be cached (t/4298/t/4299)`;
      log.storage.warn({ repoPath, error: String(err) }, message);
      this.recordEvent({
        type: 'storage.fallback',
        component: 'storage',
        level: 'warn',
        message,
        error: { name: (err as Error)?.name ?? 'Error', message: String(err), stack: (err as Error)?.stack },
        data: { repoPath },
      });
    }
  }

  private async removeFromDiskCache(repoPath: string): Promise<void> {
    const diskPath = await confineToDir(this.cacheDir, repoPath);
    try {
      await fs.unlink(diskPath);
    } catch {
      /* telemetry — silent by design */
      // Ignore missing file
    }

    await this.withManifestLock(async () => {
      if (this.manifest?.files[repoPath]) {
        delete this.manifest.files[repoPath];
        this.manifest.generation++;
        this.manifest.lastUpdated = new Date().toISOString();
        await this.saveManifest();
      }
    });
  }

  private getCachedEtag(pathAndQuery: string): string | null {
    if (!this.manifest) return null;
    // Extract repo path and an explicit ?ref= from the API endpoint.
    const match = pathAndQuery.match(/\/contents\/(.+?)(\?|$)/);
    if (!match) return null;
    // t/4258/t/4295: the manifest/disk cache this etag was recorded from is
    // main-only (writeToDiskCache/writeBinaryToDiskCache) — reusing it for a
    // session-branch GET on the same path is wrong whenever the branch's
    // content happens to equal main's (the common case right after a branch
    // is created). GitHub legitimately 304s, and nothing downstream has a
    // branch-scoped body to fall back on, so scope the cache to main/no ref.
    const refMatch = pathAndQuery.match(/[?&]ref=([^&]*)/);
    const ref = refMatch ? decodeURIComponent(refMatch[1]) : this.baseBranch;
    if (ref !== this.baseBranch) return null;
    const entry = this.manifest.files[match[1]];
    return entry?.etag || null;
  }

  // ── GitHub file operations (low-level) ─────────────────────────────────

  /** t/4584/t/4586: classifies a non-2xx Contents-API response — logs the
   *  reason unconditionally, and additionally throws when `strict` and the
   *  status isn't a genuine 404 — pulled out of `fetchFileFromGitHub` to
   *  keep that method's own complexity in budget (local/complexity-budget).
   *  403/429 (TL t/4584#4, confirmed root cause) is GitHub's shared
   *  installation rate limit exhausted, not a generic refusal, so it gets
   *  its own reason rather than falling into the generic `status=<n>`. */
  /** t/463 (log-only): on a 404 from the contents API, record what GitHub said, so the
   *  not_found reason is readable in the logs. Pulled out of fetchFileFromGitHub for the
   *  complexity budget. No behaviour change: callers still get the same null. */
  private logContents404Detail(resp: ApiResult, repoPath: string, endpoint: string, ref: string, credentialMode: string): void {
    if (resp.status !== 404) return;
    const body = (resp.data && typeof resp.data === 'object') ? resp.data as Record<string, unknown> : {};
    log.github.warn({
      path: repoPath,
      endpoint,
      ref,
      status: resp.status,
      githubMessage: typeof body.message === 'string' ? body.message : null,
      documentationUrl: typeof body.documentation_url === 'string' ? body.documentation_url : null,
      apiError: resp.error ?? null,
      credentialMode,
    }, 'fetchFileFromGitHub: contents 404 detail (t/463 log-only)');
  }

  private classifyNonOkContentsResponse(resp: ApiResult, repoPath: string, optional: boolean | undefined, strict: boolean): void {
    if (resp.status === 404) {
      this.logNullReadReason(repoPath, 'not_found', optional);
      return;
    }
    const reason: NullReadReason = (resp.status === 403 || resp.status === 429) ? 'rate_limited' : `status=${resp.status}`;
    this.logNullReadReason(repoPath, reason, optional);
    if (strict) {
      throw Object.assign(new Error(`GitHub API returned ${resp.status} for ${repoPath} — transient (${reason})`),
        { kind: 'transient' as const, status: resp.status, reason });
    }
  }

  /** t/4584/t/4586: pulled out of `fetchFileFromGitHub` for the same
   *  complexity-budget reason as `classifyNonOkContentsResponse`. */
  private handleMissingCreds(repoPath: string, optional: boolean | undefined, strict: boolean): void {
    this.logNullReadReason(repoPath, 'no_creds', optional);
    if (strict) {
      throw Object.assign(new Error(`GitHub App credentials unavailable — transient: ${repoPath}`), { kind: 'transient' as const, reason: 'no_creds' as const });
    }
  }

  // ── Raw-at-commit-SHA main reads (t/4585) ───────────────────────────────

  /** TL condition 1: a raw 404 for a path the tree already knows about must
   *  never collapse to "absent" — that's the exact t/4584 failure class.
   *  Mirrors `fileExistsInBaseBranchCache`'s own membership check (manifest
   *  file list, then the in-memory tree), without triggering a lazy
   *  `ensureRepoTreeFilled()` — an empty tree here just means "we can't
   *  confirm it exists," which keeps the conservative pre-t/4585 behavior
   *  (a 404 is `not_found`) rather than inventing a new default. */
  private isPathKnownInTree(repoPath: string): boolean {
    if (this.manifest?.files[repoPath]) return true;
    return this.repoTree.has(repoPath);
  }

  /** t/4615 (TL edge case, t/4585#6): a file added to main after the
   *  manifest's `lastCommitSha` is "not in tree" by construction — the
   *  in-memory tree and raw's pinned commit SHA both predate it — until the
   *  next poll cycle refreshes the manifest. A stale manifest can't vouch
   *  for a path's absence, so once it's older than the poll interval, "not
   *  in tree" stops being trusted as a genuine `not_found` (see the 404
   *  branch in `fetchFileFromRaw`). No manifest timestamp at all (a
   *  cold-cold boot) is treated as stale too — nothing to vouch with. */
  private isManifestStale(): boolean {
    if (!this.manifest?.lastUpdated) return true;
    return Date.now() - new Date(this.manifest.lastUpdated).getTime() > this.pollIntervalMs;
  }

  /** TL condition 3: bounds raw's own concurrency (8 in flight) so a cold
   *  boot's ~1,000 near-simultaneous reads don't fire that many
   *  unauthenticated requests at raw.githubusercontent.com at once. */
  private async acquireRawSlot(): Promise<void> {
    if (this.rawInFlight < GitHubAPIBackend.RAW_CONCURRENCY_LIMIT) {
      this.rawInFlight++;
      return;
    }
    await new Promise<void>((resolve) => this.rawWaiters.push(resolve));
    this.rawInFlight++;
  }

  private releaseRawSlot(): void {
    this.rawInFlight--;
    const next = this.rawWaiters.shift();
    if (next) next();
  }

  /** t/497: read the data repo's visibility with the installation token (api.github.com only). Never
   *  throws. A failed or unreadable answer leaves the visibility unknown, which means "try raw as
   *  today": skipping raw is only ever a quota saving, so it needs a positive answer. Single flight. */
  private refreshRepoVisibility(trigger: 'startup' | 'ttl' | 'raw-404'): Promise<void> {
    if (this.repoVisibilityInFlight) return this.repoVisibilityInFlight;
    this.repoVisibilityLastAttemptAt = Date.now();
    this.repoVisibilityInFlight = (async () => {
      try {
        const creds = await this.getCredsCached();
        if (!creds) { this.repoVisibility = null; return; }
        // optional: a 404 here (a token without metadata access, or a test double) is not an API error.
        const resp = await this.rest.request(creds, 'GET', `/repos/${creds.repo}`, undefined, undefined, { optional: true });
        const data = resp.ok ? resp.data as { visibility?: unknown; private?: unknown } | null : null;
        const visibility = typeof data?.visibility === 'string' ? data.visibility
          : data?.private === false ? 'public' : data?.private === true ? 'private' : null;
        if (visibility === null) {
          this.repoVisibility = null;
          log.storage.info({ trigger, status: resp.status }, 'repo visibility: could not be read; raw fetch stays as it was (t/497)');
          return;
        }
        this.repoVisibility = { isPublic: visibility === 'public', visibility, checkedAt: Date.now() };
        if (this.repoVisibility.isPublic) this.rawSkipLogged = false;
        log.storage.info({ trigger, visibility }, 'repo visibility read (t/497)');
      } catch (err: unknown) {
        this.repoVisibility = null;
        // INFO, not WARN: nothing degrades. Unknown visibility is the behaviour before t/497 (try raw).
        log.storage.info({ trigger, errName: (err as Error)?.name ?? 'Error' }, 'repo visibility: read threw; raw fetch stays as it was (t/497)');
      } finally {
        this.repoVisibilityInFlight = null;
      }
    })();
    return this.repoVisibilityInFlight;
  }

  /** t/497: true only when the repo is known, from a read no older than the TTL, not to be public. */
  private async shouldSkipRawForPrivateRepo(): Promise<boolean> {
    const known = this.repoVisibility;
    if (!known) return false;
    if (Date.now() - known.checkedAt > GitHubAPIBackend.REPO_VISIBILITY_TTL_MS) await this.refreshRepoVisibility('ttl');
    return this.repoVisibility !== null && !this.repoVisibility.isPublic;
  }

  /** t/497: after a raw 404 for a path in the tree, re-read the visibility, at most once a minute. */
  private recheckRepoVisibilityAfterRaw404(): void {
    if (Date.now() - this.repoVisibilityLastAttemptAt < GitHubAPIBackend.REPO_VISIBILITY_MIN_RECHECK_MS) return;
    void this.refreshRepoVisibility('raw-404');
  }

  /** t/497: one WARN per process (and again after the repo is seen public and turns private). */
  private noteRawSkippedForPrivateRepo(): void {
    if (this.rawSkipLogged) return;
    this.rawSkipLogged = true;
    log.github.warn({ visibility: this.repoVisibility?.visibility ?? null },
      'fetchFileFromRaw: the data repo is not public, so the unauthenticated raw fetch is skipped; reads use the REST API (t/497)');
  }

  /** TL condition 1's disable guard: a fixed one-minute window counting
   *  every raw-fallback event, regardless of reason. Crossing the threshold
   *  trips `rawDisabled` for the rest of the process's lifetime (never
   *  re-enabled — a restart is the recovery path) so a broadly misbehaving
   *  raw endpoint (repo turned private, CDN outage) doesn't pay a raw miss
   *  on every single subsequent read. Also tallies `rawFallbackCounts` by
   *  reason (unconditionally, even after disable) so staging measurement
   *  can see 429s separately from other causes (TL condition 3).
   *  t/4615 (Quality follow-up): once `rawDisabled` is already tripped, the
   *  window/threshold check below is moot — the decision is permanent for
   *  this process. Still tallying `rawFallbackCounts['disabled']` (same
   *  never-reset convention as `coldCacheMissCount`), but skipping the
   *  window bookkeeping stops it growing forever for no purpose. */
  private recordRawFallback(reason: RawFallbackReason): void {
    this.rawFallbackCounts[reason] = (this.rawFallbackCounts[reason] ?? 0) + 1;
    if (this.rawDisabled) return;

    const now = Date.now();
    if (now - this.rawFallbackWindowStart > 60_000) {
      this.rawFallbackWindowStart = now;
      this.rawFallbackWindowCount = 0;
    }
    this.rawFallbackWindowCount++;
    // this.rawDisabled is always false here — the early return above skips
    // this whole block once it's true.
    if (this.rawFallbackWindowCount > GitHubAPIBackend.RAW_FALLBACK_DISABLE_THRESHOLD_PER_MINUTE) {
      this.rawDisabled = true;
      log.github.error({ counts: { ...this.rawFallbackCounts } },
        `fetchFileFromRaw: disabling raw reads for the rest of this process — more than ${GitHubAPIBackend.RAW_FALLBACK_DISABLE_THRESHOLD_PER_MINUTE} fallbacks in the last minute`);
      this.recordEvent({
        type: 'system.error', component: 'github-api', level: 'error',
        message: 'fetchFileFromRaw: raw reads disabled for process lifetime — fallback rate exceeded threshold',
        data: { counts: { ...this.rawFallbackCounts } },
      });
    }
  }

  /** t/4585 (TL design t/4585#2): main-pinned reads of the public data repo
   *  via `raw.githubusercontent.com/<repo>/<commitSha>/<path>` — pinning the
   *  commit SHA makes the content immutable, so no auth and no REST quota
   *  are spent. Tried before the REST circuit-breaker check (a different
   *  host/CDN, unaffected by GitHub REST's own circuit state). Never throws;
   *  any failure becomes `fallback` for the caller to retry via REST. */
  private async fetchFileFromRaw(repoPath: string, commitSha: string): Promise<RawFetchResult> {
    if (this.rawDisabled) return { kind: 'fallback', reason: 'disabled' };
    // t/497: a repo known not to be public would 404 here every time. Skip the request.
    if (await this.shouldSkipRawForPrivateRepo()) return { kind: 'fallback', reason: 'private_repo' };
    // t/372 (CodeQL #6275): encodeURIComponent leaves '.' and '..', and the URL parser
    // normalises them, so refuse dot-segments before the URL is built.
    if (repoPath.split('/').some(seg => seg === '.' || seg === '..')) {
      return { kind: 'fallback', reason: 'invalid_path' };
    }

    const creds = await this.getCredsCached();
    if (!creds) return { kind: 'fallback', reason: 'network_error' };

    const encodedPath = repoPath.split('/').map(encodeURIComponent).join('/');
    const url = `https://raw.githubusercontent.com/${creds.repo}/${commitSha}/${encodedPath}`;

    await this.acquireRawSlot();
    try {
      let res: Response;
      try {
        res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      } catch {
        // telemetry — silent by design here; the caller (readFileFromMainCache)
        // logs exactly one WARN for every `fallback` result, naming the reason
        // — a second record here would double-log the same event.
        return { kind: 'fallback', reason: 'network_error' };
      }

      if (res.status === 404) {
        // TL condition 1: a tree-known path 404ing on raw is never trusted
        // as a genuine absence — could be a renamed/moved CDN edge case, a
        // repo-visibility change, or raw misbehaving.
        if (this.isPathKnownInTree(repoPath)) {
          // t/497 (Security): an in-tree path that 404s on raw may mean the repo is no longer public.
          // Re-read the visibility in the background; this read falls back to REST either way.
          this.recheckRepoVisibilityAfterRaw404();
          return { kind: 'fallback', reason: 'raw_404_but_in_tree' };
        }
        // t/4615: an unknown path still isn't trustworthy as genuinely
        // absent if the manifest itself predates it (a just-added file,
        // not yet seen by the next poll) — only a FRESH manifest's silence
        // gets the fast, quiet "absent" answer.
        if (this.isManifestStale()) {
          return { kind: 'fallback', reason: 'raw_404_manifest_stale' };
        }
        return { kind: 'not_found' };
      }
      if (!res.ok) {
        return { kind: 'fallback', reason: res.status === 429 ? 'status=429' : `status=${res.status}` };
      }

      // TL condition 2: hash the ORIGINAL bytes, before any decode — a
      // decode-then-re-encode round trip (res.text()) can change bytes (a
      // BOM, an invalid UTF-8 sequence), desyncing the cached sha from
      // git's actual blob hash.
      const bytes = Buffer.from(await res.arrayBuffer());
      const sha = gitBlobSha(bytes);
      const content = bytes.toString('utf-8');
      return { kind: 'hit', content, sha };
    } finally {
      this.releaseRawSlot();
    }
  }

  /** t/478: the contents GET for a caller that needs the body. A conditional request is only valid when
   *  the caller has a body to serve on a 304, and no caller of fetchFileFromGitHub has one (each arrives
   *  after a cache miss, or on a strict read that skips the disk cache, t/4778). So a strict read sends
   *  no If-None-Match, and any 304 is repeated once without the ETag instead of being read as "absent".
   *  Before this, a manifest ETag made GitHub answer 304 and the file read as absent on every attempt.
   *  Returns null only when the 304 persists on a non-strict read; a strict read throws transient. */
  private async requestContentsBody(
    creds: SyncCredentials, endpoint: string, repoPath: string, ref: string,
    optional: boolean | undefined, strict: boolean,
  ): Promise<ApiResult | null> {
    if (strict) {
      log.github.info({ path: repoPath, ref, manifestEtagPresent: !!this.manifest?.files[repoPath]?.etag },
        'fetchFileFromGitHub: strict read goes to REST without If-None-Match (t/478)');
    }
    const first = await this.rest.request(creds, 'GET', endpoint,
      undefined, undefined, { optional: !!optional, unconditional: strict });
    if (first.status !== 304) return first;

    log.github.warn({ path: repoPath, ref, strict },
      'fetchFileFromGitHub: 304 with no cached body to serve; retrying once without If-None-Match (t/478)');
    const second = await this.rest.request(creds, 'GET', endpoint,
      undefined, undefined, { optional: !!optional, unconditional: true });
    if (second.status !== 304) return second;

    log.github.warn({ path: repoPath, ref, strict },
      'fetchFileFromGitHub: 304 again on an unconditional retry; the file could not be read (t/478)');
    if (strict) {
      throw Object.assign(new Error(`GitHub answered 304 to an unconditional read — transient: ${repoPath}`), { kind: 'transient' as const, reason: 'status=304' as const });
    }
    return null;
  }

  private async fetchFileFromGitHub(
    repoPath: string,
    ref: string,
    optional?: boolean,
    strict = false,
  ): Promise<{ content: string; sha: string; etag: string } | null> {
    const creds = await this.getCredsCached();
    if (!creds) { this.handleMissingCreds(repoPath, optional, strict); return null; }

    const qRef = ref === 'main' ? '' : `?ref=${encodeURIComponent(ref)}`;
    const endpoint = `/repos/${creds.repo}/contents/${repoPath}${qRef}`;
    const resp = await this.requestContentsBody(creds, endpoint, repoPath, ref, optional, strict);
    if (resp === null) return null;
    if (!resp.ok) {
      this.logContents404Detail(resp, repoPath, endpoint, ref, creds.mode);
      this.classifyNonOkContentsResponse(resp, repoPath, optional, strict);
      return null;
    }

    const data = resp.data as {
      content?: string;
      encoding?: string;
      sha: string;
      size?: number;
      type?: string;
    };

    // If it's a directory, return null (caller should use listDirectory)
    if (data.type === 'dir') return null;

    // Decode base64 content
    if (!data.content || data.encoding !== 'base64') {
      // Large file — use Blobs API
      if (data.sha && (data.size ?? 0) > 0) {
        return this.fetchBlobFromGitHub(creds, data.sha, resp.etag ?? '');
      }
      return null;
    }

    const content = Buffer.from(data.content, 'base64').toString('utf-8');
    return { content, sha: data.sha, etag: resp.etag ?? '' };
  }

  private async fetchBlobFromGitHub(
    creds: SyncCredentials,
    sha: string,
    etag: string,
  ): Promise<{ content: string; sha: string; etag: string } | null> {
    const resp = await this.rest.request(creds, 'GET',
      `/repos/${creds.repo}/git/blobs/${sha}`);

    if (!resp.ok) return null;

    const data = resp.data as { content: string; encoding: string; sha: string };
    const content = data.encoding === 'base64'
      ? Buffer.from(data.content, 'base64').toString('utf-8')
      : data.content;
    return { content, sha: data.sha, etag: resp.etag ?? etag };
  }

  private async fetchBinaryFileFromGitHub(
    repoPath: string,
    ref: string,
  ): Promise<{ content: Buffer; sha: string; etag: string } | null> {
    const creds = await this.getCredsCached();
    if (!creds) return null;

    const qRef = ref === 'main' ? '' : `?ref=${encodeURIComponent(ref)}`;
    const endpoint = `/repos/${creds.repo}/contents/${repoPath}${qRef}`;
    let resp = await this.rest.request(creds, 'GET', endpoint);

    // t/478 guard: this runs after a binary cache miss, so a 304 has no body to serve. Repeat once
    // without the ETag instead of returning null as "absent".
    if (resp.status === 304) {
      log.github.warn({ path: repoPath, ref },
        'fetchBinaryFileFromGitHub: 304 with no cached body to serve; retrying once without If-None-Match (t/478)');
      resp = await this.rest.request(creds, 'GET', endpoint, undefined, undefined, { unconditional: true });
    }
    if (resp.status === 304) {
      log.github.warn({ path: repoPath, ref },
        'fetchBinaryFileFromGitHub: 304 again on an unconditional retry; the file could not be read (t/478)');
      return null;
    }
    if (!resp.ok) return null;

    const data = resp.data as {
      content?: string;
      encoding?: string;
      sha: string;
      size?: number;
      type?: string;
    };

    if (data.type === 'dir') return null;

    if (!data.content || data.encoding !== 'base64') {
      if (data.sha && (data.size ?? 0) > 0) {
        return this.fetchBinaryRawFromGitHub(creds, repoPath, qRef, data.sha, resp.etag ?? '');
      }
      return null;
    }

    const content = Buffer.from(data.content, 'base64');
    return { content, sha: data.sha, etag: resp.etag ?? '' };
  }

  /** t/4286: for a file too large for the Contents API's inline `content` (>1MB),
   *  re-request the SAME Contents endpoint with the raw media type instead of the
   *  Git Blobs API (`/git/blobs/{sha}`) — GitHub serves raw bytes up to 100MB this
   *  way, with no JSON envelope and no base64. The Blobs API has no raw mode, so it
   *  always pays a `res.text()` + `JSON.parse()` pass (base64-in-JSON) followed by a
   *  SECOND synchronous `Buffer.from(..., 'base64')` decode — both over the full
   *  body, both unyielded. Confirmed as the ~700ms-class event-loop block on a cold
   *  read of the synthetic-embeddings .npy files (t/4286#25/#27/#28). One raw
   *  `res.arrayBuffer()` read in `GitHubRestClient.request()`'s `raw` path replaces
   *  both decodes with zero synchronous full-body passes. */
  private async fetchBinaryRawFromGitHub(
    creds: SyncCredentials,
    repoPath: string,
    qRef: string,
    sha: string,
    etag: string,
  ): Promise<{ content: Buffer; sha: string; etag: string } | null> {
    const resp = await this.rest.request(creds, 'GET',
      `/repos/${creds.repo}/contents/${repoPath}${qRef}`, undefined, undefined, { raw: true, unconditional: true });

    // t/478: a 304 is ok with null data; never return that as the file's bytes.
    if (!resp.ok || resp.status === 304) return null;

    return { content: resp.data as Buffer, sha, etag: resp.etag ?? etag };
  }

  private async getFileSha(repoPath: string, ref: string): Promise<string | null> {
    // Check manifest first
    if (this.manifest?.files[repoPath]) {
      return this.manifest.files[repoPath].sha;
    }

    // Check tree
    const entry = this.repoTree.get(repoPath);
    if (entry) return entry.sha;

    // Fetch from API (GET, not HEAD — we need the SHA from the response body)
    const creds = await this.getCredsCached();
    if (!creds) return null;

    const qRef = ref === 'main' ? '' : `?ref=${encodeURIComponent(ref)}`;
    const resp = await this.rest.request(creds, 'GET',
      `/repos/${creds.repo}/contents/${repoPath}${qRef}`);
    // t/4258/t/4295: see fetchFileFromGitHub — a 304 carries no data.
    if (!resp.ok || resp.status === 304) return null;
    return (resp.data as { sha: string }).sha;
  }

  // ── Repo tree ──────────────────────────────────────────────────────────

  /**
   * t/4201: populate `repoTree` on a cache-hit start. Without it, `listDirectory` and `exists` fall back
   * to the GitHub Contents API on EVERY call — including every /healthz probe — so GitHub load scaled
   * with replicas × probes, and at 5 replicas GitHub refused and every replica crash-looped (t/4176,
   * 2026-10-13). One recursive-tree fetch (2 API calls) per start replaces that per-request traffic.
   * If the fetch fails, seed the tree from the manifest's known files instead (logged WARN), so
   * listings keep working from the shared cache while GitHub is unavailable.
   */
  private async loadTreeOnCacheHit(mainSha: string): Promise<'api' | 'manifest' | 'none'> {
    if (await this.fetchRepoTree(mainSha)) return 'api';
    const files = Object.entries(this.manifest?.files ?? {});
    for (const [repoPath, f] of files) {
      this.repoTree.set(repoPath, { path: repoPath, mode: '100644', type: 'blob', sha: f.sha });
    }
    this.recordEvent({
      type: 'github.api.error',
      component: 'github-api',
      level: 'warn',
      message: `initialize: tree fetch failed on a cache hit — seeded repoTree from the manifest (${files.length} files); listings may omit files not yet cached`,
      data: { sha: mainSha, seeded: files.length },
    });
    log.server.warn({ sha: mainSha, seeded: files.length, cause: 'tree-fetch-failed-on-cache-hit' },
      'initialize: tree fetch failed on a cache hit — seeded repoTree from the manifest (t/4201)');
    return files.length > 0 ? 'manifest' : 'none';
  }

  private async fetchRepoTree(commitSha: string): Promise<boolean> {
    if (!commitSha) return false;

    const creds = await this.getCredsCached();
    if (!creds) return false;

    // Get the tree SHA from the commit
    const commitResp = await this.rest.request(creds, 'GET',
      `/repos/${creds.repo}/git/commits/${commitSha}`);
    if (!commitResp.ok) return false;

    // t/470: an OK commit response with no body, or without tree.sha, is a failed load, not a throw.
    const treeSha = (commitResp.data as { tree?: { sha?: unknown } } | null | undefined)?.tree?.sha;
    if (typeof treeSha !== 'string' || treeSha.length === 0) {
      log.github.warn({ commitSha, status: commitResp.status },
        'fetchRepoTree: OK commit response without tree.sha; treating it as a failed load (t/470)');
      return false;
    }
    const entries = await this.getTree(treeSha, true);

    // t/463 (Second Opinion): build the tree locally and assign it only on success. A zero-blob or failed
    // load must not empty or replace the live tree.
    const loadedTree = new Map<string, TreeEntry>();
    for (const entry of entries) {
      // t/470: skip an entry that is not an object with a path, instead of throwing on it.
      if (entry?.type === 'blob' && typeof entry.path === 'string') {
        loadedTree.set(entry.path, entry);
      }
    }

    // Zero blobs = undici session-reuse returning stale/empty response (t/2053).
    // A valid taxonomy repo always has files — treat 0 as a load failure and
    // log at error-level so ops has a signal instead of a silent /healthz 503.
    if (loadedTree.size === 0) {
      this.recordEvent({
        type: 'github.api.error',
        component: 'github-api',
        level: 'error',
        message: 'fetchRepoTree: 0 blobs loaded — data-load failed (check GitHub API response and undici version)',
        data: { commitSha, treeSha },
      });
      // t/4258/t/4281: the comment above says "log at error-level so ops has a
      // signal" but recordEvent() alone never reached console — this was the
      // signal that never fired. Also feeds alert-github-api-error-spike.
      log.github.error({ commitSha, treeSha }, 'github.api.error: fetchRepoTree 0 blobs loaded — data-load failed');
      return false;
    }

    this.repoTree.clear();
    for (const [p, entry] of loadedTree) this.repoTree.set(p, entry);
    this.treeSha = treeSha;

    this.recordEvent({
      type: 'cache.hit',
      component: 'cache',
      level: 'info',
      message: `fetchRepoTree: cache warmed ${this.repoTree.size} blobs`,
      data: { commitSha, treeSha, count: this.repoTree.size },
    });
    return true;
  }

  /** Data-load status for /healthz surfacing (t/2059 renders this). */
  getDataLoadStatus(): { status: 'loading' | 'ready' | 'failed'; error?: string } {
    return this._dataLoadError
      ? { status: this._dataLoadStatus, error: this._dataLoadError }
      : { status: this._dataLoadStatus };
  }

  // ── Polling ────────────────────────────────────────────────────────────

  private startPolling(): void {
    if (this.pollTimer) return;

    this.pollTimer = setInterval(() => void this.pollTick(), this.pollIntervalMs);

    if (this.blobLease) {
      // t/4179 R1 (TL p/538#66): renew on its OWN timer, independent of tick
      // latency. With duration == pollIntervalMs, renewing only on the tick
      // would renew right at the expiry boundary — any slow tick (a GitHub
      // call, GC) lets the lease lapse and the holder churns every minute.
      // duration/3 gives two full retry windows before expiry.
      const renewMs = Math.max(1000, Math.floor((this.pollLeaseDurationSeconds * 1000) / 3));
      this.leaseRenewTimer = setInterval(() => void this.renewPollLease(), renewMs);
      void this.renewPollLease(); // first attempt now, not after a full renewMs wait
    }
  }

  /**
   * t/4179 R1: the ONLY place that calls `blobLease.acquireOrRenew()`. The
   * poll tick itself just reads `blobLease.isHolder()` (a cheap local flag)
   * to pick its branch — safety against that flag being stale comes from the
   * fenced write in publishPollState(), not from this timer being perfectly
   * accurate.
   */
  private async renewPollLease(): Promise<void> {
    if (!this.blobLease) return;
    const wasHolder = this.blobLease.isHolder();
    let isHolder: boolean;
    try {
      isHolder = await this.blobLease.acquireOrRenew();
    } catch (err: unknown) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'cache', level: 'warn',
        message: 'Poll-lease acquire/renew failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      this.recordEvent({
        type: 'system.error', component: 'cache', level: 'warn',
        message: 'Poll-lease acquire/renew failed — holder status uncertain, pollTick will fall back to direct polling',
        error: normalizeErrorForEvent(err),
      });
      return;
    }
    // t/547 (for the t/504 staging proof): a healthy hand-over logged nothing, so the log could not show
    // which replica held the lease.
    if (isHolder && !wasHolder) this.holderId = crypto.randomUUID();
    if (isHolder !== wasHolder) {
      log.storage.info({ holderId: this.holderId, container: this.pollLeaseContainer },
        isHolder ? 'poll lease acquired: this replica is now the poll holder' : 'poll lease lost: this replica is now a non-holder');
    }
    if (isHolder && !wasHolder) await this.seedGenerationAfterAcquiring();
  }

  /**
   * t/4179 R2 (TL p/538#66): read the published state AFTER acquiring, never
   * before — a dying holder can still publish right up to expiry, and once
   * we hold the lease the fence guarantees this read is the final word.
   * Seeds at remote.generation + 1 so numbering stays continuous across a
   * holder handoff; a missing/unparseable state seeds at 0 with a WARN.
   */
  private async seedGenerationAfterAcquiring(): Promise<void> {
    let remote: PollState | null = null;
    try {
      remote = await this.readPollState();
    } catch (err: unknown) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'cache', level: 'warn',
        message: 'Became poll-lease holder: reading existing poll-state failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      this.recordEvent({
        type: 'system.error', component: 'cache', level: 'warn',
        message: 'Became poll-lease holder: reading existing poll-state failed — seeding generation at 0',
        error: normalizeErrorForEvent(err),
      });
    }
    if (remote === null) {
      this.recordEvent({
        type: 'system.error', component: 'cache', level: 'warn',
        message: 'Became poll-lease holder: poll-state missing or unparseable — seeding generation at 0',
      });
    }
    this.pollStateGeneration = remote && Number.isFinite(remote.generation) ? remote.generation + 1 : 0;
    this.pollStateHistory = [];
  }

  private async pollTick(): Promise<void> {
    // t/482: a replica that is not ready does no ordinary polling. If its load failed for a known reason
    // it tries the full load again, whatever its lease role: each replica has its own in-memory tree, so
    // a non-holder cannot be recovered by the holder's poll state.
    if (this._dataLoadStatus === 'failed') {
      if (this._dataLoadFailure === 'known') await this.attemptLoadRecovery();
      return;
    }
    if (!this.blobLease) return this.pollDirect();
    if (this.blobLease.isHolder()) return this.pollAsHolder();
    return this.pollAsNonHolder();
  }

  /** t/483: apply a new head commit seen by a poll. The tree is loaded first, and nothing else happens
   *  unless that load succeeds: fetchRepoTree returns false on a failed, zero-blob or wrong-shaped load
   *  and leaves the live tree as it was. The callers used to ignore that result, drop the changed
   *  entries from the manifest before the fetch, and advance the manifest commit after it, so a failed
   *  fetch left the manifest naming a commit whose tree was never loaded, and the next poll saw
   *  "nothing changed". #5309 (t/463) fixed the same thing in initialize().
   *  Returns `{ changed }`, where `changed` is null when the changed paths are unknown (t/547), or null
   *  overall when the tree load failed and nothing was applied. */
  private async applyPolledCommit(currentSha: string): Promise<{ changed: string[] | null } | null> {
    const previousSha = this.manifest?.lastCommitSha ?? '';
    const changed = previousSha ? await this.compareChangedPaths(previousSha, currentSha) : null;

    const loaded = await this.fetchRepoTree(currentSha);
    if (!loaded) {
      log.storage.warn({ previousSha, currentSha, changedCount: changed?.length ?? 'unknown' },
        'poll: tree load failed for the new commit; manifest and live tree left unchanged, will retry on the next poll (t/483)');
      return null;
    }

    if (changed === null) {
      log.storage.warn({ previousSha, currentSha },
        'poll: the changed paths for the new commit are unknown; falling back to invalidating every cached file (t/547)');
    }
    this.recordEvent({
      type: 'cache.invalidate',
      component: 'cache',
      level: changed === null ? 'warn' : 'info',
      message: changed === null ? 'Poll: changed paths unknown, all cached files invalidated' : `Poll: ${changed.length} files changed`,
      data: { paths: (changed ?? []).slice(0, 20), trigger: 'poll', sha: currentSha, full: changed === null },
    });
    await this.withManifestLock(async () => {
      if (!this.manifest) return;
      if (changed === null) this.manifest.files = {};
      else for (const filePath of changed) delete this.manifest.files[filePath];
    });

    await this.updateManifestSha(currentSha);
    return { changed };
  }

  /** t/547: the paths that changed between two commits, or null when the compare cannot vouch for the whole
   *  set. getChangedFiles answers [] for a failed compare (including a force-push, where the old commit is
   *  no longer in history) and for a list cut at GitHub's cap, and a moved commit with no changed file is
   *  not trusted as "nothing changed" either. Unlike getChangedFiles, this does not invalidate the cache
   *  itself on a force-push: the caller does that after the new tree has loaded (t/483 ordering). */
  private async compareChangedPaths(fromSha: string, toSha: string): Promise<string[] | null> {
    const creds = await this.getCredsCached();
    if (!creds) return null;
    const resp = await this.rest.request(creds, 'GET', `/repos/${creds.repo}/compare/${fromSha}...${toSha}`);
    if (!resp.ok) {
      log.storage.warn({ fromSha, toSha, status: resp.status, forcePush: resp.status === 404 || resp.status === 422 },
        'poll: compare failed; the changed paths are unknown (t/547)');
      return null;
    }
    const files = (resp.data as { files?: Array<{ filename: string }> } | null | undefined)?.files;
    if (!Array.isArray(files) || files.length === 0 || files.length >= COMPARE_FILES_CAP) return null;
    return files.map(f => f.filename);
  }

  /** The pre-t/4179 poll body, unchanged — used when no pollLease is
   *  configured, and as the fallback when coordination is unavailable
   *  (TL t/4179#2 §2 point 2: fail toward coherence, never toward silent
   *  staleness). */
  private async pollDirect(): Promise<void> {
    try {
      const currentSha = await this.getLatestCommitSha();
      if (!currentSha || currentSha === this.manifest?.lastCommitSha) return;

      await this.applyPolledCommit(currentSha);
    } catch (err: unknown) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'github-api',
        level: 'error',
        message: 'Operation failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      this.recordEvent({
        type: 'system.error',
        component: 'cache',
        level: 'error',
        message: 'Polling loop error',
        error: normalizeErrorForEvent(err),
        data: { context: 'background-task' },
      });
    }
  }

  /** The current holder's poll: does the real GitHub work (unchanged from
   *  pollDirect), then publishes the result for non-holders to consume. */
  private async pollAsHolder(): Promise<void> {
    let currentSha = '';
    let changed: string[] | null = [];
    try {
      currentSha = await this.getLatestCommitSha();
      if (currentSha && currentSha !== this.manifest?.lastCommitSha) {
        const applied = await this.applyPolledCommit(currentSha);
        // t/483: a failed tree load applied nothing, so there is nothing to publish to non-holders.
        if (applied === null) return;
        changed = applied.changed;
      }
    } catch (err: unknown) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'github-api',
        level: 'error',
        message: 'Operation failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      this.recordEvent({
        type: 'system.error',
        component: 'cache',
        level: 'error',
        message: 'Polling loop error',
        error: normalizeErrorForEvent(err),
        data: { context: 'background-task' },
      });
      return;
    }
    await this.publishPollState(currentSha || this.manifest?.lastCommitSha || '', changed);
  }

  /** Publish the holder's result, fenced to its current lease — a holder
   *  that renewed too late (another replica already took over) gets a 412
   *  here and just skips the publish, instead of silently writing stale
   *  state under a lease it no longer holds. */
  private async publishPollState(lastCommitSha: string, changedPaths: string[] | null): Promise<void> {
    if (!this.blobLease) return;
    const leaseId = this.blobLease.getLeaseId();
    if (!leaseId) return; // lost holder status — next tick re-evaluates via isHolder()

    this.pollStateGeneration++;
    // t/547: null (paths unknown) is published as its own entry, so a non-holder invalidates everything.
    if (changedPaths === null || changedPaths.length > 0) {
      this.pollStateHistory.push({ generation: this.pollStateGeneration, paths: changedPaths });
      if (this.pollStateHistory.length > POLL_STATE_HISTORY_CAP) this.pollStateHistory.shift();
    }
    const state: PollState = {
      holderId: this.holderId,
      generation: this.pollStateGeneration,
      lastCommitSha,
      changedSinceGeneration: this.pollStateHistory,
      publishedAt: new Date().toISOString(),
    };
    const payload = JSON.stringify(state);
    try {
      await this.pollStateBlobClient().upload(payload, Buffer.byteLength(payload), { conditions: { leaseId } });
    } catch (err: unknown) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'cache', level: 'warn',
        message: 'Poll-state publish rejected (fence) — another replica took over the lease',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      this.recordEvent({
        type: 'system.error', component: 'cache', level: 'warn',
        message: 'Poll-state publish rejected (fence) — another replica took over the lease',
        error: normalizeErrorForEvent(err),
      });
    }
  }

  private async readPollState(): Promise<PollState | null> {
    if (!this.blobLeaseContainerClient) return null;
    try {
      const resp = await this.pollStateBlobClient().download();
      const raw = await streamToStringForPoll(resp.readableStreamBody);
      return JSON.parse(raw) as PollState;
    } catch (err: unknown) {
      if (isBlobNotFoundForPoll(err)) return null;
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'cache', level: 'warn',
        message: 'readPollState: poll-state blob read failed (not a 404)',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      throw err;
    }
  }

  private pollStateBlobClient(): BlockBlobClient {
    return this.blobLeaseContainerClient!.getBlockBlobClient(POLL_STATE_BLOB);
  }

  /**
   * Non-holder poll: read the holder's published state instead of calling
   * GitHub. Falls back to pollDirect() (TL t/4179#2 §2 point 2) if the state
   * is missing, unreadable, or older than POLL_STATE_STALE_FACTOR × the poll
   * interval — never trusts a state we can't confirm is current.
   */
  private async pollAsNonHolder(): Promise<void> {
    let state: PollState | null;
    try {
      state = await this.readPollState();
    } catch (err: unknown) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'cache', level: 'warn',
        message: 'Poll-state read failed — falling back to direct poll',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      this.recordEvent({
        type: 'system.error', component: 'cache', level: 'warn',
        message: 'Poll-state read failed — falling back to direct poll',
        error: normalizeErrorForEvent(err),
      });
      return this.pollDirect();
    }
    if (state === null) return this.pollDirect();

    const ageMs = Date.now() - Date.parse(state.publishedAt);
    if (!Number.isFinite(ageMs) || ageMs > this.pollIntervalMs * POLL_STATE_STALE_FACTOR) {
      this.recordEvent({
        type: 'system.error', component: 'cache', level: 'warn',
        message: `Poll-state stale (${ageMs}ms old, limit ${this.pollIntervalMs * POLL_STATE_STALE_FACTOR}ms) — falling back to direct poll`,
        data: { ageMs },
      });
      return this.pollDirect();
    }

    // t/547: a catch-up that could not load the new commit's tree applied nothing, so the bookkeeping
    // stays where it was and the next tick tries the same catch-up again.
    if (!(await this.applyPollState(state))) return;

    this.pollLastSeenGeneration = state.generation;
    this.pollLastSeenHolderId = state.holderId;
    this.pollLastSeenCommitSha = state.lastCommitSha;
  }

  /** Extracted from pollAsNonHolder() to keep its own complexity under budget. Brings the local manifest
   *  and tree to the holder's published commit; does not touch pollLastSeen* bookkeeping.
   *
   *  t/547: the invariant is that the manifest's file entries and the live tree both describe
   *  `manifest.lastCommitSha`. So there is nothing to do unless the published commit differs from ours,
   *  whatever the generation says (a heartbeat with an empty history used to count as a gap and wipe the
   *  whole cache on every tick). When it differs, the new commit's tree is loaded FIRST, and nothing else
   *  changes unless that load succeeds (the old code reloaded the tree at the previous commit and then
   *  advanced the manifest, so changed files kept serving their old blob). Then either only the published
   *  changed paths are dropped, when they are known to cover the whole step from our commit, or every
   *  file entry is.
   *  Returns false when the tree load failed and nothing was applied. */
  private async applyPollState(state: PollState): Promise<boolean> {
    const targetSha = state.lastCommitSha;
    const ourSha = this.manifest?.lastCommitSha ?? '';
    if (!targetSha || targetSha === ourSha) return true;

    const loaded = await this.fetchRepoTree(targetSha);
    if (!loaded) {
      log.storage.warn({ ourSha, targetSha, generation: state.generation },
        'poll (non-holder): tree load failed for the published commit; manifest and live tree left unchanged, will retry on the next poll (t/547)');
      return false;
    }

    const paths = this.knownChangedPathsSince(state, ourSha);
    if (paths === null) {
      log.storage.warn({ ourSha, targetSha, generation: state.generation, lastSeenGeneration: this.pollLastSeenGeneration },
        'poll (non-holder): the poll state cannot vouch for the changed paths since our commit; falling back to invalidating every cached file (t/547)');
    }
    await this.withManifestLock(async () => {
      if (!this.manifest) return;
      if (paths === null) this.manifest.files = {};
      else for (const p of paths) delete this.manifest.files[p];
    });
    await this.updateManifestSha(targetSha);
    this.recordEvent({
      type: 'cache.invalidate', component: 'cache', level: 'info',
      message: paths === null
        ? 'Poll (non-holder): changed paths unknown, all cached files invalidated'
        : `Poll (non-holder): ${paths.size} files changed`,
      data: { paths: paths === null ? [] : [...paths].slice(0, 20), trigger: 'poll-shared-state', sha: targetSha, full: paths === null },
    });
    return true;
  }

  /** t/547: the paths that changed between our commit and the published one, or null when the poll state
   *  cannot vouch for that whole step. It can only when: we applied this same holder's state before
   *  (t/4179 R2: a new holder restarts its history), our manifest is still at the commit we applied then
   *  (a direct-poll fallback in between moves it), the generation moved forward, and the history list was
   *  not cut at its cap past our last generation, and no entry since then says its paths are unknown. The
   *  holder adds an entry for every commit it moves to (null paths when its compare could not vouch for
   *  them), and its id is per tenure, so within one id the list is complete up to the cap. It holds only
   *  generations that moved the commit, so gaps between its entries are normal and are not a cut. */
  private knownChangedPathsSince(state: PollState, ourSha: string): Set<string> | null {
    const lastSeen = this.pollLastSeenGeneration;
    if (lastSeen === 0 || state.holderId !== this.pollLastSeenHolderId) return null;
    if (ourSha !== this.pollLastSeenCommitSha || state.generation <= lastSeen) return null;
    const history = state.changedSinceGeneration;
    const oldest = history[0]?.generation;
    if (history.length >= POLL_STATE_HISTORY_CAP && oldest !== undefined && oldest > lastSeen + 1) return null;
    const paths = new Set<string>();
    for (const entry of history) {
      if (entry.generation <= lastSeen) continue;
      if (entry.paths === null) return null;
      for (const p of entry.paths) paths.add(p);
    }
    return paths;
  }

  /**
   * t/4179 R3 (TL p/538#66): single-flight lazy repoTree refill for
   * non-holders. On failure, takes the SAME t/4201 manifest-seed path
   * `loadTreeOnCacheHit` already uses on a cold start — it NEVER falls
   * through to a per-call Contents API, which at N>1 non-holder replicas is
   * exactly the crash-loop pattern t/4201/t/4176 fixed. Concurrent callers
   * share one in-flight refill.
   */
  private async ensureRepoTreeFilled(): Promise<void> {
    if (this.repoTree.size > 0) return;
    if (!this.repoTreeRefillInFlight) {
      const sha = this.manifest?.lastCommitSha;
      this.repoTreeRefillInFlight = (sha ? this.loadTreeOnCacheHit(sha) : Promise.resolve('none' as const))
        .then(() => undefined)
        .finally(() => { this.repoTreeRefillInFlight = null; });
    }
    await this.repoTreeRefillInFlight;
  }

  /** t/4179 R3: only the holder (or a no-pollLease/single-replica backend)
   *  may fall back to a per-call Contents API hit when the tree is empty. A
   *  non-holder doing that at N>1 replicas reintroduces the t/4201 storm —
   *  it takes the manifest-seed path instead, even degraded to an empty
   *  listing on a cold cache, never a per-replica API call. */
  private mayFallBackToContentsApi(): boolean {
    return !this.blobLease || this.blobLease.isHolder();
  }

  private async invalidateChangedFiles(fromSha: string, toSha: string): Promise<void> {
    const changed = await this.getChangedFiles(fromSha, toSha);
    if (changed.length === 0) return;

    await this.withManifestLock(async () => {
      for (const filePath of changed) {
        if (this.manifest?.files[filePath]) {
          delete this.manifest.files[filePath];
        }
      }
    });

    this.recordEvent({
      type: 'cache.invalidate',
      component: 'cache',
      level: 'info',
      message: `Invalidated ${changed.length} files on startup diff`,
      data: { paths: changed.slice(0, 20), trigger: 'startup' },
    });
  }

  /** t/463: is `sha` still in repo history? A 404 or 422 says it is not. Any other outcome (a transient
   *  failure, no credentials) counts as present: a cache is never wiped on an unknown answer. */
  private async isCommitInHistory(sha: string): Promise<boolean> {
    try {
      const creds = await this.getCredsCached();
      if (!creds) return true;
      const resp = await this.rest.request(creds, 'GET', `/repos/${creds.repo}/commits/${sha}`);
      if (resp.ok) return true;
      const status = (resp as { status?: number }).status;
      return !(status === 404 || status === 422);
    } catch (err: unknown) {
      // The check itself failed (credentials, network). Keep the cache; never wipe on an unknown answer.
      log.storage.warn({ sha, err: String(err) }, 'isCommitInHistory: check failed; keeping the cache (t/463)');
      return true;
    }
  }

  /** t/463: drop the cached commit and its file entries in memory, so start-up re-seeds from the current
   *  commit. The in-memory state is authoritative for this process; persistence is best-effort. */
  private reseedManifestInMemory(): void {
    const staleSha = this.manifest?.lastCommitSha ?? '';
    if (this.manifest) {
      this.manifest.files = {};
      this.manifest.lastCommitSha = '';
      this.manifest.generation++;
    }
    log.storage.warn({ staleSha }, 'Cached commit is not in repo history — re-seeding from the current commit (t/463)');
    this.recordEvent({
      type: 'cache.invalidate',
      component: 'cache',
      level: 'warn',
      message: 'Cached commit not in repo history — re-seeding from current commit',
      data: { staleSha, trigger: 'not-in-history' },
    });
  }

  private async fullCacheInvalidation(): Promise<void> {
    await this.withManifestLock(async () => {
      if (this.manifest) {
        this.manifest.files = {};
        this.manifest.generation++;
        this.manifest.lastCommitSha = '';
        await this.saveManifest();
      }
    });
    this.repoTree.clear();
    this.treeSha = null;
  }

  private async updateManifestSha(sha: string): Promise<void> {
    await this.withManifestLock(async () => {
      if (!this.manifest) {
        this.manifest = {
          version: 1,
          generation: 1,
          lastCommitSha: sha,
          lastUpdated: new Date().toISOString(),
          files: {},
        };
      } else {
        this.manifest.lastCommitSha = sha;
        this.manifest.generation++;
        this.manifest.lastUpdated = new Date().toISOString();
      }
      await this.saveManifest();
    });
  }

  // ── Coherency probe ────────────────────────────────────────────────────

  private async runCoherencyProbe(repoPath: string): Promise<void> {
    const entry = this.manifest?.files[repoPath];
    if (!entry?.etag) return;

    const creds = await this.getCredsCached();
    if (!creds) return;

    const resp = await this.rest.request(creds, 'GET',
      `/repos/${creds.repo}/contents/${repoPath}`);

    if (resp.status === 200) {
      // Content changed but cache reported hit — coherency violation
      const newSha = (resp.data as { sha: string })?.sha;
      if (newSha && newSha !== entry.sha) {
        this.coherencyViolations++;
        this.recordEvent({
          type: 'cache.coherency_violation',
          component: 'cache',
          level: 'error',
          message: `Cache coherency violation: ${repoPath} (cached SHA ${entry.sha}, actual ${newSha})`,
          data: { path: repoPath, cachedSha: entry.sha, actualSha: newSha,
                  totalViolations: this.coherencyViolations },
        });
        // Auto-invalidate entire cache
        await this.fullCacheInvalidation();
      }
    }
    // 304 = coherency confirmed, no action needed
  }

  // ── SIGUSR2 emergency dump ─────────────────────────────────────────────

  private registerSigHandler(): void {
    if (typeof process === 'undefined' || !process.on) return;

    process.on('SIGUSR2', () => {
      if (!this.recorder) return;
      const dump = this.recorder.buildDump('manual', undefined, { trigger: 'SIGUSR2' });
      writeFramedNdjson(dump.ndjson, process.stderr);
    });
  }

  // ── Credentials helper ─────────────────────────────────────────────────

  private async getCredsCached(): Promise<SyncCredentials | null> {
    if (this.cachedCreds && Date.now() < this.credsExpiresAt) {
      return this.cachedCreds;
    }
    this.cachedCreds = await getCredentials();
    // Cache for 5 minutes
    this.credsExpiresAt = Date.now() + 5 * 60 * 1000;
    return this.cachedCreds;
  }

  private noCredsError(method: string): ActionableError {
    return new ActionableError({
      goal: `Execute ${method}`,
      problem: 'No GitHub credentials configured. Set GITHUB_APP_ID + PEM or GITHUB_TOKEN.',
      location: `GitHubAPIBackend.${method}`,
      nextSteps: [
        'Set GITHUB_APP_ID + GITHUB_APP_INSTALLATION_ID + GITHUB_APP_PRIVATE_KEY_SECRET_NAME',
        'Or set GITHUB_TOKEN for dev/test',
      ],
    });
  }

  /**
   * t/4184 (SO condition C1): evict a single path's cache entries after a 409
   * so the NEXT readFile fetches fresh from GitHub instead of serving the same
   * stale content/SHA that just conflicted — without this, "reload and
   * re-apply" reloads the same stale state and 409s again indefinitely.
   */
  private async evictPathFromCache(repoPath: string): Promise<void> {
    this.repoTree.delete(repoPath);
    await this.withManifestLock(async () => {
      if (this.manifest?.files[repoPath]) {
        delete this.manifest.files[repoPath];
        this.manifest.generation++;
        this.manifest.lastUpdated = new Date().toISOString();
        await this.saveManifest();
      }
    });
  }

  /**
   * t/4184: the 409-conflict error for writeFile/writeBinaryFile. No retry —
   * the caller's `content` was computed from a now-stale read, so re-sending
   * it with a fresh SHA would silently discard the other writer's commit.
   * `httpStatus`/`code` let the route layer (ServerAPI, t/4185) map this to a
   * clean HTTP 409 and the renderer (Sync, t/4186) show a conflict message
   * instead of a generic 500 — contract finalized at t/4185#2.
   */
  private writeConflictError(repoPath: string, method: string): ActionableError {
    return new ActionableError({
      goal: `Save ${repoPath}`,
      problem: 'The file changed since you loaded it (someone else saved a conflicting change).',
      location: `GitHubAPIBackend.${method}(${repoPath})`,
      nextSteps: ['Reload the file to see the latest version', 'Re-apply your change and save again'],
      httpStatus: 409,
      code: 'WRITE_CONFLICT',
    });
  }

  /**
   * t/4224 (TL design, p/538#40/#43): the current state of `repoPath` on a
   * session branch, read live from GitHub — the one authoritative source for
   * every route that can move the branch head (commitOverlay, mergeBranch, a
   * resync conflict resolved on GitHub, another replica, SessionBranchManager
   * .commitBatch, or anything else). A session-branch precondition or
   * edit-load checked against main's SHA instead is exactly the t/4224 bug —
   * a stale or wrong baseline silently reverting this session's own commits.
   *
   * Tells a genuinely missing file ('absent' — a 404, a legitimate "nothing
   * here yet" for a new path) apart from a real fetch failure ('unavailable'
   * — no creds, 5xx, timeout, a directory). Collapsing those (p/538#43) made
   * every session-branch write that CREATES a file 503 — this never throws;
   * callers decide what each outcome means for their own operation.
   */
  private async getSessionBranchFileStatus(
    repoPath: string, ref: string,
  ): Promise<{ kind: 'present'; content: string; sha: string } | { kind: 'absent' } | { kind: 'unavailable' }> {
    const creds = await this.getCredsCached();
    if (!creds) return { kind: 'unavailable' };

    const qRef = ref === 'main' ? '' : `?ref=${encodeURIComponent(ref)}`;
    const resp = await this.rest.request(creds, 'GET',
      `/repos/${creds.repo}/contents/${repoPath}${qRef}`,
      // t/268 (item 4): unconditional. This read always needs the body, and on the base branch a cached
      // ETag turned it into a 304, which read as 'unavailable' and surfaced a spurious 503.
      undefined, undefined, { optional: true, unconditional: true });

    if (resp.status === 404) return { kind: 'absent' };
    // t/4258/t/4295: a 304 (ok: true, data: null) means the body is unchanged
    // from a cached etag — getCachedEtag() no longer sends one for a non-main
    // ref, but treat it as unavailable defensively rather than crash reading
    // `.type` off null data.
    if (!resp.ok || resp.status === 304) return { kind: 'unavailable' };

    const data = resp.data as { content?: string; encoding?: string; sha: string; size?: number; type?: string };
    if (data.type === 'dir') return { kind: 'unavailable' }; // not a valid target for a file precondition/edit-load

    if (!data.content || data.encoding !== 'base64') {
      // Large file — use Blobs API
      if (data.sha && (data.size ?? 0) > 0) {
        const blob = await this.fetchBlobFromGitHub(creds, data.sha, resp.etag ?? '');
        return blob ? { kind: 'present', content: blob.content, sha: blob.sha } : { kind: 'unavailable' };
      }
      return { kind: 'unavailable' };
    }

    const content = Buffer.from(data.content, 'base64').toString('utf-8');
    return { kind: 'present', content, sha: data.sha };
  }

  /** Shared 503, for both writeOverlayWithPrecondition and readFileWithVersion. */
  private throwVersionUnavailable(repoPath: string, ref: string): never {
    this.recordEvent({
      type: 'github.api.error', component: 'github-api', level: 'warn',
      message: `Could not verify the current version of ${repoPath} on ${ref} — failing closed rather than falling back to main`,
      data: { path: repoPath, ref },
    });
    throw new ActionableError({
      goal: `Read the current version of ${repoPath} on ${ref}`,
      problem: 'Could not reach GitHub to verify the current version of this file on your session branch.',
      location: `GitHubAPIBackend.getSessionBranchFileStatus(${repoPath})`,
      nextSteps: ['Retry in a moment', 'Check GitHub API status'],
      httpStatus: 503,
      code: 'VERSION_UNAVAILABLE',
    });
  }

  // ── Flight recorder helpers ────────────────────────────────────────────

  private recordEvent(input: RecordInput): void {
    if (this.recorder) {
      this.recorder.record(input);
    }

    // Secondary error buffer (t/465#5)
    if (input.level === 'error' || input.level === 'warn') {
      this.errorBuffer.push({ ...input, _wall: Date.now() });
      if (this.errorBuffer.length > ERROR_BUFFER_CAPACITY) {
        this.errorBuffer.shift();
      }
    }
  }

  // ── Public accessors for health/diagnostics ────────────────────────────

  getCacheGeneration(): number { return this.manifest?.generation ?? 0; }
  getCachedFileCount(): number { return this.manifest ? Object.keys(this.manifest.files).length : 0; }
  getMainSha(): string { return this.manifest?.lastCommitSha ?? ''; }
  getLastPollAge(): number {
    if (!this.manifest?.lastUpdated) return -1;
    return Math.round((Date.now() - new Date(this.manifest.lastUpdated).getTime()) / 1000);
  }
  getRateLimitRemaining(): number { return this.rest.getRateLimitRemaining(); }
  getRateLimitResetsAt(): string { return this.rest.getRateLimitResetsAt(); }
  /** t/4699: null until the first real GitHub response has been observed. */
  getRateLimitObservedAt(): string | null { return this.rest.getRateLimitObservedAt(); }
  getCircuitState(): CircuitState { return this.rest.getCircuitState(); }
  getCoherencyViolations(): number { return this.coherencyViolations; }
  getErrorBuffer(): Array<RecordInput & { _wall: number }> { return [...this.errorBuffer]; }
  getActiveBranchCount(): number { return this.sessionOverlays.size; }
  /**
   * @deprecated t/4307: only instruments one of several miss-then-fetch code
   *  paths in this file (readFileFromMainCache) — readFileWithVersion,
   *  readBinaryFile and readFileAtRef each have their own uncounted miss
   *  branch, and this never saw session-branch reads at all (t/4300#18).
   *  Use getRequestMetrics() instead — it counts every real outbound GitHub
   *  call at the REST-client layer, regardless of which method issued it.
   */
  getColdCacheMissCount(): number { return this.coldCacheMissCount; }

  /** t/4307: since-boot outbound GitHub request count by route class, plus
   *  the latest x-ratelimit-remaining. Supersedes getColdCacheMissCount(). */
  getRequestMetrics(): { totalRequests: number; byRouteClass: Record<string, number>; rateLimitRemaining: number } {
    return this.rest.getRequestMetrics();
  }

  /** t/4585 AC2: raw.githubusercontent.com fallback-to-REST events since
   *  boot, by reason (`status=429` counted separately — TL condition 3 —
   *  so staging measurement can tell whether raw is throttling versus
   *  something else), plus whether the disable guard has tripped. */
  getRawFallbackStats(): { counts: Record<string, number>; disabled: boolean } {
    return { counts: { ...this.rawFallbackCounts }, disabled: this.rawDisabled };
  }

  getCacheHitRate(): number {
    // Approximation from tree + manifest coverage
    if (this.repoTree.size === 0) return 0;
    const cachedCount = this.manifest ? Object.keys(this.manifest.files).length : 0;
    return Math.min(1, cachedCount / Math.max(1, this.repoTree.size));
  }

  // ── t/551: the shared commit status, and conflict resolution on the shared entries ──────────────────

  /** t/551: publish the user's overlay commit status to the shared store, so the sync-status route agrees on every
   *  replica. A no-op when shared state is off. Never throws: a failed write is a WARN, and readers fall back to their
   *  local value. */
  async publishSharedCommitStatus(userId: string, status: unknown): Promise<void> {
    if (!this.sharedSavesActive(userId)) return;
    try {
      await this.sharedOverlayStore!.writeCommitStatus(userId, status);
    } catch (err) {
      log.storage.warn({ userId, err: String(err) }, 'shared commit status could not be published; other replicas show their own value (t/551)');
    }
  }

  /** t/551: the user's shared commit status and whether the store still holds staged entries for them, or null when
   *  shared state is off. Throws on a store failure; the caller (getOverlayCommitStatusShared) bounds and absorbs it. */
  async readSharedCommitStatus(userId: string): Promise<{ status: unknown; staged: boolean } | null> {
    if (!this.sharedSavesActive(userId)) return null;
    const store = this.sharedOverlayStore!;
    const [status, entries] = await Promise.all([store.readCommitStatus(userId), store.listEntries(userId)]);
    return { status, staged: entries.length > 0 };
  }

  /** t/551 ("Use theirs" with shared state active): discard every staged entry for the user, under the commit lease so
   *  a commit on another replica can't be running over the same batch (whole batch, t/4312 SO F1 and p/641#10). Busy
   *  throws OVERLAY_COMMIT_BUSY. With shared state off, this is discardConflictedOverlayEntries. Returns the paths
   *  discarded. */
  async discardConflictedOverlayEntriesAsync(userId: string): Promise<string[]> {
    if (!this.sharedSavesActive(userId)) return this.discardConflictedOverlayEntries(userId);
    const store = this.sharedOverlayStore!;
    const cfg = this.commitLockConfig();
    const lease = new BlobLease({
      accountUrl: cfg.accountUrl, container: cfg.container, blobName: `commit-locks/${userId}`,
      durationSeconds: cfg.leaseSeconds, serviceClient: cfg.serviceClient,
    });
    if (!(await lease.acquireOrRenew())) throw this.commitBusyError(userId);
    try {
      const listed = await store.listEntries(userId);
      const discarded: string[] = [];
      for (const e of listed) {
        const outcome = await store.unstage(userId, e.repoPath, { ifMatch: e.etag });
        if (outcome === 'deleted') discarded.push(e.repoPath);
        else log.storage.warn({ userId, path: e.repoPath, outcome }, 'use-theirs: a staged entry was not discarded (changed during the discard, or a store error) (t/551)');
      }
      this.discardConflictedOverlayEntries(userId); // the local read cache follows
      this.sharedOverlayReadCache.delete(userId);
      return discarded;
    } finally {
      await lease.release();
    }
  }

  /** t/551 ("Keep mine" with shared state active): re-base every staged shared entry onto the branch's current blob,
   *  then commit once. The commit takes the lease itself. Each re-base is a compare-and-set, so an entry rewritten in the
   *  meantime keeps its own base and may still conflict (reported in stillConflicted, never auto-retried). */
  private async rebaseSharedEntriesForRecommit(userId: string, branchName: string): Promise<boolean> {
    const store = this.sharedOverlayStore!;
    const listed = await store.listEntries(userId);
    if (listed.length === 0) return false;
    for (const e of listed) {
      const live = await this.resolveLiveBaseSha(e.repoPath, branchName);
      if (live === 'unknown') {
        // The branch couldn't be read: leave the old base, so the commit fails closed on this path (t/4312).
        log.storage.warn({ userId, path: e.repoPath }, 'keep-mine: live base unavailable; entry left on its old base (t/551)');
        continue;
      }
      const outcome = await store.rebaseEntry(userId, e.repoPath, { ifMatch: e.etag, baseSha: live });
      if (outcome !== 'rebased') log.storage.warn({ userId, path: e.repoPath, outcome }, 'keep-mine: a staged entry was not re-based (t/551)');
    }
    this.sharedOverlayReadCache.delete(userId);
    return true;
  }

  // ── t/550 commit 2: the cross-replica commit lease, and committing from the shared store ──────────────

  /** The commit when shared state is active (t/503#3 §2, rulings t/503#5, SO t/503#8 conditions 3 and 4):
   *  1. take this user's commit lease; if another replica holds it, throw OVERLAY_COMMIT_BUSY (nothing committed, nothing
   *     failed; the scheduler re-arms without counting a retry);
   *  2. the batch is the shared store's entries alone (option 2: every acknowledged save is there);
   *  3. the base check uses each entry's recorded baseSha (null = absent, 'unknown' = conflict);
   *  4. tree, commit, then the non-forced ref update, which GitHub refuses on a stale parent (the last fence). Just before
   *     it the lease is renewed, and the commit is abandoned if the lease changed hands or the hold cap passed;
   *  5. each committed entry is cleared only if its ETag is unchanged; an entry rewritten during the commit is rebased
   *     onto the blob just committed instead, so the next commit doesn't see a false conflict.
   *  The lease is renewed every renewEveryMs while the commit runs, never past maxHoldMs (a hung GitHub call lets it lapse),
   *  and released in finally. */
  private async commitSharedOverlay(
    userId: string, branch: string, message?: string,
  ): Promise<{ commitSha: string; filesCommitted: number; conflictedPaths?: string[] } | null> {
    const store = this.sharedOverlayStore!;
    const cfg = this.commitLockConfig();
    const lease = new BlobLease({
      accountUrl: cfg.accountUrl, container: cfg.container, blobName: `commit-locks/${userId}`,
      durationSeconds: cfg.leaseSeconds, serviceClient: cfg.serviceClient,
    });
    if (!(await lease.acquireOrRenew())) throw this.commitBusyError(userId);
    const heldFrom = Date.now();
    const leaseId = lease.getLeaseId();
    const renewTimer = setInterval(() => {
      if (Date.now() - heldFrom >= cfg.maxHoldMs) { clearInterval(renewTimer); return; }
      void lease.acquireOrRenew().catch((err: unknown) => {
        log.storage.warn({ userId, err: String(err) }, 'commit lease renewal failed; the ref-update check decides (t/550)');
      });
    }, cfg.renewEveryMs);
    try {
      return await this.commitSharedBatch(store, userId, branch, message, async () => {
        const stillOurs = Date.now() - heldFrom < cfg.maxHoldMs && (await lease.acquireOrRenew()) && lease.getLeaseId() === leaseId;
        if (!stillOurs) throw this.commitLeaseLostError(userId, branch);
      });
    } finally {
      clearInterval(renewTimer);
      await lease.release();
    }
  }

  private async commitSharedBatch(
    store: SharedOverlayStore, userId: string, branch: string, message: string | undefined,
    beforeRefUpdate: () => Promise<void>,
  ): Promise<{ commitSha: string; filesCommitted: number; conflictedPaths?: string[] } | null> {
    const listed = await store.listEntries(userId);
    if (listed.length === 0) return null;
    const entries = {
      writes: listed.filter(e => e.entry.content !== null).map(e => ({ path: e.repoPath, content: e.entry.content as string })),
      deletes: listed.filter(e => e.entry.content === null).map(e => e.repoPath),
    };
    const bases = new Map<string, string | null | 'unknown'>(listed.map(e => [e.repoPath, e.entry.baseSha]));

    const creds = await this.getCredsCached();
    if (!creds) throw this.noCredsError('commitOverlay');
    const callId = crypto.randomUUID();
    const startMs = Date.now();
    const currentSha = await this.readBranchHeadForCommit(creds, branch, callId);

    const { conflictedPaths } = await this.partitionOverlayEntriesByBase(creds, userId, entries, currentSha, callId, bases);
    if (conflictedPaths.length > 0) {
      this.recordOverlayConflicts(userId, branch, conflictedPaths);
      this.sessionOverlayConflicts.set(userId, new Set(conflictedPaths));
      return { commitSha: currentSha, filesCommitted: 0, conflictedPaths };
    }
    this.sessionOverlayConflicts.delete(userId);

    const commitSha = await this.createTreeCommitAndUpdateRef(creds, branch, currentSha,
      this.buildOverlayTreeEntries(entries), message || this.buildOverlayCommitMessage(entries), callId, beforeRefUpdate);
    this.recordEvent({
      type: 'overlay.commit', component: 'session', level: 'info',
      message: `Overlay committed to ${branch} from the shared store: ${entries.writes.length} writes, ${entries.deletes.length} deletes`,
      call_id: callId, duration_ms: Date.now() - startMs,
      data: { branch, writes: entries.writes.length, deletes: entries.deletes.length, commitSha, shared: true },
    });

    await this.clearCommittedSharedEntries(store, userId, listed);
    this.clearCommittedOverlayEntries(userId, entries); // the local map is a read cache; drop what was committed
    this.sharedOverlayReadCache.delete(userId); // the next read re-lists
    return { commitSha, filesCommitted: listed.length };
  }

  /** Step 5: clear by ETag; rebase an entry rewritten during the commit onto the blob just committed. */
  private async clearCommittedSharedEntries(
    store: SharedOverlayStore, userId: string,
    listed: Array<{ repoPath: string; entry: SharedOverlayEntry; etag: string }>,
  ): Promise<void> {
    for (const e of listed) {
      const outcome = await store.unstage(userId, e.repoPath, { ifMatch: e.etag });
      if (outcome === 'deleted') continue;
      if (outcome === 'failed') {
        log.storage.warn({ userId, path: e.repoPath }, 'committed entry could not be cleared from the shared store; the next commit may report it as a conflict (t/550)');
        continue;
      }
      const committedBase = e.entry.content === null ? null : gitBlobSha(e.entry.content);
      const rebased = await this.rebaseRewrittenEntry(store, userId, e.repoPath, committedBase);
      if (rebased !== 'rebased') {
        log.storage.warn({ userId, path: e.repoPath, rebased }, 'entry rewritten during the commit could not be rebased; the next commit may report a conflict (t/550)');
      }
    }
  }

  private async rebaseRewrittenEntry(
    store: SharedOverlayStore, userId: string, repoPath: string, baseSha: string | null,
  ): Promise<'rebased' | 'changed' | 'failed' | 'gone'> {
    for (let attempt = 0; attempt < SHARED_SAVE_MAX_ATTEMPTS; attempt++) {
      let current: SharedOverlayEntryWithEtag | null;
      try {
        current = await store.getEntryWithEtag(userId, repoPath);
      } catch (err) {
        log.storage.warn({ userId, repoPath, err: String(err) }, 'could not read an entry to rebase it after a commit (t/550)');
        return 'failed';
      }
      if (!current) return 'gone';
      const r = await store.rebaseEntry(userId, repoPath, { ifMatch: current.etag, baseSha });
      if (r !== 'changed') return r;
    }
    return 'changed';
  }

  private async readBranchHeadForCommit(creds: SyncCredentials, branch: string, callId: string): Promise<string> {
    const refResp = await this.rest.request(creds, 'GET', `/repos/${creds.repo}/git/refs/heads/${branch}`, undefined, callId);
    if (!refResp.ok) {
      throw new ActionableError({
        goal: `Commit overlay to ${branch}`,
        problem: `Failed to get branch ref: ${refResp.status} ${refResp.error}`,
        location: 'GitHubAPIBackend.commitSharedOverlay',
        nextSteps: ['Verify branch exists', 'Check GitHub App permissions'],
      });
    }
    return ((refResp.data as { object: { sha: string } }).object).sha;
  }

  private commitLockConfig(): { accountUrl: string; container: string; leaseSeconds: number; renewEveryMs: number; maxHoldMs: number; serviceClient?: BlobServiceClient } {
    const c = this.sharedCommitLock;
    if (!c) {
      throw new ActionableError({
        goal: 'Commit the shared session overlay',
        problem: 'Shared overlay state is active but no commit lock is configured (sharedOverlayState.commitLock).',
        location: 'GitHubAPIBackend.commitSharedOverlay',
        nextSteps: ['Pass sharedOverlayState.commitLock in server.ts with the overlay-state container (t/553)'],
        httpStatus: 503,
      });
    }
    return {
      accountUrl: c.accountUrl, container: c.container, serviceClient: c.serviceClient,
      leaseSeconds: c.leaseSeconds ?? 60, renewEveryMs: c.renewEveryMs ?? 20_000, maxHoldMs: c.maxHoldMs ?? 300_000,
    };
  }

  private commitBusyError(userId: string): ActionableError {
    return new ActionableError({
      goal: 'Commit the session overlay',
      problem: `Another replica is committing this user's changes right now (${userId}). Nothing was committed and nothing failed.`,
      location: 'GitHubAPIBackend.commitSharedOverlay',
      nextSteps: ['The scheduler retries on its next tick; the other replica commits the same entries'],
      httpStatus: 409,
      code: 'OVERLAY_COMMIT_BUSY',
    });
  }

  private commitLeaseLostError(userId: string, branch: string): ActionableError {
    log.storage.warn({ userId, branch }, 'commit lease lost or past its hold cap before the ref update; commit abandoned, entries stay staged (t/550)');
    return new ActionableError({
      goal: `Commit overlay to ${branch}`,
      problem: 'The commit lease was lost (or held past its cap) before the branch ref update, so the commit was abandoned.',
      location: 'GitHubAPIBackend.commitSharedOverlay',
      nextSteps: ['Nothing is lost: every entry is still staged and the next commit retries'],
      code: 'OVERLAY_COMMIT_LEASE_LOST',
    });
  }

  // ── t/550 (t/503 option 2): saves acknowledged only after the shared stage succeeds ──────────────────

  /** One save to the shared overlay store when shared state is active (t/503#9 to #15, SO t/503#14):
   *  - `precondition` (writeFile with a baseSha): the git blob sha of the entry's content must equal baseSha. A tombstone
   *    entry counts as absent. With no entry, the branch file, read fresh on every attempt, decides. Mismatch: 409.
   *  - `ifAbsent` (writeFileIfAbsent): an entry with content, or a branch file with no entry, means 'exists'.
   *  - `latestWins` (deletes, and the logged no-baseSha write): no semantic check.
   *  The check is enforced by the store's conditional upload (expect etag / absent), so a concurrent save on any replica
   *  makes this one re-check instead of overwriting it; the loop is bounded by SHARED_SAVE_MAX_ATTEMPTS and ends in a 503.
   *  `stagedAt` and `stageId` are set once, when the save arrives. Saves to one (user, path) run one at a time on this
   *  replica. The local map is set only after the store acknowledged; it is a read cache. No local-only fallback. */
  private async stageSharedOverlaySave(
    userId: string, repoPath: string, content: string | null, ref: string, mode: SharedSaveMode,
  ): Promise<'staged' | 'exists'> {
    const store = this.sharedOverlayStore!;
    if (content !== null) this.assertOverlayCap(userId, repoPath, content);
    const stagedAt = new Date().toISOString();
    const stageId = crypto.randomUUID();
    return this.withSharedSaveLock(`${userId}\u0000${repoPath}`, async () => {
      for (let attempt = 1; attempt <= SHARED_SAVE_MAX_ATTEMPTS; attempt++) {
        const current = await this.readSharedEntryForSave(store, userId, repoPath);
        const branch = current === null ? await this.getSessionBranchFileStatus(repoPath, ref) : null;
        if (branch?.kind === 'unavailable') this.throwVersionUnavailable(repoPath, ref);
        if (this.sharedSaveCheck(repoPath, ref, mode, current, branch) === 'exists') return 'exists';

        const baseSha = current ? current.entry.baseSha : branch?.kind === 'present' ? branch.sha : null;
        const expect: SharedOverlayStageExpect = mode.kind === 'latestWins' ? { latestWins: true }
          : current ? { etag: current.etag } : { absent: true };
        const result = await store.stage(userId, repoPath, { content, baseSha, stagedAt, stageId }, expect);
        if (result.ok) {
          this.applyAcknowledgedSharedSave(userId, repoPath, content, baseSha, result.gen, { content, baseSha, stagedAt, stageId });
          return 'staged';
        }
        if (result.reason === 'newer_exists') return 'staged'; // ours is ordered before a save that overlapped it
        if (result.reason === 'storage_unavailable') this.throwSharedStageFailed(repoPath, 'the shared store refused or could not be reached');
        // precondition_failed: another save landed in between; re-check against it.
      }
      return this.throwSharedStageFailed(repoPath, `the entry kept changing (${SHARED_SAVE_MAX_ATTEMPTS} attempts)`);
    });
  }

  private async readSharedEntryForSave(
    store: SharedOverlayStore, userId: string, repoPath: string,
  ): Promise<SharedOverlayEntryWithEtag | null> {
    try {
      return await store.getEntryWithEtag(userId, repoPath);
    } catch (err) {
      log.storage.warn({ userId, repoPath, err: String(err) }, 'shared overlay save: could not read the current entry; the save fails (t/550)');
      return this.throwSharedStageFailed(repoPath, 'the current entry could not be read');
    }
  }

  /** The semantic check for one attempt. Throws the 409 for a stale baseSha; 'exists' only for ifAbsent. */
  private sharedSaveCheck(
    repoPath: string, ref: string, mode: SharedSaveMode, current: SharedOverlayEntryWithEtag | null,
    branch: { kind: 'present'; sha: string } | { kind: 'absent' } | { kind: string } | null,
  ): 'ok' | 'exists' {
    const presentContent = current ? current.entry.content : null; // a tombstone entry counts as absent
    const branchPresent = current === null && branch?.kind === 'present';
    if (mode.kind === 'ifAbsent') return presentContent !== null || branchPresent ? 'exists' : 'ok';
    if (mode.kind === 'precondition') {
      const currentVersion = presentContent !== null ? gitBlobSha(presentContent)
        : branchPresent ? (branch as { sha: string }).sha : null;
      if (currentVersion === null || currentVersion !== mode.baseSha) {
        this.recordEvent({
          type: 'github.api.conflict', component: 'github-api', level: 'warn',
          message: `Overlay write conflict on ${repoPath} — the shared entry moved since the client's last read`,
          data: { path: repoPath, ref, staleSha: mode.baseSha, currentSha: currentVersion, shared: true },
        });
        throw this.writeConflictError(repoPath, 'writeFile');
      }
    }
    return 'ok';
  }

  /** After the store acknowledged: the local read cache and the base sha follow the store. */
  private applyAcknowledgedSharedSave(
    userId: string, repoPath: string, content: string | null, baseSha: string | null | 'unknown', gen: string | null,
    entry: SharedOverlayEntry,
  ): void {
    this.sessionWriteActivitySeq.set(userId, ++this.sessionWriteActivityCounter); // t/4215 budget addendum
    let overlay = this.sessionOverlays.get(userId);
    if (!overlay) { overlay = new Map(); this.sessionOverlays.set(userId, overlay); }
    overlay.set(repoPath, content ?? GitHubAPIBackend.TOMBSTONE);
    this.recordOverlayBaseShaOnce(userId, repoPath, baseSha);
    const cached = this.sharedOverlayReadCache.get(userId);
    const entries = cached ? new Map(cached.entries) : new Map<string, SharedOverlayEntry>();
    entries.set(repoPath, entry);
    // A failed `_gen` bump leaves gen null, so the next read re-lists (t/549).
    this.sharedOverlayReadCache.set(userId, { gen, entries, listedAt: cached?.listedAt ?? 0 });
  }

  private throwSharedStageFailed(repoPath: string, why: string): never {
    log.storage.warn({ repoPath, why }, 'shared overlay save failed; nothing was acknowledged (t/550)');
    this.recordEvent({
      type: 'system.error', component: 'github-api', level: 'warn',
      message: `Shared overlay save failed for ${repoPath}: ${why}`,
      data: { path: repoPath },
    });
    throw new ActionableError({
      goal: `Save ${repoPath}`,
      problem: `Your change could not be saved to the shared session store: ${why}. Nothing was saved.`,
      location: 'GitHubAPIBackend.stageSharedOverlaySave',
      nextSteps: ['Retry the save in a moment', 'If it keeps failing, check /health for storage status'],
      httpStatus: 503,
      code: 'OVERLAY_STAGE_FAILED',
    });
  }

  private async withSharedSaveLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.sharedSaveLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>(resolve => { release = resolve; });
    const tail = prev.then(() => mine);
    this.sharedSaveLocks.set(key, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.sharedSaveLocks.get(key) === tail) this.sharedSaveLocks.delete(key);
    }
  }

  /** True when saves for this request go through the shared store (t/550). */
  private sharedSavesActive(userId: string | undefined): userId is string {
    return !!userId && this.sharedOverlayStateActive && !!this.sharedOverlayStore;
  }

  /** t/550: writeFile's overlay path when shared state is active. Extracted to keep writeOverlayWithPrecondition small. */
  private async saveSharedWithOptionalBaseSha(
    userId: string, repoPath: string, content: string, ref: string, baseSha: string | undefined,
  ): Promise<{ version: string }> {
    if (baseSha === undefined) this.warnNoBaseShaOverlayWrite(repoPath, ref);
    await this.stageSharedOverlaySave(userId, repoPath, content, ref,
      baseSha === undefined ? { kind: 'latestWins' } : { kind: 'precondition', baseSha });
    return { version: gitBlobSha(content) };
  }

  private warnNoBaseShaOverlayWrite(repoPath: string, ref: string): void {
    this.recordEvent({
      type: 'storage.fallback', component: 'github-api', level: 'warn',
      message: `writeFile(${repoPath}): no baseSha supplied on overlay write — falling back to no precondition (direct fileIO caller, not the save route)`,
      data: { path: repoPath, ref },
    });
    log.github.warn({ path: repoPath, ref },
      `storage.fallback: writeFile(${repoPath}) overlay write had no baseSha — no precondition`);
  }

  /** t/4312: record this path's base blob sha the first time it's staged in a
   *  clean overlay slot. Idempotent — a later call for an already-recorded
   *  path (a same-path rewrite, or a concurrent write that landed first) is a
   *  no-op, because what's actually sitting in git for this path hasn't
   *  changed since it was first staged; only the overlay's in-memory content has. */
  private recordOverlayBaseShaOnce(userId: string, repoPath: string, baseSha: string | null | 'unknown'): void {
    let bases = this.sessionOverlayBaseShas.get(userId);
    if (!bases) { bases = new Map(); this.sessionOverlayBaseShas.set(userId, bases); }
    if (!bases.has(repoPath)) bases.set(repoPath, baseSha);
  }

  /** t/4312: for the no-precondition write path, resolve+record a base on
   *  first staging only — extracted to keep writeOverlayWithPrecondition's
   *  complexity down. A no-op when already staged or no active session. */
  private async maybeRecordBaseShaForFreshStage(
    userId: string | undefined, repoPath: string, ref: string, alreadyStaged: boolean,
  ): Promise<void> {
    if (!userId || alreadyStaged) return;
    if (this.sessionOverlayBaseShas.get(userId)?.has(repoPath)) return;
    this.recordOverlayBaseShaOnce(userId, repoPath, await this.resolveLiveBaseSha(repoPath, ref));
  }

  /** t/4312: live lookup used to resolve a path's base blob sha at first
   *  staging. 'unknown' (not a thrown error) on an unreachable session branch —
   *  fails CLOSED at commit time (always conflicts) rather than risking a
   *  silent overwrite from trusting an unverifiable base. */
  private async resolveLiveBaseSha(repoPath: string, ref: string): Promise<string | null | 'unknown'> {
    const status = await this.getSessionBranchFileStatus(repoPath, ref);
    if (status.kind === 'present') return status.sha;
    if (status.kind === 'absent') return null;
    return 'unknown';
  }

  /**
   * Write content to the in-memory overlay without making any GitHub API call.
   * The content is visible to subsequent readFile() calls and will be flushed
   * to GitHub when commitOverlay() is called.
   */
  writeToOverlay(filePath: string, content: string): void {
    const repoPath = this.toRepoPath(filePath);
    const userId = this.getEffectiveUserId();
    if (!userId) return;
    this.sessionWriteActivitySeq.set(userId, ++this.sessionWriteActivityCounter); // t/4215 budget addendum
    let overlay = this.sessionOverlays.get(userId);
    if (!overlay) {
      overlay = new Map();
      this.sessionOverlays.set(userId, overlay);
    }

    this.assertOverlayCap(userId, repoPath, content);
    overlay.set(repoPath, content);
    // t/4311 follow-up: mirror into the shared store for cross-replica read
    // visibility. Fire-and-forget (writeToOverlay stays synchronous — the
    // local write above, which this follows, is the one that must never be
    // delayed by a network call) — writeThroughSharedOverlay never rejects.
    // t/550: the save paths do not come here when shared state is active; they stage first (stageSharedOverlaySave).
    void this.writeThroughSharedOverlay(userId, repoPath, content, this.sessionOverlayBaseShas.get(userId)?.get(repoPath) ?? 'unknown');
  }

  /** t/727: cap per-user overlay memory. Projects the post-write total with replace semantics (the new content
   *  supersedes any existing entry for this path) and rejects with 413 rather than growing unbounded. */
  private assertOverlayCap(userId: string, repoPath: string, content: string): void {
    const overlay = this.sessionOverlays.get(userId);
    const newBytes = Buffer.byteLength(content, 'utf-8');
    const existing = overlay?.get(repoPath);
    const oldBytes = existing && existing !== GitHubAPIBackend.TOMBSTONE ? Buffer.byteLength(existing, 'utf-8') : 0;
    const projected = this.overlayBytes(userId) - oldBytes + newBytes;
    if (projected > this.maxOverlayBytesPerUser) {
      this.recordEvent({
        type: 'system.error',
        component: 'github-api',
        level: 'warn',
        message: 'Session overlay size cap exceeded',
        data: { userId, projectedBytes: projected, capBytes: this.maxOverlayBytesPerUser },
      });
      throw Object.assign(new ActionableError({
        goal: 'Stage an edit in the session overlay',
        problem: `Uncommitted changes exceed the per-user limit (${Math.round(projected / 1024 / 1024)} MB > ${Math.round(this.maxOverlayBytesPerUser / 1024 / 1024)} MB).`,
        location: 'GitHubAPIBackend.writeToOverlay',
        nextSteps: ['Commit your pending changes (sync) to flush the overlay to GitHub', 'Or discard changes to free space'],
      }), { statusCode: 413 });
    }
  }

  /** Total bytes of non-tombstone overlay content for a user (t/727). */
  private overlayBytes(userId: string): number {
    const overlay = this.sessionOverlays.get(userId);
    if (!overlay) return 0;
    let total = 0;
    for (const v of overlay.values()) {
      if (v !== GitHubAPIBackend.TOMBSTONE) total += Buffer.byteLength(v, 'utf-8');
    }
    return total;
  }

  /** Overlay memory stats for /health monitoring (t/727). */
  getOverlayStats(): { users: number; totalBytes: number; maxUserBytes: number; capBytes: number } {
    let totalBytes = 0;
    let maxUserBytes = 0;
    for (const userId of this.sessionOverlays.keys()) {
      const b = this.overlayBytes(userId);
      totalBytes += b;
      if (b > maxUserBytes) maxUserBytes = b;
    }
    return { users: this.sessionOverlays.size, totalBytes, maxUserBytes, capBytes: this.maxOverlayBytesPerUser };
  }

  /**
   * Mark a file as deleted in the overlay (tombstone).
   * readFile() returns null, fileExists() returns false, and commitOverlay()
   * will remove the file from the Git tree.
   * t/4312: deletes get the same base-sha fencing as writes — a live lookup
   * on first staging, since deletes have no client-supplied baseSha to reuse.
   */
  async deleteFromOverlay(filePath: string, ref: string): Promise<void> {
    const repoPath = this.toRepoPath(filePath);
    const userId = this.getEffectiveUserId();
    if (!userId) return;
    if (this.sharedSavesActive(userId)) {
      await this.stageSharedOverlaySave(userId, repoPath, null, ref, { kind: 'latestWins' }); // t/550
      return;
    }
    this.sessionWriteActivitySeq.set(userId, ++this.sessionWriteActivityCounter); // t/4215 budget addendum
    if (!this.sessionOverlayBaseShas.get(userId)?.has(repoPath)) {
      this.recordOverlayBaseShaOnce(userId, repoPath, await this.resolveLiveBaseSha(repoPath, ref));
    }
    let overlay = this.sessionOverlays.get(userId);
    if (!overlay) {
      overlay = new Map();
      this.sessionOverlays.set(userId, overlay);
    }
    overlay.set(repoPath, GitHubAPIBackend.TOMBSTONE);
    // t/4311 follow-up: mirror the tombstone into the shared store — same
    // fire-and-forget shape as writeToOverlay's write-through.
    void this.writeThroughSharedOverlay(userId, repoPath, null, this.sessionOverlayBaseShas.get(userId)?.get(repoPath) ?? 'unknown');
  }

  /**
   * Get all overlay entries for a user, split into writes and deletes.
   * Returns null if there are no pending changes.
   */
  getOverlayEntries(userId: string): { writes: { path: string; content: string }[]; deletes: string[] } | null {
    const overlay = this.sessionOverlays.get(userId);
    if (!overlay || overlay.size === 0) return null;
    const writes: { path: string; content: string }[] = [];
    const deletes: string[] = [];
    for (const [path, content] of overlay) {
      if (content === GitHubAPIBackend.TOMBSTONE) {
        deletes.push(path);
      } else {
        writes.push({ path, content });
      }
    }
    return writes.length > 0 || deletes.length > 0 ? { writes, deletes } : null;
  }

  getSessionOverlay(userId: string): Map<string, string> | undefined {
    return this.sessionOverlays.get(userId);
  }

  /**
   * Read the main-branch base content for a path from the on-disk cache,
   * bypassing the session overlay. Returns null on cache miss. Used to diff
   * pending overlay edits against their pre-edit base (e.g. the taxonomy-updated
   * broadcast in /api/sync/commit). Best-effort: a miss yields null rather than
   * a network fetch.
   */
  async readBaseFromCache(filePath: string): Promise<string | null> {
    return this.readFromDiskCache(this.toRepoPath(filePath));
  }

  clearSessionOverlay(userId: string): void {
    this.sessionOverlays.delete(userId);
    this.sessionOverlayBaseShas.delete(userId); // t/4312 condition 3
    this.sessionOverlayConflicts.delete(userId); // t/4312 condition 3 (SO F1 state)
    this.recordEvent({
      type: 'branch.delete',
      component: 'session',
      level: 'info',
      message: `Session overlay cleared for ${userId}`,
      data: { userId },
    });
  }

  /** t/4312 SO F1 ("Use theirs"), whole-batch per TL's correction (p/538#97):
   *  a per-path discard could leave the same cross-file inconsistency F2
   *  exists to prevent. **Operates on the WHOLE staged overlay, not just
   *  the conflicted subset** (Rosetta Stone's catch, p/641#10/#11): a kept
   *  `edges.json` that references a node only the discarded `skeptic.json`
   *  defined would dangle just as badly as a partial commit would have.
   *  Discards every staged path and its recorded base together — they all
   *  read live from the committed branch again. Idempotent: a no-op (empty
   *  result) when nothing is staged, so a double-call is safe. Returns the
   *  paths actually discarded. */
  discardConflictedOverlayEntries(userId: string): string[] {
    const overlay = this.sessionOverlays.get(userId);
    if (!overlay || overlay.size === 0) return [];
    const targets = [...overlay.keys()];
    this.sessionOverlays.delete(userId);
    this.sessionOverlayBaseShas.delete(userId);
    this.sessionOverlayConflicts.delete(userId);
    return targets;
  }

  /** t/4312 SO F1 ("Keep mine"), whole-batch per TL's correction (p/538#97)
   *  and Rosetta Stone's catch (p/641#10/#11) — same cross-file-consistency
   *  reasoning as discard above. Re-bases EVERY staged path (not just the
   *  conflicted subset) to the branch's CURRENT head together, then
   *  attempts one commit — the staged content now looks fresh against the
   *  new base and intentionally overwrites the other actor's changes (an
   *  explicit, user-confirmed overwrite, never a silent one). `stillConflicted`
   *  is normally empty; non-empty only if another conflict lands in the brief
   *  window between the rebase and the commit — the caller should re-enter
   *  resolution for those, never auto-retry this call. */
  async rebaseAndRecommitConflictedOverlayEntries(
    userId: string, branchName: string,
  ): Promise<{ committed: boolean; commitSha?: string; filesCommitted?: number; stillConflicted: string[] }> {
    if (this.sharedSavesActive(userId)) {
      // t/551: the staged entries are the shared store's; re-base those, not the local read cache.
      if (!(await this.rebaseSharedEntriesForRecommit(userId, branchName))) return { committed: false, stillConflicted: [] };
    } else {
      const overlay = this.sessionOverlays.get(userId);
      if (!overlay || overlay.size === 0) return { committed: false, stillConflicted: [] };
      let bases = this.sessionOverlayBaseShas.get(userId);
      if (!bases) { bases = new Map(); this.sessionOverlayBaseShas.set(userId, bases); }
      for (const path of overlay.keys()) bases.set(path, await this.resolveLiveBaseSha(path, branchName));
    }
    this.sessionOverlayConflicts.delete(userId);

    const result = await this.commitOverlay(userId, undefined, { branchName });
    if (!result) return { committed: false, stillConflicted: [] };
    return {
      committed: (result.conflictedPaths?.length ?? 0) === 0 && result.filesCommitted > 0,
      commitSha: result.commitSha,
      filesCommitted: result.filesCommitted,
      stillConflicted: result.conflictedPaths ?? [],
    };
  }

  /**
   * t/4258/t/4277 (C1): remove only the overlay entries a commit actually
   * committed, and only if they're unchanged since the pre-commit snapshot.
   * A write (or delete) that landed on a path while the commit's GitHub
   * calls were in flight must survive — it wasn't part of what got
   * committed, so clearing it would silently drop it. Unlike
   * clearSessionOverlay() (full wipe, used for session teardown), this is
   * commitOverlayImpl's post-commit cleanup only.
   *
   * t/4312 (condition 2/3): a path that stays staged (content moved mid-flight)
   * gets its recorded base REFRESHED to what we just committed — otherwise
   * the user's own next commit attempt would compare against the old
   * pre-commit base and conflict with itself. A path that does get cleared
   * has its base removed entirely (nothing left to track).
   */
  private clearCommittedOverlayEntries(
    userId: string,
    committed: { writes: { path: string; content: string }[]; deletes: string[] },
  ): void {
    const overlay = this.sessionOverlays.get(userId);
    const bases = this.sessionOverlayBaseShas.get(userId);
    if (overlay) {
      for (const w of committed.writes) {
        if (overlay.get(w.path) === w.content) { overlay.delete(w.path); bases?.delete(w.path); }
        else bases?.set(w.path, gitBlobSha(w.content));
      }
      for (const path of committed.deletes) {
        if (overlay.get(path) === GitHubAPIBackend.TOMBSTONE) { overlay.delete(path); bases?.delete(path); }
        else bases?.set(path, null);
      }
      if (overlay.size === 0) this.sessionOverlays.delete(userId);
    }
    if (bases && bases.size === 0) this.sessionOverlayBaseShas.delete(userId);
  }

  /** t/4312: find which overlay entries' recorded base no longer matches the
   *  current tree (someone else's commit, or our own since-committed
   *  content, moved it). A base-tree lookup failure or a truncated tree
   *  fails CLOSED: every entry conflicts rather than risking a silent
   *  overwrite. SO condition F2 (e/333#2): any conflict means the caller
   *  commits NOTHING this round, so this only needs to report which paths
   *  conflict, not split entries into a safe/conflicted pair. */
  private async partitionOverlayEntriesByBase(
    creds: SyncCredentials, userId: string,
    entries: { writes: { path: string; content: string }[]; deletes: string[] },
    currentSha: string, callId: string, basesOverride?: ReadonlyMap<string, string | null | 'unknown'>,
  ): Promise<{ conflictedPaths: string[] }> {
    const treeResp = await this.rest.request(creds, 'GET',
      `/repos/${creds.repo}/git/trees/${currentSha}?recursive=1`, undefined, callId);
    const failClosed = !treeResp.ok || (treeResp.data as { truncated?: boolean } | null)?.truncated === true;
    const shaByPath: Map<string, string> = failClosed
      ? new Map()
      : new Map((treeResp.data as { tree: { path: string; sha: string; type: string }[] }).tree
          .filter(t => t.type === 'blob').map(t => [t.path, t.sha]));

    const bases = basesOverride ?? this.sessionOverlayBaseShas.get(userId); // t/550: shared entries carry their own base
    // t/4312: 'unknown' means a live lookup was attempted and FAILED — fails
    // closed (always conflicts), never trusted. `undefined` (no base ever
    // recorded — a raw writeToOverlay() call, or an entry that predates this
    // feature) is a DIFFERENT case: there's no evidence anything moved, so it
    // keeps today's behavior rather than treating a bookkeeping gap as proof
    // of a real conflict.
    const isSafe = (path: string): boolean => {
      if (failClosed) return false;
      const base = bases?.get(path);
      if (base === 'unknown') return false;
      if (base === undefined) return true;
      return base === (shaByPath.get(path) ?? null);
    };

    const conflictedPaths = [
      ...entries.writes.map(w => w.path).filter(p => !isSafe(p)),
      ...entries.deletes.filter(p => !isSafe(p)),
    ];

    if (failClosed && conflictedPaths.length > 0) {
      this.recordEvent({
        type: 'github.api.error', component: 'github-api', level: 'warn',
        message: `commitOverlay: base-tree lookup failed or truncated for ${currentSha} — failing closed, ${conflictedPaths.length} path(s) treated as conflicted`,
        data: { currentSha, paths: conflictedPaths },
      });
    }

    return { conflictedPaths };
  }

  private buildOverlayTreeEntries(safe: { writes: { path: string; content: string }[]; deletes: string[] }): Record<string, unknown>[] {
    return [
      ...safe.writes.map(f => ({ path: f.path, mode: '100644', type: 'blob', content: f.content })),
      ...safe.deletes.map(path => ({ path, mode: '100644', type: 'blob', sha: null })), // null SHA = delete from tree
    ];
  }

  private buildOverlayCommitMessage(safe: { writes: { path: string; content: string }[]; deletes: string[] }): string {
    const deleteSuffix = safe.deletes.length > 0 ? `, delete ${safe.deletes.length}` : '';
    return `Update ${safe.writes.length} file(s)${deleteSuffix}`;
  }

  /** Steps 2-4 of commitOverlayImpl (create tree, create commit, update ref) —
   *  extracted to keep commitOverlayImpl's own complexity down after t/4312's
   *  base-fence partitioning. Behavior unchanged from before that change. */
  private async createTreeCommitAndUpdateRef(
    creds: SyncCredentials, branch: string, currentSha: string,
    treeEntries: Record<string, unknown>[], commitMsg: string, callId: string,
    beforeRefUpdate?: () => Promise<void>,
  ): Promise<string> {
    const treeResp = await this.rest.request(creds, 'POST',
      `/repos/${creds.repo}/git/trees`, { base_tree: currentSha, tree: treeEntries }, callId);
    if (!treeResp.ok) {
      throw new ActionableError({
        goal: `Commit overlay to ${branch}`,
        problem: `Failed to create tree: ${treeResp.status} ${treeResp.error}`,
        location: 'GitHubAPIBackend.commitOverlay step 2',
        nextSteps: ['Check file paths and content', 'Verify GitHub App permissions'],
      });
    }
    const newTreeSha = (treeResp.data as { sha: string }).sha;

    const commitResp = await this.rest.request(creds, 'POST',
      `/repos/${creds.repo}/git/commits`, { message: commitMsg, tree: newTreeSha, parents: [currentSha] }, callId);
    if (!commitResp.ok) {
      throw new ActionableError({
        goal: `Commit overlay to ${branch}`,
        problem: `Failed to create commit: ${commitResp.status} ${commitResp.error}`,
        location: 'GitHubAPIBackend.commitOverlay step 3',
        nextSteps: ['Retry — dangling tree is harmless'],
      });
    }
    const commitSha = (commitResp.data as { sha: string }).sha;

    if (beforeRefUpdate) await beforeRefUpdate(); // t/550: abandon here if the commit lease was lost

    const updateResp = await this.rest.request(creds, 'PATCH',
      `/repos/${creds.repo}/git/refs/heads/${branch}`, { sha: commitSha, force: false }, callId);
    if (!updateResp.ok) {
      throw new ActionableError({
        goal: `Commit overlay to ${branch}`,
        problem: `Failed to update branch ref: ${updateResp.status} ${updateResp.error}`,
        location: 'GitHubAPIBackend.commitOverlay step 4',
        nextSteps: ['Retry — tree and commit are already created'],
      });
    }
    return commitSha;
  }

  /** t/4312: one WARN + flight-recorder event naming paths kept staged rather
   *  than silently overwritten. */
  private recordOverlayConflicts(userId: string, branch: string, conflictedPaths: string[]): void {
    const warnMsg = `commitOverlay: ${conflictedPaths.length} path(s) conflicted on ${branch} for ${userId} — kept staged, not overwritten (t/4312)`;
    log.storage.warn({ userId, branch, conflictedPaths }, warnMsg);
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'storage', level: 'warn', message: warnMsg, data: { userId, branch, conflictedPaths },
    });
  }

  /** t/4215: wipe the plain-readFile session cache at true session end. */
  clearSessionReadCache(userId: string): void {
    this.sessionReadCache.delete(userId);
    this.sessionReadCacheHeadSha.delete(userId);
    this.sessionWriteActivitySeq.delete(userId);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

