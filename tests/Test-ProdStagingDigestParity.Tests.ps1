# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# t/4194 prevention item 3: both arms of the pure digest-parity predicate (no Azure calls).

BeforeAll {
    . (Join-Path $PSScriptRoot '..' 'operations' 'devops' 'Test-ProdStagingDigestParity.ps1')
}

Describe 'Get-DigestParityVerdict' {
    It 'FIRE ARM: different digests -> Match=false, Determinable=true' {
        $v = Get-DigestParityVerdict -ProdImage 'ghcr.io/ai-rosetta-stone/taxonomy-editor@sha256:16286620' -StagingImage 'ghcr.io/jpsnover/taxonomy-editor@sha256:3a29f431'
        $v.Match | Should -Be $false
        $v.Determinable | Should -Be $true
        $v.Message | Should -Match 'DIFFERENT images'
    }

    It 'PASS ARM: same digest -> Match=true' {
        $same = 'ghcr.io/ai-rosetta-stone/taxonomy-editor@sha256:16286620'
        $v = Get-DigestParityVerdict -ProdImage $same -StagingImage $same
        $v.Match | Should -Be $true
        $v.Determinable | Should -Be $true
    }

    It 'an empty prod image is UNDETERMINABLE, not a false match or a false mismatch' {
        $v = Get-DigestParityVerdict -ProdImage '' -StagingImage 'ghcr.io/ai-rosetta-stone/taxonomy-editor@sha256:16286620'
        $v.Determinable | Should -Be $false
        $v.Match | Should -Be $false
    }

    It 'an empty staging image is UNDETERMINABLE' {
        $v = Get-DigestParityVerdict -ProdImage 'ghcr.io/ai-rosetta-stone/taxonomy-editor@sha256:16286620' -StagingImage ''
        $v.Determinable | Should -Be $false
    }

    It 'both empty is UNDETERMINABLE' {
        $v = Get-DigestParityVerdict -ProdImage '' -StagingImage ''
        $v.Determinable | Should -Be $false
    }

    It 'an UNKNOWN verdict carries the resolver reason in its message' {
        $v = Get-DigestParityVerdict -ProdImage 'img@sha256:aaa' -StagingImage '' -StagingReason 'traffic is split'
        $v.Determinable | Should -Be $false
        $v.Message | Should -Match 'staging: traffic is split'
    }
}

# t/4399: parity must compare the revisions each app SERVES, never the app template.
Describe 'Get-ServingImage' {
    BeforeAll {
        $X = 'ghcr.io/ai-rosetta-stone/taxonomy-editor@sha256:5b0aa967'
        $Y = 'ghcr.io/ai-rosetta-stone/taxonomy-editor@sha256:f6649470'
        function New-Traffic([string]$Rev, [int]$Weight, [switch]$Latest) {
            if ($Latest) { [PSCustomObject]@{ latestRevision = $true; weight = $Weight } }
            else { [PSCustomObject]@{ revisionName = $Rev; weight = $Weight } }
        }
    }

    It 'resolves the single weighted revision to its image' {
        $s = Get-ServingImage -Traffic @((New-Traffic 'app--a' 100), (New-Traffic 'app--b' 0)) -RevisionImages @{ 'app--a' = $X; 'app--b' = $Y }
        $s.Image | Should -Be $X
        $s.Revisions | Should -Be @('app--a=100%')
    }

    It 'resolves latestRevision:true through latestRevisionName' {
        $s = Get-ServingImage -Traffic @(New-Traffic -Latest -Weight 100) -LatestRevisionName 'app--new' -RevisionImages @{ 'app--new' = $Y }
        $s.Image | Should -Be $Y
    }

    It 'a split across DIFFERENT images is UNKNOWN, with a split reason' {
        $s = Get-ServingImage -Traffic @((New-Traffic 'app--a' 50), (New-Traffic 'app--b' 50)) -RevisionImages @{ 'app--a' = $X; 'app--b' = $Y }
        $s.Image | Should -BeNullOrEmpty
        $s.Reason | Should -Match 'split'
    }

    It 'a split across revisions on the SAME image resolves to that image' {
        $s = Get-ServingImage -Traffic @((New-Traffic 'app--a' 50), (New-Traffic 'app--b' 50)) -RevisionImages @{ 'app--a' = $X; 'app--b' = $X }
        $s.Image | Should -Be $X
    }

    It 'no weighted traffic is UNKNOWN' {
        $s = Get-ServingImage -Traffic @(New-Traffic 'app--a' 0) -RevisionImages @{ 'app--a' = $X }
        $s.Image | Should -BeNullOrEmpty
        $s.Reason | Should -Match 'weight > 0'
    }

    It 'null/empty traffic is UNKNOWN, not a throw' {
        (Get-ServingImage -Traffic @($null) -RevisionImages @{}).Image | Should -BeNullOrEmpty
        (Get-ServingImage -Traffic @() -RevisionImages @{}).Image | Should -BeNullOrEmpty
    }

    It 'a serving revision with no resolvable image is UNKNOWN' {
        $s = Get-ServingImage -Traffic @(New-Traffic 'app--a' 100) -RevisionImages @{}
        $s.Image | Should -BeNullOrEmpty
        $s.Reason | Should -Match 'app--a'
    }

    It 'REGRESSION (10-21 run 39621165861): templates both name X, but staging traffic is pinned to a Y revision -> MISMATCH' {
        # After a prod Bicep apply, prod's image X is in BOTH templates and a new staging revision on X
        # exists at 0%; staging traffic stays pinned to its previous revision on Y. The old template
        # read said PARITY-OK here.
        $prod = Get-ServingImage -Traffic @(New-Traffic 'taxonomy-editor--deploy-6789ee9' 100) -RevisionImages @{ 'taxonomy-editor--deploy-6789ee9' = $X }
        $staging = Get-ServingImage -Traffic @((New-Traffic 'taxonomy-editor-staging--staging-deac973' 100), (New-Traffic 'taxonomy-editor-staging--0000253' 0)) `
            -RevisionImages @{ 'taxonomy-editor-staging--staging-deac973' = $Y; 'taxonomy-editor-staging--0000253' = $X }
        $v = Get-DigestParityVerdict -ProdImage $prod.Image -StagingImage $staging.Image `
            -ProdRevisions ($prod.Revisions -join ', ') -StagingRevisions ($staging.Revisions -join ', ')
        $v.Determinable | Should -Be $true
        $v.Match | Should -Be $false
        $v.Message | Should -Match 'staging-deac973=100%'
    }
}

# t/4496 worked example: the three-state gate verdict, end to end through Test-ProdStagingDigestParity
# with only the az boundary (Invoke-AzCapture) mocked. Asserts what lands in the step outputs and the
# step summary, which is what a workflow (and a promotion reviewer) actually reads.
Describe 'Test-ProdStagingDigestParity gate verdict (t/4496)' {
    BeforeAll {
        $script:X = 'ghcr.io/ai-rosetta-stone/taxonomy-editor@sha256:5b0aa967'
        $script:Y = 'ghcr.io/ai-rosetta-stone/taxonomy-editor@sha256:f6649470'
        # A real az 403 shape (Reader role missing on the container app).
        $script:Az403 = "ERROR: (AuthorizationFailed) The client 'a1b2' with object id 'a1b2' does not have authorization to perform action 'Microsoft.App/containerApps/read' over scope '/subscriptions/0000/resourceGroups/ai-triad/providers/Microsoft.App/containerApps/taxonomy-editor-staging' or the scope is invalid.`nCode: AuthorizationFailed"

        # Fixture table: "<app>|show" or "<app>|rev|<revision>" -> az result.
        function New-AzOk([string]$Stdout) { [PSCustomObject]@{ ExitCode = 0; Stdout = $Stdout; Stderr = '' } }
        function New-AzShow([string]$Rev) {
            New-AzOk (@{ traffic = @(@{ revisionName = $Rev; weight = 100 }); latest = $Rev } | ConvertTo-Json -Depth 5)
        }
        function Set-AzFixtures([string]$StagingImage, [switch]$Staging403) {
            $script:AzFixtures = @{
                'taxonomy-editor|show'                         = (New-AzShow 'taxonomy-editor--a')
                'taxonomy-editor|rev|taxonomy-editor--a'       = (New-AzOk $script:X)
                'taxonomy-editor-staging|show'                 = (New-AzShow 'taxonomy-editor-staging--b')
                'taxonomy-editor-staging|rev|taxonomy-editor-staging--b' = (New-AzOk $StagingImage)
            }
            if ($Staging403) {
                $script:AzFixtures['taxonomy-editor-staging|show'] = [PSCustomObject]@{ ExitCode = 1; Stdout = ''; Stderr = $script:Az403 }
            }
        }
        function Invoke-Gate {
            Test-ProdStagingDigestParity -ProdApp 'taxonomy-editor' -StagingApp 'taxonomy-editor-staging' `
                -ResourceGroup 'ai-triad' -SuppressAnnotations
        }
    }

    BeforeEach {
        # Never write into the real CI step output / summary: point both at temp files.
        $script:SavedOutput = $env:GITHUB_OUTPUT
        $script:SavedSummary = $env:GITHUB_STEP_SUMMARY
        $env:GITHUB_OUTPUT = Join-Path $TestDrive 'output.txt'
        $env:GITHUB_STEP_SUMMARY = Join-Path $TestDrive 'summary.md'
        Remove-Item $env:GITHUB_OUTPUT, $env:GITHUB_STEP_SUMMARY -ErrorAction SilentlyContinue

        Mock Invoke-AzCapture {
            $app = $AzArgs[[array]::IndexOf($AzArgs, '-n') + 1]
            $key = if ($AzArgs[1] -eq 'revision') { "$app|rev|$($AzArgs[[array]::IndexOf($AzArgs, '--revision') + 1])" } else { "$app|show" }
            if (-not $script:AzFixtures.ContainsKey($key)) { throw "no az fixture for '$key'" }
            $script:AzFixtures[$key]
        }
    }

    AfterEach {
        $env:GITHUB_OUTPUT = $script:SavedOutput
        $env:GITHUB_STEP_SUMMARY = $script:SavedSummary
    }

    It 'PASS: a readable clean target (same serving digest) -> verdict=PASS in outputs and summary' {
        Set-AzFixtures -StagingImage $script:X
        $v = Invoke-Gate
        $v.GateVerdict | Should -Be 'PASS'
        $v.Match | Should -Be $true
        $out = Get-Content $env:GITHUB_OUTPUT
        $out | Should -Contain 'verdict=PASS'
        $out | Should -Contain 'gate=prod-staging-digest-parity'
        Get-Content $env:GITHUB_STEP_SUMMARY -Raw | Should -Match '\*\*PASS\*\*'
    }

    It 'FAIL: a readable bad target (different serving digests) -> verdict=FAIL, not PASS or UNREADABLE' {
        Set-AzFixtures -StagingImage $script:Y
        $v = Invoke-Gate
        $v.GateVerdict | Should -Be 'FAIL'
        $v.Determinable | Should -Be $true
        $out = Get-Content $env:GITHUB_OUTPUT
        $out | Should -Contain 'verdict=FAIL'
        ($out | Where-Object { $_ -like 'reason=*' }) | Should -Match 'DIFFERENT images'
    }

    It 'GATE-UNREADABLE: a simulated 403 on the staging read -> verdict=GATE-UNREADABLE with a 403 reason, never PASS' {
        Set-AzFixtures -StagingImage $script:X -Staging403
        $v = Invoke-Gate
        $v.GateVerdict | Should -Be 'GATE-UNREADABLE'
        $out = Get-Content $env:GITHUB_OUTPUT
        $out | Should -Contain 'verdict=GATE-UNREADABLE'
        $out | Should -Not -Contain 'verdict=PASS'
        $reason = ($out | Where-Object { $_ -like 'reason=*' })
        $reason | Should -Match 'access denied \(403\)'
        $reason | Should -Match 'AuthorizationFailed'
        @($out | Where-Object { $_ -like 'reason=*' }).Count | Should -Be 1   # multi-line stderr stayed one line
        Get-Content $env:GITHUB_STEP_SUMMARY -Raw | Should -Match 'could NOT read the target'
    }

    It 'GATE-UNREADABLE: a 403 on the serving REVISION read carries the classified reason too' {
        Set-AzFixtures -StagingImage $script:X
        $script:AzFixtures['taxonomy-editor-staging|rev|taxonomy-editor-staging--b'] = [PSCustomObject]@{ ExitCode = 1; Stdout = ''; Stderr = $script:Az403 }
        $v = Invoke-Gate
        $v.GateVerdict | Should -Be 'GATE-UNREADABLE'
        (Get-Content $env:GITHUB_OUTPUT | Where-Object { $_ -like 'reason=*' }) | Should -Match "revision show 'taxonomy-editor-staging--b' failed \(exit 1\): access denied \(403\)"
    }
}

Describe 'ConvertTo-DigestParityGateVerdict (t/4496)' {
    It 'maps match -> PASS, mismatch -> FAIL, undeterminable -> GATE-UNREADABLE' {
        (ConvertTo-DigestParityGateVerdict (Get-DigestParityVerdict -ProdImage 'a' -StagingImage 'a')).Verdict | Should -Be 'PASS'
        (ConvertTo-DigestParityGateVerdict (Get-DigestParityVerdict -ProdImage 'a' -StagingImage 'b')).Verdict | Should -Be 'FAIL'
        (ConvertTo-DigestParityGateVerdict (Get-DigestParityVerdict -ProdImage 'a' -StagingImage '')).Verdict | Should -Be 'GATE-UNREADABLE'
    }
}
