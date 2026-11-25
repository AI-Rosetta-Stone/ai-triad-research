# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# t/92 change B (Security t/626): staging must hold NO role on the shared (prod) Key Vault. Staging
# reads only its own vault, kv-ait-stg (staging-keyvault.bicep). Static parse of the real main.bicep:
# every roleAssignment scoped to `keyVault` must name only the prod app's identity.

BeforeAll {
    $script:Bicep = Get-Content (Join-Path $PSScriptRoot '..' 'deploy' 'azure' 'main.bicep') -Raw
    $script:RoleBlocks = [regex]::Matches($script:Bicep, "(?s)(?m)^resource (\w+) 'Microsoft\.Authorization/roleAssignments@[^']+' = \{.*?\r?\n\}")
}

Describe 'staging has no role on the shared Key Vault (t/92 change B)' {
    It 'finds role assignments to check (the parse works)' {
        $script:RoleBlocks.Count | Should -BeGreaterThan 0
    }

    It 'keeps the prod app''s Secrets Officer role on the shared vault' {
        $kv = @($script:RoleBlocks | Where-Object { $_.Value -match '(?m)^\s*scope:\s*keyVault\s*$' })
        $kv.Count | Should -BeGreaterThan 0
        ($kv | Where-Object { $_.Value -match 'containerApp\.identity\.principalId' }).Count | Should -Be 1
    }

    It 'has no role assignment scoped to keyVault that names the staging app' {
        $bad = @($script:RoleBlocks | Where-Object { $_.Value -match '(?m)^\s*scope:\s*keyVault\s*$' -and $_.Value -match 'containerAppStaging' })
        $bad | ForEach-Object { $_.Groups[1].Value } | Should -BeNullOrEmpty
    }

    It 'no longer declares kvRoleAssignmentStaging' {
        $script:Bicep | Should -Not -Match '(?m)^resource kvRoleAssignmentStaging '
    }
}
