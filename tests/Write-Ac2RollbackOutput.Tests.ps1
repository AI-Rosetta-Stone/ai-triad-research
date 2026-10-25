# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    t/4309 C5 (SO review, e/361#5): Write-Ac2RollbackOutput must never throw on a $null
    RecheckFailed, and must never corrupt GITHUB_OUTPUT on a multi-line RecheckReason.
#>

Describe 'Write-Ac2RollbackOutput (t/4309 C5)' -Tag 'devops' {

    BeforeAll {
        . "$PSScriptRoot/../operations/devops/Write-Ac2RollbackOutput.ps1"
    }

    BeforeEach {
        $script:OutFile = [System.IO.Path]::GetTempFileName()
    }

    AfterEach {
        Remove-Item -Path $script:OutFile -Force -ErrorAction SilentlyContinue
    }

    It 'does NOT throw when RecheckFailed is $null (the unrecoverable-target / catch paths, SO point 1) -- the exact crash a bare .ToString() would cause' {
        $result = [PSCustomObject]@{ TargetUnrecoverable = $true; RolledBack = $false; RecheckFailed = $null; RecheckReason = $null }
        { Write-Ac2RollbackOutput -Result $result -OutputPath $script:OutFile } | Should -Not -Throw
    }

    It 'writes recheck_failed=n/a when RecheckFailed is $null' {
        $result = [PSCustomObject]@{ TargetUnrecoverable = $true; RolledBack = $false; RecheckFailed = $null; RecheckReason = $null }
        Write-Ac2RollbackOutput -Result $result -OutputPath $script:OutFile
        (Get-Content -Raw $script:OutFile) | Should -Match 'recheck_failed=n/a'
    }

    It 'writes recheck_failed=true / false correctly for the non-null arms' {
        $resultTrue = [PSCustomObject]@{ TargetUnrecoverable = $false; RolledBack = $true; RecheckFailed = $true; RecheckReason = 'x' }
        Write-Ac2RollbackOutput -Result $resultTrue -OutputPath $script:OutFile
        (Get-Content -Raw $script:OutFile) | Should -Match 'recheck_failed=true'

        $outFile2 = [System.IO.Path]::GetTempFileName()
        try {
            $resultFalse = [PSCustomObject]@{ TargetUnrecoverable = $false; RolledBack = $true; RecheckFailed = $false; RecheckReason = $null }
            Write-Ac2RollbackOutput -Result $resultFalse -OutputPath $outFile2
            (Get-Content -Raw $outFile2) | Should -Match 'recheck_failed=false'
        } finally {
            Remove-Item -Path $outFile2 -Force -ErrorAction SilentlyContinue
        }
    }

    It 'a multi-line RecheckReason (SO point 2 -- a realistic az exception message) produces THREE well-formed output entries, not a corrupted/injected key' {
        # Deliberately embeds a line that LOOKS like a key=value pair inside the reason text --
        # the real vulnerability this delimiter form exists to close (a bare "key=value" line
        # would let an az error message inject or override a later GITHUB_OUTPUT key).
        $multiline = "az error: something failed`nLine 2 of the az error`ntarget_unrecoverable=INJECTED"
        $result = [PSCustomObject]@{ TargetUnrecoverable = $true; RolledBack = $false; RecheckFailed = $null; RecheckReason = $multiline }
        { Write-Ac2RollbackOutput -Result $result -OutputPath $script:OutFile } | Should -Not -Throw

        # Simulate GITHUB_OUTPUT's own documented parsing: a `key<<DELIM` line opens a block
        # whose literal content (ANY text, including lines that look like other keys) ends only
        # at a bare line exactly equal to DELIM. A naive line-by-line regex scan (not honoring
        # this) is exactly the mistake that would make the embedded "target_unrecoverable="
        # text look like a second, injected key -- which is what this test caught on its first
        # run (a bug in the TEST, not the function: fixed by parsing delimiter-aware here).
        $lines = Get-Content -Path $script:OutFile
        $topLevelKeys = [System.Collections.Generic.List[string]]::new()
        $i = 0
        $openDelim = $null
        while ($i -lt $lines.Count) {
            $line = $lines[$i]
            if ($openDelim) {
                if ($line -eq $openDelim) { $openDelim = $null }
                $i++; continue
            }
            if ($line -match '^([A-Za-z_][A-Za-z0-9_]*)<<(.+)$') {
                $topLevelKeys.Add($Matches[1])
                $openDelim = $Matches[2]
            } elseif ($line -match '^([A-Za-z_][A-Za-z0-9_]*)=') {
                $topLevelKeys.Add($Matches[1])
            }
            $i++
        }
        $openDelim | Should -BeNullOrEmpty -Because 'every opened heredoc block must also close -- an unclosed delimiter means the file is malformed'
        @($topLevelKeys | Where-Object { $_ -eq 'target_unrecoverable' }).Count | Should -Be 1
        @($topLevelKeys | Where-Object { $_ -eq 'recheck_failed' }).Count | Should -Be 1
        @($topLevelKeys | Where-Object { $_ -eq 'recheck_reason' }).Count | Should -Be 1
    }
}
