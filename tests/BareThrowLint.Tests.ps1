# Tag: error-handling (t/4152)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Lint: no NEW bare `throw "message"` in scripts/AITriad/. Unrecoverable errors use
    New-ActionableError (Goal / Problem / Location / Next Steps), per the root AGENTS.md
    error-handling convention and docs/error-handling.md. WARN-only today (t/4152); see the
    Blocking toggle below.

.DESCRIPTION
    A bare string throw tells the reader what broke but not what was being attempted, where,
    or what to do next, which is exactly what New-ActionableError exists to supply. The tree
    already holds ~100 of them, so this is a RATCHET, not a ban: offenders are counted per
    file against tests/fixtures/bare-throw-baseline.json (same per-file ratchet idea as the
    complexity budget, scripts/complexity-baseline.json / Get-ComplexityBudgetVerdict).

    Detection is AST-based (ThrowStatementAst via Parser::ParseFile), never regex, over
    scripts/AITriad/**/*.ps1 and *.psm1.

    Counted (an "offender"):
      * throw <string>      -- StringConstantExpressionAst ('x', "x", here-strings)
      * throw "<x $y>"      -- ExpandableStringExpressionAst
      * throw $var          -- VariableExpressionAst, EXCEPT $_ / $PSItem and the small
                               file-scoped allow-list below ($script:BareThrowAllowList).
    Not counted:
      * bare `throw` (rethrow), `throw $_`, `throw $PSItem`
      * `throw (New-ActionableError ... )` and every other expression form.
      * `throw [Exception]::new(...)` / `throw [SomeException]'msg'` are OUT OF SCOPE for this
        lint: they are typed .NET exceptions, a separate conversation from string throws. They
        are deliberately not counted, so do not read "not flagged" as "approved".

    Verdict (pure, Get-BareThrowVerdict):
      * a file whose count is ABOVE its baseline         -> violation
      * a file NOT in the baseline with > 0 offenders    -> violation
      * a file BELOW its baseline (or gone from the tree) -> "ratchet down" note, not a violation
      * equal                                            -> pass

    Regenerating the baseline (after converting throws, to ratchet down):
        $env:BARETHROWLINT_REGEN_BASELINE = '1'
        Invoke-Pester tests/BareThrowLint.Tests.ps1
        Remove-Item Env:BARETHROWLINT_REGEN_BASELINE
    The helper writes the CURRENT counts. It warns about any file whose count rose; a raise
    in the baseline diff needs a reason in the PR, so convert the throw instead.

    WARN-only does NOT silence the logic: the classifier, verdict and gate-arm unit tests
    below always fail on wrong logic. Only the real-tree scan respects the Blocking toggle.

    SECOND CATEGORY: actionable-no-mode (t/4237)
    New-ActionableError with none of -AsErrorRecord / -PassThru / -Throw only calls Write-Error
    and returns NOTHING, so `throw (New-ActionableError ...)` throws $null: a bare ScriptHalted
    with no Goal / Problem / Next Steps, unless the caller happens to run with
    $ErrorActionPreference = 'Stop' (then the inner Write-Error carries the message). This
    category counts those throws, per file, against a SEPARATE section of the same baseline
    JSON (`actionable_no_mode`), with the same ratchet, verdict, regen switch, empty-scan guard,
    Blocking toggle and proof arm. The `files` section is the bare-throw category, unchanged.

    Counted (an "offender" of this category):
      * throw (New-ActionableError ...)   -- ParenExpressionAst holding one CommandAst
      * throw $(New-ActionableError ...)  -- SubExpressionAst holding one such statement
      with no -AsErrorRecord, -PassThru or -Throw (an explicit `-Switch:$false` counts as
      absent). A splatted call (@params) with no explicit switch is counted too: the lint cannot
      see inside the splat, so spell the mode switch at the call site.
    Not counted:
      * the same with any mode switch; a standalone New-ActionableError with no throw (its
        documented Write-Error default, which callers rely on).
      * `$e = New-ActionableError ...; throw $e` -- out of scope HERE: `throw $var` is already
        the bare-throw `variable` kind above (allow-list it when $e holds -AsErrorRecord).
      * string / variable throws -- they belong to the bare-throw category; the two classifiers
        are disjoint by construction, so no throw is counted twice.
    Mode-switch names are matched exactly (case-insensitive); an abbreviated switch
    (e.g. -AsErr) would be counted. None exist today -- spell the switch out.
#>

BeforeAll {
    $script:RepoRoot     = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    $script:BaselinePath = Join-Path $script:RepoRoot 'tests' 'fixtures' 'bare-throw-baseline.json'

    # ── Blocking toggle (t/4152) ─────────────────────────────────────────────────
    # $false = WARN-only: real-tree violations go out through Write-Warning (file, line, throw
    # text) and the test passes. $true = violations fail the gate.
    #
    # To PROMOTE to blocking: making a gate blocking is T2 under Change Tiers (t/4092), so it
    # needs a Second Opinion round, the T2 human approver, and live-fire evidence that the real
    # tree is at baseline with this toggle at $true (run with BARETHROWLINT_PROVE_BASELINE=1).
    # Once promoted, flipping it back to $false is a gate DEMOTION, not a config tweak: record
    # why, because the baseline ratchet assumes enforcement.
    $script:BareThrowLintBlocking = $false

    # ── Variable allow-list (t/4152) ────────────────────────────────────────────
    # `throw $var` is counted unless the variable demonstrably holds an ErrorRecord or an
    # already-actionable message. Entries are FILE-SCOPED: a global name allow (e.g. every
    # `throw $Message`) would hide real string throws elsewhere. Keep this list small; each
    # entry needs a reason. The 'allow-list entries are live' test fails on a stale entry.
    $script:BareThrowAllowList = @(
        [pscustomobject]@{
            File     = 'scripts/AITriad/Public/ConvertFrom-TruncatableJson.ps1'
            Variable = 'origError'
            Reason   = 'holds $_ (the ErrorRecord) captured at catch entry; rethrown from a nested catch, so it is `throw $_` with the original record preserved'
        }
        [pscustomobject]@{
            File     = 'scripts/AITriad/Private/New-ActionableError.ps1'
            Variable = 'Message'
            Reason   = 'the -Throw arm of New-ActionableError itself: $Message IS the rendered Goal/Error/Location/Resolve block, i.e. the convention''s own sink'
        }
        [pscustomobject]@{
            File     = 'scripts/AITriad/Public/Test-CriticalInteractions.ps1'
            Variable = 'Err'
            Reason   = 'holds New-ActionableError -AsErrorRecord (fixed in t/4155; before that it threw $null)'
        }
    )

    # ── Pure classifier ─────────────────────────────────────────────────────────
    # Returns 'literal' | 'variable' for a counted throw, $null for an allowed one.
    function script:Get-BareThrowKind {
        param(
            [Parameter(Mandatory)][System.Management.Automation.Language.ThrowStatementAst]$Throw,
            [string]$File = '',
            [object[]]$AllowList = @()
        )
        $pipe = $Throw.Pipeline
        if ($null -eq $pipe) { return $null }   # bare rethrow
        if ($pipe -isnot [System.Management.Automation.Language.PipelineAst]) { return $null }
        if (@($pipe.PipelineElements).Count -ne 1) { return $null }
        $element = $pipe.PipelineElements[0]
        if ($element -isnot [System.Management.Automation.Language.CommandExpressionAst]) { return $null }
        $expr = $element.Expression
        if ($expr -is [System.Management.Automation.Language.StringConstantExpressionAst] -or
            $expr -is [System.Management.Automation.Language.ExpandableStringExpressionAst]) {
            return 'literal'
        }
        if ($expr -is [System.Management.Automation.Language.VariableExpressionAst]) {
            $name = $expr.VariablePath.UserPath
            if ($name -in @('_', 'PSItem')) { return $null }
            $allowed = @($AllowList | Where-Object { $_.Variable -eq $name -and $_.File -eq $File })
            if ($allowed.Count -gt 0) { return $null }
            return 'variable'
        }
        # Everything else (New-ActionableError calls, [Exception]::new(...), member access,
        # sub-expressions, ...) is not counted. [Exception] forms are out of scope (see header).
        return $null
    }

    # ── Category table (t/4237) ─────────────────────────────────────────────────
    # One row per category: the baseline JSON section it ratchets against, and the words the
    # verdict, report and gate use. 'bare' keeps the original t/4152 wording byte-for-byte.
    $script:ThrowLintCategories = @{
        'bare' = [pscustomobject]@{
            Section = 'files'
            Ticket  = 't/4152'
            Noun    = 'bare throw(s)'
            Lint    = 'bare-throw-lint'
            Remedy  = 'Use New-ActionableError (Goal / Problem / Location / Next Steps), e.g. throw (New-ActionableError ... -AsErrorRecord) or New-ActionableError ... -Throw; see docs/error-handling.md.'
        }
        'actionable-no-mode' = [pscustomobject]@{
            Section = 'actionable_no_mode'
            Ticket  = 't/4237'
            Noun    = 'no-mode New-ActionableError throw(s)'
            Lint    = 'actionable-no-mode-lint'
            Remedy  = 'Add -AsErrorRecord: throw (New-ActionableError ... -AsErrorRecord). Without a mode switch New-ActionableError returns nothing, so the throw throws $null and the message is lost; see docs/error-handling.md.'
        }
    }

    # ── Pure classifier, actionable-no-mode (t/4237) ────────────────────────────
    # Returns 'actionable-no-mode' for `throw (New-ActionableError ...)` / `throw $(...)` with
    # no -AsErrorRecord / -PassThru / -Throw, else $null. Disjoint from Get-BareThrowKind:
    # that one only counts string and variable expressions, this one only paren/sub-expressions.
    function script:Get-ActionableNoModeKind {
        param([Parameter(Mandatory)][System.Management.Automation.Language.ThrowStatementAst]$Throw)
        $pipe = $Throw.Pipeline
        if ($null -eq $pipe -or $pipe -isnot [System.Management.Automation.Language.PipelineAst]) { return $null }
        if (@($pipe.PipelineElements).Count -ne 1) { return $null }
        $element = $pipe.PipelineElements[0]
        if ($element -isnot [System.Management.Automation.Language.CommandExpressionAst]) { return $null }
        $expr = $element.Expression
        $inner = $null
        if ($expr -is [System.Management.Automation.Language.ParenExpressionAst]) {
            $inner = $expr.Pipeline
        } elseif ($expr -is [System.Management.Automation.Language.SubExpressionAst]) {
            $stmts = @($expr.SubExpression.Statements)
            if ($stmts.Count -eq 1) { $inner = $stmts[0] }
        }
        if ($null -eq $inner -or $inner -isnot [System.Management.Automation.Language.PipelineAst]) { return $null }
        if (@($inner.PipelineElements).Count -ne 1) { return $null }
        $cmd = $inner.PipelineElements[0]
        if ($cmd -isnot [System.Management.Automation.Language.CommandAst]) { return $null }
        if ($cmd.GetCommandName() -ne 'New-ActionableError') { return $null }
        foreach ($p in @($cmd.CommandElements | Where-Object { $_ -is [System.Management.Automation.Language.CommandParameterAst] })) {
            if ($p.ParameterName -notin @('AsErrorRecord', 'PassThru', 'Throw')) { continue }
            # `-AsErrorRecord:$false` is present in the text but switches the mode off.
            $arg = $p.Argument
            if ($arg -is [System.Management.Automation.Language.VariableExpressionAst] -and $arg.VariablePath.UserPath -eq 'false') { continue }
            return $null
        }
        'actionable-no-mode'
    }

    # Pure: every counted throw in one AST, as {File, Line, Kind, Text} records.
    # -Category 'bare' (default, t/4152) or 'actionable-no-mode' (t/4237).
    function script:Get-BareThrowOffenders {
        param(
            [Parameter(Mandatory)][System.Management.Automation.Language.Ast]$Ast,
            [string]$File = '',
            [object[]]$AllowList = @(),
            [ValidateSet('bare', 'actionable-no-mode')][string]$Category = 'bare'
        )
        $throws = $Ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.ThrowStatementAst] }, $true)
        foreach ($t in $throws) {
            $kind = if ($Category -eq 'bare') {
                script:Get-BareThrowKind -Throw $t -File $File -AllowList $AllowList
            } else {
                script:Get-ActionableNoModeKind -Throw $t
            }
            if ($kind) {
                [pscustomobject]@{
                    File = $File
                    Line = $t.Extent.StartLineNumber
                    Kind = $kind
                    Text = (($t.Extent.Text -split "`r?`n")[0]).Trim()
                }
            }
        }
    }

    # Pure: per-file offender counts.
    function script:Measure-BareThrowCounts {
        param([object[]]$Offenders = @())
        $counts = @{}
        foreach ($o in $Offenders) {
            if ($counts.ContainsKey($o.File)) { $counts[$o.File]++ } else { $counts[$o.File] = 1 }
        }
        $counts
    }

    # Pure verdict: observed per-file counts against the baseline.
    function script:Get-BareThrowVerdict {
        param(
            [Parameter(Mandatory)][hashtable]$Observed,
            [Parameter(Mandatory)][hashtable]$Baseline,
            [ValidateSet('bare', 'actionable-no-mode')][string]$Category = 'bare'
        )
        $cat = $script:ThrowLintCategories[$Category]
        $violations = [System.Collections.Generic.List[object]]::new()
        $notes      = [System.Collections.Generic.List[object]]::new()
        foreach ($file in @($Observed.Keys | Sort-Object)) {
            $obs = [int]$Observed[$file]
            if ($obs -le 0) { continue }
            if ($Baseline.ContainsKey($file)) {
                $base = [int]$Baseline[$file]
                if ($obs -gt $base) {
                    $violations.Add([pscustomobject]@{ File = $file; Observed = $obs; Baseline = $base; Kind = 'increase' })
                }
            } else {
                $violations.Add([pscustomobject]@{ File = $file; Observed = $obs; Baseline = 0; Kind = 'new-file' })
            }
        }
        foreach ($file in @($Baseline.Keys | Sort-Object)) {
            $base = [int]$Baseline[$file]
            $obs  = if ($Observed.ContainsKey($file)) { [int]$Observed[$file] } else { 0 }
            if ($obs -lt $base) {
                $notes.Add([pscustomobject]@{
                    File = $file; Observed = $obs; Baseline = $base
                    Message = "ratchet down: $file has $obs $($cat.Noun), baseline $base -- update the baseline (tests/fixtures/bare-throw-baseline.json$(if ($cat.Section -ne 'files') { " section '$($cat.Section)'" }); BARETHROWLINT_REGEN_BASELINE=1)"
                })
            }
        }
        [pscustomobject]@{
            Violations = @($violations)
            Notes      = @($notes)
            Pass       = ($violations.Count -eq 0)
        }
    }

    # Pure: human report of the violations, one line per offending throw.
    function script:Format-BareThrowReport {
        param(
            [Parameter(Mandatory)]$Verdict,
            [object[]]$Offenders = @(),
            [ValidateSet('bare', 'actionable-no-mode')][string]$Category = 'bare'
        )
        $cat = $script:ThrowLintCategories[$Category]
        $lines = foreach ($v in $Verdict.Violations) {
            $why = if ($v.Kind -eq 'new-file') { 'not in the baseline' } else { "baseline $($v.Baseline)" }
            "$($v.File): $($v.Observed) $($cat.Noun), $why"
            foreach ($o in @($Offenders | Where-Object { $_.File -eq $v.File } | Sort-Object Line)) {
                "    $($o.File):$($o.Line)  $($o.Text)"
            }
        }
        @($lines) -join "`n"
    }

    # The gate: shared by the real-tree scan and the synthetic both-arms tests.
    function script:Assert-BareThrowGate {
        [CmdletBinding()]
        param(
            [Parameter(Mandatory)]$Verdict,
            [object[]]$Offenders = @(),
            [Parameter(Mandatory)][bool]$Blocking,
            # Synthetic tests and the proof arm pass this so CI logs carry each real note once.
            [switch]$SkipNotes,
            [ValidateSet('bare', 'actionable-no-mode')][string]$Category = 'bare'
        )
        $cat = $script:ThrowLintCategories[$Category]
        if (-not $SkipNotes) {
            foreach ($n in $Verdict.Notes) { Write-Host "$($cat.Lint) NOTE: $($n.Message)" }
        }
        $remedy = $cat.Remedy
        $report = script:Format-BareThrowReport -Verdict $Verdict -Offenders $Offenders -Category $Category
        $where  = if ($cat.Section -eq 'files') { 'tests/fixtures/bare-throw-baseline.json' } else { "tests/fixtures/bare-throw-baseline.json section '$($cat.Section)'" }
        if ($Blocking) {
            @($Verdict.Violations).Count | Should -Be 0 -Because "$($cat.Noun) rose above $where ($($cat.Ticket)). $remedy`n$report"
        } elseif (@($Verdict.Violations).Count -gt 0) {
            Write-Warning "$($cat.Lint) (WARN-only, $($cat.Ticket)): $(@($Verdict.Violations).Count) file(s) above baseline. $remedy`n$report"
        }
    }

    # Impure: scan the real tree.
    function script:Get-BareThrowTreeScan {
        param([Parameter(Mandatory)][string]$RepoRoot, [object[]]$AllowList = @())
        $dir = Join-Path $RepoRoot 'scripts' 'AITriad'
        $files = @(Get-ChildItem -LiteralPath $dir -Recurse -File | Where-Object { $_.Extension -in @('.ps1', '.psm1') } | Sort-Object FullName)
        $offenders = foreach ($f in $files) {
            $tokens = $null; $errors = $null
            $ast = [System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$tokens, [ref]$errors)
            $rel = $f.FullName.Substring($RepoRoot.Length).TrimStart('\', '/') -replace '\\', '/'
            if (@($errors).Count -gt 0) {
                Write-Warning "bare-throw-lint: $rel has $(@($errors).Count) parse error(s); scanning the partial AST, so its count may be low."
            }
            script:Get-BareThrowOffenders -Ast $ast -File $rel -AllowList $AllowList
            # One parse feeds both categories; the actionable-no-mode records carry their own Kind.
            script:Get-BareThrowOffenders -Ast $ast -File $rel -Category 'actionable-no-mode'
        }
        $all = @($offenders)
        [pscustomobject]@{
            FileCount           = $files.Count
            Offenders           = @($all | Where-Object { $_.Kind -ne 'actionable-no-mode' })
            ActionableOffenders = @($all | Where-Object { $_.Kind -eq 'actionable-no-mode' })
        }
    }

    # -Section 'files' (bare, default) or 'actionable_no_mode' (t/4237). A missing section reads
    # as an empty table, so a baseline written before t/4237 still loads.
    function script:Read-BareThrowBaseline {
        param([Parameter(Mandatory)][string]$Path, [string]$Section = 'files')
        $json = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
        $table = @{}
        if ($json.PSObject.Properties[$Section]) {
            foreach ($p in $json.$Section.PSObject.Properties) { $table[$p.Name] = [int]$p.Value }
        }
        $table
    }

    # Pure: warn on every file whose count rose (regen only). A first-ever generation of a
    # section (no previous entries) seeds every file, so it only warns on a re-generation.
    function script:Test-BareThrowRegenRises {
        param([Parameter(Mandatory)][hashtable]$Counts, [hashtable]$Previous = @{}, [string]$Lint = 'bare-throw-lint')
        foreach ($k in @($Counts.Keys | Where-Object { $Previous.Count -gt 0 } | Sort-Object)) {
            $before = if ($Previous.ContainsKey($k)) { [int]$Previous[$k] } else { 0 }
            if ($Counts[$k] -gt $before) {
                Write-Warning "$Lint regen: $k RISES $before -> $($Counts[$k]); a raise needs a reason in the PR -- convert the throw instead."
            }
        }
    }

    # Regenerate helper (BARETHROWLINT_REGEN_BASELINE=1); no public cmdlet needed. Writes BOTH
    # sections: `files` (bare, t/4152) and `actionable_no_mode` (t/4237).
    function script:Write-BareThrowBaseline {
        param(
            [Parameter(Mandatory)][string]$Path,
            [Parameter(Mandatory)][hashtable]$Counts,
            [hashtable]$Previous = @{},
            [hashtable]$ActionableCounts = @{},
            [hashtable]$PreviousActionable = @{}
        )
        script:Test-BareThrowRegenRises -Counts $Counts -Previous $Previous -Lint 'bare-throw-lint'
        script:Test-BareThrowRegenRises -Counts $ActionableCounts -Previous $PreviousActionable -Lint 'actionable-no-mode-lint'
        $files = [ordered]@{}
        foreach ($k in @($Counts.Keys | Sort-Object)) { $files[$k] = [int]$Counts[$k] }
        $actionable = [ordered]@{}
        foreach ($k in @($ActionableCounts.Keys | Sort-Object)) { $actionable[$k] = [int]$ActionableCounts[$k] }
        $doc = [ordered]@{
            __meta__ = [ordered]@{
                ticket     = 't/4152'
                doc        = 'Bare-throw ratchet baseline: per-file count of bare string/variable throws in scripts/AITriad/ (see tests/BareThrowLint.Tests.ps1 header for what counts). A count may only go down.'
                regenerate = "`$env:BARETHROWLINT_REGEN_BASELINE='1'; Invoke-Pester tests/BareThrowLint.Tests.ps1; Remove-Item Env:BARETHROWLINT_REGEN_BASELINE"
                actionable_no_mode = 't/4237: per-file count of throw (New-ActionableError ...) with no -AsErrorRecord / -PassThru / -Throw (throws $null). Same ratchet and regen switch as files.'
            }
            files              = $files
            actionable_no_mode = $actionable
        }
        ($doc | ConvertTo-Json -Depth 5) + "`n" | Set-Content -LiteralPath $Path -NoNewline -Encoding utf8NoBOM
    }

    # Pure (t/4146 lesson #247, extended to t/4237): $true when a regen must REFUSE to write,
    # because the scan saw no files, or a category saw no offenders while its baseline has some.
    function script:Test-BareThrowRegenEmptyScan {
        param(
            [Parameter(Mandatory)][int]$FileCount,
            [Parameter(Mandatory)][hashtable]$Observed,
            [Parameter(Mandatory)][hashtable]$Previous,
            [Parameter(Mandatory)][hashtable]$ObservedActionable,
            [Parameter(Mandatory)][hashtable]$PreviousActionable
        )
        ($FileCount -eq 0) -or
            ($Observed.Count -eq 0 -and $Previous.Count -gt 0) -or
            ($ObservedActionable.Count -eq 0 -and $PreviousActionable.Count -gt 0)
    }

    # ── Real-tree scan (once) ───────────────────────────────────────────────────
    $script:TreeScan = script:Get-BareThrowTreeScan -RepoRoot $script:RepoRoot -AllowList $script:BareThrowAllowList
    $script:ObservedCounts = script:Measure-BareThrowCounts -Offenders $script:TreeScan.Offenders
    $script:ObservedActionableCounts = script:Measure-BareThrowCounts -Offenders $script:TreeScan.ActionableOffenders

    if ($env:BARETHROWLINT_REGEN_BASELINE -eq '1') {
        $hasBaseline = Test-Path -LiteralPath $script:BaselinePath
        $prev      = if ($hasBaseline) { script:Read-BareThrowBaseline -Path $script:BaselinePath } else { @{} }
        $prevAct = if ($hasBaseline) { script:Read-BareThrowBaseline -Path $script:BaselinePath -Section 'actionable_no_mode' } else { @{} }
        # Lesson #247 (t/4146): a regenerate step must never write an empty scan over the source
        # of truth. Refuse when the scan saw no files, or either category saw no offenders while
        # its baseline section has some.
        if (script:Test-BareThrowRegenEmptyScan -FileCount $script:TreeScan.FileCount -Observed $script:ObservedCounts -Previous $prev -ObservedActionable $script:ObservedActionableCounts -PreviousActionable $prevAct) {
            # New-ActionableError is AITriad-private and this file does not import the module, so
            # the rendered labels are written out directly.
            throw [System.InvalidOperationException]::new(
                "Goal: Regenerate the bare-throw baseline`n" +
                "Error: The scan found $($script:TreeScan.FileCount) file(s), $($script:ObservedCounts.Count) bare-throw offending file(s) (baseline $($prev.Count)) and $($script:ObservedActionableCounts.Count) actionable-no-mode offending file(s) (baseline $($prevAct.Count)). NOT written, because an empty scan would wipe it`n" +
                "Location: tests/BareThrowLint.Tests.ps1 (BARETHROWLINT_REGEN_BASELINE)`n" +
                "Resolve: Check the scan root ($script:RepoRoot/scripts/AITriad). If every offender of a category really was removed, delete that section's entries by hand and commit that deliberately.")
        }
        script:Write-BareThrowBaseline -Path $script:BaselinePath -Counts $script:ObservedCounts -Previous $prev -ActionableCounts $script:ObservedActionableCounts -PreviousActionable $prevAct
        Write-Warning "bare-throw-lint: REGENERATED $script:BaselinePath from the current tree (BARETHROWLINT_REGEN_BASELINE=1). Review the diff before committing."
    }
}

Describe 'Bare-throw classifier (t/4152)' -Tag 'error-handling' {

    BeforeAll {
        function script:Get-SnippetKinds {
            param([string]$Code, [string]$File = 'scripts/AITriad/Public/Seed.ps1', [object[]]$AllowList = @())
            $tokens = $null; $errors = $null
            $ast = [System.Management.Automation.Language.Parser]::ParseInput($Code, [ref]$tokens, [ref]$errors)
            @($errors).Count | Should -Be 0 -Because "the snippet must parse: $Code"
            @(script:Get-BareThrowOffenders -Ast $ast -File $File -AllowList $AllowList)
        }
    }

    It 'counts <code> as <kind>' -TestCases @(
        @{ code = 'throw "plain double-quoted"';          kind = 'literal' }
        @{ code = "throw 'single-quoted'";                kind = 'literal' }
        @{ code = 'throw "expandable $x and $($y.z)"';    kind = 'literal' }
        @{ code = "throw @'`nhere-string`n'@";            kind = 'literal' }
        @{ code = "throw @`"`nexpandable here `$x`n`"@";  kind = 'literal' }
        @{ code = 'throw $msg';                           kind = 'variable' }
        @{ code = 'throw $script:LastError';              kind = 'variable' }
    ) {
        $hits = script:Get-SnippetKinds -Code $code
        $hits.Count   | Should -Be 1
        $hits[0].Kind | Should -Be $kind
    }

    It 'does not count <code>' -TestCases @(
        @{ code = 'try { 1 } catch { throw }' }
        @{ code = 'try { 1 } catch { throw $_ }' }
        @{ code = 'try { 1 } catch { throw $PSItem }' }
        @{ code = 'throw (New-ActionableError -Goal g -Problem p -Location l -NextSteps @("n") -AsErrorRecord)' }
        @{ code = 'throw [System.Exception]::new("out of scope for this lint")' }
        @{ code = 'throw [System.InvalidOperationException]"out of scope for this lint"' }
        @{ code = 'throw $_.Exception' }
        @{ code = 'throw $Error[0]' }
        @{ code = 'throw ("a" + $b)' }
        @{ code = 'throw New-Thing' }
    ) {
        @(script:Get-SnippetKinds -Code $code).Count | Should -Be 0
    }

    It 'reports file, line and the first line of the throw text' {
        $hits = script:Get-SnippetKinds -Code "function f {`n  `$a = 1`n  throw `"boom`"`n}" -File 'scripts/AITriad/Private/X.ps1'
        $hits.Count   | Should -Be 1
        $hits[0].File | Should -Be 'scripts/AITriad/Private/X.ps1'
        $hits[0].Line | Should -Be 3
        $hits[0].Text | Should -Be 'throw "boom"'
    }

    It 'the variable allow-list is file-scoped: allowed in its file, counted elsewhere' {
        $allow = @([pscustomobject]@{ File = 'scripts/AITriad/Public/A.ps1'; Variable = 'origError'; Reason = 'test' })
        @(script:Get-SnippetKinds -Code 'throw $origError' -File 'scripts/AITriad/Public/A.ps1' -AllowList $allow).Count | Should -Be 0
        @(script:Get-SnippetKinds -Code 'throw $origError' -File 'scripts/AITriad/Public/B.ps1' -AllowList $allow).Count | Should -Be 1
        @(script:Get-SnippetKinds -Code 'throw "x"'        -File 'scripts/AITriad/Public/A.ps1' -AllowList $allow).Count | Should -Be 1 -Because 'the allow-list exempts a variable, never the file'
    }

    It 'counts every bare throw in a mixed snippet and nothing else' {
        $code = @'
function f {
    try { g } catch { throw }
    if ($a) { throw "one" }
    if ($b) { throw $_ }
    if ($c) { throw $two }
    throw (New-ActionableError -Goal g -Problem p -Location l -NextSteps @('n') -AsErrorRecord)
}
'@
        $hits = script:Get-SnippetKinds -Code $code
        @($hits.Kind) | Should -Be @('literal', 'variable')
        @($hits.Line) | Should -Be @(3, 5)
    }

    It 'allow-list entries are live (each names a file that still holds throw $<Variable>)' {
        foreach ($e in $script:BareThrowAllowList) {
            $path = Join-Path $script:RepoRoot $e.File
            Test-Path -LiteralPath $path | Should -BeTrue -Because "allow-list entry $($e.File) must exist"
            $tokens = $null; $errors = $null
            $ast = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
            $live = @($ast.FindAll({ param($n)
                        $n -is [System.Management.Automation.Language.ThrowStatementAst] -and
                        $n.Pipeline -and $n.Pipeline.Extent.Text -eq "`$$($e.Variable)" }, $true))
            $live.Count | Should -BeGreaterThan 0 -Because "stale allow-list entry: $($e.File) no longer throws `$$($e.Variable) -- remove the entry"
            $e.Reason | Should -Not -BeNullOrEmpty
        }
    }
}

Describe 'Bare-throw verdict (t/4152)' -Tag 'error-handling' {

    It 'equal counts pass with no notes' {
        $v = script:Get-BareThrowVerdict -Observed @{ 'a.ps1' = 3 } -Baseline @{ 'a.ps1' = 3 }
        $v.Pass | Should -BeTrue
        @($v.Violations).Count | Should -Be 0
        @($v.Notes).Count | Should -Be 0
    }

    It 'a count ABOVE baseline is a violation' {
        $v = script:Get-BareThrowVerdict -Observed @{ 'a.ps1' = 4 } -Baseline @{ 'a.ps1' = 3 }
        $v.Pass | Should -BeFalse
        @($v.Violations).Count | Should -Be 1
        $v.Violations[0].Kind | Should -Be 'increase'
        $v.Violations[0].File | Should -Be 'a.ps1'
    }

    It 'an unlisted file with offenders is a violation' {
        $v = script:Get-BareThrowVerdict -Observed @{ 'a.ps1' = 3; 'new.ps1' = 1 } -Baseline @{ 'a.ps1' = 3 }
        $v.Pass | Should -BeFalse
        @($v.Violations).Count | Should -Be 1
        $v.Violations[0].Kind | Should -Be 'new-file'
        $v.Violations[0].File | Should -Be 'new.ps1'
    }

    It 'an unlisted file with 0 offenders is not a violation' {
        $v = script:Get-BareThrowVerdict -Observed @{ 'clean.ps1' = 0 } -Baseline @{}
        $v.Pass | Should -BeTrue
    }

    It 'a count BELOW baseline passes with a ratchet-down note' {
        $v = script:Get-BareThrowVerdict -Observed @{ 'a.ps1' = 2 } -Baseline @{ 'a.ps1' = 3 }
        $v.Pass | Should -BeTrue
        @($v.Notes).Count | Should -Be 1
        $v.Notes[0].Message | Should -BeLike '*ratchet down*a.ps1*update the baseline*'
    }

    It 'a baselined file now clean or deleted passes with a note' {
        $v = script:Get-BareThrowVerdict -Observed @{} -Baseline @{ 'gone.ps1' = 2 }
        $v.Pass | Should -BeTrue
        $v.Notes[0].File | Should -Be 'gone.ps1'
        $v.Notes[0].Observed | Should -Be 0
    }

    It 'mixed: one down, one up, one new -> two violations and one note' {
        $v = script:Get-BareThrowVerdict -Observed @{ 'down.ps1' = 1; 'up.ps1' = 5; 'new.ps1' = 2 } -Baseline @{ 'down.ps1' = 2; 'up.ps1' = 4 }
        @($v.Violations.File) | Should -Be @('new.ps1', 'up.ps1')
        @($v.Notes.File)      | Should -Be @('down.ps1')
    }
}

Describe 'Bare-throw gate arms on synthetic input (t/4152)' -Tag 'error-handling' {
    # Both arms of the Blocking toggle run here every time, whatever the toggle is set to, so
    # the blocking assertion is never first exercised on main on the day it is promoted.

    BeforeAll {
        $script:BadVerdict  = script:Get-BareThrowVerdict -Observed @{ 'x.ps1' = 2 } -Baseline @{ 'x.ps1' = 1 }
        $script:BadOffender = @(
            [pscustomobject]@{ File = 'x.ps1'; Line = 7;  Kind = 'literal'; Text = 'throw "old"' }
            [pscustomobject]@{ File = 'x.ps1'; Line = 12; Kind = 'literal'; Text = 'throw "new"' }
        )
    }

    It 'BLOCKING arm fails on a violation, naming file, line and throw text' {
        { script:Assert-BareThrowGate -Verdict $script:BadVerdict -Offenders $script:BadOffender -Blocking $true -SkipNotes } |
            Should -Throw -ExpectedMessage '*x.ps1:12  throw "new"*'
    }

    It 'WARN arm passes on the same violation and warns with file, line and throw text' {
        # Called directly: a throw here fails the It, which is the "passes" assertion.
        $w = $null
        script:Assert-BareThrowGate -Verdict $script:BadVerdict -Offenders $script:BadOffender -Blocking $false -SkipNotes -WarningVariable w -WarningAction SilentlyContinue
        @($w).Count | Should -Be 1
        ($w -join "`n") | Should -BeLike '*WARN-only*x.ps1:12  throw "new"*'
    }

    It 'BLOCKING arm passes a ratchet-down (note only)' {
        $down = script:Get-BareThrowVerdict -Observed @{ 'x.ps1' = 0 } -Baseline @{ 'x.ps1' = 1 }
        @($down.Notes).Count | Should -Be 1
        { script:Assert-BareThrowGate -Verdict $down -Blocking $true -SkipNotes } | Should -Not -Throw
    }
}

Describe 'Bare throws in scripts/AITriad/ do not grow (t/4152, WARN-only)' -Tag 'error-handling' {

    BeforeAll {
        $script:Baseline = script:Read-BareThrowBaseline -Path $script:BaselinePath
        $script:Verdict  = script:Get-BareThrowVerdict -Observed $script:ObservedCounts -Baseline $script:Baseline
    }

    It 'the scan is non-vacuous (files parsed and offenders found)' {
        $script:TreeScan.FileCount | Should -BeGreaterThan 0
        @($script:TreeScan.Offenders).Count | Should -BeGreaterThan 0 -Because 'a broken classifier would otherwise pass the ratchet on an empty set'
    }

    It 'the baseline exists, names its ticket and how to regenerate, and lists files' {
        $json = Get-Content -Raw -LiteralPath $script:BaselinePath | ConvertFrom-Json
        $json.__meta__.ticket     | Should -Be 't/4152'
        $json.__meta__.regenerate | Should -BeLike '*BARETHROWLINT_REGEN_BASELINE*'
        @($json.files.PSObject.Properties).Count | Should -BeGreaterThan 0
    }

    It 'no file exceeds its baseline (respects the Blocking toggle)' {
        script:Assert-BareThrowGate -Verdict $script:Verdict -Offenders $script:TreeScan.Offenders -Blocking $script:BareThrowLintBlocking
        @($script:TreeScan.Offenders).Count | Should -BeGreaterThan 0
    }

    It 'the shipped baseline holds with Blocking forced on (proof arm; BARETHROWLINT_PROVE_BASELINE=1)' {
        # Gated so this WARN-only lint cannot block CI: a CI-run forced-blocking assertion would
        # make the gate blocking in effect, which is a T2 change (t/4092). Run it as live-fire
        # before landing a baseline change, and before promoting the toggle.
        if ($env:BARETHROWLINT_PROVE_BASELINE -ne '1' -and -not $script:BareThrowLintBlocking) {
            Set-ItResult -Skipped -Because 'proof arm runs only with BARETHROWLINT_PROVE_BASELINE=1 while the lint is WARN-only'
            return
        }
        script:Assert-BareThrowGate -Verdict $script:Verdict -Offenders $script:TreeScan.Offenders -Blocking $true -SkipNotes
    }
}

Describe 'Actionable-no-mode classifier (t/4237)' -Tag 'error-handling' {

    BeforeAll {
        function script:Get-SnippetActionable {
            param([string]$Code, [string]$File = 'scripts/AITriad/Public/Seed.ps1')
            $tokens = $null; $errors = $null
            $ast = [System.Management.Automation.Language.Parser]::ParseInput($Code, [ref]$tokens, [ref]$errors)
            @($errors).Count | Should -Be 0 -Because "the snippet must parse: $Code"
            @(script:Get-BareThrowOffenders -Ast $ast -File $File -Category 'actionable-no-mode')
        }
    }

    It 'flags <code>' -TestCases @(
        @{ code = "throw (New-ActionableError -Goal g -Problem p -Location l -NextSteps @('x'))" }
        @{ code = "throw `$(New-ActionableError -Goal g -Problem p -Location l -NextSteps @('x'))" }
        @{ code = "throw (New-ActionableError -Goal g -Problem p -Location l -NextSteps @('x') -ErrorType T -InnerError `$_)" }
        @{ code = "throw (New-ActionableError -Goal g -Problem p -Location l -NextSteps @('x') -AsErrorRecord:`$false)" }
        @{ code = "throw (new-actionableerror -Goal g -Problem p -Location l -NextSteps @('x'))" }
        @{ code = "throw (New-ActionableError @splat)" }
        @{ code = "throw (New-ActionableError ``\n    -Goal g ``\n    -Problem p ``\n    -Location l ``\n    -NextSteps @('x'))".Replace('\n', "`n") }
    ) {
        $hits = script:Get-SnippetActionable -Code $code
        $hits.Count   | Should -Be 1
        $hits[0].Kind | Should -Be 'actionable-no-mode'
    }

    It 'does not flag <code>' -TestCases @(
        @{ code = "throw (New-ActionableError -Goal g -Problem p -Location l -NextSteps @('x') -AsErrorRecord)" }
        @{ code = "throw (New-ActionableError -Goal g -Problem p -Location l -NextSteps @('x') -PassThru)" }
        @{ code = "throw (New-ActionableError -Goal g -Problem p -Location l -NextSteps @('x') -Throw)" }
        @{ code = "throw `$(New-ActionableError -Goal g -Problem p -Location l -NextSteps @('x') -AsErrorRecord)" }
        @{ code = "throw (New-ActionableError -Goal g -Problem p -Location l -NextSteps @('x') -asErrorRecord:`$true)" }
        @{ code = "New-ActionableError -Goal g -Problem p -Location l -NextSteps @('x')" }
        @{ code = "New-ActionableError -Goal g -Problem p -Location l -NextSteps @('x') -Throw" }
        @{ code = 'try { 1 } catch { throw $_ }' }
        @{ code = 'try { 1 } catch { throw }' }
        @{ code = 'throw "x"' }
        @{ code = 'throw $msg' }
        @{ code = "`$e = New-ActionableError -Goal g -Problem p -Location l -NextSteps @('x'); throw `$e" }
        @{ code = 'throw (Get-Thing)' }
        @{ code = 'throw [System.Exception]::new("x")' }
    ) {
        @(script:Get-SnippetActionable -Code $code).Count | Should -Be 0
    }

    It 'reports file, line and the first line of the throw text' {
        $code = "function f {`n  `$a = 1`n  throw (New-ActionableError ```n    -Goal g -Problem p -Location l -NextSteps @('x'))`n}"
        $hits = script:Get-SnippetActionable -Code $code -File 'scripts/AITriad/Private/X.ps1'
        $hits.Count   | Should -Be 1
        $hits[0].File | Should -Be 'scripts/AITriad/Private/X.ps1'
        $hits[0].Line | Should -Be 3
        $hits[0].Text | Should -Be 'throw (New-ActionableError `'
    }

    It 'the two categories are disjoint: no throw is counted by both' {
        $code = @'
function f {
    if ($a) { throw "one" }
    if ($b) { throw $two }
    if ($c) { throw (New-ActionableError -Goal g -Problem p -Location l -NextSteps @('n')) }
    if ($d) { throw $(New-ActionableError -Goal g -Problem p -Location l -NextSteps @('n')) }
    throw (New-ActionableError -Goal g -Problem p -Location l -NextSteps @('n') -AsErrorRecord)
}
'@
        $tokens = $null; $errors = $null
        $ast  = [System.Management.Automation.Language.Parser]::ParseInput($code, [ref]$tokens, [ref]$errors)
        $bare = @(script:Get-BareThrowOffenders -Ast $ast -File 'f.ps1')
        $act  = @(script:Get-BareThrowOffenders -Ast $ast -File 'f.ps1' -Category 'actionable-no-mode')
        @($bare.Line) | Should -Be @(2, 3)
        @($act.Line)  | Should -Be @(4, 5)
        @($bare.Line | Where-Object { $_ -in @($act.Line) }).Count | Should -Be 0
    }
}

Describe 'Actionable-no-mode verdict and gate (t/4237)' -Tag 'error-handling' {

    It 'a count ABOVE baseline is a violation' {
        $v = script:Get-BareThrowVerdict -Observed @{ 'a.ps1' = 4 } -Baseline @{ 'a.ps1' = 3 } -Category 'actionable-no-mode'
        $v.Pass | Should -BeFalse
        $v.Violations[0].Kind | Should -Be 'increase'
    }

    It 'an unlisted file with offenders is a violation' {
        $v = script:Get-BareThrowVerdict -Observed @{ 'a.ps1' = 3; 'new.ps1' = 1 } -Baseline @{ 'a.ps1' = 3 } -Category 'actionable-no-mode'
        $v.Pass | Should -BeFalse
        @($v.Violations).Count | Should -Be 1
        $v.Violations[0].Kind | Should -Be 'new-file'
        $v.Violations[0].File | Should -Be 'new.ps1'
    }

    It 'a count BELOW baseline passes with a ratchet-down note naming the section' {
        $v = script:Get-BareThrowVerdict -Observed @{ 'a.ps1' = 2 } -Baseline @{ 'a.ps1' = 3 } -Category 'actionable-no-mode'
        $v.Pass | Should -BeTrue
        @($v.Notes).Count | Should -Be 1
        $v.Notes[0].Message | Should -BeLike "*ratchet down*a.ps1*no-mode New-ActionableError*update the baseline*section 'actionable_no_mode'*"
    }

    It 'BLOCKING arm fails naming file, line and throw text; WARN arm warns instead' {
        $bad  = script:Get-BareThrowVerdict -Observed @{ 'x.ps1' = 2 } -Baseline @{ 'x.ps1' = 1 } -Category 'actionable-no-mode'
        $offs = @(
            [pscustomobject]@{ File = 'x.ps1'; Line = 7;  Kind = 'actionable-no-mode'; Text = 'throw (New-ActionableError -Goal old' }
            [pscustomobject]@{ File = 'x.ps1'; Line = 12; Kind = 'actionable-no-mode'; Text = 'throw (New-ActionableError -Goal new' }
        )
        { script:Assert-BareThrowGate -Verdict $bad -Offenders $offs -Blocking $true -SkipNotes -Category 'actionable-no-mode' } |
            Should -Throw -ExpectedMessage '*-AsErrorRecord*x.ps1:12  throw (New-ActionableError -Goal new*'
        $w = $null
        script:Assert-BareThrowGate -Verdict $bad -Offenders $offs -Blocking $false -SkipNotes -Category 'actionable-no-mode' -WarningVariable w -WarningAction SilentlyContinue
        @($w).Count | Should -Be 1
        ($w -join "`n") | Should -BeLike '*actionable-no-mode-lint (WARN-only, t/4237)*x.ps1:12*'
    }

    It 'BLOCKING arm passes a ratchet-down (note only)' {
        $down = script:Get-BareThrowVerdict -Observed @{} -Baseline @{ 'x.ps1' = 1 } -Category 'actionable-no-mode'
        { script:Assert-BareThrowGate -Verdict $down -Blocking $true -SkipNotes -Category 'actionable-no-mode' } | Should -Not -Throw
    }

    It 'the regen empty-scan guard (#3237) refuses an empty scan of EITHER category over a non-empty baseline' {
        $some = @{ 'a.ps1' = 1 }
        # no files at all
        script:Test-BareThrowRegenEmptyScan -FileCount 0 -Observed $some -Previous $some -ObservedActionable $some -PreviousActionable $some | Should -BeTrue
        # bare category empty over a non-empty baseline
        script:Test-BareThrowRegenEmptyScan -FileCount 5 -Observed @{} -Previous $some -ObservedActionable $some -PreviousActionable $some | Should -BeTrue
        # actionable category empty over a non-empty baseline
        script:Test-BareThrowRegenEmptyScan -FileCount 5 -Observed $some -Previous $some -ObservedActionable @{} -PreviousActionable $some | Should -BeTrue
        # both populated, or a first-ever seed of the new section
        script:Test-BareThrowRegenEmptyScan -FileCount 5 -Observed $some -Previous $some -ObservedActionable $some -PreviousActionable $some | Should -BeFalse
        script:Test-BareThrowRegenEmptyScan -FileCount 5 -Observed $some -Previous $some -ObservedActionable $some -PreviousActionable @{} | Should -BeFalse
    }
}

Describe 'No-mode New-ActionableError throws in scripts/AITriad/ do not grow (t/4237, WARN-only)' -Tag 'error-handling' {

    BeforeAll {
        $script:ActBaseline = script:Read-BareThrowBaseline -Path $script:BaselinePath -Section 'actionable_no_mode'
        $script:ActVerdict  = script:Get-BareThrowVerdict -Observed $script:ObservedActionableCounts -Baseline $script:ActBaseline -Category 'actionable-no-mode'
    }

    It 'the scan is non-vacuous (offenders found)' {
        @($script:TreeScan.ActionableOffenders).Count | Should -BeGreaterThan 0 -Because 'a broken classifier would otherwise pass the ratchet on an empty set'
    }

    It 'the baseline has a non-empty actionable_no_mode section' {
        $json = Get-Content -Raw -LiteralPath $script:BaselinePath | ConvertFrom-Json
        $json.PSObject.Properties['actionable_no_mode'] | Should -Not -BeNullOrEmpty
        @($json.actionable_no_mode.PSObject.Properties).Count | Should -BeGreaterThan 0
        $json.__meta__.actionable_no_mode | Should -BeLike '*t/4237*'
    }

    It 'no file exceeds its baseline (respects the Blocking toggle)' {
        script:Assert-BareThrowGate -Verdict $script:ActVerdict -Offenders $script:TreeScan.ActionableOffenders -Blocking $script:BareThrowLintBlocking -Category 'actionable-no-mode'
        @($script:TreeScan.ActionableOffenders).Count | Should -BeGreaterThan 0
    }

    It 'the shipped baseline holds with Blocking forced on (proof arm; BARETHROWLINT_PROVE_BASELINE=1)' {
        # Same gating as the bare-throw proof arm: a CI-run forced-blocking assertion would make
        # the gate blocking in effect, which is T2 (t/4092).
        if ($env:BARETHROWLINT_PROVE_BASELINE -ne '1' -and -not $script:BareThrowLintBlocking) {
            Set-ItResult -Skipped -Because 'proof arm runs only with BARETHROWLINT_PROVE_BASELINE=1 while the lint is WARN-only'
            return
        }
        script:Assert-BareThrowGate -Verdict $script:ActVerdict -Offenders $script:TreeScan.ActionableOffenders -Blocking $true -SkipNotes -Category 'actionable-no-mode'
    }
}
