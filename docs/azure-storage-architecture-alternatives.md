# Azure Storage Architecture — Alternatives Investigation

## The Problem

The current storage architecture has required 10+ patches across 3 agents over 4 days:

```
Azure Files (SMB, /data-persistent)
  → entrypoint background copy → local /data
    → .git-ready marker protocol
      → isCopyInProgress() guards on 9 endpoints
        → retry loops (12 × 15s)
          → stale lock cleanup
            → git safe.directory config
```

Every layer was added to work around Azure Files SMB limitations: slow I/O (5-25ms/op), empty directories dropped on copy, lock files persisting across mounts, race conditions between copy and git operations.

**Root cause:** We're using a file-share designed for shared document storage as a git-aware application data layer. SMB and git are fundamentally incompatible — git expects POSIX semantics (symlinks, file modes, atomic renames) that SMB doesn't provide.

---

## Data Profile

| Data Type | Size | Files | Needed At Startup | Editable |
|-----------|------|-------|-------------------|----------|
| Taxonomy (3 POVs) | 2.4 MB | 3 | Yes (Phase 1+2) | Yes |
| Situations | 775 KB | 1 | Yes (Phase 2) | Yes |
| Edges | 7.5 MB | 1 | Yes (Phase 2) | Yes |
| Embeddings | 34 MB | 1 | Yes (Phase 2) | Auto |
| Conflicts | 5.5 MB | 1,244 | Yes (Phase 2) | Yes |
| Policy actions | 264 KB | 1 | Yes (Phase 2) | Yes |
| **Startup total** | **~50 MB** | **~1,250** | | |
| Debates | 750 MB | 373 | No (on demand) | Yes |
| Sources | 991 MB | 1,261 | No (lazy) | No |
| Summaries | 14 MB | 452 | No (lazy) | No |
| **Total repo** | **~3 GB** | **~3,300** | | |

Key insight: **only 50 MB is needed at startup**. The other 2.95 GB (debates + sources + summaries) loads on demand.

---

## Requirements

1. **See GitHub updates** — taxonomy changes pushed to `main` must be visible in the app
2. **Branch + PR** — edits create a branch and submit a pull request
3. **Fast startup** — app interactive within seconds, not minutes

---

## Option A: GitHub API-First (Recommended)

**Eliminate git and Azure Files entirely for the data path.** Use the GitHub API to read and write data, with a local cache for performance.

### Architecture

```
GitHub (AI-Rosetta-Stone/ai-triad-data, main branch)
  ↕ GitHub Contents API (authenticated via GitHub App)
Server (Node.js)
  ↕ In-memory cache + local /tmp file cache
Renderer (React)
```

### Read Path (Startup)

```
App starts → health check passes immediately (no data dependency)
  → Fetch taxonomy manifest (1 API call: GET /repos/.../contents/taxonomy/Origin)
  → Parallel fetch 7 taxonomy files via Contents API (~50 MB, 7 calls)
  → Cache to /tmp/taxonomy-cache/ (local SSD, survives process restart but not container restart)
  → App interactive in 3-5 seconds
```

For files >100 MB (embeddings at 34 MB is fine, but future-proofing): use the Git Blobs API which handles any size.

### Write Path (Edits)

```
User saves taxonomy edit
  → Server creates branch: PUT /repos/.../git/refs (if not exists)
  → Server updates file: PUT /repos/.../contents/taxonomy/Origin/{file}
    (base64-encoded content, SHA of previous version for conflict detection)
  → Server creates/updates PR: POST /repos/.../pulls
  → User sees "Changes saved to branch web-session/{user}, PR #N open"
```

No local git binary needed. No `.git/` directory. No SMB mount. No lock files.

### Update Detection

```
Periodic poll (every 60s): GET /repos/.../commits/main (1 API call)
  → Compare SHA with cached version
  → If changed: re-fetch only modified files (GET /repos/.../compare/{old}...{new} for file list)
  → Incremental cache update
```

Or: GitHub webhook → `/api/webhook/push` → invalidate cache. More responsive but requires webhook configuration.

### Lazy Data (Debates, Sources)

```
User opens debate → GET /repos/.../contents/debates/debate-{id}.json (single API call)
  → Cache locally for session duration
  → On save: PUT to branch via Contents API

User views source → GET /repos/.../contents/sources/{id}/snapshot.md
  → Read-only, cache aggressively
```

### Rate Limits

GitHub App installation tokens: **5,000 requests/hour**.

Typical usage:
- Startup: ~10 calls (manifest + 7 taxonomy files + policy + cruxes)
- Per edit: ~3 calls (create/update file + update PR)
- Polling: 60 calls/hour (1/minute)
- Lazy loads: ~5-10 calls/hour (debates, sources)

**Total: ~100-200 calls/hour** — well within 5,000 limit.

### Pros
- **Instant startup** — no SMB mount, no copy, no git. Fetch 50 MB via HTTPS in 3-5s
- **No git binary** — eliminates all git-related bugs (lock files, empty dirs, safe.directory, broken packs)
- **No Azure Files** — eliminates the entire SMB layer and its $3-5/month cost
- **Built-in conflict detection** — Contents API requires SHA for updates, rejects stale writes
- **Atomic operations** — each API call is atomic, no partial writes
- **Works on scale-to-zero** — container can restart from scratch in seconds
- **Simpler Dockerfile** — no git, no entrypoint copy, no Azure Files mount

### Cons
- **Network dependency at startup** — if GitHub API is down, app can't start (mitigate: cache last-known-good in container image or Azure Blob)
- **Large file handling** — embeddings.json (34 MB) needs Git Blobs API, not Contents API (100 MB limit on Contents)
- **Conflict files** — 1,244 individual files need either batch fetch or a consolidated index
- **No offline editing** — all writes go through GitHub API (but we're a cloud app, this is fine)

### Migration Path

1. Create `lib/server/githubDataStore.ts` — replaces `fileIO.ts` for data operations
2. Implement read/write/list via GitHub Contents API using existing `githubAppAuth.ts` credentials
3. Add `/tmp/taxonomy-cache/` with ETag-based cache invalidation
4. Remove Azure Files mount from Bicep
5. Remove entrypoint copy, `.git-ready` marker, `isCopyInProgress()` guards
6. Simplify Dockerfile (no git binary needed)

---

## Option B: Git Sparse Checkout at Startup

**Clone only what's needed, directly to local disk.** No Azure Files.

### Architecture

```
Container starts
  → git clone --filter=blob:none --depth=1 --sparse → /data (.git = 300KB)
  → git sparse-checkout set taxonomy/ conflicts/ → fetch ~50 MB
  → App starts from local /data (SSD speed)
  → Lazy: git sparse-checkout add debates/{id} sources/{id} on demand
```

### Timing

- Blobless clone: ~2s (300 KB .git metadata)
- Sparse checkout of taxonomy/+conflicts/: ~5-10s (50 MB over HTTPS)
- **Total startup: ~10-15s** — within the 300s startup probe budget

### Pros
- Standard git workflow (commit, push, branch, PR)
- Familiar tooling
- Only downloads what's needed

### Cons
- Still needs git binary in container
- Sparse checkout is a git power feature — fragile, poorly documented
- `git sparse-checkout add` for individual debates is clunky
- Network required at startup (same as Option A)
- Container restart = full re-clone (no persistence)
- Merge conflicts require git CLI handling

---

## Option C: Azure Blob Storage + GitHub Sync

**Replace Azure Files with Azure Blob Storage** (faster, cheaper, REST-native).

### Architecture

```
GitHub push → GitHub Action → copies changed files to Azure Blob Storage
Container reads from Blob Storage via REST API
Writes go through GitHub API (same as Option A)
```

### Pros
- Blob Storage is faster than Files for read-heavy workloads
- REST-native (no SMB)
- Can be CDN-fronted for global distribution

### Cons
- Adds another service (Blob Storage + GitHub Action sync)
- Two sources of truth (GitHub + Blob) — sync can drift
- Write path still needs GitHub API
- More infrastructure to maintain

---

## Recommendation: Option A (GitHub API-First)

Option A is the clear winner for our use case:

| Criterion | Current (SMB+git) | A: GitHub API | B: Sparse Clone | C: Blob+Sync |
|-----------|-------------------|---------------|-----------------|--------------|
| Startup time | 30-60s (copy) | **3-5s** | 10-15s | 5-10s |
| Complexity | Very high (10+ patches) | **Low** | Medium | High |
| Azure cost | $3-5/mo (Files) | **$0** | $0 | $1-3/mo (Blob) |
| Git dependency | Yes (fragile on SMB) | **No** | Yes | No |
| Conflict handling | Manual (git merge) | **Built-in** (SHA check) | Manual (git) | API-based |
| Scale-to-zero | Slow (copy on restart) | **Instant** | Moderate (clone) | Fast |
| Offline editing | No (needs SMB) | **No** (needs API) | No (needs clone) | No |

**The key insight:** We don't need a local git repository at all. The GitHub API provides everything we need — read files, write files, create branches, submit PRs — without any of the SMB/git/copy infrastructure that's been causing problems.

### Implementation Effort

| Task | Effort | Owner |
|------|--------|-------|
| `githubDataStore.ts` — GitHub API data layer | Medium | Shared Lib |
| Cache layer with ETag invalidation | Small | Shared Lib |
| Consolidate conflict files into single index | Small | PowerShell |
| Wire new data layer into server.ts | Medium | Taxonomy Editor |
| Remove Azure Files from Bicep | Small | DevOps |
| Remove entrypoint copy + git init + guards | Small | DevOps |
| Update data-flow-azure.md | Small | Tech Lead |

### Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| GitHub API down at startup | Cache last-known taxonomy in container image (build step) |
| Rate limit exceeded | 5,000/hr is 50x our expected usage; add exponential backoff |
| Large embeddings file (34 MB) | Use Git Blobs API (no size limit) or cache in container image |
| 1,244 conflict files | Pre-consolidate into `conflicts-index.json` (single file, ~5.5 MB) |
| Network latency | ETag caching — after first load, conditional GET returns 304 (no body) |

---

## Next Steps

1. **Get user approval** on Option A
2. Create implementation tickets (5-6 tickets, ~1 week of work)
3. Build and test `githubDataStore.ts` against live GitHub API
4. Parallel deploy: run new API-based path alongside old SMB path for validation
5. Cut over: remove Azure Files, simplify Dockerfile and entrypoint
