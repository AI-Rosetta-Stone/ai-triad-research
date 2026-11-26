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

    function Get-Block([string]$StartPattern, [string]$Text = $script:Bicep) {
        $m = [regex]::Match($Text, "(?s)(?m)$StartPattern.*?(?=\r?\n(resource|var|param|output|module|//) )")
        if (-not $m.Success) { throw "block '$StartPattern' not found in main.bicep" }
        $m.Value
    }
    # t/711: EVERY keyVaultUrl in a key-secrets block, as written (a whole quoted string, or else a bare
    # expression up to the next comma or brace, so a var reference or a literal URL is caught as well as an
    # interpolated string). A positive match
    # on one entry plus a not-match on 'keyVault.properties' passed when a single key pointed at the other vault's
    # literal URL; checking each value's prefix does not.
    function Get-KeyVaultUrlExpressions([string]$Block) {
        @([regex]::Matches($Block, 'keyVaultUrl:\s*(''[^'']*''|[^,}\r\n]+)') | ForEach-Object { $_.Groups[1].Value.Trim() })
    }
    function Get-ForeignKeyVaultUrls([string]$Block, [string]$OwnPrefix) {
        @(Get-KeyVaultUrlExpressions $Block | Where-Object { -not $_.StartsWith($OwnPrefix, [StringComparison]::Ordinal) })
    }
    $script:StagingPrefix = "'`${stagingKeyVaultUrl}secrets/"
    $script:ProdPrefix = "'`${keyVault.properties.vaultUri}secrets/"
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

    It 'staging''s key secrets reference only the staging vault: every keyVaultUrl starts with the staging vault''s URL' {
        @(Get-KeyVaultUrlExpressions $script:SecretsStaging).Count | Should -Be 2 -Because 'the parse must see both keys (not vacuous)'
        Get-ForeignKeyVaultUrls $script:SecretsStaging $script:StagingPrefix | Should -BeNullOrEmpty -Because 'a staging EasyAuth key is not read from the staging vault'
        $script:SecretsStaging | Should -Not -Match 'keyVault\.properties'
    }

    It 'prod''s key secrets reference only the shared vault: every keyVaultUrl starts with the shared vault''s URL' {
        @(Get-KeyVaultUrlExpressions $script:SecretsProd).Count | Should -Be 2 -Because 'the parse must see both keys (not vacuous)'
        Get-ForeignKeyVaultUrls $script:SecretsProd $script:ProdPrefix | Should -BeNullOrEmpty -Because 'a prod EasyAuth key is not read from the shared vault'
        $script:SecretsProd | Should -Not -Match 'stagingKeyVaultUrl'
    }

    # t/711 failing arm: mutations of the real main.bicep, including the one the old assertions let through.
    # Each runs the same check on a mutated copy and must name exactly the mutated key.
    Context 'failing arm: one staging key pointed at another vault is caught' {
        BeforeAll {
            $script:SigningLine = "{ name: easyAuthSigningSecretName, keyVaultUrl: '`${stagingKeyVaultUrl}secrets/`${easyAuthSigningSecretName}', identity: 'system' }"
            function Get-MutatedStagingBlock([string]$NewKeyVaultUrl) {
                $block = Get-Block '^var easyAuthKeySecretsStaging ='
                if (-not $block.Contains($script:SigningLine)) { throw 'the mutation target (staging signing key line) is not in the real staging block' }
                $mutatedBlock = $block.Replace($script:SigningLine, "{ name: easyAuthSigningSecretName, keyVaultUrl: $NewKeyVaultUrl, identity: 'system' }")
                $mutated = $script:Bicep.Replace($block, $mutatedBlock)
                if ($mutated -ceq $script:Bicep) { throw 'the mutation did not change main.bicep' }
                Get-Block '^var easyAuthKeySecretsStaging =' $mutated
            }
        }

        It 'the prod vault''s literal URL on the signing key only (this passed the old assertions)' {
            $literal = "'https://kv-ait-kvwl3nywge4iw.vault.azure.net/secrets/`${easyAuthSigningSecretName}'"
            $block = Get-MutatedStagingBlock $literal
            # What the old pin checked still holds on the mutated block, which is why it passed:
            $block | Should -Match 'stagingKeyVaultUrl'
            $block | Should -Not -Match 'keyVault\.properties'
            # The new check names the mutated key and nothing else.
            $foreign = @(Get-ForeignKeyVaultUrls $block $script:StagingPrefix)
            $foreign.Count | Should -Be 1
            $foreign[0] | Should -Be $literal
        }

        It 'the shared vault''s vaultUri on the signing key' {
            $foreign = @(Get-ForeignKeyVaultUrls (Get-MutatedStagingBlock "'`${keyVault.properties.vaultUri}secrets/`${easyAuthSigningSecretName}'") $script:StagingPrefix)
            $foreign.Count | Should -Be 1
        }

        It 'a var reference instead of an interpolated staging URL' {
            $foreign = @(Get-ForeignKeyVaultUrls (Get-MutatedStagingBlock 'someOtherVaultUrl') $script:StagingPrefix)
            $foreign.Count | Should -Be 1
            $foreign[0] | Should -Be 'someOtherVaultUrl'
        }

        It 'the staging vault''s URL with a path that is not under secrets/' {
            $foreign = @(Get-ForeignKeyVaultUrls (Get-MutatedStagingBlock "'`${stagingKeyVaultUrl}`${easyAuthSigningSecretName}'") $script:StagingPrefix)
            $foreign.Count | Should -Be 1
        }
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
