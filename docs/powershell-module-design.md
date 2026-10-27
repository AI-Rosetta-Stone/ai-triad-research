# PowerShell Module (AITriad) — High-Level Design

**Status:** Living document  
**Last updated:** 2026-05-01  
**Author:** Jeffrey Snover  
**Audience:** Engineers, researchers, and contributors who need to understand the module's architecture, pipeline design, and operational model.

---

## 1. Problem Statement

The AI Triad platform requires a scriptable command-line interface for researchers who work iteratively: ingest a paper, generate summaries, detect conflicts, run a debate, inspect results, adjust taxonomy, repeat. GUI tools (the Taxonomy Editor) serve visual workflows, but they can't be composed into pipelines, scheduled in batch jobs, or integrated into CI.

The PowerShell module provides 75 cmdlets that cover the full research lifecycle — from document ingestion through AI-powered analysis to taxonomy refinement — all composable via standard PowerShell pipelines and scriptable for automation.

## 2. Goals and Non-Goals

### Goals

- **G1:** Cover the full research lifecycle: ingest → summarize → detect conflicts → analyze → debate → refine taxonomy
- **G2:** Work cross-platform (Windows, macOS, Linux) on PowerShell 7.0+
- **G3:** Support multiple AI backends (Gemini, Claude, Groq) through a single interface
- **G4:** Be installable from PSGallery with zero manual configuration beyond API keys
- **G5:** Provide composable cmdlets that work with standard PowerShell pipeline patterns
- **G6:** Produce actionable error messages that help users fix problems, not just report them

### Non-Goals

- **NG1:** GUI — the module is CLI-only (it launches Electron apps but doesn't provide its own UI)
- **NG2:** Real-time streaming of AI responses — all AI calls are request/response
- **NG3:** Multi-user coordination — single-operator model
- **NG4:** Compiled cmdlets — pure script module for transparency and editability

## 3. System Context

```
┌──────────────────────────────────────────────────────────────┐
│                    PowerShell Session                         │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  AITriad Module (75 public cmdlets)                    │  │
│  │  ┌──────────┐ ┌──────────────┐ ┌───────────────────┐  │  │
│  │  │ Public/  │ │ Private/     │ │ Prompts/          │  │  │
│  │  │ 75 cmds  │ │ 33 helpers   │ │ 29 templates      │  │  │
│  │  └──────────┘ └──────────────┘ └───────────────────┘  │  │
│  └────────────────────────┬───────────────────────────────┘  │
│                           │ delegates                         │
│  ┌────────────────────────┼───────────────────────────────┐  │
│  │         Companion Modules                               │  │
│  │  ┌─────────────────┐  ┌──────────────────────────┐     │  │
│  │  │ AIEnrich.psm1   │  │ DocConverters.psm1       │     │  │
│  │  │ (AI API calls)  │  │ (PDF/HTML/DOCX → MD)     │     │  │
│  │  └────────┬────────┘  └────────────┬─────────────┘     │  │
│  └───────────┼────────────────────────┼───────────────────┘  │
└──────────────┼────────────────────────┼──────────────────────┘
               │ HTTP                    │ subprocess
               ▼                         ▼
        ┌────────────┐           ┌─────────────────┐
        │ AI Backends│           │ pandoc/pdftotext/│
        │ (Gemini,   │           │ markitdown       │
        │  Claude,   │           │ (external tools) │
        │  Groq)     │           └─────────────────┘
        └────────────┘
```

## 4. Module Architecture

### 4.1 Initialization Sequence

When `Import-Module AITriad` runs:

```
1. Detect runtime context (dev install vs. PSGallery)
   └─ dev: $RepoRoot = repository root (has .aitriad.json)
   └─ PSGallery: $RepoRoot = $PSScriptRoot

2. Define classes (TaxonomyNode, AITSource, AITModelInfo, ClaimsByPov)

3. Load ai-models.json → $script:ModelRegistry
   └─ maps model IDs to backend + API model IDs

4. Dot-source all Private/*.ps1 then Public/*.ps1

5. Import companion modules
   └─ AIEnrich.psm1 (try scripts/ then module root)
   └─ DocConverters.psm1 (same fallback)

6. Resolve data paths (Resolve-DataPath)
   └─ env var > .aitriad.json > platform default
   └─ cache in $script:DataConfig

7. Load taxonomy into memory
   └─ parse all .json files in taxonomy_dir
   └─ skip auxiliary files (embeddings, edges, policies)
   └─ store in $script:TaxonomyData[pov_name]

8. Load policy registry → $script:PolicyRegistry

9. Register -Model argument completers for 17 cmdlets

10. Create aliases (Import-Document, TaxonomyEditor, etc.)
```

All taxonomy data is in-memory after step 7. Subsequent `Get-Tax` queries are zero-I/O operations.

### 4.2 Layering

```
┌────────────────────────────────────────────┐
│ Public Cmdlets (75)                        │  ← user-facing API
├────────────────────────────────────────────┤
│ Private Helpers (33)                       │  ← shared implementation
├──────────────┬─────────────────────────────┤
│ AIEnrich     │ DocConverters               │  ← companion modules
│ (AI calls)   │ (format conversion)         │
├──────────────┴─────────────────────────────┤
│ Prompt Templates (29)                      │  ← LLM interface
├────────────────────────────────────────────┤
│ Data Layer ($script:TaxonomyData, etc.)    │  ← in-memory state
└────────────────────────────────────────────┘
```

Public cmdlets never call AI APIs directly — they delegate to `Invoke-AIApi` (in AIEnrich) or to private pipeline helpers. This separation means backend changes (adding a new AI provider) only touch AIEnrich, not the 75 cmdlets.

## 5. Core Pipeline: POV Summarization

The summarization pipeline is the module's most complex subsystem — a 7-stage process that extracts structured claims from documents and maps them to the taxonomy.

### 5.1 Pipeline Stages

```
Source Document (Markdown)
    │
    ▼
┌─── Stage 1: CHESS Pre-Classification ──────────────────────┐
│ Classify document's POV affinity via text similarity       │
│ Output: candidate POVs for RAG filtering                   │
└────────────────────────────────────────────────┬────────────┘
                                                 ▼
┌─── Stage 2: RAG Context Selection ─────────────────────────┐
│ Embed document (first 500 words + title)                   │
│ Cosine similarity against embeddings.json                  │
│ Select top-N relevant taxonomy nodes                       │
│ (bypass with -FullTaxonomy flag)                           │
└────────────────────────────────────────────────┬────────────┘
                                                 ▼
┌─── Stage 3: AutoFire Stage 1 (optional) ───────────────────┐
│ Quick sniff-test on first 1000 words                       │
│ Determine if FIRE iterative extraction is worthwhile       │
└────────────────────────────────────────────────┬────────────┘
                                                 ▼
┌─── Stage 4: Prompt Construction ───────────────────────────┐
│ Assemble: system instruction + taxonomy context + schema   │
│ For chunked docs: per-chunk prompts                        │
│ Templates from Prompts/ via Get-Prompt                     │
└────────────────────────────────────────────────┬────────────┘
                                                 ▼
┌─── Stage 5: AI Extraction ─────────────────────────────────┐
│ FIRE path: confidence-gated iterative extraction           │
│   └─ per-claim confidence scoring                          │
│   └─ low-confidence claims trigger targeted follow-ups     │
│   └─ guardrails: 5 iter/claim, 20 iter/doc, 5 min wall    │
│ Single-shot path: one AI call (no density retry, t/4473)   │
└────────────────────────────────────────────────┬────────────┘
                                                 ▼
┌─── Stage 6: AutoFire Stage 2 (optional) ───────────────────┐
│ Post-extraction density check                              │
│ If output is low-density, re-run with FIRE                 │
└────────────────────────────────────────────────┬────────────┘
                                                 ▼
┌─── Stage 7: Unmapped Concept Resolution ───────────────────┐
│ Fuzzy-match unrecognized concepts to existing nodes        │
│ Token overlap + semantic similarity ranking                │
│ Output: candidate mappings (auto-apply or review)          │
└────────────────────────────────────────────────┬────────────┘
                                                 ▼
                                         Summary JSON
                                      (summaries/<doc-id>.json)
```

### 5.2 Document Chunking

Large documents are split before processing:

1. **Phase 1:** Split on h2–h4 Markdown headings (preserves document structure)
2. **Phase 2:** Pack sections into chunks up to 15,000 tokens (estimated at 4 chars/token)
3. **Phase 3:** Merge runts (below 2,000 tokens) into the previous chunk

Per-chunk summaries are consolidated via `Merge-ChunkSummaries` to preserve cross-chunk relationships.

### 5.3 Batch Processing

`Invoke-BatchSummary` processes a queue of documents (`$queue_file`) with:
- Parallel workers (configurable via `-Parallel`)
- Per-document error isolation (one failure doesn't stop the batch)
- Automatic conflict detection after each summary (`Find-Conflict`)
- Queue-based retry logic for transient failures

## 6. AI Backend Abstraction (AIEnrich)

### 6.1 Invoke-AIApi

Central dispatcher that routes to the correct backend based on model ID:

```
Invoke-AIApi -Prompt "..." -Model "gemini-2.5-flash" -JsonMode
    │
    ├─ Resolve API key: -ApiKey > $env:GEMINI_API_KEY > $env:AI_API_KEY
    ├─ Look up backend from ai-models.json
    ├─ Build backend-specific HTTP request
    │   ├─ Gemini: generativelanguage.googleapis.com
    │   ├─ Claude: api.anthropic.com (x-api-key header)
    │   ├─ Groq: api.groq.com (OpenAI-compatible)
    │   └─ OpenAI: api.openai.com
    ├─ Send with retry on 429/503/529
    │   └─ delays: 15s, 45s, 90s, 120s (max 5 attempts)
    └─ Parse response → { Text, Backend, Model, Usage, Truncated }
```

### 6.2 Model Registry

`ai-models.json` is the single source of truth for both PowerShell and TypeScript. It maps model IDs to backend and API model IDs:

```json
{
  "gemini-2.5-flash": {
    "backend": "gemini",
    "apiModelId": "gemini-2.5-flash",
    "description": "Gemini 2.5 Flash"
  }
}
```

The `-Model` parameter on 17 cmdlets auto-completes from this registry.

## 7. Document Conversion (DocConverters)

Each format has a fallback chain — if the preferred tool is unavailable, the next one is tried:

| Format | Priority 1 | Priority 2 | Priority 3 | Priority 4 |
|---|---|---|---|---|
| PDF | markitdown | pdftotext + Optimize-PdfText | mutool | "EXTRACTION FAILED" |
| HTML | pandoc | Built-in regex converter | — | — |
| DOCX | markitdown | pandoc | ZIP/XML extraction | — |
| Office | markitdown | — | — | — |

The built-in HTML converter handles: block elements (headings, lists, tables, blockquotes), inline elements (bold, italic, code, links), entity decoding, script/style removal, and whitespace normalization. It exists so the module works without pandoc installed.

## 8. Prompt Template System

29 `.prompt` files loaded via `Get-Prompt -Name '<base-name>' -Replacements @{KEY='value'}`:

- Templates use `{{KEY}}` placeholder syntax
- Loaded from `Prompts/` directory
- Cached in `$script:PromptCache` after first read
- `-AllowUnresolved` flag suppresses warnings for intentionally unfilled placeholders

Templates are the boundary between the module's logic and natural language. When the AI model changes or prompt engineering improves, only template files change — no cmdlet code is modified.

## 9. Error Handling

All unrecoverable errors use `New-ActionableError`:

```powershell
New-ActionableError -Goal "Summarize document" `
                    -Problem "API returned 401 Unauthorized" `
                    -Location "Invoke-POVSummary → Invoke-AIApi" `
                    -NextSteps @(
                        "Check that GEMINI_API_KEY is set correctly",
                        "Run Register-AIBackend to reconfigure",
                        "Try a different model with -Model parameter"
                    )
```

Console output uses themed helpers: `Write-Step` (cyan, major pipeline steps), `Write-OK` (green, success), `Write-Warn` (yellow, non-fatal), `Write-Fail` (red, fatal), `Write-Info` (gray, detail).

## 10. Design Decisions and Trade-offs

### D1: Pure Script Module Over Compiled Cmdlets

**Chosen:** All cmdlets are `.ps1` files, no compiled C# binary.

**Why:** Transparency and editability. Researchers can read and modify cmdlet source directly. Script modules don't require build tooling — `Import-Module` loads them directly. For a research platform where users may need to customize extraction logic, this matters more than performance.

**Trade-off accepted:** Script modules are slower than compiled ones for hot loops. At our scale (75 cmdlets, each calling AI APIs with multi-second latency), PowerShell function dispatch overhead is negligible.

### D2: In-Memory Taxonomy at Import Time

**Chosen:** Load all taxonomy JSON into `$script:TaxonomyData` when the module imports.

**Why:** The taxonomy is small enough (~320 nodes, ~500 KB parsed) that in-memory operation eliminates file I/O from all query paths. `Get-Tax` filtering is instant. The alternative — loading files on demand — would make every query touch disk and require file-level caching logic.

**Trade-off accepted:** Module import takes ~500ms longer (parsing JSON). Changes to taxonomy files on disk aren't reflected until the module is re-imported. In practice, taxonomy edits happen through the module itself (which updates `$script:TaxonomyData` in place), so this is rarely an issue.

### D3: Companion Modules Over Monolithic Module

**Chosen:** AIEnrich and DocConverters as separate `.psm1` files, not merged into AITriad.

**Why:** Separation of concerns. AIEnrich handles AI API abstraction (retry logic, backend routing, token tracking); DocConverters handles document format conversion (pandoc, pdftotext). Neither is specific to the AI Triad taxonomy — they could be reused in other projects. Keeping them separate allows independent testing and versioning.

**Trade-off accepted:** Module import must locate and load companion modules (two fallback paths: `scripts/` for dev, module root for PSGallery). Non-fatal failure if companions are missing — features degrade gracefully.

### D4: FIRE Iterative Extraction (Confidence-Gated Multi-Turn)

**Chosen:** Optional multi-turn extraction with per-claim confidence scoring and targeted follow-ups.

**Why:** Single-shot extraction misses nuanced claims in complex documents. A paper with 30 relevant claims might yield 15 on the first pass. FIRE re-queries on low-confidence claims, bringing coverage to 25+. The confidence gate (default 0.7) prevents infinite loops on genuinely ambiguous claims.

**Trade-off accepted:** FIRE uses 3–5× more API calls than single-shot. Guardrails (5 iter/claim, 20 iter/doc, 5 min wall-clock) prevent runaway costs. AutoFire sniff-tests documents first to avoid FIRE on simple papers where single-shot is sufficient.

### D5: RAG Over Full Taxonomy Injection

**Chosen:** Select top-N relevant taxonomy nodes via embedding similarity; inject only those into the prompt.

**Why:** The full taxonomy (~320 nodes × ~200 chars each ≈ 64K chars) exceeds practical prompt budgets and introduces noise. RAG selects the ~50 most relevant nodes, keeping prompt size manageable and improving extraction precision by focusing the model on relevant claims.

**Trade-off accepted:** RAG can miss relevant nodes with low embedding similarity (recall ~85%). The `-FullTaxonomy` bypass flag exists for cases where exhaustive coverage is more important than precision. CHESS pre-classification narrows the POV search space before RAG, improving recall.

### D6: Cross-Platform File Operations

**Chosen:** All file operations use PowerShell's cross-platform APIs; `Write-Utf8NoBom` ensures consistent encoding.

**Why:** The module runs on Windows, macOS, and Linux. Path separators, line endings, and file encoding must work everywhere. `Write-Utf8NoBom` exists because PowerShell's default `Set-Content` on older versions adds a BOM that breaks JSON parsers on non-Windows systems.

**Trade-off accepted:** Some operations (launching Electron apps, filesystem watching) have platform-specific code paths. These are isolated in `Show-TaxonomyEditor` and similar cmdlets.

### D7: Append-Only Queue for Batch Processing

**Chosen:** `.summarise-queue.json` as an append-only queue file for batch summarization.

**Why:** Batch processing needs crash recovery. If a batch of 50 documents fails at document 23, the queue file records which documents are pending/completed/errored. Re-running `Invoke-BatchSummary` picks up where it left off without re-processing completed documents.

**Trade-off accepted:** The queue file can grow stale (referencing documents that no longer exist). Manual cleanup is occasionally needed.

## 11. Risks and Open Questions

| Risk | Impact | Mitigation |
|---|---|---|
| **PSGallery distribution** | Module must work without companion files | Fallback paths + graceful degradation |
| **API key management** | Users must configure keys for each backend | `Register-AIBackend` provides guided setup; `$AI_API_KEY` fallback works for gemini-only users (other backends need their own variable, t/4102) |
| **Prompt template drift** | Templates may not match current model capabilities | Templates are model-agnostic; temperature/schema controls handle model differences |
| **Document conversion quality** | pdftotext and markitdown produce imperfect Markdown | `Optimize-PdfText` post-processing; fallback chain tries multiple tools |
| **Taxonomy lock during import** | Re-importing module resets in-memory state | By design — module is session-scoped; changes persist to disk via cmdlets |

## 12. Glossary

| Term | Definition |
|---|---|
| **CHESS** | Document pre-classification determining which POVs are relevant |
| **RAG** | Retrieval-Augmented Generation — embedding-based context selection |
| **FIRE** | Confidence-gated iterative extraction — multi-turn claim extraction with per-claim follow-ups |
| **AutoFire** | Two-stage sniff-test deciding whether FIRE is worth the extra API calls |
| **ActionableError** | Error format with Goal, Problem, Location, and Next Steps |
| **Companion module** | AIEnrich.psm1 or DocConverters.psm1 — loaded alongside AITriad |
| **PSGallery** | PowerShell Gallery — public module registry for distribution |
