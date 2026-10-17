# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Get-DebateSessionState {
    <#
    .SYNOPSIS
        Reads phase, transcript length, run_id, and other state from a debate JSON on disk.
    .DESCRIPTION
        A one-liner diagnostic for interrupted-turn recovery and phase regression triage.
        Locates the debate file by ID under the debates data directory, reads key fields,
        and returns a typed snapshot without loading the full object graph.

        No AI calls are made — offline read only.
    .PARAMETER DebateId
        The debate UUID (with or without the 'debate-' prefix, e.g. 'd1c7f7b6-...' or
        'debate-d1c7f7b6-...').
    .PARAMETER DataRoot
        Optional override for the data root. Defaults to $env:AI_TRIAD_DATA_ROOT, then
        .aitriad.json resolution.
    .OUTPUTS
        PSCustomObject with: DebateId, Phase, TranscriptLength, RunId, UpdatedAt,
        PayloadBytes, FilePath.
    .EXAMPLE
        Get-DebateSessionState -DebateId d1c7f7b6-a170-45bb-9f14-37baf9a8ea2b
    .EXAMPLE
        Get-DebateSessionState 'd1c7f7b6-a170-45bb-9f14-37baf9a8ea2b' | Select-Object Phase, TranscriptLength
    .LINK
        Show-AITriadHelp
    .LINK
        Get-TaxonomyHealth
    .LINK
        Test-OntologyCompliance
    #>
    [CmdletBinding()]
    [OutputType([PSCustomObject])]
    param(
        [Parameter(Mandatory, Position = 0, ValueFromPipeline)]
        [ValidateNotNullOrEmpty()]
        [string]$DebateId,

        [Parameter()]
        [string]$DataRoot
    )

    process {
        Set-StrictMode -Version Latest
        $ErrorActionPreference = 'Stop'

        # Strip optional 'debate-' prefix so both forms are accepted
        $CleanId = $DebateId -replace '^debate-', ''

        $DebatesDir = if ($DataRoot) {
            Join-Path $DataRoot (& { Initialize-DataConfig; $script:DataConfig.debates_dir })
        } else {
            Get-DebatesDir
        }

        $FilePath = Join-Path $DebatesDir "debate-$CleanId.json"

        if (-not (Test-Path $FilePath)) {
            throw (New-ActionableError -AsErrorRecord `
                -Goal        "Read debate session state for '$CleanId'" `
                -Problem     "Debate file not found: $FilePath" `
                -Location    "Get-DebateSessionState" `
                -NextSteps   "Verify the DebateId is correct and the data root is reachable. Run Get-DebatesDir to confirm the resolved path.")
        }

        $Item    = Get-Item $FilePath
        $Raw     = Get-Content $FilePath -Raw -Encoding utf8
        $Debate  = $Raw | ConvertFrom-Json

        $Phase            = if ($Debate.PSObject.Properties['phase'])      { [string]$Debate.phase }      else { $null }
        $RunId            = if ($Debate.PSObject.Properties['run_id'])     { [string]$Debate.run_id }     else { $null }
        $UpdatedAt        = if ($Debate.PSObject.Properties['updated_at']) { [string]$Debate.updated_at } else { $null }
        $TranscriptLength = if ($Debate.PSObject.Properties['transcript']) { @($Debate.transcript).Count } else { 0 }

        [PSCustomObject]@{
            DebateId         = $CleanId
            Phase            = $Phase
            TranscriptLength = $TranscriptLength
            RunId            = $RunId
            UpdatedAt        = $UpdatedAt
            PayloadBytes     = $Item.Length
            FilePath         = $Item.FullName
        }
    }
}
