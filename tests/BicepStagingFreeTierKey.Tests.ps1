# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# t/4732 (PI decision 2026-11-10): staging gets its own Gemini free-tier key, secret
# free-tier-gemini-key-staging, so it stops drawing on prod's pool. The staging app alone may
# hold or reference that secret; prod stays on the shared free-tier-gemini-key. An empty staging
# param falls back to the shared key. Static parse of the real main.bicep, same approach as
# BicepAllowedOrigins.Tests.ps1.

BeforeAll {
    $script:Bicep = Get-Content (Join-Path $PSScriptRoot '..' 'deploy' 'azure' 'main.bicep') -Raw

    function Get-AppBlock([string]$AppName) {
        $m = [regex]::Match($script:Bicep, "(?s)(?m)^resource \w+ 'Microsoft\.App/containerApps@[^']+' = \{\s*\r?\n\s*name:\s*'$([regex]::Escape($AppName))'.*?(?=\r?\n(resource|var|param|output|module) )")
        if (-not $m.Success) { throw "container app '$AppName' not found in main.bicep" }
        $m.Value
    }
    function Get-VarLine([string]$Name) {
        $m = [regex]::Match($script:Bicep, "(?m)^var $Name\s*=\s*(.+)$")
        if (-not $m.Success) { throw "var $Name not found in main.bicep" }
        $m.Groups[1].Value.Trim()
    }

    $script:Prod = Get-AppBlock 'taxonomy-editor'
    $script:Staging = Get-AppBlock 'taxonomy-editor-staging'
}

Describe 'staging-only Gemini free-tier key (t/4732)' {
    It 'declares freeTierGeminiKeyStaging as a @secure() param defaulting to empty' {
        $script:Bicep | Should -Match "@secure\(\)\r?\n@description\([^\r\n]*\)\r?\nparam freeTierGeminiKeyStaging string = ''"
    }

    It 'names the staging secret free-tier-gemini-key-staging, distinct from the shared one' {
        Get-VarLine 'freeTierStagingSecretName' | Should -Be "'free-tier-gemini-key-staging'"
        Get-VarLine 'freeTierSecretName' | Should -Be "'free-tier-gemini-key'"
    }

    It 'prod keeps oauthSecrets and containerEnv, and never references the staging key or secret' {
        $script:Prod | Should -Match '(?m)^\s+secrets: oauthSecrets\s*$'
        $script:Prod | Should -Match '(?m)^\s+env: containerEnv\s*$'
        $script:Prod | Should -Not -Match 'freeTierGeminiKeyStaging|freeTierStagingSecretName|free-tier-gemini-key-staging|stagingSecrets|stagingExtraFreeTier'
    }

    It 'the shared secret list and prod env chain never pick up the staging key' {
        $oauth = [regex]::Match($script:Bicep, '(?s)var oauthSecrets = concat\((.*?)\r?\n\)').Groups[1].Value
        $oauth | Should -Not -BeNullOrEmpty
        $oauth | Should -Not -Match 'Staging'
        Get-VarLine 'containerEnv' | Should -Not -Match 'Staging'
        Get-VarLine 'extraFreeTier' | Should -Match "secretRef: freeTierSecretName"
    }

    It 'staging uses stagingSecrets, which adds only the staging key, and only when provided' {
        $script:Staging | Should -Match '(?m)^\s+secrets: stagingSecrets\s*$'
        $script:Staging | Should -Match '(?m)^\s+env: stagingContainerEnv\s*$'
        $def = [regex]::Match($script:Bicep, '(?s)var stagingSecrets = concat\((.*?)\)\r?\n').Groups[1].Value
        $def | Should -Match '^oauthSecrets,'
        $def | Should -Match 'freeTierStagingKeyProvided \? \[ \{ name: freeTierStagingSecretName, value: freeTierGeminiKeyStaging \} \] : \[\]'
    }

    It 'staging FREE_TIER_GEMINI_KEY points at the staging secret when provided, else falls back to the shared one' {
        Get-VarLine 'freeTierStagingKeyProvided' | Should -Be '!empty(freeTierGeminiKeyStaging)'
        Get-VarLine 'stagingExtraFreeTier' | Should -Be "freeTierStagingKeyProvided ? [ { name: 'FREE_TIER_GEMINI_KEY', secretRef: freeTierStagingSecretName } ] : extraFreeTier"
        $env = Get-VarLine 'stagingContainerEnv'
        $env | Should -Match '\bstagingExtraFreeTier\b'
        $env | Should -Not -Match '\bextraFreeTier\b'
    }

    It 'SO condition 1: the staging cap is 300 only on staging''s own key, else the interim 200' {
        $script:Bicep | Should -Match "(?m)^param freePoolDailyCallsCapStaging string = '300'\s*$"
        Get-VarLine 'stagingFreePoolCap' | Should -Be "freeTierStagingKeyProvided ? freePoolDailyCallsCapStaging : '200'"
        $script:Bicep | Should -Match "\{ name: 'FREE_POOL_DAILY_CALLS_CAP', value: stagingFreePoolCap \}"
        $script:Bicep | Should -Not -Match "\{ name: 'FREE_POOL_DAILY_CALLS_CAP', value: freePoolDailyCallsCapStaging \}"
    }

    It 'the staging cap stays in Sync-StagingEnv''s managed-name set, so a staging deploy never orphan-deletes it' {
        $bicepPath = Join-Path $PSScriptRoot '..' 'deploy' 'azure' 'main.bicep'
        $names = & (Join-Path $PSScriptRoot '..' 'operations' 'devops' 'Get-BicepBaseEnv.ps1') -BicepPath $bicepPath -ForStaging -NamesOnly
        @($names) | Should -Contain 'FREE_POOL_DAILY_CALLS_CAP'
    }
}

Describe 'deploy-azure.yml passes the staging key without exposing it (t/4732)' {
    BeforeAll {
        $script:Workflow = Get-Content (Join-Path $PSScriptRoot '..' '.github' 'workflows' 'deploy-azure.yml') -Raw
    }

    It 'passes freeTierGeminiKeyStaging at both call sites (what-if and apply)' {
        ([regex]::Matches($script:Workflow, 'freeTierGeminiKeyStaging=\$\{\{ secrets\.FREE_TIER_GEMINI_KEY_STAGING \}\}')).Count | Should -Be 2
        ([regex]::Matches($script:Workflow, 'freeTierGeminiKey=\$\{\{ secrets\.FREE_TIER_GEMINI_KEY \}\}')).Count | Should -Be 2
    }

    It 'WARNs on the empty-key fallback from a boolean, never the key value' {
        $script:Workflow | Should -Match "STAGING_FREE_TIER_KEY_SET: \$\{\{ secrets\.FREE_TIER_GEMINI_KEY_STAGING != '' \}\}"
        $script:Workflow | Should -Match '::warning::WARN t/4732: secrets\.FREE_TIER_GEMINI_KEY_STAGING is empty'
        # Never put the secret itself into a step env var (only the two --parameters call sites).
        $script:Workflow | Should -Not -Match '(?m)^\s+[A-Z_]+:\s*\$\{\{ secrets\.FREE_TIER_GEMINI_KEY_STAGING \}\}\s*$'
    }

    It 'SO condition 3: an empty key fails the deploy (before any apply) when staging already holds the staging secret' {
        $block = [regex]::Match($script:Workflow, '(?s)if \[ "\$STAGING_FREE_TIER_KEY_SET" != "true" \]; then(.*?)\n          fi\n').Groups[1].Value
        $block | Should -Not -BeNullOrEmpty
        # Names only, fail-closed if they can't be read, refuse if the staging secret is present...
        $block | Should -Match 'az containerapp secret list -n "\$\{\{ env\.CONTAINER_APP_NAME \}\}-staging"'
        $block | Should -Not -Match '--show-values'
        $block | Should -Match "grep -qx 'free-tier-gemini-key-staging'"
        ([regex]::Matches($block, '(?m)^\s+exit 1\s*$')).Count | Should -Be 2
        # ...and only then WARN and fall back.
        $block.IndexOf('::warning::WARN t/4732') | Should -BeGreaterThan $block.LastIndexOf('exit 1')
        # It runs in the what-if step, which precedes the Bicep apply.
        $script:Workflow.IndexOf('STAGING_FREE_TIER_KEY_SET: ') | Should -BeLessThan $script:Workflow.IndexOf('- name: Deploy Bicep template')
    }
}
