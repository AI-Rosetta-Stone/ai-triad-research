# Data Separation Plan — Refactoring Data into a Separate Repository

## Problem

The `ai-triad-research` repo contains both **code** (PowerShell module, Electron apps, prompts) and **data** (taxonomy, sources, summaries, conflicts, debates). This creates:

- **Bloated repo**: ~400 MB, mostly source PDFs
- **Tight coupling**: Data paths hardcoded in ~25 files across PowerShell and TypeScript
- **Version confusion**: Code changes and data changes create interleaved commits
- **Distribution friction**: Users who only want the tools don't need 90+ source documents

## Current Data Inventory

| Directory | Size | Files | Description |
|-----------|------|-------|-------------|
| `sources/` | ~396 MB | 134 dirs | Ingested documents (PDFs, HTML, snapshots) |
| `taxonomy/Origin/` | ~8 MB | 6 JSON files | Authoritative taxonomy + edges + embeddings |
| `summaries/` | ~1.7 MB | 92 JSON files | AI-generated POV summaries |
| `conflicts/` | ~2.8 MB | 713 JSON files | Auto-detected factual conflicts |
| `debates/` | ~248 KB | 8 JSON files | Structured debate sessions |
| `prompts/` (top-level) | ~20 KB | 3 files | Experimental prompt docs |
| `.summarise-queue.json` | ~5 KB | 1 file | Pending summary queue |
| `TAXONOMY_VERSION` | 6 B | 1 file | Schema version trigger |
| `ai-models.json` | ~8 KB | 1 file | AI model configuration |

**Total data**: ~410 MB (vs ~15 MB of code)

## Target Architecture

```
github.com/AI-Rosetta-Stone/ai-triad-research       ← CODE repo (~15 MB)
├── scripts/AITriad/                          (PowerShell module)
├── taxonomy-editor/                          (Electron app)
├── taxonomy/schemas/                         (JSON schemas — part of code)
├── scripts/AITriad/Prompts/                  (prompt templates — part of code)
├── ai-models.json                            (model config — part of code)
├── .aitriad.json                             (NEW: data repo path config)
└── docs/

github.com/AI-Rosetta-Stone/ai-triad-data            ← DATA repo (~410 MB)
├── taxonomy/Origin/                          (taxonomy JSONs, edges, embeddings)
├── sources/                                  (ingested documents)
├── summaries/                                (POV summaries)
├── conflicts/                                (factual conflicts)
├── debates/                                  (debate sessions)
├── .summarise-queue.json                     (summary queue)
└── TAXONOMY_VERSION                          (schema version)
```

## Resolution Strategy

### Phase 1: Introduce Data Path Configuration

**Goal**: Decouple code from data locations without moving anything yet.

#### 1a. Create `.aitriad.json` config file

```json
{
  "data_root": ".",
  "taxonomy_dir": "taxonomy/Origin",
  "sources_dir": "sources",
  "summaries_dir": "summaries",
  "conflicts_dir": "conflicts",
  "debates_dir": "debates"
}
```

When `data_root` is `.`, everything works as today (monorepo). When it's `../ai-triad-data`, code reads from the sibling data repo.

#### 1b. Update PowerShell module

Create `Private/Resolve-DataPath.ps1`:
```powershell
function Resolve-DataPath {
    param([string]$SubPath)
    $ConfigPath = Join-Path $script:RepoRoot '.aitriad.json'
    if (Test-Path $ConfigPath) {
        $Config = Get-Content -Raw $ConfigPath | ConvertFrom-Json
        $DataRoot = if ([System.IO.Path]::IsPathRooted($Config.data_root)) {
            $Config.data_root
        } else {
            Join-Path $script:RepoRoot $Config.data_root
        }
        return Join-Path $DataRoot $SubPath
    }
    # Fallback: data is in the code repo
    return Join-Path $script:RepoRoot $SubPath
}
```

Replace all hardcoded paths:
```powershell
# Before:
$TaxDir = Join-Path $RepoRoot 'taxonomy' 'Origin'
# After:
$TaxDir = Resolve-DataPath $script:Config.taxonomy_dir
```

**Files to update** (~23 PowerShell files with hardcoded paths):
- `AITriad.psm1` — taxonomy loading at import
- `Import-AITriadDocument.ps1` — sources/ write
- `Invoke-POVSummary.ps1`, `Invoke-BatchSummary.ps1` — summaries/ write
- `Find-Conflict.ps1` — conflicts/ write
- `Show-TriadDialogue.ps1` — debates/ write
- `Get-AITSource.ps1`, `Get-Summary.ps1` — data reads
- `Get-TaxonomyHealth.ps1` — reads all directories
- And ~13 more

#### 1c. Update Electron apps

Update `taxonomy-editor/src/main/fileIO.ts`:
```typescript
// Before:
const TAXONOMY_BASE = path.join(PROJECT_ROOT, 'taxonomy');
const CONFLICTS_DIR = path.join(PROJECT_ROOT, 'conflicts');

// After:
const config = loadAiTriadConfig(); // reads .aitriad.json
const DATA_ROOT = path.resolve(PROJECT_ROOT, config.data_root);
const TAXONOMY_BASE = path.join(DATA_ROOT, 'taxonomy');
const CONFLICTS_DIR = path.join(DATA_ROOT, config.conflicts_dir);
```

### Phase 2: Create Data Repository

1. Create `github.com/AI-Rosetta-Stone/ai-triad-data`
2. Move data directories:
   ```bash
   # In ai-triad-data/
   git init
   cp -r ../ai-triad-research/taxonomy/Origin taxonomy/Origin
   cp -r ../ai-triad-research/sources .
   cp -r ../ai-triad-research/summaries .
   cp -r ../ai-triad-research/conflicts .
   cp -r ../ai-triad-research/debates .
   cp ../ai-triad-research/.summarise-queue.json .
   cp ../ai-triad-research/TAXONOMY_VERSION .
   git add -A && git commit -m "Initial data import from ai-triad-research"
   git push
   ```

3. Use Git LFS for large files in the data repo:
   ```bash
   git lfs install
   git lfs track "sources/*/raw/*.pdf"
   git lfs track "sources/*/raw/*.html"
   git lfs track "taxonomy/Origin/embeddings.json"
   ```

### Phase 3: Clean Up Code Repository

1. Update `.aitriad.json` to point to sibling:
   ```json
   { "data_root": "../ai-triad-data" }
   ```

2. Add data directories to `.gitignore`:
   ```
   # Data (lives in ai-triad-data repo)
   /taxonomy/Origin/
   /sources/
   /summaries/
   /conflicts/
   /debates/
   /.summarise-queue.json
   /TAXONOMY_VERSION
   ```

3. Keep `taxonomy/schemas/` in the code repo (it's schema definitions, not data)

4. Remove data from git history (optional, saves ~400 MB):
   ```bash
   git filter-repo --path sources/ --invert-paths
   git filter-repo --path taxonomy/Origin/ --invert-paths
   # etc.
   ```
   **Warning**: This rewrites history and requires force-push.

### Phase 4: Developer Setup

Update README with setup instructions:

```bash
# Clone both repos side by side
git clone https://github.com/AI-Rosetta-Stone/ai-triad-research.git
git clone https://github.com/AI-Rosetta-Stone/ai-triad-data.git

# Or clone data into the code repo (monorepo-like)
cd ai-triad-research
git clone https://github.com/AI-Rosetta-Stone/ai-triad-data.git data
# Then set .aitriad.json: { "data_root": "data" }
```

Add a setup helper:
```powershell
# scripts/AITriad/Public/Install-AITriadData.ps1
function Install-AITriadData {
    # Clone the data repo into ../ai-triad-data if not present
    # Or into ./data as a subdirectory
}
```

## What Stays in the Code Repo

| Path | Reason |
|------|--------|
| `scripts/AITriad/` | PowerShell module code |
| `scripts/AITriad/Prompts/` | Prompt templates (versioned with code) |
| `scripts/AIEnrich.psm1` | Companion module |
| `scripts/DocConverters.psm1` | Companion module |
| `taxonomy/schemas/` | JSON validation schemas (code, not data) |
| `taxonomy-editor/` | Electron app source |
| `ai-models.json` | Model configuration (code/config) |
| `docs/` | Documentation |
| `.aitriad.json` | Data path configuration |

## What Moves to the Data Repo

| Path | Size | Note |
|------|------|------|
| `taxonomy/Origin/*.json` | 8 MB | Taxonomy, edges, embeddings |
| `sources/` | 396 MB | Use Git LFS for raw/ PDFs |
| `summaries/` | 1.7 MB | |
| `conflicts/` | 2.8 MB | |
| `debates/` | 248 KB | |
| `.summarise-queue.json` | 5 KB | |
| `TAXONOMY_VERSION` | 6 B | |

## Edge Cases

### Environment variable override

Support `$env:AI_TRIAD_DATA_ROOT` as the highest-priority override:

```
Priority:
1. $env:AI_TRIAD_DATA_ROOT (if set)
2. .aitriad.json data_root (if file exists)
3. Same directory as code repo (monorepo fallback)
```

### Taxonomy Editor bundled data

For redistributable builds, the Electron app could bundle a snapshot of the taxonomy data so it works out-of-the-box without cloning the data repo. The bundled data would be overridden by `.aitriad.json` if present.

### CI/CD

GitHub Actions workflows need to checkout both repos:
```yaml
- uses: actions/checkout@v4
  with:
    repository: AI-Rosetta-Stone/ai-triad-data
    path: ai-triad-data
```

## Estimated Effort

| Phase | Effort | Risk |
|-------|--------|------|
| Phase 1: Config + path abstraction | 2 days | Low — no data movement |
| Phase 2: Create data repo + move data | 0.5 day | Medium — need to verify all paths |
| Phase 3: Clean code repo | 0.5 day | High if rewriting git history |
| Phase 4: Developer setup + docs | 0.5 day | Low |
| **Total** | **~3.5 days** | |

## Recommended Order

1. **Start with Phase 1** — introduce `.aitriad.json` and `Resolve-DataPath`. This is fully backward-compatible; the config defaults to `.` so nothing changes until you move data.
2. **Test thoroughly** — run all cmdlets, verify all Electron apps still read/write correctly.
3. **Phase 2+3 together** — create data repo and update `.aitriad.json` in one step.
4. **Phase 4** — update docs and README.

## Decision Points

1. **Git LFS for data repo?** — Recommended for source PDFs. Without it, `git clone` downloads 400+ MB.
2. **Rewrite code repo history?** — Optional. Saves space but breaks existing forks/clones. Can defer.
3. **Submodule vs sibling repos?** — Sibling repos are simpler. Submodules add git complexity. Recommend siblings with `.aitriad.json` pointing between them.
4. **Bundled data in Electron?** — Useful for first-run experience. Can bundle a minimal dataset (taxonomy JSONs only, no source PDFs).
