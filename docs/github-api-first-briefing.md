# GitHub API-First Implementation Plan — External Review Briefing

This document provides the full context needed to evaluate the GitHub API-First implementation plan (`docs/github-api-first-implementation.md`). It is written for reviewers who have no prior knowledge of the system.

---

## What Is This Project?

**AI Triad Research** is a multi-perspective research platform for AI policy and safety literature, built at the Berkman Klein Center (Harvard). The platform lets researchers organize AI policy positions into a structured taxonomy (a graph of beliefs, desires, and intentions across three philosophical camps: accelerationist, safetyist, and skeptic), detect conflicts between positions, run AI-powered debates, and produce policy analysis.

### Two Repositories

| Repo | Contents | Size |
|------|----------|------|
| `ai-triad-research` (code) | TypeScript apps, PowerShell module, CI/CD, infrastructure | ~10 MB |
| `ai-triad-data` (data) | Taxonomy JSON files, source documents, summaries, conflict files, debate transcripts, embeddings | ~410 MB |

The code repo never contains data. The data repo is the single source of truth for all taxonomy content.

**Data repo file size distribution:** The 410 MB aggregate is spread across thousands of small files, not a few large ones. No single file exceeds ~30 MB. This matters for API design — the `StorageBackend` interface uses `Promise<string>` (not streaming) because individual file sizes are well within V8's comfort zone.

| Data Type | File Count | Typical File Size | Largest File |
|-----------|-----------|-------------------|--------------|
| Taxonomy POV files | 5 | 1-5 MB | ~5 MB |
| Embeddings | 1 | ~20-30 MB | ~30 MB (largest in repo) |
| Conflict files | 1,244 | 2-50 KB each | ~5.5 MB total |
| Debate transcripts | ~50-100 | 10-200 KB | <1 MB |
| Chat sessions | Variable | 5-100 KB | <1 MB |
| Source documents | ~200 | 10-500 KB | <1 MB |
| Summaries | ~200 | 5-50 KB | <500 KB |
| Edges, policy registry | 2 | 100-500 KB | <1 MB |

### The Application

The **Taxonomy Editor** is the primary app. It runs in two modes:

- **Desktop (Electron)**: Runs locally on macOS/Windows. Reads/writes data directly from the local filesystem via Node.js `fs` module. The data repo is cloned locally.
- **Web (Azure Container Apps)**: Hosted at `https://taxonomy-editor.yellowbush-aeda037d.eastus.azurecontainerapps.io`. A Node.js HTTP server serves a React SPA. Currently reads/writes data from an Azure Files SMB mount that contains a clone of the data repo.

Both modes share the same React frontend. A "bridge" pattern abstracts the difference: `electron-bridge.ts` (IPC to Electron main process) vs `web-bridge.ts` (REST calls to server). The bridge implements a shared `AppAPI` interface with 100+ methods.

---

## The Current Data Architecture (What We're Replacing)

### How the Web App Gets Data Today

```
Container starts
  -> entrypoint.sh (93-line shell script)
    -> Background: copy data from Azure Files SMB mount (/data-persistent) to local disk (/data)
       - 9 directories: taxonomy, sources, summaries, debates, conflicts, chats, etc.
       - Skips .git/ (SMB corrupts git internals)
       - Writes progress to /tmp/copy-status.json
    -> Foreground: start Node.js server immediately
  -> Server starts, health probes pass
  -> Server retries git init (12 attempts, 15s intervals):
    - Waits for background copy to finish
    - Clones to /tmp, moves .git/ to data root
    - Writes .git-ready marker file
  -> App becomes fully interactive (30-60s after container start)
```

### Problems with This Architecture

1. **Slow startup**: 30-60 seconds (SMB copy + git init), during which the app shows a loading state
2. **SMB corruption**: Azure Files SMB doesn't preserve git filesystem semantics — `.git/` directories corrupt, lock files persist across mounts, empty directories appear
3. **Copy guards**: 9+ server endpoints check `isCopyInProgress()` and return early if the background copy hasn't finished
4. **Git init failures**: The init retry loop fails intermittently, leaving the app in a degraded state where edits work but sync doesn't
5. **Infrastructure cost**: Azure Files Standard LRS costs ~$3-5/month for storage we don't need if we read from GitHub directly
6. **Complexity**: `entrypoint.sh` (93 lines), `gitRepoStore.ts` (1,371 lines, 4-phase git sync), copy-status protocol, `.git-ready` markers

### How Edits Work Today (Web Mode)

1. User edits taxonomy in the browser
2. Browser sends `PUT /api/taxonomy/:pov` to server
3. Server writes JSON to local disk via `fileIO.ts` (synchronous `fs.writeFileSync`)
4. `gitRepoStore.ts` auto-commits the change to a session branch (`web-session/{userId}`)
5. User clicks "Create PR" → server runs `git push` + creates GitHub PR
6. PR reviewed and merged on GitHub
7. Server detects merge via webhook or polling, fetches updates

---

## The Proposed Architecture (GitHub API-First)

### Core Idea

Replace all local disk I/O and git operations with direct GitHub REST API calls. The data repo on GitHub becomes the live backend, not just a sync target.

### How It Would Work

```
Container starts
  -> CMD: node server.js (no entrypoint, no background copy)
  -> Health probes pass immediately
  -> GitHubAPIBackend.initialize():
    - Get GitHub App installation token from Azure Key Vault
    - Check /tmp/taxonomy-cache/manifest.json
    - If cache is fresh (SHA matches GitHub main HEAD): serve from cache (0 API calls, <100ms)
    - If cache is stale or missing: fetch changed files via Compare API (2-10 calls, 3-5s)
  -> App interactive in <5s
```

### Key Design Decisions

#### 1. StorageBackend Abstraction

Instead of rewriting the 40+ domain functions in `fileIO.ts` (911 lines covering taxonomy, conflicts, edges, debates, chats, proposals, harvest, sources, summaries, prompts), we abstract the raw I/O:

```typescript
interface StorageBackend {
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string): Promise<void>;
  listDirectory(path: string): Promise<string[]>;
  deleteFile(path: string): Promise<void>;
  fileExists(path: string): Promise<boolean>;
}
```

Two implementations:
- `FilesystemBackend` — wraps `fs.promises.*` (current behavior, for Electron and local dev)
- `GitHubAPIBackend` — uses GitHub Contents/Blobs/Trees API with local SSD cache

`fileIO.ts` keeps all domain logic (conflict parsing, edge updates, harvest operations) but delegates raw I/O to whichever backend is active. This minimizes blast radius.

**Session context injection:** In API mode, reads and writes must target the correct git ref — `main` (for users without edits) or `api-session/{userId}` (for users with active session branches). Server middleware resolves the authenticated user (from Azure Easy Auth headers) into a `SessionContext` that `GitHubAPIBackend` uses internally for ref resolution. The cache has two layers: a shared main cache and per-user session overlays, so User A's edits are invisible to User B until merged to main. `FilesystemBackend` ignores session context (there's only one copy on disk).

**Important migration note:** The current `fileIO.ts` uses 75+ synchronous `fs` calls (`readFileSync`, `writeFileSync`, etc.). The `StorageBackend` interface is async (`Promise<>`). This means all 40+ fileIO functions and all their callers in `server.ts` must become async. This is a large diff with zero behavior change — it's sequenced as the first ticket to isolate risk.

**Concurrency note:** The sync-to-async migration is not purely mechanical. Changing functions to async yields to the event loop between `await` points, introducing potential interleaving for concurrent HTTP requests. Most fileIO functions are pure reads or pure writes and are unaffected. However, ~5 functions perform read-modify-write cycles (`updateEdgeStatus`, `bulkUpdateEdges`, `swapEdgeDirection`, `harvestAddVerdict`, `harvestUpdateSteelman`) — these read a file, modify the parsed object in memory, then write back. Concurrent requests could interleave between the read and write. A lightweight per-file write mutex (lock map keyed by file path) is required for these operations.

**Scope clarification:** This migration is entirely server-side. The React frontend is already fully async — it uses `fetch()` for REST calls (web mode) and IPC (Electron mode), both of which are asynchronous. The frontend is completely unaffected by the server's sync-to-async migration.

#### 2. STORAGE_MODE Environment Variable

```typescript
const backend = process.env.STORAGE_MODE === 'github-api'
  ? new GitHubAPIBackend(...)
  : new FilesystemBackend(...);
```

- Default: `github-api` in production (container), `filesystem` in development/Electron
- Enables zero-downtime rollback: change the env var, restart, done
- Both backends coexist in the codebase permanently

#### 3. Local File Cache (`/tmp/taxonomy-cache/`)

- Ephemeral SSD cache (survives process restart, not container restart)
- `manifest.json` tracks per-file SHAs and ETags
- Startup: if cached SHA matches GitHub main HEAD, serve entirely from cache (0 API calls)
- Polling: every 60s, check main HEAD SHA. On change, fetch only changed files via Compare API
- ETag support: `If-None-Match` headers avoid re-downloading unchanged files
- **Write-through caching only:** the cache is updated only after a successful 2xx response from the GitHub API. No optimistic updates — if a write fails, the cache remains consistent with the source of truth. The user sees a progress banner during the ~1-2s write latency, so there is no UX penalty.

#### 4. Session Branch Manager (Per-User Editing)

- No branch created until user makes first edit (lazy creation)
- Branch naming: `api-session/{userId}` (one per user, fully isolated)
- Commits batched via Git Trees API (4 API calls per save, regardless of file count):
  1. GET current branch SHA
  2. POST new tree with all changed files
  3. POST new commit pointing to tree
  4. PATCH branch ref to new commit
- Existing 2-second debounce batches rapid edits into single commits
- Token freshness check: before starting a batch commit, validate the installation token has >60s remaining; force early refresh if not (prevents mid-transaction auth failures)
- PR creation: just `POST /pulls` (branch is already on GitHub)

#### 5. Conflict File Consolidation

- Current: 1,244 individual conflict JSON files (~5.5 MB total)
- Problem: loading via Contents API = 1,244 API calls
- Solution: generate `_conflict-index.json` containing all conflicts in one file (1 API call)
- Generated weekly by existing `cluster-conflicts.yml` GitHub Actions workflow
- Individual files remain source of truth; index is a read-only optimization
- Writes still target individual files (so clustering workflow continues to work)

#### 6. Baked Fallback Data

- Container image build fetches current taxonomy snapshot from GitHub
- Baked into image at `/app/fallback-data/`
- If GitHub API is unreachable at startup: serve from fallback (read-only, banner with data age)
- Ensures the app is never completely down, even during GitHub outages

---

## Authentication

The system uses a **GitHub App** (not a personal access token) for API authentication:

1. Private key (PEM) stored in Azure Key Vault (accessed via managed identity)
2. Server mints a JWT (RS256, 9-minute TTL) from the PEM
3. JWT exchanged for an installation access token (1-hour TTL, auto-refreshed 5 minutes before expiry)
4. All API calls use: `Authorization: token {installation_token}`

This is already implemented in `githubAppAuth.ts` — no new auth code needed. The GitHub App has `contents: write` permission on the `ai-triad-data` repo.

Rate limit: 5,000 requests/hour per installation. Estimated usage: ~145/hour (60 polling + 10 startup + 10 reads + 60 writes + 5 listings). 97% headroom.

**Token lifecycle note:** The installation token has a 1-hour TTL and auto-refreshes 5 minutes before expiry. Multi-step operations (e.g., the 4-call batch commit) validate token freshness at the start of the transaction and force an early refresh if the token will expire within 60 seconds. This prevents mid-transaction auth failures.

---

## What Gets Deleted

| Component | Lines | Purpose | Replacement |
|-----------|-------|---------|-------------|
| `entrypoint.sh` | 93 | Background SMB copy + Node start | Direct `CMD ["node", "server.js"]` |
| `gitRepoStore.ts` | 1,371 | 4-phase git sync (commit, push, fetch, rebase) | Session Branch Manager + Compare API |
| `initDataRepo()` | ~50 | Clone to /tmp, move .git/ | Not needed (no local git) |
| `isCopyInProgress()` guards | ~9 endpoints | Gate operations during SMB copy | Not needed (no copy) |
| `.git-ready` marker | Protocol | Signal git init completion | Not needed |
| Azure Files resources | Bicep | Storage account, file share, volume mount | Not needed |
| `deploy.ps1 -SeedData` | ~65 | Populate Azure Files share | Not needed |

---

## Sync UI Changes

The app has a rich sync UI with 5 components: **SaveBar** (status badges), **UnsyncedChangesDrawer** (file list, diffs, PR/resync/discard actions), **RebaseConflictModal** (merge conflict resolution), **SyncDiagnosticsDialog** (full diagnostics + credential entry), and **GitProgressBanner** (operation progress with spinner/timer). All components are preserved — their data sources change from local git commands to GitHub API calls. The server endpoints return the same interface shapes; only the server-side implementation switches.

Current implementation uses local git commands. API-mode equivalents:

| Feature | Current (git) | Proposed (API) |
|---------|--------------|----------------|
| Unsynced count | `git status` | Compare API `ahead_by` |
| File list | `git diff --name-only` | Compare API `files[]` |
| Diff view | `git diff {file}` | Compare API `patch` field |
| Create PR | `git push` + POST /pulls | Just POST /pulls (branch already remote) |
| Pull updates | `git fetch` + `git rebase` | Merges API or branch reset |
| Divergence warning | (none) | Proactive banner when session branch falls behind main (yellow at 3+ commits, red at 10+) |
| Interactive rebase | 5 endpoints | Deferred — show conflict banner with GitHub link |

---

## Infrastructure

- **Hosting:** Azure Container Apps (scale 0-1 instances)
- **Auth:** GitHub + Google OAuth via Azure Easy Auth, server-side allowlist
- **Container image:** `ghcr.io/ai-rosetta-stone/taxonomy-editor:latest`
- **Secrets:** Azure Key Vault (GitHub App PEM, user BYOK API keys)
- **CI/CD:** GitHub Actions (build, test, deploy)
- **Process manager:** `tini` as PID 1 (zombie reaping for pty-broker.py subprocesses) — stays even after entrypoint.sh is deleted

---

## Rollback Plan

1. Set `STORAGE_MODE=filesystem` in container environment
2. Re-enable Azure Files in Bicep (git revert)
3. Re-seed data share (`deploy.ps1 -SeedData`)
4. Redeploy — zero data loss (all writes go to GitHub regardless of mode)

---

## Observability & Flight Recorder Integration

The system has an existing **flight recorder** — a ring buffer (3,000 events client-side, 2,000 server-side) that captures structured events and dumps to NDJSON on error or manual trigger (Ctrl+Alt+D). It already instruments all bridge API calls, AI operations, and debate engine events.

For the GitHub API-first migration, the flight recorder is extended with 18 new event types covering:
- **GitHub API calls** (`github.api.request/response/error/rate_limit`) — every REST call with endpoint, duration, rate limit headers, cache hit status
- **Cache operations** (`cache.hit/miss/invalidate/manifest.swap`) — cache coherency tracking with generation counters
- **Branch lifecycle** (`branch.create/commit/delete/divergence`) — session branch operations with correlation IDs
- **Sync events** (`sync.pr.create/update/merge/conflict/webhook`) — PR lifecycle and conflict detection

All events are also emitted as structured JSON to stdout for Azure Log Analytics. The `/health` endpoint exposes cache hit rate, rate limit remaining, active branches, and cache generation.

**Correlation:** All GitHub API calls within a batch commit share a `call_id` (UUID), enabling end-to-end tracing of a save operation from the initial write through the 4-step Trees API sequence.

## Consistency Model

The system is explicitly **eventually consistent**:
- Main branch freshness SLA: ≤60s (polling), ≤2s (with webhook acceleration)
- Session branches are strongly consistent relative to local writes (write-through cache)
- Cross-user edits are isolated by per-user branches; conflicts resolved at PR merge time
- No distributed transactions — batch commits either fully succeed or fully fail
- GitHub is the sole authoritative source of truth; the local cache is a subordinate replica
- Force pushes / history rewrites are detected (cached SHA returns 404) and trigger full cache invalidation

## Branch Lifecycle Governance

- **TTL:** 30-day inactivity limit; daily cleanup scan deletes stale branches
- **Quota:** Max 1 active branch per user; new edits resume existing branch
- **Divergence:** Auto-merge main at 20+ commits behind (via Merges API); if conflicts, block further saves until resolved
- **Orphan detection:** Scan for branches whose userId no longer maps to an active auth principal

## Webhook Acceleration

The existing HMAC-verified webhook endpoint (`POST /api/sync/webhook/github`) is reused in API mode. Push events to main trigger immediate cache invalidation + WebSocket notification to connected clients, reducing the stale window from 60s to ~2s. Polling continues as a correctness fallback if webhooks fail.

## Scaling Limits

The system operates well within GitHub API limits today (~2,000 files, ~145 API calls/hr). Known thresholds are documented with review triggers: Trees API truncates at 100,000 entries, Compare API degrades for >300 changed files, primary rate limit is 5,000/hr. If the repo exceeds 2 GB or 50,000 files, archive old data (debates, transcripts) to a separate repo.

---

## Identified Risks (from internal + external review)

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| 1 | Cache loss on container restart during GitHub outage → stale fallback data | HIGH | Banner with data age, consider persistent cache volume ($0.06/mo), daily image builds |
| 2 | Shared rate limit across container instances (5,000/hr shared) | MEDIUM | Structured logging, degrade at 500 remaining, cap replicas at 1 |
| 3 | Missing conflict index → fallback reads 1,244 files (25% of rate budget) | MEDIUM | Hard cap: return empty conflicts if index missing, never enumerate |
| 4 | In-flight edits lost during cutover from filesystem to API mode | MEDIUM | 7-day soak period, cutover checklist, user notification |
| 5 | PEM private key cached in process memory | MEDIUM | Key Vault only in production (never inline env var), minimal App permissions |
| 6 | Async interleaving on read-modify-write cycles (~5 functions) | MEDIUM | Per-file write mutex for affected operations |
| 7 | Optimistic cache updates diverge from GitHub on write failures | MEDIUM | Write-through caching only (update cache after 2xx, never optimistically) |
| 8 | Session branch diverges from main over days → massive merge conflicts | MEDIUM | Proactive divergence warning (yellow at 3+ commits behind, red at 10+) |
| 9 | Token expiry mid-batch-commit (4 API calls) | LOW | Validate >60s token remaining before starting batch, force early refresh |
| 10 | 5.5 MB conflict index memory pressure | LOW | Cache parsed object after first load |
| 11 | Sync-to-async migration regressions | LOW | Standalone PR, full test suite validation, per-file mutex for RMW cycles |

---

## Implementation Tickets (10 total)

| # | Ticket | Title | Owner | Blocked By |
|---|--------|-------|-------|------------|
| 1 | t/464 | StorageBackend interface + FilesystemBackend (sync-to-async migration) | Taxonomy Editor | — |
| 2 | t/465 | GitHubAPIBackend (Contents/Blobs/Trees API + cache) | Taxonomy Editor | t/464 |
| 3 | t/466 | Consolidate conflict files into _conflict-index.json | PowerShell | — |
| 4 | t/467 | Session Branch Manager (per-user branches, batch commits) | Taxonomy Editor | t/465 |
| 5 | t/468 | Wire STORAGE_MODE switch in server.ts | Taxonomy Editor | t/464, t/465 |
| 6 | t/469 | Sync UI in API mode (Compare API for diffs/unsynced) | Taxonomy Editor | t/467, t/468 |
| 7 | t/470 | Remove legacy git sync infrastructure | Taxonomy Editor | t/468, t/469 |
| 8 | t/471 | Bake taxonomy snapshot into container image (fallback) | Docker | t/465 |
| 9 | t/472 | Remove Azure Files from Bicep, simplify Dockerfile | Docker | t/468, t/470 |
| 10 | t/473 | Update deploy workflow, delete Azure Files, update docs | DevOps | t/472 |

**Critical path:** t/464 → t/465 → t/468 + t/467 (parallel) → t/469 → t/470 → t/472 → t/473
**Parallel work:** t/466 (conflicts), t/471 (fallback)

---

## Important Context for Reviewers

Before reviewing, note these frequently misunderstood aspects:

- **File sizes are small.** The 410 MB data repo is thousands of small files, not a few large ones. The largest single file is ~30 MB (embeddings). See the file size distribution table above. Streaming I/O is unnecessary — `Promise<string>` is appropriate for these sizes.
- **The async migration is server-side only.** The React frontend already uses async I/O (`fetch()` for REST, IPC for Electron). The sync-to-async migration only affects `fileIO.ts` and its callers in `server.ts`. The frontend is completely unaffected.
- **This is a low-concurrency app.** 2-5 academic researchers, not a public-facing API. Design decisions (per-file mutex vs distributed locks, single instance vs multi-instance coordination) are calibrated to this scale.
- **The app has two completely separate build targets.** Electron (desktop) and web (container). The `STORAGE_MODE` switch only affects the web server. Electron doesn't use `server.ts` at all — it reads from the local filesystem via the Electron main process.

## Questions for Reviewers

We invite feedback on any aspect of the plan. Some specific areas where outside perspective would be valuable:

1. **StorageBackend abstraction** — Is a 5-method interface sufficient, or are there I/O patterns we're missing? We've identified ~5 read-modify-write functions that need a per-file write mutex — are there other concurrency patterns we should guard against?

2. **GitHub API as a database** — We're using a git hosting service as a live data backend for a multi-user editing app. What failure modes or consistency issues should we anticipate? Is the 60-second polling interval appropriate, or should we consider webhooks/SSE for real-time sync?

3. **Session branch strategy** — One branch per user, lazy creation, batch commits via Trees API. Does this scale for 2-5 concurrent users? We've added divergence warnings (yellow at 3+ commits behind, red at 10+) — is this sufficient, or should we auto-merge main into session branches?

4. **Cache design** — Write-through cache on ephemeral `/tmp` with SHA-based invalidation. Is write-through the right choice over optimistic-with-rollback? Should we persist the manifest on a small volume from day one?

5. **Rate limit budget** — ~145/hr estimated against 5,000/hr limit (single instance). Are we missing any high-volume patterns? The conflict index hard cap prevents the worst burst scenario (1,244 reads) — are there others?

6. **Conflict resolution** — Interactive rebase is deferred (banner + GitHub link instead). Is this acceptable UX for academic researchers editing structured JSON, or is in-app conflict resolution essential?

7. **Rollback plan** — `STORAGE_MODE` env var switch with 7-day soak period before Azure Files deletion. Are there edge cases where the rollback isn't clean (e.g., data written via API that doesn't exist on the Azure Files volume)?

8. **Security** — GitHub App PEM in Key Vault, installation tokens with 1-hour TTL, token freshness validation before multi-step transactions. Are there additional hardening steps we should take?
