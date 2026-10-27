# t/4471 model-tier check (spec §7c): round-2 prompts at fcbe33a8, gemini-3.1-pro-preview.
# Scratch roots only. Spend hard stop: this run's budget is $4.10 ($4.50 cap minus ~$0.40 already spent).
$ErrorActionPreference = 'Stop'
$Scratch  = 'C:\Users\jsnov\AppData\Local\Temp\claude\C--Users-jsnov-repos-ai-triad-research-research-comp-linguist\171d658c-637d-4fca-9291-31dc0bf5f9e6\scratchpad'
$CodeRoot = 'C:\Users\jsnov\repos\ai-triad-research\.worktrees\t4471-pro-code'
$Model    = 'gemini-3.1-pro-preview'
$Budget   = 3.85   # $4.50 cap - ~$0.40 rounds 1-2 - $0.25 allowance for the unlogged in-flight call of the stopped attempt 1
$PerDocReserve = 0.90   # worst case for one doc: two FIRE calls at the 32768-token output ceiling at pro pricing
$env:AI_TRIAD_DATA_ROOT    = 'C:\Users\jsnov\repos\ai-triad-data\.worktrees\data-t4471-pro'
$env:AI_TRIAD_SOURCES_ROOT = Join-Path $Scratch 'sources-pro'
$env:AI_TRIAD_CODE_ROOT    = $CodeRoot
$env:T4471_USAGE_LOG       = Join-Path $Scratch 'usage-pro.jsonl'

Import-Module (Join-Path $CodeRoot 'scripts\AITriad\AITriad.psd1') -Force
$mod = Get-Module AITriad
# FIRE wall-clock raised at run time (no code edit): Invoke-SummaryPipeline does not pass -WallClockSeconds,
# so a module-scope default applies. 60 s cut pro off before its confidence pass (attempt 1).
& $mod { $script:PSDefaultParameterValues = @{ 'Invoke-IterativeExtraction:WallClockSeconds' = 900 } }
$dataRoot = & $mod { Get-DataRoot }
$srcRoot  = & $mod { Get-SourcesDir }
Write-Host "module:       $($mod.Path)"
Write-Host "data root:    $dataRoot"
Write-Host "sources root: $srcRoot"
if ($mod.Path -notlike '*t4471-pro-code*' -or $dataRoot -notlike '*data-t4471-pro*' -or $srcRoot -notlike '*sources-pro*') {
    throw 'Module or roots not redirected to scratch; aborting.'
}

function Get-SpendSoFar {
    if (-not (Test-Path $env:T4471_USAGE_LOG)) { return 0.0 }
    $c = 0.0
    foreach ($l in Get-Content $env:T4471_USAGE_LOG) {
        $u = ($l | ConvertFrom-Json).um
        $in  = [double]$u.promptTokenCount
        $out = [double]$u.totalTokenCount - $in   # candidates + thoughts, both billed as output
        $c += $in * 2.0 / 1e6 + $out * 12.0 / 1e6
    }
    return [math]::Round($c, 4)
}

function Assert-RealReposUnchanged {
    $d = (git -C 'C:\Users\jsnov\repos\ai-triad-data' status --porcelain) -join "`n"
    $s = (git -C 'C:\Users\jsnov\repos\ai-triad-sources' status --porcelain) -join "`n"
    $d0 = (Get-Content (Join-Path $Scratch 'data-before.txt')) -join "`n"
    $s0 = (Get-Content (Join-Path $Scratch 'sources-before.txt')) -join "`n"
    $bad = @()
    foreach ($line in ($d -split "`n")) { if ($line -and ($line -match 'summaries/|conflicts/|taxonomy/')) { $bad += "data: $line" } }
    foreach ($line in ($s -split "`n")) { if ($line -and -not ($s0 -split "`n" -contains $line)) { $bad += "sources: $line" } }
    if ($bad.Count -gt 0) { throw "Real repo changed: $($bad -join '; ')" }
}

$Key = & $mod { Resolve-AIApiKey -ExplicitKey '' -Backend 'gemini' }
if ([string]::IsNullOrWhiteSpace($Key)) { throw 'No gemini key resolved; aborting.' }

# Attempt 3: the 5 remaining non-example docs first, then the 2 example docs if budget allows.
$Docs = Get-Content (Join-Path $Scratch 'docs-attempt3.txt') | Where-Object { $_.Trim() }
foreach ($d in $Docs) {
    $spent = Get-SpendSoFar
    if ($spent + $PerDocReserve -gt $Budget) { Write-Warning "BUDGET STOP before ${d}: spent `$$spent"; break }
    Write-Host "=== summary $d (spent so far `$$spent)"
    try { Invoke-POVSummary -DocId $d.Trim() -Model $Model -IterativeExtraction -Force -ApiKey $Key | Out-Null }
    catch { Write-Warning "summary failed for ${d}: $($_.Exception.Message)" }
    Assert-RealReposUnchanged
}

# Org arm skipped (budget priority): org passes on flash-lite, and the decision rule cannot turn on pro org output.
Write-Host "TOTAL SPEND (this run): `$$(Get-SpendSoFar)"
Write-Host 'DONE'
