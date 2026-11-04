# AI Triad Research

**Status:** Private

## Purpose

Multi-perspective research platform for AI policy and safety literature. Organizes sources through a four-POV taxonomy (accelerationist, safetyist, skeptic, situations), ingests documents, generates AI-powered summaries, and detects factual conflicts across viewpoints.

## Repository Structure

This project uses three repositories:

| Repository | Contents |
|-----------|----------|
| **[ai-triad-research](https://github.com/AI-Rosetta-Stone/ai-triad-research)** (this repo) | PowerShell module, shared TypeScript lib, Electron apps, prompts, schemas |
| **[ai-triad-data](https://github.com/AI-Rosetta-Stone/ai-triad-data)** | Taxonomy, summaries, conflicts, debates |
| **ai-triad-sources** | Ingested source documents (~680 documents: PDFs, snapshots) |

```
ai-triad-research/              CODE REPO
├── scripts/AITriad/            PowerShell module (145 cmdlets)
│   ├── Public/                 Exported functions
│   ├── Private/                Internal helpers
│   └── Prompts/                AI prompt templates
├── scripts/AIEnrich.psm1       Multi-backend AI API abstraction
├── scripts/DocConverters.psm1  PDF/DOCX/HTML → Markdown
├── lib/                        Shared TypeScript (debate engine, ai-client, flight recorder)
├── taxonomy-editor/            Electron + React desktop app / hosted web app
├── poviewer/                   POV analysis viewer (Electron)
├── summary-viewer/             Summary browser (Electron)
├── taxonomy/schemas/           JSON validation schemas
├── deploy/azure/               Bicep IaC for the hosted web app
├── ai-models.json              AI model configuration
├── ai-usages.json              UsageID → AI call parameter registry
├── .aitriad.json               Data path configuration
└── docs/                       Documentation

ai-triad-data/                  DATA REPO
├── taxonomy/Origin/            POV taxonomies + edges + embeddings
├── summaries/                  ~700 AI-generated POV summaries
├── conflicts/                  ~1,250 auto-detected factual conflicts
├── debates/                    Structured debate sessions
├── .summarise-queue.json       Pending summary queue
└── TAXONOMY_VERSION            Schema version trigger

ai-triad-sources/               SOURCES REPO
└── src-*/                      One directory per ingested document
```

## Quick Start

### Prerequisites

- **PowerShell 7+** — [Install](https://aka.ms/powershell)
- **Node.js 20+** — [Install](https://nodejs.org/)
- **At least one AI API key** — Gemini (free tier), Claude, or Groq

### Setup

For development, there are two ways to do spin up the platform.

#### Run Directly on Host Machine

```powershell
# 1. Clone the repos as siblings (sources repo optional unless ingesting)
cd ~/source/repos
git clone https://github.com/AI-Rosetta-Stone/ai-triad-research.git
git clone https://github.com/AI-Rosetta-Stone/ai-triad-data.git

# 2. Load the module
cd ai-triad-research
Import-Module ./scripts/AITriad/AITriad.psm1

# 3. Check dependencies (installs missing ones with -Fix)
Install-AIDependencies -Fix

# 4. Configure your AI API key (opens a browser-based UI)
Register-AIBackend

# 5. Verify everything works
Test-Dependencies
Get-Tax | Measure-Object   # Should show several hundred nodes (785 POV nodes as of 2026-07)
```

#### Run in Dev Container

The containerized version of the platform is a multi-container application
(since Neo4j runs in its own container). The project source code is accessed via
a volume rather than being copied into a container, which allows for live edits.

Before starting the container, copy `.env.example` to `.env` next to `compose.yaml`
(docker compose loads it automatically) and set a Neo4j password of your own plus at
least one AI API key. Compose refuses to start without `NEO4J_PASSWORD`:

```bash
# .env
NEO4J_PASSWORD=choose-your-own
GEMINI_API_KEY=your-key-here
```

All ports are published on `127.0.0.1` only, because the dev server runs with
`AUTH_DISABLED`.

`Register-AIBackend`'s browser-based setup UI doesn't work from inside the
container — it binds to `127.0.0.1`, which inside a container is only reachable
from that container itself, not from the host, even with the port published. So
for the dev container, API keys are set directly as environment variables
instead; `Register-AIBackend` remains the way to configure keys when running
directly on your host machine (see above).

To build the app image and run with neo4j:

```bash
docker compose --profile graph up --build
```

To build the app image and run without neo4j (default):

```bash
docker compose up --build
```

Or build then run:

```bash
docker compose build
docker compose up
```

The above commands for the PowerShell dev setup (`Import-Module`,
`Install-AIDependencies -Fix`, `Get-Tax`) get run in the container via
`scripts/dev-bootstrap.sh`. If no AI API key is set, bootstrap prints a reminder
to add one to `.env` and restart.

Useful for Development:

```bash
  # watch bootstrap + app output
  docker compose logs -f app
  # shell into the running container
  docker compose exec app bash
  # PowerShell session
  docker compose exec app pwsh
  # status
  docker compose ps
```

Tear down:

```bash
  # stop/remove containers (keeps volumes)
  docker compose down
  # include the profiled neo4j service
  docker compose --profile graph down
  # also wipe volumes (pnpm-store, neo4j-data/logs)
  docker compose --profile graph down -v
```

Running taxonomy-editor dev application using `npm`:

```bash
  export AUTH_DISABLED=1
  cd taxonomy-editor
  npm run dev:container
  # health check when taxonomy-editor is running
  curl -sf http://localhost:7862/health && echo
```

The `AUTH_DISABLED` env variable here is necessary here for full functionality,
since you can't log in with a local deployment. Note that if `NODE_ENV` gets set
to `production`, `AUTH_DISABLED` won't actually disable authorization.

Then verify that this is working by visiting `http://localhost:5173/`. This is
probably best for simple development (allows for Vite's hot reloading), but to
better match deployment conditions, use a container service by starting up
Docker with

```bash
  docker compose --profile all
```

or

```bash
  docker compose --profile taxonomy-editor
```

### Testing in Development

The full pester test suite takes quite a while to run, and so usually should not
be used. To run a specific test file, for instance `AICallLog.Tests.ps1`, you
can do

```pwsh
Invoke-Pester ./tests/AICallLog.Tests.ps1 -Output Detailed
```

or, from bash,

```bash
pwsh -Command "Invoke-Pester ./tests/AICallLog.Tests.ps1 -Output Detailed"
```

It should be noted that since tests are available through the mounted
`:/workspaes/ai-triad-research`, they can be used in the `app` service but not
elsewhere.

Some useful commands for testing from within the containerized development
environment and PowerShell:

```pwsh
# Smoke test
Invoke-Pester ./tests/AITriad.Module.Tests.ps1, ./tests/TriadConfig.Tests.ps1 -Output Detailed
# Full test, which takes quite a while to run
./scripts/Invoke-BoundedTestRun.ps1 -OutputLevel Normal
```

These can also be run via `docker compose exec app pwsh -NoProfile -c "..."`

Or you can let `Test-Scope.ps1` pick the tests to run. This looks at the diff
between staged and unstaged changes, and scopes testing on the basis of this.
So you have to do this PRIOR to staging changes.

```pwsh
./scripts/Test-Scope.ps1 # print recommended
./scripts/Test-Scope.ps1 -Run # run the tests
```

### Data Path Configuration

The file `.aitriad.json` tells the code where to find data:

```json
{
  "data_root": "../ai-triad-data",
  "sources_root": "../ai-triad-sources",
  "taxonomy_dir": "taxonomy/Origin",
  "sources_dir": "sources",
  "summaries_dir": "summaries",
  "conflicts_dir": "conflicts",
  "debates_dir": "debates",
  "queue_file": ".summarise-queue.json",
  "version_file": "TAXONOMY_VERSION"
}
```

Note: source documents resolve under `sources_root` (a separate repo), not `data_root`.

**Override with environment variable:**
```powershell
$env:AI_TRIAD_DATA_ROOT = "/path/to/custom/data"
```

**Priority:** `$env:AI_TRIAD_DATA_ROOT` > `.aitriad.json` > monorepo fallback

### Optional Setup

```powershell
# Python embeddings (for semantic search)
pip install -r scripts/requirements.txt
Update-TaxEmbeddings

# Neo4j graph database (requires Docker)
Install-GraphDatabase

# Install Electron app dependencies
cd taxonomy-editor && npm install && cd ..
cd poviewer && npm install && cd ..
cd summary-viewer && npm install && cd ..
```

### Desktop Apps

```powershell
Show-TaxonomyEditor    # or: TaxonomyEditor
Show-POViewer          # or: POViewer
Show-SummaryViewer     # or: SummaryViewer
```

The Taxonomy Editor includes an integrated Edge Browser (toolbar panel) — the standalone Edge Viewer has been retired.

### Core Workflow

```powershell
# Ingest a document
Import-AITriadDocument -Path paper.pdf -Title "Paper Title" -PovTags accelerationist

# Generate POV summaries
Invoke-POVSummary -DocId paper-title-2026

# Detect conflicts across summaries
Find-Conflict -DocId paper-title-2026

# Extract policy actions from taxonomy nodes
Find-PolicyAction -POV accelerationist

# Identify possible fallacies
Find-PossibleFallacy -POV safetyist

# View taxonomy health
Get-TaxonomyHealth -GraphMode

# Run a three-agent debate
Show-TriadDialogue "Should AI be regulated like a public utility?"

# Get full help
Show-AITriadHelp
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GEMINI_API_KEY` | Yes (primary) | Google Gemini API key |
| `ANTHROPIC_API_KEY` | No | Anthropic Claude API key |
| `GROQ_API_KEY` | No | Groq API key |
| `AI_API_KEY` | No | Fallback key. PowerShell uses it for gemini models only; other backends need their own variable (t/4102) |
| `AI_MODEL` | No | Default model override |
| `AI_TRIAD_DATA_ROOT` | No | Override data directory path |
| `NEO4J_PASSWORD` | For docker compose | Neo4j password. Required by `compose.yaml` (no default). `Install-GraphDatabase` generates one if unset. |

Use `Register-AIBackend` to configure keys via a GUI, or set them manually.
Settings are persisted to `~/.aitriad-env` — add `. ~/.aitriad-env` to your shell profile.

## AI Model Configuration

Models are configured in `ai-models.json` (single source of truth for both PowerShell and Electron). The Taxonomy Editor Settings dialog includes a **Refresh Models** button that queries provider APIs (Gemini, Groq) and probes Claude model candidates to discover available models.

Supported backends: **Google Gemini** (free tier available), **Anthropic Claude**, **Groq** (free tier available).

## Taxonomy Version

Current version is tracked in `TAXONOMY_VERSION` (in the data repo). Bumping it triggers CI batch re-summarization.
