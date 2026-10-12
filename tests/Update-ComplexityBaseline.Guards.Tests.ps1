# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
    t/4146: Update-ComplexityBaseline must never write an empty scan over the baseline.
    A relative -Path used to be resolved against the process working directory instead of the
    PowerShell location; the scan found nothing and the empty result silently replaced every
    baseline entry. These tests pin both guards: relative paths resolve against Get-Location,
    and an empty scan or a non-directory -Path throws without touching the baseline file.
#>

BeforeAll {
    $script:RepoRoot = Split-Path -Parent $PSScriptRoot
    Import-Module (Join-Path $script:RepoRoot 'scripts/AITriad/AITriad.psm1') -Force -WarningAction SilentlyContinue
}

Describe 'Update-ComplexityBaseline guards (t/4146)' -Tag 'complexity' {
    BeforeEach {
        $script:Work = Join-Path ([System.IO.Path]::GetTempPath()) ('cb-guard-' + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $script:Work | Out-Null
        $script:Baseline = Join-Path $script:Work 'baseline.json'
        Set-Content -LiteralPath $script:Baseline -Value '{"__meta__":{"threshold":15},"keep.ps1":{"max":30,"countOver":1}}' -NoNewline
        $script:BaselineBefore = Get-Content -LiteralPath $script:Baseline -Raw
    }
    AfterEach {
        Remove-Item -LiteralPath $script:Work -Recurse -Force -ErrorAction SilentlyContinue
    }

    It 'an empty scan throws an actionable error and leaves the baseline byte-identical' {
        $empty = Join-Path $script:Work 'empty'
        New-Item -ItemType Directory -Path $empty | Out-Null
        $thrown = $null
        try { Update-ComplexityBaseline -Path $empty -BaselinePath $script:Baseline -Confirm:$false }
        catch { $thrown = $_ }
        $thrown | Should -Not -BeNullOrEmpty
        $thrown.Exception.Message | Should -Match 'Goal:'
        $thrown.Exception.Message | Should -Match 'found no functions'
        (Get-Content -LiteralPath $script:Baseline -Raw) | Should -BeExactly $script:BaselineBefore
    }

    It 'a -Path that is not a directory throws and leaves the baseline byte-identical' {
        $thrown = $null
        try { Update-ComplexityBaseline -Path (Join-Path $script:Work 'does-not-exist') -BaselinePath $script:Baseline -Confirm:$false }
        catch { $thrown = $_ }
        $thrown | Should -Not -BeNullOrEmpty
        $thrown.Exception.Message | Should -Match 'is not a directory'
        (Get-Content -LiteralPath $script:Baseline -Raw) | Should -BeExactly $script:BaselineBefore
    }

    It 'a relative -Path resolves against the PowerShell location, not the process directory' {
        $src = Join-Path $script:Work 'src'
        New-Item -ItemType Directory -Path $src | Out-Null
        $body = (1..20 | ForEach-Object { "    if (`$x -eq $_) { `$y = $_ }" }) -join "`n"
        Set-Content -LiteralPath (Join-Path $src 'Busy.ps1') -Value "function Get-Busy {`n    param(`$x)`n$body`n}"
        Push-Location $script:Work
        try {
            $result = Update-ComplexityBaseline -Path 'src' -BaselinePath $script:Baseline -Confirm:$false
        }
        finally { Pop-Location }
        $result.VisitedFiles | Should -BeGreaterThan 0
        $result.OffenderCount | Should -BeGreaterThan 0
        (Get-Content -LiteralPath $script:Baseline -Raw) | Should -Match 'Busy\.ps1'
    }
}
