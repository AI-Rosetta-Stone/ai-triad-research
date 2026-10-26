# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Move-GitHubIdentityData {
    <#
    .SYNOPSIS
        Admin-only: copies one GitHub-derived identity's stored data onto a new id (t/4440).
    .DESCRIPTION
        Follow-up to t/4326: the server now canonicalizes GitHub's spoofable principal name
        into a stable-id-derived name (an IDENTITY_MAP entry, else a fresh `github-<id>`).
        Only 2 of the 15 pre-existing GitHub-shaped storage ids could be backfilled via
        IDENTITY_MAP; the other 13 are free-text display names/emails that can never be
        looked up, so their data is stranded under the old id until an admin recovers it.

        COPY-ONLY, never a move: -FromId's data is left untouched, so this is reversible and
        can be re-run. Nothing is looked up automatically — -FromId and -ToId are both
        required, explicit admin input (never derived from a name match).

        Copies, then verifies, each store:
          - `user-content/users/<FromId>/` -> `user-content/users/<ToId>/` (blob, recursive).
          - `/mnt/shared/preferences/<FromId>.json` -> `.../<ToId>.json` (the same Azure Files
            share AI_TRIAD_DATA_ROOT uses — confirmed in main.bicep — not blob storage), only
            if it exists for -FromId.
          - `calibration/users/<FromId>*`: checked, never copied. Its shape for a GitHub id is
            unspecified (Quality, t/4440#2 item 2), so a non-empty result is surfaced as a
            WARNing and in the returned object's Warnings, for an admin to migrate by hand —
            copying blind here would be the one place this cmdlet could write something wrong.

        Both blob and file copies are asynchronous: `az storage blob/file copy start` returns
        once the copy is QUEUED, not once it's done. Each copy is polled via
        Wait-AzStorageCopyComplete until it reports success/failed/aborted/timeout (Quality,
        t/4440#2 item 1) before verification runs.
    .PARAMETER FromId
        The old GitHub-derived directory id (a free-text display name/email, or a prior
        github-<id>) whose data should be copied.
    .PARAMETER ToId
        The target id (typically a fresh github-<id> the person now signs in as).
    .PARAMETER StorageAccount
        Storage account name. Default: auto-detected from resource group (same convention as
        Restore-TaxEditorBlob).
    .PARAMETER ResourceGroup
        Azure resource group name. Default: ai-triad.
    .PARAMETER PreferencesShare
        Azure Files share name holding the /mnt/shared preferences directory.
    .PARAMETER TimeoutSeconds
        Max time to wait for any one async copy to settle. Default 300.
    .OUTPUTS
        [pscustomobject] { Action; FromId; ToId; StorageAccount; Copies[]; Warnings[];
        AllVerified; Timestamp }. Copies[] carries one entry per blob/file actually copied:
        { Store; Source; Dest; SizeBytes; CopyStatus; Verified }.
    .EXAMPLE
        Move-GitHubIdentityData -FromId 'jsnover15@hotmail.com' -ToId 'jpsnover' -PreferencesShare 'shared'
    .EXAMPLE
        Move-GitHubIdentityData -FromId 'rich.gillin@kingcovefederal.com' -ToId 'github-48213099' -PreferencesShare 'shared' -WhatIf
    .LINK
        Show-AITriadHelp
    .LINK
        Get-TaxEditorBlob
    .LINK
        Restore-TaxEditorBlob
    #>
    [CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [string]$FromId,

        [Parameter(Mandatory)]
        [string]$ToId,

        [Parameter()]
        [string]$StorageAccount,

        [Parameter()]
        [string]$ResourceGroup = 'ai-triad',

        [Parameter(Mandatory)]
        [string]$PreferencesShare,

        [Parameter()]
        [ValidateRange(1, 3600)]
        [int]$TimeoutSeconds = 300
    )

    begin {
        Set-StrictMode -Version Latest
        $CallerName = 'Move-GitHubIdentityData'

        if ($FromId -eq $ToId) {
            throw (New-ActionableError -AsErrorRecord `
                -Goal 'Copy GitHub identity data' `
                -Problem "-FromId and -ToId are both '$FromId'" `
                -Location $CallerName `
                -NextSteps @('Pass a different -ToId'))
        }

        # ── Validate az CLI (same checks as Restore-TaxEditorBlob) ────────
        $AzCmd = Get-Command az -ErrorAction SilentlyContinue
        if (-not $AzCmd) {
            throw (New-ActionableError -AsErrorRecord `
                -Goal 'Copy GitHub identity data' `
                -Problem 'Azure CLI (az) not found on PATH' `
                -Location $CallerName `
                -NextSteps @('Install Azure CLI: https://aka.ms/installazurecli'))
        }

        $AccountJson = & az account show --output json 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $AccountJson) {
            throw (New-ActionableError -AsErrorRecord `
                -Goal 'Copy GitHub identity data' `
                -Problem 'Azure CLI is not logged in' `
                -Location $CallerName `
                -NextSteps @('Run: az login', 'Verify subscription: az account show'))
        }

        # ── Resolve storage account ───────────────────────────────────────
        if (-not $StorageAccount) {
            $AccountListJson = & az storage account list -g $ResourceGroup --query "[?starts_with(name,'staitriad')].name" -o json 2>$null
            if ($LASTEXITCODE -ne 0 -or -not $AccountListJson) {
                throw (New-ActionableError -AsErrorRecord `
                    -Goal 'Resolve storage account' `
                    -Problem "No storage accounts found in resource group '$ResourceGroup'" `
                    -Location $CallerName `
                    -NextSteps @('Pass -StorageAccount explicitly'))
            }
            $Accounts = $AccountListJson | ConvertFrom-Json
            if (@($Accounts).Count -eq 0) {
                throw (New-ActionableError -AsErrorRecord `
                    -Goal 'Resolve storage account' `
                    -Problem "No 'staitriad*' storage accounts found in '$ResourceGroup'" `
                    -Location $CallerName `
                    -NextSteps @('Pass -StorageAccount explicitly'))
            }
            $StorageAccount = $Accounts[0]
        }
    }

    process {
        if (-not $PSCmdlet.ShouldProcess("$FromId -> $ToId", "Copy GitHub identity data on '$StorageAccount'")) {
            return
        }

        $CopyLog = [System.Collections.Generic.List[object]]::new()
        $Warnings = [System.Collections.Generic.List[string]]::new()

        # ── 1. user-content blobs ─────────────────────────────────────────
        $SourcePrefix = "users/$FromId/"
        Write-Verbose "Listing blobs under user-content/$SourcePrefix..."
        $BlobListJson = & az storage blob list `
            --account-name $StorageAccount --container-name 'user-content' `
            --prefix $SourcePrefix --auth-mode login --output json 2>$null
        if ($LASTEXITCODE -ne 0) {
            throw (New-ActionableError -AsErrorRecord `
                -Goal "List blobs for '$FromId'" `
                -Problem "az storage blob list failed (exit code $LASTEXITCODE)" `
                -Location $CallerName `
                -NextSteps @('Check storage account access permissions'))
        }
        $SourceBlobs = @($BlobListJson | ConvertFrom-Json)
        if ($SourceBlobs.Count -eq 0) {
            $Warnings.Add("user-content/users/$FromId/ has no blobs — nothing to copy in this store.")
            Write-Warning $Warnings[-1]
        }

        foreach ($Blob in $SourceBlobs) {
            $RelPath = $Blob.name.Substring($SourcePrefix.Length)
            $DestBlobName = "users/$ToId/$RelPath"
            $SourceUri = "https://$StorageAccount.blob.core.windows.net/user-content/$($Blob.name)"

            Write-Verbose "Copying blob '$($Blob.name)' -> '$DestBlobName'..."
            $null = & az storage blob copy start `
                --account-name $StorageAccount --destination-container 'user-content' --destination-blob $DestBlobName `
                --source-uri $SourceUri --auth-mode login --output none 2>$null
            if ($LASTEXITCODE -ne 0) {
                throw (New-ActionableError -AsErrorRecord `
                    -Goal "Copy blob '$($Blob.name)'" `
                    -Problem "az storage blob copy start failed (exit code $LASTEXITCODE)" `
                    -Location $CallerName `
                    -NextSteps @('Check destination container/path permissions', 'Re-run — the copy is idempotent (copy-only, not a move)'))
            }

            # No .GetNewClosure(): invoked synchronously right here (never deferred past this loop
            # iteration), and GetNewClosure() detaches the scriptblock from the module's command
            # table — Pester's -ModuleName AITriad mock of `az` then silently misses, and every poll
            # falls through to a real (failing) `az` call, masked by 2>$null, until it times out.
            $CopyStatus = Wait-AzStorageCopyComplete -TimeoutSeconds $TimeoutSeconds -GetStatus ({
                $PropsJson = & az storage blob show --account-name $StorageAccount --container-name 'user-content' `
                    --name $DestBlobName --auth-mode login --query 'properties.copy.status' --output tsv 2>$null
                if ($LASTEXITCODE -eq 0) { "$PropsJson".Trim() } else { $null }
            })

            $DestShow = & az storage blob show --account-name $StorageAccount --container-name 'user-content' `
                --name $DestBlobName --auth-mode login --output json 2>$null
            $DestProps = if ($LASTEXITCODE -eq 0 -and $DestShow) { $DestShow | ConvertFrom-Json } else { $null }
            $Verified = ($CopyStatus -eq 'success') -and $DestProps -and
                ([int64]$DestProps.properties.contentLength -eq [int64]$Blob.properties.contentLength)

            $CopyLog.Add([pscustomobject]@{
                Store      = 'user-content'
                Source     = $Blob.name
                Dest       = $DestBlobName
                SizeBytes  = $Blob.properties.contentLength
                CopyStatus = $CopyStatus
                Verified   = $Verified
            })
            if (-not $Verified) {
                Write-Warning "Copy of '$($Blob.name)' did not verify (copy status: $CopyStatus)."
            }
        }

        # ── 2. /mnt/shared/preferences/<FromId>.json (Azure Files, not blob) ──
        $PrefSourcePath = "preferences/$FromId.json"
        $PrefDestPath = "preferences/$ToId.json"
        Write-Verbose "Checking for preferences file '$PrefSourcePath'..."
        $PrefShowJson = & az storage file list `
            --account-name $StorageAccount --share-name $PreferencesShare `
            --path 'preferences' --auth-mode login --query "[?name=='$FromId.json']" --output json 2>$null
        $PrefExists = ($LASTEXITCODE -eq 0) -and $PrefShowJson -and (@($PrefShowJson | ConvertFrom-Json).Count -gt 0)

        if ($PrefExists) {
            $SourceFileUri = "https://$StorageAccount.file.core.windows.net/$PreferencesShare/$PrefSourcePath"
            Write-Verbose "Copying preferences file -> '$PrefDestPath'..."
            $null = & az storage file copy start `
                --account-name $StorageAccount --destination-share $PreferencesShare --destination-path $PrefDestPath `
                --source-uri $SourceFileUri --output none 2>$null
            if ($LASTEXITCODE -ne 0) {
                throw (New-ActionableError -AsErrorRecord `
                    -Goal 'Copy preferences file' `
                    -Problem "az storage file copy start failed (exit code $LASTEXITCODE)" `
                    -Location $CallerName `
                    -NextSteps @('Check the Azure Files share name and permissions'))
            }

            $PrefCopyStatus = Wait-AzStorageCopyComplete -TimeoutSeconds $TimeoutSeconds -GetStatus ({
                $StatusTsv = & az storage file show --account-name $StorageAccount --share-name $PreferencesShare `
                    --path $PrefDestPath --query 'copy.status' --output tsv 2>$null
                if ($LASTEXITCODE -eq 0) { "$StatusTsv".Trim() } else { $null }
            })

            $PrefDestShow = & az storage file show --account-name $StorageAccount --share-name $PreferencesShare `
                --path $PrefDestPath --output json 2>$null
            $PrefVerified = ($PrefCopyStatus -eq 'success') -and ($LASTEXITCODE -eq 0) -and $PrefDestShow

            $CopyLog.Add([pscustomobject]@{
                Store      = 'preferences'
                Source     = $PrefSourcePath
                Dest       = $PrefDestPath
                SizeBytes  = $null
                CopyStatus = $PrefCopyStatus
                Verified   = [bool]$PrefVerified
            })
            if (-not $PrefVerified) {
                Write-Warning "Copy of preferences file did not verify (copy status: $PrefCopyStatus)."
            }
        }
        else {
            Write-Verbose "No preferences file for '$FromId' — skipping that store."
        }

        # ── 3. calibration/users: check only, never copy (Quality, t/4440#2 item 2) ──
        $CalibListJson = & az storage blob list `
            --account-name $StorageAccount --container-name 'calibration' `
            --prefix "users/$FromId" --auth-mode login --output json 2>$null
        # Wrapped in an outer @(): "$x = if (cond) {@(...)} else {@()}" unwraps a single-element
        # array to its scalar (the if-as-value PowerShell gotcha hit earlier in t/4477's review).
        $CalibBlobs = @(if ($LASTEXITCODE -eq 0 -and $CalibListJson) { @($CalibListJson | ConvertFrom-Json) } else { @() })
        if ($CalibBlobs.Count -gt 0) {
            $Warnings.Add("calibration/users has $($CalibBlobs.Count) blob(s) for '$FromId' — NOT copied (shape unspecified for a GitHub id); migrate by hand if needed. Paths: $(($CalibBlobs | ForEach-Object name) -join ', ')")
            Write-Warning $Warnings[-1]
        }

        [PSCustomObject]@{
            Action         = 'GithubIdentityMigration'
            FromId         = $FromId
            ToId           = $ToId
            StorageAccount = $StorageAccount
            Copies         = @($CopyLog)
            Warnings       = @($Warnings)
            AllVerified    = (@($CopyLog | Where-Object { -not $_.Verified })).Count -eq 0
            Timestamp      = (Get-Date).ToString('o')
        }
    }
}
