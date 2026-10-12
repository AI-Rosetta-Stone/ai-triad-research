# GitHub API-First Implementation Plan

## Overview

Replace the Azure Files SMB + git clone data layer with direct GitHub API access. Eliminates all SMB-related issues (empty directories, lock files, slow copy, git corruption) and reduces startup from 30-60s to 3-5s.

**Source of truth:** `AI-Rosetta-Stone/ai-triad-data` on GitHub (main branch)
**Auth:** Existing GitHub App (ID: 3646042, Installation: 130612260) via Azure Key Vault PEM

---

## Phase 1: GitHub Data Store (Core API Layer)

### 1.1 Create `taxonomy-editor/src/server/GitHubAPIBackend.ts`

Implements the `StorageBackend` interface (see Phase 2.1) using GitHub's REST API. This is the raw I/O layer — domain logic stays in `fileIO.ts`.

**Dependencies:** Existing `githubAppAuth.ts` for installation token generation.

```typescript
// Implements StorageBackend (5 methods) + GitHub-specific operations
class GitHubAPIBackend implements StorageBackend {
  // StorageBackend interface (delegated from fileIO.ts)
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string): Promise<void>;
  listDirectory(path: string): Promise<string[]>;
  deleteFile(path: string): Promise<void>;
  fileExists(path: string): Promise<boolean>;

  // GitHub-specific (used by Session Branch Manager + Sync UI)
  getLatestCommitSha(): Promise<string>;
  getChangedFiles(fromSha: string, toSha: string): Promise<string[]>;
  getTree(sha: string, recursive?: boolean): Promise<TreeEntry[]>;
  createBranch(name: string, fromSha?: string): Promise<void>;
  createCommitFromTree(branch: string, files: FileChange[], message: string): Promise<string>;
  createOrUpdatePR(branch: string, title: string, body: string): Promise<{ number: number; url: string }>;
  compareBranches(base: string, head: string): Promise<CompareResult>;
}
```

**API mapping:**

| Operation | GitHub API Endpoint | Rate Cost |
|-----------|-------------------|-----------|
| Read file (<100MB) | `GET /repos/{owner}/{repo}/contents/{path}` | 1 |
| Read file (>100MB) | `GET /repos/{owner}/{repo}/git/blobs/{sha}` | 1 |
| List directory | `GET /repos/{owner}/{repo}/contents/{path}` | 1 |
| Write file | `PUT /repos/{owner}/{repo}/contents/{path}` | 1 |
| Create branch | `POST /repos/{owner}/{repo}/git/refs` | 1 |
| Create PR | `POST /repos/{owner}/{repo}/pulls` | 1 |
| Update PR | `PATCH /repos/{owner}/{repo}/pulls/{number}` | 1 |
| Latest commit | `GET /repos/{owner}/{repo}/commits/main` | 1 |
| Changed files | `GET /repos/{owner}/{repo}/compare/{base}...{head}` | 1 |

**Authentication flow:**
1. Read PEM from Azure Key Vault via managed identity (`AZURE_KEYVAULT_URL` + `GITHUB_APP_PRIVATE_KEY_SECRET_NAME`)
2. Generate JWT from App ID + PEM
3. Exchange JWT for installation access token (1-hour TTL, auto-refresh)
4. Use token for all API calls: `Authorization: token {installation_token}`

This reuses the existing `githubAppAuth.ts` token generation — no new auth code needed.

**Error handling:**
- 404 → file/path not found (return null, don't throw)
- 409 → SHA conflict on write (return conflict error, let caller handle)
- 422 → validation error (branch exists, PR exists — handle gracefully)
- 403/429 → rate limit (respect `Retry-After` header, exponential backoff)
- 401 → token expired (force token refresh, retry once with new token)
- 5xx → GitHub outage (retry with backoff, then circuit-break)

**Retry policy:**
- **Retryable:** 5xx, 429, network errors, ECONNRESET
- **Not retryable:** 4xx (except 401 → refresh token + retry once, 429 → respect Retry-After)
- **Max retries:** 3 per request
- **Backoff:** exponential with jitter (100ms, 300ms, 900ms base + random 0-100ms)
- **Respect `Retry-After`:** if present, wait the specified duration instead of backoff

**Circuit breaker (adaptive half-open):**
- **Closed** (normal): all requests go to GitHub API
- **Open** (tripped): after 5 consecutive failures, enter fallback mode. Reads serve from cache/baked fallback (read-only), writes rejected with banner "GitHub unavailable — edits temporarily disabled"
- **Half-open** (probing): attempt one probe request (`GET /repos/.../commits/main`) on an exponential schedule: 30s → 1m → 2m → 5m (cap). On probe success, immediately return to **closed** state. On probe failure, increment backoff and stay half-open.
- Circuit breaker state (`closed`/`open`/`half-open`) logged as `github.api.circuit_break` event and exposed on `/health`
- A brief DNS blip (10s) triggers at most 30s of fallback mode instead of a 5-minute hard penalty

**Write failure recovery:**
- If a batch commit fails mid-sequence (e.g., tree created but commit fails): the dangling tree is harmless (unreferenced objects are garbage-collected by GitHub). The branch ref is unchanged. Retry the full 4-step sequence from the beginning.
- Cache is NOT updated on failure (write-through guarantees consistency)

### 1.2 Local File Cache (`/tmp/taxonomy-cache/`)

Cache files on local SSD for fast repeated access. Survives process restart but not container restart (ephemeral).

```
/tmp/taxonomy-cache/
  manifest.json          # { lastCommitSha, lastUpdated, files: { path: { sha, etag, cachedAt } } }
  taxonomy/Origin/
    accelerationist.json  # Cached file content
    safetyist.json
    ...
  conflicts/
    _conflict-clusters.json
  debates/               # Lazily populated on demand
    debate-001.json
```

**Cache strategy:**
- **Startup:** Check manifest → if `lastCommitSha` matches current main HEAD, serve from cache (0 API calls). If stale, fetch only changed files via compare API.
- **Read:** Check cache first → if hit, return immediately. If miss, fetch from GitHub API, cache, return.
- **Write:** Write to GitHub API (to branch), update local cache optimistically.
- **Invalidation:** Periodic poll (60s) compares `lastCommitSha` with `GET /repos/.../commits/main`. On change, fetch diff and invalidate only changed files.

**ETag support:** Include `If-None-Match: {etag}` on API calls. GitHub returns 304 (no body) if unchanged — counts toward rate limit but saves bandwidth.

### 1.3 Conflict File Consolidation

Current: 1,244 individual conflict files in `conflicts/` (~5.5 MB total).
Problem: Listing 1,244 files via Contents API would be 1,244 API calls.

**Solution:** Create a pre-built `conflicts/_conflict-index.json` that contains all conflicts in one file. The existing `cluster-conflicts.yml` workflow already runs weekly — add a step to generate the index.

```json
// conflicts/_conflict-index.json (~5.5 MB, single file)
{
  "version": 1,
  "generated": "2026-05-11T00:00:00Z",
  "conflicts": {
    "acc-B-001_vs_saf-B-001.json": { /* conflict content */ },
    "acc-B-002_vs_skp-B-001.json": { /* conflict content */ },
    ...
  }
}
```

This reduces conflicts from 1,244 API calls to 1.

---

## Phase 2: StorageBackend Abstraction

### 2.1 `StorageBackend` Interface

Instead of rewriting 40+ `fileIO.ts` domain functions, abstract the raw I/O layer. `fileIO.ts` keeps all its domain logic (conflict parsing, edge updates, harvest operations) but delegates file operations to a backend.

```typescript
interface StorageBackend {
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string): Promise<void>;
  listDirectory(path: string): Promise<string[]>;
  deleteFile(path: string): Promise<void>;
  fileExists(path: string): Promise<boolean>;
}
```

**Two implementations:**

| Backend | Mode | Use Case |
|---------|------|----------|
| `FilesystemBackend` | `STORAGE_MODE=filesystem` | Electron app, local dev, current behavior |
| `GitHubAPIBackend` | `STORAGE_MODE=github-api` | Azure container deployment |

`FilesystemBackend` is a trivial wrapper around `fs.readFile`/`fs.writeFile` — extracted from the existing `fileIO.ts` inline disk I/O. No behavior change, just indirection.

`GitHubAPIBackend` uses the GitHub Contents API (files <100MB), Git Blobs API (files >100MB), and Git Trees API (directory listings >1,000 items) with the local `/tmp/taxonomy-cache/` cache layer from Phase 1.

**Benefit:** Reduces blast radius — `fileIO.ts` domain functions (40+, 911 lines) don't change at all. Only the 5 raw I/O primitives are swapped.

**Path contract:**
- All paths are relative to repo root (e.g., `taxonomy/Origin/accelerationist.json`)
- Leading `/` stripped automatically
- `.git` paths rejected (throw `ActionableError`)
- Path traversal (`..`) rejected

### 2.1a Session Context & Ref Resolution

In API mode, reads and writes target different git refs depending on user state. The `StorageBackend` interface stays path-only — ref resolution is handled internally by `GitHubAPIBackend` using an injected `SessionContext`.

```typescript
interface SessionContext {
  userId: string;
  branchName?: string;  // null = no session branch, read from main
}
```

**Server middleware** resolves the authenticated user (from Azure Easy Auth `X-MS-CLIENT-PRINCIPAL-NAME` header) into a `SessionContext`:

```typescript
// server.ts — middleware runs before every request
app.use((req, res, next) => {
  const userId = extractUserId(req);  // from Easy Auth headers
  const branch = sessionManager.getActiveBranch(userId); // null if none
  req.sessionContext = { userId, branchName: branch };
  next();
});
```

`fileIO.setSessionContext(ctx)` is called per-request. `GitHubAPIBackend` uses the context internally:

| Operation | Ref Used | Rationale |
|-----------|----------|-----------|
| `readFile` | Session branch if exists, else main | User sees their own edits after save + page reload |
| `writeFile` | Session branch (lazy-created) | Writes always target the user's branch |
| `listDirectory` | Session branch if exists, else main | Directory listings reflect user's state |
| `deleteFile` | Session branch | Deletes are branch-scoped |
| `fileExists` | Session branch if exists, else main | Consistent with reads |

**`FilesystemBackend` ignores `SessionContext`** — there's only one copy on disk (the working tree), which matches the current behavior.

**Cache partitioning:** The cache has two layers:
- **Main cache** — shared across all users, reflects `main` branch HEAD
- **Session overlays** — per-user, tracks files modified on the session branch (keyed by `userId`)

When a user reads a file:
1. Check session overlay (if session branch exists) → return if found
2. Fall through to main cache → return if found
3. Fetch from GitHub API (session branch ref) → populate appropriate layer

When a user writes a file:
1. Write to GitHub (session branch) via batch commit
2. On success: update session overlay in cache (write-through)
3. Main cache is unaffected

When main polling detects changes:
1. Update main cache with changed files
2. Session overlays are NOT invalidated (they reflect user's branch, not main)

This preserves the current behavior: user sees their own edits, other users see main.

### 2.2 Directory Listings — Git Trees API

GitHub Contents API returns max 1,000 items per directory. Several `fileIO` functions scan large directories:
- `discoverSources()` — hundreds of files
- `listDebateSessions()` / `listChatSessions()` — variable count
- `readAllConflictFiles()` — 1,244 files (mitigated by conflict index, but fallback needed)

**Solution:** `GitHubAPIBackend.listDirectory()` uses the Git Trees API:
```
GET /repos/{owner}/{repo}/git/trees/{sha}?recursive=1
```
Single call returns the entire repo tree (~2,000 entries). Cache strategy:

- **Full tree cached in memory** after first fetch (one object, keyed by path)
- **File contents lazy-loaded** — `readFile` fetches on first access, populates manifest + SSD cache
- **On poll/invalidation:** re-fetch only changed files via Compare API; update the cached tree object
- **Manifest atomicity:** write to `manifest.json.tmp`, rename to `manifest.json` (atomic swap prevents torn reads during background poll)
- **Cold start:** fetch tree (1 call) → lazy-load files on demand (not preloaded). Core taxonomy files (~5) are loaded on first `/api/taxonomy` request. Embeddings (~30 MB) are lazy-loaded only when needed (embedding search, never on startup).
- **Tree truncation:** GitHub truncates trees >100,000 entries. Current repo has ~2,000 files. If truncation is detected (`truncated: true` in response), log `system.scaling_warning` and fall back to per-directory Contents API calls.

### 2.3 `STORAGE_MODE` Switch

```typescript
// server.ts initialization
const backend: StorageBackend = process.env.STORAGE_MODE === 'github-api'
  ? new GitHubAPIBackend({ repo, auth, cacheDir: '/tmp/taxonomy-cache' })
  : new FilesystemBackend({ dataRoot: process.env.AI_TRIAD_DATA_ROOT });

fileIO.setBackend(backend);
```

Default: `github-api` in container mode (`NODE_ENV=production`), `filesystem` in Electron mode.

### 2.4 Conflict Write Strategy

- **Read path:** Bulk load via `_conflict-index.json` (1 API call for all 1,244 conflicts)
- **Write path:** Write individual conflict files via API (source of truth for the clustering workflow)
- **Cache:** Server updates the cached index optimistically on writes so the UI reflects changes immediately
- **Staleness:** The repo's `_conflict-index.json` becomes stale between workflow runs. This is acceptable — the staleness window only affects other users, and the weekly `cluster-conflicts.yml` regenerates it

Individual files are SoT. The index is a read-only optimization for bulk loading.

---

## Phase 2B: Session Branch Manager

### Branch Lifecycle

| Event | Action |
|-------|--------|
| User opens app | No branch created (read from main cache) |
| User makes first edit | Lazy branch creation: `POST /repos/.../git/refs` → `api-session/{userId}` from main HEAD |
| User saves | Batch commit to session branch (see below) |
| User clicks "Create PR" | `POST /repos/.../pulls` from session branch → main |
| PR merged | Delete session branch: `DELETE /repos/.../git/refs/heads/api-session/{userId}` |
| User returns next day | Check if branch exists → resume or create new |

### Branch Naming

`api-session/{sanitizedUserId}` — one branch per user. The `userId` comes from the OAuth principal (GitHub username or Google email hash).

**`sanitizeBranchName` helper:** Replace disallowed characters (`/`, spaces, `~`, `^`, `:`, `?`, `*`, `[`, `\`) with `-`. Lowercase. Truncate to 100 chars. Reject empty result. Examples:
- `jeff@example.com` → `api-session/jeff-example-com`
- `JeffSnover` → `api-session/jeffsnover`

### Commit Batching — Git Trees API

Per-file `PUT /repos/.../contents/{path}` creates one commit per save — potentially dozens per session. Instead, batch via the Git Trees API:

```
1. GET  /repos/.../git/refs/heads/api-session/{userId}  → current branch SHA
2. POST /repos/.../git/trees                             → create tree with all changed files
3. POST /repos/.../git/commits                           → create commit pointing to new tree
4. PATCH /repos/.../git/refs/heads/api-session/{userId}  → update branch ref
```

This creates a single commit per save-batch regardless of how many files changed. The server debounces saves (existing 2s debounce) and batches all pending changes into one commit.

**Rate cost:** 4 API calls per save-batch (vs N calls for N files with Contents API).

### Concurrent Users

- Each user gets their own `api-session/{userId}` branch — no cross-user conflicts
- Two users editing simultaneously: separate branches, separate PRs
- If both edit the same file: conflict detected when second PR tries to merge (GitHub handles this)

### Multi-Tab & Concurrency Locking

- **Per-user commit mutex:** a single in-memory lock per `userId` serializes the 4-step Trees API batch commit. If two browser tabs for the same user trigger saves simultaneously, the second waits for the first to complete. Prevents race conditions on branch ref updates.
- **Per-file write mutex:** (from Phase 2.1) protects read-modify-write cycles in `fileIO.ts`. Independent of the commit mutex.
- Lock hierarchy: per-file mutex acquired first (within `fileIO` domain functions), per-user commit mutex acquired when batching (in Session Branch Manager). No nested locking between the two.

---

## Phase 2C: Sync UI in API Mode

### Feature Mapping

| Current Feature | Current Implementation | API-Mode Equivalent |
|----------------|----------------------|-------------------|
| **Unsynced changes count** | `git status` (local working tree) | `GET /repos/.../compare/main...api-session/{userId}` → `ahead_by` count |
| **Unsynced file list** | `git diff --name-only` | Same compare API → `files[]` array with `filename`, `status`, `changes` |
| **File diff view** | `git diff {file}` | Compare API returns `patch` field per file (unified diff format) |
| **Create PR** | `git push` + `POST /pulls` | Just `POST /repos/.../pulls` (branch already on GitHub) — simpler |
| **Update PR** | Push new commits | Batch commit to session branch (auto-updates open PR) |
| **Pull updates from main** | `git fetch` + `git rebase` | `POST /repos/.../merges` (merge main into session branch) or reset branch to main HEAD + replay |
| **Check for upstream changes** | `git fetch` + compare local/remote | `GET /repos/.../commits/main` → compare SHA with cached value |
| **Interactive rebase** | 5 local git endpoints | **Deferred** — detect conflicts via merge API, show "merge conflict" banner with manual resolution link to GitHub PR |

### Simplified Sync Status Endpoint

```json
// GET /api/sync/status (API mode)
{
  "enabled": true,
  "mode": "github-api",
  "github_configured": true,
  "session_branch": "api-session/jeff",
  "unsynced_count": 3,
  "pr_number": 42,
  "pr_url": "https://github.com/AI-Rosetta-Stone/ai-triad-data/pull/42",
  "main_sha": "abc1234",
  "branch_sha": "def5678",
  "main_updated_available": true,
  "has_conflicts": false,
  "cache": {
    "hit_rate": 0.95,
    "last_poll": "2026-05-13T14:00:00Z",
    "age_seconds": 45
  }
}
```

### Interactive Rebase — Deferred

The current 5-endpoint interactive rebase (`/api/sync/rebase/*`) doesn't translate to API mode. Instead:
1. Detect conflicts: `POST /repos/.../merges` returns 409 if conflicts exist
2. Show banner: "Merge conflict detected — resolve on GitHub" with link to PR
3. User resolves on GitHub's conflict editor
4. Server polls PR status → when resolved, refresh cache

This is acceptable for v1. Full API-based conflict resolution can be added later if needed.

---

## Phase 2D: Server Endpoint Updates

| Endpoint | Change |
|----------|--------|
| `GET /health` | No change — passes immediately, no data dependency |
| `GET /api/data/available` | Check cache manifest instead of filesystem |
| `GET /api/taxonomy` | Read from cache/API via `StorageBackend` |
| `PUT /api/taxonomy` | Write to session branch via `StorageBackend` + batch commit |
| `GET /api/sync/status` | Return session branch status, cache freshness, PR info (see above) |
| `POST /api/sync/init` | No-op in API mode — no git repo to initialize |
| `POST /api/data/pull` | Invalidate cache, re-fetch from main |
| `POST /api/data/check-updates` | Compare cached SHA with main HEAD |
| `POST /api/sync/create-pr` | Create PR from session branch → main |

### Remove Git Sync Infrastructure

After API mode is stable, delete:
- `gitRepoStore.ts` (1,371 lines) — replaced by Session Branch Manager + StorageBackend
- `initDataRepo()` — no `.git/` directory to initialize
- `isCopyInProgress()` guards on 9 endpoints — no copy to wait for
- `.git-ready` marker protocol — no marker needed
- `GIT_TERMINAL_PROMPT=0` — no git binary

### Startup Sequence (New)

```
Container starts
  → CMD: node server.js (no entrypoint, no background copy, no Azure Files)
  → server.ts: health check passes immediately (no data dependency)
  → server.ts: GitHubAPIBackend.initialize()
    → Read installation token from Key Vault
    → Check /tmp/taxonomy-cache/manifest.json
    → If fresh (< 60s old): serve from cache (0 API calls, <100ms)
    → If stale/missing: fetch main HEAD SHA (1 call)
      → If SHA matches cache: done (1 API call, <500ms)
      → If SHA differs: fetch changed files only (2-8 calls, 3-5s)
      → If no cache: full fetch via Trees API (2 calls for tree + 10 calls for files, 3-5s)
  → App interactive
```

---

## Phase 2E: Sync UI Component Transition

Every existing sync UI component needs API-mode behavior. The components themselves are preserved — their data sources change.

### Component-by-Component Instructions

#### SaveBar.tsx — No structural changes

The SaveBar shows three sync badges (unsynced count, upstream updated, rebase paused) plus a diagnostics gear icon. These all read from `useSyncStatus()`, which polls `GET /api/sync/status`. The server endpoint already returns the same `SyncStatus` shape in both modes — only the server-side implementation changes. SaveBar needs no code changes.

#### useSyncStatus hook — Update poll target (if needed)

Currently polls `GET /api/sync/status` every 10 seconds. In API mode, the server returns the same `SyncStatus` interface but populated from GitHub Compare API instead of local git. The hook itself needs no changes — the server handles the mode switch.

**Add webhook acceleration:** When `POST /api/sync/webhook/github` fires (already HMAC-verified in current code), push a WebSocket event to connected clients so `useSyncStatus` can refresh immediately instead of waiting for the next 10-second poll. This eliminates the stale window for PR merges and upstream pushes.

#### UnsyncedChangesDrawer.tsx — Adapt data sources, simplify some actions

| Element | Current | API Mode Change |
|---------|---------|-----------------|
| Header (branch name) | From `syncStatus.session_branch` | Same — branch name comes from server |
| File list | `GET /api/sync/unsynced` → local `git diff` | Same endpoint, server uses Compare API internally |
| Diff preview | `GET /api/sync/diff?path=...` → local `git diff` | Same endpoint, server uses Compare API `patch` field |
| "Create PR" button | Calls `POST /api/sync/create-pr` → `git push` + GitHub API | **Simpler** — branch already on GitHub, just `POST /pulls` |
| "Update PR" button | Pushes new commits | **No-op** — batch commits auto-update open PR |
| "Resync" button | Calls `POST /api/sync/resync` → `git fetch` + `git rebase` | Server uses Merges API or branch reset internally |
| "Discard file" button | Calls `POST /api/sync/discard` → `git checkout` | Server reverts file on session branch via Contents API |
| "Discard all" button | Calls `POST /api/sync/discard-all` → `git reset` | Server deletes session branch + recreates from main HEAD |
| GitHub not configured | Shows tooltip about missing env vars | **Remove in API mode** — GitHub App auth is always configured in container |
| **NEW: Divergence warning** | (none) | Yellow banner at 3+ commits behind main, red at 10+. Uses `behind_by` from Compare API. Shown above file list. |

The drawer's visual structure, `GitProgressBanner` integration, and `useGitProgress` tracking are unchanged.

#### RebaseConflictModal.tsx — Deferred in API mode

In API mode, interactive rebase is not available. When the Merges API returns 409 (conflict), the server returns:

```json
{ "has_conflicts": true, "pr_url": "https://github.com/.../pull/42" }
```

Instead of opening `RebaseConflictModal`, show a simpler conflict banner in `UnsyncedChangesDrawer`:

```
⚠ Merge conflict detected — your changes conflict with recent updates to main.
[Resolve on GitHub →]  (links to PR conflict editor)
```

The `RebaseConflictModal` component stays in the codebase (used in filesystem mode) but is never rendered in API mode. Gate on `syncStatus.mode === 'github-api'`.

#### SyncDiagnosticsDialog.tsx — Major content changes

This dialog has 5 collapsible sections. Each needs API-mode updates:

**1. Connection Status** — Simplify for API mode:
- Remove: "Git Initialized", "Credentials Valid", PAT entry form
- Add: "Storage Mode: GitHub API", "GitHub App: Connected" (token status), "Cache: fresh/stale (age Ns)"
- Remove: inline GitHub PAT credential form (not needed — GitHub App auth is automatic)

**2. Repository State** — Adapt data sources:
- "Current branch" → session branch name (or "none — reading from main")
- "HEAD SHA" → session branch HEAD SHA (from Compare API)
- "origin/main SHA" → cached main HEAD SHA
- "Ahead/Behind" → from Compare API `ahead_by` / `behind_by`
- "Pull Request" → same (PR number + URL)
- Add: "Cache hit rate", "Last poll", "Rate limit remaining"

**3. Data Files** — Adapt for cached files:
- Instead of scanning local filesystem, show cache manifest: file path, cached SHA, cache age
- Status: ✓ cached, 🔄 fetching, ✗ missing
- Show "Local Edits" column only when session branch exists

**4. Recent Commits** — Use GitHub API:
- Fetch from `GET /repos/.../commits?sha=main&per_page=10`
- Cache the result (poll interval: 60s, same as main polling)

**5. Actions** — Simplify:
- Remove: "Initialize Repo" (no git to init), "Fetch from Origin" (automatic polling)
- Keep: "Create Pull Request", "Reset to origin/main" (deletes session branch)
- Add: "Force cache refresh" (invalidate manifest, re-fetch all)
- Add: "Dump flight recorder" (already exists as button, keep it)

#### GitProgressBanner.tsx — No changes

The progress banner is operation-agnostic — it displays whatever `useGitProgress` state contains. The operation types (`create-pr`, `resync`, `discard`, etc.) stay the same. Only the server-side implementation of these operations changes.

#### useGitProgress hook — Add new operation types

Add operation step sequences for API-mode operations:

```typescript
'create-pr':    ['Creating pull request...']  // Simpler — no push needed
'resync':       ['Merging main into session branch...', 'Refreshing cache...']
'discard':      ['Reverting file on session branch...']
'discard-all':  ['Resetting session branch to main...']
'cache-refresh': ['Invalidating cache...', 'Fetching from GitHub...']
```

The existing `'download'`, `'push'`, `'init-repo'`, `'fetch-origin'`, `'reset-main'` types become filesystem-mode only.

---

## Phase 2F: Consistency Model

This system is eventually consistent. These guarantees are formalized to prevent undefined behavior during implementation.

### Read Consistency

- **Main branch reads** are eventually consistent with a freshness SLA of ≤60 seconds (polling interval). Webhook acceleration reduces this to ≤2 seconds for push events.
- **Session branch reads** are strongly consistent relative to local writes — the write-through cache updates only after a confirmed 2xx from GitHub, and subsequent reads serve from the updated cache.
- **Cross-user visibility**: User A's writes are invisible to User B until User A's PR is merged to main and User B's cache refreshes (≤60s after merge).

### Write Consistency

- **Single-user writes** are serialized by the per-file write mutex and committed atomically via Git Trees API batch.
- **Multi-user writes** are isolated by per-user branches. Conflicts are detected at PR merge time, not at write time.
- **No distributed transactions.** A batch commit either fully succeeds or fully fails. Cache is updated only on success (write-through).

### Authoritative Source

- **GitHub `main` branch** is the single source of truth for read data.
- **GitHub `api-session/{userId}` branches** are the source of truth for in-progress edits.
- **Local cache** is a subordinate replica — never authoritative. On any inconsistency, the cache is discarded and re-fetched.

### Cache Coherency Rules

- Cache manifest uses **atomic swap** semantics: write to `manifest.json.tmp`, rename to `manifest.json`. Partial manifest writes are impossible.
- Cache tracks a **generation counter** (monotonic integer). Stale reads detected by comparing generation at read time vs write time.
- **Manifest checksum:** On load, validate manifest integrity (JSON parse + required fields check). On corruption, discard and re-fetch (equivalent to cold start).
- **Force push / history rewrite detection:** If a cached SHA returns 404 or 409 from the Compare API, the entire cache is invalidated (full re-fetch from Trees API). This handles admin force-pushes, squash merges, and history rewrites.

### Service Level Objectives (SLOs)

These SLOs apply to the web/container deployment in API mode. They are measured over a rolling 30-day window.

| SLO | Target | Measurement |
|-----|--------|-------------|
| Availability | 99.9% | `/health` returns 200 (excluding planned maintenance) |
| Taxonomy freshness | P99 ≤ 60s, P50 ≤ 2s | Time from push to main → cache updated (polling vs webhook) |
| Read latency (cache hit) | P95 < 300ms | `/api/taxonomy/:pov` response time when cache is warm |
| Read latency (cache miss) | P99 < 3s | `/api/taxonomy/:pov` response time on cold fetch |
| Write success rate | ≥ 99.5% | Batch commits that succeed on first attempt (excluding GitHub outages) |
| Sync UI freshness | < 10s | Time from save → unsynced count updates in SaveBar |

**Error budget:** 0.1% unavailability = ~43 minutes/month. Exhaustion triggers: pause non-critical deployments, investigate root cause before resuming changes.

### Azure Monitor Alerts

| Alert | Condition | Severity |
|-------|-----------|----------|
| Rate limit warning | `github.rate_limit_remaining` < 1,000 for 5 min | Warning |
| Rate limit critical | `github.rate_limit_remaining` < 500 or any 429 response | Critical |
| Cache degraded | Cache hit rate < 85% over 5 min | Warning |
| Branch divergence | Any active session branch > 10 commits behind main | Warning |
| API error spike | > 5 `github.api.error` events in 5 min | Critical |
| Fallback active | `storage.fallbackActive` = true for > 5 min | Critical |
| Container restart storm | > 3 restarts in 15 min | Critical |

### Operational Runbooks

Create `deploy/azure/runbooks/` with procedures for:

| Runbook | Trigger | Key Steps |
|---------|---------|-----------|
| GitHub Outage | Fallback active alert | Verify fallback data serving. Notify users via banner (automatic). Monitor GitHub status page. Writes auto-resume when API returns. |
| Rate Limit Exhaustion | Rate limit critical alert | Check for burst source in structured logs. If container is polling-storming: scale to 0 temporarily. If legitimate: reduce polling interval or disable non-essential reads. |
| Cache Corruption | Manifest fails checksum or repeated cache misses | Force full re-fetch via SyncDiagnosticsDialog "Force cache refresh" button. If persistent: restart container (clears `/tmp` cache). |
| Token / Key Vault Failure | Auth errors in flight recorder | Check Key Vault accessibility (`az keyvault show`). Check managed identity assignment. Check GitHub App installation status. Force token refresh via server-dump endpoint. |
| Session Branch Force-Push | `cache.invalidate` with trigger `force-push` | Automatic: full cache invalidation. Manual: verify user's session branch is still valid. If orphaned: notify user to re-create from main. |

---

## Phase 2G: Observability & Flight Recorder Integration

The existing flight recorder infrastructure (ring buffer, NDJSON dumps, context providers, bridge instrumentation) must be extended to cover all new GitHub API operations. This is critical — distributed synchronization systems are impossible to debug without deep telemetry.

### New Event Types

Add these to the flight recorder `EventType` enum in `lib/flight-recorder/types.ts`:

| Event Type | Component | Level | When |
|-----------|-----------|-------|------|
| `github.api.request` | `github-api` | debug | Every GitHub REST API call (method, endpoint, rate-limit headers) |
| `github.api.response` | `github-api` | debug | API response (status, duration_ms, rate_remaining, cache_hit) |
| `github.api.error` | `github-api` | error | API failure (status, error body, retry count) |
| `github.api.rate_limit` | `github-api` | warn | Rate limit warning (remaining < 1000) or degraded (remaining < 500) |
| `cache.hit` | `cache` | debug | Cache hit (path, age_ms, generation) |
| `cache.miss` | `cache` | info | Cache miss (path, reason: expired/missing/invalidated) |
| `cache.invalidate` | `cache` | info | Cache invalidation (paths[], trigger: poll/force-push/manual) |
| `cache.manifest.swap` | `cache` | info | Manifest atomic swap (generation, file_count, main_sha) |
| `branch.create` | `session` | info | Session branch created (userId, from_sha) |
| `branch.commit` | `session` | info | Batch commit (branch, file_count, commit_sha, duration_ms) |
| `branch.delete` | `session` | info | Session branch deleted (userId, reason: pr-merged/manual/ttl) |
| `branch.divergence` | `session` | warn | Branch divergence detected (behind_by, ahead_by) |
| `sync.pr.create` | `session` | info | PR created (number, url, branch) |
| `sync.pr.update` | `session` | info | PR updated (number, new commits) |
| `sync.pr.merge` | `session` | info | PR merged (number, merge_sha) |
| `sync.conflict` | `session` | warn | Merge conflict detected (pr_number, conflicting_files) |
| `sync.webhook` | `session` | info | Webhook received (event_type, delivery_id) |
| `storage.mode` | `storage` | info | Storage mode selected at startup (mode, backend_class) |
| `storage.fallback` | `storage` | warn | Fallback data activated (data_age_hours, reason) |

### Server Context Provider Update

Extend the server-side flight recorder context provider (currently in `server.ts` lines 29-68) with GitHub API state:

```typescript
serverRecorder.setContextProvider(() => ({
  server: { version, started_at, uptime_s, ... },
  memory: { rss_mb, heap_used_mb, heap_total_mb },
  storage: {
    mode: process.env.STORAGE_MODE,
    cache_generation: backend.getCacheGeneration(),
    cache_file_count: backend.getCachedFileCount(),
    cache_hit_rate: backend.getCacheHitRate(),
    main_sha: backend.getMainSha(),
    last_poll_age_s: backend.getLastPollAge(),
  },
  github: {
    rate_limit_remaining: backend.getRateLimitRemaining(),
    rate_limit_resets_at: backend.getRateLimitResetsAt(),
    token_expires_in_s: backend.getTokenExpiresIn(),
    active_branches: backend.getActiveBranchCount(),
  },
  sessions: {
    active_count: sessionManager.getActiveSessionCount(),
    branches: sessionManager.getActiveBranches(), // [{userId, branch, ahead_by, behind_by}]
  },
}));
```

### Dictionary Registrations

Register new component names at server startup:

```typescript
serverRecorder.intern('component', 'github-api');
serverRecorder.intern('component', 'cache');
serverRecorder.intern('component', 'session');
serverRecorder.intern('component', 'storage');
```

### Request Tracing

Every REST call from the web bridge generates a `request_id` (UUID) passed as an `X-Request-ID` header. Server middleware stamps this on every flight recorder event within that request. Combined with the batch commit's `call_id`, this enables end-to-end tracing from button click to GitHub response.

```
request_id=xyz789 → bridge.call (saveTaxonomyFile, info)
request_id=xyz789 → lock.acquire_attempt (file: accelerationist.json)
request_id=xyz789 → lock.acquired (wait_duration_ms: 2)
request_id=xyz789 → call_id=abc123 → github.api.request (POST trees)
...
request_id=xyz789 → lock.released (hold_duration_ms: 280)
request_id=xyz789 → bridge.call (success, duration_ms: 310)
```

### Correlation IDs

All GitHub API events within a single batch commit share a `call_id` (UUID) for correlation. This allows tracing a save operation from the initial write-through to the 4-step Trees API sequence:

```
call_id=abc123 → github.api.request (GET refs)
call_id=abc123 → github.api.response (200, 45ms)
call_id=abc123 → github.api.request (POST trees)
call_id=abc123 → github.api.response (201, 120ms)
call_id=abc123 → github.api.request (POST commits)
call_id=abc123 → github.api.response (201, 80ms)
call_id=abc123 → github.api.request (PATCH refs)
call_id=abc123 → github.api.response (200, 30ms)
call_id=abc123 → branch.commit (4 files, 275ms total)
```

### Structured Logging Integration

All `github.api.*` events are also emitted as structured JSON to stdout (for Azure Log Analytics). Format:

```json
{"level":"info","component":"github-api","event":"api.response","endpoint":"GET /repos/.../contents/taxonomy/Origin/accelerationist.json","status":200,"duration_ms":145,"rate_remaining":4855,"cache_hit":false,"timestamp":"2026-05-13T15:00:00Z"}
```

This enables Log Analytics queries like:
- `where component == "github-api" and duration_ms > 1000` — slow API calls
- `where event == "api.rate_limit"` — rate limit events
- `where event == "cache.invalidate"` — cache invalidation frequency
- `where event == "sync.conflict"` — merge conflict frequency

### Health Endpoint Expansion

`GET /health` now includes flight recorder stats alongside GitHub API stats:

```json
{
  "status": "ok",
  "flightRecorder": {
    "eventsTotal": 1234,
    "eventsRetained": 1000,
    "capacity": 2000
  },
  "github": {
    "rateLimit": { "remaining": 4850, "limit": 5000, "resetsAt": "..." },
    "cacheHitRate": 0.95,
    "cacheGeneration": 42,
    "lastPollAt": "...",
    "activeBranches": 2
  },
  "storage": {
    "mode": "github-api",
    "mainSha": "abc1234",
    "cacheFileCount": 15,
    "fallbackActive": false
  }
}
```

### Mutex Instrumentation

Both the per-file write mutex and per-user commit mutex are instrumented:

| Event | Level | Fields |
|-------|-------|--------|
| `lock.acquire_attempt` | debug | lock_type (file/user), key (path/userId), request_id |
| `lock.acquired` | debug | lock_type, key, wait_duration_ms |
| `lock.released` | debug | lock_type, key, hold_duration_ms |
| `lock.timeout` | error | lock_type, key, wait_duration_ms (always 10,000) |
| `lock.ttl_eviction` | error | lock_type, key, hold_duration_ms (always 30,000), call_id |

**Hard timeout on acquisition:** 10 seconds. If exceeded, throw `LockTimeoutError` (ActionableError with goal, problem, location, next steps). This prevents silent hangs from queued requests waiting on a stalled lock holder.

**Absolute TTL on hold:** 30 seconds. If a lock is held longer than 30 seconds (e.g., a GitHub API call hangs indefinitely inside the critical section), the lock is automatically evicted and the operation marked as failed (`lock.ttl_eviction` event). Write-through cache guarantees safety — if the GitHub write succeeded but we lost track, the next poll catches up; if it failed, the cache is clean.

### Cache Coherency Probe

For 1% of cache hits (randomly sampled), asynchronously verify the cached content against GitHub after serving the user:

1. Fire background `GET` with `If-None-Match: {etag}` for the served file
2. If GitHub returns 304 (not modified): no action, coherency confirmed
3. If GitHub returns 200 (content changed but cache reported hit): log `cache.coherency_violation` as **critical**, auto-invalidate entire cache, increment violation counter on `/health`

Rate-limit cost: ~1-2 extra API calls/hour at current read volume. Provides continuous integrity checking that catches bugs in manifest logic that would otherwise cause silent stale-data serving.

### Webhook Effectiveness Measurement

Track `sync.freshness_delta_ms` — elapsed time from GitHub push timestamp to the moment the server's cache invalidates the affected files. Expose `webhook_effectiveness_ratio` on `/health`:

- Ratio = (updates caught by webhook) / (total updates detected)
- If ratio drops below 50% over 1 hour → log warning, investigate webhook delivery
- If P50 freshness delta is consistently ~60s → webhooks are failing silently, app is polling-only

### Secondary Error Buffer

In addition to the main ring buffer (2,000 events), maintain a small **error-only buffer** (100 events) that stores only `error` and `warn` level events. Included as a `_type: "errors"` section in flight recorder dumps. This guarantees that root-cause error events survive even if a retry storm floods the main buffer with thousands of debug-level API request logs.

### Background Task Error Handling

Background tasks (cache polling, webhook handler, stale branch scan) run outside the Express request context. Ensure:

- `process.on('unhandledRejection')` handler logs to flight recorder with `{ component: 'server', context: 'background-task' }`
- All background async loops wrap their body in try/catch with explicit flight recorder events
- Polling loop failures never crash the server — log, increment error counter, retry on next interval

### SIGUSR2 Emergency Dump

When the event loop is blocked or Express is unresponsive, the normal dump mechanisms (Ctrl+Alt+D, API endpoint) are unreachable. Register a POSIX signal handler that bypasses the event loop:

```typescript
process.on('SIGUSR2', () => {
  const dump = serverRecorder.buildDump('manual', null, { trigger: 'SIGUSR2' });
  process.stderr.write(dump + '\n');  // stderr, not stdout (stdout may be buffered)
});
```

**Diagnostic command** (from Azure CLI or container exec):
```bash
az containerapp exec -n taxonomy-editor -g ai-triad --command "kill -SIGUSR2 $(pgrep node)"
```

Note: SIGUSR2 is used instead of SIGUSR1 because Node.js reserves SIGUSR1 for the debugger in some configurations. `tini` (PID 1) forwards signals to the child process, so this works correctly in the container. Add this command to the operational runbooks.

### Diagnostic Dump Enrichment

When a flight recorder dump is triggered (manual Ctrl+Alt+D, uncaught error, or via DiagnosticsWindow button), the context provider captures a full snapshot of GitHub API state — cache generation, rate limit, active branches, last poll time, token expiry. This makes dumps self-contained for post-mortem analysis.

---

## Phase 2H: Webhook Acceleration

### Hybrid Polling + Webhook Model

Polling alone creates a ≤60s stale window. The existing `POST /api/sync/webhook/github` endpoint (HMAC-verified) already handles push events. Extend it for API mode:

**Events to handle:**
- `push` to `main` → invalidate cache for changed files, push WebSocket event to clients
- `pull_request` merged → delete session branch from local tracking, push WebSocket event
- `pull_request` opened/updated → update PR status in sync state

**Client notification:** When webhook fires, emit a WebSocket event on `ws/events`:
```json
{ "type": "sync:main-updated", "sha": "abc1234", "changed_files": ["taxonomy/Origin/accelerationist.json"] }
```

`useSyncStatus` listens for this event and triggers an immediate refresh instead of waiting for the 10-second poll.

**Fallback:** Polling continues as a correctness backstop. If webhooks fail (GitHub outage, misconfigured webhook URL, network partition), polling catches up within 60 seconds. Webhook delivery is logged as `sync.webhook` events in the flight recorder.

---

## Phase 2I: Branch Lifecycle Governance

### Policies

| Policy | Value | Enforcement |
|--------|-------|-------------|
| Branch TTL | 30 days inactive | Scheduled scan (daily) deletes stale branches |
| Max branches per user | 1 active | New edit when branch exists → resume existing branch |
| Max divergence | 20 commits behind main | Auto-merge main into session branch (non-fast-forward merge via Merges API). If conflicts, force user to resolve before allowing further saves. |
| Orphan detection | On auth provider change | If `userId` mapping changes, scan for orphaned `api-session/*` branches |

### Stale Branch Cleanup

Add a **scheduled GitHub Actions workflow** (not server-side cron — simpler, no container load, runs reliably even if the app is scaled to zero):

```yaml
# .github/workflows/cleanup-session-branches.yml
name: Cleanup stale session branches
on:
  schedule:
    - cron: '0 4 * * *'  # Daily at 4 AM UTC
```

Steps:
1. `GET /repos/.../git/refs/heads/api-session/` → list all session branches
2. For each branch, check last commit date via `GET /repos/.../commits?sha={branch}&per_page=1`
3. If last commit > 30 days ago and no open PR: delete branch (`DELETE /repos/.../git/refs/heads/api-session/{userId}`)
4. Log deleted branches in workflow summary

### Force Push / History Rewrite Handling

If the Compare API returns 404 or 422 for a cached SHA:

1. Log `cache.invalidate` event with trigger `force-push`
2. Invalidate entire cache manifest (not just affected files)
3. Full re-fetch via Trees API
4. For active session branches: check if branch base SHA still exists in main history. If not, warn user: "Main branch was rewritten — your session branch may need to be rebased."

---

## Phase 2J: Scaling Limits & Review Triggers

These are known GitHub API limits. The system operates well within them today but should be monitored.

| Limit | Threshold | Current | Review Trigger |
|-------|-----------|---------|----------------|
| Contents API file size | 100 MB | Largest file: ~30 MB | If any file exceeds 50 MB |
| Trees API entries | 100,000 (truncated beyond) | ~2,000 files | If repo exceeds 50,000 files |
| Compare API performance | Degrades >300 changed files | Typical diff: 1-5 files | If diffs regularly exceed 100 files |
| Rate limit (primary) | 5,000/hr per installation | ~145/hr estimated | If usage exceeds 2,000/hr |
| Rate limit (secondary) | Abuse detection on burst writes | 4 calls per save-batch | If saves exceed 30/minute |
| Repository size | GitHub warns at 5 GB | ~410 MB | If repo exceeds 2 GB |
| Branch count | No hard limit, but refs slow | 2-5 active | If stale branches accumulate >50 |

**When a trigger fires:** Log a `system.scaling_warning` event, review whether to archive old data (debates, transcripts, closed conflicts) into a separate repo or implement retention policies.

---

## Phase 3: Infrastructure Cleanup (DevOps)

### 3.1 Remove Azure Files from Bicep (`main.bicep`)

Delete these resources:
- `storageAccount` (Microsoft.Storage/storageAccounts)
- `fileService` (fileServices)
- `dataShare` (file share `taxonomy-data`)
- `storageMount` (environment storage mount)
- Volume mount on container app (`/data-persistent`)
- Volume definition (`taxonomy-data`, `AzureFile`)
- `shareDeleteRetentionPolicy`

Keep:
- Key Vault (still used for GitHub App PEM + BYOK API keys)
- Log Analytics
- Container Apps Environment
- Auth config

**Cost savings:** ~$3-5/month (Azure Files Standard LRS).

### 3.2 Simplify Dockerfile

Remove:
- `RUN mkdir -p /data && chown aitriad:aitriad /data` (no local data dir needed)
- `COPY deploy/azure/entrypoint.sh ./entrypoint.sh` (no entrypoint)

Keep:
- `ENTRYPOINT ["tini", "--"]` — required for PID 1 zombie reaping and SIGTERM handling (pty-broker.py spawns subprocesses)
- `ENV AI_TRIAD_DATA_ROOT` — update value to `/tmp/taxonomy-cache` (server code still reads it)

Change:
- `CMD ["sh", "entrypoint.sh"]` → `CMD ["node", "dist/server/taxonomy-editor/src/server/server.js"]`

The `/tmp/taxonomy-cache/` directory is created by the app at runtime — no Dockerfile changes needed for it.

**Verify `/tmp` storage backing:** Azure Container Apps may back `/tmp` with tmpfs (RAM-backed) depending on the workload profile. The cache working set is 30-60 MB (5 taxonomy files + conflict index + tree object; embeddings lazy-loaded only on search). If `/tmp` is tmpfs, either confirm sufficient memory headroom (container has 1 GiB, app baseline ~300 MB, cache ~60 MB = 640 MB headroom) or configure an explicit ephemeral volume for `/tmp/taxonomy-cache` that uses disk.

**Container restart resilience:** Session branch writes survive container restarts because the branch exists on GitHub — only the local cache is lost. On restart, the boot sequence resolves the user's session branch via session context and fetches from GitHub. The user sees a brief cache-miss delay, not data loss.

### 3.3 Simplify `entrypoint.sh` → Delete

The entire `entrypoint.sh` (93 lines) becomes unnecessary:
- No Azure Files mount to copy from
- No `.git` handling
- No copy-status.json
- No background subshell

Replace `CMD ["sh", "entrypoint.sh"]` with `CMD ["node", "dist/server/taxonomy-editor/src/server/server.js"]`.

### 3.4 Update `deploy-azure.yml`

- Remove "Trigger data-repo initialization" step (no git repo to init)
- Simplify health check (app starts instantly, no copy wait)
- Keep: stale revision cleanup, curl timeout, failure diagnostics, traffic shift retry

### 3.5 Remove `deploy.ps1` SeedData

The `-SeedData` parameter and the entire seed section (lines 150-215) become unnecessary — no Azure Files share to seed.

### 3.6 Clean Up Azure Files Share

After successful cutover:
```bash
# Verify app is running without Azure Files
curl -s .../health  # ok
curl -s .../api/data/available  # true

# Delete the file share
az storage share delete --name taxonomy-data --account-name staitriadkvwl3nywge4iw

# (Optional) Delete the storage account if no other shares exist
az storage account delete --name staitriadkvwl3nywge4iw -g ai-triad
```

---

## Phase 4: Fallback & Resilience

### 4.1 Bake Last-Known-Good Into Container Image

Add a build step to `container.yml` that fetches the current taxonomy from GitHub and bakes it into the image:

```yaml
- name: Fetch taxonomy snapshot
  continue-on-error: true  # Missing snapshot shouldn't block image build
  run: |
    mkdir -p taxonomy-snapshot/taxonomy/Origin
    for f in accelerationist.json safetyist.json skeptic.json cross-cutting.json edges.json policy_actions.json embeddings.json; do
      gh api "/repos/AI-Rosetta-Stone/ai-triad-data/contents/taxonomy/Origin/$f" \
        --jq '.content' | base64 -d > "taxonomy-snapshot/taxonomy/Origin/$f"
    done
    # Validate at least one file was fetched
    [ -s taxonomy-snapshot/taxonomy/Origin/accelerationist.json ] || echo "::warning::Snapshot fetch failed — image will start without fallback data"
  env:
    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

```dockerfile
# 6. Fallback taxonomy snapshot (changes on every image build — LAST layer)
COPY --chown=aitriad:aitriad taxonomy-snapshot/ ./fallback-data/
```

> **Notes (from Docker review):** Place the snapshot COPY as the last layer to avoid busting cached layers above it. Use `gh api` with auth (not unauthenticated `curl`) in case the data repo goes private. `continue-on-error: true` ensures a failed fetch doesn't block the image build. Image size impact: ~15 MB (taxonomy + conflict index) — well within budget.

If GitHub API is unreachable at startup, serve from `/app/fallback-data/` (read-only mode, banner: "Running in offline mode — data from [build date]. Edits disabled.").

**Fallback data scope** — what is baked vs what shows as empty:

| Data | Baked? | Rationale |
|------|--------|-----------|
| Taxonomy POV files (5) | Yes | Core app functionality |
| `edges.json` | Yes | Required for graph views |
| `policy_actions.json` | Yes | Required for policy views |
| `embeddings.json` | Yes | Required for search/similarity |
| `_conflict-index.json` | Yes | Required for conflicts tab |
| `_conflict-clusters.json` | Yes | Required for cluster display |
| Debates, chats | No — empty | User-generated, varies per session |
| Sources, summaries | No — empty | Large, not critical for read-only mode |
| Proposals, harvests | No — empty | In-progress work, not needed for fallback |

The CI build step validates that at least the 5 taxonomy files + edges + policy registry are present before proceeding.

### 4.2 Rate Limit Monitoring

Add `X-RateLimit-Remaining` to the `/health` endpoint response:
```json
{
  "status": "ok",
  "github": {
    "rateLimit": { "remaining": 4850, "limit": 5000, "resetsAt": "..." },
    "cacheHitRate": 0.95,
    "lastPollAt": "..."
  }
}
```

**Alert at 80%:** When `X-RateLimit-Remaining` drops below 1,000 (20% budget left), log a warning. Below 500: return `degraded` health status and disable polling (serve from cache only). This prevents rate limit exhaustion from cascading into API failures.

**Expected budget:** ~145 calls/hour (60 polling + 10 startup + 10 reads + 60 writes + 5 listings) — well within 5,000/hour limit (97% headroom).

---

## Testing Strategy

### Unit Tests (Ticket 2 — GitHubAPIBackend)

- Mock GitHub API responses (use `msw` or similar HTTP mock library)
- Test every `StorageBackend` method: readFile, writeFile, listDirectory, deleteFile, fileExists
- Test session context resolution: reads from session branch vs main
- Test cache behavior: hits, misses, invalidation, atomic manifest swap, generation counter
- Test error handling: 404, 409, 422, 429, 5xx, network errors
- Test retry policy: exponential backoff, jitter, Retry-After header
- Test circuit breaker: activation after 5 failures, cooldown, probe request
- Test rate limit tracking: warning threshold, degraded mode
- Test force push detection: 404 on cached SHA → full invalidation

### Unit Tests (Ticket 4 — Session Branch Manager)

- Test branch lifecycle: create, commit, PR, delete
- Test batch commit via Trees API: verify 4-step sequence
- Test per-user commit mutex: concurrent saves serialized
- Test token freshness check: force refresh when <60s remaining
- Test branch name sanitization: special characters, email addresses

### Integration Tests (New Ticket 11)

- Run against a **disposable test repo** (`ai-triad-test-data` or similar)
- End-to-end: start server with `STORAGE_MODE=github-api` → create session branch → save taxonomy → create PR → verify on GitHub
- Webhook: trigger push event → verify cache invalidation + WebSocket notification
- Divergence: advance main while session branch exists → verify warning banner
- Multi-user: two sessions editing simultaneously → verify branch isolation

### Chaos Tests (New Ticket 11)

- Simulate rate limit exhaustion (mock 429 responses) → verify circuit breaker + fallback mode
- Simulate GitHub outage (mock 500 responses) → verify fallback data served + writes disabled
- Simulate token expiry mid-batch → verify retry with fresh token
- Simulate force push (delete and recreate main ref) → verify full cache invalidation
- Simulate missing conflict index → verify hard cap (empty array, not 1,244 reads)

---

## Implementation Tickets

| # | Title | Owner | Depends On | Effort | Notes |
|---|-------|-------|-----------|--------|-------|
| 1 | `StorageBackend` interface + `FilesystemBackend` (sync→async migration) | Taxonomy Editor | — | Medium | Large diff: 75+ sync `fs` calls → async. Per-file write mutex for RMW ops. Standalone PR, no behavior change. |
| 2 | `GitHubAPIBackend` implementation (Contents/Blobs/Trees APIs + cache + session context) | Taxonomy Editor | 1 | Large | Includes session context resolution, per-user cache overlays, retry/backoff/circuit-breaker, flight recorder events. |
| 3 | Consolidate conflict files into `_conflict-index.json` | PowerShell | — | Small | |
| 4 | Session Branch Manager — per-user branch lifecycle, batch commits, multi-tab mutex | Taxonomy Editor | 2 | Medium | Includes `sanitizeBranchName`, per-user commit mutex, token freshness check. |
| 5 | Wire `STORAGE_MODE` switch + session context middleware in `server.ts` | Taxonomy Editor | 1, 2 | Small | Includes Easy Auth → SessionContext middleware. |
| 6 | Sync UI in API mode — unsynced view, diffs, PR creation, divergence warnings | Taxonomy Editor | 4, 5 | Medium | UI component transition per Phase 2E. Interactive rebase deferred. |
| 7 | Remove legacy git sync infrastructure (`gitRepoStore`, `initDataRepo`, copy guards) | Taxonomy Editor | 5, 6 | Medium | |
| 8 | Bake taxonomy snapshot into container image (fallback) | Docker | 2 | Small | Expanded scope: taxonomy + edges + policy + embeddings + conflict index/clusters. |
| 9 | Remove Azure Files from Bicep, simplify Dockerfile/entrypoint | Docker (Dockerfile) + Azure (Bicep) | 5, 7 | Small | Keep tini ENTRYPOINT. |
| 10 | Update deploy workflow + deployment docs | DevOps / Documentation | 9 | Small | |
| 11 | Integration + chaos tests for GitHub API mode | Taxonomy Editor | 2, 4 | Medium | Disposable test repo. Covers end-to-end, webhook, divergence, multi-user, rate limit, outage, force push. |

**Critical path:** 1 → 2 → 5 + 4 (parallel) → 6 → 7 → 9 → 10
**Parallel work:** 3 (conflicts), 8 (fallback), 11 (tests — after 2+4)

> **Note (from Tech Lead review):** Ticket 1 is intentionally first — it extracts the `FilesystemBackend` by migrating 75+ synchronous `fs` calls to async. This is a mechanical but large diff that should be a standalone PR proving the abstraction works before Ticket 2 adds the `GitHubAPIBackend`. No behavior change in Ticket 1.

---

## Risk Mitigations (from internal + external reviews)

| # | Risk | Severity | Mitigation | Ticket |
|---|------|----------|-----------|--------|
| 1 | Cache loss on container restart during GitHub outage | HIGH | Add stale-data age to read-only banner. Consider persistent cache volume (~$0.06/month). Daily image builds for fresh snapshots. Log fallback data age on startup. | 2, 8 |
| 2 | Shared rate limit across container instances | MEDIUM | Degraded mode disables all polling (not just periodic). Log `X-RateLimit-Remaining`. Cap replicas (`maxReplicas: 1` for now). | 2 |
| 3 | Conflict index fallback = 1,244 API calls | MEDIUM | Hard cap on fallback: if `_conflict-index.json` missing, return empty conflicts — never enumerate 1,244 files. Add index generation to CI. | 2, 3 |
| 4 | In-flight edits lost during cutover | MEDIUM | Cutover checklist: check for unsynced changes. Notify users to PR pending work. 7-day soak period before Azure Files deletion. | 9 |
| 5 | PEM key material in process memory | MEDIUM | Ban inline `GITHUB_APP_PRIVATE_KEY` env var in prod — Key Vault path only. Verify GitHub App permissions are minimally scoped (`contents: write` on ai-triad-data only). | 2 |
| 6 | Async interleaving on read-modify-write cycles | MEDIUM | Per-file write mutex for ~5 affected functions (updateEdgeStatus, bulkUpdateEdges, swapEdgeDirection, harvestAddVerdict, harvestUpdateSteelman). | 1 |
| 7 | Optimistic cache updates diverge from GitHub on write failure | MEDIUM | Write-through caching only — cache updated after 2xx, never optimistically. | 2 |
| 8 | Session branch diverges from main over days → massive merge conflicts | MEDIUM | Divergence warning (yellow at 3+, red at 10+ commits behind). Auto-merge main at 20+ commits. | 6 |
| 9 | Force push / history rewrite invalidates cached SHAs | MEDIUM | Detect via 404/422 on Compare API. Full cache invalidation + re-fetch. Log as `cache.invalidate` with trigger `force-push`. | 2 |
| 10 | Token expiry mid-batch-commit | LOW | Validate >60s remaining before starting batch. Force early refresh if needed. | 4 |
| 11 | Conflict index memory pressure (5.5 MB) | LOW | Cache parsed object, not raw string. No action beyond existing design. | — |
| 12 | Sync-to-async migration regressions | LOW | Already mitigated by ticket sequencing (Ticket 1 first as standalone PR). | 1 |
| 13 | Abandoned session branches accumulate | LOW | 30-day TTL, daily cleanup scan, max 1 branch per user. | 4 |

---

## Rollback Plan

If the GitHub API-first approach has issues in production:

1. **Re-enable Azure Files:** Revert the Bicep template (git revert on the removal commit)
2. **Re-seed data:** Run `deploy.ps1 -SeedData` to populate the share
3. **Switch `STORAGE_MODE=filesystem`:** Toggle the env var, redeploy
4. **No data loss:** All writes go to GitHub (the source of truth) regardless of storage mode

The `STORAGE_MODE` env var makes this a zero-downtime rollback — just change the var and restart.

### Cutover Sequencing (from Azure + Risk Assessor reviews)

1. Add `STORAGE_MODE=github-api` to both prod and staging in Bicep (keep Azure Files mounted)
2. Deploy — both apps start using GitHub API, Azure Files still available as fallback
3. Verify 48 hours of stable API-mode operation
4. **Cutover checklist:** Check for unsynced changes, notify users to PR pending work
5. Remove Azure Files resources from Bicep, deploy
6. **7-day soak period:** Keep storage account alive (don't delete) for instant rollback
7. After 7 days of stability: delete storage account via Bicep removal

---

## Success Criteria

- [ ] App starts in <5s (currently 30-60s)
- [ ] `/api/data/available` returns true within 5s of container start
- [ ] Taxonomy edits create a branch + PR on GitHub
- [ ] GitHub pushes to main are visible in the app within 60s (≤2s with webhook)
- [ ] Azure Files storage account deleted
- [ ] Monthly Azure cost reduced by $3-5
- [ ] No `entrypoint.sh`, no `.git-ready`, no `isCopyInProgress()` guards
- [ ] All sync UI components work in API mode (UnsyncedChangesDrawer, SyncDiagnosticsDialog, SaveBar)
- [ ] Flight recorder captures all GitHub API calls, cache operations, and branch lifecycle events
- [ ] `/health` endpoint includes GitHub API stats, cache state, and flight recorder stats
- [ ] Divergence warning shown when session branch falls behind main
- [ ] Stale session branches auto-cleaned after 30 days
- [ ] Force push on main detected and cache fully invalidated
- [ ] Container image size reduced (no git binary needed in base image — future optimization)
