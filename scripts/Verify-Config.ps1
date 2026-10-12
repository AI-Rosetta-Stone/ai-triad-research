# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Runs every ai-models.json registry-completeness gate in one command.
.DESCRIPTION
    ai-models.json is a repo-root registry whose completeness is enforced by
    test suites that live in other packages (taxonomy-editor's vitest suite and
    the tests/ Pester suite). An agent editing the root config gets no local
    signal that those suites gate it — which is how a registry edit can go green
    locally and red in CI (t/1933). This script gives that edit a single local
    command that runs every gate below and exits non-zero if any fails.

    Gates (t/1950#1 original inventory; t/2486 adds registryCompleteness;
    t/3560 adds the model-literal-lint pair; t/3657 splits the ai-config vitest
    gate into its unit + conformance suites; t/3865 adds the outlets.json SSOT
    key-set parity gates). Counts are NOT restated in this prose or in the
    printed summary — they are derived from $PesterGates / $VitestGates at
    runtime, so the output can never misreport the population it actually ran:
      Pester (run directly):
        - tests/Test-AIModelsConfig.Tests.ps1   config gate
        - tests/ModelLiteralLint.Tests.ps1      model-id literals name registered models
        - tests/OutletsKeySetGate.Tests.ps1     outlets.json SSOT vs PS consumer key set (t/3865)
        - tests/OutletKeySetVerdict.Tests.ps1   key-set comparator, both GV arms on synthetic fixtures
      vitest (delegated to taxonomy-editor's suite):
        - taxonomy-editor/src/server/__tests__/keysValidation.test.ts   KEY_VALIDATION_PROBES completeness
        - taxonomy-editor/src/main/__tests__/modelConfigCache.test.ts   id->apiId map
        - lib/debate/__tests__/configInvariant.test.ts                  fallbackChain / default invariants
        - lib/electron-shared/modelDiscovery.test.ts                    model discovery
        - taxonomy-editor/src/renderer/hooks/useTaxonomyStore/slices/__tests__/registryCompleteness.test.ts   renderer accessor-chain completeness
        - lib/ai-config/modelLiteralLint.test.ts                        TS model-literal lint unit suite
        - lib/ai-config/modelLiteralLint.conformance.test.ts            shared cross-toolchain conformance corpus
        - lib/oped/__tests__/outletsKeySetGate.test.ts                  outlets.json SSOT vs TS consumer key set (t/3865)
      Live environment check (not a test file — see its section for why):
        - data-repo hook wiring (t/3869)   core.hooksPath / hook presence+exec bit in the
          operator's data checkout. PASS / WARN (warn-first) / N/A (own count) / FAIL.

    The vitest half is the fiddly part. taxonomy-editor's vitest include-globs
    are relative to taxonomy-editor/src/renderer, so passing repo-root-relative
    paths as filters silently matches ZERO tests and exits 0 — a false green that
    looks exactly like success (t/1950#1). This script defends against that by:
      1. filtering with bare basenames (CWD-independent substring match), and
      2. verifying `vitest list` collects EXACTLY the expected files ($VitestGates)
         before running — any other collected count is a FAILURE, not success.
.EXAMPLE
    npm run verify:config
.EXAMPLE
    pwsh -File scripts/Verify-Config.ps1
.NOTES
    Cross-platform: pwsh + npm exist on both the win32 fleet and Linux CI.
    Run from anywhere — paths resolve relative to this script's location.
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# A failing vitest suite exits non-zero — that is expected, not an error to abort on.
# Pin this OFF so a native non-zero exit never throws (some pwsh builds default it $true,
# which would turn `$ErrorActionPreference = 'Stop'` into a throw at the vitest call and
# skip our graceful "FAIL vitest run" reporting). We branch on $LASTEXITCODE ourselves.
$PSNativeCommandUseErrorActionPreference = $false

$RepoRoot   = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$TaxEditor  = Join-Path $RepoRoot 'taxonomy-editor'

# Ordered map: vitest basename filter -> a path fragment that must appear in the
# collected file's path. Fragments are specific enough to detect a basename
# collision (a stray same-named test elsewhere would list under a different path).
$VitestGates = [ordered]@{
    'keysValidation'        = 'server/__tests__/keysValidation.test.ts'
    'modelConfigCache'      = 'main/__tests__/modelConfigCache.test.ts'
    'configInvariant'       = 'lib/debate/__tests__/configInvariant.test.ts'
    'modelDiscovery.test'   = 'lib/electron-shared/modelDiscovery.test.ts'   # '.test' so sibling modelDiscovery.*.test.ts files don't widen the filter
    'registryCompleteness'  = 'hooks/useTaxonomyStore/slices/__tests__/registryCompleteness.test.ts'
    'modelLiteralLint.test' = 'lib/ai-config/modelLiteralLint.test.ts'
    'modelLiteralLint.conformance.test' = 'lib/ai-config/modelLiteralLint.conformance.test.ts'
    'outletsKeySetGate'     = 'lib/oped/__tests__/outletsKeySetGate.test.ts'
}
$PesterGates = @(
    (Join-Path $RepoRoot 'tests/Test-AIModelsConfig.Tests.ps1')
    (Join-Path $RepoRoot 'tests/ModelLiteralLint.Tests.ps1')
    (Join-Path $RepoRoot 'tests/OutletsKeySetGate.Tests.ps1')
    (Join-Path $RepoRoot 'tests/OutletKeySetVerdict.Tests.ps1')
    (Join-Path $RepoRoot 'tests/AIBackendProfiles.Completeness.Tests.ps1')   # t/4135: profile rows <-> registry backends
)

# gate name -> $true (pass) / $false (fail); preserves declaration order for the summary
$Results = [ordered]@{}

function Write-Section {
    param([string]$Text)
    Write-Host ''
    Write-Host "== $Text ==" -ForegroundColor Cyan
}

# ── Pester gates ────────────────────────────────────────────────────────────
Write-Section 'Pester registry gates'
# t/3865 owner review: $PesterGates.Count -eq 0 (e.g. an accidental clear, a bad
# merge) must be a FAILURE, never a silent pass. Without this, an empty array
# makes BOTH $missingPester and $foundPester empty too, so the run block below
# never executes and adds ZERO entries to $Results for Pester -- the script
# would still print PASSED having run no Pester gates at all. This is exactly
# the "gate reports success over a population it can't see" class t/3819/t/3865
# exist to prevent (t/3821's parity check over 694 files while skipping every
# .tsx; the model-literal lint green with zero offenders while never scanning
# .json) -- so assert the population itself, not just that every file in it
# exists.
if ($PesterGates.Count -eq 0) {
    Write-Host '  FAIL Pester registry — $PesterGates is empty; zero gates would run.' -ForegroundColor Red
    $Results['PesterGates:non-empty'] = $false
}
$missingPester = @($PesterGates | Where-Object { -not (Test-Path $_) })
foreach ($m in $missingPester) {
    $name = Split-Path $m -Leaf
    Write-Host "  FAIL $name — file not found at $m" -ForegroundColor Red
    $Results[$name] = $false
}
$foundPester = @($PesterGates | Where-Object { Test-Path $_ })
if ($foundPester.Count -gt 0) {
    # Run Pester with strict mode OFF for this call only. Under `Set-StrictMode -Version
    # Latest` (set at the top of this script), Pester's expansion of `<...>` template
    # tokens in a test NAME throws when the token names an unbound variable — e.g. the
    # literal "<family>" in a Test-AIModelsConfig `It` name expands `$family`, which is
    # never set. That would FALSE-RED an otherwise-passing gate. CI runs its Pester step
    # with no ambient strict mode, so it is green; matching that is correct behaviour, not
    # a workaround. The `& { ... }` child scope confines `-Off` to this one invocation —
    # the rest of the script keeps strict mode. Config-object invocation also mirrors ci.yml.
    $run = & {
        Set-StrictMode -Off
        $pconf = New-PesterConfiguration
        $pconf.Run.Path         = $foundPester
        $pconf.Run.PassThru     = $true
        $pconf.Output.Verbosity = 'None'
        Invoke-Pester -Configuration $pconf
    }
    foreach ($ct in $run.Containers) {
        $name = Split-Path $ct.Item -Leaf
        $ok   = ($ct.Result -eq 'Passed')
        if ($ok) {
            Write-Host "  PASS $name ($($ct.PassedCount) tests)" -ForegroundColor Green
        } else {
            Write-Host "  FAIL $name ($($ct.FailedCount) failed / $($ct.PassedCount) passed)" -ForegroundColor Red
        }
        $Results[$name] = $ok
    }
}

# ── vitest gates (delegated to taxonomy-editor) ──────────────────────────────
Write-Section 'vitest registry gates (via taxonomy-editor)'
$Filters = @($VitestGates.Keys)

# t/3865 owner review: same population-assertion as the Pester side above.
# $VitestGates.Count -eq 0 happens to be caught downstream today too -- an
# EMPTY @Filters makes `vitest list` collect every test file in the project
# (confirmed: 796 on this repo, not zero), which then mismatches a 0 expected
# count and fails the collection guard. But that protection is an ACCIDENT of
# vitest's "no filter = everything" default, not an assertion -- it would
# silently stop protecting if that default ever changed, or if someone added
# a real filter elsewhere. Assert the population explicitly rather than lean
# on a side effect.
if ($VitestGates.Count -eq 0) {
    Write-Host '  FAIL vitest registry — $VitestGates is empty; zero gates would run.' -ForegroundColor Red
    $Results['VitestGates:non-empty'] = $false
}

if (-not (Test-Path (Join-Path $TaxEditor 'node_modules'))) {
    # Standalone tooling script: report as a gate failure and exit non-zero rather
    # than throw (New-ActionableError lives in the AITriad module, and importing it
    # would trigger the module-load taxonomy scan this command has no need for).
    Write-Host '  FAIL vitest — taxonomy-editor/node_modules is missing.' -ForegroundColor Red
    Write-Host '        Goal:  run the vitest registry gates' -ForegroundColor DarkYellow
    Write-Host "        Fix:   run 'pnpm install' in $TaxEditor, then re-run verify:config" -ForegroundColor DarkYellow
    $Results["vitest:collection ($($VitestGates.Count) files)"] = $false
    $Results['vitest:run'] = $false
}
else {
    Push-Location $TaxEditor
    try {
    # Step 1 — COLLECTION GUARD. `vitest list --filesOnly` prints one path per
    # collected file (exit 0 even when it matches nothing — the silent-zero trap),
    # so we count and match rather than trusting the exit code.
    $listed = @(& npm exec --silent -- vitest list --filesOnly @Filters 2>&1 |
        Where-Object { $_ -and ($_ -is [string]) } |
        ForEach-Object { $_.Trim() } |
        Where-Object { $_ -match '\.test\.tsx?$' })   # only test-file paths — ignore any stderr noise

    $collectionOk = $true
    if ($listed.Count -ne $VitestGates.Count) {
        Write-Host "  FAIL collection — expected $($VitestGates.Count) files, vitest collected $($listed.Count)" -ForegroundColor Red
        if ($listed.Count -gt 0) { $listed | ForEach-Object { Write-Host "        collected: $_" -ForegroundColor DarkYellow } }
        $collectionOk = $false
    }
    foreach ($frag in $VitestGates.Values) {
        $hit = @($listed | Where-Object { $_.Replace('\', '/') -like "*$frag" })
        if ($hit.Count -ne 1) {
            Write-Host "  FAIL collection — expected exactly one match for '$frag', got $($hit.Count)" -ForegroundColor Red
            $collectionOk = $false
        }
    }
    $Results["vitest:collection ($($VitestGates.Count) files)"] = $collectionOk

    if ($collectionOk) {
        Write-Host "  PASS collection — all $($VitestGates.Count) gate files collected" -ForegroundColor Green

        # Step 2 — RUN the seven collected files.
        & npm exec --silent -- vitest run @Filters
        $runOk = ($LASTEXITCODE -eq 0)
        if ($runOk) {
            Write-Host "  PASS vitest run — all $($VitestGates.Count) gate suites green" -ForegroundColor Green
        } else {
            Write-Host "  FAIL vitest run — one or more suites failed (exit $LASTEXITCODE, see output above)" -ForegroundColor Red
        }
        $Results['vitest:run'] = $runOk
    } else {
        # Collection is untrustworthy — do NOT run (a partial/zero run would look green).
        Write-Host "  SKIP vitest run — collection guard failed; not running an unverified set" -ForegroundColor Red
        $Results['vitest:run'] = $false
    }
    } finally {
        Pop-Location
    }
}

# ── Data-repo hook wiring (t/3869) ─────────────────────────────────────────
# Checks that the OPERATOR'S data checkout has core.hooksPath = .githooks, so its two guards
# (pre-commit rationale-drop t/2945; commit-msg node-removal t/3851, added once committed) can run.
# Lives HERE, not in tests/: CI's fresh data checkout never has hooksPath, so a live assertion
# there would be permanently red (t/3869#2). Path resolution mirrors the runtime exactly
# (AI_TRIAD_DATA_ROOT > .aitriad.json data_root), via DataRepoHooksVerdict.ps1.
# Severities: WIRED → PASS · ABSENT → N/A (own count, never PASSED) · UNDETERMINED → FAIL ·
# UNWIRED / MISWIRED / HOOK_MISSING → WARN ONLY (Gate Promotion: making these FAIL needs a real warn
# cycle + t/3870 landed + evidence the warning is ignored + TL GV + mandatory Second Opinion).
# Does NOT assert the hooks fire correctly — only that they are wired.
Write-Section 'Data-repo hook wiring (t/3869)'
$Warnings      = [ordered]@{}
$NotApplicable = [ordered]@{}
. (Join-Path $RepoRoot 'operations/devops/DataRepoHooksVerdict.ps1')
$hooksFacts = Get-DataRepoHooksFacts -CodeRepoRoot $RepoRoot -ExpectedHooks @('pre-commit', 'commit-msg')
$hooksV = Get-DataRepoHooksVerdict -Resolution $hooksFacts.Resolution -PathExists $hooksFacts.PathExists `
    -IsGitRepo $hooksFacts.IsGitRepo -HooksPath $hooksFacts.HooksPath -Hooks $hooksFacts.Hooks
$hooksLabel = "data-repo-hooks ($($hooksV.State))"
switch ($hooksV.Severity) {
    'PASS' { Write-Host "  PASS $hooksLabel — $($hooksV.Reason) [$($hooksV.Path)]" -ForegroundColor Green; $Results[$hooksLabel] = $true }
    'FAIL' { Write-Host "  FAIL $hooksLabel — $($hooksV.Reason)" -ForegroundColor Red
             if ($hooksV.Remediation) { Write-Host "        Fix: $($hooksV.Remediation)" -ForegroundColor DarkYellow }
             $Results[$hooksLabel] = $false }
    'WARN' { Write-Host "  WARN $hooksLabel — $($hooksV.Reason) [$($hooksV.Path)]" -ForegroundColor Yellow
             if ($hooksV.Remediation) { Write-Host "        Fix: $($hooksV.Remediation)" -ForegroundColor DarkYellow }
             $Warnings[$hooksLabel] = $hooksV.Reason }
    'NA'   { Write-Host "  N/A  $hooksLabel — $($hooksV.Reason)" -ForegroundColor DarkGray; $NotApplicable[$hooksLabel] = $hooksV.Reason }
    default { Write-Host "  FAIL $hooksLabel — unknown severity '$($hooksV.Severity)'" -ForegroundColor Red; $Results[$hooksLabel] = $false }
}

# ── Cache-read pricing completeness (t/3945) ────────────────────────────────
# Pricing entries on a backend that reports cached tokens must declare a numeric cachedInputPer1M
# (cachedInputPer1M = inputPer1M means "no discount"; never null, t/3945#1). Otherwise cost code
# silently charges cached tokens at the full input rate. Predicate: findPricingMissingCacheRate
# (lib/ai-client/registry.ts), run through lib/ai-client/cache-pricing-cli.ts.
# WARN ONLY (gate promotion: blocking needs a warn cycle + TL GV + mandatory Second Opinion).
# FAIL CLOSED (t/3945#3 cond 1): if the check can't run or its output can't be parsed, that is a
# WARN saying so, never silence or a clean result. A clean result is printed here but kept OUT of
# $Results, so the "all N green" count is identical whether or not this lane warns.
Write-Section 'Cache-read pricing completeness (t/3945)'
$cacheLabel   = 'cache-pricing'
$cacheCli     = Join-Path $RepoRoot 'lib/ai-client/cache-pricing-cli.ts'
$tsxBin       = Join-Path $RepoRoot 'node_modules' '.bin' 'tsx'
$tsxCmd       = if ($IsWindows) { "$tsxBin.cmd" } else { $tsxBin }
$cacheProblem = $null
$cacheResult  = $null
if (-not (Test-Path $tsxCmd))      { $cacheProblem = "tsx not found at $tsxCmd (run 'pnpm install' at the repo root)" }
elseif (-not (Test-Path $cacheCli)) { $cacheProblem = "check script not found at $cacheCli" }
else {
    $cacheOut  = @(& $tsxCmd $cacheCli --repo-root $RepoRoot 2>&1)
    $cacheExit = $LASTEXITCODE
    if ($cacheExit -ne 0) {
        $tail = ($cacheOut | Select-Object -Last 3 | ForEach-Object { "$_" }) -join ' | '
        $cacheProblem = "check script exited ${cacheExit}: $tail"
    }
    else {
        $lastLine = ($cacheOut | Where-Object { $_ -is [string] -and $_.Trim() } | Select-Object -Last 1)
        try   { $cacheResult = $lastLine | ConvertFrom-Json -ErrorAction Stop }
        catch { $cacheProblem = "check output was not JSON: '$lastLine'" }
        if ($cacheResult -and (-not $cacheResult.PSObject.Properties['checked'] -or -not $cacheResult.PSObject.Properties['issues'])) {
            $cacheProblem = "check output is missing 'checked' or 'issues': '$lastLine'"
            $cacheResult  = $null
        }
        elseif ($cacheResult -and [int]$cacheResult.checked -eq 0) {
            $cacheProblem = 'check evaluated 0 pricing entries on cache-reporting backends (expected many); treating as not evaluated'
            $cacheResult  = $null
        }
        elseif (-not $cacheResult -and -not $cacheProblem) {
            $cacheProblem = 'check produced no output'
        }
    }
}
if ($cacheProblem) {
    Write-Host "  WARN $cacheLabel — could not be evaluated: $cacheProblem" -ForegroundColor Yellow
    $Warnings["$cacheLabel (not evaluated)"] = $cacheProblem
}
elseif (@($cacheResult.issues).Count -gt 0) {
    $n = @($cacheResult.issues).Count
    Write-Host "  WARN $cacheLabel — $n of $($cacheResult.checked) pricing entries lack a numeric cachedInputPer1M:" -ForegroundColor Yellow
    foreach ($i in @($cacheResult.issues)) { Write-Host "        $($i.referenceSite)" -ForegroundColor Yellow }
    Write-Host '        Fix: set the provider cache-read price, or cachedInputPer1M = inputPer1M if there is no discount (never null).' -ForegroundColor DarkYellow
    $Warnings["$cacheLabel ($n missing)"] = "$n pricing entries lack cachedInputPer1M"
}
else {
    Write-Host "  OK   $cacheLabel — all $($cacheResult.checked) pricing entries on cache-reporting backends declare cachedInputPer1M (warn-only lane; not counted in the gate total)" -ForegroundColor Green
}

# ── Pricing-key contract (t/3946) ───────────────────────────────────────────
# `pricing` is keyed by models[].id (binding design t/3946#5, after Second Opinion e/248). Same CLI run as
# the cache lane above (findPricingKeyIssues). WARN: a key that isn't a models[].id, a reachable model with
# no pricing, two models sharing a (backend, apiModelId) pair. INFO: an apiModelId served by 2+ backends.
# WARN ONLY and FAIL CLOSED, exactly like the cache lane: kept out of $Results, so the "all N green" count
# never changes; a crash, missing fields or an empty model list is "could not be evaluated", never clean.
Write-Section 'Pricing-key contract (t/3946)'
$keyLabel   = 'pricing-keys'
$keyProblem = $cacheProblem
if (-not $keyProblem -and -not ($cacheResult.PSObject.Properties['keyIssues'] -and $cacheResult.PSObject.Properties['keyInfo'] -and $cacheResult.PSObject.Properties['models'])) {
    $keyProblem = "check output is missing 'models', 'keyIssues' or 'keyInfo'"
}
elseif (-not $keyProblem -and [int]$cacheResult.models -eq 0) {
    $keyProblem = 'check evaluated 0 models (expected many); treating as not evaluated'
}
if ($keyProblem) {
    Write-Host "  WARN $keyLabel — could not be evaluated: $keyProblem" -ForegroundColor Yellow
    $Warnings["$keyLabel (not evaluated)"] = $keyProblem
}
else {
    foreach ($i in @($cacheResult.keyInfo)) { Write-Host "  INFO $keyLabel — $($i.message)" -ForegroundColor DarkGray }
    $k = @($cacheResult.keyIssues).Count
    if ($k -gt 0) {
        Write-Host "  WARN $keyLabel — $k pricing-key issue(s) across $($cacheResult.models) models:" -ForegroundColor Yellow
        foreach ($i in @($cacheResult.keyIssues)) { Write-Host "        $($i.referenceSite): $($i.message)" -ForegroundColor Yellow }
        $Warnings["$keyLabel ($k issues)"] = "$k pricing-key contract issues"
    }
    else {
        Write-Host "  OK   $keyLabel — all pricing keys are models[].id, every reachable model is priced, (backend, apiModelId) pairs are unique (warn-only lane; not counted in the gate total)" -ForegroundColor Green
    }
}

# ── Calibration-epoch register (t/4037) ─────────────────────────────────────
# A changed `defaults` / `debateTiers` model starts a calibration epoch and needs a row in register §17
# (research/comp-linguist/docs/metric-provenance-register.md). Compared against the MERGE-BASE with
# origin/main, not its tip, so a branch that is behind main never reports main's own changes (in reverse)
# as its own. WARN ONLY and FAIL CLOSED like the lanes above: kept out of $Results until TL Gate
# Verification + Second Opinion (t/3361); "could not be evaluated" is never reported as clean.
Write-Section 'Calibration-epoch register (t/4037)'
$epochLabel = 'calibration-epochs'
$epochProblem = $null
$epochGaps = @()
try {
    . (Join-Path $PSScriptRoot 'CalibrationEpochCheck.ps1')
    $base = (git -C $RepoRoot merge-base HEAD origin/main 2>$null)
    if ($LASTEXITCODE -ne 0 -or -not $base) {
        $epochProblem = 'no merge-base with origin/main (run `git fetch origin main`)'
    }
    else {
        $baseJson = (git -C $RepoRoot show "$($base.Trim()):ai-models.json" 2>$null) -join "`n"
        if ($LASTEXITCODE -ne 0 -or -not $baseJson) { $epochProblem = "ai-models.json not readable at merge-base $($base.Trim().Substring(0, 8))" }
        else {
            $registerPath = Join-Path $RepoRoot 'research/comp-linguist/docs/metric-provenance-register.md'
            $headConfig = Get-Content -Raw (Join-Path $RepoRoot 'ai-models.json') | ConvertFrom-Json
            $rows = @(Get-EpochRegisterRows -Markdown (Get-Content -Raw $registerPath))
            $epochGaps = @(Find-UnrecordedEpochChanges -BaseConfig ($baseJson | ConvertFrom-Json) -HeadConfig $headConfig -RegisterRows $rows)
        }
    }
}
catch { $epochProblem = "check threw: $($_.Exception.Message)" }
if ($epochProblem) {
    Write-Host "  WARN $epochLabel — could not be evaluated: $epochProblem" -ForegroundColor Yellow
    $Warnings["$epochLabel (not evaluated)"] = $epochProblem
}
elseif ($epochGaps.Count -gt 0) {
    Write-Host "  WARN $epochLabel — $($epochGaps.Count) changed model slot(s) with no register §17 row:" -ForegroundColor Yellow
    foreach ($g in $epochGaps) {
        $old = if ($g.Old) { $g.Old } else { '(none)' }; $new = if ($g.New) { $g.New } else { '(none)' }
        Write-Host "        $($g.Slot): $old → $new" -ForegroundColor Yellow
    }
    Write-Host '        Fix: add one row per slot to metric-provenance-register.md §17 (Slot = the dotted slot above, Old → new as shown) in this PR.' -ForegroundColor DarkYellow
    $Warnings["$epochLabel ($($epochGaps.Count) unrecorded)"] = "$($epochGaps.Count) model slot change(s) without a §17 epoch row"
}
else {
    Write-Host "  OK   $epochLabel — every changed defaults/debateTiers model since the merge-base has a §17 row (warn-only lane; not counted in the gate total)" -ForegroundColor Green
}

# ── Summary ──────────────────────────────────────────────────────────────────
# PASS/FAIL gates live in $Results; WARN and N/A are reported on their own lines and counts and are
# NEVER folded into the PASSED total (t/3869#2 — "all N green" must not include a check that warned
# or never ran). Only a FAIL changes the exit code.
Write-Section 'Summary'
$failed = @()
foreach ($k in $Results.Keys) {
    if ($Results[$k]) {
        Write-Host "  [PASS] $k" -ForegroundColor Green
    } else {
        Write-Host "  [FAIL] $k" -ForegroundColor Red
        $failed += $k
    }
}
foreach ($k in $Warnings.Keys)      { Write-Host "  [WARN] $k" -ForegroundColor Yellow }
foreach ($k in $NotApplicable.Keys) { Write-Host "  [N/A]  $k" -ForegroundColor DarkGray }
$tail = ''
if ($Warnings.Count -gt 0)      { $tail += ", $($Warnings.Count) warning(s)" }
if ($NotApplicable.Count -gt 0) { $tail += ", $($NotApplicable.Count) N/A" }

if ($failed.Count -gt 0) {
    Write-Host ''
    Write-Host "verify:config FAILED — $($failed.Count) gate(s): $($failed -join ', ')$tail" -ForegroundColor Red
    exit 1
}

Write-Host ''
Write-Host "verify:config PASSED — all $($Results.Count) registry gate checks green ($($PesterGates.Count) Pester files, $($VitestGates.Count) vitest files)$tail." -ForegroundColor Green
exit 0
