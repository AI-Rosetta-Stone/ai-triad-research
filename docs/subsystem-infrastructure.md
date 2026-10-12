# Infrastructure & Deployment

## Overview

The platform uses GitHub Actions for CI/CD, Docker for containerization, and Azure Container Apps for cloud deployment. The BYOK (Bring Your Own Key) model means users supply their own AI API keys rather than the platform providing shared credentials.

## CI/CD Pipelines

### Core Pipelines

| Workflow | File | Trigger | Purpose |
|---|---|---|---|
| **CI** | `ci.yml` | Push/PR to main | Pester tests, TypeScript check, Electron build |
| **Release** | `release.yml` | Tag `v*` | Multi-platform builds, PSGallery publish, GitHub release |
| **Deploy** | `deploy-azure.yml` | Manual (workflow_dispatch, `-f sha=<commit>`) | Azure Container Apps deployment (t/3679: digest-pinned; `sha` required) |
| **Container** | `container.yml` | Tag `v*` or manual | Docker multi-platform build, GHCR push |

### Supporting Pipelines

| Workflow | Trigger | Purpose |
|---|---|---|
| `base-image.yml` | Manual | Build base runtime image (Python 3.11, Node 22) |
| `batch-summarize.yml` | Schedule or manual | Batch re-summarize documents |
| `cluster-conflicts.yml` | Manual | Cluster conflict data |
| `taxonomy-version-reminder.yml` | Daily schedule | Taxonomy health check reminder |

### CI Test Matrix

**test-powershell** (Ubuntu latest):
1. Checkout code repo + data repo (shallow clone)
2. Symlink data to `../ai-triad-data`
3. Install Pester
4. Run Pester tests
5. Build module via `Build-Module.ps1 -Clean`
6. Validate manifest

**test-electron** (Ubuntu latest):
1. Node 20 setup
2. `cd taxonomy-editor && npm ci`
3. TypeScript check (`npx tsc --noEmit`)
4. Build (`npm run build`)

### Release Pipeline

1. **resolve-version** — Check PSGallery; bump patch if version already published
2. **test** — Full Pester suite
3. **build-ps-module** — Build PowerShell module, upload artifact
4. **build-electron-{mac,win,linux}** — Signed Electron apps per platform
5. **create-release** — GitHub release with auto-generated notes

## Docker Architecture

Two-stage multi-platform build (amd64 + arm64):

### Stage 1: Builder

```dockerfile
FROM node:22-bookworm-slim
# Install build deps (python3, make, g++ for node-gyp)
# npm ci
# npm run build:container  →  TypeScript compile + Vite bundle
```

### Stage 2: Runtime

```dockerfile
FROM ghcr.io/ai-rosetta-stone/ai-triad-base:latest
# Base includes: Python 3.11, Node 22, ffmpeg, pandoc
# Copy built artifacts (dist/server, dist/renderer)
# VOLUME /data
# USER aitriad (non-root)
# EXPOSE 7862
# HEALTHCHECK: curl http://localhost:7862/health
```

The base image (`Dockerfile.base` in `deploy/azure/`) pre-installs heavy dependencies so application builds are fast.

## Azure Deployment

### Infrastructure (Bicep)

`deploy/azure/main.bicep` defines:

| Resource | Purpose |
|---|---|
| Container Apps Environment | Serverless, scale-to-zero hosting |
| Container App | Application with managed identity for Key Vault |
| Storage Account + Azure Files | Persistent `/data` volume |
| Log Analytics Workspace | Monitoring and diagnostics |
| Key Vault | Secrets storage (OAuth credentials, API keys) |

### BYOK Model

Users enter their own API keys through the application UI. Keys are encrypted with AES-256-GCM and stored on the data volume — the platform never holds or manages shared API credentials.

### Authentication

Three modes configurable via deployment parameters:

| Parameter | Effect |
|---|---|
| `authDisabled = true` | Anonymous-only, no login UI |
| `authOptional = true` | Login page with anonymous option |
| Neither | Login required |

OAuth providers (optional): Google, GitHub. Configured via `googleClientId`/`googleClientSecret` and `githubClientId`/`githubClientSecret` deployment parameters.

### Data Sync

Optional GitHub App integration for syncing the data repository:
- Requires GitHub App ID, installation ID, and private key in Key Vault
- Enabled via `gitSyncEnabled` parameter
- Allows the web-deployed instance to read/write to `ai-triad-data`

### Deployment Parameters

| Parameter | Purpose |
|---|---|
| `containerImage` | GHCR image URL |
| `googleClientId/Secret` | Google OAuth (secure) |
| `githubClientId/Secret` | GitHub OAuth (secure) |
| `authDisabled` | Disable authentication |
| `authOptional` | Optional authentication |
| `gitSyncEnabled` | Enable GitHub data sync |
| ~~`ghcrPassword`~~ | **Removed** — GHCR pulls are anonymous (package is public). See `deploy/azure/runbooks/production-release.md` Registry Auth. |

### Environment Variables (Runtime)

- `ALLOWED_ORIGINS` — Derived from deployment FQDN
- `DEPLOY_SHA` — Git commit SHA for traceability
- `AI_TRIAD_DATA_ROOT` — `/data` (mounted Azure Files share)
- `GIT_SYNC_ENABLED`, `GITHUB_REPO`, `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID` — Data sync configuration

## Version Management

Version bumps must update three files consistently:

1. `scripts/AITriad/AITriad.psd1` — Source manifest (`ModuleVersion`)
2. `build/AITriad/AITriad.psd1` — Built manifest (rebuild via `Build-Module.ps1 -Clean`)
3. `AGENTS.md` (aliased as `CLAUDE.md`) — Version reference in Architecture section

Release workflow: push a `v*` tag (e.g., `v0.8.0`) to trigger the release pipeline, then manually trigger `deploy-azure.yml` to push to Azure.

## Data Path Resolution

The data directory resolves in priority order:

```
1. $env:AI_TRIAD_DATA_ROOT         (explicit override)
2. .aitriad.json → data_root       (relative to repo root)
3. Platform default:
   - Windows: %LOCALAPPDATA%\AITriad\data
   - macOS:   ~/Library/Application Support/AITriad/data
   - Linux:   $XDG_DATA_HOME/aitriad/data
```

This chain supports dev (sibling repo), PSGallery install (platform default), and container deployment (env var pointing to `/data` volume) without code changes.

## Monitoring

- Azure Log Analytics captures container logs and metrics
- Health endpoint at `/health` for liveness probes
- Debate diagnostics files (`*-diagnostics.json`) provide turn-by-turn execution traces
- `Show-DebateDiagnostics` cmdlet for post-hoc analysis
