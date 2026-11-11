#Requires -Version 7
<#
.SYNOPSIS
    t/246: score candidate.prompt on the rubric seeds + the CL held-out set, N replicates.
.DESCRIPTION
    Read-only over situations.json; writes results.json next to this script. Build-NodeInput and
    the call shape are copied verbatim from scripts/Invoke-DisagreementTypeBackfill.ps1 so the
    candidate is tested on exactly the production input.
#>
param(
    [int]$Replicates = 3,
    [string]$Model = 'gemini-3.5-flash-lite',
    [string]$SituationsPath
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$repo = (Resolve-Path (Join-Path $here '..' '..' '..' '..')).Path
Import-Module (Join-Path $repo 'scripts' 'AIEnrich.psm1') -Force

if (-not $SituationsPath) {
    $dataRoot = if ($env:AI_TRIAD_DATA_ROOT) { $env:AI_TRIAD_DATA_ROOT } else { Join-Path $repo '..' 'ai-triad-data' }
    $SituationsPath = Join-Path $dataRoot 'taxonomy' 'Origin' 'situations.json'
}
$data  = Get-Content $SituationsPath -Raw | ConvertFrom-Json
$nodes = if ($data.PSObject.Properties['nodes']) { $data.nodes } else { $data }
$byId  = @{}; foreach ($n in $nodes) { $byId[[string]$n.id] = $n }

$ClassifyPrompt = (Get-Content (Join-Path $here 'candidate.prompt') -Raw).TrimEnd()
$seeds = [ordered]@{
    'sit-447' = 'definitional'; 'sit-001' = 'interpretive'; 'sit-100' = 'interpretive'; 'sit-250' = 'interpretive'
    'sit-350' = 'interpretive'; 'sit-430' = 'interpretive'; 'sit-470' = 'interpretive'; 'sit-300' = 'structural'
    'sit-400' = 'structural'
}
$held = (Get-Content (Join-Path $here 'heldout_labels.json') -Raw | ConvertFrom-Json).labels

# ── verbatim from Invoke-DisagreementTypeBackfill.ps1 ──
function Build-NodeInput([PSObject]$Node) {
    $desc = if ($Node.PSObject.Properties['description']) { [string]$Node.description } else { '' }
    $parts = [System.Collections.Generic.List[string]]::new()
    $parts.Add("SITUATION: $($Node.id)")
    $parts.Add("DESCRIPTION: $desc")
    $parts.Add('')

    foreach ($pov in @('accelerationist', 'safetyist', 'skeptic')) {
        $interp = if ($Node.PSObject.Properties['interpretations'] -and $Node.interpretations) {
            $Node.interpretations
        } else { $null }

        $povData = if ($interp -and $interp.PSObject.Properties[$pov]) { $interp.$pov } else { $null }
        if ($null -eq $povData) {
            $parts.Add("${pov}: [no interpretation]")
            continue
        }

        # Summaries stored as the string "null" when unpopulated
        $summary = if ($povData.PSObject.Properties['summary']) { [string]$povData.summary } else { '' }
        if ($summary -eq 'null' -or [string]::IsNullOrWhiteSpace($summary)) {
            # Fall back to belief if available
            $belief = if ($povData.PSObject.Properties['belief']) { [string]$povData.belief } else { '' }
            if ($belief -eq 'null' -or [string]::IsNullOrWhiteSpace($belief)) {
                $parts.Add("${pov}: [no interpretation]")
            } else {
                $parts.Add("${pov} (belief): $belief")
            }
        } else {
            $parts.Add("${pov}: $summary")
        }
    }

    return $parts -join "`n"
}
# ── end verbatim ──

function Invoke-Classify([string]$Id) {
    $fullPrompt = "$ClassifyPrompt`n`nHere is the situation to classify:`n`n$(Build-NodeInput $byId[$Id])"
    $response = Invoke-AIApi -Prompt $fullPrompt -Model $Model -JsonMode -Temperature 0.1 -MaxTokens 256
    if ($null -eq $response) { return [PSCustomObject]@{ label = $null; confidence = $null; rationale = 'empty response' } }
    $text = if ($response.PSObject.Properties['Text']) { [string]$response.Text } else { [string]$response }
    $cleaned = $text -replace '(?s)```json\s*', '' -replace '(?s)```\s*$', ''
    try {
        $r = $cleaned | ConvertFrom-Json
        [PSCustomObject]@{ label = [string]$r.disagreement_type; confidence = $r.confidence; rationale = [string]$r.rationale }
    } catch {
        Write-Warning "t/246 run_validation: unparseable response for $Id; recorded as null ($($_.Exception.Message))"
        [PSCustomObject]@{ label = $null; confidence = $null; rationale = 'unparseable' }
    }
}

$ids = @($seeds.Keys) + @($held | ForEach-Object { $_.id })
$missing = @($ids | Where-Object { -not $byId.ContainsKey($_) })
if ($missing.Count) { throw "t/246 run_validation: ids missing from situations.json: $($missing -join ', ')" }

$runs = @()
for ($rep = 1; $rep -le $Replicates; $rep++) {
    $out = [ordered]@{}
    foreach ($id in $ids) { $out[$id] = Invoke-Classify $id }
    $runs += , $out
    Write-Host "replicate $rep done"
}
$result = [ordered]@{
    model = $Model; temperature = 0.1; replicates = $Replicates
    prompt_sha256 = (Get-FileHash (Join-Path $here 'candidate.prompt') -Algorithm SHA256).Hash.ToLower()
    situations_sha256 = (Get-FileHash $SituationsPath -Algorithm SHA256).Hash.ToLower()
    runs = $runs
}
$result | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $here 'results.json') -Encoding utf8NoBOM
Write-Host "wrote results.json"
