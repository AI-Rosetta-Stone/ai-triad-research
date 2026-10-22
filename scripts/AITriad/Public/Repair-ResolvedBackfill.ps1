# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Repair-ResolvedBackfill {
    <#
    .SYNOPSIS
        Backfills key_points from resolved unmapped concepts into pov_summaries.
    .DESCRIPTION
        When unmapped concepts are resolved (matched to taxonomy nodes via
        Repair-UnmappedConcepts), they receive a resolved_node_id but are NOT
        automatically promoted into the pov_summaries key_points arrays.

        This cmdlet scans every summary's unmapped_concepts for entries that
        have a resolved_node_id, checks whether that concept already appears in
        the corresponding POV's key_points, and if not, creates a new
        key_point entry with extraction_confidence 0.7 and
        excerpt_context "unmapped_concept_backfill".

        t/3900: a resolved_node_id that no longer names a LIVE taxonomy node is
        skipped (logged, never written) -- a t/3595-style cleanup can null a
        backfilled key_point's taxonomy_node_id (intentionally unlinked) while
        leaving THIS field, the origin pointer, dead. "Already appears" counts a
        null-linked backfill entry with the same point text as already
        represented, regardless of its current taxonomy_node_id -- null means
        intentionally unlinked, not missing, so it must not be re-backfilled.

        POV mapping:
          - suggested_pov "accelerationist" -> pov_summaries.accelerationist.key_points
          - suggested_pov "safetyist"       -> pov_summaries.safetyist.key_points
          - suggested_pov "skeptic"         -> pov_summaries.skeptic.key_points
          - suggested_pov "situations"      -> SKIPPED (no key_points section)
          - suggested_pov "cross_cutting"   -> SKIPPED (no pov_summaries section)

        Also scans factual_claims to identify candidates whose
        linked_taxonomy_nodes share a POV family prefix with resolved concepts.
        These are logged for manual review but not auto-modified.
    .PARAMETER DocId
        Wildcard pattern to limit which summaries to process.
        Default: '*' (all summaries).
    .PARAMETER WhatIf
        Show what would be changed without writing files.
    .EXAMPLE
        Repair-ResolvedBackfill
        # Process all summaries.
    .EXAMPLE
        Repair-ResolvedBackfill -DocId '*constitution*'
        # Process only matching summaries.
    .EXAMPLE
        Repair-ResolvedBackfill -WhatIf
        # Preview changes without modifying files.
    .LINK
        Show-AITriadHelp
    .LINK
        Repair-PovAttributes
    .LINK
        Repair-PovDescriptions
    .LINK
        Repair-PovLineage
    .LINK
        Repair-UnmappedConcepts
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [string]$DocId = '*'
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    $SummariesDir = Get-SummariesDir

    if (-not (Test-Path $SummariesDir)) {
        Write-Fail "Summaries directory not found: $SummariesDir"
        return
    }

    $SummaryFiles = @(Get-ChildItem -Path $SummariesDir -Filter '*.json' -File |
        Where-Object { $_.BaseName -like $DocId })

    if ($SummaryFiles.Count -eq 0) {
        Write-Warn "No summary files matched pattern '$DocId'"
        return
    }

    # Valid POV names that map to pov_summaries sections
    $ValidPovs = @('accelerationist', 'safetyist', 'skeptic')

    # POV family prefixes for factual_claims candidate matching
    $PovPrefixes = @{
        accelerationist = 'acc-'
        safetyist       = 'saf-'
        skeptic         = 'skp-'
    }

    Write-Step "Scanning $($SummaryFiles.Count) summary file(s) for resolved unmapped concepts"
    Write-Info "Action: For each resolved unmapped concept, check if its node already"
    Write-Info "        appears in pov_summaries key_points. If not, create a new entry."
    Write-Info ""

    $TotalBackfilled      = 0
    $TotalAlreadyLinked   = 0
    $TotalSkippedPov      = 0
    $TotalSkippedNoPov    = 0
    $TotalSkippedDeadNode = 0
    $FilesModified        = 0
    $AllBackfills       = [System.Collections.Generic.List[PSObject]]::new()
    $AllSkipped         = [System.Collections.Generic.List[PSObject]]::new()
    $AllClaimCandidates = [System.Collections.Generic.List[PSObject]]::new()

    foreach ($File in $SummaryFiles) {
        try {
            $Summary = ConvertFrom-JsonPreserveShape -Json (Get-Content -Raw -Path $File.FullName)   # whole-file rewrite (t/4425)
        }
        catch {
            Write-Warn "Failed to parse $($File.Name): $_"
            continue
        }

        $DocName = $File.BaseName

        # ── Check for unmapped_concepts with resolved_node_id ────────────
        $HasUnmapped = $Summary.PSObject.Properties['unmapped_concepts']
        if (-not $HasUnmapped -or -not $HasUnmapped.Value) { continue }
        $Unmapped = @($HasUnmapped.Value)
        if ($Unmapped.Count -eq 0) { continue }

        # Filter to only resolved concepts. t/3907: a bare `null` element (writer
        # artifact from chunk-merge) must not reach PSObject.Properties under
        # StrictMode -- it throws "The property 'Properties' cannot be found".
        $NullConceptCount = @($Unmapped | Where-Object { $null -eq $_ }).Count
        if ($NullConceptCount -gt 0) {
            Write-Warn "$DocName — skipping $NullConceptCount null entry/entries in unmapped_concepts (t/3907)"
        }
        $ResolvedConcepts = @($Unmapped | Where-Object {
            $null -ne $_ -and
            $_.PSObject.Properties['resolved_node_id'] -and
            -not [string]::IsNullOrWhiteSpace($_.resolved_node_id)
        })
        if ($ResolvedConcepts.Count -eq 0) { continue }

        # ── Ensure pov_summaries exists ──────────────────────────────────
        $HasPovSummaries = $Summary.PSObject.Properties['pov_summaries']
        if (-not $HasPovSummaries -or -not $HasPovSummaries.Value) {
            Write-Warn "$DocName — no pov_summaries section, skipping $($ResolvedConcepts.Count) resolved concept(s)"
            continue
        }
        $PovSummaries = $Summary.pov_summaries

        # ── Build per-POV dedupe sets (t/3900: node-id set + text-based backfill
        #    set, so a null-linked backfill entry still counts as represented) ──
        $LinkSets = Get-BackfillLinkSets -PovSummaries $PovSummaries -ValidPovs $ValidPovs
        $ExistingNodeIds = $LinkSets.NodeIds
        $ExistingBackfillPoints = $LinkSets.BackfillPoints

        # ── Collect factual_claims for candidate matching ────────────────
        $FactualClaims = @()
        if ($Summary.PSObject.Properties['factual_claims'] -and $Summary.factual_claims) {
            $FactualClaims = @($Summary.factual_claims)
        }

        $FileModified = $false
        $FileBackfillCount = 0

        foreach ($Concept in $ResolvedConcepts) {
            $NodeId      = $Concept.resolved_node_id
            $SuggestedPov = if ($Concept.PSObject.Properties['suggested_pov']) { $Concept.suggested_pov } else { $null }
            $ConceptText = if ($Concept.PSObject.Properties['concept']) { $Concept.concept } else { '' }
            $Category    = if ($Concept.PSObject.Properties['suggested_category']) { $Concept.suggested_category } else { 'Beliefs' }
            $Label       = if ($Concept.PSObject.Properties['suggested_label']) { $Concept.suggested_label } else { '' }

            # ── Skip non-POV concepts (situations, cross_cutting) ────────
            if (-not $SuggestedPov -or $SuggestedPov -eq 'situations') {
                $TotalSkippedPov++
                $null = $AllSkipped.Add([PSCustomObject]@{
                    DocId     = $DocName
                    NodeId    = $NodeId
                    Pov       = $SuggestedPov
                    Label     = $Label
                    Reason    = 'situations_pov'
                })
                Write-Info "$DocName — SKIP '$Label' ($NodeId): suggested_pov is 'situations' (no key_points section)"
                continue
            }

            if ($SuggestedPov -eq 'cross_cutting' -or $SuggestedPov -eq 'cross-cutting') {
                $TotalSkippedPov++
                $null = $AllSkipped.Add([PSCustomObject]@{
                    DocId     = $DocName
                    NodeId    = $NodeId
                    Pov       = $SuggestedPov
                    Label     = $Label
                    Reason    = 'cross_cutting_pov'
                })
                Write-Info "$DocName — SKIP '$Label' ($NodeId): suggested_pov is '$SuggestedPov' (no pov_summaries section)"
                continue
            }

            # ── Validate the POV section exists ──────────────────────────
            if ($SuggestedPov -notin $ValidPovs) {
                $TotalSkippedNoPov++
                $null = $AllSkipped.Add([PSCustomObject]@{
                    DocId     = $DocName
                    NodeId    = $NodeId
                    Pov       = $SuggestedPov
                    Label     = $Label
                    Reason    = 'unknown_pov'
                })
                Write-Warn "$DocName — SKIP '$Label' ($NodeId): unknown suggested_pov '$SuggestedPov'"
                continue
            }

            if (-not $PovSummaries.PSObject.Properties[$SuggestedPov] -or -not $PovSummaries.$SuggestedPov) {
                $TotalSkippedNoPov++
                $null = $AllSkipped.Add([PSCustomObject]@{
                    DocId     = $DocName
                    NodeId    = $NodeId
                    Pov       = $SuggestedPov
                    Label     = $Label
                    Reason    = 'pov_section_missing'
                })
                Write-Warn "$DocName — SKIP '$Label' ($NodeId): POV section '$SuggestedPov' not found in pov_summaries"
                continue
            }

            # ── Never write a dead id (t/3900) ───────────────────────────
            # A t/3595-style cleanup nulls the key_point's taxonomy_node_id but leaves
            # unmapped_concepts[].resolved_node_id pointing at the now-dead id. Without
            # this check, backfill re-derives a fresh key_point from that dead source
            # pointer every run. Fallback-path logging (root AGENTS.md): this is a
            # degraded/skip path, so it's logged, not silent.
            if (-not (Test-TaxonomyNodeId -NodeId $NodeId)) {
                $TotalSkippedDeadNode++
                $null = $AllSkipped.Add([PSCustomObject]@{
                    DocId     = $DocName
                    NodeId    = $NodeId
                    Pov       = $SuggestedPov
                    Label     = $Label
                    Reason    = 'dead_node_id'
                })
                Write-Warn "$DocName — SKIP '$Label' ($NodeId): resolved_node_id is not a live taxonomy node (t/3900)"
                continue
            }

            # ── Check if node already exists in key_points ───────────────
            # t/3900: a backfill entry whose point text already appears for this POV
            # counts as already represented REGARDLESS of its current taxonomy_node_id
            # (null included) -- null means intentionally unlinked, not missing.
            if ($ExistingNodeIds[$SuggestedPov].Contains($NodeId) -or
                $ExistingBackfillPoints[$SuggestedPov].Contains($ConceptText)) {
                $TotalAlreadyLinked++
                Write-Info "$DocName — ALREADY LINKED '$Label' ($NodeId) in $SuggestedPov key_points"
                continue
            }

            # ── Create the new key_point entry ───────────────────────────
            $NewKeyPoint = [PSCustomObject]@{
                stance                = 'aligned'
                taxonomy_node_id      = $NodeId
                category              = $Category
                point                 = $ConceptText
                verbatim              = $null
                excerpt_context       = 'unmapped_concept_backfill'
                extraction_confidence = 0.7
                vocabulary_terms      = @()
            }

            if ($PSCmdlet.ShouldProcess("$($File.Name) [$SuggestedPov]", "Add key_point for $NodeId '$Label'")) {
                $PovSection = $PovSummaries.$SuggestedPov

                # Ensure key_points array exists
                if (-not $PovSection.PSObject.Properties['key_points'] -or $null -eq $PovSection.key_points) {
                    $PovSection | Add-Member -NotePropertyName 'key_points' -NotePropertyValue @() -Force
                }

                # Append the new key_point — wrap existing in @() for safety then build new array
                $CurrentPoints = @($PovSection.key_points)
                $PovSection.key_points = @($CurrentPoints) + @($NewKeyPoint)

                # Track the new node ID so we don't duplicate within this file
                $null = $ExistingNodeIds[$SuggestedPov].Add($NodeId)

                $FileModified = $true
                $FileBackfillCount++
                $TotalBackfilled++
            }

            $null = $AllBackfills.Add([PSCustomObject]@{
                DocId    = $DocName
                NodeId   = $NodeId
                Pov      = $SuggestedPov
                Category = $Category
                Label    = $Label
            })

            Write-OK "$DocName — BACKFILL '$Label' ($NodeId) -> $SuggestedPov.key_points"

            # ── Factual claims candidate matching ────────────────────────
            # Find claims that share a POV family prefix with this concept's node
            if ($PovPrefixes.ContainsKey($SuggestedPov)) {
                $Prefix = $PovPrefixes[$SuggestedPov]
                foreach ($Claim in $FactualClaims) {
                    if ($null -eq $Claim) { continue }
                    if (-not $Claim.PSObject.Properties['linked_taxonomy_nodes'] -or -not $Claim.linked_taxonomy_nodes) {
                        continue
                    }
                    $LinkedNodes = @($Claim.linked_taxonomy_nodes)
                    $SharesFamily = $false
                    foreach ($LinkedNode in $LinkedNodes) {
                        if ($LinkedNode -is [string] -and $LinkedNode.StartsWith($Prefix)) {
                            $SharesFamily = $true
                            break
                        }
                    }
                    if ($SharesFamily) {
                        $ClaimLabel = if ($Claim.PSObject.Properties['claim_label']) { $Claim.claim_label } else { '' }
                        $ClaimText  = if ($Claim.PSObject.Properties['claim']) { $Claim.claim } else { '' }

                        # Avoid duplicate candidate entries
                        $AlreadyLogged = $false
                        foreach ($Existing in $AllClaimCandidates) {
                            if ($Existing.DocId -eq $DocName -and
                                $Existing.ClaimLabel -eq $ClaimLabel -and
                                $Existing.ConceptNodeId -eq $NodeId) {
                                $AlreadyLogged = $true
                                break
                            }
                        }
                        if (-not $AlreadyLogged) {
                            $null = $AllClaimCandidates.Add([PSCustomObject]@{
                                DocId           = $DocName
                                ClaimLabel      = $ClaimLabel
                                ClaimText       = $ClaimText
                                LinkedNodes     = ($LinkedNodes -join ', ')
                                ConceptNodeId   = $NodeId
                                ConceptLabel    = $Label
                                PovFamily       = $SuggestedPov
                            })
                        }
                    }
                }
            }
        }

        # ── Write modified file ──────────────────────────────────────────
        if ($FileModified) {
            $Json = $Summary | ConvertTo-Json -Depth 20
            Write-Utf8NoBom -Path $File.FullName -Value $Json
            $FilesModified++
            Write-Info "$DocName — wrote $FileBackfillCount new key_point(s)"
        }
    }

    # ── Summary output ───────────────────────────────────────────────────
    Write-Step "Backfill complete"
    Write-OK   "$TotalBackfilled key_point(s) backfilled across $FilesModified file(s)"

    if ($TotalAlreadyLinked -gt 0) {
        Write-Info "$TotalAlreadyLinked resolved concept(s) already had key_points — no action needed"
    }
    if ($TotalSkippedPov -gt 0) {
        Write-Info "$TotalSkippedPov concept(s) skipped — suggested_pov was 'situations' or 'cross_cutting' (no key_points section)"
    }
    if ($TotalSkippedNoPov -gt 0) {
        Write-Warn "$TotalSkippedNoPov concept(s) skipped — POV section missing or unrecognized"
    }
    if ($TotalSkippedDeadNode -gt 0) {
        Write-Warn "$TotalSkippedDeadNode concept(s) skipped — resolved_node_id is not a live taxonomy node (t/3900)"
    }

    # ── Factual claims candidate report ──────────────────────────────────
    if ($AllClaimCandidates.Count -gt 0) {
        Write-Step "Factual claims candidates for manual review"
        Write-Info "The following factual_claims share a POV-family prefix with backfilled concepts."
        Write-Info "They may benefit from linked_taxonomy_nodes updates. Review manually."
        Write-Info ""
        foreach ($Candidate in $AllClaimCandidates) {
            Write-Info "$($Candidate.DocId):"
            Write-Info "  Claim: $($Candidate.ClaimLabel)"
            Write-Info "  Current linked nodes: $($Candidate.LinkedNodes)"
            Write-Info "  Related concept node: $($Candidate.ConceptNodeId) ($($Candidate.ConceptLabel))"
            Write-Info ""
        }
        Write-Info "$($AllClaimCandidates.Count) candidate claim(s) identified for review"
    }

    # ── Return results ───────────────────────────────────────────────────
    return [PSCustomObject]@{
        Backfilled      = $AllBackfills
        Skipped         = $AllSkipped
        ClaimCandidates = $AllClaimCandidates
        Statistics      = [PSCustomObject]@{
            TotalBackfilled      = $TotalBackfilled
            TotalAlreadyLinked   = $TotalAlreadyLinked
            TotalSkippedPov      = $TotalSkippedPov
            TotalSkippedNoPov    = $TotalSkippedNoPov
            TotalSkippedDeadNode = $TotalSkippedDeadNode
            FilesModified        = $FilesModified
        }
    }
}
