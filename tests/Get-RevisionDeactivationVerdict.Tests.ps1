# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# t/4242: staging deactivated the revision traffic was pinned to (weight=100), serving 404 on
# every path. Both arms of "skip weight > 0" proven here, plus the SO review conditions (p/682#33,
# PR #3367): C1 (ingress traffic config + latestRevision must independently agree), C3 (unknown
# weight is never read as 0).

BeforeAll {
    . (Join-Path $PSScriptRoot '..' 'operations' 'devops' 'Get-RevisionDeactivationVerdict.ps1')
}

Describe 'Get-RevisionDeactivationVerdict' {
    It 'FIRE ARM: revision-show weight > 0 (the t/4242 incident shape) -> skip, even with no other protection' {
        $v = Get-RevisionDeactivationVerdict -RevisionName 'taxonomy-editor-staging--0000220' `
            -TrafficWeight 100 -IngressWeight 100
        $v.Action | Should -Be 'skip'
        $v.Reason | Should -Be 'nonzero-traffic-weight'
    }

    It 'weight = 0 on BOTH sources, Active, not serving, not protected, not latest-with-traffic -> deactivate' {
        $v = Get-RevisionDeactivationVerdict -RevisionName 'taxonomy-editor-staging--0000219' `
            -TrafficWeight 0 -IngressWeight 0 -Active $true
        $v.Action | Should -Be 'deactivate'
        $v.Reason | Should -Be 'stale-zero-weight-unprotected'
    }

    It 'SO C1 FIRE ARM: revision-show reports 0 but the ingress traffic config still lists it at 100 -> skip (the derived field the re-check originally trusted can itself lag the routing source)' {
        $v = Get-RevisionDeactivationVerdict -RevisionName 'taxonomy-editor-staging--0000220' `
            -TrafficWeight 0 -IngressWeight 100
        $v.Action | Should -Be 'skip'
        $v.Reason | Should -Be 'nonzero-ingress-weight'
    }

    It 'SO C1 FIRE ARM: the candidate IS the latestRevision traffic target (no revisionName entry to match by name at all) -> skip' {
        $v = Get-RevisionDeactivationVerdict -RevisionName 'taxonomy-editor-staging--f5e1689' `
            -TrafficWeight 0 -IngressWeight 0 -IsLatestRevisionWithTraffic $true
        $v.Action | Should -Be 'skip'
        $v.Reason | Should -Be 'latest-revision-with-traffic'
    }

    It 'SO C3 FIRE ARM: revision-show trafficWeight is null/unknown -> skip, NEVER read as 0' {
        $v = Get-RevisionDeactivationVerdict -RevisionName 'taxonomy-editor-staging--0000219' `
            -TrafficWeight $null -IngressWeight 0
        $v.Action | Should -Be 'skip'
        $v.Reason | Should -Be 'unknown-traffic-weight'
    }

    It 'SO C3 FIRE ARM: the ingress traffic config query itself failed (null, not an empty array) -> skip' {
        $v = Get-RevisionDeactivationVerdict -RevisionName 'taxonomy-editor-staging--0000219' `
            -TrafficWeight 0 -IngressWeight $null
        $v.Action | Should -Be 'skip'
        $v.Reason | Should -Be 'unknown-ingress-weight'
    }

    It 'weight = 0 on both sources but not Active -> skip (already-inactive, nothing to do)' {
        $v = Get-RevisionDeactivationVerdict -RevisionName 'taxonomy-editor-staging--0000218' `
            -TrafficWeight 0 -IngressWeight 0 -Active $false
        $v.Action | Should -Be 'skip'
        $v.Reason | Should -Be 'already-inactive'
    }

    It 'weight = 0 on both sources, Active, but IS the serving revision by name -> skip (defense in depth)' {
        $v = Get-RevisionDeactivationVerdict -RevisionName 'taxonomy-editor-staging--f5e1689' `
            -TrafficWeight 0 -IngressWeight 0 -ServingRevisionName 'taxonomy-editor-staging--f5e1689'
        $v.Action | Should -Be 'skip'
        $v.Reason | Should -Be 'is-serving-revision'
    }

    It 'weight = 0 on both sources, Active, not serving, but explicitly in -ProtectedNames -> skip' {
        $v = Get-RevisionDeactivationVerdict -RevisionName 'taxonomy-editor-staging--0000220' `
            -TrafficWeight 0 -IngressWeight 0 -ProtectedNames @('taxonomy-editor-staging--0000220')
        $v.Action | Should -Be 'skip'
        $v.Reason | Should -Be 'explicitly-protected'
    }

    It 'a protected name that does not match this candidate does not spuriously skip it' {
        $v = Get-RevisionDeactivationVerdict -RevisionName 'taxonomy-editor-staging--0000219' `
            -TrafficWeight 0 -IngressWeight 0 -ProtectedNames @('taxonomy-editor-staging--0000220')
        $v.Action | Should -Be 'deactivate'
    }
}

Describe 'Get-IngressTrafficWeightForRevision' {
    It 'a named entry with weight 100 -> IngressWeight 100, not latest-with-traffic' {
        $entries = @(
            [PSCustomObject]@{ revisionName = 'rev-a'; weight = 100; latestRevision = $false }
        )
        $r = Get-IngressTrafficWeightForRevision -RevisionName 'rev-a' -TrafficEntries $entries -LatestRevisionName 'rev-a'
        $r.IngressWeight | Should -Be 100
        $r.IsLatestRevisionWithTraffic | Should -Be $false
    }

    It 'no entry names this revision at all -> IngressWeight 0 (a validly-queried empty result is known-zero)' {
        $entries = @(
            [PSCustomObject]@{ revisionName = 'rev-other'; weight = 100; latestRevision = $false }
        )
        $r = Get-IngressTrafficWeightForRevision -RevisionName 'rev-a' -TrafficEntries $entries -LatestRevisionName 'rev-other'
        $r.IngressWeight | Should -Be 0
        $r.IsLatestRevisionWithTraffic | Should -Be $false
    }

    It '$null TrafficEntries (the query itself failed) -> IngressWeight $null, not 0' {
        $r = Get-IngressTrafficWeightForRevision -RevisionName 'rev-a' -TrafficEntries $null -LatestRevisionName 'rev-a'
        $r.IngressWeight | Should -Be $null
        $r.IsLatestRevisionWithTraffic | Should -Be $false
    }

    It 'an empty array (validly queried, zero entries) -> IngressWeight 0, not $null' {
        $r = Get-IngressTrafficWeightForRevision -RevisionName 'rev-a' -TrafficEntries @() -LatestRevisionName 'rev-a'
        $r.IngressWeight | Should -Be 0
    }

    It 'a latestRevision:true entry with weight 100 and NO revisionName, targeting this candidate via LatestRevisionName -> IsLatestRevisionWithTraffic true even though IngressWeight (by name) is 0' {
        $entries = @(
            [PSCustomObject]@{ weight = 100; latestRevision = $true }
        )
        $r = Get-IngressTrafficWeightForRevision -RevisionName 'rev-newest' -TrafficEntries $entries -LatestRevisionName 'rev-newest'
        $r.IngressWeight | Should -Be 0
        $r.IsLatestRevisionWithTraffic | Should -Be $true
    }

    It 'a latestRevision:true entry with weight 100, but THIS candidate is NOT the latest revision -> IsLatestRevisionWithTraffic false (the traffic targets a different revision)' {
        $entries = @(
            [PSCustomObject]@{ weight = 100; latestRevision = $true }
        )
        $r = Get-IngressTrafficWeightForRevision -RevisionName 'rev-old' -TrafficEntries $entries -LatestRevisionName 'rev-newest'
        $r.IsLatestRevisionWithTraffic | Should -Be $false
    }

    It 'SO C1b FIRE ARM: a latestRevision:true entry WITH traffic, but LatestRevisionName is unknown (null/blank) -> IsLatestRevisionWithTraffic TRUE (conservatively protect — cannot rule out this candidate is the target)' {
        $entries = @(
            [PSCustomObject]@{ weight = 100; latestRevision = $true }
        )
        $r = Get-IngressTrafficWeightForRevision -RevisionName 'rev-either' -TrafficEntries $entries -LatestRevisionName $null
        $r.IsLatestRevisionWithTraffic | Should -Be $true
    }

    It 'a latestRevision:true entry with weight 0 -> IsLatestRevisionWithTraffic false (no traffic to carry)' {
        $entries = @(
            [PSCustomObject]@{ weight = 0; latestRevision = $true }
        )
        $r = Get-IngressTrafficWeightForRevision -RevisionName 'rev-newest' -TrafficEntries $entries -LatestRevisionName 'rev-newest'
        $r.IsLatestRevisionWithTraffic | Should -Be $false
    }
}
