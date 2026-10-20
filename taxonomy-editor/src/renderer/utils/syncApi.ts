// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Client wrapper for the Phase-1 /api/sync/* endpoints.
 *
 * Kept out of the full AppAPI bridge on purpose — sync is a server-side
 * capability (the server owns the git working tree). Renderer code calls
 * these directly via fetch; no IPC path is needed because the feature is
 * only meaningful when a server process is running.
 *
 * When GIT_SYNC_ENABLED is off the server returns `enabled: false` from
 * `getSyncStatus()` and empty arrays/strings elsewhere, so callers can
 * render a disabled UI without special-casing the network layer.
 */

import { ActionableError } from '@lib/debate/errors';
import { getGlobalRecorder } from '@lib/flight-recorder/index';

export interface SyncStatus {
  enabled: boolean;
  unsynced_count: number;
  session_branch: string | null;
  pr_number: number | null;
  pr_url: string | null;
  push_pending: boolean;
  /** True when GITHUB_REPO + credentials are configured on the server. */
  github_configured: boolean;
  /** Set by the GitHub webhook when a PR merges on origin/main. */
  main_updated_available: boolean;
  /** True when a rebase is paused with unresolved conflicts. */
  rebase_in_progress: boolean;

  // ── API-mode fields (present when mode === 'github-api') ──

  /** Storage mode: 'github-api' or 'filesystem'. */
  mode?: 'github-api' | 'filesystem';
  /** Main branch HEAD SHA. */
  main_sha?: string;
  /** Session branch HEAD SHA. */
  branch_sha?: string;
  /** Commits behind main (for divergence warning). */
  behind_by?: number;
  /** True when merge API detects conflicts. */
  has_conflicts?: boolean;
  /** Cache stats (API mode). */
  cache?: {
    hit_rate: number;
    last_poll: string;
    age_seconds: number;
  };
  /** The user's staged-overlay commit state (t/4312, #3467). `'conflict'` (behind the server's
   *  OVERLAY_CONFLICT_STATE_ENABLED flag) means a newer commit changed files in the staged batch: nothing
   *  in the batch commits, and the server stops retrying until the user resolves it (t/4313). */
  overlay_commit?: OverlayCommitStatus;
}

/** Mirrors the server's OverlayCommitStatus (storage/overlayCommitScheduler.ts, #3467 contract). */
export interface OverlayCommitStatus {
  state: 'pending' | 'committed' | 'failed' | 'conflict';
  at: number;
  error?: string;
  /** Set, non-empty, when `state === 'conflict'`: the files changed elsewhere. */
  conflictedPaths?: string[];
}

/** The files a save conflict is waiting on, or null when there's no conflict to resolve (t/4313). */
export function overlayConflictPaths(status: SyncStatus): string[] | null {
  const oc = status.overlay_commit;
  return oc?.state === 'conflict' && (oc.conflictedPaths?.length ?? 0) > 0 ? oc.conflictedPaths! : null;
}

export type ResyncMode = 'rebase' | 'fetch-only' | 'reset-main';

export interface CreatePrSuccess {
  ok: true;
  number: number;
  url: string;
  branch: string;
  created: boolean;
}

export interface ResyncSuccess {
  ok: true;
  mode: ResyncMode;
  session_ahead: number;
  main_sha: string;
  conflicts: boolean;
  /** Set when a rebase paused on conflict. */
  conflict_files?: string[];
  message: string;
}

export interface RebaseState {
  in_progress: boolean;
  conflict_files: string[];
  onto_branch: string | null;
}

export interface RebaseResolveResult { ok: true; remaining_files: string[]; }
export interface ContinueRebaseResult {
  ok: true;
  completed: boolean;
  conflict_files: string[];
  message: string;
}
export interface AbortRebaseResult { ok: true; message: string; }

export interface UnsyncedFile {
  path: string;
  /** Single-char git status code: 'M' | 'A' | 'D' | 'R' | '?' */
  status: string;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new ActionableError({
    goal: 'Fetch data from sync server',
    problem: `GET ${path} failed with HTTP ${res.status}`,
    location: 'syncApi.getJson',
    nextSteps: ['Check the server is running', 'Verify your authentication'],
  });
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) {
    throw new ActionableError({
      goal: 'Connect to sync server',
      problem: `Sync server not available (got ${ct || 'text/html'} instead of JSON)`,
      location: 'syncApi.getJson',
      nextSteps: ['Make sure the sync server is running', 'Check the server URL configuration'],
    });
  }
  return res.json() as Promise<T>;
}

async function postJson<T>(path: string, body: unknown, opts?: { timeoutMs?: number }): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...(opts?.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new ActionableError({
      goal: 'Send data to sync server',
      problem: `POST ${path} failed with HTTP ${res.status}: ${text}`,
      location: 'syncApi.postJson',
      nextSteps: ['Check the server is running', 'Verify your authentication'],
    });
  }
  return res.json() as Promise<T>;
}

const DISABLED_STATUS: SyncStatus = {
  enabled: false,
  unsynced_count: 0,
  session_branch: null,
  pr_number: null,
  pr_url: null,
  push_pending: false,
  github_configured: false,
  main_updated_available: false,
  rebase_in_progress: false,
};

export async function getSyncStatus(): Promise<SyncStatus> {
  try {
    return await getJson<SyncStatus>('/api/sync/status');
  } catch (err) {
    getGlobalRecorder()?.record({ type: 'system.error', component: 'sync-api', level: 'debug', message: 'Sync status unavailable', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
    return DISABLED_STATUS;
  }
}

export async function listUnsynced(): Promise<UnsyncedFile[]> {
  try {
    return await getJson<UnsyncedFile[]>('/api/sync/unsynced');
  } catch (err) {
    getGlobalRecorder()?.record({ type: 'system.error', component: 'sync-api', level: 'warn', message: 'Unsynced list unavailable', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
    return [];
  }
}

export async function getFileDiff(relPath: string): Promise<string> {
  try {
    const res = await getJson<{ path: string; diff: string }>(
      `/api/sync/diff?path=${encodeURIComponent(relPath)}`,
    );
    return res.diff || '';
  } catch (err) {
    getGlobalRecorder()?.record({ type: 'system.error', component: 'sync-api', level: 'warn', message: 'File diff unavailable', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
    return '';
  }
}

export async function discardFile(relPath: string): Promise<void> {
  await postJson('/api/sync/discard', { path: relPath });
}

export async function discardAll(): Promise<void> {
  await postJson('/api/sync/discard', { all: true });
}

// ── Save-conflict resolution (t/4313; contract in #3467's body, TL p/538#97) ──
// Both act on the user's WHOLE staged batch, never a per-file subset. Both are POSTs: never auto-retried here;
// a failure surfaces to the banner for a manual retry (network rules). 30 s is ample: one rebase + one commit.
const RESOLVE_TIMEOUT_MS = 30_000;

/** "Use theirs": discard every staged change in the batch; those files read the newer committed version again. */
export async function resolveOverlayConflictUseTheirs(): Promise<{ discarded: string[] }> {
  return postJson('/api/sync/overlay-conflicts/use-theirs', {}, { timeoutMs: RESOLVE_TIMEOUT_MS });
}

/**
 * "Keep mine": re-base the whole batch onto the current head and commit it, overwriting the newer version.
 * A non-empty `stillConflicted` means another change landed in the gap: the caller shows the conflict again
 * rather than calling this again.
 */
export async function resolveOverlayConflictKeepMine(): Promise<{
  committed: boolean; commitSha?: string; filesCommitted?: number; stillConflicted: string[];
}> {
  return postJson('/api/sync/overlay-conflicts/keep-mine', {}, { timeoutMs: RESOLVE_TIMEOUT_MS });
}

export async function createPullRequest(opts: { title?: string; body?: string }): Promise<CreatePrSuccess> {
  return postJson<CreatePrSuccess>('/api/sync/create-pr', opts);
}

export async function resync(mode: ResyncMode): Promise<ResyncSuccess> {
  return postJson<ResyncSuccess>('/api/sync/resync', { mode });
}

// ── Phase 4: rebase conflict resolution ──

export async function getRebaseState(): Promise<RebaseState> {
  try {
    return await getJson<RebaseState>('/api/sync/rebase-state');
  } catch (err) {
    getGlobalRecorder()?.record({ type: 'system.error', component: 'sync-api', level: 'warn', message: 'Rebase state unavailable', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
    return { in_progress: false, conflict_files: [], onto_branch: null };
  }
}

export async function getRebaseFile(relPath: string): Promise<string> {
  const res = await getJson<{ path: string; content: string }>(
    `/api/sync/rebase-file?path=${encodeURIComponent(relPath)}`,
  );
  return res.content || '';
}

export async function resolveRebaseFile(relPath: string, content: string): Promise<RebaseResolveResult> {
  return postJson<RebaseResolveResult>('/api/sync/rebase/resolve', { path: relPath, content });
}

export async function continueRebase(): Promise<ContinueRebaseResult> {
  return postJson<ContinueRebaseResult>('/api/sync/rebase/continue', {});
}

export async function abortRebase(): Promise<AbortRebaseResult> {
  return postJson<AbortRebaseResult>('/api/sync/rebase/abort', {});
}

// ── Diagnostics ──

export interface EditCounts {
  added: number;
  modified: number;
  deleted: number;
}

export interface DiagnosticsFile {
  relative_path: string;
  exists: boolean;
  size_bytes: number;
  modified_iso: string;
  /** Single-char git status: 'M' modified, 'A' added, 'D' deleted, '?' untracked, '' clean */
  git_status: string;
  /** Semantic diff counts (nodes added/modified/deleted vs origin/main). Null when clean or non-diffable. */
  edit_counts: EditCounts | null;
}

export interface DiagnosticsCommit {
  sha: string;
  message: string;
  author: string;
  date_iso: string;
}

export interface SyncDiagnostics {
  git_sync_enabled: boolean;
  data_root: string;
  data_root_has_git: boolean;
  github_repo: string | null;
  github_credentials_valid: boolean;
  current_branch: string | null;
  head_sha: string | null;
  origin_main_sha: string | null;
  ahead_of_main: number;
  behind_main: number;
  active_taxonomy_dir: string;
  files: DiagnosticsFile[];
  recent_commits: DiagnosticsCommit[];

  // ── API-mode extras (present when mode === 'github-api') ──
  mode?: 'github-api' | 'filesystem';
  cache_hit_rate?: number;
  cache_file_count?: number;
  circuit_state?: string;
  rate_limit_remaining?: number;
  active_sessions?: Array<{
    userId: string;
    branch: string;
    lastCommitAt: number;
    prNumber: number | null;
  }>;
}

const DISABLED_DIAGNOSTICS: SyncDiagnostics = {
  git_sync_enabled: false,
  data_root: '',
  data_root_has_git: false,
  github_repo: null,
  github_credentials_valid: false,
  current_branch: null,
  head_sha: null,
  origin_main_sha: null,
  ahead_of_main: 0,
  behind_main: 0,
  active_taxonomy_dir: '',
  files: [],
  recent_commits: [],
};

export async function getSyncDiagnostics(): Promise<SyncDiagnostics> {
  try {
    return await getJson<SyncDiagnostics>('/api/sync/diagnostics');
  } catch (err) {
    getGlobalRecorder()?.record({ type: 'system.error', component: 'sync-api', level: 'debug', message: 'Sync diagnostics unavailable', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
    return DISABLED_DIAGNOSTICS;
  }
}

export async function setGithubCredentials(repo: string, token: string): Promise<{ ok: boolean; configured: boolean }> {
  return postJson('/api/sync/credentials', { repo, token });
}

export async function clearGithubCredentials(): Promise<{ ok: boolean; configured: boolean }> {
  return postJson('/api/sync/credentials', { clear: true });
}

// ── Progress-tracked wrappers ──
//
// These call the same endpoints but drive `useGitProgress` so the
// `<GitProgressBanner>` renders automatically.

import { useGitProgress } from '../hooks/useGitProgress';

async function tracked<T>(
  operation: import('../hooks/useGitProgress').GitOperation,
  fn: (stepOp: (idx: number) => void) => Promise<T>,
): Promise<T> {
  const store = useGitProgress.getState();
  store.startOp(operation);
  try {
    const result = await fn(store.stepOp);
    store.completeOp();
    return result;
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'syncApi',
      level: 'error',
      message: `Tracked sync operation '${operation}' failed`,
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    store.failOp(err instanceof Error ? err.message : String(err));
    throw err;
  }
}

export function createPullRequestTracked(opts: { title?: string; body?: string }): Promise<CreatePrSuccess> {
  return tracked('create-pr', async (step) => {
    step(0); // Committing changes...
    step(1); // Pushing branch...
    // The server does commit+push+PR in a single call — we advance to step 2
    // immediately since we can't observe the server's internal progress.
    step(2);
    return createPullRequest(opts);
  });
}

export function resyncTracked(mode: ResyncMode): Promise<ResyncSuccess> {
  return tracked('resync', async (step) => {
    step(0); // Fetching from origin...
    step(1); // Rebasing session branch...
    const result = await resync(mode);
    step(2); // Verifying state...
    return result;
  });
}

export function discardAllTracked(): Promise<void> {
  return tracked('discard', async (step) => {
    step(0); // Resetting working tree...
    return discardAll();
  });
}

export function pullDataTracked(pullFn: () => Promise<{ success: boolean; message: string }>): Promise<{ success: boolean; message: string }> {
  return tracked('download', async (step) => {
    step(0); // Fetching from GitHub...
    const result = await pullFn();
    step(1); // Updating local files...
    return result;
  });
}

export function fetchOriginTracked(): Promise<ResyncSuccess> {
  return tracked('fetch-origin', async (step) => {
    step(0); // Fetching from origin...
    const result = await resync('fetch-only');
    step(1); // Updating refs...
    return result;
  });
}

export function resetMainTracked(): Promise<ResyncSuccess> {
  return tracked('reset-main', async (step) => {
    step(0); // Fetching from origin...
    step(1); // Resetting to origin/main...
    const result = await resync('reset-main');
    step(2); // Verifying state...
    return result;
  });
}
