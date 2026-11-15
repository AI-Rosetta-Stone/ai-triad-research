# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Warn-only (t/4294): reads the Microsoft (Entra/AAD) sign-in app registration's credential
    list and warns when any `easyauth-*` client secret expires within -WarnDays (default 30).
.DESCRIPTION
    Thin impure shim over Get-SignInSecretExpiryVerdict (SignInSecretExpiryVerdict.ps1). Reads
    ONLY displayName and endDateTime (`--query` restricts the az output), never a secret value
    or hint.

    Always exits 0. The verdict goes to stdout, to $env:GITHUB_STEP_SUMMARY and $env:GITHUB_OUTPUT
    (`status=WARN|CLEAN|UNREADABLE`) when set, and to -OutputPath as JSON, for the workflow's
    issue step to read.

    Google and GitHub are NOT covered, and the output says so every run (see $ProviderGaps).
    Neither provider has a client-secret expiry to watch or an API that lists a client's secrets.
.PARAMETER AadAppId
    The sign-in Entra app registration's appId. The workflow passes secrets.AAD_CLIENT_ID, the
    same value deploy-azure.yml hands main.bicep as aadClientId (the app the container's
    auth config signs in with). Empty gives UNREADABLE, never clean.
.PARAMETER AzLoginOutcome
    Optional: the azure/login step's outcome. Anything other than 'success' gives UNREADABLE
    without calling az.
.PARAMETER WarnDays
    How many days ahead to warn. Default 30.
.PARAMETER OutputPath
    Where to write the JSON verdict. Default: signin-secret-expiry.json in the current directory.
.PARAMETER Now
    The current instant (for tests). Default: now, UTC.
.EXAMPLE
    ./operations/devops/Test-SignInSecretExpiry.ps1 -AadAppId (az containerapp auth microsoft show -n taxonomy-editor -g ai-triad --query registration.clientId -o tsv)
#>
[CmdletBinding()]
param(
    [AllowEmptyString()]
    [string]$AadAppId,

    [AllowEmptyString()]
    [string]$AzLoginOutcome,

    [ValidateRange(1, 365)]
    [int]$WarnDays = 30,

    [string]$OutputPath = 'signin-secret-expiry.json',

    [datetimeoffset]$Now = [datetimeoffset]::UtcNow
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'SignInSecretExpiryVerdict.ps1')

# Researched for t/4294 (2026-11-09). Printed on every run so a CLEAN result is never read as
# covering all three sign-in providers.
$ProviderGaps = @(
    'GAP (Google): NOT checked. Google OAuth web-client secrets carry no expiry date, and Google exposes no API that lists a web client''s secrets (Cloud Console only; the IAP oauth-clients API covers IAP clients only). Not covered here: Google deletes OAuth clients that are unused for 6 months.'
    'GAP (GitHub): NOT checked. GitHub OAuth App client secrets do not expire, and GitHub has no REST endpoint that lists them (Developer settings UI only). Not covered here: GitHub revokes a client secret it detects as leaked.'
)

$credentials = $null
$readError = $null

if ($AzLoginOutcome -and $AzLoginOutcome -ne 'success') {
    $readError = "Azure OIDC login did not succeed (outcome '$AzLoginOutcome'), so the credential list was not read"
} elseif ([string]::IsNullOrWhiteSpace($AadAppId)) {
    $readError = 'the sign-in app ID is empty (secrets.AAD_CLIENT_ID was not available to this job)'
} elseif (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    $readError = 'the az CLI is not on PATH'
} else {
    $global:LASTEXITCODE = 0
    $raw = @(& az ad app credential list --id $AadAppId `
            --query '[].{displayName:displayName,endDateTime:endDateTime}' -o json 2>&1)
    $exit = $LASTEXITCODE
    $stderr = @($raw | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] } | ForEach-Object { $_.ToString() })
    $stdout = @($raw | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] }) -join "`n"
    if ($exit -ne 0) {
        $detail = (@($stderr | Where-Object { $_ -match '\S' }) -join ' ').Trim()
        if (-not $detail) { $detail = '(no error text)' }
        if ($detail.Length -gt 300) { $detail = $detail.Substring(0, 300) + '...' }
        $readError = "az ad app credential list failed (exit $exit): $detail"
        if ($detail -match 'Insufficient privileges|Authorization_RequestDenied|403|Forbidden') {
            $readError += ' -- the OIDC identity has no Microsoft Graph read access to app registrations (needs Application.Read.All; granting it is a PI decision, t/4294)'
        }
    } else {
        try {
            $credentials = @($stdout | ConvertFrom-Json)
        } catch {
            $readError = "az ad app credential list returned output that is not JSON: $($_.Exception.Message)"
        }
    }
}

$verdict = Get-SignInSecretExpiryVerdict -Credentials $credentials -ReadError $readError -Now $Now -WarnDays $WarnDays

Write-Host "Sign-in secret expiry (t/4294), Microsoft (Entra) app: $($verdict.Message)"
foreach ($c in $verdict.Checked) {
    Write-Host "  $($c.displayName): endDateTime $($c.endDateTime), $($c.daysLeft) day(s) left"
}
if ($verdict.IgnoredCount -gt 0) {
    Write-Host "  ($($verdict.IgnoredCount) credential(s) not named easyauth-* ignored: not the sign-in secret)"
}
foreach ($g in $ProviderGaps) { Write-Host $g }

if ($verdict.Status -ne 'CLEAN') {
    Write-Host "::warning title=Sign-in secret expiry $($verdict.Status) (t/4294)::$($verdict.Message)"
}
if ($verdict.Status -eq 'UNREADABLE') {
    Write-Warning "Fallback: no expiry verdict for the Microsoft sign-in secret this run, reported as UNREADABLE (not clean). Reason: $($verdict.Reason)"
}

$result = [ordered]@{
    status       = $verdict.Status
    reason       = $verdict.Reason
    message      = $verdict.Message
    warnDays     = $verdict.WarnDays
    expiring     = @($verdict.Expiring)
    checked      = @($verdict.Checked)
    ignoredCount = $verdict.IgnoredCount
    providerGaps = $ProviderGaps
}
$result | ConvertTo-Json -Depth 5 | Set-Content -Path $OutputPath -Encoding utf8

if ($env:GITHUB_OUTPUT) {
    Add-Content -Path $env:GITHUB_OUTPUT -Value "status=$($verdict.Status)"
}
if ($env:GITHUB_STEP_SUMMARY) {
    $summary = [System.Collections.Generic.List[string]]::new()
    $summary.Add('## Sign-in secret expiry (t/4294)')
    $summary.Add('')
    $summary.Add("**Microsoft (Entra): $($verdict.Status)**: $($verdict.Reason)")
    foreach ($c in $verdict.Checked) { $summary.Add("- ``$($c.displayName)``: $($c.endDateTime) ($($c.daysLeft) day(s) left)") }
    $summary.Add('')
    foreach ($g in $ProviderGaps) { $summary.Add("- $g") }
    Add-Content -Path $env:GITHUB_STEP_SUMMARY -Value ($summary -join "`n")
}

exit 0
