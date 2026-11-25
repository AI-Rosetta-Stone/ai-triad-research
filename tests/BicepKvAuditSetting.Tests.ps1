# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# t/659 (SO p/299#11, TL p/45#265): diagnostic settings are written whole, so whatever the
# template omits from kv-audit-logs is removed on every apply. This static parse of main.bicep
# fails if the shared vault's audit category group stops being declared enabled, or if the
# setting drifts from what live carries (destination type and the disabled allLogs entry).

BeforeAll {
    $script:Bicep = Get-Content (Join-Path $PSScriptRoot '..' 'deploy' 'azure' 'main.bicep') -Raw
    $m = [regex]::Match($script:Bicep, "(?s)resource kvDiagnostics '[^']+' = \{.*?\r?\n\}")
    if (-not $m.Success) { throw 'kvDiagnostics resource not found in main.bicep' }
    $script:Diag = $m.Value
}

Describe 'Key Vault audit diagnostic setting (t/659)' {
    It 'is scoped to the shared vault and named kv-audit-logs' {
        $script:Diag | Should -Match 'scope:\s*keyVault\b'
        $script:Diag | Should -Match "name:\s*'kv-audit-logs'"
    }
    It 'declares the audit category group enabled' {
        $script:Diag | Should -Match "(?s)categoryGroup:\s*'audit'\s*\r?\n\s*enabled:\s*true"
    }
    It 'declares the allLogs entry live carries, so an apply does not rewrite the setting' {
        $script:Diag | Should -Match "(?s)categoryGroup:\s*'allLogs'\s*\r?\n\s*enabled:\s*false"
    }
    It 'declares the AzureDiagnostics destination the audit queries read from' {
        $script:Diag | Should -Match "logAnalyticsDestinationType:\s*'AzureDiagnostics'"
    }
}
