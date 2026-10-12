# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Update-ComplexityBaseline {
    <#
    .SYNOPSIS
        Generates/regenerates the PowerShell complexity-ratchet baseline (t/3829).
    .DESCRIPTION
        Peer of the TypeScript complexity-ratchet baseline (t/3820/t/3821), adopting
        its corrected semantics verbatim: per-FILE record of { max, countOver }, both
        offenders-only (max > Threshold), write-only-downward (never raises a recorded
        number -- a regression against the existing entry is simply not written, which
        leaves the old frozen value in place so Test-ComplexityBudget catches it on the
        next enforcement run), and a cured file (max drops to <= Threshold) is dropped
        from the baseline entirely rather than left as a stale entry.

        Write-only-downward uses Get-ComplexityBudgetVerdict's Pareto-dominance rule,
        not independent per-field minima -- independent minima would score a good
        decomposition (one 302-complexity function split into several smaller ones,
        which lowers max but raises countOver) as a regression. See
        Get-ComplexityBudgetVerdict's docstring for the full rule and why.

        Both this generator and Test-ComplexityBudget call Measure-CodeComplexity
        directly (via the shared Get-ComplexityScanTargets) as the SOLE complexity
        counter -- there is no second implementation to mirror, so there is nothing to
        parity-check and nothing that can silently diverge the way the TypeScript
        side's hand-mirrored ESLint-node-set once did (t/3829#11).

        Self-validates its own output before writing (t/3829#4's "make the generator
        assert its own output shape"): output key count must equal written+kept
        decisions, no two keys may collide case-insensitively, and -- t/3874 -- no
        emitted key may contain '\'. The last guard exists because Measure-CodeComplexity's
        File (via [System.IO.Path]::GetRelativePath) is OS-native-separated; a baseline
        generated on Windows and enforced on Linux CI never matched on ContainsKey, so
        EVERY baselined scripts/ file read as a brand-new offender there (t/3874, found
        via t/3871#3). Get-ComplexityScanTargets now normalizes to '/' at the source, so
        this assertion should never fire in normal operation -- it exists to catch a
        Windows regeneration silently reintroducing '\' if that normalization ever
        regresses, not to handle an expected case.
    .PARAMETER Path
    .PARAMETER Path
        Root directory to scan. Default: the scripts/ directory (same resolution as
        Measure-CodeComplexity's default) -- this IS the ratchet's scan scope; its
        leaf name is recorded verbatim as __meta__.scan.
    .PARAMETER BaselinePath
        Path to the baseline JSON file. Default: complexity-baseline.json directly
        under -Path.
    .PARAMETER Threshold
        The complexity threshold above which a file is considered an offender and
        gets a baseline entry. Default: 15 (matches the TypeScript peer's threshold
        and t/3824's sizing analysis). This is the canonical value -- change it only
        here; Test-ComplexityBudget reads it back from the baseline's own __meta__
        rather than carrying an independent default, so there is no second place for
        it to drift out of sync (t/3829#4's "parameter lives in two places" problem,
        eliminated rather than tied-by-convention).
    .OUTPUTS
        [PSCustomObject] { Path; OffenderCount; Written; Kept; VisitedFiles }
    .EXAMPLE
        Update-ComplexityBaseline
    .EXAMPLE
        Update-ComplexityBaseline -WhatIf -Verbose
    .LINK
        Test-ComplexityBudget
    .LINK
        Measure-CodeComplexity
    #>
    [CmdletBinding(SupportsShouldProcess)]
    [OutputType([pscustomobject])]
    param(
        [Parameter()]
        [string]$Path,

        [Parameter()]
        [string]$BaselinePath,

        [Parameter()]
        [ValidateScript({ $_ -gt 0 })]
        [int]$Threshold = 15
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    if (-not $Path) {
        # Measure-CodeComplexity's own default resolution: scripts/AITriad/Public -> scripts/
        $Path = (Resolve-Path (Join-Path $PSScriptRoot '..' '..')).Path
    }
    elseif (Test-Path -LiteralPath $Path -PathType Container) {
        # t/4146: resolve against the PowerShell location. A relative -Path was otherwise
        # resolved against the process working directory by the scan, found nothing, and the
        # empty result overwrote the whole baseline.
        $Path = (Resolve-Path -LiteralPath $Path).Path
    }
    else {
        throw (New-ActionableError -Goal 'Regenerate the complexity baseline' `
            -Problem "-Path '$Path' is not a directory" `
            -Location 'Update-ComplexityBaseline' `
            -NextSteps @('Pass the scripts/ directory, e.g. -Path ./scripts, or omit -Path to use the module default') `
            -AsErrorRecord)
    }
    if (-not $BaselinePath) {
        $BaselinePath = Join-Path $Path 'complexity-baseline.json'
    }
    $scanLabel = Split-Path $Path -Leaf

    Write-Verbose "Scanning '$Path' (scan label '$scanLabel') at threshold $Threshold"
    $targets = @(Get-ComplexityScanTargets -Path $Path)
    if ($targets.Count -eq 0) {
        # t/4146: an empty scan must never be written over the baseline, because it would
        # silently drop every entry. A real tree always has functions to measure.
        throw (New-ActionableError -Goal 'Regenerate the complexity baseline' `
            -Problem "The scan of '$Path' found no functions, so the baseline was NOT written (writing it would remove every entry)" `
            -Location 'Update-ComplexityBaseline' `
            -NextSteps @("Check that -Path points at the scripts/ tree (it resolved to '$Path')", 'Run Measure-CodeComplexity -Path <same path> to confirm it finds functions') `
            -AsErrorRecord)
    }

    $observedByFile = [ordered]@{}
    foreach ($group in ($targets | Group-Object File)) {
        $maxComplexity = ($group.Group | Measure-Object -Property Complexity -Maximum).Maximum
        $countOver = @($group.Group | Where-Object { $_.Complexity -gt $Threshold }).Count
        $observedByFile[$group.Name] = [ordered]@{ max = [int]$maxComplexity; countOver = $countOver }
    }
    Write-Verbose "Measured $($observedByFile.Count) file(s) with at least one function in scope"

    $existingBaseline = @{}
    if (Test-Path -LiteralPath $BaselinePath) {
        $raw = Get-Content -LiteralPath $BaselinePath -Raw | ConvertFrom-Json
        foreach ($prop in $raw.PSObject.Properties) {
            if ($prop.Name -eq '__meta__') { continue }
            # t/3874: normalize on READ too -- tolerates a legacy/hand-edited '\'-keyed
            # entry so it still matches the '/'-keyed observed file from the now-normalized
            # Get-ComplexityScanTargets, rather than silently treating it as cured.
            $key = $prop.Name.Replace('\', '/')
            # t/3877: ConvertFrom-ComplexityBaselineEntry also captures an optional TL-authorized
            # justifiedRaise annotation (t/3874#2/p/360#496) -- see ComplexityBaselineAnnotation.ps1.
            $existingBaseline[$key] = ConvertFrom-ComplexityBaselineEntry -Value $prop.Value
        }
    }

    $written = 0
    $kept = 0
    $output = [ordered]@{}

    foreach ($file in $observedByFile.Keys) {
        $observed = $observedByFile[$file]

        if ($observed.max -le $Threshold) {
            # Sub-threshold: never baselined. If this file was previously an offender
            # and has now been cured, it is correctly dropped by simply not writing it --
            # baseline-offenders-only, never a stale entry for a healed file.
            continue
        }

        if ($existingBaseline.ContainsKey($file)) {
            $existing = $existingBaseline[$file]
            if (Get-ComplexityBudgetVerdict -Observed $observed -Existing $existing -Threshold $Threshold) {
                $output[$file] = $observed
                $written++
            } else {
                # Regression vs. the frozen baseline: write-only-downward refuses to
                # raise the recorded number. Keep the OLD value so the next
                # Test-ComplexityBudget run flags this file as a real regression,
                # rather than silently absorbing it into a new "baseline".
                $output[$file] = $existing
                $kept++
                Write-Warning "Update-ComplexityBaseline: '$file' regressed (observed max=$($observed.max) countOver=$($observed.countOver) vs frozen max=$($existing.max) countOver=$($existing.countOver)) -- keeping frozen value; Test-ComplexityBudget will flag this."
            }
            # t/3877: forward a justified-raise annotation across regeneration on EITHER
            # branch above (no-op if $existing doesn't have one) -- see
            # ComplexityBaselineAnnotation.ps1 for why this can't change ratchet behavior.
            $null = Copy-ComplexityBaselineAnnotation -Existing $existing -Output $output[$file] -File $file
        } else {
            $output[$file] = $observed
            $written++
        }
    }

    # Self-validation (t/3829#4): assert the generator's own output shape rather than
    # trusting the control flow above. A future edit that adds another $output[...]
    # assignment path without a matching counter increment fails loudly here.
    if ($output.Count -ne ($written + $kept)) {
        New-ActionableError `
            -Goal 'Generate the complexity-ratchet baseline' `
            -Problem "Self-check failed: output has $($output.Count) key(s) but written($written) + kept($kept) = $($written + $kept)" `
            -Location 'Update-ComplexityBaseline' `
            -NextSteps @('This indicates a logic defect in the generator -- do not ship a baseline that failed this check', 'File a bug; do not silently proceed') `
            -Throw
    }
    $normalizedKeys = @($output.Keys | ForEach-Object { $_.ToLowerInvariant() })
    $duplicates = @($normalizedKeys | Group-Object | Where-Object { $_.Count -gt 1 })
    if ($duplicates.Count -gt 0) {
        New-ActionableError `
            -Goal 'Generate the complexity-ratchet baseline' `
            -Problem "Case-insensitive duplicate key(s) detected: $(($duplicates | ForEach-Object { $_.Name }) -join ', ')" `
            -Location 'Update-ComplexityBaseline' `
            -NextSteps @('Two different path spellings resolved to the same physical file -- check -Path and the scan for symlinks or mixed casing') `
            -Throw
    }
    # t/3874: a baseline generated on Windows and enforced on Linux CI never matched on
    # ContainsKey (OS-native separator vs '/'), so every baselined scripts/ file read as
    # a brand-new offender there -- 177 false positives, found via t/3871#3. Get-
    # ComplexityScanTargets normalizes to '/' at the source, so this should never fire;
    # it exists to catch a Windows regeneration silently reintroducing '\' if that
    # normalization ever regresses, rather than writing a baseline broken the same way.
    $backslashKeys = @($output.Keys | Where-Object { $_.Contains('\') })
    if ($backslashKeys.Count -gt 0) {
        New-ActionableError `
            -Goal 'Generate the complexity-ratchet baseline' `
            -Problem "Emitted key(s) contain '\' instead of '/': $($backslashKeys -join ', ')" `
            -Location 'Update-ComplexityBaseline' `
            -NextSteps @('This indicates Get-ComplexityScanTargets stopped normalizing separators -- do not ship a baseline that failed this check', 'File a bug; do not silently proceed') `
            -Throw
    }

    $final = [ordered]@{
        __meta__ = [ordered]@{
            threshold = $Threshold
            scan      = $scanLabel
            doc       = 'PowerShell complexity-ratchet baseline (t/3829). Per-file {max, countOver}, offenders only (max > threshold). Shrinks monotonically -- regenerated by Update-ComplexityBaseline, which never raises a recorded number. Entries are never added for files at or below threshold.'
        }
    }
    foreach ($key in ($output.Keys | Sort-Object)) { $final[$key] = $output[$key] }

    if ($PSCmdlet.ShouldProcess($BaselinePath, "Write complexity baseline ($($output.Count) offender file(s))")) {
        $final | ConvertTo-Json -Depth 5 | Write-Utf8NoBom -Path $BaselinePath
        Write-Verbose "Wrote $BaselinePath ($($output.Count) offender file(s): $written written, $kept kept-frozen)"
    }

    [PSCustomObject]@{
        Path          = $BaselinePath
        OffenderCount = $output.Count
        Written       = $written
        Kept          = $kept
        VisitedFiles  = $observedByFile.Count
    }
}
