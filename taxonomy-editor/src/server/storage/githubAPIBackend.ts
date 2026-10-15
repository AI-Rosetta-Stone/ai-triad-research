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
import type { StorageBackend } from './storageBackend.js';
import { getCredentials, getRepoSlug, type SyncCredentials } from '../security/githubAppAuth.js';
import { ActionableError } from '../../../../lib/debate/errors.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import type { FlightRecorder, RecordInput } from '../../../../lib/flight-recorder/index.js';
import { getCurrentUserId, getSessionBranchName } from '../security/userContext.js';
import { GitHubRestClient, normalizeErrorForEvent, type CircuitState } from './githubRestClient.js';
import { getDataRoot } from '../config.js';
import { gitBlobSha } from './gitBlobSha.js';
import { writeFramedNdjson, log } from '../logger.js';

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
}

// ── Constants ────────────────────────────────────────────────────────────

// t/727: cap uncommitted session-overlay memory per user (taxonomy POV files are
// 1–2 MB each; many concurrent editors could otherwise exhaust memory).
const DEFAULT_MAX_OVERLAY_BYTES_PER_USER = 20 * 1024 * 1024; // 20 MB

const POLL_INTERVAL_MS = 60_000;
const ERROR_BUFFER_CAPACITY = 100;

const MANIFEST_FILE = 'manifest.json';

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

  // t/4203 (p/775#56): userId → (repoPath → content) for paths this session
  // already committed to its session branch. commitOverlay() clears the
  // pending overlay above on success, but the content now lives on the
  // session branch, not main — without this baseline, the next read/write
  // falls through to main's stale on-disk cache: a read shows pre-edit
  // content (silently reverting the save), and a write's precondition check
  // (getFileSha, which ignores `ref` and only ever reflects main) compares
  // the client's baseSha against main's stale SHA instead of what was just
  // committed, producing a false WRITE_CONFLICT on every save after the
  // first. Cleared only at session end (clearCommittedOverlayBaseline),
  // never by commitOverlay/clearSessionOverlay themselves.
  private committedOverlayBaseline: Map<string, Map<string, string>> = new Map();

  // Resilient GitHub HTTP transport — rate limit + circuit breaker live here (t/1698).
  private readonly rest: GitHubRestClient;

  // Secondary error-only ring buffer (100 events)
  private errorBuffer: Array<RecordInput & { _wall: number }> = [];

  // Polling timer
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  // Coherency probe stats
  private coherencyViolations = 0;

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

  constructor(config: GitHubAPIBackendConfig) {
    this.cacheDir = config.cacheDir;
    this.recorder = config.recorder ?? null;
    this.pollIntervalMs = config.pollIntervalMs ?? POLL_INTERVAL_MS;
    this.coherencyProbeRate = config.coherencyProbeRate ?? 0.01;
    this.maxOverlayBytesPerUser = config.maxOverlayBytesPerUser
      ?? (process.env.OVERLAY_MAX_BYTES_PER_USER ? parseInt(process.env.OVERLAY_MAX_BYTES_PER_USER, 10) : DEFAULT_MAX_OVERLAY_BYTES_PER_USER);

    this.rest = new GitHubRestClient({
      record: (input) => this.recordEvent(input),
      getEtag: (pathAndQuery) => this.getCachedEtag(pathAndQuery),
      refreshCreds: async () => {
        this.cachedCreds = null;
        this.credsExpiresAt = 0;
        return this.getCredsCached();
      },
    });

    this.registerSigHandler();
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
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
      return;
    }

    const mainSha = await this.getLatestCommitSha();
    if (this.manifest && this.manifest.lastCommitSha === mainSha) {
      this.recordEvent({
        type: 'cache.hit',
        component: 'cache',
        level: 'info',
        message: 'Cache manifest matches main HEAD — serving from cache',
        data: { sha: mainSha, fileCount: Object.keys(this.manifest.files).length },
      });
      this._dataLoadStatus = 'ready';
    } else {
      const loaded = await this.fetchRepoTree(mainSha);
      if (loaded) {
        this._dataLoadStatus = 'ready';
      } else {
        this._dataLoadStatus = 'failed';
        this._dataLoadError = 'GitHub API data load failed during initialization — check credentials and network';
        this.recordEvent({
          type: 'github.api.error',
          component: 'github-api',
          level: 'error',
          message: 'initialize: data load failed — /healthz will report 503 until recovery',
          data: { sha: mainSha },
        });
      }
      if (this.manifest && mainSha) {
        await this.invalidateChangedFiles(this.manifest.lastCommitSha, mainSha);
      }
      if (mainSha) {
        await this.updateManifestSha(mainSha);
      }
    }

    this.startPolling();
  }

  shutdown(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
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

    // t/4203: fall back to what this session already committed, before
    // falling through to main's (stale, from this session's perspective) cache.
    const baseline = this.committedOverlayBaseline.get(readUserId);
    if (baseline?.has(repoPath)) {
      const val = baseline.get(repoPath)!;
      this.recordEvent({
        type: 'cache.hit',
        component: 'cache',
        level: 'debug',
        message: `Committed-session baseline hit: ${repoPath}`,
        data: { path: repoPath, layer: 'session-committed', userId: readUserId },
      });
      return val;
    }

    return undefined;
  }

  /**
   * Read a file as UTF-8, or null if absent.
   *
   * `opts.ref` pins the GitHub API fallback to a specific ref (e.g. 'main') for
   * shared data that lives on main rather than the caller's session branch —
   * community submissions, calibration logs. Without it, a cache miss fetches
   * with the effective session-branch ref, which 404s for shared files (the file
   * doesn't exist on the branch) and burns rate limit. See t/684.
   *
   * The session overlay is still consulted first regardless of `opts.ref`, so
   * in-session writes remain visible (read-your-writes) — this is required by the
   * read-modify-write flows in community/calibration curation, where the same
   * shared file is appended to multiple times within one request.
   */
  async readFile(filePath: string, opts?: { ref?: string; optional?: boolean }): Promise<string | null> {
    const repoPath = this.toRepoPath(filePath);

    // Check session overlay first
    const overlayVal = this.checkSessionOverlay(repoPath);
    if (overlayVal !== undefined) {
      return overlayVal === GitHubAPIBackend.TOMBSTONE ? null : overlayVal;
    }

    // Check main cache (on-disk)
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

    // Cache miss — fetch from GitHub
    this.recordEvent({
      type: 'cache.miss',
      component: 'cache',
      level: 'info',
      message: `Cache miss: ${repoPath}`,
      data: { path: repoPath, reason: 'missing' },
    });

    if (this.rest.isTripped()) {
      return null; // Circuit open — serve null (file not available)
    }

    // Pinned ref (e.g. 'main') for shared data; else the effective session ref.
    const ref = opts?.ref ?? this.getEffectiveRef();
    const result = await this.fetchFileFromGitHub(repoPath, ref, opts?.optional);
    if (result === null) return null;

    // Write-through to disk cache
    await this.writeToDiskCache(repoPath, result.content, result.sha, result.etag);
    return result.content;
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
   */
  async readFileWithVersion(filePath: string, opts?: { ref?: string }): Promise<{ content: string; version: string } | null> {
    const repoPath = this.toRepoPath(filePath);

    const overlayVal = this.checkSessionOverlay(repoPath);
    if (overlayVal !== undefined) {
      return overlayVal === GitHubAPIBackend.TOMBSTONE ? null : { content: overlayVal, version: gitBlobSha(overlayVal) };
    }

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
    const ref = opts?.ref ?? this.getEffectiveRef();
    const result = await this.fetchFileFromGitHub(repoPath, ref);
    if (result === null) return null;

    await this.writeToDiskCache(repoPath, result.content, result.sha, result.etag);
    return { content: result.content, version: result.sha };
  }

  async readBinaryFile(filePath: string): Promise<Buffer | null> {
    const repoPath = this.toRepoPath(filePath);

    const cached = await this.readBinaryFromDiskCache(repoPath);
    if (cached !== null) return cached;

    if (this.rest.isTripped()) return null;

    const ref = this.getEffectiveRef();
    const result = await this.fetchBinaryFileFromGitHub(repoPath, ref);
    if (result === null) return null;

    await this.writeBinaryToDiskCache(repoPath, result.content, result.sha, result.etag);
    return result.content;
  }

  async readFileAtRef(repoPath: string, ref: string): Promise<string | null> {
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
    // t/4203: checkSessionOverlay also consults what this session already
    // committed, so a save right after a commit compares against that, not
    // main's stale cached SHA (which ignores `ref` entirely) — otherwise a
    // false WRITE_CONFLICT fires on every save after the first.
    const existing = this.checkSessionOverlay(repoPath);
    const currentVersion = existing !== undefined && existing !== GitHubAPIBackend.TOMBSTONE
      ? gitBlobSha(existing)
      : await this.getFileSha(repoPath, ref);

    if (baseSha === undefined) {
      this.recordEvent({
        type: 'storage.fallback', component: 'github-api', level: 'warn',
        message: `writeFile(${repoPath}): no baseSha supplied on overlay write — falling back to no precondition (direct fileIO caller, not the save route)`,
        data: { path: repoPath, ref },
      });
    } else if (currentVersion !== null && baseSha !== currentVersion) {
      this.recordEvent({
        type: 'github.api.conflict', component: 'github-api', level: 'warn',
        message: `Overlay write conflict on ${repoPath} — staged content moved since the client's last read`,
        data: { path: repoPath, ref, staleSha: baseSha, currentSha: currentVersion },
      });
      throw this.writeConflictError(repoPath, 'writeFile');
    }

    this.writeToOverlay(filePath, content);
    return { version: gitBlobSha(content) };
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
    const repoPath = this.toRepoPath(dirPath);
    const prefix = repoPath ? repoPath + '/' : '';

    // Build the base listing (direct children) from the in-memory tree, falling
    // back to the GitHub Contents API. Collected as a Set so the session overlay
    // merge below can add/remove entries idempotently.
    const seen = new Set<string>();

    if (this.repoTree.size > 0) {
      for (const [p] of this.repoTree) {
        if (prefix && !p.startsWith(prefix)) continue;
        const rest = prefix ? p.slice(prefix.length) : p;
        if (!rest) continue;
        // Direct children only — first path segment under the prefix.
        seen.add(rest.split('/')[0]);
      }
    } else if (!(this.rest.isTripped())) {
      await this.fetchDirectoryFromAPI(repoPath, opts, seen);
    } else {
      log.server.warn({ dir: repoPath, cause: 'circuit-breaker-open' }, 'listDirectory returning [] — circuit breaker open, may be false-empty (t/3300)');
    }

    // Merge the session overlay so files written this session are visible and
    // tombstoned files are hidden — mirroring readFile()/fileExists() semantics.
    // Without this, submissions written to the overlay (e.g. community submits)
    // are invisible to listDirectory() until the overlay is flushed on commit.
    this.mergeOverlayIntoListing(prefix, seen);

    return [...seen];
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
    const ref = opts?.ref ?? this.getEffectiveRef();
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

  private async fetchDirectoryFromAPI(
    repoPath: string, opts: { ref?: string } | undefined, seen: Set<string>,
  ): Promise<void> {
    const creds = await this.getCredsCached();
    if (creds) {
      const ref = opts?.ref ?? this.getEffectiveRef();
      const qRef = ref === 'main' ? '' : `?ref=${encodeURIComponent(ref)}`;
      const resp = await this.rest.request(creds, 'GET',
        `/repos/${creds.repo}/contents/${repoPath}${qRef}`);
      if (resp.ok && Array.isArray(resp.data)) {
        for (const e of resp.data as Array<{ name: string }>) seen.add(e.name);
      } else if (!resp.ok) {
        log.server.warn({ dir: repoPath, status: (resp as { status?: number }).status, cause: 'api-non-ok' }, 'listDirectory returning [] — GitHub API non-ok response, may be false-empty (t/3300)');
      }
    } else {
      log.server.warn({ dir: repoPath, cause: 'no-credentials' }, 'listDirectory returning [] — no GitHub credentials available, may be false-empty (t/3300)');
    }
  }

  /**
   * Merge the active session overlay into a base directory listing (in place).
   * Adds the direct-child segment of each non-tombstoned overlay entry under
   * `prefix`, and removes direct-file children that have been tombstoned.
   * Tombstones for files nested in subdirectories do not remove the subdirectory
   * segment, since other (non-deleted) files may still live under it.
   */
  private mergeOverlayIntoListing(prefix: string, entries: Set<string>): void {
    if (this.getEffectiveRef() === this.baseBranch) return;
    const userId = this.getEffectiveUserId();
    if (!userId) return;
    const overlay = this.sessionOverlays.get(userId);
    if (!overlay) return;

    for (const [p, content] of overlay) {
      if (prefix && !p.startsWith(prefix)) continue;
      const rest = prefix ? p.slice(prefix.length) : p;
      if (!rest) continue;
      const seg = rest.split('/')[0];
      const isDirectFile = !rest.includes('/');
      if (content === GitHubAPIBackend.TOMBSTONE) {
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
      this.deleteFromOverlay(filePath);
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

  async fileExists(filePath: string): Promise<boolean> {
    const repoPath = this.toRepoPath(filePath);

    // Check session overlay
    const existsBranch = this.getEffectiveRef();
    const existsUserId = this.getEffectiveUserId();
    if (existsBranch !== this.baseBranch && existsUserId) {
      const overlay = this.sessionOverlays.get(existsUserId);
      if (overlay?.has(repoPath)) return overlay.get(repoPath) !== GitHubAPIBackend.TOMBSTONE;
    }

    // Check disk cache manifest
    if (this.manifest?.files[repoPath]) return true;

    // Check in-memory tree
    if (this.repoTree.has(repoPath)) return true;

    // Check for directory in tree
    if (this.repoTree.size > 0) {
      const prefix = repoPath + '/';
      for (const [p] of this.repoTree) {
        if (p.startsWith(prefix)) return true;
      }
    }

    // Fallback: HEAD request to Contents API
    if (this.rest.isTripped()) return false;

    const creds = await this.getCredsCached();
    if (!creds) return false;

    const ref = this.getEffectiveRef();
    const qRef = ref === 'main' ? '' : `?ref=${encodeURIComponent(ref)}`;
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

    const data = resp.data as { tree: TreeEntry[]; truncated?: boolean };
    if (data.truncated) {
      this.recordEvent({
        type: 'system.scaling_warning',
        component: 'github-api',
        level: 'warn',
        message: 'Git Trees API returned truncated result (>100,000 entries)',
        data: { sha, entryCount: data.tree.length },
      });
    }
    return data.tree;
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
  async commitOverlay(userId: string, message?: string): Promise<{ commitSha: string; filesCommitted: number } | null> {
    const entries = this.getOverlayEntries(userId);
    if (!entries) return null;

    const branch = this.getEffectiveRef();
    if (branch === this.baseBranch) {
      throw new ActionableError({
        goal: 'Commit overlay to GitHub',
        problem: `Cannot commit overlay to base branch '${this.baseBranch}'.`,
        location: 'GitHubAPIBackend.commitOverlay',
        nextSteps: ['Ensure a session branch is active'],
      });
    }

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

    // Step 2: Create tree with writes + deletes
    const treeEntries: Record<string, unknown>[] = [
      ...entries.writes.map(f => ({
        path: f.path,
        mode: '100644',
        type: 'blob',
        content: f.content,
      })),
      ...entries.deletes.map(path => ({
        path,
        mode: '100644',
        type: 'blob',
        sha: null, // null SHA = delete from tree
      })),
    ];

    const commitMsg = message || `Update ${entries.writes.length} file(s)${entries.deletes.length > 0 ? `, delete ${entries.deletes.length}` : ''}`;

    const treeResp = await this.rest.request(creds, 'POST',
      `/repos/${creds.repo}/git/trees`, {
        base_tree: currentSha,
        tree: treeEntries,
      }, callId);
    if (!treeResp.ok) {
      throw new ActionableError({
        goal: `Commit overlay to ${branch}`,
        problem: `Failed to create tree: ${treeResp.status} ${treeResp.error}`,
        location: 'GitHubAPIBackend.commitOverlay step 2',
        nextSteps: ['Check file paths and content', 'Verify GitHub App permissions'],
      });
    }
    const newTreeSha = (treeResp.data as { sha: string }).sha;

    // Step 3: Create commit
    const commitResp = await this.rest.request(creds, 'POST',
      `/repos/${creds.repo}/git/commits`, {
        message: commitMsg,
        tree: newTreeSha,
        parents: [currentSha],
      }, callId);
    if (!commitResp.ok) {
      throw new ActionableError({
        goal: `Commit overlay to ${branch}`,
        problem: `Failed to create commit: ${commitResp.status} ${commitResp.error}`,
        location: 'GitHubAPIBackend.commitOverlay step 3',
        nextSteps: ['Retry — dangling tree is harmless'],
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
        goal: `Commit overlay to ${branch}`,
        problem: `Failed to update branch ref: ${updateResp.status} ${updateResp.error}`,
        location: 'GitHubAPIBackend.commitOverlay step 4',
        nextSteps: ['Retry — tree and commit are already created'],
      });
    }

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

    // t/4203: remember what just landed on the session branch before clearing
    // the pending overlay below — otherwise the next read/write for these
    // paths this session falls through to main's stale cache (see the field
    // comment on committedOverlayBaseline).
    let baseline = this.committedOverlayBaseline.get(userId);
    if (!baseline) {
      baseline = new Map();
      this.committedOverlayBaseline.set(userId, baseline);
    }
    for (const w of entries.writes) baseline.set(w.path, w.content);
    for (const d of entries.deletes) baseline.set(d, GitHubAPIBackend.TOMBSTONE);

    // Clear overlay only on success (Tech Lead note #2)
    this.clearSessionOverlay(userId);

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

    const resp = await this.rest.request(creds, 'GET',
      `/repos/${creds.repo}/compare/${base}...${head}`);

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

    // t/4203 (TL probe, p/775#64): this merge just moved the session branch
    // HEAD independently of commitOverlay — any path already in this user's
    // committed baseline may now hold content the merge brought in from main,
    // not what we last recorded. Refresh before returning, or a save right
    // after this resync could pass its precondition against stale pre-merge
    // content and silently erase main's merged change on the next commit.
    const userId = this.getEffectiveUserId();
    if (userId) await this.refreshCommittedBaselineAfterMerge(userId, branch);

    return { ok: true, sha: data.sha, conflicts: false, message: `Merged main into ${branch}` };
  }

  /**
   * t/4203: re-fetch every path this user's committed-session baseline
   * tracks from the branch's new (post-merge) HEAD, so the baseline reflects
   * what the session branch actually holds, not stale pre-merge content.
   * Fails closed: a path whose refresh doesn't succeed is evicted rather than
   * kept — the next precondition check for it falls through to getFileSha()
   * (the same degraded-but-safe behavior from before this baseline existed),
   * never silently trusts content that couldn't be re-verified.
   */
  private async refreshCommittedBaselineAfterMerge(userId: string, branch: string): Promise<void> {
    const baseline = this.committedOverlayBaseline.get(userId);
    if (!baseline || baseline.size === 0) return;

    for (const repoPath of [...baseline.keys()]) {
      const result = await this.fetchFileFromGitHub(repoPath, branch, true);
      if (result === null) {
        baseline.delete(repoPath);
        this.recordEvent({
          type: 'storage.fallback', component: 'github-api', level: 'warn',
          message: `Committed-session baseline refresh failed for ${repoPath} after merge into ${branch} — evicted (fail closed)`,
          data: { path: repoPath, branch, userId },
        });
        continue;
      }
      baseline.set(repoPath, result.content);
    }
  }

  // ── Path contract ──────────────────────────────────────────────────────

  private toRepoPath(filePath: string): string {
    let p = filePath;

    // Strip the data-root prefix to get the repo-relative path. Use getDataRoot()
    // (the actual source of incoming absolute paths from fileIO.ts) rather than
    // this.cacheDir (the disk-cache write location) — they can diverge when the
    // cache is on a separate mount (e.g. TAXONOMY_CACHE_DIR != AI_TRIAD_DATA_ROOT),
    // which caused staging github-api reads to 404 (t/2670).
    const dataRoot = getDataRoot();
    if (p.startsWith(dataRoot)) {
      p = p.slice(dataRoot.length);
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

    // Reject path traversal
    if (p.includes('..')) {
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

    const diskPath = path.join(this.cacheDir, repoPath);
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

    const diskPath = path.join(this.cacheDir, repoPath);
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
    const diskPath = path.join(this.cacheDir, repoPath);
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
  }

  private async writeBinaryToDiskCache(
    repoPath: string, content: Buffer, sha: string, etag: string,
  ): Promise<void> {
    const diskPath = path.join(this.cacheDir, repoPath);
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
  }

  private async removeFromDiskCache(repoPath: string): Promise<void> {
    const diskPath = path.join(this.cacheDir, repoPath);
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
    // Extract repo path from the API endpoint
    const match = pathAndQuery.match(/\/contents\/(.+?)(\?|$)/);
    if (!match) return null;
    const entry = this.manifest.files[match[1]];
    return entry?.etag || null;
  }

  // ── GitHub file operations (low-level) ─────────────────────────────────

  private async fetchFileFromGitHub(
    repoPath: string,
    ref: string,
    optional?: boolean,
  ): Promise<{ content: string; sha: string; etag: string } | null> {
    const creds = await this.getCredsCached();
    if (!creds) return null;

    const qRef = ref === 'main' ? '' : `?ref=${encodeURIComponent(ref)}`;
    const resp = await this.rest.request(creds, 'GET',
      `/repos/${creds.repo}/contents/${repoPath}${qRef}`,
      undefined, undefined, optional ? { optional: true } : undefined);

    if (!resp.ok) return null;

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
    const resp = await this.rest.request(creds, 'GET',
      `/repos/${creds.repo}/contents/${repoPath}${qRef}`);

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
        return this.fetchBinaryBlobFromGitHub(creds, data.sha, resp.etag ?? '');
      }
      return null;
    }

    const content = Buffer.from(data.content, 'base64');
    return { content, sha: data.sha, etag: resp.etag ?? '' };
  }

  private async fetchBinaryBlobFromGitHub(
    creds: SyncCredentials,
    sha: string,
    etag: string,
  ): Promise<{ content: Buffer; sha: string; etag: string } | null> {
    const resp = await this.rest.request(creds, 'GET',
      `/repos/${creds.repo}/git/blobs/${sha}`);

    if (!resp.ok) return null;

    const data = resp.data as { content: string; encoding: string; sha: string };
    const content = data.encoding === 'base64'
      ? Buffer.from(data.content, 'base64')
      : Buffer.from(data.content);
    return { content, sha: data.sha, etag: resp.etag ?? etag };
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
    if (!resp.ok) return null;
    return (resp.data as { sha: string }).sha;
  }

  // ── Repo tree ──────────────────────────────────────────────────────────

  private async fetchRepoTree(commitSha: string): Promise<boolean> {
    if (!commitSha) return false;

    const creds = await this.getCredsCached();
    if (!creds) return false;

    // Get the tree SHA from the commit
    const commitResp = await this.rest.request(creds, 'GET',
      `/repos/${creds.repo}/git/commits/${commitSha}`);
    if (!commitResp.ok) return false;

    const treeSha = (commitResp.data as { tree: { sha: string } }).tree.sha;
    const entries = await this.getTree(treeSha, true);

    this.repoTree.clear();
    for (const entry of entries) {
      if (entry.type === 'blob') {
        this.repoTree.set(entry.path, entry);
      }
    }
    this.treeSha = treeSha;

    // Zero blobs = undici session-reuse returning stale/empty response (t/2053).
    // A valid taxonomy repo always has files — treat 0 as a load failure and
    // log at error-level so ops has a signal instead of a silent /healthz 503.
    if (this.repoTree.size === 0) {
      this.recordEvent({
        type: 'github.api.error',
        component: 'github-api',
        level: 'error',
        message: 'fetchRepoTree: 0 blobs loaded — data-load failed (check GitHub API response and undici version)',
        data: { commitSha, treeSha },
      });
      return false;
    }

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

    this.pollTimer = setInterval(() => void (async () => {
      try {
        const currentSha = await this.getLatestCommitSha();
        if (!currentSha || currentSha === this.manifest?.lastCommitSha) return;

        const changed = this.manifest?.lastCommitSha
          ? await this.getChangedFiles(this.manifest.lastCommitSha, currentSha)
          : [];

        if (changed.length > 0) {
          this.recordEvent({
            type: 'cache.invalidate',
            component: 'cache',
            level: 'info',
            message: `Poll: ${changed.length} files changed`,
            data: { paths: changed.slice(0, 20), trigger: 'poll', sha: currentSha },
          });

          // Invalidate changed files from disk cache (under manifest lock)
          await this.withManifestLock(async () => {
            for (const filePath of changed) {
              if (this.manifest?.files[filePath]) {
                delete this.manifest.files[filePath];
              }
            }
          });
        }

        // Update tree
        await this.fetchRepoTree(currentSha);
        await this.updateManifestSha(currentSha);
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
    })(), this.pollIntervalMs);
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
  getCircuitState(): CircuitState { return this.rest.getCircuitState(); }
  getCoherencyViolations(): number { return this.coherencyViolations; }
  getErrorBuffer(): Array<RecordInput & { _wall: number }> { return [...this.errorBuffer]; }
  getActiveBranchCount(): number { return this.sessionOverlays.size; }
  getCacheHitRate(): number {
    // Approximation from tree + manifest coverage
    if (this.repoTree.size === 0) return 0;
    const cachedCount = this.manifest ? Object.keys(this.manifest.files).length : 0;
    return Math.min(1, cachedCount / Math.max(1, this.repoTree.size));
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
    let overlay = this.sessionOverlays.get(userId);
    if (!overlay) {
      overlay = new Map();
      this.sessionOverlays.set(userId, overlay);
    }

    // t/727: cap per-user overlay memory. Project the post-write total using
    // replace semantics (the new content supersedes any existing entry for this
    // path). Reject with 413 rather than silently growing unbounded.
    const newBytes = Buffer.byteLength(content, 'utf-8');
    const existing = overlay.get(repoPath);
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

    overlay.set(repoPath, content);
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
   */
  deleteFromOverlay(filePath: string): void {
    const repoPath = this.toRepoPath(filePath);
    const userId = this.getEffectiveUserId();
    if (!userId) return;
    let overlay = this.sessionOverlays.get(userId);
    if (!overlay) {
      overlay = new Map();
      this.sessionOverlays.set(userId, overlay);
    }
    overlay.set(repoPath, GitHubAPIBackend.TOMBSTONE);
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

  /** t/4203: test/diagnostic accessor for the committed-session baseline. */
  getCommittedOverlayBaseline(userId: string): Map<string, string> | undefined {
    return this.committedOverlayBaseline.get(userId);
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
    this.recordEvent({
      type: 'branch.delete',
      component: 'session',
      level: 'info',
      message: `Session overlay cleared for ${userId}`,
      data: { userId },
    });
  }

  /**
   * t/4203: wipe the committed-session baseline (see the field comment on
   * committedOverlayBaseline) — unlike clearSessionOverlay, NOT called by
   * commitOverlay itself (that would erase the baseline it just set). Call
   * this only when the session truly ends (branch deleted), alongside
   * clearSessionOverlay — see SessionBranchManager.deleteBranch.
   */
  clearCommittedOverlayBaseline(userId: string): void {
    this.committedOverlayBaseline.delete(userId);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

