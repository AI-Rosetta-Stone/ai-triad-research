# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Warn-only pre-deploy check (t/4288): compares each live container-app sign-in secret against
    the value the next deploy would apply from its GitHub Actions secret. Never prints either
    value — reads the live secret, masks it immediately, and compares SHA-256 hashes only.
.DESCRIPTION
    Root cause of the 2026-10-19 incident: a container-secret-only manual fix was silently
    reverted by the next ordinary deploy, because deploys always re-apply the GitHub-sourced
    secret and there was no signal that doing so would change anything live. This check makes
    that signal visible BEFORE the apply, every deploy, without ever reading a secret value
    into a log.
.PARAMETER ResourceGroup
    Azure resource group. Default: ai-triad.
.PARAMETER ContainerAppName
    Azure Container App name. Default: taxonomy-editor.
.PARAMETER DeploySourceValues
    Hashtable of { ContainerSecretName = plaintextValue }. The caller (the workflow) builds this
    from its own `secrets.*` context — GitHub Actions masks anything from `secrets.*` in logs
    automatically, so passing the plaintext in-process here is safe; this script never writes
    it anywhere.
.OUTPUTS
    One line per secret: "<name>: match" or "<name>: MISMATCH — this deploy would change the
    sign-in secret". Never the value or its hash. Always exits 0 (warn-only, per t/4288's
    acceptance criteria — promotion to blocking is a separate T2 decision).
#>
[CmdletBinding()]
param(
    [string]$ResourceGroup = 'ai-triad',
    [string]$ContainerAppName = 'taxonomy-editor',
    [Parameter(Mandatory)][hashtable]$DeploySourceValues
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$anyMismatch = $false

foreach ($containerSecretName in $DeploySourceValues.Keys) {
    $deployValue = $DeploySourceValues[$containerSecretName]
    if ([string]::IsNullOrEmpty($deployValue)) {
        Write-Host "$containerSecretName`: skipped (no deploy-source value configured for this environment)"
        continue
    }

    $liveValue = az containerapp secret show -n $ContainerAppName -g $ResourceGroup --secret-name $containerSecretName --query value -o tsv 2>$null
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrEmpty($liveValue)) {
        Write-Host "::warning::$containerSecretName`: could not read the live value (secret may not exist yet) — skipping drift check for it."
        continue
    }
    # Mask immediately — this is the ONLY point in this script where the live value exists as a
    # plain string. Never Write-Host it, never include it in an exception message below.
    Write-Host "::add-mask::$liveValue"

    $liveHash = [System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::HashData([System.Text.Encoding]::UTF8.GetBytes($liveValue))).Replace('-', '').ToLowerInvariant()
    $deployHash = [System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::HashData([System.Text.Encoding]::UTF8.GetBytes($deployValue))).Replace('-', '').ToLowerInvariant()
    $liveValue = $null
    $deployValue = $null

    if ($liveHash -eq $deployHash) {
        Write-Host "$containerSecretName`: match"
    } else {
        Write-Host "::warning::$containerSecretName`: MISMATCH — this deploy would change the sign-in secret. If that's not intentional, the container-app copy was likely changed by hand since the last deploy (t/4288 pattern) — rotate properly with Rotate-SignInSecret.ps1 instead of letting this deploy silently overwrite it."
        $anyMismatch = $true
    }
}

if ($anyMismatch) {
    Write-Host "`nOne or more sign-in secrets would change on this deploy. Warn-only (t/4288) — proceeding."
}
exit 0
