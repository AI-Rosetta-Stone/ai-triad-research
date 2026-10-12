# AI Triad Research

**Status:** Private
**Fellowship:** Berkman Klein Center, 2026

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
| `NEO4J_PASSWORD` | No | Neo4j password (default: aitriad2026) |

Use `Register-AIBackend` to configure keys via a GUI, or set them manually.
Settings are persisted to `~/.aitriad-env` — add `. ~/.aitriad-env` to your shell profile.

## AI Model Configuration

Models are configured in `ai-models.json` (single source of truth for both PowerShell and Electron). The Taxonomy Editor Settings dialog includes a **Refresh Models** button that queries provider APIs (Gemini, Groq) and probes Claude model candidates to discover available models.

Supported backends: **Google Gemini** (free tier available), **Anthropic Claude**, **Groq** (free tier available).

## Taxonomy Version

Current version is tracked in `TAXONOMY_VERSION` (in the data repo). Bumping it triggers CI batch re-summarization.
