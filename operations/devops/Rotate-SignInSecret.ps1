# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# R5 gate (t/4288, SO e/318): a code comment here is invisible to someone who runs the script
# directly, so the warning is emitted at runtime instead (see Write-Warning below). Remove both
# once R5 is recorded on t/4288.

<#
.SYNOPSIS
    Rotates one sign-in client secret (Microsoft/AAD, Google, or GitHub), writing the GitHub
    Actions secret and BOTH the prod and staging container-app secrets together, and refuses to
    delete any old credential until the new one is confirmed present AND a sign-in has been
    confirmed working.
.DESCRIPTION
    t/4288 (2026-10-19): two outages from manual, un-sequenced secret rotation, plus a Second
    Opinion review (e/318, p/331) that found the first version of THIS script would have
    recreated outage 2. Fixed per that review (R1-R4 below):
      - R1: `az ad app credential reset` WITHOUT `--append` overwrites every existing password
        credential — the old secret would die before GitHub/container/restart ever ran. Fixed
        by always passing `--append`.
      - R2: the old version matched the new credential by `customKeyIdentifier`, which
        `--display-name` never sets (it sets `displayName`) — the match always failed closed by
        accident, and a forced deletion would have hit every OTHER credential on the app
        registration, not just prior rotations. Fixed by snapshotting keyIds before/after the
        reset and identifying the new credential by the keyId diff; deletion defaults to only
        prior `easyauth-*`-named credentials, never an unrelated one, and is always shown to the
        operator before it runs.
      - R3: `authConfigStaging` (main.bicep) uses the SAME secret names and the SAME Entra app
        registration as prod — the old version only touched `taxonomy-editor`, so Phase 2's
        deletion would silently break staging sign-in. Fixed by writing/restarting BOTH
        `taxonomy-editor` and `taxonomy-editor-staging`, and requiring sign-in confirmation on
        both before any deletion.
      - R4: revision restarts were fire-and-forget with no exit-code check, and only the single
        `trafficWeight==100` revision was restarted (missing a split-traffic case). Fixed to
        restart every revision with traffic > 0 on both apps and throw on any restart failure.
    R5 (SO e/318): before first real use on a real app registration, dry-run this script against
    a throwaway Entra app registration (GitHub/container writes pointed at scratch targets or
    skipped) and record the credential lists before/after on t/4288. That is a pre-first-use
    gate, not a merge gate — see the runbook.
.PARAMETER Provider
    'aad' | 'google' | 'github' — which sign-in secret to rotate.
.PARAMETER NewSecretValue
    Required for Google/GitHub (the new value from that provider's console). Omit for AAD —
    the script generates it via `az ad app credential reset --append` and never displays it.
.PARAMETER AadAppId
    The Entra app registration's appId. Required when -Provider aad.
.PARAMETER ResourceGroup
    Azure resource group. Default: ai-triad.
.PARAMETER ContainerAppName
    Azure Container App name (prod). The matching staging app
    (`<ContainerAppName>-staging`) is always updated alongside it — both share the same secret
    names and the same Entra app registration. Default: taxonomy-editor.
.PARAMETER SkipDelete
    Writes the new secret and restarts both apps, but stops before the deletion phase — use this
    to rotate without immediately retiring the old credential (e.g. a scheduled rotation where
    the old one isn't known-bad yet).
.EXAMPLE
    ./Rotate-SignInSecret.ps1 -Provider aad -AadAppId 51dee973-5497-47f8-a749-68603cbe8c8f
.EXAMPLE
    ./Rotate-SignInSecret.ps1 -Provider google -NewSecretValue (Read-Host -AsSecureString 'New Google client secret')
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)]
    [ValidateSet('aad', 'google', 'github')]
    [string]$Provider,

    [System.Security.SecureString]$NewSecretValue,

    [string]$AadAppId,

    [string]$ResourceGroup = 'ai-triad',

    [string]$ContainerAppName = 'taxonomy-editor',

    [switch]$SkipDelete
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Write-Warning "DO NOT use this script for a real rotation until R5 is recorded on t/4288 (SO review, e/318): a dry run against a throwaway Entra app registration, with credential lists before/after recorded on the ticket, AND proof that the GitHub-secret copy works (not just the container copies) — run a real deploy that re-applies AAD_CLIENT_SECRET/etc. and confirm sign-in, before Phase 2. Remove this warning once R5 is recorded on t/4288."

function New-ActionableError {
    param([string]$Goal, [string]$Problem, [string]$Location, [string]$NextSteps)
    "Goal: $Goal`nProblem: $Problem`nLocation: $Location`nResolve: $NextSteps"
}

$providerMap = @{
    aad    = @{ GitHubSecret = 'AAD_CLIENT_SECRET'; ContainerSecret = 'aad-client-secret'; DisplayName = 'Microsoft (AAD)' }
    google = @{ GitHubSecret = 'GOOGLE_CLIENT_SECRET'; ContainerSecret = 'google-client-secret'; DisplayName = 'Google' }
    # t/4418: GH_OAUTH_CLIENT_SECRET is what deploy-azure.yml's apply reads; GitHub rejects GITHUB_* secret names.
    github = @{ GitHubSecret = 'GH_OAUTH_CLIENT_SECRET'; ContainerSecret = 'github-client-secret'; DisplayName = 'GitHub' }
}
$cfg = $providerMap[$Provider]
$apps = @($ContainerAppName, "$ContainerAppName-staging")

if ($Provider -eq 'aad' -and -not $AadAppId) {
    throw (New-ActionableError -Goal 'Rotate the Microsoft sign-in secret' `
        -Problem '-AadAppId was not supplied' `
        -Location 'Rotate-SignInSecret.ps1 -Provider aad' `
        -NextSteps 'Pass -AadAppId <the Entra app registration appId>, e.g. 51dee973-5497-47f8-a749-68603cbe8c8f')
}
if ($Provider -ne 'aad' -and -not $NewSecretValue) {
    throw (New-ActionableError -Goal "Rotate the $($cfg.DisplayName) sign-in secret" `
        -Problem '-NewSecretValue was not supplied' `
        -Location "Rotate-SignInSecret.ps1 -Provider $Provider" `
        -NextSteps "Generate a new client secret in $($cfg.DisplayName)'s own console first, then pass it as -NewSecretValue (SecureString).")
}

function Restart-AllActiveRevisions {
    param([string]$App, [string]$Rg)
    $names = az containerapp revision list -n $App -g $Rg --query "[?properties.trafficWeight > ``0``].name" -o tsv
    if ($LASTEXITCODE -ne 0) {
        throw (New-ActionableError -Goal "Restart $App so the new secret takes effect" `
            -Problem "az containerapp revision list failed (exit $LASTEXITCODE)" `
            -Location "Rotate-SignInSecret.ps1, Restart-AllActiveRevisions($App)" `
            -NextSteps "Check the app name/resource group and re-run, or restart manually: az containerapp revision restart -n $App -g $Rg --revision <name>")
    }
    $revisionNames = @($names -split "`n" | Where-Object { $_ })
    if (@($revisionNames).Count -eq 0) {
        throw (New-ActionableError -Goal "Restart $App so the new secret takes effect" `
            -Problem 'No revision has traffic > 0 — nothing to restart, which means the new secret is written but not yet live anywhere.' `
            -Location "Rotate-SignInSecret.ps1, Restart-AllActiveRevisions($App)" `
            -NextSteps "Investigate $App's traffic split: az containerapp revision list -n $App -g $Rg -o table")
    }
    foreach ($rev in $revisionNames) {
        az containerapp revision restart -n $App -g $Rg --revision $rev 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw (New-ActionableError -Goal "Restart $App so the new secret takes effect" `
                -Problem "az containerapp revision restart failed for revision '$rev' (exit $LASTEXITCODE)" `
                -Location "Rotate-SignInSecret.ps1, Restart-AllActiveRevisions($App)" `
                -NextSteps "Retry by hand: az containerapp revision restart -n $App -g $Rg --revision $rev — do not proceed to deletion until every app has actually restarted.")
        }
        Write-Host "  Restarted $App revision '$rev'." -ForegroundColor Green
    }
}

Write-Host "=== Rotating $($cfg.DisplayName) sign-in secret ===" -ForegroundColor Cyan
Write-Host "Before you continue: ping the Computational Linguist — the revision restarts at the end of this script will kill any in-flight inquiry (t/4288 lesson)." -ForegroundColor Yellow
Write-Host "This will update BOTH $($apps -join ' and ') — they share the same Entra app registration and secret names (t/4288 SO review, e/318)." -ForegroundColor Yellow

# ── Phase 1: generate/obtain the new value, write BOTH copies on BOTH apps, restart ──────
$plainValue = $null
$newCredKeyId = $null
$newDisplayName = $null
$beforeCreds = $null

if ($Provider -eq 'aad') {
    $beforeCreds = @(az ad app credential list --id $AadAppId --query '[].{keyId:keyId,displayName:displayName,hint:hint}' -o json | ConvertFrom-Json)
    $newDisplayName = "easyauth-$(Get-Date -Format 'yyyy-MM-dd-HHmmss')"
    if ($PSCmdlet.ShouldProcess($AadAppId, "az ad app credential reset --append (new credential: $newDisplayName)")) {
        # --append is load-bearing (SO e/318 R1): WITHOUT it, `reset` REPLACES every existing
        # password credential, killing the old secret before GitHub/container/restart ever run —
        # that's outage 2, built into the command. The value is captured straight into a
        # variable and never echoed — `reset` prints it to stdout by default, so we request JSON
        # and read the field, never -o tsv to a terminal. Still never Write-Host it anywhere.
        $credResultJson = az ad app credential reset --id $AadAppId --append --display-name $newDisplayName --years 1 --query '{password:password}' -o json 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $credResultJson) {
            throw (New-ActionableError -Goal 'Create a new Entra client-secret credential' `
                -Problem 'az ad app credential reset failed or returned nothing' `
                -Location "Rotate-SignInSecret.ps1, az ad app credential reset --id $AadAppId" `
                -NextSteps 'Confirm the appId is correct and the caller has Application.ReadWrite.OwnedBy (or equivalent) on this app registration.')
        }
        $credResult = $credResultJson | ConvertFrom-Json
        $plainValue = $credResult.password

        # R2: identify the new credential by the keyId DIFF, never by display-name matching
        # against customKeyIdentifier (which --display-name never sets — the old version's match
        # always failed closed by accident, not by design).
        $afterCreds = @(az ad app credential list --id $AadAppId --query '[].{keyId:keyId,displayName:displayName,hint:hint}' -o json | ConvertFrom-Json)
        $beforeKeyIds = @($beforeCreds | ForEach-Object { $_.keyId })
        $newCreds = @($afterCreds | Where-Object { $_.keyId -notin $beforeKeyIds })
        if (@($newCreds).Count -ne 1) {
            throw (New-ActionableError -Goal 'Identify the new credential before writing it anywhere' `
                -Problem "Expected exactly 1 new keyId after reset --append, found $(@($newCreds).Count)" `
                -Location 'Rotate-SignInSecret.ps1, Phase 1 keyId diff' `
                -NextSteps "Inspect az ad app credential list --id $AadAppId by hand before proceeding — do not guess which credential is the new one.")
        }
        $newCredKeyId = $newCreds[0].keyId
        Write-Host "New credential confirmed: keyId $newCredKeyId (displayName '$newDisplayName')." -ForegroundColor Green
    }
} else {
    $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($NewSecretValue)
    try { $plainValue = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
    finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

if ($PSCmdlet.ShouldProcess('GitHub + Azure Container Apps (prod + staging)', "write $($cfg.GitHubSecret) / $($cfg.ContainerSecret)")) {
    # GitHub secret first (t/4288 ordering: so the NEXT ordinary deploy doesn't silently revert
    # a container-only change, same root cause as the 10-19 incident).
    $plainValue | gh secret set $cfg.GitHubSecret -R AI-Rosetta-Stone/ai-triad-research 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw (New-ActionableError -Goal 'Write the GitHub Actions secret' `
            -Problem "gh secret set $($cfg.GitHubSecret) failed (exit $LASTEXITCODE)" `
            -Location 'Rotate-SignInSecret.ps1, Phase 1' `
            -NextSteps 'Check gh auth status and repo write access, then re-run.')
    }

    foreach ($app in $apps) {
        az containerapp secret set -n $app -g $ResourceGroup --secrets "$($cfg.ContainerSecret)=$plainValue" 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw (New-ActionableError -Goal "Write the Azure Container App secret on $app" `
                -Problem "az containerapp secret set failed (exit $LASTEXITCODE)" `
                -Location 'Rotate-SignInSecret.ps1, Phase 1' `
                -NextSteps "The GitHub secret ($($cfg.GitHubSecret)) was already updated, and other app(s) in $($apps -join ', ') may already be updated too — the copies are now OUT OF SYNC across $($apps -join '/'). Re-run 'az containerapp secret set' by hand for $app with the same value before doing anything else.")
        }
    }

    Write-Host "All copies written on $($apps -join ' and '). Restarting active revisions..." -ForegroundColor Cyan
    foreach ($app in $apps) {
        Restart-AllActiveRevisions -App $app -Rg $ResourceGroup
    }
}
$plainValue = $null  # drop the in-memory copy now that both writes are done

# ── Phase 2: HARD gate — verify new credential exists AND sign-in confirmed on BOTH apps ──
if ($SkipDelete) {
    Write-Host "-SkipDelete set: rotation complete, no old credential removed. Re-run without -SkipDelete once you've confirmed sign-in works on both $($apps -join ' and ')." -ForegroundColor Yellow
    return
}

Write-Host "`n=== Phase 2: pre-deletion verification (t/4288 — never delete before this passes) ===" -ForegroundColor Cyan

if ($Provider -eq 'aad') {
    $creds = @(az ad app credential list --id $AadAppId --query '[].{displayName:displayName,hint:hint,keyId:keyId}' -o json | ConvertFrom-Json)
    $newCred = @($creds | Where-Object { $_.keyId -eq $newCredKeyId })
    if (@($newCred).Count -eq 0) {
        throw (New-ActionableError -Goal 'Verify the new credential exists before deleting anything' `
            -Problem "az ad app credential list no longer shows keyId '$newCredKeyId'" `
            -Location 'Rotate-SignInSecret.ps1, Phase 2' `
            -NextSteps 'Do NOT delete any old credential. Investigate before re-running.')
    }
    Write-Host "Confirmed: the new credential (hint $($newCred[0].hint), displayName '$($newCred[0].displayName)') is listed on the app registration." -ForegroundColor Green
}

Write-Host "`nBefore anything is deleted: go test a $($cfg.DisplayName) sign-in against BOTH $($apps -join ' and ') right now." -ForegroundColor Yellow
$confirmation = Read-Host "Type the exact phrase 'sign-in confirmed' to proceed to deletion, or anything else to stop here"
if ($confirmation -ne 'sign-in confirmed') {
    Write-Host "Stopping before deletion — nothing old was removed. The new secret is live in both copies on both apps; re-run with -SkipDelete:`$false once sign-in is confirmed on both, or just run Phase 2 again." -ForegroundColor Yellow
    return
}

if ($Provider -eq 'aad') {
    # R2: default deletion candidates to ONLY prior rotation-created credentials
    # (displayName like 'easyauth-*'), never an unrelated credential someone else put on this
    # app registration. The operator is always shown the exact set before anything is deleted.
    $deletionCandidates = @($creds | Where-Object { $_.keyId -ne $newCredKeyId -and $_.displayName -like 'easyauth-*' })
    $otherCreds = @($creds | Where-Object { $_.keyId -ne $newCredKeyId -and $_.displayName -notlike 'easyauth-*' })
    if (@($otherCreds).Count -gt 0) {
        Write-Host "NOTE: $(@($otherCreds).Count) other credential(s) on this app registration are NOT prior rotations (displayName doesn't match 'easyauth-*') and will NOT be touched: $(($otherCreds | ForEach-Object { "$($_.displayName) (hint $($_.hint))" }) -join ', ')" -ForegroundColor Yellow
    }
    if (@($deletionCandidates).Count -eq 0) {
        Write-Host "No prior 'easyauth-*' credentials to delete." -ForegroundColor Green
    } else {
        Write-Host "Prior rotation credentials eligible for deletion:" -ForegroundColor Cyan
        for ($i = 0; $i -lt @($deletionCandidates).Count; $i++) {
            Write-Host "  [$i] $($deletionCandidates[$i].displayName) (hint $($deletionCandidates[$i].hint), keyId $($deletionCandidates[$i].keyId))"
        }
        $selection = Read-Host "Press Enter to delete ALL of the above, type comma-separated indices to delete only those, or 'none' to skip deletion"
        $toDelete = switch -Regex ($selection.Trim()) {
            '^$'     { $deletionCandidates; break }
            '^none$' { @(); break }
            default  {
                $indices = $selection -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [int]$_ }
                @($deletionCandidates[$indices])
            }
        }
        foreach ($old in $toDelete) {
            if ($PSCmdlet.ShouldProcess($AadAppId, "az ad app credential delete --key-id $($old.keyId) (was '$($old.displayName)', hint $($old.hint))")) {
                az ad app credential delete --id $AadAppId --key-id $old.keyId 2>&1 | Out-Null
                if ($LASTEXITCODE -ne 0) {
                    Write-Warning "Failed to delete credential keyId $($old.keyId) (hint $($old.hint)) — remove it by hand."
                } else {
                    Write-Host "Deleted old credential (hint $($old.hint))." -ForegroundColor Green
                }
            }
        }
    }
} else {
    Write-Host "$($cfg.DisplayName) client secrets aren't Entra credentials with a list/delete API — retire the old one in $($cfg.DisplayName)'s own console once you're ready." -ForegroundColor Yellow
}

Write-Host "`nRotation complete." -ForegroundColor Green
