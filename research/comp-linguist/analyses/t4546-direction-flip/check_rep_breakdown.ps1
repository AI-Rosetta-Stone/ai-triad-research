<#
.SYNOPSIS
    t/4546 ask #2 (classify cause): for each of the 19 flips, judges the
    verbatim rep and the canonical_proposition rep SEPARATELY against the
    directional gate (instead of the opposes-if-ANY aggregate), to test the
    hypothesis that a verbatim rep -- often a document-excerpt sentence
    FRAGMENT (dependent clause, no clear subject/predicate) -- reads as a
    spurious NLI "contradiction" that canonical_proposition (engineered to be
    self-contained, t/4558) would not.
#>
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$dataRoot = $env:AI_TRIAD_DATA_ROOT
if (-not $dataRoot) { $dataRoot = (Resolve-Path (Join-Path $here '..' '..' '..' '..' '..' 'ai-triad-data')).Path }

Import-Module (Join-Path $here '..' '..' '..' '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force -WarningAction SilentlyContinue

$flips = Get-Content (Join-Path $here 'flips.json') -Raw | ConvertFrom-Json

$claimsPath = Join-Path $dataRoot 'taxonomy' 'Origin' 'organization_stance_claims.json'
$embPath = Join-Path $dataRoot 'taxonomy' 'Origin' 'embeddings-orgstance-6733.json'
$result = Invoke-OrgClaimMatching -ClaimsPath $claimsPath -EmbeddingsPath $embPath -PerOrgCap 100 -Force -SkipDirectionalGate -SkipEndorsementGate 6>$null

$povByPrefix = @{ acc = 'accelerationist'; saf = 'safetyist'; skp = 'skeptic' }
$nodeTextById = @{}
InModuleScope AITriad { } | Out-Null
foreach ($pov in @('accelerationist','safetyist','skeptic','situations')) {
    $path = Join-Path $dataRoot 'taxonomy' 'Origin' "$pov.json"
    if (-not (Test-Path $path)) { continue }
    $d = Get-Content $path -Raw | ConvertFrom-Json
    foreach ($n in @($d.nodes)) {
        if (-not $n.PSObject.Properties['id']) { continue }
        $lbl = if ($n.PSObject.Properties['label']) { [string]$n.label } else { '' }
        $dsc = if ($n.PSObject.Properties['description'] -and $n.description) { [string]$n.description } else { '' }
        $dsc = $dsc -replace '(?s)\s*(Encompasses|Excludes)\s*:.*$', ''
        $nodeTextById[[string]$n.id] = if ($dsc) { "$lbl -- $($dsc.Trim())" } else { $lbl }
    }
}

$byKey = @{}
foreach ($p in @($result.Proposals)) { $byKey["$($p.OrgId)::$($p.NodeId)"] = $p }

$gatePairs = [System.Collections.Generic.List[PSObject]]::new()
$meta = [System.Collections.Generic.List[PSObject]]::new()
foreach ($flip in $flips) {
    $key = "$($flip.Org)::$($flip.Node)"
    if (-not $byKey.ContainsKey($key)) { continue }
    $prop = $byKey[$key]
    $nid = [string]$prop.NodeId
    $nodeText = if ($nodeTextById.ContainsKey($nid)) { $nodeTextById[$nid] } else { '' }
    $prefix = if ($nid -match '^(acc|saf|skp)-') { $Matches[1] } else { '' }
    $nodePov = if ($prefix -and $povByPrefix.ContainsKey($prefix)) { $povByPrefix[$prefix] } else { '' }
    foreach ($rep in @($prop.RepReps)) {
        $id = "$($flip.Id):$($rep.Kind)"
        $gatePairs.Add([PSCustomObject]@{ Id = $id; ClaimProp = [string]$rep.Text; NodeProp = $nodeText; NodePov = $nodePov })
        $meta.Add([PSCustomObject]@{ Id = $id; FlipId = $flip.Id; Kind = $rep.Kind; Text = $rep.Text; NodeText = $nodeText })
    }
}

$verdicts = InModuleScope AITriad -Parameters @{ GatePairs = $gatePairs } {
    param($GatePairs)
    Test-DirectionalAgreement -Pair @($GatePairs) -TauContra 1.0
}
$verdictById = @{}
foreach ($v in @($verdicts)) { $verdictById[[string]$v.Id] = $v }

Write-Host '=== Per-rep verdicts (verbatim vs canonical, same node) ==='
$disagree = 0
foreach ($flip in $flips) {
    $reps = @($meta | Where-Object { $_.FlipId -eq $flip.Id })
    if (@($reps).Count -eq 0) { continue }
    Write-Host "$($flip.Id) [$($flip.Org) -> $($flip.Node)] label=$($flip.Label)"
    $dirs = @()
    foreach ($r in $reps) {
        $v = $verdictById[$r.Id]
        $dirs += $v.Direction
        Write-Host "    [$($r.Kind)] dir=$($v.Direction) margin=$($v.Confidence)  text: $($r.Text)"
    }
    if (@($dirs | Sort-Object -Unique).Count -gt 1) {
        $disagree++
        Write-Host "    >>> REPS DISAGREE <<<" -ForegroundColor Yellow
    }
    Write-Host ''
}
Write-Host "Reps disagree (verbatim vs canonical gave different directions) on $disagree of $($flips.Count) flips."
