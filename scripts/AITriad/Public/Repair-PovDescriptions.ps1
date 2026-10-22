# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Repair-PovDescriptions {
    <#
    .SYNOPSIS
        Detects and repairs POV node description issues: wrong genus, missing
        Encompasses/Excludes clauses, and truncated sentences.
    .DESCRIPTION
        Scans POV taxonomy files for 4 issue types:
          1. Wrong genus prefix (deterministic fix — no AI)
          2. Missing Encompasses clause (AI-assisted)
          3. Missing Excludes clause (AI-assisted)
          4. Truncated mid-sentence (AI-assisted completion)

        Uses -WhatIf to preview changes. Deterministic fixes (wrong genus) are
        applied without AI calls. AI fixes use temperature 0.2 for repair fidelity.
    .PARAMETER POV
        Filter to a specific POV file.
    .PARAMETER Category
        Filter to a specific BDI category.
    .PARAMETER Model
        AI model for description repair. Default: gemini-3.5-flash-lite.
    .PARAMETER ApiKey
        AI API key. Resolved from env if omitted.
    .EXAMPLE
        Repair-PovDescriptions -WhatIf
    .EXAMPLE
        Repair-PovDescriptions -POV safetyist
    .EXAMPLE
        Repair-PovDescriptions -Category Beliefs -Model gemini-3.5-flash-lite
    .LINK
        Show-AITriadHelp
    .LINK
        Repair-PovAttributes
    .LINK
        Repair-PovLineage
    .LINK
        Repair-ResolvedBackfill
    .LINK
        Repair-UnmappedConcepts
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [ValidateSet('accelerationist', 'safetyist', 'skeptic')]
        [string]$POV,

        [ValidateSet('Beliefs', 'Desires', 'Intentions')]
        [string]$Category,

        [ValidateScript({ Test-AIModelId $_ })]
        [ArgumentCompleter({ param($cmd, $param, $word) $script:ValidModelIds | Where-Object { $_ -like "$word*" } })]
        [string]$Model = (Get-AITierModel -Tier basic),

        [string]$ApiKey
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    $TaxDir = Get-TaxonomyDir

    # Resolve API key for AI fixes
    # Backend from ai-models.json, never guessed; only the user's -ApiKey is forwarded (t/4087).
    $HasAIKey = $false
    if (-not $WhatIfPreference) {
        $HasAIKey = (Get-AIModelKeyStatus -Model $Model -ApiKey $ApiKey).HasKey
    }

    $PovFiles = @('accelerationist', 'safetyist', 'skeptic')
    if ($POV) { $PovFiles = @($POV) }

    $GenusMap = @{
        Beliefs    = 'A Belief within'
        Desires    = 'A Desire within'
        Intentions = 'An Intention within'
    }

    $TotalFixed = 0
    $TotalSkipped = 0
    $IssuesByType = @{ wrong_genus = 0; missing_encompasses = 0; missing_excludes = 0; truncated = 0 }

    foreach ($PovName in $PovFiles) {
        $FilePath = Join-Path $TaxDir "$PovName.json"
        if (-not (Test-Path $FilePath)) { continue }

        $Data = Get-Content $FilePath -Raw | ConvertFrom-Json
        $Modified = $false

        Write-Host "`n=== $PovName ===" -ForegroundColor Cyan

        foreach ($Node in $Data.nodes) {
            $Desc = $Node.description
            if (-not $Desc) { continue }
            if (Test-TaxonomyNodeSuperseded $Node) { continue }   # no AI rewrite of a retired node; $Data keeps it (t/4356)
            # Skip parent nodes
            if ($Node.PSObject.Properties['children'] -and $Node.children -and @($Node.children).Count -gt 0) { continue }
            # Category filter
            if ($Category -and $Node.category -ne $Category) { continue }

            $NodeCat = $Node.category
            $Issues = [System.Collections.Generic.List[string]]::new()
            $NewDesc = $Desc

            # ── Issue 1: Wrong genus ──────────────────────────────────────
            if ($Desc -notmatch '^An?\s+(Belief|Desire|Intention)\s+within') {
                $Issues.Add('wrong_genus')
                $IssuesByType.wrong_genus++

                if ($NodeCat -and $GenusMap.ContainsKey($NodeCat)) {
                    $Prefix = "$($GenusMap[$NodeCat]) $PovName discourse that"
                    # Try to salvage the existing text after the bad prefix
                    if ($NewDesc -match '^An?\s+\w+\s+(?:within\s+\w+\s+discourse\s+that\s+|to\s+|that\s+|where\s+|for\s+)(.+)') {
                        $NewDesc = "$Prefix $($Matches[1])"
                    }
                    elseif ($NewDesc -match '^(?:The\s+process\s+of|A\s+(?:strategy|method|practice|policy\s+approach|situation\s+concept)\s+(?:where|that|for|of)\s*)(.+)') {
                        $NewDesc = "$Prefix describes $($Matches[1])"
                    }
                    else {
                        # Wrap entirely
                        $NewDesc = "$Prefix describes the following: $NewDesc"
                    }
                }
            }

            # ── Issue 2: Truncated sentence ───────────────────────────────
            $Trimmed = $NewDesc.TrimEnd()
            $LastChar = $Trimmed[-1]
            $EndsOk = $Trimmed -match '[.!?]["\x27\)\u201D]?\s*$'
            if ($LastChar -match '[a-zA-Z]' -and -not $EndsOk) {
                $Issues.Add('truncated')
                $IssuesByType.truncated++
            }

            # ── Issue 3/4: Missing Encompasses / Excludes ─────────────────
            if ($NewDesc -notmatch 'Encompasses:') {
                $Issues.Add('missing_encompasses')
                $IssuesByType.missing_encompasses++
            }
            if ($NewDesc -notmatch 'Excludes:') {
                $Issues.Add('missing_excludes')
                $IssuesByType.missing_excludes++
            }

            if ($Issues.Count -eq 0) { continue }

            # ── Determine if AI is needed ─────────────────────────────────
            $NeedsAI = $Issues.Contains('truncated') -or $Issues.Contains('missing_encompasses') -or $Issues.Contains('missing_excludes')
            $IsGenusOnly = $Issues.Count -eq 1 -and $Issues[0] -eq 'wrong_genus'

            # ── Show before ───────────────────────────────────────────────
            $BeforeTail = if ($Desc.Length -gt 60) { "...$($Desc.Substring($Desc.Length - 60))" } else { $Desc }

            if ($NeedsAI -and -not $WhatIfPreference -and $HasAIKey) {
                # AI-assisted repair
                $Prompt = @"
You are repairing a taxonomy node description. Do NOT rewrite — only fix the specific issues listed.

Node: $($Node.id)
Label: $($Node.label)
Category: $NodeCat
POV: $PovName

Current description:
$NewDesc

Issues to fix:
$(($Issues | ForEach-Object { "- $_" }) -join "`n")

Rules:
1. If the description is truncated mid-sentence, complete ONLY the broken sentence (1 clause).
2. If missing Encompasses: clause, add it on a new line. Format: "Encompasses: [2-4 concrete sub-themes]."
3. If missing Excludes: clause, add it on a new line. Format: "Excludes: [what neighboring concepts cover instead]."
4. The description MUST use genus-differentia structure with 3 lines separated by \n:
   Line 1: "$($GenusMap[$NodeCat] ?? 'A Belief within') $PovName discourse that [differentia]."
   Line 2: "Encompasses: [sub-themes]."
   Line 3: "Excludes: [boundaries]."
5. Preserve existing text verbatim where it is correct — only add missing parts.
6. Return ONLY the corrected description text. No JSON, no markdown, no explanation.
"@

                try {
                    $Result = Invoke-AIApi -Prompt $Prompt -Model $Model -ApiKey $ApiKey `
                        -Temperature 0.2 -MaxTokens 1024 -TimeoutSec 30
                    if ($Result -and $Result.Text) {
                        $NewDesc = $Result.Text.Trim() -replace '^\s*```\s*', '' -replace '\s*```\s*$', ''
                    }
                }
                catch {
                    Write-Warning "  AI repair failed for $($Node.id): $($_.Exception.Message)"
                    $TotalSkipped++
                    continue
                }
            }

            $AfterTail = if ($NewDesc.Length -gt 60) { "...$($NewDesc.Substring($NewDesc.Length - 60))" } else { $NewDesc }

            # ── Apply or preview ──────────────────────────────────────────
            $IssueLabel = $Issues -join ', '
            if ($PSCmdlet.ShouldProcess("$($Node.id) [$IssueLabel]", 'Repair description')) {
                Add-TextHistoryEntry -Node $Node -Field 'description' `
                    -Previous $Desc -Value $NewDesc -Source 'batch_audit' `
                    -Reason "Repair: $IssueLabel"
                $Node.description = $NewDesc
                # t/1550 — regenerate aphorism after description rewrite. Fail-open.
                Set-NodeAphorism -Node $Node -Pov $PovName -Reason 'repair-description'
                $Modified = $true
                $TotalFixed++
                Write-Host "  FIXED $($Node.id) [$IssueLabel]" -ForegroundColor Green
                Write-Host "    Before: $BeforeTail" -ForegroundColor DarkGray
                Write-Host "    After:  $AfterTail" -ForegroundColor Gray
            }
            else {
                Write-Host "  WOULD FIX $($Node.id) [$IssueLabel]" -ForegroundColor Yellow
                Write-Host "    Tail: $BeforeTail" -ForegroundColor DarkGray
                if ($NeedsAI) {
                    Write-Host "    Fix:  (AI will complete — requires API call)" -ForegroundColor DarkYellow
                } else {
                    Write-Host "    After: $AfterTail" -ForegroundColor Gray
                }
            }
        }

        # Write back if modified
        if ($Modified -and -not $WhatIfPreference) {
            Assert-DataWriteAllowed -Path $FilePath  # t/2902
            $Data | ConvertTo-Json -Depth 20 | Set-Content -Path $FilePath -Encoding UTF8
            Write-Host "  Saved $FilePath" -ForegroundColor Green
        }
    }

    Write-Host "`n=== SUMMARY ===" -ForegroundColor Cyan
    Write-Host "  Issues found:"
    $IssuesByType.GetEnumerator() | Sort-Object Name | ForEach-Object { Write-Host "    $($_.Key): $($_.Value)" }
    Write-Host "  Fixed: $TotalFixed"
    Write-Host "  Skipped: $TotalSkipped"
}
