# Infrastructure & Deployment — High-Level Design

**Status:** Living document  
**Last updated:** 2026-05-17  
**Author:** Jeffrey Snover  
**Audience:** Engineers and operators who need to understand the platform's CI/CD, containerization, cloud deployment, and operational model.

---

## 1. Problem Statement

The AI Triad platform has multiple deployment targets: researchers running locally on Windows/macOS/Linux, a cloud-hosted instance on Azure for shared access, and CI pipelines that must validate both PowerShell and TypeScript code. Each target has different requirements — desktop needs native installers, cloud needs containerization, CI needs reproducible test environments.

The infrastructure must support all three without forcing contributors to understand the full deployment surface. A researcher who only uses the PowerShell module shouldn't need Docker; a cloud operator shouldn't need to understand Pester tests.

## 2. Goals and Non-Goals

### Goals

- **G1:** Automated testing on every push/PR (PowerShell + TypeScript)
- **G2:** One-command release for all platforms (macOS, Windows, Linux desktop + container image)
- **G3:** Cloud deployment with zero infrastructure management (serverless containers)
- **G4:** BYOK model — platform never holds shared API keys
- **G5:** Data access via GitHub REST API with local SSD cache (no persistent volume needed)
- **G6:** Optional authentication (anonymous, Google OAuth, GitHub OAuth)

### Non-Goals

- **NG1:** Multi-region deployment — single Azure region is sufficient for research team
- **NG2:** Auto-scaling under load — research workload is single-digit concurrent users
- **NG3:** Kubernetes — Container Apps provides sufficient orchestration
- **NG4:** Secrets rotation automation — manual key management via Key Vault is adequate
- **NG5:** Blue-green or canary deployments — single-instance rolling updates are acceptable

## 3. CI/CD Pipeline Architecture

### 3.1 Pipeline Map

```
Push/PR to main
    │
    ├─► ci.yml ─────────────────────────────────────────┐
    │   ├─ test-powershell (Ubuntu)                     │
    │   │  └─ Pester tests → Build module → Validate   │
    │   └─ test-electron (Ubuntu)                       │
    │      └─ npm ci → tsc check → npm run build        │
    │                                                    │
Tag v*                                                   │
    │                                                    │
    ├─► release.yml ────────────────────────────────────┐│
    │   ├─ resolve-version (check PSGallery)            ││
    │   ├─ test (Pester)                                ││
    │   ├─ build-ps-module                              ││
    │   ├─ build-electron-mac                           ││
    │   ├─ build-electron-win                           ││
    │   ├─ build-electron-linux                         ││
    │   └─ create-release (GitHub release + artifacts)  ││
    │                                                    ││
    ├─► container.yml ──────────────────────────────────┘│
    │   └─ Docker multi-platform build (amd64, arm64)    │
    │   └─ Push to GHCR                                  │
    │                                                    │
Manual trigger                                           │
    │                                                    │
    └─► deploy-azure.yml ───────────────────────────────┘
        └─ Azure Container Apps deployment
```

### 3.2 CI Test Matrix

**test-powershell** job:

```
1. Checkout ai-triad-research (code)
2. Checkout ai-triad-data (shallow clone, separate path)
3. Symlink data to ../ai-triad-data
4. Install Pester module
5. Invoke-Pester ./tests/
6. Build-Module.ps1 -Clean
7. Test-ModuleManifest ./build/AITriad/AITriad.psd1
```

The data repo checkout is necessary because tests exercise taxonomy queries, summarization, and conflict detection against real data. Shallow clone keeps checkout time manageable (~50 MB vs. 410 MB full clone).

**test-electron** job:

```
1. Setup Node 22
2. cd taxonomy-editor && npm ci
3. npx tsc --noEmit -p tsconfig.main.json
4. npm run build
```

TypeScript check validates types across the full codebase. The build step catches Vite configuration issues and missing dependencies.

### 3.3 Release Pipeline

Triggered by pushing a `v*` tag (e.g., `v0.8.0`):

```
resolve-version ──► test ──► build-ps-module ──┐
                                                ├──► create-release
                    build-electron-mac ─────────┤
                    build-electron-win ─────────┤
                    build-electron-linux ────────┘
```

**resolve-version** checks PSGallery for the current published version. If the tag version matches an already-published version, it auto-bumps the patch number to avoid collisions.

**create-release** downloads all build artifacts and creates a GitHub release with auto-generated release notes (derived from commit messages since the last tag).

## 4. Container Architecture

### 4.1 Build Strategy

Two-stage multi-platform build (amd64 + arm64):

```dockerfile
# Stage 1: Builder
FROM node:22-bookworm-slim AS builder
# Install build deps (python3, make, g++ for node-gyp native modules)
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build:container
# Output: dist/server/ (Express app) + dist/renderer/ (Vite bundle)

# Stage 2: Runtime
FROM ghcr.io/ai-rosetta-stone/ai-triad-base:latest
# Base image: Python 3.11, Node 22, pandoc, ffmpeg, ghostscript
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
USER aitriad
EXPOSE 7862
HEALTHCHECK CMD curl -f http://localhost:7862/health
CMD ["node", "dist/server/index.js"]
```

### 4.2 Base Image

The base image (`deploy/azure/Dockerfile.base`) pre-installs heavy dependencies:

| Component | Purpose | Size Impact |
|---|---|---|
| Python 3.11 | Embedding computation (sentence-transformers) | ~200 MB |
| Node 22 | Application runtime | ~100 MB |
| pandoc | Document conversion (PDF/DOCX → Markdown) | ~50 MB |
| ffmpeg | Audio generation for debate transcripts | ~80 MB |
| ghostscript | PDF processing | ~30 MB |

Building the base image separately (via `base-image.yml`) means application builds don't reinstall these dependencies, reducing build time from ~15 minutes to ~3 minutes.

### 4.3 Runtime Configuration

| Environment Variable | Purpose | Default |
|---|---|---|
| `AI_TRIAD_DATA_ROOT` | Cache directory path | `/tmp/taxonomy-cache` |
| `STORAGE_MODE` | Data backend (`github-api` or `filesystem`) | `github-api` in container, `filesystem` in Electron |
| `ALLOWED_ORIGINS` | CORS origins | Deployment FQDN |
| `DEPLOY_SHA` | Git commit for traceability | Set at deploy time |
| `GITHUB_REPO` | Data repo (owner/name) | `AI-Rosetta-Stone/ai-triad-data` |
| `GITHUB_APP_ID` | GitHub App for API auth | — |
| `GITHUB_APP_INSTALLATION_ID` | GitHub App installation | — |
| `GITHUB_APP_PRIVATE_KEY_SECRET_NAME` | Key Vault secret name for PEM | — |

## 5. Azure Deployment

### 5.1 Infrastructure (Bicep)

`deploy/azure/main.bicep` defines the complete infrastructure:

```
┌────────────────────────────────────────────────────────────┐
│ Resource Group                                              │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Container Apps Environment                            │  │
│  │  ┌────────────────────────────────────────────────┐  │  │
│  │  │ Container App (production)                     │  │  │
│  │  │  ├─ Image: ghcr.io/ai-rosetta-stone/taxonomy-editor   │  │  │
│  │  │  ├─ Port: 7862                                 │  │  │
│  │  │  ├─ Managed Identity → Key Vault access        │  │  │
│  │  │  ├─ Data: GitHub REST API → /tmp cache         │  │  │
│  │  │  └─ Scale: 1-5 replicas                        │  │  │
│  │  ├────────────────────────────────────────────────┤  │  │
│  │  │ Container App (staging)                        │  │  │
│  │  │  └─ Scale: 0-1 replicas (scale-to-zero)       │  │  │
│  │  └────────────────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌───────────────────────────┐  ┌──────────────────────┐  │
│  │ Key Vault                 │  │ Log Analytics        │  │
│  │  ├─ GitHub App PEM key    │  │  ├─ Container logs   │  │
│  │  ├─ OAuth client secrets  │  │  ├─ KV audit logs    │  │
│  │  ├─ BYOK user API keys    │  │  └─ Alert rules (7)  │  │
│  │  └─ GHCR password         │  └──────────────────────┘  │
│  └───────────────────────────┘                             │
│                                                             │
│  GitHub REST API (AI-Rosetta-Stone/ai-triad-data)                   │
│  └─ Contents/Trees/Blobs APIs via GitHub App auth           │
└────────────────────────────────────────────────────────────┘
```

**Data architecture (GitHub API-first):** The container has no persistent volume. Data is read from and written to `AI-Rosetta-Stone/ai-triad-data` via the GitHub REST API, authenticated with a GitHub App (PEM in Key Vault). A local SSD cache (`/tmp/taxonomy-cache/`) accelerates reads. On GitHub outage, the app serves from a baked taxonomy snapshot in the container image (read-only mode). Startup time: 3-5 seconds.

### 5.2 BYOK (Bring Your Own Key) Model

The platform never holds shared API keys. Users manage their own keys:

```
User enters API key in UI
    │
    ▼
Client-side AES-256-GCM encryption
    │
    ▼
Encrypted key stored via StorageBackend (session branch in API mode, local disk in filesystem mode)
    │
    ▼
At inference time:
    ├─ Decrypt key in memory
    ├─ Send to AI backend
    └─ Key never logged or persisted in plaintext
```

This model means:
- **No shared API costs** — each user pays for their own usage
- **No key rotation burden** — users manage their own keys
- **No credential exposure risk** — the platform stores only encrypted blobs
- **Per-user backend choice** — one user can use Gemini while another uses Claude

### 5.3 Authentication Modes

Three configurable modes via deployment parameters:

| Mode | Behavior | Use Case |
|---|---|---|
| `authDisabled = true` | No login UI, anonymous access only | Personal instance, local testing |
| `authOptional = true` | Login page with "continue anonymously" option | Shared instance with optional identity |
| Neither | Login required, no anonymous access | Restricted access, audit trail needed |

OAuth providers (optional):
- **Google** — configured via `googleClientId` / `googleClientSecret`
- **GitHub** — configured via `githubClientId` / `githubClientSecret`

Secrets stored in Azure Key Vault, accessed via managed identity (no hardcoded credentials in the container).

### 5.4 Data Architecture (GitHub API-First)

The container reads and writes `ai-triad-data` directly via the GitHub REST API. There is no persistent volume, no git clone, and no Azure Files mount.

#### Data Flow

```
GitHub (AI-Rosetta-Stone/ai-triad-data, main branch)
    │
    ▼
GitHubAPIBackend ── GitHub Contents/Trees/Blobs APIs
    │                  └── Auth: GitHub App installation token (Key Vault PEM)
    ▼
Local SSD Cache (/tmp/taxonomy-cache/)
    │   ├── manifest.json (SHA + ETag per file, generation counter)
    │   ├── taxonomy/Origin/*.json (cached file contents)
    │   └── conflicts/_conflict-index.json (bulk-loaded, 1 API call)
    ▼
fileIO.ts domain functions (40+ functions, unchanged)
    │
    ▼
Express REST API → React SPA
```

#### Container Startup Sequence

```
Container starts
  → CMD: node server.js (no entrypoint.sh, no background copy)
  → tini as PID 1 (zombie reaping for pty-broker.py subprocesses)
  → Health check passes immediately (no data dependency)
  → GitHubAPIBackend.initialize():
    → Read GitHub App installation token from Key Vault
    → Check /tmp/taxonomy-cache/manifest.json
    → If fresh (SHA matches main HEAD): serve from cache (0 API calls, <100ms)
    → If stale/missing: fetch changed files via Compare API (2-10 calls, 3-5s)
  → App interactive in 3-5 seconds
```

#### GitHub App Authentication

All API calls use a GitHub App (not personal access tokens):

1. Private key (PEM) stored in Azure Key Vault, accessed via managed identity
2. Server mints a JWT (RS256, 9-minute TTL) from the PEM
3. JWT exchanged for an installation access token (1-hour TTL)
4. Token auto-refreshes 5 minutes before expiry
5. Multi-step operations validate >60s token remaining before starting

Rate limit: 5,000 requests/hour per installation. Estimated usage: ~145/hour (97% headroom).

#### Caching Architecture

**Write-through cache** — the cache is updated only after a confirmed 2xx from GitHub. No optimistic updates.

| Mechanism | Detail |
|---|---|
| **Manifest** | `manifest.json` tracks per-file SHA, ETag, cached timestamp. Atomic swap via `.tmp` + rename. |
| **Generation counter** | Monotonic integer detects stale reads across concurrent requests. |
| **Polling** | Every 60s, compare cached SHA with `GET /repos/.../commits/main`. On change, fetch only changed files via Compare API. |
| **Webhook acceleration** | Push events to main trigger immediate cache invalidation + WebSocket notification to clients (stale window: ~2s vs. 60s polling-only). |
| **ETag support** | `If-None-Match` headers on API calls. GitHub returns 304 (no body) if unchanged — saves bandwidth. |
| **Coherency probe** | 1% of cache hits are asynchronously verified against GitHub. Violations trigger full cache invalidation. |
| **Force-push detection** | If a cached SHA returns 404/409 from Compare API, entire cache is invalidated and re-fetched. |

**Session overlays:** Per-user cache layers track files modified on session branches. User A's edits are invisible to User B until merged to main.

#### Session Branch Manager

- No branch created until first edit (lazy creation)
- Branch naming: `api-session/{sanitizedUserId}` (one per user)
- Commits batched via Git Trees API (4 API calls per save, regardless of file count)
- Per-user commit mutex serializes concurrent saves from multi-tab sessions
- Divergence warning: yellow at 3+ commits behind main, red at 10+
- Auto-merge main at 20+ commits behind (via Merges API)
- Stale branch cleanup: daily GitHub Actions workflow deletes branches inactive >30 days

#### Resilience

| Feature | Detail |
|---|---|
| **Baked fallback data** | Container image includes a last-known-good taxonomy snapshot (`/app/fallback-data/`). If GitHub is unreachable at startup, serves read-only with a banner showing data age. |
| **Adaptive circuit breaker** | After 5 consecutive GitHub API failures → open (fallback mode, writes disabled). Probe on exponential schedule (30s→1m→2m→5m cap). On success → immediately closed. |
| **Rate limit degradation** | Below 1,000 remaining: warning logged. Below 500: polling disabled, serve from cache only, `degraded` health status. |
| **SIGUSR2 emergency dump** | When the event loop is blocked, `kill -SIGUSR2 $(pgrep node)` triggers a flight recorder dump to stderr (bypasses Express). |

#### Observability

**Flight recorder:** Ring buffer (2,000 events server-side) with 18+ event types for GitHub API operations:

| Category | Events |
|---|---|
| GitHub API | `github.api.request`, `response`, `error`, `rate_limit` |
| Cache | `cache.hit`, `miss`, `invalidate`, `manifest.swap` |
| Branch lifecycle | `branch.create`, `commit`, `delete`, `divergence` |
| Sync | `sync.pr.create`, `update`, `merge`, `conflict`, `webhook` |
| Storage | `storage.mode`, `storage.fallback` |

All events are also emitted as structured JSON to stdout for Azure Log Analytics.

**Azure Monitor alerts (7 rules):**

| Alert | Condition | Severity |
|---|---|---|
| Rate limit warning | Remaining < 1,000 for 5 min | Warning |
| Rate limit critical | Remaining < 500 or any 429 response | Critical |
| Cache degraded | Hit rate < 85% over 5 min | Warning |
| Branch divergence | Session branch > 10 commits behind main | Warning |
| API error spike | > 5 `github.api.error` events in 5 min | Critical |
| Fallback active | `storage.fallbackActive` = true for > 5 min | Critical |
| Container restart storm | > 3 restarts in 15 min | Critical |

**Health endpoint** (`GET /health`) includes GitHub API stats, cache state, and flight recorder stats:

```json
{
  "status": "ok",
  "github": { "rateLimit": { "remaining": 4850, "limit": 5000 }, "cacheHitRate": 0.95, "activeBranches": 2 },
  "storage": { "mode": "github-api", "mainSha": "abc1234", "cacheFileCount": 15, "fallbackActive": false },
  "flightRecorder": { "eventsTotal": 1234, "eventsRetained": 1000 }
}
```

#### Sources Separation

Source documents (PDFs, DOCX, HTML) live in a separate `ai-triad-sources` repo, accessible only from local filesystem (Electron mode). Summaries (derived from sources) remain in `ai-triad-data` and are available in web mode. The UI shows summaries and metadata but not original documents when running in API mode.

For the complete technical specification, see [GitHub API-First Implementation Plan](./github-api-first-implementation.md).

## 6. Version Management

### 6.1 Release Process

```
1. Update version in 3 files:
   ├─ scripts/AITriad/AITriad.psd1      (source manifest)
   ├─ build/AITriad/AITriad.psd1        (build via Build-Module.ps1 -Clean)
   └─ AGENTS.md                          (documentation reference)

2. Commit: "chore: bump version to 0.x.y"

3. Tag: git tag v0.x.y && git push origin v0.x.y

4. Automated:
   ├─ release.yml builds all artifacts
   └─ container.yml builds and pushes Docker image

5. Manual: trigger deploy-azure.yml (workflow_dispatch) with the built commit —
   `-f sha=<commit>` (t/3679 deploy-by-digest; `sha` is required, no `:latest` path)
```

### 6.2 Version Consistency Checks

The CI pipeline validates version consistency:
- `Test-ModuleManifest` ensures `AITriad.psd1` is well-formed
- Release pipeline's `resolve-version` step checks PSGallery for conflicts
- Manual verification: source manifest version must match build manifest version

## 7. Supporting Workflows

| Workflow | Trigger | Purpose |
|---|---|---|
| `batch-summarize.yml` | Schedule or manual | Re-summarize documents when taxonomy changes (triggered by `TAXONOMY_VERSION` bump) |
| `cluster-conflicts.yml` | Manual | Cluster raw conflicts into deduplicated consolidated set |
| `taxonomy-version-reminder.yml` | Daily schedule | Reminds team to check taxonomy health metrics |
| `base-image.yml` | Manual | Rebuild base runtime image with updated system packages |

## 8. Design Decisions and Trade-offs

### D1: Azure Container Apps Over App Service / AKS

**Chosen:** Azure Container Apps (serverless containers).

**Why:** Scale-to-zero eliminates compute costs during idle periods (the research team doesn't use the cloud instance 24/7). Container Apps provides managed HTTPS, custom domains, and volume mounts without the operational overhead of Kubernetes. App Service doesn't support scale-to-zero for containers.

**Trade-off accepted:** Cold start latency (~10–15 seconds) when the app scales from zero. For a research tool with single-digit concurrent users, this is acceptable. WebSocket connections (used by the terminal) may be interrupted by scale events.

**Alternative considered:** AKS (Azure Kubernetes Service). Rejected as over-provisioned for a single-container, single-user workload. The operational burden of managing a Kubernetes cluster outweighs any orchestration benefits at this scale.

### D2: BYOK Over Shared API Keys

**Chosen:** Users bring their own AI API keys.

**Why:** Shared keys create cost management problems (who pays for API usage?), rate limit conflicts (multiple users sharing a single key), and credential rotation responsibilities. BYOK eliminates all three. Each user is responsible for their own costs, rate limits, and key management.

**Trade-off accepted:** Higher friction for new users — they must obtain and configure API keys before using AI features. `Register-AIBackend` provides guided setup, and the UI has a key configuration flow, but it's still an extra step compared to "just works."

### D3: Bicep Over Terraform

**Chosen:** Azure Bicep for infrastructure-as-code.

**Why:** The deployment is Azure-only. Bicep is Azure-native, requires no additional tooling (ships with Azure CLI), and produces ARM templates directly. Terraform would add a dependency (HashiCorp provider) and state management complexity for a single-cloud deployment.

**Trade-off accepted:** If the platform ever deploys to AWS or GCP, Bicep won't help. At current scale and plans, Azure-only is sufficient.

### D4: Separate Base Image

**Chosen:** Pre-built base image (`ai-triad-base`) with heavy dependencies.

**Why:** Python 3.11, pandoc, ffmpeg, and ghostscript take 5–10 minutes to install. Baking them into a base image that changes rarely (rebuilt via manual `base-image.yml` trigger) means application builds are fast (~3 minutes). The base image changes only when system-level dependencies are added or updated.

**Trade-off accepted:** Base image staleness — if a security patch affects Python or pandoc, the base image must be manually rebuilt. The `base-image.yml` workflow exists for this purpose, but there's no automated trigger on upstream CVEs.

### D5: GitHub Actions Over Azure DevOps

**Chosen:** GitHub Actions for all CI/CD.

**Why:** The repository is hosted on GitHub. Actions provides native integration (PR checks, release creation, GHCR push) without cross-platform credential management. The team's existing workflow is GitHub-centric (issues, PRs, discussions).

**Trade-off accepted:** GitHub Actions' runner fleet is limited (2-core Ubuntu runners for free tier). Build times for multi-platform Electron builds are ~15 minutes. Self-hosted runners could reduce this but add maintenance overhead.

### D6: GitHub API-First Over Azure Files / Blob Storage

**Chosen:** GitHub REST API with local SSD cache, replacing the previous Azure Files SMB architecture.

**Why:** Azure Files SMB had multiple issues: slow startup (30-60s for SMB copy + git init), SMB corruption of `.git/` directories, copy guard complexity (9+ endpoints checking `isCopyInProgress()`), and intermittent git init failures. The GitHub API-First approach eliminates all of these — startup is 3-5s, there's no local git, and the `StorageBackend` abstraction keeps `fileIO.ts` domain logic unchanged.

**Trade-off accepted:** Eventually consistent reads (≤60s stale window with polling, ≤2s with webhooks). Write latency is ~1-2s per save (GitHub API round-trip) vs. near-instant with local filesystem. GitHub rate limits (5,000/hr) constrain burst operations, though current usage (~145/hr) has 97% headroom. Container restart loses the ephemeral cache (re-fetched in 3-5s).

**Previous architecture (deprecated):** Azure Files SMB mount → `entrypoint.sh` (93 lines, background copy) → `gitRepoStore.ts` (1,371 lines, 4-phase git sync) → `.git-ready` marker protocol. All removed.

### D7: Optional Authentication

**Chosen:** Three auth modes (disabled, optional, required) configurable at deploy time.

**Why:** Different deployment contexts need different auth postures. A personal instance on a home network doesn't need authentication. A shared instance for a research team needs optional login (some users want attribution, others want anonymity). An institutional deployment might require login for compliance.

**Trade-off accepted:** Anonymous mode means debate transcripts and taxonomy edits have no attribution. The `authorized-users.json` file gates access but doesn't enforce identity for every action.

## 9. Operational Runbook

### Health Monitoring

| Check | How | Frequency |
|---|---|---|
| Container health | `GET /health` (liveness probe — includes GitHub API stats, cache state) | Every 30 seconds |
| Application logs | Azure Log Analytics → container stdout (structured JSON) | Continuous |
| GitHub API rate limit | `GET /health` → `github.rateLimit.remaining` | Per-request |
| Cache coherency | Automatic 1% sampling probe on cache hits | Continuous |
| API key validity | First AI call fails with 401 → user-visible error | Per-request |
| Azure Monitor alerts | 7 alert rules (rate limit, cache, divergence, errors, fallback, restarts) | Continuous |

### Common Operations

| Operation | Command/Action |
|---|---|
| Deploy new version | `gh workflow run deploy-azure.yml -f environment=production -f sha=<commit>` (t/3679: `sha` required, pins by digest) |
| View container logs | Azure Portal → Container Apps → Log stream |
| Rebuild base image | `gh workflow run base-image.yml` |
| Force restart | Azure Portal → Container Apps → Restart |
| Force cache refresh | SyncDiagnosticsDialog → "Force cache refresh" button |
| Emergency flight recorder dump | `az containerapp exec ... --command "kill -SIGUSR2 $(pgrep node)"` |
| Check GitHub API status | `GET /health` → `github` and `storage` sections |

## 10. Risks and Open Questions

| Risk | Severity | Mitigation |
|---|---|---|
| **Cache loss on container restart during GitHub outage** | HIGH | Baked fallback data in image, banner with data age, daily image builds for fresh snapshots |
| **GitHub API rate limit exhaustion** | MEDIUM | Degraded mode at <500 remaining (disable polling, cache-only). Structured logging. Cap replicas. |
| **Missing conflict index → 1,244 API calls** | MEDIUM | Hard cap: return empty conflicts if `_conflict-index.json` missing, never enumerate individual files |
| **Session branch divergence** | MEDIUM | Proactive warnings (yellow at 3+, red at 10+ behind). Auto-merge main at 20+ commits. |
| **Base image staleness** | MEDIUM | Manual rebuild via `base-image.yml`; consider automated CVE scanning |
| **Cold start latency** | LOW | ~10-15s delay from scale-to-zero. App data loads in 3-5s. Acceptable for research use. |
| **Single-region** | LOW | Outage = complete downtime. Acceptable for research team. |
| **GHCR package visibility** | LOW | Anonymous pulls — `ghcr.io/ai-rosetta-stone/taxonomy-editor` must stay public (visibility flip = outage). See `deploy/azure/runbooks/production-release.md` Registry Auth section. |

## 11. Glossary

| Term | Definition |
|---|---|
| **BYOK** | Bring Your Own Key — users supply their own AI API keys |
| **Circuit breaker** | Resilience pattern: after N consecutive failures, stop calling the failing service and serve from fallback until a probe succeeds |
| **Flight recorder** | Ring buffer of structured events for post-mortem debugging. Dumps to NDJSON on error or manual trigger. |
| **GHCR** | GitHub Container Registry — hosts Docker images |
| **GitHub App** | Machine identity for GitHub API access. Uses PEM key → JWT → installation token flow. |
| **Bicep** | Azure-native infrastructure-as-code language |
| **Container Apps** | Azure serverless container hosting with scale-to-zero |
| **Managed Identity** | Azure-assigned identity for resource-to-resource auth (no credentials in code) |
| **Scale-to-zero** | Container stops when idle; no compute costs during inactivity |
| **Cold start** | Delay when a stopped container starts in response to the first request |
| **Session branch** | Per-user git branch (`api-session/{userId}`) for isolated edits in API mode |
| **StorageBackend** | 5-method I/O abstraction (`readFile`, `writeFile`, `listDirectory`, `deleteFile`, `fileExists`) with filesystem and GitHub API implementations |
| **Write-through cache** | Cache updated only after confirmed successful write to source of truth (GitHub) |
