# Tag: unit (t/214)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Orca t/4861 (t/214): -Ids / -ExcludeIds scoping for scripts/Invoke-DisagreementTypeBackfill.ps1.
.DESCRIPTION
    The script runs on load (imports, reads situations.json, calls the AI), so its pure
    Select-BackfillTarget is lifted out with the parser and tested on synthetic nodes: a frozen
    -Ids list is honoured exactly, an unknown or already-populated id is an error (a frozen list
    can't silently shrink), and -ExcludeIds needs a reason that is logged. No AI, no data.
#>

BeforeAll {
    $path = Join-Path $PSScriptRoot '..' 'scripts' 'Invoke-DisagreementTypeBackfill.ps1'
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$null, [ref]$null)
    $fn = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Select-BackfillTarget' }, $true)
    . ([scriptblock]::Create($fn.Extent.Text))
    $script:Cands = @('sit-484', 'sit-485', 'sit-486', 'sit-487', 'sit-999') | ForEach-Object { [pscustomobject]@{ id = $_ } }
}

Describe 'Select-BackfillTarget (t/214)' -Tag 'unit' {
    It 'no -Ids keeps every unpopulated candidate (the old behaviour)' {
        @(Select-BackfillTarget -Candidates $script:Cands).id | Should -Be @('sit-484', 'sit-485', 'sit-486', 'sit-487', 'sit-999')
    }

    It '-Ids restricts the pass to exactly the frozen list, in its order' {
        @(Select-BackfillTarget -Candidates $script:Cands -Ids 'sit-487', 'sit-484').id | Should -Be @('sit-487', 'sit-484')
    }

    It 'an -Ids entry that is unknown or already populated is an error, never a silent skip' {
        { Select-BackfillTarget -Candidates $script:Cands -Ids 'sit-484', 'sit-123' } | Should -Throw -ExpectedMessage '*sit-123*'
    }

    It '-ExcludeIds drops the id and logs it with the reason' {
        # A plain function (no -WarningVariable): split the warning stream off the output.
        $out = @(Select-BackfillTarget -Candidates $script:Cands -Ids 'sit-484', 'sit-486' -ExcludeIds 'sit-486' -ExcludeReason 'approved for retirement' 3>&1)
        $w = @($out | Where-Object { $_ -is [System.Management.Automation.WarningRecord] })
        $r = @($out | Where-Object { $_ -isnot [System.Management.Automation.WarningRecord] })
        $r.id | Should -Be @('sit-484')
        @($w | Where-Object { "$_" -match 'sit-486' -and "$_" -match 'approved for retirement' }).Count | Should -Be 1
    }

    It '-ExcludeIds without -ExcludeReason is refused' {
        { Select-BackfillTarget -Candidates $script:Cands -ExcludeIds 'sit-486' } | Should -Throw -ExpectedMessage '*ExcludeReason*'
    }
}
