# Tag: lint (t/4366 AC3)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Corpus JSON read-then-rewrite lint (t/4366 AC3).
.DESCRIPTION
    On PS 7.4, bare ConvertFrom-Json coerces ISO timestamps to [datetime], so a function that reads
    a corpus file that way and writes the object back re-emits those strings differently: an offset
    like +02:00 becomes the machine's local offset, and .440Z becomes .44Z (t/4366#3, measured).
    The fix is ConvertFrom-JsonPreserveShape (or a per-file reader such as Read-EdgesFile); #3553
    and #3615 fixed every metadata.json writer that way.

    The check is per function, by AST data flow: a variable assigned from a pipeline containing bare
    ConvertFrom-Json that later reaches ConvertTo-Json, in a function with a write sink
    (Write-Utf8NoBom, Set-Content, Out-File, Add-Content, [IO.File]::WriteAll*). Every current hit
    is in tests/fixtures/corpus-read-rewrite-baseline.json with a reason and its owning ticket.

    A hit not in the baseline is a violation. While $script:CorpusReadLintBlocking is $false
    (WARN-only, per t/4366#3), violations go out through Write-Warning; the proof arms below
    always fail on wrong analyzer logic. A baseline entry no longer found is a ratchet-down note:
    delete it.
#>

BeforeAll {
    $script:RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
    $script:BaselinePath = Join-Path $PSScriptRoot 'fixtures' 'corpus-read-rewrite-baseline.json'
    # $false = WARN-only. Flip to $true to make a new bare read-then-rewrite fail CI.
    $script:CorpusReadLintBlocking = $false

    function script:Find-BareReadRewrite {
        # Hits as '<function>' names in one script text. <script> is the file's top level when it
        # defines no functions.
        param([Parameter(Mandatory)][string]$Text)
        $ast = [System.Management.Automation.Language.Parser]::ParseInput($Text, [ref]$null, [ref]$null)
        $fns = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true))
        if ($fns.Count -eq 0) { $fns = @($ast) }
        foreach ($fn in $fns) {
            $body = if ($fn -is [System.Management.Automation.Language.FunctionDefinitionAst]) { $fn.Body } else { $fn }
            $bare = @{}
            foreach ($as in $body.FindAll({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] }, $true)) {
                $isBare = @($as.Right.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'ConvertFrom-Json' }, $true)).Count -gt 0
                if ($isBare -and $as.Left -is [System.Management.Automation.Language.VariableExpressionAst]) { $bare[$as.Left.VariablePath.UserPath] = $true }
            }
            if ($bare.Count -eq 0) { continue }
            # The bare-read object itself must be what's serialized: piped in ($d | ConvertTo-Json), or
            # passed as -InputObject / the first positional argument. A derived value (@{ n = $d.x })
            # is not a rewrite of the file.
            $isBareVar = { param($e) $e -is [System.Management.Automation.Language.VariableExpressionAst] -and $bare.ContainsKey($e.VariablePath.UserPath) }
            $reaches = $false
            foreach ($p in $body.FindAll({ param($n) $n -is [System.Management.Automation.Language.PipelineAst] }, $true)) {
                $els = @($p.PipelineElements)
                for ($i = 0; $i -lt $els.Count -and -not $reaches; $i++) {
                    $c = $els[$i]
                    if ($c -isnot [System.Management.Automation.Language.CommandAst] -or $c.GetCommandName() -ne 'ConvertTo-Json') { continue }
                    if ($i -gt 0 -and $els[$i - 1] -is [System.Management.Automation.Language.CommandExpressionAst] -and (& $isBareVar $els[$i - 1].Expression)) { $reaches = $true; break }
                    $ce = @($c.CommandElements)
                    for ($j = 1; $j -lt $ce.Count; $j++) {
                        $prev = $ce[$j - 1]
                        $named = $prev -is [System.Management.Automation.Language.CommandParameterAst] -and $prev.ParameterName -like 'I*'   # -InputObject (any unambiguous prefix)
                        $positional = $j -eq 1 -and $ce[$j] -isnot [System.Management.Automation.Language.CommandParameterAst]
                        if (($named -or $positional) -and (& $isBareVar $ce[$j])) { $reaches = $true; break }
                    }
                }
                if ($reaches) { break }
            }
            if (-not $reaches) { continue }
            $sinks = @($body.FindAll({ param($n)
                ($n -is [System.Management.Automation.Language.CommandAst] -and $n.GetCommandName() -match '^(Write-Utf8NoBom|Set-Content|Out-File|Add-Content)$') -or
                ($n -is [System.Management.Automation.Language.InvokeMemberExpressionAst] -and "$($n.Member)" -match '^WriteAll(Text|Bytes)$') }, $true))
            if ($sinks.Count -eq 0) { continue }
            if ($fn -is [System.Management.Automation.Language.FunctionDefinitionAst]) { $fn.Name } else { '<script>' }
        }
    }

    function script:Get-TreeHit {
        $scripts = Join-Path $script:RepoRoot 'scripts'
        foreach ($f in Get-ChildItem $scripts -Recurse -Include *.ps1, *.psm1 -File | Where-Object FullName -notmatch '[\\/](archive|tests?)[\\/]') {
            $rel = $f.FullName.Substring($script:RepoRoot.Length + 1) -replace '\\', '/'
            foreach ($fn in @(script:Find-BareReadRewrite -Text ([IO.File]::ReadAllText($f.FullName)))) { "$rel::$fn" }
        }
    }
}

Describe 'Corpus JSON read-then-rewrite lint: analyzer proof arms (always enforced)' -Tag 'lint' {
    It 'flags a bare read whose object is written back' {
        $t = 'function Fix-It { $d = Get-Content -Raw $p | ConvertFrom-Json; $d.x = 1; $d | ConvertTo-Json -Depth 9 | Set-Content $p }'
        @(script:Find-BareReadRewrite -Text $t) | Should -Be @('Fix-It')
    }
    It 'flags -InputObject and [IO.File]::WriteAllText forms' {
        $t = 'function Fix-It { $d = [IO.File]::ReadAllText($p) | ConvertFrom-Json -AsHashtable; $j = ConvertTo-Json -InputObject $d; [IO.File]::WriteAllText($p, $j) }'
        @(script:Find-BareReadRewrite -Text $t) | Should -Be @('Fix-It')
    }
    It 'does not flag a shape-preserving read' {
        $t = 'function Ok-It { $d = ConvertFrom-JsonPreserveShape -Json $raw -AsOrderedHashtable; $d | ConvertTo-Json | Write-Utf8NoBom -Path $p }'
        @(script:Find-BareReadRewrite -Text $t).Count | Should -Be 0
    }
    It 'does not flag a bare read that is never written back' {
        $t = 'function Ok-It { $d = Get-Content -Raw $p | ConvertFrom-Json; $out = @{ n = $d.count } | ConvertTo-Json; Set-Content $q $out }'
        @(script:Find-BareReadRewrite -Text $t).Count | Should -Be 0
    }
    It 'does not flag a function with no write sink' {
        $t = 'function Ok-It { $d = Get-Content -Raw $p | ConvertFrom-Json; $d | ConvertTo-Json }'
        @(script:Find-BareReadRewrite -Text $t).Count | Should -Be 0
    }
    It 'fails on the pre-#3553 metadata read (the bug this ticket fixed)' {
        $src = [IO.File]::ReadAllText((Join-Path $script:RepoRoot 'scripts' 'AITriad' 'Private' 'Set-BatchDocCurrent.ps1'))
        $m = [regex]::Match($src, 'ConvertFrom-JsonPreserveShape -Json (\$\w+) -AsOrderedHashtable')
        $m.Success | Should -BeTrue -Because 'the #3553 fix site is where this arm expects it'
        @(script:Find-BareReadRewrite -Text $src).Count | Should -Be 0 -Because 'fixed today'
        $old = $src.Replace($m.Value, "$($m.Groups[1].Value) | ConvertFrom-Json -AsHashtable")
        @(script:Find-BareReadRewrite -Text $old) | Should -Be @('Set-BatchDocCurrent')
    }
}

Describe 'Corpus JSON read-then-rewrite lint: the real tree against the baseline' -Tag 'lint' {
    BeforeAll {
        $script:Baseline = (Get-Content -Raw $script:BaselinePath | ConvertFrom-Json -AsHashtable).entries
        $script:Hits = @(script:Get-TreeHit)
    }

    It 'finds the known hits (the scan works)' {
        # The corpus rewriters are fixed (t/4356, t/4425); what remains are the 4 non-corpus entries.
        # The scanner itself is proven by the synthetic arms above.
        $script:Hits.Count | Should -BeGreaterThan 0
        $script:Hits | Should -Contain 'scripts/AITriad/Private/Update-DebateProgress.ps1::Update-DebateProgress'
    }

    It 'has no bare read-then-rewrite outside the baseline' {
        $new = @($script:Hits | Where-Object { -not $script:Baseline.ContainsKey($_) })
        if ($new.Count -and -not $script:CorpusReadLintBlocking) {
            Write-Warning "CorpusJsonReadLint (WARN-only, t/4366): $($new.Count) new bare ConvertFrom-Json read-then-rewrite(s): $($new -join '; '). Read with ConvertFrom-JsonPreserveShape (or Read-EdgesFile) instead; see docs/powershell-strict-mode.md and t/4366#3."
            return
        }
        $new | Should -BeNullOrEmpty -Because 'read corpus JSON with ConvertFrom-JsonPreserveShape before writing it back (t/4366)'
    }

    It 'notes baseline entries that no longer match (ratchet down)' {
        $gone = @($script:Baseline.Keys | Where-Object { $_ -notin $script:Hits })
        if ($gone.Count) { Write-Warning "CorpusJsonReadLint: fixed, delete from the baseline: $($gone -join '; ')" }
        $true | Should -BeTrue
    }

    It 'gives every baseline entry a reason and an owning ticket' {
        foreach ($k in $script:Baseline.Keys) {
            $script:Baseline[$k].reason | Should -Not -BeNullOrEmpty -Because $k
            $script:Baseline[$k].ticket | Should -Match '^t/\d+$' -Because $k
        }
    }
}
