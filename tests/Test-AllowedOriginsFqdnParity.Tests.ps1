# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# t/4407: both arms of the pure ALLOWED_ORIGINS-vs-FQDN predicates (no Azure calls).

BeforeAll {
    . (Join-Path $PSScriptRoot '..' 'operations' 'devops' 'Test-AllowedOriginsFqdnParity.ps1')
}

Describe 'Get-OriginsFqdnVerdict' {
    It 'PASS ARM (match): the origin names the app''s own FQDN' {
        $v = Get-OriginsFqdnVerdict -App 'taxonomy-editor' -OriginsValue 'https://taxonomy-editor.yellowbush-aeda037d.eastus.azurecontainerapps.io' -Fqdn 'taxonomy-editor.yellowbush-aeda037d.eastus.azurecontainerapps.io'
        $v.Match | Should -Be $true
        $v.Determinable | Should -Be $true
    }

    It 'match is case-insensitive on the host' {
        $v = Get-OriginsFqdnVerdict -App 'taxonomy-editor' -OriginsValue 'https://TAXONOMY-EDITOR.yellowbush-aeda037d.eastus.azurecontainerapps.io' -Fqdn 'taxonomy-editor.yellowbush-aeda037d.eastus.azurecontainerapps.io'
        $v.Match | Should -Be $true
    }

    # This is the exact live t/4406 shape: staging served prod's origin.
    It 'FIRE ARM (mismatch): staging serving prod''s origin' {
        $v = Get-OriginsFqdnVerdict -App 'taxonomy-editor-staging' -OriginsValue 'https://taxonomy-editor.yellowbush-aeda037d.eastus.azurecontainerapps.io' -Fqdn 'taxonomy-editor-staging.yellowbush-aeda037d.eastus.azurecontainerapps.io'
        $v.Match | Should -Be $false
        $v.Determinable | Should -Be $true
        $v.Message | Should -Match 'does NOT match'
    }

    It 'FIRE ARM (missing env): an empty origins value is UNDETERMINABLE, not a false match' {
        $v = Get-OriginsFqdnVerdict -App 'taxonomy-editor' -OriginsValue '' -Fqdn 'taxonomy-editor.yellowbush-aeda037d.eastus.azurecontainerapps.io' -Reason "serving revision 'app--a' has no ALLOWED_ORIGINS set"
        $v.Determinable | Should -Be $false
        $v.Match | Should -Be $false
        $v.Message | Should -Match 'no ALLOWED_ORIGINS set'
    }

    It 'an empty FQDN is UNDETERMINABLE' {
        $v = Get-OriginsFqdnVerdict -App 'taxonomy-editor' -OriginsValue 'https://taxonomy-editor.yellowbush-aeda037d.eastus.azurecontainerapps.io' -Fqdn ''
        $v.Determinable | Should -Be $false
    }

    It 'an unparseable origins value is UNDETERMINABLE, not a crash' {
        $v = Get-OriginsFqdnVerdict -App 'taxonomy-editor' -OriginsValue 'not-a-url' -Fqdn 'taxonomy-editor.yellowbush-aeda037d.eastus.azurecontainerapps.io'
        $v.Determinable | Should -Be $false
        $v.Message | Should -Match 'not a parseable URL'
    }
}

# t/4399's serving-revision pattern, genericized to any per-revision string value.
Describe 'Get-ServingEnvValue' {
    BeforeAll {
        function New-Traffic([string]$Rev, [int]$Weight, [switch]$Latest) {
            if ($Latest) { [PSCustomObject]@{ latestRevision = $true; weight = $Weight } }
            else { [PSCustomObject]@{ revisionName = $Rev; weight = $Weight } }
        }
    }

    It 'resolves the single weighted revision to its value' {
        $r = Get-ServingEnvValue -Traffic @((New-Traffic 'app--a' 100), (New-Traffic 'app--b' 0)) -RevisionValues @{ 'app--a' = 'https://x'; 'app--b' = 'https://y' }
        $r.Value | Should -Be 'https://x'
        $r.Revisions | Should -Contain 'app--a=100%'
    }

    It 'latestRevision:true resolves via LatestRevisionName' {
        $r = Get-ServingEnvValue -Traffic @((New-Traffic -Weight 100 -Latest)) -LatestRevisionName 'app--latest' -RevisionValues @{ 'app--latest' = 'https://x' }
        $r.Value | Should -Be 'https://x'
    }

    # FIRE ARM (split-traffic): different values across weighted revisions -> UNKNOWN, not a guess.
    It 'a split across DIFFERENT values resolves to $null with a reason' {
        $r = Get-ServingEnvValue -Traffic @((New-Traffic 'app--a' 50), (New-Traffic 'app--b' 50)) -RevisionValues @{ 'app--a' = 'https://x'; 'app--b' = 'https://y' }
        $r.Value | Should -BeNullOrEmpty
        $r.Reason | Should -Match 'DIFFERENT'
    }

    It 'a split across the SAME value resolves to that value' {
        $r = Get-ServingEnvValue -Traffic @((New-Traffic 'app--a' 50), (New-Traffic 'app--b' 50)) -RevisionValues @{ 'app--a' = 'https://x'; 'app--b' = 'https://x' }
        $r.Value | Should -Be 'https://x'
    }

    It 'no weighted traffic resolves to $null with a reason' {
        $r = Get-ServingEnvValue -Traffic @((New-Traffic 'app--a' 0)) -RevisionValues @{ 'app--a' = 'https://x' }
        $r.Value | Should -BeNullOrEmpty
        $r.Reason | Should -Match 'no ingress traffic entry has weight'
    }

    It 'a weighted revision with no recorded value resolves to $null, naming the revision' {
        $r = Get-ServingEnvValue -Traffic @((New-Traffic 'app--a' 100)) -RevisionValues @{} -ValueLabel 'ALLOWED_ORIGINS'
        $r.Value | Should -BeNullOrEmpty
        $r.Reason | Should -Match "app--a' has no ALLOWED_ORIGINS set"
    }
}
