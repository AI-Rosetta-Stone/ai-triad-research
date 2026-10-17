# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Deploy-TaxEditorInfra {
    <#
    .SYNOPSIS
        Deploys Bicep infrastructure from a specific git commit.
    .DESCRIPTION
        Checks out deploy/azure/main.bicep from the specified git commit,
        runs a what-if preview, then deploys with -Confirm gate. This
        enables infrastructure rollback to a known-good Bicep state.

        Some Bicep changes are irreversible (storage account deletion,
        Key Vault purge). The what-if preview and -Confirm gate protect
        against accidents. Supports -WhatIf/-Confirm.
    .PARAMETER Commit
        Git commit SHA (full or short) to deploy from.
    .PARAMETER ResourceGroup
        Azure resource group name. Default: ai-triad.
    .PARAMETER Parameters
        Additional Bicep parameters as a hashtable.
    .EXAMPLE
        Deploy-TaxEditorInfra -Commit 'abc1234'
    .EXAMPLE
        Deploy-TaxEditorInfra -Commit 'abc1234' -WhatIf
    .EXAMPLE
        Deploy-TaxEditorInfra -Commit 'abc1234' -Parameters @{ containerImage = 'ghcr.io/ai-rosetta-stone/taxonomy-editor:0.8.0' }
    .LINK
        Show-AITriadHelp
    .LINK
        Test-AzureHealth
    .LINK
        Get-ContainerAppRevision
    .LINK
        Remove-StaleContainerImages
    .LINK
        Get-AzureFlightRecorder
    .LINK
        Test-TaxEditorInfra
    .LINK
        Deploy-TaxEditorImage
    #>
    [CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
    param(
        [Parameter(Mandatory, Position = 0)]
        [string]$Commit,

        [Parameter()]
        [string]$ResourceGroup = 'ai-triad',

        [Parameter()]
        [hashtable]$Parameters = @{}
    )

    Set-StrictMode -Version Latest
    $CallerName = 'Deploy-TaxEditorInfra'

    # ── Validate az CLI ──────────────────────────────────────────────────
    $AzCmd = Get-Command az -ErrorAction SilentlyContinue
    if (-not $AzCmd) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal 'Deploy Bicep infrastructure' `
            -Problem 'Azure CLI (az) not found on PATH' `
            -Location $CallerName `
            -NextSteps @('Install Azure CLI: https://aka.ms/installazurecli'))
    }

    $AccountJson = & az account show --output json 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $AccountJson) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal 'Deploy Bicep infrastructure' `
            -Problem 'Azure CLI is not logged in' `
            -Location $CallerName `
            -NextSteps @('Run: az login', 'Verify subscription: az account show'))
    }

    # ── Validate git and resolve commit ──────────────────────────────────
    $GitCmd = Get-Command git -ErrorAction SilentlyContinue
    if (-not $GitCmd) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal 'Retrieve Bicep from commit' `
            -Problem 'git not found on PATH' `
            -Location $CallerName `
            -NextSteps @('Install git: https://git-scm.com'))
    }

    $FullSha = & git rev-parse --verify "$Commit" 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $FullSha) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal 'Retrieve Bicep from commit' `
            -Problem "Commit '$Commit' not found in repository" `
            -Location $CallerName `
            -NextSteps @('Verify the commit SHA: git log --oneline',
                         'Fetch from remote if needed: git fetch origin'))
    }
    $ShortSha = $FullSha.Substring(0, [Math]::Min(10, $FullSha.Length))

    # ── Extract Bicep from commit ────────────────────────────────────────
    $BicepContent = & git show "${FullSha}:deploy/azure/main.bicep" 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $BicepContent) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal 'Retrieve Bicep from commit' `
            -Problem "deploy/azure/main.bicep not found at commit $ShortSha" `
            -Location $CallerName `
            -NextSteps @("Verify the file exists at that commit: git show ${ShortSha}:deploy/azure/main.bicep",
                         'The Bicep file may have been added after this commit'))
    }

    $TempFile = [System.IO.Path]::GetTempFileName() -replace '\.tmp$', '.bicep'
    try {
        [System.IO.File]::WriteAllText($TempFile, ($BicepContent -join "`n"))

        # ── Run what-if preview ──────────────────────────────────────────
        Write-Verbose "Running what-if preview for commit $ShortSha..."
        $AzWhatIfArgs = @(
            'deployment', 'group', 'what-if'
            '--resource-group', $ResourceGroup
            '--template-file', $TempFile
            '--no-pretty-print'
        )

        if ($Parameters.Count -gt 0) {
            $ParamArgs = @()
            foreach ($Key in $Parameters.Keys) {
                $ParamArgs += "${Key}=$($Parameters[$Key])"
            }
            $AzWhatIfArgs += '--parameters'
            $AzWhatIfArgs += $ParamArgs
        }

        $WhatIfOutput = & az @AzWhatIfArgs 2>&1 | Out-String

        $HasDeletes = $WhatIfOutput -match '"changeType"\s*:\s*"Delete"'
        if ($HasDeletes) {
            Write-Warning "Bicep what-if detected resource DELETIONS at commit $ShortSha — review carefully."
        }

        # ── Parse change count ───────────────────────────────────────────
        $ChangeCount = 0
        try {
            $JsonOutput = $WhatIfOutput | ConvertFrom-Json -ErrorAction Stop
            if ($JsonOutput.PSObject.Properties['changes']) {
                $ChangeCount = @($JsonOutput.changes).Count
            }
        }
        catch {
            Write-Verbose 'Could not parse what-if JSON output.'
        }

        Write-Verbose "What-if preview: $ChangeCount change(s) detected."

        # ── WhatIf / Confirm gate ────────────────────────────────────────
        $ConfirmMsg = "Deploy Bicep from commit $ShortSha ($ChangeCount change(s)"
        if ($HasDeletes) { $ConfirmMsg += ', includes DELETIONS' }
        $ConfirmMsg += ')'

        if (-not $PSCmdlet.ShouldProcess($ResourceGroup, $ConfirmMsg)) {
            return [PSCustomObject]@{
                Action        = 'InfraDeployPreview'
                Commit        = $ShortSha
                ResourceGroup = $ResourceGroup
                HasDeletes    = $HasDeletes
                ChangeCount   = $ChangeCount
                Deployed      = $false
                WhatIfOutput  = $WhatIfOutput.Trim()
                Timestamp     = (Get-Date).ToString('o')
            }
        }

        # ── Deploy ───────────────────────────────────────────────────────
        Write-Verbose "Deploying Bicep from commit $ShortSha..."
        $AzDeployArgs = @(
            'deployment', 'group', 'create'
            '--resource-group', $ResourceGroup
            '--template-file', $TempFile
            '--output', 'json'
        )

        if ($Parameters.Count -gt 0) {
            $AzDeployArgs += '--parameters'
            $AzDeployArgs += $ParamArgs
        }

        $DeployOutput = & az @AzDeployArgs 2>$null | Out-String

        if ($LASTEXITCODE -ne 0) {
            throw (New-ActionableError -AsErrorRecord `
                -Goal "Deploy Bicep from commit $ShortSha" `
                -Problem "az deployment group create failed (exit code $LASTEXITCODE)" `
                -Location $CallerName `
                -NextSteps @("Review the what-if output for issues",
                             "Check deployment status: az deployment group list -g $ResourceGroup --query `"[0]`""))
        }

        $ProvisioningState = 'Unknown'
        try {
            $DeployJson = $DeployOutput | ConvertFrom-Json -ErrorAction Stop
            if ($DeployJson.PSObject.Properties['properties'] -and
                $DeployJson.properties.PSObject.Properties['provisioningState']) {
                $ProvisioningState = $DeployJson.properties.provisioningState
            }
        }
        catch {
            Write-Verbose 'Could not parse deployment JSON output.'
        }

        Write-Verbose "Deployment complete: $ProvisioningState"

        [PSCustomObject]@{
            Action            = 'InfraDeploy'
            Commit            = $ShortSha
            ResourceGroup     = $ResourceGroup
            HasDeletes        = $HasDeletes
            ChangeCount       = $ChangeCount
            Deployed          = $true
            ProvisioningState = $ProvisioningState
            Timestamp         = (Get-Date).ToString('o')
        }
    }
    finally {
        if (Test-Path $TempFile) {
            Remove-Item $TempFile -Force -ErrorAction SilentlyContinue
        }
    }
}
