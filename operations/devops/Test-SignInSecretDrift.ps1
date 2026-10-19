# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Warn-only pre-deploy check (t/4288): compares each live container-app sign-in secret (on
    BOTH prod and staging) against the value the next deploy would apply from its GitHub Actions
    secret. Never prints either value — reads the live secret, masks it immediately, and
    compares SHA-256 hashes only.
.DESCRIPTION
    Root cause of the 2026-10-19 incident: a container-secret-only manual fix was silently
    reverted by the next ordinary deploy, because deploys always re-apply the GitHub-sourced
    secret to BOTH prod and staging (same `main.bicep` apply, same Entra app registration), with
    no signal that doing so would change anything live. This check makes that signal visible
    BEFORE the apply, every deploy, without ever reading a secret value into a log.

    SO review (e/320, C1/C2): checks prod AND staging (a single apply affects both — that's what
    broke staging on 2026-10-19), and reports three states per app per secret: `match`,
    `match-after-trim` (a CRLF-only difference, e.g. from `$plainValue | gh secret set` — see
    e/319#4), or `MISMATCH` (a genuinely different value).
.PARAMETER ResourceGroup
    Azure resource group. Default: ai-triad.
.PARAMETER ContainerAppNames
    Azure Container App names to check. Default: taxonomy-editor and taxonomy-editor-staging —
    both share the same secret names and Entra app registration, so a single deploy's apply
    affects both.
.PARAMETER DeploySourceValues
    Hashtable of { ContainerSecretName = plaintextValue }. The caller (the workflow) builds this
    from its own `secrets.*` context — GitHub Actions masks anything from `secrets.*` in logs
    automatically, so passing the plaintext in-process here is safe; this script never writes
    it anywhere.
.OUTPUTS
    One line per app per secret: "<app>/<name>: match" / "<app>/<name>: match-after-trim" /
    "<app>/<name>: MISMATCH". Never the value or its hash. Any non-match state is also appended
    to $env:GITHUB_STEP_SUMMARY when that variable is set (SO C3). Always exits 0 (warn-only,
    per t/4288's acceptance criteria — promotion to blocking is a separate T2 decision, tracked
    as a follow-up, e/320).
#>
[CmdletBinding()]
param(
    [string]$ResourceGroup = 'ai-triad',
    [string[]]$ContainerAppNames = @('taxonomy-editor', 'taxonomy-editor-staging'),
    [Parameter(Mandatory)][hashtable]$DeploySourceValues
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-Sha256Hex([string]$Value) {
    [System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::HashData([System.Text.Encoding]::UTF8.GetBytes($Value))).Replace('-', '').ToLowerInvariant()
}

$anyNonMatch = $false
$summaryLines = [System.Collections.Generic.List[string]]::new()

foreach ($containerAppName in $ContainerAppNames) {
    foreach ($containerSecretName in $DeploySourceValues.Keys) {
        $label = "$containerAppName/$containerSecretName"
        $deployValue = $DeploySourceValues[$containerSecretName]
        if ([string]::IsNullOrEmpty($deployValue)) {
            Write-Host "$label`: skipped (no deploy-source value configured for this environment)"
            continue
        }

        $liveValue = az containerapp secret show -n $containerAppName -g $ResourceGroup --secret-name $containerSecretName --query value -o tsv 2>$null
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrEmpty($liveValue)) {
            Write-Host "::warning::$label`: could not read the live value (secret may not exist yet) — skipping drift check for it."
            continue
        }
        # Mask immediately — this is the ONLY point in this script where the live value exists as
        # a plain string. Never Write-Host it, never include it in an exception message below.
        Write-Host "::add-mask::$liveValue"

        $liveHash = Get-Sha256Hex $liveValue
        $deployHash = Get-Sha256Hex $deployValue
        $liveTrimmedHash = Get-Sha256Hex $liveValue.Trim()
        $deployTrimmedHash = Get-Sha256Hex $deployValue.Trim()
        $liveValue = $null
        $deployValue = $null

        if ($liveHash -eq $deployHash) {
            Write-Host "$label`: match"
        } elseif ($liveTrimmedHash -eq $deployTrimmedHash) {
            $msg = "$label`: match-after-trim — exact bytes differ (likely a trailing CRLF from a PowerShell pipe, e.g. \`gh secret set\`), but the trimmed value is the same secret. Still worth fixing the GitHub copy before it reaches a real auth exchange."
            Write-Host "::warning::$msg"
            $summaryLines.Add("- $msg")
            $anyNonMatch = $true
        } else {
            $msg = "$label`: MISMATCH — this deploy would change the sign-in secret. If that's not intentional, the container-app copy was likely changed by hand since the last deploy (t/4288 pattern) — rotate properly with Rotate-SignInSecret.ps1 instead of letting this deploy silently overwrite it."
            Write-Host "::warning::$msg"
            $summaryLines.Add("- $msg")
            $anyNonMatch = $true
        }
    }
}

if ($anyNonMatch) {
    Write-Host "`nOne or more sign-in secrets would change on this deploy, or differ only by whitespace. Warn-only (t/4288) — proceeding."
    if ($env:GITHUB_STEP_SUMMARY) {
        $summaryHeader = "## Sign-in secret drift check (t/4288)`n"
        Add-Content -Path $env:GITHUB_STEP_SUMMARY -Value ($summaryHeader + ($summaryLines -join "`n"))
    }
}
exit 0
