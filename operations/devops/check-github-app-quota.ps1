# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    t/4587 part (b): warn-only preflight on a GitHub App installation's remaining rate-limit
    quota, run right before deploy-azure.yml / deploy-staging.yml shift traffic to a new
    revision -- the exact moment a cold boot could spend the quota the sync App shares with
    whatever is about to start serving.
.DESCRIPTION
    Mints a short-lived installation token (JWT -> POST /app/installations/{id}/access_tokens,
    same signing shape as AgentAppToken.psm1's New-GitHubAppJwt, but standalone: this checks the
    SYNC app's installations (ai-triad-taxonomy-sync[-staging]), not the per-role agent-attribution
    apps that module is scoped to), queries GET /rate_limit, revokes the token, and emits
    ::warning:: via Get-GitHubAppQuotaVerdict when remaining is under the ceiling.

    DETECTION ONLY. Never fails the step (always exits 0) -- this is explicitly T1 warn-only
    per the ticket's own tier call; a blocking version is a separate future T2.
.PARAMETER AppId
    The GitHub App's numeric id (not secret, t/4096#10 precedent).
.PARAMETER InstallationId
    The App's installation id on the target org (not secret).
.PARAMETER PrivateKeyPem
    The App's PEM private key, read by the caller from Key Vault and passed in -- this script
    never reads a vault itself, so it stays testable without any Azure dependency.
.PARAMETER Ceiling
    Passed through to Get-GitHubAppQuotaVerdict. Default 1000 per the ticket's ask.
.PARAMETER Label
    A short name for the annotation (e.g. "prod" / "staging") so a dual-call site's two
    warnings are distinguishable in the workflow log.
#>
param(
    [Parameter(Mandatory)][string] $AppId,
    [Parameter(Mandatory)][string] $InstallationId,
    [Parameter(Mandatory)][string] $PrivateKeyPem,
    [int] $Ceiling = 1000,
    [string] $Label = 'installation'
)

. (Join-Path $PSScriptRoot 'GitHubAppQuotaVerdict.ps1')

function ConvertTo-Base64UrlLocal {
    param([byte[]] $Bytes)
    [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function New-SyncAppJwtLocal {
    # Same RS256 JWT shape as AgentAppToken.psm1's New-GitHubAppJwt (iat backdated 60s for
    # clock skew, exp 9 minutes out -- GitHub's max is 10) -- duplicated here deliberately so
    # this script has zero dependency on the unrelated per-role agent-app module.
    param([string] $AppId, [string] $PrivateKeyPem)
    $now = [datetimeoffset]::UtcNow
    $header  = @{ alg = 'RS256'; typ = 'JWT' } | ConvertTo-Json -Compress
    $payload = [ordered]@{
        iat = $now.AddSeconds(-60).ToUnixTimeSeconds()
        exp = $now.AddSeconds(540).ToUnixTimeSeconds()
        iss = "$AppId"
    } | ConvertTo-Json -Compress
    $enc = [Text.Encoding]::UTF8
    $signingInput = '{0}.{1}' -f (ConvertTo-Base64UrlLocal $enc.GetBytes($header)), (ConvertTo-Base64UrlLocal $enc.GetBytes($payload))
    $rsa = [Security.Cryptography.RSA]::Create()
    try {
        $rsa.ImportFromPem($PrivateKeyPem)
        $sig = $rsa.SignData($enc.GetBytes($signingInput), [Security.Cryptography.HashAlgorithmName]::SHA256,
            [Security.Cryptography.RSASignaturePadding]::Pkcs1)
    } finally {
        $rsa.Dispose()
    }
    '{0}.{1}' -f $signingInput, (ConvertTo-Base64UrlLocal $sig)
}

$remaining = $null
$queryError = $null
$installationToken = $null
try {
    $jwt = New-SyncAppJwtLocal -AppId $AppId -PrivateKeyPem $PrivateKeyPem
    $tokenHeaders = @{ Authorization = "Bearer $jwt"; Accept = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28' }
    $tokenResp = Invoke-RestMethod -Method Post -Uri "https://api.github.com/app/installations/$InstallationId/access_tokens" `
        -Headers $tokenHeaders -ContentType 'application/json'
    $installationToken = $tokenResp.token

    $rlHeaders = @{ Authorization = "Bearer $installationToken"; Accept = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28' }
    $rl = Invoke-RestMethod -Uri 'https://api.github.com/rate_limit' -Headers $rlHeaders -Method Get
    if ($rl.rate -and $rl.rate.PSObject.Properties['remaining']) {
        $remaining = [int]$rl.rate.remaining
    }
} catch {
    $queryError = $_.Exception.Message
} finally {
    if ($installationToken) {
        try {
            Invoke-RestMethod -Method Delete -Uri 'https://api.github.com/installation/token' -Headers @{
                Authorization = "Bearer $installationToken"; Accept = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28'
            } | Out-Null
        } catch {
            # Best-effort revoke, matching AgentAppToken.psm1's C4 pattern -- a failure here never
            # fails the preflight; the token expires on its own within the hour regardless.
            Write-Warning "check-github-app-quota ($Label): could not revoke the probe token ($($_.Exception.Message)); it expires on its own within 1 hour."
        }
    }
}

$verdict = Get-GitHubAppQuotaVerdict -Remaining $remaining -Ceiling $Ceiling -QueryError $queryError
if ($verdict.ShouldWarn) {
    Write-Host "::warning::t/4587 quota preflight ($Label): $($verdict.Reason)"
} else {
    Write-Host "t/4587 quota preflight ($Label): $($verdict.Reason)"
}
exit 0
