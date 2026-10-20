# Both-arms proof for the tokenStore safety predicate (t/4133, prevention for t/4132).
# Dot-sources the SAME predicate file deploy-azure.yml uses (t/3010 co-location pattern
# — gate and proof cannot diverge).
#
# Fixture shapes are the REAL az containerapp auth show --query 'login.tokenStore' -o json
# output from the t/4132 incident and its fix, plus hypothetical backed shapes:
#   - BadShape:       what was deployed from inception until PR #3163 (enabled:true, no backing)
#   - GoodShape:      what PR #3163 deployed (enabled:false)
#   - BackedSasShape: correctly configured via sasUrlSettingName
#   - BackedUriShape: correctly configured via blobContainerUri (MI-backed, @2024-10-02-preview)

BeforeAll {
    . "$PSScriptRoot/../operations/devops/Invoke-TokenStoreGateCheck.ps1"

    # Real t/4132 incident shape (enabled:true, no sasUrlSettingName — azureBlobStorage is empty object)
    $script:BadShape        = '{"enabled":true,"tokenRefreshExtensionHours":72,"azureBlobStorage":{}}'
    # Fixed shape (PR #3163 — enabled:false)
    $script:GoodShape       = '{"enabled":false,"tokenRefreshExtensionHours":72,"azureBlobStorage":{}}'
    # Correctly enabled with sasUrlSettingName backing
    $script:BackedSasShape  = '{"enabled":true,"tokenRefreshExtensionHours":72,"azureBlobStorage":{"sasUrlSettingName":"tokenstore-sas-url"}}'
    # Correctly enabled with blobContainerUri backing (managed-identity path, @2024-10-02-preview)
    $script:BackedUriShape  = '{"enabled":true,"tokenRefreshExtensionHours":72,"azureBlobStorage":{"blobContainerUri":"https://storage.blob.core.windows.net/tokens"}}'
}

Describe 'Invoke-TokenStoreCheck — tokenStore safety predicate (t/4133)' {

    It 'PASS: tokenStore.enabled=false (real t/4132 fixed shape from PR #3163)' {
        $ts = $script:GoodShape | ConvertFrom-Json
        $r  = Invoke-TokenStoreCheck -AppLabel 'prod' -TokenStore $ts
        $r.Safe    | Should -BeTrue
        $r.Skipped | Should -BeFalse
    }

    It 'FIRE: tokenStore.enabled=true with no backing (real t/4132 incident shape)' {
        $ts = $script:BadShape | ConvertFrom-Json
        $r  = Invoke-TokenStoreCheck -AppLabel 'prod' -TokenStore $ts
        $r.Safe    | Should -BeFalse
        $r.Skipped | Should -BeFalse
        $r.Reason  | Should -Match 'sasUrlSettingName'
        $r.Reason  | Should -Match 't/4132'
        $r.Reason  | Should -Match 'prod'
    }

    It 'PASS: tokenStore.enabled=true WITH sasUrlSettingName backing' {
        $ts = $script:BackedSasShape | ConvertFrom-Json
        $r  = Invoke-TokenStoreCheck -AppLabel 'staging' -TokenStore $ts
        $r.Safe    | Should -BeTrue
        $r.Skipped | Should -BeFalse
    }

    It 'PASS: tokenStore.enabled=true WITH blobContainerUri backing (MI path, C4)' {
        $ts = $script:BackedUriShape | ConvertFrom-Json
        $r  = Invoke-TokenStoreCheck -AppLabel 'staging' -TokenStore $ts
        $r.Safe    | Should -BeTrue
        $r.Skipped | Should -BeFalse
    }

    It 'PASS: null TokenStore (app not found / auth not configured) -> skip, not a failure' {
        $r = Invoke-TokenStoreCheck -AppLabel 'staging' -TokenStore $null
        $r.Safe    | Should -BeTrue
        $r.Skipped | Should -BeTrue
        $r.Reason  | Should -Match 'not configured'
    }

    It 'FIRE: azureBlobStorage key absent entirely -> unbacked -> fail' {
        # Edge case: azureBlobStorage key missing from JSON (not just empty object)
        $ts = '{"enabled":true,"tokenRefreshExtensionHours":72}' | ConvertFrom-Json
        $r  = Invoke-TokenStoreCheck -AppLabel 'prod' -TokenStore $ts
        $r.Safe | Should -BeFalse
    }

    It 'PASS: enabled=false even with azureBlobStorage absent -> safe (disabled is always safe)' {
        $ts = '{"enabled":false}' | ConvertFrom-Json
        $r  = Invoke-TokenStoreCheck -AppLabel 'staging' -TokenStore $ts
        $r.Safe | Should -BeTrue
    }
}

# t/4169 (t/4133 C3): the pre-merge layer. Parses deploy/azure/main.bicep itself, so a template that
# regresses to tokenStore.enabled:true without backing fails CI before it can ever deploy (t/4132).
Describe 'main.bicep authConfig tokenStore is safe (t/4169)' {
    BeforeAll {
        function New-AuthFixture([string]$TokenStoreBody, [string]$Name = 'authX') {
            @"
resource $Name 'Microsoft.App/containerApps/authConfigs@2024-10-02-preview' = {
  name: 'current'
  properties: {
    login: {
      allowedExternalRedirectUrls: [
        'https://`${containerApp.properties.configuration.ingress.fqdn}'
      ]
$TokenStoreBody
    }
  }
}
"@
        }
    }

    It 'REAL main.bicep: finds the prod and staging authConfigs, each parsed, each safe' {
        $text = Get-Content -Raw "$PSScriptRoot/../deploy/azure/main.bicep"
        $cfgs = Get-BicepTokenStoreConfigs -BicepText $text
        @($cfgs).Count | Should -BeGreaterOrEqual 2
        @($cfgs.Resource) | Should -Contain 'authConfig'
        @($cfgs.Resource) | Should -Contain 'authConfigStaging'
        foreach ($c in $cfgs) {
            $c.ParseError | Should -BeNullOrEmpty -Because "$($c.Resource) must have a literal, explicit tokenStore"
            (Invoke-TokenStoreCheck -AppLabel $c.Resource -TokenStore $c.TokenStore).Safe | Should -BeTrue -Because "$($c.Resource) tokenStore must be disabled or blob-backed (t/4132)"
        }
    }

    It 'FIRE: enabled: true with no backing (the t/4132 template) -> unsafe' {
        $c = (Get-BicepTokenStoreConfigs -BicepText (New-AuthFixture "      tokenStore: {`n        enabled: true`n      }"))[0]
        $c.ParseError | Should -BeNullOrEmpty
        (Invoke-TokenStoreCheck -AppLabel $c.Resource -TokenStore $c.TokenStore).Safe | Should -BeFalse
    }

    It 'FIRE: enabled: true with an empty azureBlobStorage block -> unsafe' {
        $c = (Get-BicepTokenStoreConfigs -BicepText (New-AuthFixture "      tokenStore: {`n        enabled: true`n        azureBlobStorage: {}`n      }"))[0]
        (Invoke-TokenStoreCheck -AppLabel $c.Resource -TokenStore $c.TokenStore).Safe | Should -BeFalse
    }

    It 'PASS: enabled: true with sasUrlSettingName backing -> safe' {
        $c = (Get-BicepTokenStoreConfigs -BicepText (New-AuthFixture "      tokenStore: {`n        enabled: true`n        azureBlobStorage: {`n          sasUrlSettingName: 'tokenstore-sas-url'`n        }`n      }"))[0]
        (Invoke-TokenStoreCheck -AppLabel $c.Resource -TokenStore $c.TokenStore).Safe | Should -BeTrue
    }

    It 'PASS: enabled: true with blobContainerUri backing -> safe' {
        $c = (Get-BicepTokenStoreConfigs -BicepText (New-AuthFixture "      tokenStore: {`n        enabled: true`n        azureBlobStorage: {`n          blobContainerUri: 'https://acct.blob.core.windows.net/tokens'`n        }`n      }"))[0]
        (Invoke-TokenStoreCheck -AppLabel $c.Resource -TokenStore $c.TokenStore).Safe | Should -BeTrue
    }

    It 'IGNORES comments: a comment saying "enabled: true" does not override the real enabled: false' {
        $c = (Get-BicepTokenStoreConfigs -BicepText (New-AuthFixture "      tokenStore: {`n        // enabled: true would lose sessions on recycle`n        enabled: false`n      }"))[0]
        $c.ParseError | Should -BeNullOrEmpty
        $c.TokenStore.enabled | Should -BeFalse
    }

    It 'FAILS CLOSED: no tokenStore block -> ParseError, never safe' {
        $c = (Get-BicepTokenStoreConfigs -BicepText (New-AuthFixture '      preserveUrlFragmentsForLogins: false'))[0]
        $c.ParseError | Should -Match 'no tokenStore block'
        $c.TokenStore | Should -BeNullOrEmpty
    }

    It 'FAILS CLOSED: non-literal enabled (a param/expression) -> ParseError' {
        $c = (Get-BicepTokenStoreConfigs -BicepText (New-AuthFixture "      tokenStore: {`n        enabled: tokenStoreEnabled`n      }"))[0]
        $c.ParseError | Should -Match 'not a literal'
    }
}
