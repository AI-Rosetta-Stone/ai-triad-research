# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# t/4096 Decision A: per-role GitHub App identities for agents.
#
# Mints a short-lived (1 hour) GitHub App installation token for one agent role, so agent
# actions are attributable to an App instead of the PI's own jpsnover account.
#
# WHAT A ROLE TOKEN PROVES (SO e/285#2 C1, read before building anything on these Apps):
#   A role-App action attests that an agent ran with that role, not that a different agent
#   performed it. All three keys are readable by every process as this user.
#   So role separation is ATTRIBUTION, not authorization or separation of duties. Never
#   configure a required-approval rule or ruleset whose satisfaction by a reviewer-App
#   approval is treated as independent review; T2 approval stays with the PI's own account.
#   THIS LIMIT LAPSES only if the keys move to per-agent stores that other agents cannot read.
#   The vault name is a label, not a boundary unless the backing store is dedicated to these keys
#   (TL e/285#7, SO e/285#8). Today SecretStore keeps ONE store per user,
#   so AiTriadAgentApps and LocalStore are two registrations of the same store, its
#   Authentication None / Interaction None setting is store-wide, and every secret in it is
#   readable by any process running as this user.
#
# SECURITY CONTRACT (t/3918 context):
#   - The App private key is read from the SecretManagement vault at call time and never
#     written to disk, logged, or put in an environment variable.
#   - Tokens are scoped to ONE repository (default ai-triad-research; ai-triad-data must be
#     named explicitly, and data writes go through /data-mutation) (C3).
#   - Invoke-AsAgentApp is the agent-facing entry point. It scopes GH_TOKEN to one block and
#     revokes the token when the block ends (C4), so the token lives only as long as the block.
#   - This is a MODULE that exports only Get-AgentAppToken and Invoke-AsAgentApp (SO C7). The
#     plaintext minting helper is module-private, so no exported command prints a token.
#   - Get-AgentAppToken returns a SecureString unless -AsPlainText is passed, so a bare call
#     cannot print a token into tool output or a transcript (C2). -AsPlainText exists only for
#     the single bash idiom:
#       GH_TOKEN="$(pwsh -NoProfile -c 'Import-Module ./operations/devops/AgentAppToken.psm1; Get-AgentAppToken -Role reviewer -AsPlainText')" gh ...
#     WARNING: that idiom forgoes C4 revocation, so its token stays valid for its full hour.
#     Prefer Invoke-AsAgentApp, which revokes when the block ends.
#     -NoProfile only skips the secrets the PowerShell profile loads; User-scope environment
#     variables (registry-persisted) are inherited by every process regardless (TL e/285#16).
#
# Usage:
#   Import-Module ./operations/devops/AgentAppToken.psm1
#   Invoke-AsAgentApp -Role reviewer -ScriptBlock { gh pr review 123 --approve --body '...' }

# App and installation IDs are not secret (t/4096#10). Gate Co-Location: they live here,
# at the point of use.
# Permissions are the role's set from the setup guide (t/4096#8), sent explicitly on every token
# request (TL ruling e/285#3 on C3) so each token's scope is visible on the wire. A role may only
# request permissions its App was granted; GitHub refuses anything wider.
$script:AgentApps = @{
    # Installation IDs are the AI-Rosetta-Stone org installations (PI, 2026-10-12, t/4096 org move).
    author     = @{ AppId = 5236085; InstallationId = 170627508; Slug = 'ai-triad-author-jpsnover'
                    Permissions = @{ contents = 'write'; pull_requests = 'write'; issues = 'write'; workflows = 'write'
                                     actions = 'read'; checks = 'read'; statuses = 'read' } }
    reviewer   = @{ AppId = 5236159; InstallationId = 170628507; Slug = 'ai-triad-reviewer-jpsnover'
                    Permissions = @{ contents = 'read'; pull_requests = 'write'; issues = 'write' } }
    maintainer = @{ AppId = 5236199; InstallationId = 170628840; Slug = 'ai-triad-maintainer-jpsnover'
                    Permissions = @{ contents = 'write'; pull_requests = 'write'; issues = 'write'; workflows = 'write'
                                     actions = 'write'; checks = 'read'; statuses = 'read' } }
}
$script:AgentAppVault = 'AiTriadAgentApps'

function ConvertTo-Base64Url {
    [CmdletBinding()]
    param([Parameter(Mandatory)][byte[]] $Bytes)
    [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function New-GitHubAppJwt {
    <#
    .SYNOPSIS
    PURE (no I/O). Builds the RS256-signed JWT a GitHub App uses to authenticate as itself.
    .DESCRIPTION
    iat is backdated 60s for clock skew; exp is 9 minutes out (GitHub's maximum is 10).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][long] $AppId,
        [Parameter(Mandatory)][string] $PrivateKeyPem,
        [datetimeoffset] $Now = [datetimeoffset]::UtcNow
    )
    $header  = @{ alg = 'RS256'; typ = 'JWT' } | ConvertTo-Json -Compress
    $payload = [ordered]@{
        iat = $Now.AddSeconds(-60).ToUnixTimeSeconds()
        exp = $Now.AddSeconds(540).ToUnixTimeSeconds()
        iss = "$AppId"
    } | ConvertTo-Json -Compress
    $enc = [Text.Encoding]::UTF8
    $signingInput = '{0}.{1}' -f (ConvertTo-Base64Url $enc.GetBytes($header)), (ConvertTo-Base64Url $enc.GetBytes($payload))
    $rsa = [Security.Cryptography.RSA]::Create()
    try {
        $rsa.ImportFromPem($PrivateKeyPem)
        $sig = $rsa.SignData($enc.GetBytes($signingInput), [Security.Cryptography.HashAlgorithmName]::SHA256,
            [Security.Cryptography.RSASignaturePadding]::Pkcs1)
    } finally {
        $rsa.Dispose()
    }
    '{0}.{1}' -f $signingInput, (ConvertTo-Base64Url $sig)
}

function Get-AgentAppToken {
    <#
    .SYNOPSIS
    Mints a 1-hour installation token for one agent role, scoped to one repository.
    Returns a SecureString unless -AsPlainText is passed (SO C2). Agents should use
    Invoke-AsAgentApp instead; -AsPlainText is only for the documented bash idiom.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][ValidateSet('author', 'reviewer', 'maintainer')][string] $Role,
        [ValidateSet('ai-triad-research', 'ai-triad-data')][string] $Repository = 'ai-triad-research',
        [switch] $AsPlainText,
        [string] $Vault = $script:AgentAppVault
    )
    $token = New-AgentAppInstallationToken -Role $Role -Repository $Repository -Vault $Vault
    if ($AsPlainText) { return $token }
    ConvertTo-SecureString -String $token -AsPlainText -Force
}

function New-AgentAppInstallationToken {
    # PRIVATE: returns the plaintext token. Called only by Get-AgentAppToken and
    # Invoke-AsAgentApp, which keep it out of the output stream.
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][ValidateSet('author', 'reviewer', 'maintainer')][string] $Role,
        [Parameter(Mandatory)][ValidateSet('ai-triad-research', 'ai-triad-data')][string] $Repository,
        [string] $Vault = $script:AgentAppVault
    )
    $ErrorActionPreference = 'Stop'
    $app = $script:AgentApps[$Role]
    $secretName = "ai-triad-$Role-key"
    try {
        $pem = Get-Secret -Vault $Vault -Name $secretName -AsPlainText
    } catch {
        throw (New-AgentAppTokenError -Problem "Could not read secret '$secretName' from vault '$Vault': $($_.Exception.Message)" `
            -NextSteps "Confirm the vault is registered (Get-SecretVault) and holds $secretName (Get-SecretInfo -Vault $Vault). The PI stores the keys (t/4096#10).")
    }
    $jwt = New-GitHubAppJwt -AppId $app.AppId -PrivateKeyPem $pem
    $pem = $null
    $uri = "https://api.github.com/app/installations/$($app.InstallationId)/access_tokens"
    $headers = @{ Authorization = "Bearer $jwt"; Accept = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28' }
    # C3: scope the token to exactly one repository instead of every repo the App is installed on.
    $body = @{ repositories = @($Repository); permissions = $app.Permissions } | ConvertTo-Json -Compress -Depth 3
    try {
        $resp = Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -Body $body -ContentType 'application/json'
    } catch {
        throw (New-AgentAppTokenError -Problem "GitHub refused to mint an installation token for $($app.Slug): $($_.Exception.Message)" `
            -NextSteps 'Check the App ID and Installation ID match the installed App, and that the private key is the current one for that App.')
    }
    $resp.token
}

function Invoke-AsAgentApp {
    <#
    .SYNOPSIS
    Runs a script block with GH_TOKEN set to a fresh token for the role, then restores the
    previous value, so the token never outlives the block.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][ValidateSet('author', 'reviewer', 'maintainer')][string] $Role,
        [Parameter(Mandatory)][scriptblock] $ScriptBlock,
        [ValidateSet('ai-triad-research', 'ai-triad-data')][string] $Repository = 'ai-triad-research'
    )
    $previous = $env:GH_TOKEN
    $token = $null
    try {
        $token = New-AgentAppInstallationToken -Role $Role -Repository $Repository
        $env:GH_TOKEN = $token
        & $ScriptBlock
    } finally {
        $env:GH_TOKEN = $previous
        # C4: revoke so the token lives only as long as the block. Best-effort: a failure here
        # does not fail the caller's work, but it is logged (fallback-path logging rule).
        if ($token) {
            try {
                Invoke-RestMethod -Method Delete -Uri 'https://api.github.com/installation/token' -Headers @{
                    Authorization = "Bearer $token"; Accept = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28'
                } | Out-Null
            } catch {
                Write-Warning "AgentAppToken: could not revoke the $Role token after use ($($_.Exception.Message)); it expires on its own within 1 hour."
            }
            $token = $null
        }
    }
}

function New-AgentAppTokenError {
    param([string] $Problem, [string] $NextSteps)
    $cmd = Get-Command New-ActionableError -ErrorAction SilentlyContinue
    if ($cmd) {
        return (New-ActionableError -Goal 'Mint a GitHub App installation token for an agent role (t/4096)' `
            -Problem $Problem -Location 'operations/devops/AgentAppToken.psm1' -NextSteps $NextSteps)
    }
    "Goal: Mint a GitHub App installation token for an agent role (t/4096)`nError: $Problem`nLocation: operations/devops/AgentAppToken.psm1`nResolve: $NextSteps"
}

# SO C7: only the two safe entry points leave the module.
Export-ModuleMember -Function Get-AgentAppToken, Invoke-AsAgentApp
