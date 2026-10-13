# Tag: taxonomy (t/4180)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Covers Invoke-TaxEditorLoadTest's prod guard (t/4180).
.DESCRIPTION
    The guard is the one behavior this cmdlet must get right under every circumstance —
    it throws before touching az or node, so it's testable with no mocking and no
    network. The ramp itself (az monitor metrics, the node driver, scale restore) is
    integration behavior exercised by actually running against staging, per
    operations/devops/load-test/README.md — not unit-tested here.
#>

BeforeAll {
    $ModulePath = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1'
    Import-Module $ModulePath -Force -WarningAction SilentlyContinue
}

Describe 'Invoke-TaxEditorLoadTest (t/4180)' -Tag 'taxonomy' {

    It 'Refuses a URL that does not contain "staging"' {
        { Invoke-TaxEditorLoadTest -BaseUrl 'https://taxonomy-editor.example.io' } |
            Should -Throw -ErrorId '*'
    }

    It 'Refuses the bare prod URL' {
        { Invoke-TaxEditorLoadTest -BaseUrl 'https://taxonomy-editor.yellowbush-aeda037d.eastus.azurecontainerapps.io' } |
            Should -Throw
    }

    It 'The guard is case-insensitive, so a different-cased prod host is still refused' {
        { Invoke-TaxEditorLoadTest -BaseUrl 'https://Taxonomy-Editor.EXAMPLE.io' } | Should -Throw
    }
}
