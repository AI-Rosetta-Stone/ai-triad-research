# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Invoke-EdgeRationaleBackfill {
    <#
    .SYNOPSIS
        Backfills missing/empty `rationale` on existing edges via AI (t/2679).
    .DESCRIPTION
        Historical edges in edges.json predate the `rationale` field (t/2674: 99.5%
        absent). This cmdlet finds edges whose rationale is missing or empty, asks an
        LLM to generate one from the source+target node text and the edge type, and
        writes it back via Write-EdgesFile — WITHOUT changing any edge's status.

        Idempotent: edges that already have a non-empty rationale are skipped unless
        -Force. Resumable: writes a checkpoint every -CheckpointEvery successful
        backfills, so an interrupted run can be re-run and picks up where it left off.
        Silent-blank safe: if the LLM returns no rationale, the edge is left unchanged
        and the omission is surfaced (a Write-Warning count), never written as ''
        (the t/2674 observability contract).
    .PARAMETER Scope
        'UIVisible' (default) backfills only approved edges (those rendered in the
        EdgeBrowser). 'All' backfills every rationale-less edge regardless of status.
    .PARAMETER Limit
        Cap the number of edges processed this run (0 = no cap). Use for a costed
        pilot, e.g. -Limit 200.
    .PARAMETER MinConfidence
        Only backfill edges whose `confidence` is >= this value (0.0 = no filter).
        e.g. -MinConfidence 0.95 restricts to the highest-confidence edges. Self-loops
        (source == target) are always skipped regardless of this setting.
    .PARAMETER Model
        AI model. Default 'gemini-3.5-flash-lite' (free tier).
    .PARAMETER ApiKey
        AI API key. If omitted, resolved via backend env var (GEMINI_API_KEY, etc).
    .PARAMETER Temperature
        Sampling temperature. Default 0.3.
    .PARAMETER Force
        Overwrite existing non-empty rationales too (default: skip already-populated).
    .PARAMETER CheckpointEvery
        Write edges.json after every N successful backfills (0 = only at the end).
        Default 25.
    .PARAMETER DryRun
        Select target edges and render the first prompt, but make NO API calls and NO
        writes. Reports how many edges WOULD be processed — use to size a pilot's cost.
    .PARAMETER RepoRoot
        Repository root. Defaults to the module-resolved root.
    .OUTPUTS
        [PSCustomObject] summary: Targeted, Backfilled, Failed, SkippedNoNodeText, DryRun.
    .EXAMPLE
        # Costed pilot preview — no spend, no writes
        Invoke-EdgeRationaleBackfill -Scope UIVisible -Limit 200 -DryRun
    .EXAMPLE
        # Run the 200-edge pilot on the free tier
        Invoke-EdgeRationaleBackfill -Scope UIVisible -Limit 200
    .LINK
        Invoke-EdgeDiscovery
    .LINK
        Approve-Edge
    #>
    [CmdletBinding(SupportsShouldProcess)]
    [OutputType([PSCustomObject])]
    param(
        [Parameter()]
        [ValidateSet('UIVisible', 'All')]
        [string]$Scope = 'UIVisible',

        [Parameter()]
        [ValidateRange(0, 100000)]
        [int]$Limit = 0,

        [Parameter()]
        [ValidateRange(0.0, 1.0)]
        [double]$MinConfidence = 0.0,

        [Parameter()]
        [ValidateScript({ Test-AIModelId $_ })]
        [string]$Model = (Get-AITierModel -Tier basic),

        [Parameter()]
        [string]$ApiKey = '',

        [Parameter()]
        [ValidateRange(0.0, 1.0)]
        [double]$Temperature = 0.3,

        [Parameter()]
        [switch]$Force,

        [Parameter()]
        [ValidateRange(0, 10000)]
        [int]$CheckpointEvery = 25,

        [Parameter()]
        [switch]$DryRun,

        [Parameter()]
        [string]$RepoRoot
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    # ── Resolve backend + key (fail fast with a clear message) ────────────
    # The backend comes from ai-models.json and an unknown model fails here, before any call (t/4087).
    # Only the user's own -ApiKey is forwarded; Invoke-AIApi resolves the key for the registry backend.
    $null = Get-AIModelBackend -Model $Model
    $ResolvedKey = $ApiKey

    # ── Load edges.json ───────────────────────────────────────────────────
    $TaxDir    = if ($RepoRoot) { Join-Path $RepoRoot 'taxonomy/Origin' } else { Get-TaxonomyDir }
    $EdgesPath = Join-Path $TaxDir 'edges.json'
    if (-not (Test-Path -LiteralPath $EdgesPath)) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal 'Backfill edge rationales' `
            -Problem "edges.json not found at $EdgesPath" `
            -Location 'Invoke-EdgeRationaleBackfill' `
            -NextSteps 'Verify the data root (Get-TaxonomyDir) or pass -RepoRoot to the repo containing taxonomy/Origin/edges.json.')
    }
    # t/2974: read via the coercion-free reader so discovered_at (and any ISO timestamp) is NOT
    # coerced to [datetime] and truncated on the whole-file write-back below.
    $EdgesData = Read-EdgesFile -Path $EdgesPath

    # ── Build node id → {label, description} map from all node files ──────
    $NodeText = @{}
    foreach ($File in Get-ChildItem -Path $TaxDir -Filter '*.json' -File) {
        if ($File.Name -in @('edges.json', 'embeddings.json', 'policy_actions.json')) { continue }
        try { $Doc = Get-Content -Raw -Path $File.FullName | ConvertFrom-Json } catch { continue }
        if (-not ($Doc.PSObject.Properties['nodes'])) { continue }
        foreach ($N in @($Doc.nodes)) {
            if ($N.PSObject.Properties['id']) {
                $NodeText[$N.id] = [PSCustomObject]@{
                    Label = if ($N.PSObject.Properties['label']) { [string]$N.label } else { '' }
                    Desc  = if ($N.PSObject.Properties['description']) { [string]$N.description } else { '' }
                }
            }
        }
    }

    # ── Edge-type definitions (for prompt context) ───────────────────────
    $TypeDef = @{}
    if ($EdgesData.PSObject.Properties['edge_types']) {
        foreach ($T in @($EdgesData.edge_types)) {
            if ($T.PSObject.Properties['type']) {
                $TypeDef[$T.type] = if ($T.PSObject.Properties['definition']) { [string]$T.definition } else { '' }
            }
        }
    }

    # ── Select target edges ───────────────────────────────────────────────
    $Targets   = [System.Collections.Generic.List[object]]::new()
    $SelfLoops = [System.Collections.Generic.List[string]]::new()
    foreach ($E in @($EdgesData.edges)) {
        $HasRationale = $E.PSObject.Properties['rationale'] -and -not [string]::IsNullOrWhiteSpace($E.rationale)
        if ($HasRationale -and -not $Force) { continue }
        # Never rationalize a malformed self-loop (source == target). Collect for a cleanup list.
        if ($E.source -eq $E.target) { $SelfLoops.Add("$($E.source) ($($E.type))"); continue }
        if ($Scope -eq 'UIVisible') {
            $Status = if ($E.PSObject.Properties['status']) { $E.status } else { '' }
            if ($Status -ne 'approved') { continue }
        }
        # Confidence gate — skip edges below the model-confidence threshold.
        $Conf = if ($E.PSObject.Properties['confidence']) { [double]$E.confidence } else { 0.0 }
        if ($Conf -lt $MinConfidence) { continue }
        $Targets.Add($E)
    }
    if ($Limit -gt 0 -and $Targets.Count -gt $Limit) {
        $Targets = [System.Collections.Generic.List[object]]@($Targets[0..($Limit - 1)])
    }

    Write-Host "Edge rationale backfill: $($Targets.Count) target edge(s) [scope=$Scope, minConfidence=$MinConfidence, limit=$Limit, model=$Model]" -ForegroundColor Cyan
    if ($SelfLoops.Count -gt 0) {
        $Shown = @($SelfLoops | Select-Object -First 20) -join ', '
        Write-Warning "Skipped $($SelfLoops.Count) self-loop edge(s) (source == target — malformed, should be removed): $Shown$(if ($SelfLoops.Count -gt 20) { ' …' })"
    }

    $Summary = {
        param($t, $b, $f, $s, $sl, $dry)
        [PSCustomObject]@{
            Targeted          = $t
            Backfilled        = $b
            Failed            = $f
            SkippedNoNodeText = $s
            SelfLoopsSkipped  = $sl
            DryRun            = [bool]$dry
            Model             = $Model
            Scope             = $Scope
            MinConfidence     = $MinConfidence
        }
    }

    # Render the {{...}} replacement map for one edge.
    $BuildReplacements = {
        param($Edge)
        $Src = if ($NodeText.ContainsKey($Edge.source)) { $NodeText[$Edge.source] } else { $null }
        $Tgt = if ($NodeText.ContainsKey($Edge.target)) { $NodeText[$Edge.target] } else { $null }
        if (-not $Src -or -not $Tgt) { return $null }
        $Trunc = { param($s) if ($s.Length -gt 400) { $s.Substring(0, 400) } else { $s } }
        @{
            EDGE_TYPE     = [string]$Edge.type
            EDGE_TYPE_DEF = if ($TypeDef.ContainsKey($Edge.type)) { $TypeDef[$Edge.type] } else { '(see taxonomy edge-type vocabulary)' }
            SOURCE_ID     = [string]$Edge.source
            SOURCE_LABEL  = $Src.Label
            SOURCE_DESC   = & $Trunc $Src.Desc
            TARGET_ID     = [string]$Edge.target
            TARGET_LABEL  = $Tgt.Label
            TARGET_DESC   = & $Trunc $Tgt.Desc
        }
    }

    # ── Dry run: preview target count + first prompt, no API, no writes ───
    if ($DryRun) {
        if ($Targets.Count -gt 0) {
            $R = & $BuildReplacements $Targets[0]
            if ($R) {
                Write-Host ''
                Write-Host '--- Sample prompt (first target edge) ---' -ForegroundColor DarkGray
                Write-Host (Get-Prompt -Name 'edge-rationale-backfill' -Replacements $R)
            } else {
                Write-Host '  (first target edge has no resolvable node text — it would be skipped)' -ForegroundColor DarkYellow
            }
        }
        Write-Host ''
        Write-Host "DRY RUN — no API calls, no writes. Would process $($Targets.Count) edge(s)." -ForegroundColor Yellow
        return & $Summary $Targets.Count 0 0 0 $SelfLoops.Count $true
    }

    # ── Backfill loop ─────────────────────────────────────────────────────
    $Schema = @{ type = 'object'; properties = @{ rationale = @{ type = 'string' } }; required = @('rationale') }
    $Backfilled = 0; $Failed = 0; $SkippedNoText = 0

    foreach ($Edge in $Targets) {
        $EdgeKey = "$($Edge.source)->$($Edge.target) ($($Edge.type))"

        $Repl = & $BuildReplacements $Edge
        if (-not $Repl) {
            Write-Warning "Skip $EdgeKey — source/target node text not found in taxonomy."
            $SkippedNoText++
            continue
        }

        if (-not $PSCmdlet.ShouldProcess($EdgeKey, 'Generate + write rationale')) { continue }

        $Rationale = $null
        try {
            $Prompt   = Get-Prompt -Name 'edge-rationale-backfill' -Replacements $Repl
            $Response = Invoke-AIApi -Prompt $Prompt -Model $Model -ApiKey $ResolvedKey `
                -Temperature $Temperature -MaxTokens 512 -TimeoutSec 60 -JsonMode -ResponseSchema $Schema
            $Text = ($Response.Text -replace '^```(json)?', '' -replace '```$', '').Trim()
            $Parsed = $Text | ConvertFrom-Json
            if ($Parsed.PSObject.Properties['rationale']) { $Rationale = [string]$Parsed.rationale }
        } catch {
            Write-Warning "Backfill failed for $EdgeKey — $($_.Exception.Message)"
        }

        if ([string]::IsNullOrWhiteSpace($Rationale)) {
            # Silent-blank contract (t/2674): surface, do NOT write a blank.
            Write-Warning "No rationale returned for $EdgeKey — leaving unchanged (not written blank)."
            $Failed++
            continue
        }

        if ($Edge.PSObject.Properties['rationale']) {
            $Edge.rationale = $Rationale
        } else {
            Add-Member -InputObject $Edge -NotePropertyName 'rationale' -NotePropertyValue $Rationale -Force
        }
        # t/2944 write-together invariant: this edge just received a non-empty rationale (the empty case
        # returned above via the silent-blank contract), so stamp its provenance in the SAME write —
        # backfill = post-hoc LLM reconstruction (edge-rationale-source-marker.md).
        if ($Edge.PSObject.Properties['rationale_source']) {
            $Edge.rationale_source = 'backfill'
        } else {
            Add-Member -InputObject $Edge -NotePropertyName 'rationale_source' -NotePropertyValue 'backfill' -Force
        }
        $Backfilled++

        if ($CheckpointEvery -gt 0 -and ($Backfilled % $CheckpointEvery) -eq 0) {
            $EdgesData.last_modified = (Get-Date).ToString('yyyy-MM-dd')
            Write-EdgesFile -EdgesData $EdgesData -Path $EdgesPath
            Write-Host "  checkpoint: $Backfilled written" -ForegroundColor DarkGray
        }
    }

    # ── Final write ───────────────────────────────────────────────────────
    if ($Backfilled -gt 0) {
        $EdgesData.last_modified = (Get-Date).ToString('yyyy-MM-dd')
        Write-EdgesFile -EdgesData $EdgesData -Path $EdgesPath
    }

    Write-Host ''
    Write-Host "=== Backfill complete ===" -ForegroundColor Cyan
    Write-Host "  Backfilled:          $Backfilled" -ForegroundColor Green
    Write-Host "  Failed (no output):  $Failed" -ForegroundColor $(if ($Failed -gt 0) { 'Yellow' } else { 'Green' })
    Write-Host "  Skipped (no text):   $SkippedNoText" -ForegroundColor $(if ($SkippedNoText -gt 0) { 'Yellow' } else { 'Green' })

    if ($Failed -gt 0) {
        Write-Warning "$Failed edge(s) produced no rationale and were left unchanged (t/2674 silent-blank contract)."
    }

    return & $Summary $Targets.Count $Backfilled $Failed $SkippedNoText $SelfLoops.Count $false
}
