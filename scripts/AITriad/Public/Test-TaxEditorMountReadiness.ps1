# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Test-TaxEditorMountReadiness {
    <#
    .SYNOPSIS
        Single-attempt probe: does a deployed taxonomy-editor revision's Azure Files
        mount actually have readable data yet?
    .DESCRIPTION
        t/4513 (t/4504 prevention): a brand-new Container App replica's `azureFile`
        (Azure Files SMB) mount attach has a short propagation window before reads are
        fully reliable. The existing health check (`/health`/`/healthz`) never reads an
        arbitrary data file, so it can't see this. This probes the exact three routes
        that failed on revision `-10951` (t/4504) -- `/api/entities`, `/api/organizations`,
        `/api/taxonomy/accelerationist` -- using the SAME success test the smoke's
        data-presence phase uses (`Invoke-SmokeDataPresencePhase`): an anonymous session,
        JSON content-type, and > 0 rows via `Test-DataPresenceAssertion`.

        t/4513's first live deploy (run 40358394585) rolled prod back on a FALSE
        NEGATIVE: the original implementation called `New-AnonymousWebSession`,
        `Invoke-RemoteCheck` and `Test-DataPresenceAssertion` directly from
        `deploy-azure.yml`'s inline `run:` block, which only has `Import-Module
        AITriad.psm1` in scope -- those three helpers are module-Private, invisible
        outside the module, so EVERY attempt failed with "not recognized" and read as
        "mount not ready" 13 times in a row. This cmdlet is the fix: it's Public
        (exported), so `Import-Module` alone resolves it from a workflow's `run:` block,
        exactly like `Test-EmbeddingHealth`/`Test-TaxEditorHealth` already are.

        Single-attempt by design -- the caller (Wait-MountReady,
        operations/devops/Get-MountReadinessVerdict.ps1) owns the bounded-retry loop,
        so this cmdlet stays a pure one-shot probe and is independently testable.
    .PARAMETER BaseUrl
        The revision's base URL (its own per-revision FQDN, not the app's shared URL,
        so the probe hits the exact replica being gated).
    .PARAMETER TimeoutSec
        Per-request timeout. Default 15.
    .OUTPUTS
        [PSCustomObject] Ready (bool), FailedRoute (string or $null), Reason (string or
        $null), Checked (string[], every route attempted before success or the first
        failure).
    .EXAMPLE
        Test-TaxEditorMountReadiness -BaseUrl 'https://taxonomy-editor--rev.example.com'
    .LINK
        Show-AITriadHelp
    .LINK
        Test-TaxEditorHealth
    .LINK
        Test-EmbeddingHealth
    #>
    [CmdletBinding()]
    [OutputType([PSCustomObject])]
    param(
        [Parameter(Mandatory, Position = 0)]
        [string]$BaseUrl,

        [Parameter()]
        [ValidateRange(1, 120)]
        [int]$TimeoutSec = 15
    )

    Set-StrictMode -Version Latest

    $BaseUrl = $BaseUrl.TrimEnd('/')

    $Routes = @(
        @{ Path = '/api/entities';                 Field = '';      Label = 'entities' }
        @{ Path = '/api/organizations';            Field = '';      Label = 'organizations' }
        @{ Path = '/api/taxonomy/accelerationist'; Field = 'nodes'; Label = 'taxonomy nodes' }
    )
    $Checked = [System.Collections.Generic.List[string]]::new()

    $DataSession = New-AnonymousWebSession -BaseUrl $BaseUrl -TimeoutSec $TimeoutSec
    if (-not $DataSession) {
        Write-Host '  (anonymous session not established — probe will likely hit the auth interstitial)' -ForegroundColor DarkYellow
    }

    foreach ($R in $Routes) {
        $Checked.Add($R.Label)
        $Params = @{ BaseUrl = $BaseUrl; Path = $R.Path; Method = 'GET'; TimeoutSec = $TimeoutSec; ExpectJson = $true }
        if ($DataSession) { $Params.Session = $DataSession }
        $Check  = Invoke-RemoteCheck @Params
        $Assert = Test-DataPresenceAssertion -Body $Check.Body -ContentType $Check.ContentType `
            -CountField $R.Field -Label $R.Label
        if (-not $Assert.Pass) {
            return [PSCustomObject]@{
                Ready       = $false
                FailedRoute = $R.Label
                Reason      = $Assert.Reason
                Checked     = @($Checked)
            }
        }
    }

    [PSCustomObject]@{
        Ready       = $true
        FailedRoute = $null
        Reason      = $null
        Checked     = @($Checked)
    }
}
