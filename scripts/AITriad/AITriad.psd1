# Copyright (c) 2026 2026 Snover International Consulting LLC. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

@{
    RootModule        = 'AITriad.psm1'
    ModuleVersion     = '0.8.6'
    GUID              = 'a7c3e1f0-4b2d-4e8a-9f6c-1d3b5e7a9c0f'
    Author            = 'Jeffrey Snover'
    CompanyName       = 'Snover International Consulting LLC'
    Copyright         = '(c) 2026 Snover International Consulting LLC. All rights reserved.'
    Description       = 'AI Triad Research — taxonomy queries, document ingestion, POV analysis'
    PowerShellVersion = '7.0'

    # Functions exported from this module
    FunctionsToExport = @(
        'Clear-AICallLog'   # t/3241 — AI Call Log core (rotate/clear)
        'Get-AICallLog'     # t/3243 — AI Call Log reader (filterable, pipeline)
        'Show-AICallLog'    # t/3244 — AI Call Log HTML viewer (sortable/filterable)
        'Get-Tax'
        'Update-TaxEmbeddings'
        'Import-AITriadDocument'
        'Invoke-POVSummary'
        'Invoke-BatchSummary'
        'Find-Conflict'
        'Find-AITSource'
        'Save-WaybackUrl'
        'Save-AITSource'
        'Invoke-PIIAudit'
        'Update-Snapshot'
        'Show-TaxonomyEditor'
        'Show-POViewer'
        'Show-SummaryViewer'
        'Show-AITriadHelp'
        'Get-TaxonomyHealth'
        'Measure-TaxonomyBaseline'
        'Invoke-TaxonomyProposal'
        'Compare-Taxonomy'
        'Get-AITSource'
        'Get-AITDebate'
        'Repair-PovDescriptions'
        'Repair-PovLineage'
        'Repair-PovAttributes'
        'Repair-SituationReciprocity'
        'Add-SituationEvidenceLink'
        'Export-AggregatedCruxes'
        'Export-TriadDebateBrief'
        'Test-BriefNarrationStage'
        'Get-Summary'
        'Invoke-AttributeExtraction'
        'Invoke-EdgeDiscovery'
        'Invoke-EdgeRationaleBackfill'
        'Get-GraphNode'
        'Find-GraphPath'
        'Approve-Edge'
        'Approve-TaxonomyProposal'
        'Get-Concept'   # t/3291 — standardized dictionary reader + concept<->node reverse map
        'Get-Edge'
        'Get-Situation'
        'Set-Edge'
        'Invoke-GraphQuery'
        'Get-ConflictEvolution'
        'Export-TaxonomyToGraph'
        'Install-GraphDatabase'
        'Invoke-CypherQuery'
        'Show-GraphOverview'
        'Get-TopicFrequency'
        'Get-IngestionPriority'
        'Find-SituationCandidates'
        'Find-CrossCuttingCandidates'
        'Show-TriadDialogue'
        'Register-AIBackend'
        'Install-AITriadData'
        'Install-AIDependencies'
        'Test-Dependencies'
        'Find-PossibleFallacy'
        'Find-PolicyAction'
        'Get-Policy'
        'Update-PolicyRegistry'
        'Show-FallacyInfo'
        'Test-TaxonomyIntegrity'
        'Test-TaxonomyDir'
        'Assert-CleanDataTree'
        'Save-JsonNodeFieldEdits'
        'Set-PovNodeTags'
        'Invoke-HierarchyProposal'
        'Set-TaxonomyHierarchy'
        'Invoke-SchemaMigration'
        'Invoke-PolicyRefinement'
        'Repair-UnmappedConcepts'
        'Invoke-AITDebate'
        'Resume-AITDebate'
        'Convert-DebateToAudio'
        'Convert-MD2PDF'
        'Show-Markdown'
        'Show-DebateDiagnostics'
        'Repair-DebateOutput'
        'Show-DebateHarvest'
        'Get-AITSBOM'
        'Test-OntologyCompliance'
        'Test-SituationBdiCompliance'
        'Get-SituationBdiViolationsFromJson'
        'Get-RelevantTaxonomyNodes'
        'Invoke-QbafConflictAnalysis'
        'Test-ExtractionQuality'
        'Show-WorkflowRunner'
        'Test-EdgeDirection'
        'Test-AITJudgeModel'
        'Repair-AITSummaryMappings'
        'Repair-ResolvedBackfill'
        'Invoke-EdgeWeightEvaluation'
        'Repair-Markdown'
        'Compare-DebateRuns'
        'Compare-DebateQuality'
        'Measure-DebateQuality'
        'Invoke-DebateAB'
        'Show-OSSLicenses'
        'Get-AICostReport'
        'Get-AITierModel'
        'Build-NodeSourceIndex'
        'Test-CitationLinkIntegrity'
        'Get-FlightRecorderDump'
        'Get-LatestFlightRecorderDump'
        'Get-AzureFlightRecorder'
        'Show-FlightRecorder'
        'Export-SourcesIndex',
        'Update-AITSourceIndex'
        'Get-PovLineage'
        'Get-IntellectualLineage'
        'Invoke-BDIWeightAssignment'
        'Register-AITriadDrive'
        'Get-TaxonomyProcess'
        'Request-FlightRecorderDump'
        'Get-FlightRecorderReport'
        'Read-FlightRecorderDump'
        'Invoke-DebateDiagnosis'
        'Measure-CodeComplexity'
        'Update-ComplexityBaseline'
        'Test-ComplexityBudget'
        'Get-AITClaim'
        'Compare-EmbeddingModel'
        'Test-RerankerBaseline'
        'New-OpEd'
        'Get-OpEdSource'
        'New-SyntheticCorpus'
        'Update-SyntheticCorpus'
        'Sync-SyntheticCorpus'
        'Get-SyntheticStatement'
        'Export-SyntheticEmbeddings'
        'Test-SynthesisCompleteness'
        'Get-ImportReport'
        'Get-CalibrationTrend'
        'Test-TaxEditorHealth'
        'Test-TaxEditorInquiry'
        'Test-EmbeddingHealth'
        'Test-TaxEditorEndpoints'
        'Test-AnonymousDebateFlow'
        'Test-PersonaEndpoints'
        'Test-ServiceWorkerHealth'
        'Watch-DebateProgress'
        'Invoke-DebateBatch'
        'Get-FreeTierStatus'
        'Sync-FreeTierKeys'
        'Invoke-TaxEditorSmokeTest'
        'Invoke-TaxEditorLoadTest'
        'Test-PreloadHealth'
        'Test-AnalyticsBackend'
        'Test-AnalyticsBlobHealth'
        'Get-AnalyticsEventTypes'
        'Test-AzureHealth'
        'Test-GitHubHealth'
        'Get-TaxEditorRevision'
        'Switch-TaxEditorRevision'
        'Get-TaxEditorDataCommit'
        'Undo-TaxEditorDataCommit'
        'Sync-TaxEditorData'
        'Reset-TaxEditorSession'
        'Get-TaxEditorImage'
        'Deploy-TaxEditorImage'
        'Set-TaxEditorKnownGood'
        'Restore-TaxEditorKnownGood'
        'Test-TaxEditorInfra'
        'Deploy-TaxEditorInfra'
        'Get-TaxEditorBlob'
        'Restore-TaxEditorBlob'
        'Get-CriticalInteraction'
        'Test-CriticalInteractions'
        'Merge-FlightRecorderDumps'
        'Get-TriadConfig'
        'Set-TriadConfig'
        'Invoke-TriadConfigReload'
        'Invoke-VernacularBatch'
        'Invoke-DebateGroundingBatch'
        # t/1224 — Organization data model
        'Get-Organization'
        'Find-OrganizationByPOV'
        'Find-OrganizationByTopic'
        'Get-OrganizationStakeholders'
        'Import-Organization'
        'Compare-OrganizationPositions'
        # t/1526 — Organization actor-relationship edges
        'Get-OrganizationEdge'
        'Import-OrganizationEdge'
        # t/1804 — Entity ontology (Phase 1): store + curation cmdlets
        'Get-Entity'
        'Import-Entity'
        'Update-EntityEmbeddings'   # t/3121 D — backfill entity_embeddings.json to v2 multi-vector
        # t/1261 — UsageID registry
        'Invoke-AIByUsage'
        # t/1308 — cc→sit migration
        'Invoke-CcToSitMigration'
        'Test-AIApiKey'
        'Test-GeminiKeyPool'
        'Test-AIBackendHealth'
        'Test-AIBackendQuota'
        'Test-AIModelsConfig'
        # t/1492 — GHCR cleanup
        'Remove-StaleContainerImages'
        # t/1493 — Taxonomy snapshot fetch
        'Get-TaxonomySnapshot'
        # t/1498 — ACA revision queries
        'Get-ContainerAppRevision'
        # t/1499 — GH workflow run queries
        'Get-GitHubWorkflowRun'
        'Get-CIFailureSummary'
        # t/1550 — POV aphorism backfill
        'Invoke-AphorismBatch'
        # t/1553 Stage 0 — org PUBLISHED edge seeding
        'Invoke-OrgPublishedSeeding'
        # t/1553 Stage 1 — org stance claim extraction
        'Invoke-OrgStanceExtraction'
        # t/1553 Stages 2+3 — claim→node matching + edge proposal aggregation
        'Invoke-OrgClaimMatching'
        # t/1560 Stage 5 — R2 rollup, per-camp derived alignment from approved edges
        'Invoke-OrgDerivedCampScores'
        # t/1500 Phase 3 — blue-green deploy orchestration (e/41)
        'Disable-ContainerAppRevision'
        'New-ContainerAppRevision'
        'Set-ContainerAppTraffic'
        'Get-ContainerAppDiagnostics'
        # t/1579 — Debate-Tested Phase 2 research surface
        'Get-NodeTestingRecord'
        'Update-NodeTestingRecord'
        # t/1654 — pre-embedding TAXONOMY_DIR validation
        'Test-TaxonomyDirContents'
        # t/1806 — Entity ontology Phase 1: extraction + maintenance reports
        'Invoke-EntityExtraction'
        'Get-EntityReport'
        # t/4075 — review surface for advisory existing-entity candidates (never links)
        'Get-EntityExtractionCandidates'
        # t/1894 — Entity ontology Phase 2-B: batch mention indexer (entity_mentions.json)
        'Update-EntityMentionIndex'
        # t/3124 — Claim-side entity grounding: writes entity_refs[] onto summary claims
        'Update-ClaimEntityRef'
        # t/3215 — FOL Phase 1: formalize claims into neo-Davidsonian logical_form (schema t/3126)
        'Invoke-LogicalFormPass'
        # t/2196 — Vite dev server diagnostic
        'Get-ViteDevStatus'
        # t/3869 — resolves the true main-checkout root from inside any worktree (nested or sibling)
        'Get-WorktreeMainRoot'
        # t/2330 — Debate session state diagnostic
        'Get-DebateSessionState'
        # t/2335 — Debate index field-type integrity check (per-session files)
        'Test-DebateIndexIntegrity'
        # t/2735 — Debate index (.debate-index.json) type-invalid entry scan + repair
        'Get-DebateIndexHealth'
        # t/3065 — 429/rate-limit pattern summary from a flight recorder dump
        'Get-DebateRateLimitSummary'
        # t/2367 — Debate blob existence check in Azure storage
        'Test-DebateSession'
        # t/2545 — Pre-flight atomic write+rename probe for debate output dir
        'Test-DebatePersistence'
        # t/2765 — ACA server log retrieval with requestId correlation
        'Get-ServerLog'
        # t/3082 — Log Analytics server-log query (deep history) by window/requestId/pattern
        'Get-TaxEditorServerLogs'
        # t/3168 — one-shot embeddings-cache resolving/re-computing verdict on the live revision
        'Test-EmbeddingsCacheHealth'
        # t/3195 — parse JSON tolerating truncation (recovers the valid prefix)
        'ConvertFrom-TruncatableJson'
        # t/3225 — stale-head-merge guard: verify PR headRefOid == remote tip before gh pr merge
        'Invoke-VerifiedMerge'
    )

    # Aliases exported from this module
    AliasesToExport   = @(
        'Import-Document'
        'Install-AITdependencies'
        'TaxonomyEditor'
        'POViewer'
        'SummaryViewer'
        'Redo-Snapshots'
        'Show-MD'
        'Workflow'
    )

    # Cmdlets exported (none — pure script module)
    CmdletsToExport   = @()

    # Variables exported (none)
    VariablesToExport = @()

    # Format files to load
    FormatsToProcess  = @('Formats/Taxonomy.Format.ps1xml')

    # Private data
    PrivateData = @{
        PSData = @{
            Tags       = @('AI', 'Taxonomy', 'Research', 'POV', 'Gemini')
            ProjectUri = 'https://github.com/jsnov/ai-triad-research'
        }
    }
}
