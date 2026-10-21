# AITriad Cmdlet Reference

Full reference for the `AITriad` PowerShell module (110+ cmdlets). This was extracted from the root `AGENTS.md` to keep per-agent context small — the root now carries only a pointer here.

**Prefer these cmdlets over reading raw JSON files or re-implementing logic in code.** They are faster, cheaper (no LLM call), and tested.

```powershell
Import-Module ./scripts/AITriad/AITriad.psm1   # required first
Show-AITriadHelp                                # browse all cmdlets
Get-Help <CmdletName> -Full                     # full docs for any cmdlet
```

**Canonical parameter names (t/1345):** `-Path` for the input file/directory, `-OutputPath` for the output artifact. Cmdlets whose native param is `ConfigPath`/`DocPath`/`From`/etc. also accept `-Path`; cmdlets whose native param is `OutputFile`/`OutputDirectory`/`OutputDir` also accept `-OutputPath`. Aliases only — the native names still work for backward compatibility.

### Taxonomy Data
| Cmdlet | Use when |
|--------|----------|
| `Get-Tax` | Load full taxonomy (nodes, edges, metadata) |
| `Get-GraphNode` | Look up a specific node by ID |
| `Get-Edge` | Fetch edges (filter by source/target/type) |
| `Get-Concept` | Read the standardized dictionary (concepts, `term:*`) as objects; filter by `-Slug`/`-Camp`/`-Status`, reverse concept↔node map via `-UsedByNode <id>`, `-IncludeColloquial` adds colloquial terms (t/3291) |
| `Get-Situation` | List/filter situations (by id/label/text/linked-node/camp); reports per-POV supporting-evidence counts derived from `linked_nodes` |
| `Get-Policy` | Look up policy actions from the registry |
| `Get-TaxonomyHealth` | Check node/edge counts, orphans, structural issues |
| `Compare-Taxonomy` | Diff two taxonomy states |
| `Test-TaxonomyIntegrity` | Validate referential integrity — dangling refs, edge source/target resolution, self-loop edges, and situation⇄POV reciprocity (`SituationReciprocity`, warn-first); `-Repair` strips bad/self-loop edges and dangling refs, first writing a restorable audit of every prune (full edge objects) to `<data root>/audit/integrity-repair/` (`-AuditDir` to override) and warning with the missing IDs; an audit-write failure aborts before any file changes; pruning >20 edges requires `-Force` (edges.json left byte-identical if blocked; t/3853) (see `Test-OrganizationIntegrity` for the Organization slice) |
| `Repair-SituationReciprocity` | Reconcile situation `linked_nodes` ⇄ POV-node `situation_refs` so the two directions are mutual (t/2979); a dry-run-first RECOVERY tool, clean-tree-required, no commit/push. Use when the reciprocity check flags drift |
| `Add-SituationEvidenceLink` | Commit embedding-proposed situation→POV evidence links from a Stage-1 proposal JSON (WS-B, t/3015): writes both directions + `evidence_provenance` stamp, collision-guards authored links, idempotent, clean-tree-required, no commit/push. `-DryRun` to preview; `-Purge -BatchId <id>` to roll back a machine batch |
| `Test-TaxonomyDir` | Pre-validate the taxonomy dir against the embed_taxonomy.py loader contract before `Update-TaxEmbeddings` — reports which files would be ingested vs skipped and flags any ingested file whose `nodes` lack `id` (the shape that crashes the embed run, t/2875) |
| `Test-OntologyCompliance` | Check nodes against ontology rules |
| `Test-SituationBdiCompliance` | Data-boundary gate validator: assert situations carry full per-POV BDI decomposition (belief+desire+intention across acc/saf/skp). `-ChangedOnly -BaseRef <ref>` scopes to new/modified situations vs a git baseline; `-FailOnViolation` throws (non-zero exit) for CI/hook gate use (t/3011) |
| `Get-NodeTestingRecord` | Debate-Tested Phase 2 research surface — filter/sort POV nodes by tier, stale-hash, or importance×deficit (t/1579) |
| `Update-NodeTestingRecord -RecomputeOnly` | Recompute tier + sort_key across all nodes after a constant change; historical record[] never touched; idempotent (t/1579) |

### Organizations (t/1224)
| Cmdlet | Use when |
|--------|----------|
| `Get-Organization` | Look up organization by id or search by name/type |
| `Find-OrganizationByPOV` | Filter organizations by POV alignment score window |
| `Find-OrganizationByTopic` | Find organizations engaged with a specific situation (sit-*) |
| `Get-OrganizationStakeholders` | Get supporters/opposers for a policy action (pol-*) |
| `Import-Organization` | Create or update an organization record (upsert + integrity check) |
| `Compare-OrganizationPositions` | Side-by-side POV alignment table for 2+ organizations |
| `Get-OrganizationEdge` | Look up organization actor-relationship edges (filter by OrgId, Type, Direction; t/1526) |
| `Import-OrganizationEdge` | Upsert an organization actor edge by (source,target,type) composite key with integrity check (t/1526) |

### Entities (t/1804)
| Cmdlet | Use when |
|--------|----------|
| `Get-Entity` | Resolve an entity record (ent-*) from entities.json; follows merge tombstones to the canonical record and stamps `redirected_from` (t/1804) |
| `Import-Entity` | Curation write: upsert 1-20 proposed/approved/deprecated entity records with a never-reused ent-NNN allocator; person records need a human description to approve (t/1804) |
| `Update-EntityEmbeddings` | Backfill/refresh entity_embeddings.json to the v2 multi-vector shape ({name_vector, description_vector?}) for all approved entities; idempotent via per-entity `_src_hash` (skips unchanged), batches all re-embeds into one call, `-Force` re-embeds all, `-WhatIf` previews. Use when populating vectors after approvals or a model swap (t/3121) |
| `Invoke-EntityExtraction` | Phase 1 entity extraction from source_evidence_index.json facts; resolves against existing entities/orgs/taxonomy/dictionary/policy before minting only the unmatched remainder (t/1806). Existing-entity name similarity is advisory only and never links (t/4075) |
| `Get-EntityExtractionCandidates` | Review the advisory existing-entity candidates `Invoke-EntityExtraction` recorded (similarity, rank, `VersionSibling`); confirm a real duplicate with `Import-Entity` `merged_into`. `VersionSibling = $false` is not "safe to merge" (t/4075) |
| `Get-EntityReport` | Maintenance reports: near-duplicate entities, provenance orphans, dictionary-collision candidates, merge-chain defects, `relation-dag` invariants (acyclic + depth≤3 over persisted `relations[]`, t/3170) (t/1806) |
| `Update-EntityMentionIndex` | Phase 2-B batch re-index: rebuilds the derived `entity_mentions.json` by alias-first, deterministic matching of entities against **`{sei:*, summary:*}`** container text (SEI facts + summary key-points/claims). **`node:*` grounding moved to CL's Python reconciler** (t/3160 G7 disjoint-scope contract); this cmdlet never emits a `node:*` key. Indexes `-Status` entities only (default `approved`, per §5 / the D1 caller-filters-to-approved contract); widen to `-Status approved,proposed` for an explicit preview. Populated statuses recorded in the envelope's `indexed_status`. Idempotent via per-container `text_sha256`, human mentions win, normalization mirrors the D1 parity contract (t/1894, t/1982, t/3122, t/3160) |
| `Update-ClaimEntityRef` | Claim-side entity grounding: writes `entity_refs[]` (Shared Lib `EntityLinkRef`) onto summary `key_points`/`factual_claims` by **precise-only** surface/alias matching against the approved register — mirrors CL's node reconciler; **no entity-embedding rung** (§13.3 propose-only, Andreessen-45). Refs written by this pass, never the extraction LLM (R2.3). Idempotent (only changed files rewritten; a claim that resolves to nothing has its `entity_refs` removed). `-Status` (default `approved`), `-SummariesPath`, `-Force`, `-WhatIf` (t/3124) |
| `Invoke-LogicalFormPass` | FOL Phase-1 formalization: attaches a neo-Davidsonian `logical_form` (schema t/3126, `logical-form-schema.md`) to summary `key_points`/`factual_claims` via the `enrichment.logical-form-formalization` UsageID. Runs **after** `Update-ClaimEntityRef` — reads each claim's `entity_refs[]`, joins `dolce_category`→`args[].sort`, and **enforces** grounding (every `ent-*` arg must come from the claim's refs — no minted ids, R6/t/2294), copy-not-judge on `sort`/`match_level`, mechanical `modality`, and enum validation before persisting. Defaults to the grounded set (claims with `entity_refs`); `-IncludeUngrounded`, `-MaxClaims`, `-Model`, `-Force`, `-WhatIf`. Produces the batch CL's `score_golden.py` scores for `formalization_accuracy` (t/3215) |

### Graph & Conflict Analysis
| Cmdlet | Use when |
|--------|----------|
| `Find-GraphPath` | Find paths between two nodes |
| `Find-Conflict` | Discover conflicts between POV nodes |
| `Invoke-GraphQuery` | Run structured graph queries |
| `Invoke-CypherQuery` | Run raw Cypher against Neo4j |
| `Invoke-QbafConflictAnalysis` | QBAF-based conflict scoring |
| `Show-GraphOverview` | Visualize graph structure |
| `Export-TaxonomyToGraph` | Export to Neo4j |

### Debate Engine
| Cmdlet | Use when |
|--------|----------|
| `Show-TriadDialogue` | Run a three-agent debate (CLI entry point) |
| `Invoke-AITDebate` | Invoke debate programmatically |
| `Resume-AITDebate` | Finish a crashed debate from its -partial.json checkpoint (synthesis + persist tail) |
| `Get-AITDebate` | Load a saved debate by ID |
| `Compare-DebateRuns` | Diff two debate runs |
| `Compare-DebateQuality` | Diff quality scores between two debate runs |
| `Measure-DebateQuality` | Compute quality score for a single debate run |
| `Invoke-DebateBatch` | Run a batch of debates from a config file with live progress |
| `Watch-DebateProgress` | Live-updating table of a running batch's per-debate status (hung detection) |
| `Show-DebateDiagnostics` | Inspect debate internals |
| `Repair-DebateOutput` | Fix malformed debate JSON |
| `Export-TriadDebateBrief` | Export a closed debate to a presentation brief (.pptx). Local mode (`-Path`) runs the offline lib/brief pipeline; server mode (`-DebateId`) is deferred pending AAD auth (t/2839) |
| `Test-BriefNarrationStage` | Run ONLY the brief narrate stage on a deck_spec + model to debug zero-entry/bad-trace failures without the full pipeline; returns entry count + validation errors (t/2873) |

### Op-Ed Generation
| Cmdlet | Use when |
|--------|----------|
| `Get-OpEdSource` | Convert (PDF/DOCX/HTML, dispatched on Content-Type) and validate PRE-FETCHED source content — takes a temp-file path + content-type, returns a SourcePrep object for New-OpEd. Convert-only: the URL fetch moved to the shared Node fetcher (t/2586, t/3307) |
| `New-OpEd` | Generate a publication-ready op-ed in a POV camp voice, grounded in the project taxonomy; accepts -Topic, -Url (CLI best-effort fetch then convert — desktop fetches via the hardened Node fetcher, t/3312), or -SourcePrep (pre-built prep object for multi-voice runs) |

### Sources & Ingestion
| Cmdlet | Use when |
|--------|----------|
| `Import-AITriadDocument` | Ingest a PDF/DOCX/HTML source |
| `Save-AITSource` / `Find-AITSource` | Store/retrieve source records |
| `Export-SourcesIndex` | Build `sources-index.json` (card fields + `content_sha256` + URL/provenance per doc) for hosts that can't read `ai-triad-sources`; byte-stable, writes only on change (t/4334) |
| `Get-IntellectualLineage` | Trace a node's source lineage |
| `Get-PovLineage` | POV-specific lineage |
| `Get-IngestionPriority` | Score sources by ingestion value |
| `Invoke-AttributeExtraction` | AI-extract attributes from a source |
| `Invoke-EdgeDiscovery` | Discover candidate edges from text |
| `Invoke-EdgeRationaleBackfill` | Backfill missing/empty edge `rationale` via AI — idempotent, resumable, `-DryRun`/`-Limit` for a costed pilot (t/2679) |

### AI Enrichment
| Cmdlet | Use when |
|--------|----------|
| `Invoke-AIByUsage` | Config-driven AI dispatch by UsageID (reads `ai-usages.json`, renders templates, delegates to Invoke-AIApi) |
| `Get-AITierModel` | Resolve a model tier (`basic`=fast/cheap, `advanced`=frontier) + backend to the currently-registered id from `ai-models.json` `debateTiers` — use as a drift-proof default (`[string]$Model = (Get-AITierModel -Tier basic)`) instead of a hardcoded literal (t/3564) |
| `Build-NodeSourceIndex` | Build the derived belief-node→primary-source sidecar `taxonomy/Origin/source_index.json` by inverting summaries' node-citation links against live ids — deterministic, self-describing header (schemaVersion/inputHash/totals); `-WhatIf`/`-PassThru` to preview (t/3596) |
| `Test-CitationLinkIntegrity` | Advisory referential-integrity gate (t/3598): verifies summary→node links resolve to live nodes of their class (belief/situation), every `source_index.json` `source_id` resolves to `<sources>/<id>/metadata.json` (chunk-suffix stripped), and the index isn't stale (header inputHash + key count). Returns per-leg pass/offenders; warn-only until the SO/TL blocking flip |
| `Invoke-BatchSummary` | Batch-summarize documents from the queue |
| `Invoke-POVSummary` | Summarize one document across all 3 POVs (writes `summaries/<doc-id>.json`) |
| `Invoke-BDIWeightAssignment` | Assign BDI weights to nodes |
| `Invoke-EdgeWeightEvaluation` | Score edge weights via AI |
| `Invoke-VernacularBatch` | Generate vernacular descriptions |
| `Invoke-DebateGroundingBatch` | Generate first-person camp-voice `graph_attributes.debate_grounding` for POV nodes (t/3366); skip-if-present, `-Force`/`-Id`/`-WhatIf`/`-Concurrency`, surgical upsert write |
| `Invoke-AphorismBatch` | Backfill camp-voiced sober aphorisms (~3-8 words) on POV nodes — presentational only, never a scoring input; skips pillars/deprecated (t/1550) |
| `New-SyntheticCorpus` | Generate synthetic training data |
| `Get-SyntheticStatement` | Get the synthetic statements generated for a BDI element (node id); reads synthetic/corpus_<pov>.json, excludes pruned by default (-IncludePruned to include) |

### AI Call Log (t/3235)
| Cmdlet | Use when |
|--------|----------|
| `Clear-AICallLog` | Rotate/clear the AI call log (`ai-call-log.jsonl`) so the next logged call restarts `ID` at 1 — a "session" is one log file. No-op if absent; honors `-WhatIf`. Capture is behind the default-off `AI_CALL_LOG_ENABLED` flag (t/3241) |
| `Get-AICallLog` | Read the AI call log as filterable, pipeline-friendly `[AICallLogEntry]` objects — filter by `-Scenario`/`-Status` (wildcards) and `-After`/`-Before` date range. Reading ignores the capture flag; absent/empty log → empty result (t/3243) |
| `Show-AICallLog` | Render the AI call log as a self-contained, sortable/filterable HTML viewer and open it in the browser (same filters as `Get-AICallLog`). `-PassThru` returns the generated HTML path instead of opening (t/3244) |

### Health & Diagnostics
| Cmdlet | Use when |
|--------|----------|
| `Test-TaxEditorHealth` | Production liveness/readiness check (supports `-MaxAttempts` polling for post-deploy waits, t/1491) |
| `Test-TaxEditorInquiry` | Verifies the hosted inquiry flow returns REAL data, not an ADR-001 graceful-empty shell — POST→poll→assert `campVerdicts`/`calibration`/`grounding` count>0; needs a `-SessionCookie` (auth-only); empty-shell = loud `New-ActionableError` (t/3584) |
| `Test-EmbeddingHealth` | Smoke-test `POST /api/embeddings/compute` in prod (anon session + x-request-id) — reports Healthy/status/duration/vector dims + a `Get-ServerLog`-traceable requestId on failure (t/2787) |
| `Test-TaxEditorEndpoints` | Smoke-test 16 endpoints |
| `Test-AnonymousDebateFlow` | End-to-end smoke test of the anonymous/free-tier user journey |
| `Test-PersonaEndpoints` | Auth-gate regression matrix across anonymous/authenticated/admin personas |
| `Test-ServiceWorkerHealth` | Parse deployed /sw.js for skipWaiting mode, denylist coverage, precache stats |
| `Get-FreeTierStatus` | Live free-tier budget/usage report (live config + token consumption) |
| `Sync-FreeTierKeys` | Validate-then-set the FREE_TIER_GEMINI_KEY pool — auth-probes each key, excludes failures, sets passing keys as the comma-separated pool value (GHA secret / local env), reports K and resulting front-door RPM |
| `Test-AnalyticsBackend` | Analytics storage round-trip probe — POST synthetic event, wait, GET query, verify event appears; confirms write failures in <60s (t/2668) |
| `Test-AzureHealth` | Azure infra status |
| `Test-AnalyticsBlobHealth` | Verify the analytics blob container exists, is accessible, and has recent data (daily NDJSON blobs, event counts, stale-write threshold) |
| `Get-AnalyticsEventTypes` | Read-side analytics check — per-event-type counts from `GET /api/analytics/query` (surfaces instrumentation gaps like `view.dwell: 0`); `-Days`/`-Env prod\|staging` |
| `Test-GitHubHealth` | GitHub platform + CI status |
| `Test-AIApiKey` | Probe AI backend auth endpoints (no tokens consumed) — confirm a key is present and accepted before running jobs |
| `Test-GeminiKeyPool` | Definitive count + per-key validity of the Gemini free-key pool from a key file (AIza + AQ. formats) via the auth-only probe; masked fingerprints only, never raw keys (t/3141) |
| `Test-AIBackendHealth` | Full completion round-trip probe per backend — use before a debate run to surface degraded/unreachable models (t/2212) |
| `Test-AIBackendQuota` | Per-backend quota probe — flags quota-exhausted backends (Status='quota') with a best-effort ResetAt; use at session start to catch quota exhaustion before a wall of judge failures (t/3029) |
| `Test-DebateIndexIntegrity` | Validate debate-*.json field types for UI-crash regressions — catches the object-as-title bug (t/2335) |
| `Get-DebateIndexHealth` | Scan the aggregated `.debate-index.json` for type-invalid entries (object-as-title etc.); `-Repair` deletes bad entries for re-extraction on next launch (t/2735) |
| `Get-DebateRateLimitSummary` | Summarize 429/rate-limit patterns from a flight recorder dump — per-bucket (`embed:<ip>`/`free:<ip>`) count, first/last, retry-after min/max/mean/distinct; reuses `Get-FlightRecorderReport` (t/3065) |
| `Test-DebatePersistence` | Pre-flight atomic write+rename probe for the debates output dir — call before AI generation to surface LOCKED/NO_PERMISSION early (t/2545) |
| `Get-ContainerAppRevision` | Query ACA revisions by mode (Active/Stale/Fqdn) — replaces raw `az containerapp revision` calls (t/1498) |
| `Get-ServerLog` | Retrieve + filter ACA server logs, correlate by Pino requestId — `-RequestId`/`-Recent`/`-StartTime`/`-Pattern` sets, `-Level`/`-Component`/`-Follow`/`-Raw` (t/2765) |
| `Get-TaxEditorServerLogs` | Pull **deep** server-log history from Log Analytics (past the live-tail buffer) by `-From`/`-To`/`-RequestId`/`-Pattern`; parses Pino fields (Level/RequestId/Component/Method/Path/Status/DurationMs); `-System` for revision/restart events (t/3082) |
| `Test-EmbeddingsCacheHealth` | One-shot `resolving`/`re-computing`/`no-traffic`/`unknown` verdict on whether the precomputed embeddings cache is serving on the live revision — compute p50/p95, load-shed 503s, cache-ready signal over `-From`/`-To` (default 30m); baseline-validation for the embedding-saturation class (t/3168) |
| `ConvertFrom-TruncatableJson` | Parse JSON, recovering the valid prefix when a structured-output response was truncated mid-JSON (via `Repair-TruncatedJson`); WARNs on the repair path, re-throws the original error when unrepairable. Used by `Invoke-EntityExtraction` so entity-dense nodes don't hard-fail (t/3195) |
| `Test-PreloadHealth` | Validate the built `preload.cjs` before launch — exists, calls `contextBridge.exposeInMainWorld`, self-contained (no relative `require('./…')`), optional `node --check` (t/2775, t/2777) |
| `New-ContainerAppRevision` | Blue-green: deploy a new ACA revision at 0% traffic; returns real `RevisionName` for the promotion chain (t/1500 Phase 3) |
| `Set-ContainerAppTraffic` | Shift traffic to a named revision with retry — call BEFORE `Disable-ContainerAppRevision` in rollback (t/1500 Phase 3) |
| `Disable-ContainerAppRevision` | Deactivate an ACA revision (stale cleanup or rollback tail); non-fatal on failure — matches deploy YAML's `\|\| true` semantics (t/1500 Phase 3) |
| `Get-ContainerAppDiagnostics` | Combined revision-show + console + system logs for failure triage; polls 30s for logs to appear before declaring unavailable (t/1500 Phase 3) |
| `Get-GitHubWorkflowRun` | Fetch a workflow run + per-job conclusions for a commit SHA or run ID (t/1499) |
| `Get-CIFailureSummary` | One-call CI triage — pull failing Pester tests + real infra errors from a gh run log (t/2882) |
| `Remove-StaleContainerImages` | GHCR cleanup — paginate → filter → delete untagged image versions with `-WhatIf` (t/1492) |
| `Get-TaxonomySnapshot` | Fetch the 11-file taxonomy + conflict snapshot from ai-triad-data with commit-SHA stamping (t/1493) |
| `Test-TaxonomyDirContents` | Pre-embedding TAXONOMY_DIR validation — flags files whose `nodes` field would crash `Update-TaxEmbeddings` (dict/null instead of a list of objects); mirrors embed_taxonomy.py skip logic (t/1654) |
| `Get-FlightRecorderDump` | Pull flight recorder from server |
| `Get-LatestFlightRecorderDump` | Find the most recent *non-stub* flight recorder dump (>10KB) for triage — skips the tiny startup/shutdown stubs that can be newer than the real dump (t/1712) |
| `Read-FlightRecorderDump` | Structured error/retry summary from a dump — error grouping by (component,type), retry-chain reconstruction with computed backoff intervals, preceding-warning lookback, client/server split (t/3726) |
| `Invoke-DebateDiagnosis` | Structured debate-issue analysis from a dump — per-run phase/round progression, COMMIT-intervention receipt per POVer, derived closure status, deduped errors/warnings, best-effort steelman text scan (t/3768) |
| `Measure-CodeComplexity` | McCabe (cyclomatic) complexity per function, AST-based over PS source — defaults to `scripts/`, filterable by `-MinComplexity` (p/550) |
| `Update-ComplexityBaseline` | Generate/regenerate the complexity-ratchet baseline (`scripts/complexity-baseline.json`) — per-file `{max, countOver}`, offenders-only, write-only-downward (t/3829) |
| `Test-ComplexityBudget` | Enforce the complexity-ratchet baseline — new over-threshold file or a baselined file regressing both fail; reads threshold from the baseline unless `-Threshold` is explicitly passed and must then match (t/3829) |
| `Get-AICostReport` | Token/cost usage report |
| `Get-ViteDevStatus` | Vite dev server diagnostic — port owner, working dir, HTTP health, main/worktree/orphan classification (t/2196) |
| `Get-WorktreeMainRoot` | Resolves the true main-checkout root from inside any worktree (nested `.worktrees/<x>` or sibling `../wt-<x>`) via `git rev-parse --git-common-dir`; use when anchoring a sibling-relative path like a data-repo root, where the calling worktree's own directory is the wrong depth (t/3869) |
| `Get-DebateSessionState` | Read phase, transcript length, run_id, and updated_at from a debate JSON on disk — one-liner for interrupted-turn recovery diagnosis (t/2330) |

### Config
| Cmdlet | Use when |
|--------|----------|
| `Get-TriadConfig` / `Set-TriadConfig` | Read/write runtime config |
| `Register-AIBackend` | Configure AI backend credentials |
| `Test-AIApiKey` | Verify an AI provider API key authenticates (auth-only probe of gemini/claude/groq/openai/azure; no token cost). Use `-All` to sweep every backend with a resolvable key. |
| `Test-AIModelsConfig` | Validate `ai-models.json` — BOM, JSON parse, orphaned model refs in defaults/debateTiers/fallbackChains, incomplete `models[]` entries, and friendly-id-in-`apiModelId` (t/1705). Returns `{Pass; Issues}`; run in a Pester test / CI. |

### Data-Write Safety
| Cmdlet | Use when |
|--------|----------|
| `Assert-CleanDataTree` | Before a whole-file rewrite of a data-repo JSON, assert the target has no uncommitted changes — so a `ConvertFrom-Json \| ConvertTo-Json` (or Python `json.load`→`json.dump`) round-trip can't sweep concurrent working-tree state into the commit (t/2902; `-Force` downgrades the block to a warning). Also exposed as the opt-in `Write-Utf8NoBom -RequireCleanTree` switch. |
| `Save-JsonNodeFieldEdits` | Use when a writer needs to set scalar `nodes[]` fields in a data-repo JSON without a whole-file round-trip. Reads fresh, splices ONLY the target fields via a re-parse-verified byte-preserving primitive, writes once through the guarded sink — so it cannot sweep concurrent WIP and is safe even on the perpetually-dirty BLOCK-tier `situations.json` (t/2916). Returns a summary (Applied + NotFound). Pair with explicit-path staging at commit. |
| `Set-PovNodeTags` | Use when writing a POV node's `pov_tags` field (the t/3962 tagging writer). Validates the WHOLE batch against the registry in ONE call to the blocking gate `lib/schema/pov-tags-cli.ts` before writing anything — a bad tag anywhere refuses the entire batch, so a file is never left half-tagged (t/3969). Writes surgically via `Update-JsonNodePath -ArrayValue`. Supports `-WhatIf` and `-TargetPath` for dry-run / worktree writes. Returns `{Checked; Applied; NotFound}`. |

**Centralized data-write guard (t/2902 Part 2).** Every data-of-record write in the module funnels through a guarded sink, so individual cmdlets need no per-callsite wiring:

- **Content-string writes** go through `Write-Utf8NoBom`, which calls the internal `Assert-DataWriteAllowed` guard automatically. Writers using atomic `[IO.File]::WriteAllText`/`Move` sinks call the guard directly at the sink; Python re-writers call `assert_clean_data_tree` (`scripts/data_tree_guard.py`).
- The guard fires **only** for a target **under the data root** (`Get-DataRoot`) that is **already dirty** — it is per-file, never a whole-tree assertion (the data tree is perpetually dirty).
- **Mode is TIERED per target** (t/2909): **BLOCK** tier = low-traffic/usually-clean/high-sensitivity files (`situations.json`, `organization_stance_claims.json`, and the registries — `policy_actions`/`organizations`/`organization_edges`/`entities`/`entity_mentions`) → throws on a dirty target; **WARN** tier = everything else (high-traffic perpetually-dirty: POV camp files, `edges.json`, `embeddings.json`, summaries, and `.debate-index.json` — rewritten every debate run) → warns and proceeds (the durable fix there is field-surgical writes, t/2916). `$env:AI_TRIAD_DATA_WRITE_GUARD` = `Block`|`Warn`|`Off` is a **global override** that wins over the tier. Pass `-AllowDirty` on a sink call to opt a legitimate sequential rewriter out. Tier membership is co-located in `Assert-DataWriteAllowed.ps1` / `data_tree_guard.py` (lockstep).
- A detection test (`tests/DataWriteSinkGuard.Tests.ps1`) fails CI if any new data writer reaches disk bypassing the guarded sink — so coverage tracks growth.
