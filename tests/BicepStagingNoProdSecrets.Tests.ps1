# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# t/654 (t/92 B2; PI 2026-11-25, TL p/12#265/#267; Security p/278#18): staging holds no prod secret
# except the three sign-in OAuth client secrets, a PI-accepted risk (t/92#73, review 2027-02-25).
# Static parse of the real main.bicep: an ALLOW-LIST, so any new secret reaching staging fails here.
#
# Step 1 of 2: gemini-paid-key is still in staging's secrets (stagingPaidKeyRetained) because ACA rejects an
# apply that drops a secret an active revision references, and that apply also deploys prod. Its env
# reference is already gone. Step 2 removes it and deletes it from $script:Step1Retained below.

BeforeAll {
    $script:Bicep = Get-Content (Join-Path $PSScriptRoot '..' 'deploy' 'azure' 'main.bicep') -Raw

    function Get-VarBody([string]$Name) {
        $m = [regex]::Match($script:Bicep, "(?s)(?m)^var $Name = concat\((.*?)\r?\n\)")
        if (-not $m.Success) { $m = [regex]::Match($script:Bicep, "(?m)^var $Name = (.+)$") }
        if (-not $m.Success) { throw "var $Name not found in main.bicep" }
        $m.Groups[1].Value
    }
    function Get-VarLine([string]$Name) {
        $m = [regex]::Match($script:Bicep, "(?m)^var $Name\s*=\s*(.+)$")
        if (-not $m.Success) { throw "var $Name not found in main.bicep" }
        $m.Groups[1].Value.Trim()
    }

    # The accepted-risk OAuth secrets, staging's own free-tier key, and the step-1 retained entry.
    # t/669: plus staging's OWN EasyAuth cookie keys, from staging's vault (never prod's; the vault test below pins it).
    $script:AllowedSecretNameVars = @('googleClientSecretName', 'githubClientSecretName', 'aadClientSecretName', 'freeTierStagingSecretName',
        'easyAuthEncryptionSecretName', 'easyAuthSigningSecretName')
    $script:Step1Retained = @('paidTierSecretName')
    # Prod secrets that must never reach staging.
    $script:ForbiddenSecretNameVars = @('githubTokenSecretName', 'githubWebhookSecretName', 'freeTierSecretName')

    # Resolve stagingSecrets one level: its own entries plus the vars it concatenates.
    $script:StagingSecretsText = Get-VarLine 'stagingSecrets'
    $script:StagingSecretsBody = [regex]::Match($script:Bicep, '(?s)var stagingSecrets = concat\((.*?)\)\r?\n').Groups[1].Value
    $script:Expanded = $script:StagingSecretsBody
    foreach ($v in [regex]::Matches($script:StagingSecretsBody, '\b(staging\w+Secrets|stagingPaidKeyRetained)\b') | ForEach-Object { $_.Value } | Select-Object -Unique) {
        $script:Expanded += "`n" + (Get-VarBody $v)
    }
    # t/669: easyAuthKeySecretsStaging is a multi-line conditional array, not a concat; take its whole body.
    $script:EasyAuthStagingBody = [regex]::Match($script:Bicep, '(?s)(?m)^var easyAuthKeySecretsStaging = (.*?)\] : \[\]').Groups[1].Value
    if ($script:StagingSecretsBody -match '\beasyAuthKeySecretsStaging\b') { $script:Expanded += "`n" + $script:EasyAuthStagingBody }
    # Every bare var name concatenated into stagingSecrets (an identifier standing alone between commas), so a new
    # var this parse doesn't expand fails the 'no silent gap' test instead of hiding its secrets.
    $script:ConcatVars = @(($script:StagingSecretsBody -split ',') | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^[A-Za-z]\w*$' })
    $script:UnexpandedVars = @($script:ConcatVars | Where-Object { $_ -notmatch '^(staging\w+Secrets|stagingPaidKeyRetained|easyAuthKeySecretsStaging)$' })
}

Describe 'staging holds no prod secret except the accepted OAuth three (t/654)' {
    It 'resolves staging''s secrets (the parse works)' {
        $script:StagingSecretsBody | Should -Not -BeNullOrEmpty
        $script:Expanded | Should -Match 'googleClientSecretName'
    }

    It 'staging''s secrets name only allow-listed secret-name vars' {
        $names = [regex]::Matches($script:Expanded, 'name:\s*(\w+)') | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique
        $extra = @($names | Where-Object { $_ -notin ($script:AllowedSecretNameVars + $script:Step1Retained) })
        $extra | Should -BeNullOrEmpty -Because 'a secret outside the allow-list reached staging'
    }

    It 't/669: staging''s EasyAuth keys come from STAGING''s vault, never the prod vault' {
        $script:EasyAuthStagingBody | Should -Match 'easyAuthEncryptionSecretName'
        $script:EasyAuthStagingBody | Should -Match 'stagingKeyVaultUrl'
        $script:EasyAuthStagingBody | Should -Not -Match 'keyVault.properties'
    }

    It 'every var concatenated into stagingSecrets is expanded by this test (no silent gap)' {
        $script:ConcatVars | Should -Contain 'stagingOauthSecrets' -Because 'the parse must see the concatenated vars (not vacuous)'
        $script:ConcatVars | Should -Contain 'easyAuthKeySecretsStaging'
        $script:UnexpandedVars | Should -BeNullOrEmpty
    }

    It 'staging''s secrets never include the prod token, webhook or prod free-tier key' {
        foreach ($f in $script:ForbiddenSecretNameVars) { $script:Expanded | Should -Not -Match "\b$f\b" }
        $script:StagingSecretsBody | Should -Not -Match '\bsharedOauthSecrets\b'
    }

    It 'staging''s env references no prod secret: no GEMINI_PAID_KEY, GITHUB_TOKEN or GITHUB_WEBHOOK_SECRET' {
        $env = Get-VarLine 'stagingContainerEnv'
        $env | Should -Be 'concat(stagingBaseEnv, stagingExtraFreeTier)'
        $env | Should -Not -Match '\b(extraPaidTier|extraGithubToken|extraGithubWebhook|extraFreeTier)\b'
    }

    It 'step 1: gemini-paid-key is retained ONLY as the named step-1 entry, with no env reference to it' {
        Get-VarLine 'stagingPaidKeyRetained' | Should -Be 'paidTierEnabled ? [ { name: paidTierSecretName, value: geminiPaidKey } ] : []'
        Get-VarLine 'stagingContainerEnv' | Should -Not -Match 'Paid'
    }
}
