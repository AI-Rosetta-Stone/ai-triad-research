# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Read-EntityCandidateLog {
    <#
    .SYNOPSIS
        Reads and parses entity_extraction_log.json for Get-EntityExtractionCandidates, throwing
        an actionable error when the file is missing or unparseable (split out for t/4146 so the
        cmdlet stays within the complexity budget; behaviour unchanged).
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        throw (New-ActionableError -PassThru `
            -Goal 'List advisory existing-entity candidates' `
            -Problem "entity_extraction_log.json not found at $Path" `
            -Location 'Get-EntityExtractionCandidates' `
            -NextSteps @('Run Invoke-EntityExtraction first, or pass -Path to the log'))
    }
    try {
        Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
    } catch {
        throw (New-ActionableError -PassThru `
            -Goal 'List advisory existing-entity candidates' `
            -Problem "entity_extraction_log.json could not be parsed: $($_.Exception.Message)" `
            -Location 'Get-EntityExtractionCandidates' `
            -NextSteps @("Restore $Path from git and re-run"))
    }
}
