# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# t/4242: staging deactivated the revision traffic was pinned to (weight=100), serving 404 on
# every path. Both arms of "skip weight > 0" proven here, plus the other skip reasons.

BeforeAll {
    . (Join-Path $PSScriptRoot '..' 'operations' 'devops' 'Get-RevisionDeactivationVerdict.ps1')
}

Describe 'Get-RevisionDeactivationVerdict' {
    It 'FIRE ARM: weight > 0 (the t/4242 incident shape) -> skip, even with no other protection' {
        $v = Get-RevisionDeactivationVerdict -RevisionName 'taxonomy-editor-staging--0000220' -TrafficWeight 100
        $v.Action | Should -Be 'skip'
        $v.Reason | Should -Be 'nonzero-traffic-weight'
    }

    It 'weight = 0, Active, not serving, not protected -> deactivate' {
        $v = Get-RevisionDeactivationVerdict -RevisionName 'taxonomy-editor-staging--0000219' -TrafficWeight 0 -Active $true
        $v.Action | Should -Be 'deactivate'
        $v.Reason | Should -Be 'stale-zero-weight-unprotected'
    }

    It 'weight > 0 wins over every other field, including a missing/false Active flag' {
        $v = Get-RevisionDeactivationVerdict -RevisionName 'taxonomy-editor-staging--0000220' -TrafficWeight 100 -Active $false
        $v.Action | Should -Be 'skip'
        $v.Reason | Should -Be 'nonzero-traffic-weight'
    }

    It 'weight = 0 but not Active -> skip (already-inactive, nothing to do)' {
        $v = Get-RevisionDeactivationVerdict -RevisionName 'taxonomy-editor-staging--0000218' -TrafficWeight 0 -Active $false
        $v.Action | Should -Be 'skip'
        $v.Reason | Should -Be 'already-inactive'
    }

    It 'weight = 0, Active, but IS the serving revision by name -> skip (defense in depth, independent of the weight read)' {
        $v = Get-RevisionDeactivationVerdict -RevisionName 'taxonomy-editor-staging--f5e1689' -TrafficWeight 0 `
            -ServingRevisionName 'taxonomy-editor-staging--f5e1689'
        $v.Action | Should -Be 'skip'
        $v.Reason | Should -Be 'is-serving-revision'
    }

    It 'weight = 0, Active, not serving, but explicitly in -ProtectedNames -> skip' {
        $v = Get-RevisionDeactivationVerdict -RevisionName 'taxonomy-editor-staging--0000220' -TrafficWeight 0 `
            -ProtectedNames @('taxonomy-editor-staging--0000220')
        $v.Action | Should -Be 'skip'
        $v.Reason | Should -Be 'explicitly-protected'
    }

    It 'a protected name that does not match this candidate does not spuriously skip it' {
        $v = Get-RevisionDeactivationVerdict -RevisionName 'taxonomy-editor-staging--0000219' -TrafficWeight 0 `
            -ProtectedNames @('taxonomy-editor-staging--0000220')
        $v.Action | Should -Be 'deactivate'
    }
}
