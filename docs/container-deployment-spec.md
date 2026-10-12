# AI Triad Taxonomy Editor — Container Deployment Specification

## Document Structure

1. [Functional Specification](#1-functional-specification) — User experience
2. [Technical Design Specification](#2-technical-design-specification) — Architecture
3. [Phased Implementation Plan](#3-phased-implementation-plan) — Delivery roadmap

---

# 1. Functional Specification

## 1.1 Vision

Users run a single PowerShell command — `Show-TaxonomyEditor` — and the Taxonomy Editor opens in their default web browser. All dependencies (Node.js, Python, PowerShell modules, AI model configs, embedding models) are encapsulated in a Docker container. Nothing is installed on the host except Docker itself and the AITriad PowerShell module.

## 1.2 User Experience

### First Run

```powershell
PS> Show-TaxonomyEditor
```

**What happens:**

1. The cmdlet checks for Docker. If missing, prints:
   ```
   Docker is required but not installed.
   Install Docker Desktop from https://www.docker.com/products/docker-desktop/
   ```
   and exits.

2. The cmdlet checks for the `ghcr.io/ai-rosetta-stone/taxonomy-editor` image. If missing:
   ```
   Pulling AI Triad Taxonomy Editor image (this is a one-time download)...
   [=========>                    ] 340 MB / 1.2 GB
   ```

3. The cmdlet starts the container:
   ```
   Starting Taxonomy Editor...
   ```

4. The cmdlet waits for the health endpoint to respond (up to 30 seconds):
   ```
   Waiting for editor to be ready...
   ```

5. The browser opens and the cmdlet prints:
   ```
   Taxonomy Editor is running at http://localhost:7862
   Press Ctrl+C to stop.
   ```

6. On first launch in the browser, the user sees the existing First Run dialog (API key setup, data repo clone) — same experience as today's Electron app.

### Subsequent Runs

Steps 1-2 are instant (image cached). Step 3-5 take ~3 seconds. The user sees the app in their browser with all prior state preserved.

### Stopping

`Ctrl+C` in the PowerShell session (or closing the terminal) gracefully stops the container. Data persists in the mounted volume.

### Parameters

```powershell
Show-TaxonomyEditor
    [-Port <int>]           # Default: 7862 (matches existing focus-server port)
    [-DataPath <string>]    # Override data directory (default: auto-detect via .aitriad.json)
    [-NoBrowser]            # Start the server without opening a browser
    [-Pull]                 # Force pull latest image even if cached
    [-Detach]               # Run in background (returns immediately)
    [-Stop]                 # Stop a running detached instance
    [-Status]               # Show whether a container is running
    [-Verbose]              # Show Docker output
```

### Example Workflows

```powershell
# Basic usage — start, use, Ctrl+C to stop
Show-TaxonomyEditor

# Run on a different port (e.g., if 7862 is taken)
Show-TaxonomyEditor -Port 8080

# Point to a specific data directory
Show-TaxonomyEditor -DataPath ~/research-data

# Run in background for long sessions
Show-TaxonomyEditor -Detach
# ... later ...
Show-TaxonomyEditor -Stop

# Check if already running
Show-TaxonomyEditor -Status
# Output: Taxonomy Editor is running at http://localhost:7862 (container: aitriad-editor-7862)

# Force update to latest version
Show-TaxonomyEditor -Pull
```

### API Key Handling

API keys are sensitive and must never be baked into the container image.

**Option A (recommended):** The browser-based First Run dialog prompts for keys, which are stored in an encrypted file inside the mounted data volume (replacing Electron's `safeStorage`).

**Option B:** Environment variables passed through from the host:
```powershell
# Keys from host environment pass through automatically
$env:GEMINI_API_KEY = "your-key"
Show-TaxonomyEditor
```

**Option C:** Explicit parameter:
```powershell
Show-TaxonomyEditor -ApiKeys @{ Gemini = "key1"; Claude = "key2" }
```

The cmdlet passes keys via Docker `--env` flags (never written to disk on host, never baked into image).

### Multi-User (Future Stage)

In the current stage, this is single-user: one container per user, data on the local machine. The architecture is designed so that future stages can introduce:
- Shared data volumes (team sees the same taxonomy)
- Authentication (who's connected)
- Cloud hosting (no Docker on the user's machine at all)

## 1.3 What Changes for the User

| Aspect | Today (Electron) | Stage 1 (Container) |
|--------|-------------------|----------------------|
| Install | `Install-Module AITriad` + Node.js + Python + git | `Install-Module AITriad` + Docker |
| Launch | `Show-TaxonomyEditor` | `Show-TaxonomyEditor` (same command) |
| Runtime | Electron window | Browser tab |
| Dependencies | Host-installed | Containerized |
| Data location | `../ai-triad-data` or platform default | Same (mounted into container) |
| Terminal panel | Embedded PowerShell PTY | Web terminal (same UX) |
| Offline use | Full | Full (container runs locally) |
| Performance | Native | Near-native (no GPU needed) |

## 1.4 What Does NOT Change

- The React UI — identical components, styling, and behavior
- All debate, chat, analysis, and taxonomy editing features
- Data file formats and directory structure
- AI API integrations (Gemini, Claude, Groq)
- The PowerShell AITriad module itself (it gains a new launch mode, but existing commands remain)

---

# 2. Technical Design Specification

## 2.1 Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  HOST MACHINE                                                    │
│                                                                  │
│  ┌──────────────────────┐   ┌──────────────────────────────┐    │
│  │ PowerShell            │   │ Web Browser                  │    │
│  │ Show-TaxonomyEditor   │──→│ http://localhost:7862        │    │
│  │  • docker pull/run    │   │ (same React UI)              │    │
│  │  • lifecycle mgmt     │   └──────────────┬───────────────┘    │
│  └──────────────────────┘                   │                    │
│                                             │ HTTP + WebSocket   │
│  ┌──────────────────────────────────────────┼───────────────┐    │
│  │ DOCKER CONTAINER                         │               │    │
│  │  ┌──────────────────────────────────────┐│               │    │
│  │  │ Node.js Server (Express/Fastify)     ││               │    │
│  │  │  • Serves React SPA static files     ││               │    │
│  │  │  • REST API  ← replaces IPC bridge   ││               │    │
│  │  │  • WebSocket ← terminal + live updates│               │    │
│  │  │  • AI API proxy (keys never in browser)│              │    │
│  │  └──┬─────────────┬─────────────┬───────┘│               │    │
│  │     │             │             │         │               │    │
│  │  ┌──▼──┐  ┌──────▼──────┐  ┌──▼──────┐  │               │    │
│  │  │FileIO│  │ AI Backends │  │ Terminal │  │               │    │
│  │  │     │  │ Gemini/     │  │ PTY +    │  │               │    │
│  │  │     │  │ Claude/Groq │  │ pwsh     │  │               │    │
│  │  └──┬──┘  └─────────────┘  └─────────┘  │               │    │
│  │     │                                     │               │    │
│  │  ┌──▼──────────────────────────────────┐  │               │    │
│  │  │ /data (mounted volume)              │  │               │    │
│  │  │  taxonomy/ sources/ summaries/      │  │               │    │
│  │  │  conflicts/ debates/ chats/         │  │               │    │
│  │  └────────────────────────────────────┘  │               │    │
│  │                                           │               │    │
│  │  Installed in container:                  │               │    │
│  │  • Node.js 22 LTS                        │               │    │
│  │  • Python 3.12 + sentence-transformers   │               │    │
│  │  • PowerShell 7                           │               │    │
│  │  • git, pandoc                            │               │    │
│  │  • AITriad PS module + companions         │               │    │
│  └───────────────────────────────────────────────────────────┘    │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │ ~/ai-triad-data (bind-mounted as /data in container)     │    │
│  └──────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

## 2.2 The IPC-to-REST Translation Layer

The Electron app communicates via `window.electronAPI.*` (70+ IPC methods). In the web version, these become HTTP/WebSocket calls. The key insight is that the **renderer code stays identical** — only the bridge implementation changes.

### Bridge Adapter Pattern

```typescript
// electron-bridge.ts (today — used in Electron builds)
export const api: AppAPI = {
  loadTaxonomyFile: (pov) => window.electronAPI.loadTaxonomyFile(pov),
  generateText: (prompt, model, timeout) => window.electronAPI.generateText(prompt, model, timeout),
  // ... 70+ methods
};

// web-bridge.ts (new — used in container builds)
export const api: AppAPI = {
  loadTaxonomyFile: (pov) => fetch(`/api/taxonomy/${pov}`).then(r => r.json()),
  generateText: (prompt, model, timeout) =>
    fetch('/api/ai/generate', {
      method: 'POST',
      body: JSON.stringify({ prompt, model, timeout }),
    }).then(r => r.json()),
  // ... same 70+ methods, backed by HTTP
};
```

The renderer imports from `@bridge` (a Vite alias) which resolves to either `electron-bridge.ts` or `web-bridge.ts` depending on the build target.

### API Surface Grouping

| Group | Methods | Protocol | Notes |
|-------|---------|----------|-------|
| Taxonomy CRUD | loadTaxonomyFile, saveTaxonomyFile, loadEdges, etc. | REST | Standard CRUD |
| Conflict CRUD | loadConflictFiles, saveConflictFile, createConflictFile, deleteConflictFile | REST | Standard CRUD |
| Debate/Chat IO | listDebateSessions, loadDebateSession, saveDebateSession, etc. | REST | Standard CRUD |
| AI Generation | generateText, generateTextWithSearch | REST (streaming future) | Server proxies to AI APIs |
| Embeddings/NLI | computeEmbeddings, computeQueryEmbedding, nliClassify | REST | Server calls Python |
| Terminal | terminalSpawn, terminalWrite, terminalResize, terminalKill | WebSocket | Bidirectional PTY stream |
| Events | onReloadTaxonomy, onFocusNode, onGenerateTextProgress | WebSocket | Server-push events |
| API Keys | setApiKey, hasApiKey | REST | Encrypted storage in data volume |
| Data Mgmt | isDataAvailable, getDataRoot, cloneDataRepo, checkDataUpdates | REST | Git operations |
| Window Control | growWindow, shrinkWindow, isMaximized | **Removed** | Not applicable in browser |
| Clipboard | clipboardWriteText | **Browser native** | `navigator.clipboard.writeText()` |
| File Dialogs | pickDocumentFile, exportDebateToFile | REST + download | Server-side file handling with upload/download |

## 2.3 Server Architecture

A single Express (or Fastify) Node.js server running inside the container:

```
src/server/
├── server.ts              # Entry point, Express app setup
├── routes/
│   ├── taxonomy.ts        # GET/PUT /api/taxonomy/:pov
│   ├── conflicts.ts       # CRUD /api/conflicts/*
│   ├── debates.ts         # CRUD /api/debates/*
│   ├── chats.ts           # CRUD /api/chats/*
│   ├── ai.ts              # POST /api/ai/generate, /api/ai/search
│   ├── embeddings.ts      # POST /api/embeddings/*
│   ├── apiKeys.ts         # GET/POST /api/keys
│   ├── data.ts            # GET /api/data/status, POST /api/data/clone
│   ├── proposals.ts       # CRUD /api/proposals/*
│   └── health.ts          # GET /health
├── services/
│   ├── fileIO.ts          # Adapted from main/fileIO.ts
│   ├── aiBackends.ts      # Adapted from main/embeddings.ts
│   ├── apiKeyStore.ts     # File-based encrypted key storage
│   ├── terminal.ts        # PTY management
│   └── dataUpdater.ts     # Git clone/pull operations
├── ws/
│   ├── terminal.ts        # WebSocket ↔ PTY bridge
│   └── events.ts          # Server-push event bus
└── static/                # Vite-built React SPA served here
```

### Service Layer Reuse

The existing `main/` files (`fileIO.ts`, `embeddings.ts`, `apiKeyStore.ts`, `terminal.ts`) contain the real logic. The server routes are thin wrappers:

```typescript
// routes/taxonomy.ts
router.get('/:pov', async (req, res) => {
  const data = await fileIO.readTaxonomyFile(req.params.pov);
  res.json(data);
});

router.put('/:pov', async (req, res) => {
  await fileIO.writeTaxonomyFile(req.params.pov, req.body);
  res.json({ ok: true });
});
```

Most of the existing main-process code works as-is in a Node.js server context. The only Electron-specific API that needs replacement is `safeStorage` (for API key encryption) and `net.fetch` (replaced with standard `fetch` in Node 22).

## 2.4 Terminal WebSocket

The embedded terminal is a key feature. In the container, the PTY broker runs server-side and streams to the browser via WebSocket:

```
Browser (xterm.js) ←──WebSocket──→ Server (ws) ←──stdio──→ PTY (pwsh)
```

The existing `pty-broker.py` works unmodified. The server just bridges its stdin/stdout to a WebSocket channel instead of Electron IPC.

## 2.5 Dockerfile

```dockerfile
FROM node:22-bookworm-slim AS base

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git pandoc python3 python3-pip python3-venv \
    poppler-utils          # pdftotext \
    && rm -rf /var/lib/apt/lists/*

# PowerShell 7
RUN curl -fsSL https://packages.microsoft.com/config/debian/12/packages-microsoft-prod.deb -o /tmp/ms.deb \
    && dpkg -i /tmp/ms.deb && rm /tmp/ms.deb \
    && apt-get update && apt-get install -y powershell \
    && rm -rf /var/lib/apt/lists/*

# Python ML dependencies (in a venv so they don't conflict)
RUN python3 -m venv /opt/ml-env
ENV PATH="/opt/ml-env/bin:$PATH"
RUN pip install --no-cache-dir sentence-transformers numpy

# Pre-download the embedding model so first run is fast
RUN python3 -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('all-MiniLM-L6-v2')"

# Application code
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production

COPY dist/server/ ./dist/server/
COPY dist/renderer/ ./dist/renderer/
COPY scripts/ ./scripts/
COPY ai-models.json ./
COPY taxonomy/schemas/ ./taxonomy/schemas/
COPY .aitriad.json ./

# Data volume
VOLUME /data
ENV AI_TRIAD_DATA_ROOT=/data

EXPOSE 7862
HEALTHCHECK --interval=5s --timeout=3s CMD curl -f http://localhost:7862/health || exit 1

CMD ["node", "dist/server/server.js"]
```

### Image Size Estimate

| Layer | Size |
|-------|------|
| node:22-bookworm-slim | ~200 MB |
| System packages (git, pandoc, poppler, pwsh) | ~300 MB |
| Python venv + sentence-transformers + PyTorch CPU | ~800 MB |
| Pre-downloaded embedding model | ~90 MB |
| Node.js app (server + renderer + node_modules) | ~50 MB |
| AITriad PS module + configs | ~5 MB |
| **Total** | **~1.4 GB** |

This is large but comparable to other ML-ready containers. The download is one-time.

### Multi-stage Build Optimization

A multi-stage build keeps the final image lean:

```dockerfile
# Stage 1: Build the app
FROM node:22-bookworm-slim AS builder
WORKDIR /build
COPY . .
RUN npm ci && npm run build:server && npm run build:renderer

# Stage 2: Runtime image
FROM node:22-bookworm-slim AS runtime
# ... install system deps, copy built artifacts from builder
COPY --from=builder /build/dist /app/dist
```

## 2.6 Data Volume Strategy

The data directory (`ai-triad-data`) is bind-mounted from the host:

```
docker run -v /path/to/ai-triad-data:/data ghcr.io/ai-rosetta-stone/taxonomy-editor
```

This means:
- Data persists across container restarts
- Users can still use the PowerShell module directly against the same data
- Existing data repos work without migration
- Git operations inside the container work on the mounted repo

The `Show-TaxonomyEditor` cmdlet auto-detects the data path using the same resolution logic as today (`Resolve-DataPath`).

## 2.7 API Key Security

Electron's `safeStorage` is not available in a server context. Replacement:

1. **Server-side encrypted file**: Keys are encrypted with a key derived from a machine-specific secret (container ID + data volume fingerprint) using Node.js `crypto.createCipheriv`. Stored in `/data/.aitriad-keys.enc`.

2. **Environment variable passthrough**: The cmdlet detects `$env:GEMINI_API_KEY` etc. and passes them via `docker run --env`.

3. **Keys never reach the browser**: The server proxies all AI API calls. The browser sends prompts to `/api/ai/generate`; the server attaches the API key.

## 2.8 What Gets Removed (Browser vs. Electron)

| Electron Feature | Browser Replacement |
|------------------|---------------------|
| `BrowserWindow` | Not needed (browser is the window) |
| `safeStorage` | Server-side encrypted file |
| `net.fetch` | Standard `fetch` (Node 22) |
| `contextBridge` / preload | REST + WebSocket bridge |
| `dialog.showOpenDialog` | `<input type="file">` + upload endpoint |
| `dialog.showSaveDialog` | Server generates file + browser download |
| `shell.openExternal` | `window.open()` |
| `clipboard.writeText` | `navigator.clipboard.writeText()` |
| Window resize IPC | CSS-only (browser handles it) |
| App menu (File, Edit, View) | In-app toolbar or keyboard shortcuts |
| Diagnostics popout window | In-app panel (or new browser tab via URL route) |
| Focus server (:17862) | Same server, same endpoint |

## 2.9 Build Configuration

Vite builds with a `VITE_TARGET` environment variable:

```typescript
// vite.config.ts
const isWeb = process.env.VITE_TARGET === 'web';

export default defineConfig({
  resolve: {
    alias: {
      '@bridge': isWeb
        ? path.resolve('src/renderer/bridge/web-bridge.ts')
        : path.resolve('src/renderer/bridge/electron-bridge.ts'),
    },
  },
});
```

This keeps one codebase for both targets. The Electron build continues to work for developers who prefer the desktop experience.

---

# 3. Phased Implementation Plan

## Phase 0: Preparation (Foundation)

**Goal:** Extract the bridge interface without changing any existing behavior.

### 0.1 Define the AppAPI Interface

Create `src/renderer/bridge/types.ts` that declares every method currently on `window.electronAPI`:

```typescript
export interface AppAPI {
  loadTaxonomyFile(pov: string): Promise<PovData>;
  saveTaxonomyFile(pov: string, data: PovData): Promise<void>;
  generateText(prompt: string, model?: string, timeoutMs?: number): Promise<{ text: string }>;
  // ... all 70+ methods with proper types
}
```

### 0.2 Create the Electron Bridge

Create `src/renderer/bridge/electron-bridge.ts` that implements `AppAPI` by delegating to `window.electronAPI`:

```typescript
export const api: AppAPI = {
  loadTaxonomyFile: (pov) => window.electronAPI.loadTaxonomyFile(pov),
  // ...
};
```

### 0.3 Migrate All Renderer Code

Replace every `window.electronAPI.xxx()` call in the renderer with `api.xxx()` imported from `@bridge`. This is a mechanical find-and-replace across all components, hooks, and utilities.

**Validation:** The Electron app works exactly as before. No behavior change.

### 0.4 Extract Service Layer

Factor the business logic out of `src/main/` files into a shared `src/services/` layer that has no Electron imports:

- `fileIO.ts` → remove `app.getPath`, accept data root as config
- `embeddings.ts` → replace `net.fetch` with standard `fetch`
- `apiKeyStore.ts` → abstract storage backend (Electron safeStorage vs. file-based)
- `terminal.ts` → abstract transport (Electron IPC vs. WebSocket)

**Validation:** Electron app still works, now using the shared service layer.

**Deliverables:**
- `src/renderer/bridge/types.ts` — AppAPI interface
- `src/renderer/bridge/electron-bridge.ts` — Electron implementation
- `src/services/` — shared business logic
- All `window.electronAPI` references replaced with `api.*`

---

## Phase 1: Web Server

**Goal:** The app runs in a browser served by a Node.js server inside a Docker container.

### 1.1 Create the Server

Build `src/server/server.ts` — an Express app that:
- Serves the Vite-built SPA from `/`
- Exposes REST routes under `/api/`
- Exposes WebSocket at `/ws/terminal` and `/ws/events`
- Reads config from environment variables

### 1.2 Implement REST Routes

One route file per API group. Each route is a thin wrapper around the shared service layer:

| Priority | Routes | Effort |
|----------|--------|--------|
| P0 (app loads) | `GET /api/taxonomy/:pov`, `GET /api/data/status`, `GET /api/keys/has`, `GET /api/models` | Small |
| P0 (core editing) | `PUT /api/taxonomy/:pov`, conflict CRUD, edge CRUD | Small |
| P1 (debates) | Debate session CRUD, chat session CRUD | Small |
| P1 (AI) | `POST /api/ai/generate`, `POST /api/ai/search` | Medium — proxy + key injection |
| P2 (embeddings) | `POST /api/embeddings/compute`, `POST /api/embeddings/query`, `POST /api/nli/classify` | Medium — calls Python |
| P2 (terminal) | WebSocket PTY bridge | Medium |
| P3 (data mgmt) | Clone repo, check/pull updates | Small |
| P3 (misc) | Proposals, harvest, PS prompts, focus-node | Small |

### 1.3 Create the Web Bridge

`src/renderer/bridge/web-bridge.ts` implements `AppAPI` using `fetch` and WebSocket:

```typescript
const BASE = ''; // same-origin

export const api: AppAPI = {
  loadTaxonomyFile: (pov) =>
    fetch(`${BASE}/api/taxonomy/${pov}`).then(handleResponse),
  generateText: (prompt, model, timeout) =>
    fetch(`${BASE}/api/ai/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, model, timeout }),
    }).then(handleResponse),
  // ...
};
```

### 1.4 Conditional Build

Add `VITE_TARGET=web` support to `vite.config.ts` so the renderer resolves `@bridge` to the web bridge.

Add build scripts:
```json
{
  "build:web": "VITE_TARGET=web vite build",
  "build:server": "tsc -p tsconfig.server.json",
  "build:container": "npm run build:web && npm run build:server"
}
```

### 1.5 Dockerfile

Create `Dockerfile` and `.dockerignore`. Build and test locally.

### 1.6 Browser Adaptations

Handle the few Electron-specific UI behaviors:
- Replace `dialog.showOpenDialog` with `<input type="file">` + file upload endpoint
- Replace `dialog.showSaveDialog` with server-generated file download
- Replace clipboard IPC with `navigator.clipboard`
- Remove window-resize IPC (CSS handles it)
- Diagnostics popout → URL route `/diagnostics` (opens in new tab)

**Deliverables:**
- `src/server/` — complete server implementation
- `src/renderer/bridge/web-bridge.ts` — web bridge
- `Dockerfile`, `.dockerignore`
- Updated `vite.config.ts` with dual-target support
- Updated `package.json` with container build scripts

---

## Phase 2: PowerShell Launcher

**Goal:** `Show-TaxonomyEditor` manages the Docker container lifecycle.

### 2.1 Refactor Show-TaxonomyEditor

The existing `Show-TaxonomyEditor.ps1` checks for Node.js and runs `npm run dev`. The refactored version:

```powershell
function Show-TaxonomyEditor {
    [CmdletBinding()]
    param(
        [int]$Port = 7862,
        [string]$DataPath,
        [switch]$NoBrowser,
        [switch]$Pull,
        [switch]$Detach,
        [switch]$Stop,
        [switch]$Status
    )

    # 1. Resolve data path (existing logic)
    if (-not $DataPath) {
        $DataPath = Resolve-DataPath
    }

    # 2. Check Docker
    Assert-DockerAvailable

    # 3. Handle -Stop / -Status
    if ($Stop)   { Stop-TaxonomyContainer -Port $Port; return }
    if ($Status) { Get-TaxonomyContainerStatus -Port $Port; return }

    # 4. Check if already running on this port
    if (Test-TaxonomyContainerRunning -Port $Port) {
        Write-Host "Taxonomy Editor is already running at http://localhost:$Port"
        if (-not $NoBrowser) { Start-Process "http://localhost:$Port" }
        return
    }

    # 5. Pull image if needed
    if ($Pull -or -not (Test-DockerImageExists 'ghcr.io/ai-rosetta-stone/taxonomy-editor')) {
        Pull-TaxonomyEditorImage
    }

    # 6. Build docker run args
    $containerName = "aitriad-editor-$Port"
    $envArgs = Get-ApiKeyEnvArgs  # passes through GEMINI_API_KEY, ANTHROPIC_API_KEY, etc.

    # 7. Start container
    $runArgs = @(
        'run', '--rm',
        '--name', $containerName,
        '-p', "${Port}:7862",
        '-v', "${DataPath}:/data",
        $envArgs,
        'ghcr.io/ai-rosetta-stone/taxonomy-editor:latest'
    )
    if ($Detach) { $runArgs = @('run', '-d') + $runArgs[1..($runArgs.Length)] }

    # 8. Wait for ready + open browser
    if (-not $Detach) {
        $dockerJob = Start-Job { docker @using:runArgs }
        Wait-ForHealthEndpoint -Port $Port -TimeoutSeconds 30
        if (-not $NoBrowser) { Start-Process "http://localhost:$Port" }
        Write-Host "Taxonomy Editor is running at http://localhost:$Port"
        Write-Host "Press Ctrl+C to stop."
        try { Wait-Job $dockerJob } finally { Stop-TaxonomyContainer -Port $Port }
    } else {
        docker @runArgs
        Wait-ForHealthEndpoint -Port $Port -TimeoutSeconds 30
        if (-not $NoBrowser) { Start-Process "http://localhost:$Port" }
        Write-Host "Taxonomy Editor is running at http://localhost:$Port (detached)"
    }
}
```

### 2.2 Container Lifecycle Helpers

Private functions in `Private/`:

- `Assert-DockerAvailable` — checks `Get-Command docker`, prints install URL if missing
- `Test-DockerImageExists` — `docker images -q ghcr.io/ai-rosetta-stone/taxonomy-editor`
- `Pull-TaxonomyEditorImage` — `docker pull` with progress
- `Test-TaxonomyContainerRunning` — `docker ps --filter`
- `Stop-TaxonomyContainer` — `docker stop`
- `Get-TaxonomyContainerStatus` — status display
- `Wait-ForHealthEndpoint` — polls `http://localhost:$Port/health`
- `Get-ApiKeyEnvArgs` — collects `--env KEY=val` for each set API key env var

### 2.3 Backward Compatibility

The cmdlet auto-detects the best mode:
1. If Docker is available → container mode (default)
2. If Docker is not available but Node.js is → legacy dev mode (existing behavior)
3. If neither → error with instructions

This means existing developer workflows are unaffected.

**Deliverables:**
- Refactored `Public/Show-TaxonomyEditor.ps1`
- `Private/Assert-DockerAvailable.ps1` and other helpers
- Updated module manifest

---

## Phase 3: Polish & Production Readiness

**Goal:** Reliable, secure, production-quality container deployment.

### 3.1 Container Hardening

- Run as non-root user (`USER node`)
- Read-only filesystem where possible (`--read-only` with tmpfs for `/tmp`)
- Drop all capabilities (`--cap-drop ALL`)
- Resource limits in `docker run` (memory, CPU)
- Validate bind-mount path exists before starting

### 3.2 Image Optimization

- Multi-stage build (builder → runtime)
- `.dockerignore` excludes dev files, test fixtures, `.git`
- Pin all base image versions for reproducibility
- Layer ordering optimized for cache hits (deps before code)
- Consider PyTorch CPU-only variant to reduce Python layer size

### 3.3 Automated Image Build

GitHub Actions workflow:

```yaml
on:
  push:
    tags: ['v*']
jobs:
  build-container:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/build-push-action@v5
        with:
          push: true
          tags: ghcr.io/ai-rosetta-stone/taxonomy-editor:${{ github.ref_name }},ghcr.io/ai-rosetta-stone/taxonomy-editor:latest
```

### 3.4 Image Versioning

The cmdlet checks for version compatibility:
- Container reports its version via `GET /health` response
- If the module version and container version diverge beyond a minor version, warn the user to `Show-TaxonomyEditor -Pull`

### 3.5 Graceful Shutdown

- `SIGTERM` handler in `server.ts` — flush pending writes, close WebSockets, exit
- `docker stop` timeout of 10 seconds (enough for file flushes)
- PowerShell `Ctrl+C` traps `[Console]::TreatControlCAsInput` and sends `docker stop`

### 3.6 Logging

- Server logs to stdout (Docker captures it)
- `Show-TaxonomyEditor -Verbose` streams Docker logs to the PowerShell console
- Structured JSON logs for production debugging

**Deliverables:**
- Hardened Dockerfile
- CI/CD workflow for image publishing
- Version compatibility checking
- Graceful shutdown handling

---

## Phase 4: Multi-User Preparation (Future)

> This phase is out of scope for Stage 1 but documents the path forward.

### 4.1 Authentication

- Add session-based auth (or OAuth) to the server
- API keys stored per-user in a database (not shared file)
- HTTPS termination via reverse proxy (nginx/caddy)

### 4.2 Shared Data

- Replace bind-mounted data directory with a shared volume or object storage
- Add file locking / optimistic concurrency for taxonomy edits
- Conflict resolution UI when two users edit the same node

### 4.3 Cloud Deployment

- Docker Compose for multi-container setup (app + reverse proxy + optional DB)
- Kubernetes manifests or cloud-native deployment (Cloud Run, ECS, etc.)
- `Show-TaxonomyEditor -Cloud` connects to a hosted instance instead of running locally

---

## Implementation Timeline

| Phase | Description | Key Risk | Estimated Effort |
|-------|-------------|----------|-----------------|
| **0** | Bridge extraction | Mechanical but large — 70+ API methods | ~40 files touched |
| **1** | Web server + Docker | Terminal WebSocket is the trickiest part | New server codebase |
| **2** | PowerShell launcher | Docker lifecycle edge cases (port conflicts, stale containers) | ~8 new PS functions |
| **3** | Production hardening | Image size optimization vs. feature completeness | CI/CD + testing |
| **4** | Multi-user (future) | Concurrency, auth, cloud infra | Separate project |

### Dependency Graph

```
Phase 0 ──→ Phase 1 ──→ Phase 2 ──→ Phase 3
                                        │
                                        ▼
                                    Phase 4 (future)
```

Phase 0 must complete before Phase 1 (the bridge interface is the foundation). Phases 2 and 3 can partially overlap (the cmdlet can be developed while the server is being finalized).

---

## Appendix A: Files That Change

### Phase 0 (Bridge Extraction)

| Action | File |
|--------|------|
| **Create** | `src/renderer/bridge/types.ts` |
| **Create** | `src/renderer/bridge/electron-bridge.ts` |
| **Modify** | Every file that calls `window.electronAPI.*` (~40 files) |
| **Create** | `src/services/fileIO.ts` (extracted from `src/main/fileIO.ts`) |
| **Create** | `src/services/aiBackends.ts` (extracted from `src/main/embeddings.ts`) |
| **Create** | `src/services/apiKeyStore.ts` (abstracted) |
| **Modify** | `src/main/ipcHandlers.ts` (delegate to services) |
| **Modify** | `vite.config.ts` (add `@bridge` alias) |

### Phase 1 (Web Server)

| Action | File |
|--------|------|
| **Create** | `src/server/server.ts` + all route and service files |
| **Create** | `src/renderer/bridge/web-bridge.ts` |
| **Create** | `Dockerfile`, `.dockerignore` |
| **Create** | `tsconfig.server.json` |
| **Modify** | `package.json` (new build scripts, server deps) |
| **Modify** | `vite.config.ts` (VITE_TARGET support) |
| **Modify** | Components using file dialogs, clipboard, window resize |

### Phase 2 (PowerShell Launcher)

| Action | File |
|--------|------|
| **Modify** | `Public/Show-TaxonomyEditor.ps1` |
| **Create** | `Private/Assert-DockerAvailable.ps1` |
| **Create** | `Private/Test-TaxonomyContainerRunning.ps1` |
| **Create** | `Private/Stop-TaxonomyContainer.ps1` |
| **Create** | `Private/Get-TaxonomyContainerStatus.ps1` |
| **Create** | `Private/Wait-ForHealthEndpoint.ps1` |
| **Create** | `Private/Get-ApiKeyEnvArgs.ps1` |
| **Modify** | `AITriad.psd1` (manifest, if new exports needed) |

## Appendix B: Risk Mitigation

| Risk | Impact | Mitigation |
|------|--------|------------|
| Image too large (>2 GB) | Slow first download | PyTorch CPU-only, multi-stage build, optional ML layer |
| Terminal latency over WebSocket | Poor UX in PS terminal | Buffer + batch writes, binary WebSocket frames |
| API key exposure | Security breach | Keys never in browser, HTTPS in future, encrypted at rest |
| Docker not installed | User blocked | Clear error message + install link; fallback to legacy dev mode |
| Port conflicts | Container won't start | Auto-detect available port; `-Port` parameter |
| File permission mismatches | Data read/write errors | Match container UID to host UID; `--user $(id -u):$(id -g)` |
| Stale containers after crash | Port locked | Check for orphaned containers on startup; `docker rm -f` |
