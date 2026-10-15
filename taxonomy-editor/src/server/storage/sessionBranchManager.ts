// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * SessionBranchManager — per-user branch lifecycle and batch commits.
 *
 * Manages `api-session/{sanitizedUserId}` branches on GitHub:
 *   - Lazy branch creation on first edit (no branch until user saves)
 *   - Batch commits via Git Trees API (4 API calls per save-batch)
 *   - Per-user commit mutex (serializes concurrent saves for multi-tab safety)
 *   - Token freshness check (>60s remaining before batch commit)
 *   - PR creation from session branch → main
 *   - Branch lifecycle: create → commit → PR → merge → delete
 *
 * See docs/github-api-first-implementation.md Phase 2B.
 */

import crypto from 'crypto';
import type { GitHubAPIBackend, FileChange } from './githubAPIBackend.js';
import { getTokenExpiryMs, getCredentials } from '../security/githubAppAuth.js';
import { ActionableError } from '../../../../lib/debate/errors.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import type { FlightRecorder, RecordInput } from '../../../../lib/flight-recorder/index.js';
import { getConfig } from '../runtimeConfig.js';

// ── Constants ────────────────────────────────────────────────────────────

const BRANCH_PREFIX = 'api-session/';
const MAX_BRANCH_NAME_LENGTH = 100;
// t/929: token-freshness threshold + lock timeouts are runtime-configurable via
// getConfig().sessions.* (BRANCH_PREFIX / MAX_BRANCH_NAME_LENGTH stay constant —
// restart-required, spec §2.12).

// ── Branch name sanitization ─────────────────────────────────────────────

// Characters disallowed in git refs: space ~ ^ : ? * [ \ and control chars
const DISALLOWED_REF_CHARS = /[\s~^:?*[\]\\]/g;

/**
 * Sanitize a userId into a valid git branch name segment.
 *
 * - Replaces disallowed git ref characters with `-`
 * - Lowercases
 * - Truncates to 100 chars (including `api-session/` prefix)
 * - Rejects empty result
 *
 * Examples:
 *   `jeff@example.com` → `jeff-example-com`
 *   `JeffSnover`       → `jeffsnover`
 */
export function sanitizeBranchName(userId: string): string {
  let sanitized = userId
    .toLowerCase()
    .replace(DISALLOWED_REF_CHARS, '-')
    .replace(/\.{2,}/g, '-')           // consecutive dots are disallowed in refs
    .replace(/\/\./g, '/-')            // component starting with dot
    .replace(/@/g, '-')                // @ common in email userIds
    .replace(/-{2,}/g, '-')            // collapse consecutive dashes
    .replace(/^-+|-+$/g, '')           // trim leading/trailing dashes
    .replace(/\.lock$/i, '-lock');     // .lock suffix is reserved by git

  // Truncate so full branch name fits within limit
  const maxSegmentLength = MAX_BRANCH_NAME_LENGTH - BRANCH_PREFIX.length;
  if (sanitized.length > maxSegmentLength) {
    sanitized = sanitized.slice(0, maxSegmentLength).replace(/-+$/, '');
  }

  if (!sanitized) {
    throw new ActionableError({
      goal: 'Sanitize user ID for branch name',
      problem: `userId "${userId}" produces an empty branch name after sanitization`,
      location: 'sanitizeBranchName',
      nextSteps: ['Ensure the userId contains at least one alphanumeric character'],
    });
  }

  return sanitized;
}

// ── Mutex ────────────────────────────────────────────────────────────────

interface MutexEntry {
  promise: Promise<void>;
  resolve: () => void;
  acquiredAt: number;
  ttlTimer: ReturnType<typeof setTimeout>;
}

/**
 * Per-user commit mutex. Serializes the 4-step Trees API batch commit
 * for the same user (multi-tab safety). Two browser tabs saving
 * simultaneously → second save waits for first to complete.
 */
class CommitMutex {
  private locks = new Map<string, MutexEntry>();
  private recorder: FlightRecorder | null;

  constructor(recorder: FlightRecorder | null) {
    this.recorder = recorder;
  }

  async acquire(userId: string, requestId?: string): Promise<void> {
    const startMs = Date.now();

    this.recordLockEvent('lock.acquire_attempt', userId, requestId, {});

    // Wait for any existing lock to release
    const existing = this.locks.get(userId);
    if (existing) {
      const timeoutPromise = new Promise<never>((_, reject) => {
        // eslint-disable-next-line @typescript-eslint/no-use-before-define -- class defined below, safe at call-time
        setTimeout(() => reject(new LockTimeoutError(userId, Date.now() - startMs)), getConfig().sessions.lockAcquireTimeoutMs);
      });

      try {
        await Promise.race([existing.promise, timeoutPromise]);
      } catch (err) {
        getGlobalRecorder()?.record({
          type: 'system.error',
          component: 'session-branch',
          level: 'error',
          message: 'Operation failed',
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        });
        // eslint-disable-next-line @typescript-eslint/no-use-before-define
        if (err instanceof LockTimeoutError) {
          this.recordLockEvent('lock.timeout', userId, requestId, {
            wait_duration_ms: Date.now() - startMs,
          });
          throw err;
        }
        // Lock holder threw — we can proceed
      }
    }

    // Acquire the lock
    let lockResolve!: () => void;
    const lockPromise = new Promise<void>(resolve => { lockResolve = resolve; });

    const ttlTimer = setTimeout(() => {
      this.recordLockEvent('lock.ttl_eviction', userId, requestId, {
        hold_duration_ms: getConfig().sessions.lockHoldTtlMs,
      });
      this.release(userId);
    }, getConfig().sessions.lockHoldTtlMs);

    this.locks.set(userId, {
      promise: lockPromise,
      resolve: lockResolve,
      acquiredAt: Date.now(),
      ttlTimer,
    });

    this.recordLockEvent('lock.acquired', userId, requestId, {
      wait_duration_ms: Date.now() - startMs,
    });
  }

  release(userId: string): void {
    const entry = this.locks.get(userId);
    if (!entry) return;

    clearTimeout(entry.ttlTimer);

    this.recordLockEvent('lock.released', userId, undefined, {
      hold_duration_ms: Date.now() - entry.acquiredAt,
    });

    this.locks.delete(userId);
    entry.resolve();
  }

  private recordLockEvent(
    type: RecordInput['type'],
    userId: string,
    requestId: string | undefined,
    data: Record<string, unknown>,
  ): void {
    if (!this.recorder) return;
    this.recorder.record({
      type,
      component: 'session',
      level: type === 'lock.timeout' || type === 'lock.ttl_eviction' ? 'error' : 'debug',
      message: `${type}: user commit mutex for ${userId}`,
      request_id: requestId,
      data: { lock_type: 'user', key: userId, ...data },
    });
  }
}

class LockTimeoutError extends ActionableError {
  constructor(userId: string, waitMs: number) {
    super({
      goal: `Acquire commit mutex for user ${userId}`,
      problem: `Lock acquisition timed out after ${waitMs}ms. Another save operation may be stuck.`,
      location: 'CommitMutex.acquire',
      nextSteps: [
        'Wait a few seconds and retry the save',
        'If the problem persists, check for a stalled batch commit in the flight recorder',
      ],
    });
  }
}

// ── SessionBranchManager ─────────────────────────────────────────────────

export interface SessionBranchState {
  branchName: string;
  userId: string;
  createdAt: number;         // epoch ms
  lastCommitAt: number;      // epoch ms, 0 if no commits yet
  lastCommitSha: string;
  prNumber: number | null;
  prUrl: string | null;
}

export class SessionBranchManager {
  private readonly backend: GitHubAPIBackend;
  private readonly recorder: FlightRecorder | null;
  private readonly mutex: CommitMutex;

  // userId → branch state (in-memory tracking of active sessions)
  private sessions = new Map<string, SessionBranchState>();

  constructor(backend: GitHubAPIBackend, recorder?: FlightRecorder) {
    this.backend = backend;
    this.recorder = recorder ?? null;
    this.mutex = new CommitMutex(this.recorder);
  }

  // ── Branch lifecycle ─────────────────────────────────────────────────

  /**
   * Get the active session branch for a user, or undefined if none exists.
   * Returns the in-memory tracking state; call `checkBranchExists` to
   * verify against GitHub on session resume.
   */
  getActiveBranch(userId: string): string | undefined {
    return this.sessions.get(userId)?.branchName;
  }

  /**
   * Resolve the session branch for a user — fast in-memory check first,
   * then GitHub fallback for cold starts / server restarts.
   * Does NOT create a branch (read-safe). Returns undefined if no branch exists.
   */
  async resolveBranch(userId: string): Promise<string | undefined> {
    const cached = this.sessions.get(userId);
    if (cached) return cached.branchName;
    if (userId === '_local') return undefined;
    const exists = await this.checkBranchExists(userId);
    return exists ? this.sessions.get(userId)?.branchName : undefined;
  }

  /** Get the full state for a user's session, or undefined. */
  getSessionState(userId: string): SessionBranchState | undefined {
    return this.sessions.get(userId);
  }

  /**
   * Ensure a session branch exists for the user. Creates one lazily
   * from main HEAD if it doesn't exist yet.
   *
   * Called on first edit — reads come from main until this is invoked.
   */
  async ensureBranch(userId: string): Promise<string> {
    const existing = this.sessions.get(userId);
    if (existing) return existing.branchName;

    const sanitized = sanitizeBranchName(userId);
    const branchName = BRANCH_PREFIX + sanitized;

    // Check if the branch already exists on GitHub (session resume)
    const exists = await this.branchExistsOnGitHub(branchName);

    if (!exists) {
      await this.backend.createBranch(branchName);
    }

    const state: SessionBranchState = {
      branchName,
      userId,
      createdAt: Date.now(),
      lastCommitAt: 0,
      lastCommitSha: '',
      prNumber: null,
      prUrl: null,
    };
    this.sessions.set(userId, state);

    this.recordEvent({
      type: exists ? 'branch.create' : 'branch.create',
      component: 'session',
      level: 'info',
      message: exists
        ? `Resumed existing session branch: ${branchName}`
        : `Created session branch: ${branchName}`,
      data: { branch: branchName, userId, resumed: exists },
    });

    return branchName;
  }

  /**
   * Batch commit changed files to the user's session branch.
   *
   * Uses the Git Trees API for a single commit per save-batch
   * (4 API calls regardless of file count). Per-user mutex serializes
   * concurrent saves from multiple tabs.
   *
   * The existing 2s debounce in the client batches pending changes
   * before this is called.
   */
  async commitBatch(
    userId: string,
    files: FileChange[],
    message?: string,
  ): Promise<string> {
    if (files.length === 0) {
      throw new ActionableError({
        goal: 'Batch commit to session branch',
        problem: 'No files to commit',
        location: 'SessionBranchManager.commitBatch',
        nextSteps: ['Ensure at least one file has been modified before saving'],
      });
    }

    // Ensure branch exists (lazy creation)
    const branchName = await this.ensureBranch(userId);

    // Token freshness check — validate >60s remaining before starting
    await this.ensureTokenFreshness();

    const requestId = crypto.randomUUID();
    const commitMessage = message ?? this.buildCommitMessage(userId, files);

    // Acquire per-user mutex (serializes multi-tab concurrent saves)
    await this.mutex.acquire(userId, requestId);
    try {
      const commitSha = await this.backend.createCommitFromTree(
        branchName,
        files,
        commitMessage,
      );

      // Update session state
      const state = this.sessions.get(userId);
      if (state) {
        state.lastCommitAt = Date.now();
        state.lastCommitSha = commitSha;
      }

      return commitSha;
    } finally {
      this.mutex.release(userId);
    }
  }

  /**
   * Create (or update) a PR from the user's session branch to main.
   */
  async createPR(
    userId: string,
    title?: string,
    body?: string,
  ): Promise<{ number: number; url: string }> {
    const state = this.sessions.get(userId);
    if (!state) {
      throw new ActionableError({
        goal: 'Create pull request',
        problem: `No active session branch for user ${userId}`,
        location: 'SessionBranchManager.createPR',
        nextSteps: ['Make an edit first — a session branch is created on first save'],
      });
    }

    const prTitle = title ?? `Taxonomy edits by ${userId}`;
    const prBody = body ?? `Session branch: \`${state.branchName}\`\n\nAutomated PR from the Taxonomy Editor.`;

    const pr = await this.backend.createOrUpdatePR(state.branchName, prTitle, prBody);

    state.prNumber = pr.number;
    state.prUrl = pr.url;

    return pr;
  }

  /**
   * Delete the user's session branch (after PR merge or manual cleanup).
   * Clears the in-memory session state and the backend's session overlay.
   */
  async deleteBranch(userId: string, reason: 'pr-merged' | 'manual' | 'ttl' = 'manual'): Promise<void> {
    const state = this.sessions.get(userId);
    if (!state) return;

    const creds = await getCredentials();
    if (!creds) return;

    // Delete the branch ref on GitHub. Encode each URL segment so injected
    // characters in creds.repo or branchName cannot alter the URL structure.
    const [delOwner, delRepo] = creds.repo.split('/');
    if (!delOwner || !delRepo) return;
    const delBranchPath = state.branchName.split('/').map(encodeURIComponent).join('/');
    // t/3267: 10s timeout matches branchExistsOnGitHub — prevents OS TCP hang on branch cleanup
    const delAbort = new AbortController();
    const delTimer = setTimeout(() => delAbort.abort(), 10_000);
    try {
      const res = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(delOwner)}/${encodeURIComponent(delRepo)}/git/refs/heads/${delBranchPath}`,
        {
          method: 'DELETE',
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${creds.token}`,
            'User-Agent': 'ai-triad-taxonomy-editor',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          signal: delAbort.signal,
        },
      );

      if (!res.ok && res.status !== 422 && res.status !== 404) {
        this.recordEvent({
          type: 'github.api.error',
          component: 'session',
          level: 'error',
          message: `Failed to delete branch ${state.branchName}: ${res.status}`,
          data: { branch: state.branchName, status: res.status },
        });
      }
    } catch (err: unknown) {
      const isDelTimeout = (err as Error).name === 'AbortError';
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'session-branch',
        level: 'error',
        message: isDelTimeout
          ? `branch DELETE timed out after 10s for ${state.branchName}`
          : 'Operation failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      this.recordEvent({
        type: 'github.api.error',
        component: 'session',
        level: 'error',
        message: `Network error deleting branch ${state.branchName}`,
        error: err instanceof Error
          ? { name: err.name, message: err.message, stack: err.stack?.slice(0, 500) }
          : { name: 'Error', message: String(err) },
      });
    } finally {
      clearTimeout(delTimer);
    }

    this.recordEvent({
      type: 'branch.delete',
      component: 'session',
      level: 'info',
      message: `Session branch deleted: ${state.branchName}`,
      data: { branch: state.branchName, userId, reason },
    });

    // Clear in-memory state and backend overlay
    this.sessions.delete(userId);
    this.backend.clearSessionOverlay(userId);
  }

  /**
   * Check if a session branch exists on GitHub (for session resume).
   * If found, registers it in the local session map.
   */
  async checkBranchExists(userId: string): Promise<boolean> {
    const sanitized = sanitizeBranchName(userId);
    const branchName = BRANCH_PREFIX + sanitized;

    const exists = await this.branchExistsOnGitHub(branchName);
    if (exists && !this.sessions.has(userId)) {
      this.sessions.set(userId, {
        branchName,
        userId,
        createdAt: Date.now(),
        lastCommitAt: 0,
        lastCommitSha: '',
        prNumber: null,
        prUrl: null,
      });
    }

    return exists;
  }

  /**
   * Get divergence info for a user's session branch vs main.
   */
  async getDivergence(userId: string): Promise<{ ahead_by: number; behind_by: number } | null> {
    const state = this.sessions.get(userId);
    if (!state) return null;

    const baseBranch = this.backend.getBaseBranch();
    const result = await this.backend.compareBranches(baseBranch, state.branchName);

    if (result.behind_by > 0) {
      this.recordEvent({
        type: 'branch.divergence',
        component: 'session',
        level: result.behind_by >= 10 ? 'warn' : 'info',
        message: `Branch ${state.branchName}: ${result.ahead_by} ahead, ${result.behind_by} behind ${baseBranch}`,
        data: {
          branch: state.branchName,
          userId,
          ahead_by: result.ahead_by,
          behind_by: result.behind_by,
        },
      });
    }

    return { ahead_by: result.ahead_by, behind_by: result.behind_by };
  }

  // ── Public accessors (for health/diagnostics) ────────────────────────

  getActiveSessionCount(): number {
    return this.sessions.size;
  }

  getActiveBranches(): Array<{
    userId: string;
    branch: string;
    lastCommitAt: number;
    prNumber: number | null;
  }> {
    return Array.from(this.sessions.values()).map(s => ({
      userId: s.userId,
      branch: s.branchName,
      lastCommitAt: s.lastCommitAt,
      prNumber: s.prNumber,
    }));
  }

  // ── Internal helpers ─────────────────────────────────────────────────

  private async branchExistsOnGitHub(branchName: string): Promise<boolean> {
    const creds = await getCredentials();
    if (!creds) return false;

    // SSRF guard: encode each URL path segment so injected characters in
    // creds.repo or branchName cannot alter the URL structure. The scheme and
    // host are structurally guaranteed by the template literal — no runtime
    // startsWith check needed; the encoding is the actual protection.
    const [owner, repoName] = creds.repo.split('/');
    if (!owner || !repoName) return false;
    const branchPath = branchName.split('/').map(encodeURIComponent).join('/');
    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/git/refs/heads/${branchPath}`;

    // t/3267: 10s timeout prevents OS-level TCP hang (~90-120s) when GitHub is slow
    // on first write after container restart (in-memory sessions map is cleared).
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 10_000);
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${creds.token}`,
          'User-Agent': 'ai-triad-taxonomy-editor',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: abort.signal,
      });
      return res.ok;
    } catch (err: unknown) {
      const isTimeout = (err as Error).name === 'AbortError';
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'session-branch-manager', level: 'warn',
        message: isTimeout
          ? 'branch existence check timed out after 10s, treating as absent'
          : 'branch existence check failed (network error), treating as absent',
        data: { url, error: String(err), timedOut: isTimeout },
      });
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Validate the installation token has >60s remaining before starting
   * a batch commit. If not, force an early credential refresh.
   *
   * This prevents the 4-step Trees API sequence from failing mid-transaction
   * due to token expiry, which would leave a dangling tree (harmless but
   * wasteful) and require a full retry.
   */
  private async ensureTokenFreshness(): Promise<void> {
    const expiryMs = getTokenExpiryMs();

    // expiryMs === 0 means PAT mode or no cached token — skip check
    // (PATs don't expire mid-request; getCredentials handles app token refresh)
    if (expiryMs === 0) return;

    const remainingMs = expiryMs - Date.now();
    if (remainingMs < getConfig().sessions.tokenFreshnessThresholdMs) {
      this.recordEvent({
        type: 'github.api.request',
        component: 'session',
        level: 'info',
        message: `Token has ${Math.round(remainingMs / 1000)}s remaining — forcing early refresh before batch commit`,
        data: { remaining_ms: remainingMs, threshold_ms: getConfig().sessions.tokenFreshnessThresholdMs },
      });

      // Force a fresh credential fetch (getCredentials re-mints if needed)
      await getCredentials();
    }
  }

  private buildCommitMessage(userId: string, files: FileChange[]): string {
    const fileCount = files.length;
    const fileList = files.slice(0, 5).map(f => f.path).join(', ');
    const suffix = fileCount > 5 ? ` (+${fileCount - 5} more)` : '';
    return `Update ${fileCount} file${fileCount === 1 ? '' : 's'}: ${fileList}${suffix}\n\nAuthor: ${userId}\nvia Taxonomy Editor`;
  }

  private recordEvent(input: RecordInput): void {
    if (this.recorder) {
      this.recorder.record(input);
    }
  }
}
