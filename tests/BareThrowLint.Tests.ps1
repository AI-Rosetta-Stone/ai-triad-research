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

    # Pure: every counted throw in one AST, as {File, Line, Kind, Text} records.
    function script:Get-BareThrowOffenders {
        param(
            [Parameter(Mandatory)][System.Management.Automation.Language.Ast]$Ast,
            [string]$File = '',
            [object[]]$AllowList = @()
        )
        $throws = $Ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.ThrowStatementAst] }, $true)
        foreach ($t in $throws) {
            $kind = script:Get-BareThrowKind -Throw $t -File $File -AllowList $AllowList
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
            [Parameter(Mandatory)][hashtable]$Baseline
        )
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
                    Message = "ratchet down: $file has $obs bare throw(s), baseline $base -- update the baseline (tests/fixtures/bare-throw-baseline.json; BARETHROWLINT_REGEN_BASELINE=1)"
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
        param([Parameter(Mandatory)]$Verdict, [object[]]$Offenders = @())
        $lines = foreach ($v in $Verdict.Violations) {
            $why = if ($v.Kind -eq 'new-file') { 'not in the baseline' } else { "baseline $($v.Baseline)" }
            "$($v.File): $($v.Observed) bare throw(s), $why"
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
            [switch]$SkipNotes
        )
        if (-not $SkipNotes) {
            foreach ($n in $Verdict.Notes) { Write-Host "bare-throw-lint NOTE: $($n.Message)" }
        }
        $remedy = 'Use New-ActionableError (Goal / Problem / Location / Next Steps), e.g. throw (New-ActionableError ... -AsErrorRecord) or New-ActionableError ... -Throw; see docs/error-handling.md.'
        $report = script:Format-BareThrowReport -Verdict $Verdict -Offenders $Offenders
        if ($Blocking) {
            @($Verdict.Violations).Count | Should -Be 0 -Because "bare throws rose above tests/fixtures/bare-throw-baseline.json (t/4152). $remedy`n$report"
        } elseif (@($Verdict.Violations).Count -gt 0) {
            Write-Warning "bare-throw-lint (WARN-only, t/4152): $(@($Verdict.Violations).Count) file(s) above baseline. $remedy`n$report"
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
        }
        [pscustomobject]@{ FileCount = $files.Count; Offenders = @($offenders) }
    }

    function script:Read-BareThrowBaseline {
        param([Parameter(Mandatory)][string]$Path)
        $json = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
        $table = @{}
        foreach ($p in $json.files.PSObject.Properties) { $table[$p.Name] = [int]$p.Value }
        $table
    }

    # Regenerate helper (BARETHROWLINT_REGEN_BASELINE=1); no public cmdlet needed.
    function script:Write-BareThrowBaseline {
        param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][hashtable]$Counts, [hashtable]$Previous = @{})
        # A first-ever generation (no previous baseline) seeds every file; only warn on a re-generation.
        foreach ($k in @($Counts.Keys | Where-Object { $Previous.Count -gt 0 } | Sort-Object)) {
            $before = if ($Previous.ContainsKey($k)) { [int]$Previous[$k] } else { 0 }
            if ($Counts[$k] -gt $before) {
                Write-Warning "bare-throw-lint regen: $k RISES $before -> $($Counts[$k]); a raise needs a reason in the PR -- convert the throw instead."
            }
        }
        $files = [ordered]@{}
        foreach ($k in @($Counts.Keys | Sort-Object)) { $files[$k] = [int]$Counts[$k] }
        $doc = [ordered]@{
            __meta__ = [ordered]@{
                ticket     = 't/4152'
                doc        = 'Bare-throw ratchet baseline: per-file count of bare string/variable throws in scripts/AITriad/ (see tests/BareThrowLint.Tests.ps1 header for what counts). A count may only go down.'
                regenerate = "`$env:BARETHROWLINT_REGEN_BASELINE='1'; Invoke-Pester tests/BareThrowLint.Tests.ps1; Remove-Item Env:BARETHROWLINT_REGEN_BASELINE"
            }
            files = $files
        }
        ($doc | ConvertTo-Json -Depth 5) + "`n" | Set-Content -LiteralPath $Path -NoNewline -Encoding utf8NoBOM
    }

    # ── Real-tree scan (once) ───────────────────────────────────────────────────
    $script:TreeScan = script:Get-BareThrowTreeScan -RepoRoot $script:RepoRoot -AllowList $script:BareThrowAllowList
    $script:ObservedCounts = script:Measure-BareThrowCounts -Offenders $script:TreeScan.Offenders

    if ($env:BARETHROWLINT_REGEN_BASELINE -eq '1') {
        $prev = if (Test-Path -LiteralPath $script:BaselinePath) { script:Read-BareThrowBaseline -Path $script:BaselinePath } else { @{} }
        script:Write-BareThrowBaseline -Path $script:BaselinePath -Counts $script:ObservedCounts -Previous $prev
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
