# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# t/669 (PI yes, t/669#11): each app's EasyAuth cookie keys are Key Vault references from ITS OWN vault.
# Bicep has no cross-resource assertion, so this static parse of the real main.bicep is the guard:
#   - staging's key secrets reference only the staging vault (stagingKeyVaultUrl), never the shared one;
#   - prod's reference only the shared vault (keyVault), never the staging one;
#   - each app's secrets list and authConfig use its own set, never the other's;
#   - staging goes first: prod's switch can't default to true while staging's is false.
# Same approach as BicepStagingFreeTierKey.Tests.ps1 and BicepProdStateShareIsolation.Tests.ps1.

BeforeAll {
    $script:Bicep = Get-Content (Join-Path $PSScriptRoot '..' 'deploy' 'azure' 'main.bicep') -Raw

    function Get-Block([string]$StartPattern) {
        $m = [regex]::Match($script:Bicep, "(?s)(?m)$StartPattern.*?(?=\r?\n(resource|var|param|output|module|//) )")
        if (-not $m.Success) { throw "block '$StartPattern' not found in main.bicep" }
        $m.Value
    }
    function Get-ParamDefault([string]$Name) {
        $m = [regex]::Match($script:Bicep, "(?m)^param $Name bool = (true|false)\s*$")
        if (-not $m.Success) { throw "param $Name (bool with a literal default) not found" }
        $m.Groups[1].Value
    }

    $script:SecretsStaging = Get-Block '^var easyAuthKeySecretsStaging ='
    $script:SecretsProd = Get-Block '^var easyAuthKeySecretsProd ='
    $script:OauthSecrets = Get-Block '^var oauthSecrets ='
    $script:StagingSecrets = Get-Block '^var stagingSecrets ='
    $script:AuthProd = Get-Block "^resource authConfig 'Microsoft\.App/containerApps/authConfigs@[^']+' ="
    $script:AuthStaging = Get-Block "^resource authConfigStaging 'Microsoft\.App/containerApps/authConfigs@[^']+' ="
}

Describe 'EasyAuth cookie keys come from each app''s own vault (t/669)' {

    It 'staging''s key secrets reference only the staging vault' {
        $script:SecretsStaging | Should -Match 'stagingKeyVaultUrl'
        $script:SecretsStaging | Should -Not -Match 'keyVault\.properties'
    }

    It 'prod''s key secrets reference only the shared vault' {
        $script:SecretsProd | Should -Match 'keyVault\.properties\.vaultUri'
        $script:SecretsProd | Should -Not -Match 'stagingKeyVaultUrl'
    }

    It 'both use the app''s system identity, not a stored value' {
        foreach ($b in $script:SecretsStaging, $script:SecretsProd) {
            $b | Should -Match "identity:\s*'system'"
            $b | Should -Not -Match '\bvalue:'
        }
    }

    It 'each app''s secrets list carries only its own key secrets' {
        $script:OauthSecrets | Should -Match '\beasyAuthKeySecretsProd\b'
        $script:OauthSecrets | Should -Not -Match '\beasyAuthKeySecretsStaging\b'
        $script:StagingSecrets | Should -Match '\beasyAuthKeySecretsStaging\b'
        $script:StagingSecrets | Should -Not -Match '\beasyAuthKeySecretsProd\b'
    }

    It 'each authConfig uses its own encryptionSettings' {
        $script:AuthProd | Should -Match 'encryptionSettings:\s*easyAuthEncryptionSettingsProd\b'
        $script:AuthStaging | Should -Match 'encryptionSettings:\s*easyAuthEncryptionSettingsStaging\b'
    }

    It 'staging goes first: prod''s switch is not on while staging''s is off' {
        if ((Get-ParamDefault 'easyAuthOwnKeysProd') -eq 'true') {
            Get-ParamDefault 'easyAuthOwnKeysStaging' | Should -Be 'true'
        }
    }
}
