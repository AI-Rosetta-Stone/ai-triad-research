# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Invoke-OrgStanceExtraction {
    <#
    .SYNOPSIS
        Stage 1 of t/1553 — extracts an org's own asserted/opposed positions
        from each approved PUBLISHED document.
    .DESCRIPTION
        Consumes approved PUBLISHED edges (org → source) from the
        organization_edges.json store. For each (org, source) pair whose
        target document exists in the ingested corpus, loads snapshot.md
        and calls the `enrichment.org-stance-extraction` UsageID.

        Claims come back as structured JSON:
          { text, canonical_proposition, polarity, extraction_confidence }
        keyed to (org_id, source_id). Persisted to
        organization_stance_claims.json under the taxonomy origin, with
        an idempotence guard on (org_id, source_id) — re-runs skip
        already-extracted pairs unless -Force.

        Edges whose target isn't on disk (historical curated edges without
        an ingested doc) are skipped with a count in the summary — never
        an AI call.

        Zero writes to organization_edges.json — Stage 1 only produces
        claims, not proposals. Proposal emission is Stage 3.
    .PARAMETER Org
        Restrict to specific org id(s). Default: all orgs with at least
        one approved PUBLISHED edge.
    .PARAMETER MaxDocs
        Safety cap on documents processed per run. Default: no cap.
        Use `-MaxDocs 3` for CL first-batch review.
    .PARAMETER Concurrency
        Parallel AI calls. Default 3 — conservative to stay under
        flash-lite rate limits (same lesson as t/1550 aphorism backfill).
    .PARAMETER Force
        Re-extract for (org, source) pairs that already have claims.
    .PARAMETER MaxDocChars
        Truncate document body to this many chars before extraction
        (flash-lite context safety). Default 20000 (~5K tokens).
    .PARAMETER OutputPath
        Override the claim file path (data-repo taxonomy/Origin by default).
    .EXAMPLE
        Invoke-OrgStanceExtraction -MaxDocs 3
    .EXAMPLE
        Invoke-OrgStanceExtraction -Org org-001,org-002
    .LINK
        Show-AITriadHelp
    .LINK
        Invoke-OrgClaimMatching
    .LINK
        Invoke-OrgDerivedCampScores
    .LINK
        Invoke-OrgPublishedSeeding
    .LINK
        Get-Organization
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter()]
        [string[]]$Org,

        [Parameter()]
        [ValidateRange(1, 500)]
        [int]$MaxDocs,

        [Parameter()]
        [ValidateRange(1, 20)]
        [int]$Concurrency = 3,

        [Parameter()]
        [switch]$Force,

        [Parameter()]
        [ValidateRange(500, 200000)]
        [int]$MaxDocChars = 20000,

        [Parameter()]
        [Alias('Path')]
        [string]$OutputPath
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    # ── Resolve paths + registries ───────────────────────────────────────
    $sourcesRoot = Get-SourcesDir
    if (-not (Test-Path $sourcesRoot)) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal 'Extract org stance claims' `
            -Problem "Sources directory not found: $sourcesRoot" `
            -Location 'Invoke-OrgStanceExtraction' `
            -NextSteps @('Set $env:AI_TRIAD_SOURCES_ROOT', 'Verify .aitriad.json'))
    }

    if (-not $OutputPath) {
        $OutputPath = Join-Path (Get-TaxonomyDir) 'organization_stance_claims.json'
    }

    $orgStore   = Get-OrganizationsStore
    $edgeStore  = Get-OrganizationEdgesStore
    $orgs       = if ($orgStore.PSObject.Properties['organizations']) { @($orgStore.organizations) } else { @() }
    $edges      = if ($edgeStore -and $edgeStore.PSObject.Properties['edges']) { @($edgeStore.edges) } else { @() }

    $orgById = @{}
    foreach ($o in $orgs) { $orgById[[string]$o.id] = $o }

    # ── Build work list ──────────────────────────────────────────────────
    $wanted = @()
    if ($Org) { $wanted = @($Org) }
    $wantedCount = @($wanted).Count
    $approved = @($edges | Where-Object {
        $_.PSObject.Properties['type']   -and
        $_.PSObject.Properties['status'] -and
        $_.PSObject.Properties['source'] -and
        $_.PSObject.Properties['target'] -and
        [string]$_.type -eq 'PUBLISHED' -and
        [string]$_.status -eq 'approved' -and
        [string]$_.target -notlike 'org-*' -and
        (($wantedCount -eq 0) -or ([string]$_.source -in $wanted))
    })

    # ── Load existing claims (idempotence guard) ─────────────────────────
    $existingClaims = [System.Collections.Generic.List[PSObject]]::new()
    $covered = @{}   # "$orgId::$sourceId" → 1
    if (Test-Path $OutputPath) {
        $prev = Get-Content $OutputPath -Raw | ConvertFrom-Json
        if ($prev.PSObject.Properties['claims']) {
            foreach ($c in @($prev.claims)) {
                $existingClaims.Add($c)
                if ($c.PSObject.Properties['org_id'] -and $c.PSObject.Properties['source_id']) {
                    $covered["$($c.org_id)::$($c.source_id)"] = 1
                }
            }
        }
    }

    $workItems = [System.Collections.Generic.List[PSObject]]::new()
    $skippedNoDoc     = 0
    $skippedAlreadyDone = 0
    $skippedNoOrg      = 0

    # duplicate_of (t/4337 C1): an edge to a marked copy is read through its canonical doc, and one
    # org reads each resolved doc once. Existing claims keep the ids they were extracted under, so
    # "covered" accepts either the exact or the resolved id (spec 6.4).
    $resolution = Get-SourceResolution -SourcesDir $sourcesRoot
    $queued = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    foreach ($e in $approved) {
        $orgId    = [string]$e.source
        $exactId  = [string]$e.target
        $sourceId = Resolve-SourceId -Resolution $resolution -Id $exactId
        $key      = "$orgId::$sourceId"

        if (-not $Force -and ($covered.ContainsKey($key) -or $covered.ContainsKey("$orgId::$exactId"))) {
            $skippedAlreadyDone++
            continue
        }
        if (-not $queued.Add($key)) { $skippedAlreadyDone++; continue }

        if (-not $orgById.ContainsKey($orgId)) {
            $skippedNoOrg++
            continue
        }

        $sourceDir = Join-Path $sourcesRoot $sourceId
        $snapshot  = Join-Path $sourceDir 'snapshot.md'
        if (-not (Test-Path $snapshot)) {
            $skippedNoDoc++
            continue
        }

        $org   = $orgById[$orgId]
        $orgName = if ($org.PSObject.Properties['name']) { [string]$org.name } else { $orgId }
        $orgType = if ($org.PSObject.Properties['type']) { [string]$org.type } else { 'organization' }

        $workItems.Add([PSCustomObject]@{
            OrgId    = $orgId
            OrgName  = $orgName
            OrgType  = $orgType
            SourceId = $sourceId
            Snapshot = $snapshot
        })
    }

    if ($MaxDocs -and $workItems.Count -gt $MaxDocs) {
        $workItems = $workItems | Select-Object -First $MaxDocs
    }

    $Total = @($workItems).Count
    Write-Verbose "Work items: $Total (skipped no-doc: $skippedNoDoc, already-done: $skippedAlreadyDone, no-org: $skippedNoOrg)"

    if ($Total -eq 0) {
        Write-Host 'Nothing to extract — no approved PUBLISHED edges match the filter, or all are already done.'
        return [PSCustomObject]@{
            Extracted        = 0
            ClaimsWritten    = 0
            Failed           = 0
            SkippedNoDoc     = $skippedNoDoc
            SkippedAlreadyDone = $skippedAlreadyDone
            SkippedNoOrg     = $skippedNoOrg
            OutputPath       = $OutputPath
        }
    }

    # ── Pre-render prompts in the outer runspace (Get-Prompt is Private,
    # invisible in -Parallel workers — same fix as t/1550 aphorism). ────
    $moduleRoot = $script:ModuleRoot
    $promptSubs = [System.Collections.Generic.List[PSObject]]::new()
    foreach ($item in $workItems) {
        $docText = Get-Content $item.Snapshot -Raw
        if ($docText.Length -gt $MaxDocChars) { $docText = $docText.Substring(0, $MaxDocChars) }
        $rendered = Get-Prompt -Name 'org-stance-extraction' -Replacements @{
            org_name = $item.OrgName
            org_type = $item.OrgType
            document = $docText
        }
        $promptSubs.Add([PSCustomObject]@{
            OrgId     = $item.OrgId
            OrgName   = $item.OrgName
            OrgType   = $item.OrgType
            SourceId  = $item.SourceId
            Prompt    = $rendered
            DocChars  = $docText.Length
        })
    }

    if (-not $PSCmdlet.ShouldProcess("$Total document(s)", 'Extract stance claims via enrichment.org-stance-extraction')) {
        return [PSCustomObject]@{
            WouldProcess = $Total
            OutputPath   = $OutputPath
        }
    }

    # ── Extract (parallel) ───────────────────────────────────────────────
    $newClaims = [System.Collections.Concurrent.ConcurrentBag[PSObject]]::new()
    $failed    = [System.Collections.Concurrent.ConcurrentBag[string]]::new()
    $invalid   = [System.Collections.Concurrent.ConcurrentBag[string]]::new()
    # t/1553#14 — CL flagged that opposes-tagged claims which also contain
    # oppositional lexicon in the proposition (oppose/reject/resist/against/
    # "least promising") double-mark direction and invert stance downstream.
    # Lint surfaces recurrences; does NOT drop (CL's rule).
    $flagged   = [System.Collections.Concurrent.ConcurrentBag[PSObject]]::new()
    # Pattern covers direct opposition lexicon AND negated deontics
    # (t/1553#16 audit — "ought NOT to X" + polarity=opposes still inverts).
    $doubleMarkPattern = '(?i)(\b(oppose|reject|resist|against|least promising)\b|\b(ought|should|must|need|shall|may)\s+not\b)'

    # Validator scriptblock — passed through $using: to the parallel workers
    # (Test-OrgStanceClaim is a Private helper and isn't callable inside
    # -Parallel worker runspaces; same class of bug as Get-Prompt).
    $validator = {
        param($claim)
        if ($null -eq $claim) { return [PSCustomObject]@{ Ok = $false; Reason = 'null claim' } }
        if (-not $claim.PSObject.Properties['polarity']) { return [PSCustomObject]@{ Ok = $false; Reason = 'missing polarity' } }
        $pol = [string]$claim.polarity
        if ($pol -notin @('asserts', 'opposes')) { return [PSCustomObject]@{ Ok = $false; Reason = "polarity '$pol' not in {asserts, opposes}" } }
        if (-not $claim.PSObject.Properties['extraction_confidence']) { return [PSCustomObject]@{ Ok = $false; Reason = 'missing extraction_confidence' } }
        $conf = 0.0
        try { $conf = [double]$claim.extraction_confidence } catch { return [PSCustomObject]@{ Ok = $false; Reason = "extraction_confidence not numeric" } }
        if ($conf -lt 0.0 -or $conf -gt 1.0) { return [PSCustomObject]@{ Ok = $false; Reason = "extraction_confidence $conf out of [0,1]" } }
        if (-not $claim.PSObject.Properties['canonical_proposition']) { return [PSCustomObject]@{ Ok = $false; Reason = 'missing canonical_proposition' } }
        $prop = [string]$claim.canonical_proposition
        if ([string]::IsNullOrWhiteSpace($prop)) { return [PSCustomObject]@{ Ok = $false; Reason = 'canonical_proposition empty' } }
        $wc = @($prop -split '\s+' | Where-Object { $_ }).Count
        if ($wc -gt 60) { return [PSCustomObject]@{ Ok = $false; Reason = "canonical_proposition too long: $wc words (> 60)" } }
        if (-not $claim.PSObject.Properties['text']) { return [PSCustomObject]@{ Ok = $false; Reason = 'missing text' } }
        if ([string]::IsNullOrWhiteSpace([string]$claim.text)) { return [PSCustomObject]@{ Ok = $false; Reason = 'text empty' } }
        [PSCustomObject]@{ Ok = $true; Reason = $null }
    }
    $ModulePath = Join-Path $moduleRoot 'AITriad.psm1'
    $EnrichPath = Join-Path $moduleRoot '..' 'AIEnrich.psm1'
    if (-not (Test-Path $EnrichPath)) { $EnrichPath = Join-Path $moduleRoot 'AIEnrich.psm1' }
    $ProgressId = 1
    $Completed  = [ref]0

    Write-Progress -Id $ProgressId -Activity 'Extracting stance claims' -Status "0 / $Total" -PercentComplete 0

    if ($Concurrency -eq 1) {
        # Sequential path (deterministic, testable).
        foreach ($item in $promptSubs) {
            try {
                $ai = Invoke-AIByUsage -UsageId 'enrichment.org-stance-extraction' -Values @{
                    prompt = $item.Prompt
                }
                if ($null -ne $ai -and $ai.Text) {
                    # Defensive strip of any ```json ... ``` fences the model might add
                    # despite prompt "no markdown fences" instruction.
                    $body = [string]$ai.Text
                    $body = $body -replace '^\s*```(json)?\s*', ''
                    $body = $body -replace '\s*```\s*$', ''
                    $parsed = $body.Trim() | ConvertFrom-Json -ErrorAction Stop
                    foreach ($c in @($parsed.claims)) {
                        # Post-parse validation (t/1553#12 CL condition — schema no
                        # longer guards the boundary, so the cmdlet does).
                        $valid = & $validator $c
                        if (-not $valid.Ok) {
                            $invalid.Add("$($item.OrgId)::$($item.SourceId): $($valid.Reason)")
                            Write-Warning "Dropped claim for $($item.OrgId)::$($item.SourceId): $($valid.Reason)"
                            continue
                        }
                        # t/1553#14 double-mark lint (flag, not drop).
                        if ([string]$c.polarity -eq 'opposes' -and
                            ([string]$c.canonical_proposition) -match $doubleMarkPattern) {
                            $flagged.Add([PSCustomObject]@{
                                org_id                = $item.OrgId
                                source_id             = $item.SourceId
                                canonical_proposition = [string]$c.canonical_proposition
                                Reason                = 'double-mark: opposes-tagged proposition contains oppositional lexicon'
                            })
                        }
                        $newClaims.Add([PSCustomObject]@{
                            org_id                = $item.OrgId
                            source_id             = $item.SourceId
                            text                  = [string]$c.text
                            canonical_proposition = [string]$c.canonical_proposition
                            polarity              = [string]$c.polarity
                            extraction_confidence = [double]$c.extraction_confidence
                            extracted_at          = (Get-Date).ToString('o')
                            extraction_model      = if ($ai.PSObject.Properties['Model']) { $ai.Model } else { 'gemini-3.5-flash-lite' }
                        })
                    }
                } else {
                    $failed.Add("$($item.OrgId)::$($item.SourceId): empty AI response")
                }
            } catch {
                $failed.Add("$($item.OrgId)::$($item.SourceId): $($_.Exception.Message)")
                Write-Warning "$($item.OrgId)::$($item.SourceId): $($_.Exception.Message)"
            }
            $Done = [System.Threading.Interlocked]::Increment($Completed)
            $Pct  = [math]::Min(100, [math]::Round(($Done / $Total) * 100))
            Write-Progress -Id $ProgressId -Activity 'Extracting stance claims' -Status "$Done / $Total" -PercentComplete $Pct
        }
    } else {
        $promptSubs | ForEach-Object -Parallel {
            Import-Module $using:ModulePath -Force -WarningAction SilentlyContinue
            Import-Module $using:EnrichPath -Force -WarningAction SilentlyContinue
            $item      = $_
            $NewBag    = $using:newClaims
            $FailBag   = $using:failed
            $InvBag    = $using:invalid
            $FlagBag   = $using:flagged
            $DoubleMarkPattern = $using:doubleMarkPattern
            $CompRef   = $using:Completed
            $TotalCnt  = $using:Total
            $ProgId    = $using:ProgressId

            # Inline validator — ForEach-Object -Parallel forbids passing
            # scriptblocks via $using:, so we duplicate the logic here.
            $validator = {
                param($claim)
                if ($null -eq $claim) { return [PSCustomObject]@{ Ok = $false; Reason = 'null claim' } }
                if (-not $claim.PSObject.Properties['polarity']) { return [PSCustomObject]@{ Ok = $false; Reason = 'missing polarity' } }
                $pol = [string]$claim.polarity
                if ($pol -notin @('asserts', 'opposes')) { return [PSCustomObject]@{ Ok = $false; Reason = "polarity '$pol' not in {asserts, opposes}" } }
                if (-not $claim.PSObject.Properties['extraction_confidence']) { return [PSCustomObject]@{ Ok = $false; Reason = 'missing extraction_confidence' } }
                $conf = 0.0
                try { $conf = [double]$claim.extraction_confidence } catch { return [PSCustomObject]@{ Ok = $false; Reason = "extraction_confidence not numeric" } }
                if ($conf -lt 0.0 -or $conf -gt 1.0) { return [PSCustomObject]@{ Ok = $false; Reason = "extraction_confidence $conf out of [0,1]" } }
                if (-not $claim.PSObject.Properties['canonical_proposition']) { return [PSCustomObject]@{ Ok = $false; Reason = 'missing canonical_proposition' } }
                $prop = [string]$claim.canonical_proposition
                if ([string]::IsNullOrWhiteSpace($prop)) { return [PSCustomObject]@{ Ok = $false; Reason = 'canonical_proposition empty' } }
                $wc = @($prop -split '\s+' | Where-Object { $_ }).Count
                if ($wc -gt 60) { return [PSCustomObject]@{ Ok = $false; Reason = "canonical_proposition too long: $wc words (> 60)" } }
                if (-not $claim.PSObject.Properties['text']) { return [PSCustomObject]@{ Ok = $false; Reason = 'missing text' } }
                if ([string]::IsNullOrWhiteSpace([string]$claim.text)) { return [PSCustomObject]@{ Ok = $false; Reason = 'text empty' } }
                [PSCustomObject]@{ Ok = $true; Reason = $null }
            }

            try {
                $ai = Invoke-AIByUsage -UsageId 'enrichment.org-stance-extraction' -Values @{
                    prompt = $item.Prompt
                }
                if ($null -ne $ai -and $ai.Text) {
                    # Defensive strip of any ```json ... ``` fences the model might add
                    # despite prompt "no markdown fences" instruction.
                    $body = [string]$ai.Text
                    $body = $body -replace '^\s*```(json)?\s*', ''
                    $body = $body -replace '\s*```\s*$', ''
                    $parsed = $body.Trim() | ConvertFrom-Json -ErrorAction Stop
                    foreach ($c in @($parsed.claims)) {
                        $valid = & $validator $c
                        if (-not $valid.Ok) {
                            $InvBag.Add("$($item.OrgId)::$($item.SourceId): $($valid.Reason)")
                            Write-Warning "Dropped claim for $($item.OrgId)::$($item.SourceId): $($valid.Reason)"
                            continue
                        }
                        # t/1553#14 double-mark lint (flag, not drop).
                        if ([string]$c.polarity -eq 'opposes' -and
                            ([string]$c.canonical_proposition) -match $DoubleMarkPattern) {
                            $FlagBag.Add([PSCustomObject]@{
                                org_id                = $item.OrgId
                                source_id             = $item.SourceId
                                canonical_proposition = [string]$c.canonical_proposition
                                Reason                = 'double-mark: opposes-tagged proposition contains oppositional lexicon'
                            })
                        }
                        $NewBag.Add([PSCustomObject]@{
                            org_id                = $item.OrgId
                            source_id             = $item.SourceId
                            text                  = [string]$c.text
                            canonical_proposition = [string]$c.canonical_proposition
                            polarity              = [string]$c.polarity
                            extraction_confidence = [double]$c.extraction_confidence
                            extracted_at          = (Get-Date).ToString('o')
                            extraction_model      = if ($ai.PSObject.Properties['Model']) { $ai.Model } else { 'gemini-3.5-flash-lite' }
                        })
                    }
                } else {
                    $FailBag.Add("$($item.OrgId)::$($item.SourceId): empty AI response")
                }
            } catch {
                $FailBag.Add("$($item.OrgId)::$($item.SourceId): $($_.Exception.Message)")
                Write-Warning "$($item.OrgId)::$($item.SourceId): $($_.Exception.Message)"
            }

            $Done = [System.Threading.Interlocked]::Increment($CompRef)
            $Pct  = [math]::Min(100, [math]::Round(($Done / $TotalCnt) * 100))
            Write-Progress -Id $ProgId -Activity 'Extracting stance claims' -Status "$Done / $TotalCnt" -PercentComplete $Pct
        } -ThrottleLimit $Concurrency
    }

    Write-Progress -Id $ProgressId -Activity 'Extracting stance claims' -Completed

    # ── text_verbatim (t/4382) ───────────────────────────────────────────
    # Computed here, after collection, so both the sequential and the parallel path get it (the
    # parallel runspaces can't call module helpers). FORENSIC FIELD: NO consumer branches on
    # text_verbatim. THE EXEMPTION LAPSES the moment a consumer branches on it (root AGENTS.md, T0).
    # It records whether `text` is a verbatim span of the source snapshot (Test-StanceTextVerbatim);
    # a paraphrase passed downstream as a quote can blur Invoke-OrgClaimMatching's polarity signal.
    $snapshotBySource = @{}; foreach ($w in @($workItems)) { $snapshotBySource[[string]$w.SourceId] = [string]$w.Snapshot }
    $snapshotText = @{}; $notVerbatim = 0
    foreach ($c in @($newClaims)) {
        $sp = $snapshotBySource[[string]$c.source_id]
        if ($sp -and -not $snapshotText.ContainsKey($sp)) { $snapshotText[$sp] = [System.IO.File]::ReadAllText($sp) }
        $isVerbatim = [bool]($sp -and (Test-StanceTextVerbatim -Text ([string]$c.text) -Snapshot $snapshotText[$sp]))
        $c | Add-Member -NotePropertyName 'text_verbatim' -NotePropertyValue $isVerbatim -Force
        if (-not $isVerbatim) {
            $notVerbatim++
            $t = [string]$c.text; $preview = if ($t.Length -gt 80) { $t.Substring(0, 80) + '…' } else { $t }
            Write-Warning "Invoke-OrgStanceExtraction: claim text for $($c.org_id)::$($c.source_id) is not a verbatim span of its snapshot (paraphrase?): '$preview'"
        }
    }

    # ── Merge + persist ──────────────────────────────────────────────────
    $writtenNew   = @($newClaims).Count
    if ($writtenNew -gt 0) {
        # -Force replaces old claims for the same (org, source); no-Force
        # can't reach here for existing (org, source) pairs anyway.
        if ($Force) {
            $refreshedKeys = @{}
            foreach ($item in $promptSubs) { $refreshedKeys["$($item.OrgId)::$($item.SourceId)"] = 1 }
            $keep = [System.Collections.Generic.List[PSObject]]::new()
            foreach ($c in $existingClaims) {
                $k = "$($c.org_id)::$($c.source_id)"
                if (-not $refreshedKeys.ContainsKey($k)) { $keep.Add($c) }
            }
            $existingClaims = $keep
        }
        foreach ($c in @($newClaims)) { $existingClaims.Add($c) }
    }

    $store = [PSCustomObject]@{
        _schema_version = '1.0.0'
        _doc            = 'Organization stance claims extracted per t/1553 Stage 1. Feeds Stage 2/3 claim→node matching. Machine-proposed / human-disposes downstream.'
        last_modified   = (Get-Date).ToString('yyyy-MM-dd')
        claim_count     = @($existingClaims).Count
        claims          = @($existingClaims)
    }

    if ($writtenNew -gt 0) {
        Assert-DataWriteAllowed -Path $OutputPath  # t/2902
        $temp = "$OutputPath.tmp"
        $json = $store | ConvertTo-Json -Depth 8
        Set-Content -Path $temp -Value $json -Encoding utf8NoBOM
        [System.IO.File]::Move($temp, $OutputPath, $true)
    }

    $failCount    = @($failed).Count
    $invalidCount = @($invalid).Count
    $flaggedCount = @($flagged).Count
    Write-Host ""
    Write-Host "Done. Documents processed: $Total | Claims extracted: $writtenNew | Invalid dropped: $invalidCount | Double-mark flagged: $flaggedCount | Failed: $failCount | Skipped no-doc: $skippedNoDoc | Skipped already-done: $skippedAlreadyDone"

    [PSCustomObject]@{
        Extracted          = $Total - $failCount
        ClaimsWritten      = $writtenNew
        InvalidDropped     = $invalidCount
        InvalidItems       = @($invalid)
        FlaggedDoubleMark  = $flaggedCount
        FlaggedItems       = @($flagged)
        Failed             = $failCount
        FailedItems        = @($failed)
        SkippedNoDoc       = $skippedNoDoc
        SkippedAlreadyDone = $skippedAlreadyDone
        SkippedNoOrg       = $skippedNoOrg
        OutputPath         = $OutputPath
    }
}
