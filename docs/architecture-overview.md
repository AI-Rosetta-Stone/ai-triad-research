# AI Triad Research — System Architecture

## Purpose

AI Triad Research is a multi-perspective research platform for AI policy and safety literature. It organizes scholarly arguments into a structured taxonomy, detects conflicts between perspectives, and simulates structured debates between three AI-driven characters representing distinct viewpoints.

The system serves researchers, policy analysts, and scholars who need to understand the landscape of AI governance arguments — not just what people are saying, but how those arguments relate to, support, and contradict each other.

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      User Interfaces                        │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │  Taxonomy     │  │  POV         │  │  Summary         │  │
│  │  Editor       │  │  Viewer      │  │  Viewer          │  │
│  │  (Electron)   │  │  (Electron)  │  │  (Electron)      │  │
│  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘  │
│         │                  │                    │            │
│  ┌──────┴──────────────────┴────────────────────┴─────────┐ │
│  │              Shared TypeScript Libraries                │ │
│  │  lib/debate/  ·  lib/dictionary/  ·  lib/translation/  │ │
│  └──────────────────────────┬─────────────────────────────┘ │
└─────────────────────────────┼───────────────────────────────┘
                              │
┌─────────────────────────────┼───────────────────────────────┐
│              PowerShell Module (AITriad)                     │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐   │
│  │148 Public│ │86 Private│ │42 Prompt │ │  Companion    │   │
│  │ Cmdlets  │ │ Helpers  │ │Templates │ │  Modules      │   │
│  │          │ │          │ │          │ │ AIEnrich.psm1 │   │
│  │          │ │          │ │          │ │ DocConvert.psm│   │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────┘   │
└─────────────────────────────┼───────────────────────────────┘
                              │
┌─────────────────────────────┼───────────────────────────────┐
│                  AI Backends                                 │
│    Gemini · Claude · Groq · OpenAI · DeepSeek                │
│    Azure · Z.AI · Moonshot · Ollama (local)                  │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────┼───────────────────────────────┐
│                   Data Layer                                 │
│  ┌───────────────────────────────────────────────────────┐  │
│  │              ai-triad-data (sibling repo, ~410 MB)    │  │
│  │  taxonomy/  summaries/  conflicts/  debates/          │  │
│  └───────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────┐  │
│  │         ai-triad-sources (local-only, ~200 docs)      │  │
│  │  sources/  (PDFs, DOCX, HTML — not in web mode)       │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌───────────────────────────────────────────────────────┐  │
│  │        GitHub API Backend (web/container mode)         │  │
│  │  StorageBackend ─► GitHubAPIBackend ─► SSD cache      │  │
│  │  STORAGE_MODE=github-api | filesystem                 │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## Repository Split

Code, data, and source documents live in separate repositories:

| Repository | Contents | Size | Access |
|---|---|---|---|
| `ai-triad-research` (this repo) | All source code, scripts, Electron apps, CI/CD | ~50 MB | GitHub |
| `ai-triad-data` (sibling) | Taxonomy JSON, summaries, conflicts, debates, embeddings | ~410 MB | GitHub (API in web mode) |
| `ai-triad-sources` (local-only) | Source PDFs, DOCX, HTML documents (~200 files) | Variable | Local filesystem only |

**Sources separation:** Source documents were moved to a dedicated `ai-triad-sources` repo to keep `ai-triad-data` focused on structured JSON data accessible via the GitHub API. Summaries (derived from sources) remain in `ai-triad-data`. Sources are unavailable in web/container mode — the UI shows summaries and metadata but not original documents.

The file `.aitriad.json` in the code repo maps relative paths to data directories. Data paths resolve in priority order: `$env:AI_TRIAD_DATA_ROOT` > `.aitriad.json` > platform-specific default (`%LOCALAPPDATA%\AITriad\data` on Windows, `~/Library/Application Support/AITriad/data` on macOS, `$XDG_DATA_HOME/aitriad/data` on Linux).

### Data Backend (GitHub API-First)

The Taxonomy Editor's web deployment uses the **GitHub API-First** backend — reading and writing `ai-triad-data` directly via the GitHub REST API instead of local filesystem I/O.

**`StorageBackend` interface** — A 5-method abstraction (`readFile`, `writeFile`, `listDirectory`, `deleteFile`, `fileExists`) with two implementations:

| Backend | `STORAGE_MODE` | Use Case |
|---|---|---|
| `FilesystemBackend` | `filesystem` | Electron desktop app, local development |
| `GitHubAPIBackend` | `github-api` | Azure Container Apps web deployment |

`fileIO.ts` keeps all domain logic (40+ functions for taxonomy, conflicts, edges, debates) but delegates raw I/O to the active backend. This minimizes blast radius — only the 5 I/O primitives are swapped.

**Session context:** In API mode, server middleware resolves the authenticated user (from Azure Easy Auth headers) into a `SessionContext`. Reads target the user's session branch (if one exists) or `main`. Writes always target the user's `api-session/{userId}` branch (lazy-created on first edit). The cache has two layers: a shared main cache and per-user session overlays.

**Local SSD cache** (`/tmp/taxonomy-cache/`) — Ephemeral cache with SHA-based manifest. On startup, if the cached SHA matches GitHub's `main` HEAD, the app serves entirely from cache (0 API calls, <100ms). Polling every 60s checks for changes; webhook acceleration reduces the stale window to ~2s.

**Authentication:** GitHub App installation tokens (PEM in Azure Key Vault, 1-hour TTL, auto-refresh). Rate budget: ~145 calls/hr against 5,000/hr limit (97% headroom).

For the complete technical specification, see [GitHub API-First Implementation Plan](./github-api-first-implementation.md).

## Major Subsystems

### 1. Taxonomy Model

The core data structure — a graph of 889 POV nodes (~1,330 total incl. 441 situation nodes) representing arguments about AI policy, organized by perspective and argument type. Four POV camps (Accelerationist, Safetyist, Skeptic, Situations) each decomposed into Belief-Desire-Intention categories. Nodes link to each other via typed edges (SUPPORTS, CONTRADICTS, ASSUMES, etc.) and reference shared policy actions from a centralized registry of 1,547 policies.

**See:** [Taxonomy & Data Model](./subsystem-taxonomy.md)

### 2. PowerShell Module

148 public cmdlets for taxonomy queries, document ingestion, AI-powered summarization, conflict detection, graph analysis, and debate orchestration. Companion modules handle multi-backend AI abstraction (AIEnrich) and document format conversion (DocConverters).

**See:** [PowerShell Module](./subsystem-powershell.md)

### 3. Debate Engine

A three-agent BDI debate system in TypeScript (`lib/debate/`, 129 non-test files / 228 incl. tests). Characters (Accelerationist, Safetyist, Skeptic) argue grounded in the taxonomy, with a moderator agent managing interventions, convergence detection, and phase transitions. Produces structured transcripts with QBAF (Quantitative Bipolar Argumentation Framework) networks.

**Debate phases:** confrontation → argumentation → concluding (with adaptive phase transitions based on convergence signals).

**Four-stage turn pipeline:** Each debate turn passes through BRIEF → PLAN → DRAFT → CITE stages with per-stage validation and retry:

| Stage | Purpose | Output |
|---|---|---|
| **BRIEF** | Situational analysis — what happened, what's at stake | `BriefWorkProduct` |
| **PLAN** | Argument strategy — which moves, which nodes to cite | `PlanWorkProduct` |
| **DRAFT** | Full statement generation with a quality pre-check (grounding, falsifiability, engagement) | `DraftWorkProduct` |
| **CITE** | Citation extraction — taxonomy node refs, evidence claims, QBAF edges | `CiteWorkProduct` |

Retry hierarchy: per-stage retry (cheap, re-prompts a single stage) → orchestration retry (expensive, restarts the full pipeline).

**Two-stage turn validation:**

- **Stage A (Symbolic):** 10 deterministic rules via `validatePlanStage`, `validateDraftStage`, and `validateCiteStage` — checks schema conformance, grounding, taxonomy references, and directive compliance
- **Stage B (LLM Judge):** AI-powered quality assessment with calibration cap enforcement. Can be skipped with `deterministicOnly: true`.

**Convergence diagnostics:** 7 deterministic signals for detecting when a debate should transition toward concluding:

1. **Argument redundancy** — lexical self-overlap + semantic cosine similarity (recycling detection)
2. **Dialectical engagement** — ratio of targeted responses vs. standalone assertions
3. **Move polarity** — confrontational vs. collaborative move ratio
4. **Position drift** — how much characters' positions are shifting
5. **Concession opportunity** — whether characters are acknowledging opposing points
6. **Crux resolution** — have the core disagreements been identified and addressed?
7. **Pragmatic convergence** — hedge rate changes, qualification drops in concluding phase

**Evidence pipeline:** Claims are backed by source evidence with QBAF scoring. The engine retrieves relevant sources from the corpus, attaches verification status, and builds evidence-weighted argument networks.

**See:** [Debate Engine](./subsystem-debate-engine.md)

### 4. Taxonomy Editor

The primary user interface — an Electron + React application for editing taxonomy nodes, running debates, viewing argument graphs, and managing the research workflow. Deploys both as a desktop app and as a containerized web app on Azure.

**See:** [Taxonomy Editor](./subsystem-taxonomy-editor.md)

### 5. Supporting Applications

Two additional Electron apps: POViewer (three-pane document viewer with PDF rendering and AI summarization) and Summary Viewer (summary browser).

### 6. Infrastructure & Deployment

GitHub Actions CI/CD, Docker multi-platform builds, Azure Container Apps deployment via Bicep, GitHub API-First data backend with local SSD cache, and a BYOK (Bring Your Own Key) model for API key management.

**See:** [Infrastructure & Deployment](./subsystem-infrastructure.md), [Infrastructure Design](./infrastructure-design.md)

## AI Backend Architecture

All AI calls route through a unified abstraction layer. The PowerShell side uses `Invoke-AIApi` (in AIEnrich.psm1); the TypeScript side uses `aiAdapter.ts`. Both read from `ai-models.json` — the single source of truth for model IDs, backend mappings, and API endpoints.

| Backend | API Endpoint | Key Env Var | Default Model |
|---|---|---|---|
| Google Gemini | generativelanguage.googleapis.com | `GEMINI_API_KEY` | gemini-3.6-flash |
| Anthropic Claude | api.anthropic.com | `ANTHROPIC_API_KEY` | claude-sonnet-4-6 |
| Groq | api.groq.com | `GROQ_API_KEY` | openai/gpt-oss-120b |
| OpenAI | api.openai.com | `OPENAI_API_KEY` | — |
| DeepSeek | api.deepseek.com | `DEEPSEEK_API_KEY` | deepseek-v4-flash |
| Azure OpenAI | $AZURE_OPENAI_ENDPOINT | `AZURE_OPENAI_API_KEY` | gpt-4o |
| Z.AI (GLM) | api.z.ai | `ZAI_API_KEY` | glm-5.2 |
| Moonshot (Kimi) | api.moonshot.ai | `MOONSHOT_API_KEY` | kimi-k3 |
| Ollama (local) | localhost:11434 | — | gemma4:e4b-it-q4_K_M |

Fallback key: in the PowerShell module, `$AI_API_KEY` is used only for gemini models when `GEMINI_API_KEY` is unset; every other backend needs its own variable (t/4102).

Retry strategy: exponential backoff on HTTP 429/503/529, with delays of 15/45/90/120 seconds across up to 5 attempts.

### Azure OpenAI is bring-your-own (t/3554)

Unlike every other backend above, Azure has no shared endpoint — **the deployments live in *your* Azure OpenAI resource, not the project's.** The project hosts none. `$AZURE_OPENAI_ENDPOINT` points at your resource.

**Name your deployment exactly after the model.** The provider builds its URL as `{endpoint}/openai/deployments/{apiModelId}/chat/completions`, so the registry's `apiModelId` **is** the deployment name it requests — there is no translation step. Every azure entry in `ai-models.json` uses the bare Azure OpenAI catalog name (`gpt-4o`, `gpt-4o-mini`, `gpt-4.1`, `gpt-4.1-mini`), so a deployment you named `my-gpt4o` will not be found.

**A 404 selecting an azure model is almost always local, not a platform fault.** In order of likelihood:
1. You haven't created that deployment in your resource.
2. Your deployment has a different name than the model id (see above).
3. The model isn't available in your resource's region, or not for your deployment type.

**Adding a new azure model** to the registry: the test is *"does Azure publish it under this exact catalog name, reachable through the Azure OpenAI `/openai/deployments/` API?"* — not *"is it sold by Azure."* The Microsoft Foundry catalog is broader than the Azure OpenAI API surface, and some Foundry models are served from a different endpoint shape this provider does not speak.

## Data Flow

### Document Ingestion Pipeline

```
URL or File
    │
    ▼
Import-AITriadDocument ── slug generation, raw storage, Markdown snapshot
    │
    ▼
Invoke-POVSummary ── CHESS classification → RAG → AI extraction (FIRE or single-shot)
    │
    ▼
Find-Conflict / Invoke-QbafConflictAnalysis ── cross-summary conflict detection
    │
    ▼
Taxonomy Updates ── new nodes, edges, policy mappings
```

### Debate Flow

```
Topic + optional source document
    │
    ▼
Document Analysis ── extract claims, tension points, I-nodes
    │
    ▼
Edit Claims (optional) ── user reviews/edits extracted claims
    │
    ▼
Opening Statements ── each character states position grounded in taxonomy
    │
    ▼
Confrontation ── initial position clashes, distinguish and counterexample moves
    │                  └── each turn: BRIEF → PLAN → DRAFT → CITE pipeline
    │
    ▼
Argumentation ── deep engagement, crux identification, evidence exchange
    │                  └── moderator: budget, cooldown, drift detection
    │
    ▼
Concluding ── convergence detection, integration, final statements
    │
    ▼
QBAF Network ── quantified argument strengths and relationships
```

## Error Handling

All unrecoverable errors use `New-ActionableError` (PowerShell) or `ActionableError` (TypeScript) with four fields: Goal, Problem, Location, Next Steps. The convention is documented in `docs/error-handling.md`. Recovery (retry, fallback, partial results) is always preferred over hard failure.

## Testing

| Layer | Framework | Location | Run Command |
|---|---|---|---|
| PowerShell module | Pester | `tests/` | `Invoke-Pester ./tests/` |
| Debate engine | Vitest | `lib/debate/*.test.ts` | `npm test` (from repo root) |
| Dictionary/Translation | Vitest | `lib/dictionary/__tests__/`, `lib/translation/__tests__/` | `npm test` |
| Taxonomy Editor | Vitest | `taxonomy-editor/` | `cd taxonomy-editor && npm test` |

## CI/CD

Two primary CI jobs run on every push/PR to main:
1. **test-powershell** — Pester tests, module build, manifest validation
2. **test-electron** — npm install, TypeScript check, Electron build

Additional workflows handle releases (triggered by `v*` tags), Azure deployment (manual), Docker builds, batch summarization, and conflict clustering.

## Related Documentation

| Document | Purpose |
|---|---|
| [Taxonomy & Data Model](./subsystem-taxonomy.md) | Node structure, POV camps, BDI categories, edges, policies, embeddings |
| [PowerShell Module](./subsystem-powershell.md) | 148 cmdlets, companion modules, prompt templates, data resolution |
| [Debate Engine](./subsystem-debate-engine.md) | Three-agent debates, moderator system, QBAF, phase transitions |
| [Taxonomy Editor](./subsystem-taxonomy-editor.md) | Electron app, React components, Zustand stores, IPC layer |
| [Infrastructure & Deployment](./subsystem-infrastructure.md) | CI/CD, Docker, Azure, BYOK key management |
| [Error Handling](./error-handling.md) | ActionableError convention and examples |
| [Debate System Overview](./debate-system-overview.md) | End-to-end debate flow (existing doc) |
