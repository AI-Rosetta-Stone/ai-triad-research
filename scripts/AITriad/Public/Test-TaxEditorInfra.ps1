# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Test-TaxEditorInfra {
    <#
    .SYNOPSIS
        Runs a Bicep what-if dry run to preview infrastructure changes.
    .DESCRIPTION
        Executes 'az deployment group what-if' against the current
        deploy/azure/main.bicep template. Shows what would change without
        deploying. Highlights resource deletions as warnings.
    .PARAMETER ResourceGroup
        Azure resource group name. Default: ai-triad.
    .PARAMETER TemplatePath
        Path to the Bicep template. Default: deploy/azure/main.bicep (relative to repo root).
    .PARAMETER Parameters
        Additional Bicep parameters as a hashtable (e.g., @{ containerImage = 'ghcr.io/...:0.8.1' }).
    .EXAMPLE
        Test-TaxEditorInfra
    .EXAMPLE
        Test-TaxEditorInfra -Parameters @{ containerImage = 'ghcr.io/ai-rosetta-stone/taxonomy-editor:0.8.0' }
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
        Deploy-TaxEditorInfra
    .LINK
        Deploy-TaxEditorImage
    #>
    [CmdletBinding()]
    param(
        [Parameter()]
        [string]$ResourceGroup = 'ai-triad',

        [Parameter()]
        [string]$TemplatePath,

        [Parameter()]
        [hashtable]$Parameters = @{}
    )

    Set-StrictMode -Version Latest
    $CallerName = 'Test-TaxEditorInfra'

    # ── Validate az CLI ──────────────────────────────────────────────────
    $AzCmd = Get-Command az -ErrorAction SilentlyContinue
    if (-not $AzCmd) {
        throw (New-ActionableError `
            -Goal 'Run Bicep what-if preview' `
            -Problem 'Azure CLI (az) not found on PATH' `
            -Location $CallerName `
            -NextSteps @('Install Azure CLI: https://aka.ms/installazurecli'))
    }

    $AccountJson = & az account show --output json 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $AccountJson) {
        throw (New-ActionableError `
            -Goal 'Run Bicep what-if preview' `
            -Problem 'Azure CLI is not logged in' `
            -Location $CallerName `
            -NextSteps @('Run: az login', 'Verify subscription: az account show'))
    }

    # ── Resolve template path ────────────────────────────────────────────
    if (-not $TemplatePath) {
        $RepoRoot = (git rev-parse --show-toplevel 2>$null)
        if (-not $RepoRoot) {
            throw (New-ActionableError `
                -Goal 'Locate Bicep template' `
                -Problem 'Not in a git repository — cannot resolve default template path' `
                -Location $CallerName `
                -NextSteps @('Pass -TemplatePath explicitly',
                             'Run from inside the ai-triad-research repository'))
        }
        $TemplatePath = Join-Path $RepoRoot 'deploy' 'azure' 'main.bicep'
    }

    if (-not (Test-Path $TemplatePath)) {
        throw (New-ActionableError `
            -Goal 'Run Bicep what-if preview' `
            -Problem "Bicep template not found: $TemplatePath" `
            -Location $CallerName `
            -NextSteps @('Verify the path to main.bicep',
                         'Default: deploy/azure/main.bicep in repo root'))
    }

    # ── Build az command arguments ───────────────────────────────────────
    $AzArgs = @(
        'deployment', 'group', 'what-if'
        '--resource-group', $ResourceGroup
        '--template-file', $TemplatePath
        '--no-pretty-print'
    )

    if ($Parameters.Count -gt 0) {
        $ParamArgs = @()
        foreach ($Key in $Parameters.Keys) {
            $ParamArgs += "${Key}=$($Parameters[$Key])"
        }
        $AzArgs += '--parameters'
        $AzArgs += $ParamArgs
    }

    # ── Run what-if ──────────────────────────────────────────────────────
    Write-Verbose "Running: az $($AzArgs -join ' ')"
    $RawOutput = & az @AzArgs 2>&1 | Out-String

    $HasDeletes = $RawOutput -match '"changeType"\s*:\s*"Delete"'
    if ($HasDeletes) {
        Write-Warning 'Bicep what-if detected resource DELETIONS — review carefully before deploying.'
    }

    # ── Parse changes from output ────────────────────────────────────────
    $Changes = @()
    try {
        $JsonOutput = $RawOutput | ConvertFrom-Json -ErrorAction Stop
        if ($JsonOutput.PSObject.Properties['changes']) {
            foreach ($Change in $JsonOutput.changes) {
                $ResourceId = ''
                if ($Change.PSObject.Properties['resourceId']) {
                    $ResourceId = $Change.resourceId
                }
                $ChangeType = ''
                if ($Change.PSObject.Properties['changeType']) {
                    $ChangeType = $Change.changeType
                }
                $Changes += [PSCustomObject]@{
                    ChangeType = $ChangeType
                    ResourceId = $ResourceId
                }
            }
        }
    }
    catch {
        Write-Verbose "Could not parse what-if JSON output — returning raw text."
    }

    # ── Return result ────────────────────────────────────────────────────
    [PSCustomObject]@{
        Action        = 'InfraWhatIf'
        ResourceGroup = $ResourceGroup
        TemplatePath  = $TemplatePath
        HasDeletes    = $HasDeletes
        ChangeCount   = @($Changes).Count
        Changes       = $Changes
        RawOutput     = $RawOutput.Trim()
        Timestamp     = (Get-Date).ToString('o')
    }
}
