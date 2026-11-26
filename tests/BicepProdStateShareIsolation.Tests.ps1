# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# t/624 (t/617 design A, Security condition 1): prod's class-A state moves to the Azure Files share
# 'taxonomy-state-prod', which staging must never mount. Bicep has no cross-resource assertion, so
# this static parse of the real main.bicep is the guard: only the prod container app may reference
# the 'taxonomy-state-prod' storage, and only one env storage registration may point at that share.
# Same approach as BicepStagingFreeTierKey.Tests.ps1.

BeforeAll {
    $script:Bicep = Get-Content (Join-Path $PSScriptRoot '..' 'deploy' 'azure' 'main.bicep') -Raw

    function Get-AppBlock([string]$AppName) {
        $m = [regex]::Match($script:Bicep, "(?s)(?m)^resource \w+ 'Microsoft\.App/containerApps@[^']+' = \{\s*\r?\n\s*name:\s*'$([regex]::Escape($AppName))'.*?(?=\r?\n(resource|var|param|output|module) )")
        if (-not $m.Success) { throw "container app '$AppName' not found in main.bicep" }
        $m.Value
    }

    # Every storageName in an app block, as written (a quoted literal, or else the bare expression).
    function Get-StorageNameExpressions([string]$AppBlock) {
        @([regex]::Matches($AppBlock, "(?m)^\s*storageName:\s*('[^']*'|[^\r\n]+)") | ForEach-Object { $_.Groups[1].Value.Trim() })
    }

    # Env storage registrations declared in the template: storage name -> Bicep symbol.
    function Get-DeclaredEnvStorages([string]$Text) {
        $map = @{}
        foreach ($m in [regex]::Matches($Text, "(?m)^resource (\w+) 'Microsoft\.App/managedEnvironments/storages@[^']+' = \{\s*\r?\n\s*parent:[^\r\n]*\r?\n\s*name:\s*'([^']+)'")) {
            $map[$m.Groups[2].Value] = $m.Groups[1].Value
        }
        $map
    }

    # The symbols an app must list in dependsOn (one per volume whose storage this template registers)
    # that it does not list. A storageName string creates no implicit dependency, so a missing symbol
    # means ARM may update the app before the storage is registered and refuse it.
    function Get-MissingStorageDependencies([string]$AppBlock, [hashtable]$Declared) {
        $dep = [regex]::Match($AppBlock, '(?m)^  dependsOn:\s*\[([^\]]*)\]')
        $listed = if ($dep.Success) { @($dep.Groups[1].Value -split '[,\s]+' | Where-Object { $_ }) } else { @() }
        @(Get-StorageNameExpressions $AppBlock |
            ForEach-Object { $_.Trim("'") } |
            Where-Object { $Declared.ContainsKey($_) -and $listed -notcontains $Declared[$_] } |
            ForEach-Object { $Declared[$_] })
    }

    $script:Prod = Get-AppBlock 'taxonomy-editor'
    $script:Staging = Get-AppBlock 'taxonomy-editor-staging'
    $script:StorageRef = "storageName:\s*'taxonomy-state-prod'"
    $script:Declared = Get-DeclaredEnvStorages $script:Bicep
}

Describe 'Prod-only state share isolation (t/624, t/617)' {

    It 'the prod app mounts the taxonomy-state-prod storage' {
        $script:Prod | Should -Match $script:StorageRef
    }

    It 'the staging app never references the taxonomy-state-prod storage' {
        $script:Staging | Should -Not -Match 'taxonomy-state-prod'
    }

    It 'no container app other than prod references the taxonomy-state-prod storage' {
        $refs = [regex]::Matches($script:Bicep, $script:StorageRef)
        $refs.Count | Should -Be 1
        $script:Prod.Contains($refs[0].Value) | Should -BeTrue
    }

    It 'exactly one env storage registration points at the taxonomy-state-prod share' {
        $shares = [regex]::Matches($script:Bicep, "shareName:\s*'taxonomy-state-prod'")
        $shares.Count | Should -Be 1
    }

    It 'the staging app does not set AI_TRIAD_STATE_ROOT under /mnt/prod-state' {
        $script:Staging | Should -Not -Match '/mnt/prod-state'
    }

    # SO round on #5576: an allowlist, not a denylist. A new staging volume, or one whose storage is
    # computed, fails here until someone decides it is safe.
    It 'the staging app mounts exactly its two storages, each a literal' {
        $names = @(Get-StorageNameExpressions $script:Staging | Sort-Object)
        $names | Should -Be @("'taxonomy-data-ro'", "'taxonomy-data-staging'")
    }

    It 'the prod app mounts exactly its two storages, each a literal' {
        $names = @(Get-StorageNameExpressions $script:Prod | Sort-Object)
        $names | Should -Be @("'taxonomy-data'", "'taxonomy-state-prod'")
    }

    It 'every shareName in main.bicep is a plain literal (no interpolation, var or param could resolve to the prod state share)' {
        $all = @([regex]::Matches($script:Bicep, '(?m)^\s*shareName:\s*([^\r\n]+)') | ForEach-Object { $_.Groups[1].Value.Trim() })
        $all.Count | Should -BeGreaterThan 0 -Because 'the parse must see the registrations (not vacuous)'
        @($all | Where-Object { $_ -notmatch "^'[A-Za-z0-9-]+'$" }) | Should -BeNullOrEmpty
    }

    It 'the only env storage that registers the taxonomy-state-prod share is the one named taxonomy-state-prod' {
        $script:Declared.Keys | Should -Contain 'taxonomy-state-prod'
        $block = [regex]::Match($script:Bicep, "(?s)(?m)^resource $($script:Declared['taxonomy-state-prod']) .*?(?=\r?\n(resource|var|param|output|module|//) )").Value
        $block | Should -Match "shareName:\s*'taxonomy-state-prod'"
    }
}

Describe 'Container apps are ordered after the env storages they mount (SO round on #5576)' {

    It 'the parse finds the three registrations this template declares (not vacuous)' {
        @($script:Declared.Keys | Sort-Object) | Should -Be @('taxonomy-data-ro', 'taxonomy-data-staging', 'taxonomy-state-prod')
    }

    It 'the prod app lists every in-template storage it mounts in dependsOn' {
        Get-MissingStorageDependencies $script:Prod $script:Declared | Should -BeNullOrEmpty
    }

    It 'the staging app lists every in-template storage it mounts in dependsOn' {
        Get-MissingStorageDependencies $script:Staging $script:Declared | Should -BeNullOrEmpty
    }

    # Failing arm: the state SO blocked on (no dependsOn on the prod app) must be named by the check.
    It 'failing arm: the prod app without its dependsOn is reported as missing envStorageProdState' {
        $line = [regex]::Match($script:Prod, '(?m)^  dependsOn:[^\r\n]*\r?\n')
        $line.Success | Should -BeTrue -Because 'the mutation target must exist in the real prod block'
        $mutated = $script:Prod.Replace($line.Value, '')
        Get-MissingStorageDependencies $mutated $script:Declared | Should -Be @('envStorageProdState')
    }

    It 'failing arm: the staging app with one storage dropped from dependsOn is reported' {
        $mutated = $script:Staging.Replace('dependsOn: [envStorageStagingState, envStorageSharedRO]', 'dependsOn: [envStorageSharedRO]')
        $mutated | Should -Not -Be $script:Staging -Because 'the mutation must change the block'
        Get-MissingStorageDependencies $mutated $script:Declared | Should -Be @('envStorageStagingState')
    }
}
