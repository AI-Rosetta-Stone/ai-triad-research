# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# t/4935: the deploy what-if reports containers[0].env as an unevaluated ARM expression, so it can't see a
# dropped secretRef or a wrong override. These tests cover the pure snapshot/diff core and the shim that the
# deploy workflows call, including that no raw env value ever reaches output, files or annotations.

BeforeAll {
    . (Join-Path $PSScriptRoot '..' 'operations' 'devops' 'azure' 'ContainerEnvSnapshotVerdict.ps1')
    $script:Shim = Join-Path $PSScriptRoot '..' 'operations' 'devops' 'azure' 'Invoke-ContainerEnvSnapshot.ps1'
    $script:Now = [datetime]::new(2026, 11, 9, 12, 0, 0, [System.DateTimeKind]::Utc)
    $script:Key = [byte[]](1..32)

    function New-Env([hashtable[]] $Entries) {
        @($Entries | ForEach-Object { [pscustomobject]$_ })
    }
    function Snap($EnvVars) { @(ConvertTo-ContainerEnvSnapshot -EnvVars $EnvVars -HashKey $script:Key) }

    $script:Base = New-Env @(
        @{ name = 'NODE_ENV'; value = 'production' }
        @{ name = 'GITHUB_REPO'; value = 'AI-Rosetta-Stone/ai-triad-data' }
        @{ name = 'AUTH_DISABLED'; value = '' }
        @{ name = 'FREE_TIER_GEMINI_KEY'; secretRef = 'free-tier-gemini-key' }
        @{ name = 'GEMINI_PAID_KEY'; secretRef = 'gemini-paid-key' }
        @{ name = 'DEPLOY_SHA'; value = 'aaaaaaa' }
    )
}

Describe 'ConvertTo-ContainerEnvSnapshot' {
    It 'keeps name and secretRef, replaces the value with a 64-hex hash, and holds no raw value' {
        $s = Snap $script:Base
        $s.Count | Should -Be 6
        ($s | Where-Object Name -eq 'NODE_ENV').ValueHash | Should -Match '^[0-9a-f]{64}$'
        ($s | Where-Object Name -eq 'FREE_TIER_GEMINI_KEY').SecretRef | Should -Be 'free-tier-gemini-key'
        ($s | Where-Object Name -eq 'FREE_TIER_GEMINI_KEY').ValueHash | Should -BeNullOrEmpty
        ($s | ConvertTo-Json -Depth 5) | Should -Not -Match 'production|ai-triad-data'
    }

    It 'an empty value is hashed, so empty and absent stay distinguishable' {
        $s = Snap $script:Base
        ($s | Where-Object Name -eq 'AUTH_DISABLED').ValueHash | Should -Match '^[0-9a-f]{64}$'
    }

    It 'the keyed hash differs from a plain SHA-256 and from another key (per-run key is unlinkable)' {
        $k1 = Get-ContainerEnvValueHash -Value 'true' -HashKey $script:Key
        $plain = Get-ContainerEnvValueHash -Value 'true'
        $k2 = Get-ContainerEnvValueHash -Value 'true' -HashKey ([byte[]](2..33))
        $plain | Should -Be 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b'
        $k1 | Should -Not -Be $plain
        $k1 | Should -Not -Be $k2
    }

    It 'a duplicate name throws an actionable error naming the var, not its value' {
        $dup = New-Env @(@{ name = 'X'; value = 'secret-one' }, @{ name = 'X'; value = 'secret-two' })
        { Snap $dup } | Should -Throw -ExpectedMessage '*more than one entry named ''X''*'
        try { Snap $dup } catch { $_.Exception.Message | Should -Not -Match 'secret-one|secret-two' }
    }
}

Describe 'Get-ContainerEnvDiffVerdict' {
    It 'identical env gives no diff (clean)' {
        $v = Get-ContainerEnvDiffVerdict -Before (Snap $script:Base) -After (Snap $script:Base) -Now $script:Now
        $v.Status | Should -Be 'clean'
        @($v.Differences).Count | Should -Be 0
    }

    It 'FIRE ARM: a removed secretRef shows as removed and undeclared (drift)' {
        $after = @($script:Base | Where-Object name -ne 'GEMINI_PAID_KEY')
        $v = Get-ContainerEnvDiffVerdict -Before (Snap $script:Base) -After (Snap $after) -Now $script:Now
        $v.Status | Should -Be 'drift'
        @($v.Undeclared).Count | Should -Be 1
        $v.Undeclared[0].Name | Should -Be 'GEMINI_PAID_KEY'
        $v.Undeclared[0].Change | Should -Be 'removed'
        $v.Undeclared[0].BeforeSecretRef | Should -Be 'gemini-paid-key'
    }

    It 'FIRE ARM: a changed value shows as changed, carrying hashes only' {
        $after = @(New-Env @(@{ name = 'GITHUB_REPO'; value = 'AI-Rosetta-Stone/ai-triad-data-staging' })) +
            @($script:Base | Where-Object name -ne 'GITHUB_REPO')
        $v = Get-ContainerEnvDiffVerdict -Before (Snap $script:Base) -After (Snap $after) -Now $script:Now
        $v.Status | Should -Be 'drift'
        $d = $v.Undeclared[0]
        $d.Name | Should -Be 'GITHUB_REPO'
        $d.Change | Should -Be 'changed'
        $d.Detail | Should -Be 'value'
        $d.BeforeHash | Should -Match '^[0-9a-f]{64}$'
        $d.AfterHash | Should -Match '^[0-9a-f]{64}$'
        $d.BeforeHash | Should -Not -Be $d.AfterHash
    }

    It 'a secretRef swapped for a plain value is a source change (the t/4935 wrong-override shape)' {
        $after = @(New-Env @(@{ name = 'GEMINI_PAID_KEY'; value = '' })) + @($script:Base | Where-Object name -ne 'GEMINI_PAID_KEY')
        $v = Get-ContainerEnvDiffVerdict -Before (Snap $script:Base) -After (Snap $after) -Now $script:Now
        $v.Undeclared[0].Change | Should -Be 'changed'
        $v.Undeclared[0].Detail | Should -Be 'source'
    }

    It 'an added var is reported as added' {
        $after = @($script:Base) + (New-Env @(@{ name = 'NEW_FLAG'; value = '1' }))
        $v = Get-ContainerEnvDiffVerdict -Before (Snap $script:Base) -After (Snap $after) -Now $script:Now
        $v.Undeclared[0].Name | Should -Be 'NEW_FLAG'
        $v.Undeclared[0].Change | Should -Be 'added'
    }

    It 'PASS ARM: a change declared in the allowlist is allowed (declared, not drift)' {
        $after = @($script:Base | Where-Object name -ne 'GEMINI_PAID_KEY')
        $cfg = [pscustomobject]@{ expectedChanges = @([pscustomobject]@{ name = 'GEMINI_PAID_KEY'; change = 'removed'; ticket = 't/9999'; reason = 'retire paid key'; expires = '2026-12-01' }) }
        $v = Get-ContainerEnvDiffVerdict -Before (Snap $script:Base) -After (Snap $after) -ExpectedChanges $cfg -Now $script:Now
        $v.Status | Should -Be 'declared'
        $v.Differences[0].Declared | Should -BeTrue
        $v.Differences[0].DeclaredBy | Should -Match 't/9999'
    }

    It 'a declaration of the wrong kind does not allow the change (declared changed != removed)' {
        $after = @($script:Base | Where-Object name -ne 'GEMINI_PAID_KEY')
        $cfg = [pscustomobject]@{ expectedChanges = @([pscustomobject]@{ name = 'GEMINI_PAID_KEY'; change = 'changed'; ticket = 't/9999'; expires = '2026-12-01' }) }
        $v = Get-ContainerEnvDiffVerdict -Before (Snap $script:Base) -After (Snap $after) -ExpectedChanges $cfg -Now $script:Now
        $v.Status | Should -Be 'drift'
    }

    It 'an expired declaration allows nothing and is reported' {
        $after = @($script:Base | Where-Object name -ne 'GEMINI_PAID_KEY')
        $cfg = [pscustomobject]@{ expectedChanges = @([pscustomobject]@{ name = 'GEMINI_PAID_KEY'; change = 'any'; ticket = 't/9999'; expires = '2026-11-08' }) }
        $v = Get-ContainerEnvDiffVerdict -Before (Snap $script:Base) -After (Snap $after) -ExpectedChanges $cfg -Now $script:Now
        $v.Status | Should -Be 'drift'
        $v.ConfigWarnings[0] | Should -Match 'expired on 2026-11-08'
    }

    It 'a declaration expiring today still applies (inclusive UTC day)' {
        $after = @($script:Base | Where-Object name -ne 'GEMINI_PAID_KEY')
        $cfg = [pscustomobject]@{ expectedChanges = @([pscustomobject]@{ name = 'GEMINI_PAID_KEY'; change = 'removed'; ticket = 't/9999'; expires = '2026-11-09' }) }
        (Get-ContainerEnvDiffVerdict -Before (Snap $script:Base) -After (Snap $after) -ExpectedChanges $cfg -Now $script:Now).Status | Should -Be 'declared'
    }

    It 'a malformed declaration (no ticket) allows nothing and is reported' {
        $after = @($script:Base | Where-Object name -ne 'GEMINI_PAID_KEY')
        $cfg = [pscustomobject]@{ expectedChanges = @([pscustomobject]@{ name = 'GEMINI_PAID_KEY'; change = 'removed'; expires = '2026-12-01' }) }
        $v = Get-ContainerEnvDiffVerdict -Before (Snap $script:Base) -After (Snap $after) -ExpectedChanges $cfg -Now $script:Now
        $v.Status | Should -Be 'drift'
        $v.ConfigWarnings[0] | Should -Match 'malformed'
    }

    It 'the per-deploy stamps (DEPLOY_SHA etc.) changing or appearing are built-in declared' {
        $after = @(New-Env @(@{ name = 'DEPLOY_SHA'; value = 'bbbbbbb' }, @{ name = 'IMAGE_DIGEST'; value = 'sha256:x' })) +
            @($script:Base | Where-Object name -ne 'DEPLOY_SHA')
        $v = Get-ContainerEnvDiffVerdict -Before (Snap $script:Base) -After (Snap $after) -Now $script:Now
        $v.Status | Should -Be 'declared'
        @($v.Differences).Count | Should -Be 2
    }

    It 'a per-deploy stamp being REMOVED is not built-in declared' {
        $after = @($script:Base | Where-Object name -ne 'DEPLOY_SHA')
        (Get-ContainerEnvDiffVerdict -Before (Snap $script:Base) -After (Snap $after) -Now $script:Now).Status | Should -Be 'drift'
    }

    It 'a missing or errored snapshot is unreadable, never clean' {
        $v1 = Get-ContainerEnvDiffVerdict -Before $null -After (Snap $script:Base) -Now $script:Now
        $v1.Status | Should -Be 'unreadable'
        $v1.Reason | Should -Match 'before snapshot missing'
        $v2 = Get-ContainerEnvDiffVerdict -Before (Snap $script:Base) -After @() -AfterError 'az exited 1' -Now $script:Now
        $v2.Status | Should -Be 'unreadable'
        $v2.Reason | Should -Match 'az exited 1'
    }

    It 'an empty but readable env on both sides is clean, not unreadable' {
        (Get-ContainerEnvDiffVerdict -Before @() -After @() -Now $script:Now).Status | Should -Be 'clean'
    }
}

Describe 'Format-ContainerEnvDiffVerdict' {
    It 'an undeclared removal renders a warning with the name and secretRef name' {
        $after = @($script:Base | Where-Object name -ne 'GEMINI_PAID_KEY')
        $v = Get-ContainerEnvDiffVerdict -Before (Snap $script:Base) -After (Snap $after) -Now $script:Now
        $lines = @(Format-ContainerEnvDiffVerdict -Verdict $v -Label 'prod')
        $warn = @($lines | Where-Object Level -eq 'warning')
        $warn.Count | Should -Be 2
        $warn[0].Message | Should -Match 'UNDECLARED: GEMINI_PAID_KEY removed \(was secretRef gemini-paid-key\)'
        $warn[1].Message | Should -Match 'DRIFT'
    }

    It 'a value change renders 12-hex hash prefixes only' {
        $after = @(New-Env @(@{ name = 'NODE_ENV'; value = 'development' })) + @($script:Base | Where-Object name -ne 'NODE_ENV')
        $v = Get-ContainerEnvDiffVerdict -Before (Snap $script:Base) -After (Snap $after) -Now $script:Now
        $msg = (@(Format-ContainerEnvDiffVerdict -Verdict $v -Label 'prod') | Where-Object Level -eq 'warning')[0].Message
        $msg | Should -Match 'NODE_ENV value changed, hash [0-9a-f]{12} -> [0-9a-f]{12}\.'
        $msg | Should -Not -Match 'production|development'
    }

    It 'clean renders a single notice; unreadable renders a GATE-UNREADABLE warning' {
        $clean = Get-ContainerEnvDiffVerdict -Before (Snap $script:Base) -After (Snap $script:Base) -Now $script:Now
        $c = @(Format-ContainerEnvDiffVerdict -Verdict $clean -Label 'x')
        $c.Count | Should -Be 1
        $c[0].Level | Should -Be 'notice'
        $u = @(Format-ContainerEnvDiffVerdict -Verdict (Get-ContainerEnvDiffVerdict -Before $null -After @() -Now $script:Now) -Label 'x')
        $u[0].Level | Should -Be 'warning'
        $u[0].Message | Should -Match 'GATE-UNREADABLE'
    }
}

Describe 'Invoke-ContainerEnvSnapshot.ps1 (shim, az mocked)' {
    BeforeAll {
        $script:Sentinels = @("SENTINEL-OLD-$([guid]::NewGuid())", "SENTINEL-NEW-$([guid]::NewGuid())", "SENTINEL-CONN-$([guid]::NewGuid())")
        function Set-AzRevisionEnv([object[]] $EnvVars, [int] $Exit = 0, [string] $RawOverride = $null) {
            $global:T4935AzExit = $Exit
            $global:T4935AzOut = if ($null -ne $RawOverride -and $RawOverride -ne '') { $RawOverride } else {
                ConvertTo-Json -Depth 5 -InputObject @([pscustomobject]@{ name = 'taxonomy-editor'; image = 'img'; env = $EnvVars })
            }
        }
        function global:az {
            $global:LASTEXITCODE = $global:T4935AzExit
            if ($global:T4935AzExit -ne 0) { [Console]::Error.WriteLine('ERROR: (ResourceNotFound) revision not found'); return }
            $global:T4935AzOut
        }
    }
    AfterAll {
        # Function:\az, not function:global:az: the latter silently removes nothing, leaking the az shim (t/289).
        Remove-Item -Path Function:\az -ErrorAction SilentlyContinue
        Remove-Variable T4935AzExit, T4935AzOut -Scope Global -ErrorAction SilentlyContinue
    }
    BeforeEach {
        $script:Dir = Join-Path ([System.IO.Path]::GetTempPath()) "t4935-$([guid]::NewGuid())"
        New-Item -ItemType Directory -Path $script:Dir | Out-Null
        $script:KeyFile = Join-Path $script:Dir 'k'
        $script:BeforeFile = Join-Path $script:Dir 'before.json'
        $script:AfterFile = Join-Path $script:Dir 'after.json'
        $script:Allow = Join-Path $script:Dir 'allow.json'
        Set-Content -LiteralPath $script:Allow -Value '{"expectedChanges":[]}'
        $script:SavedSummary = $env:GITHUB_STEP_SUMMARY
        $env:GITHUB_STEP_SUMMARY = Join-Path $script:Dir 'summary.md'
    }
    AfterEach {
        $env:GITHUB_STEP_SUMMARY = $script:SavedSummary
        Remove-Item -LiteralPath $script:Dir -Recurse -Force -ErrorAction SilentlyContinue
    }

    It 'NO-LEAK: a full before/after/diff cycle with a changed value never prints or writes any raw value' {
        $old = New-Env @(
            @{ name = 'GITHUB_REPO'; value = $script:Sentinels[0] }
            @{ name = 'APPLICATIONINSIGHTS_CONNECTION_STRING'; value = $script:Sentinels[2] }
            @{ name = 'GEMINI_PAID_KEY'; secretRef = 'gemini-paid-key' }
        )
        $new = New-Env @(
            @{ name = 'GITHUB_REPO'; value = $script:Sentinels[1] }
            @{ name = 'APPLICATIONINSIGHTS_CONNECTION_STRING'; value = $script:Sentinels[2] }
        )
        Set-AzRevisionEnv $old
        $o1 = & $script:Shim -AppName app -ResourceGroup rg -RevisionName rev-old -OutFile $script:BeforeFile -KeyFile $script:KeyFile *>&1 | Out-String
        Set-AzRevisionEnv $new
        $o2 = & $script:Shim -AppName app -ResourceGroup rg -RevisionName rev-new -OutFile $script:AfterFile -KeyFile $script:KeyFile *>&1 | Out-String
        $o3 = & $script:Shim -Diff -BeforeFile $script:BeforeFile -AfterFile $script:AfterFile -ExpectedChangesFile $script:Allow -Label prod *>&1 | Out-String
        $LASTEXITCODE | Should -Be 0

        # The diff did run and saw both findings, so the no-leak assertion below is not vacuous.
        $o3 | Should -Match '::warning::.*UNDECLARED: GITHUB_REPO value changed, hash [0-9a-f]{12} -> [0-9a-f]{12}'
        $o3 | Should -Match '::warning::.*UNDECLARED: GEMINI_PAID_KEY removed \(was secretRef gemini-paid-key\)'

        $everything = $o1 + $o2 + $o3 + (Get-Content -Raw $script:BeforeFile) + (Get-Content -Raw $script:AfterFile) +
            (Get-Content -Raw $env:GITHUB_STEP_SUMMARY) + (Get-Content -Raw $script:KeyFile)
        foreach ($s in $script:Sentinels) { $everything | Should -Not -Match ([regex]::Escape($s)) }
        # Also no prefix of a sentinel (guards against a truncated value slipping into a message).
        $everything | Should -Not -Match 'SENTINEL-'
    }

    It 'NO-LEAK: an az response that is not valid JSON fails with fixed text, not the parser message' {
        # Unparseable on purpose (PS7's ConvertFrom-Json tolerates a merely truncated array). The parser's own
        # message can quote input; the shim must replace it with fixed text.
        Set-AzRevisionEnv @() -RawOverride "ERROR $($script:Sentinels[0]) {""name"":""X"",""value"":""$($script:Sentinels[0])""}"
        $o = & $script:Shim -AppName app -ResourceGroup rg -RevisionName r -OutFile $script:BeforeFile -KeyFile $script:KeyFile *>&1 | Out-String
        $o | Should -Match '::warning::.*not valid JSON \(details withheld'
        ($o + (Get-Content -Raw $script:BeforeFile)) | Should -Not -Match 'SENTINEL-'
    }

    It 'identical env through the shim is a PASS notice and no warning' {
        Set-AzRevisionEnv (New-Env @(@{ name = 'A'; value = $script:Sentinels[0] }))
        & $script:Shim -AppName app -ResourceGroup rg -RevisionName r1 -OutFile $script:BeforeFile -KeyFile $script:KeyFile *>&1 | Out-Null
        & $script:Shim -AppName app -ResourceGroup rg -RevisionName r2 -OutFile $script:AfterFile -KeyFile $script:KeyFile *>&1 | Out-Null
        $o = & $script:Shim -Diff -BeforeFile $script:BeforeFile -AfterFile $script:AfterFile -ExpectedChangesFile $script:Allow *>&1 | Out-String
        $o | Should -Match '::notice::.*PASS'
        $o | Should -Not -Match '::warning::'
    }

    It 'an az failure is a WARN fallback, the diff reports GATE-UNREADABLE, and the shim still exits 0' {
        Set-AzRevisionEnv @() -Exit 3
        $o1 = & $script:Shim -AppName app -ResourceGroup rg -RevisionName r -OutFile $script:BeforeFile -KeyFile $script:KeyFile *>&1 | Out-String
        $LASTEXITCODE | Should -Be 0
        $o1 | Should -Match '::warning::.*WARN fallback.*exited 3'
        Set-AzRevisionEnv (New-Env @(@{ name = 'A'; value = 'x' }))
        & $script:Shim -AppName app -ResourceGroup rg -RevisionName r2 -OutFile $script:AfterFile -KeyFile $script:KeyFile *>&1 | Out-Null
        $o = & $script:Shim -Diff -BeforeFile $script:BeforeFile -AfterFile $script:AfterFile -ExpectedChangesFile $script:Allow *>&1 | Out-String
        $LASTEXITCODE | Should -Be 0
        $o | Should -Match '::warning::.*GATE-UNREADABLE.*exited 3'
    }

    It 'an empty revision name (no serving revision) is a WARN fallback, not a crash' {
        $o = & $script:Shim -AppName app -ResourceGroup rg -RevisionName '' -OutFile $script:BeforeFile -KeyFile $script:KeyFile *>&1 | Out-String
        $LASTEXITCODE | Should -Be 0
        $o | Should -Match '::warning::.*no revision name'
    }

    It 'a missing snapshot file makes the diff GATE-UNREADABLE and exit 0' {
        $o = & $script:Shim -Diff -BeforeFile (Join-Path $script:Dir 'nope.json') -AfterFile (Join-Path $script:Dir 'nope2.json') -ExpectedChangesFile $script:Allow *>&1 | Out-String
        $LASTEXITCODE | Should -Be 0
        $o | Should -Match '::warning::.*GATE-UNREADABLE.*no snapshot file'
    }

    It 'the checked-in allowlist file parses and has no malformed entries' {
        # Expiry is deliberately NOT checked here (an expiring entry must not red unrelated PRs); the
        # deploy-time diff reports expired entries as a WARN instead.
        $real = Join-Path $PSScriptRoot '..' 'operations' 'devops' 'azure' 'container-env-expected-changes.json'
        $cfg = Get-Content -Raw $real | ConvertFrom-Json
        $r = Get-ContainerEnvExpectedChange -Config $cfg -Now ([datetime]::new(2000, 1, 1, 0, 0, 0, [System.DateTimeKind]::Utc))
        @($r.Warnings) | Should -BeNullOrEmpty
    }
}
