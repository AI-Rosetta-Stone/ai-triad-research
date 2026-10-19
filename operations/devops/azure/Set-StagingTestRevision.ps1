# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Creates a staging test revision from the revision currently SERVING traffic, with
    overrides (size, read-only shared mount, env vars), health-checks it on its own revision
    FQDN, then moves traffic to it. -Restore moves traffic back and deactivates the test
    revision.

.DESCRIPTION
    For one-off operational tests on taxonomy-editor-staging only (t/4263 C1, t/4264).
    It is NOT a way to make persistent config changes: the next Bicep deploy replaces the
    template, so every persistent change still goes through main.bicep.

    Why not `az containerapp update --cpu ...`: that builds the new revision from the app's
    LATEST template, which is not necessarily what serves traffic. On 2026-10-17 staging
    served --0000223 (image f5a29be4...) while the latest template was --0000226 (image
    5dcaf97c..., no deploy metadata). This script copies the template of the revision that
    holds 100% of traffic, so the test measures the build users actually get.

    Safety:
      - refuses unless the app is in Multiple revision mode (the original revision stays
        active, so -Restore is a traffic shift, not a re-create);
      - the new revision gets traffic only after its own /healthz returns 200;
      - -Restore re-reads the test revision's weight and deactivates it only at weight 0
        (the t/4242 rule).

.PARAMETER Cpu
    vCPU for the test revision, e.g. 1.0. Requires -Memory (an ACA Consumption pair).

.PARAMETER Memory
    Memory for the test revision, e.g. '2Gi'.

.PARAMETER ReadOnlyShared
    Re-point the 'shared-data' volume (/mnt/shared) from 'taxonomy-data' (ReadWrite) to the
    'taxonomy-data-ro' environment storage (ReadOnly), so the test cannot write to prod's share.

.PARAMETER SetEnv
    Env vars to add or replace, e.g. @{ ANON_SESSION_DIR = '/mnt/staging-state/anon-sessions' }.

.PARAMETER Image
    Image to run instead of the serving revision's, e.g. prod's current digest. Must be an
    immutable digest reference (...@sha256:...).

.PARAMETER TerminationGracePeriodSeconds
    Grace between SIGTERM and SIGKILL for the test revision. Staging's template sets none (ACA
    default); prod's main.bicep sets 60, so use 60 to test shutdown behaviour as prod sees it.

.PARAMETER Suffix
    Revision suffix (lowercase letters, digits, hyphens). Default: 'test-<yyyyMMddHHmm>'.

.EXAMPLE
    # t/4263 C1: 1 vCPU load-test revision, prod share read-only, anon sessions isolated
    ./Set-StagingTestRevision.ps1 -Cpu 1.0 -Memory 2Gi -ReadOnlyShared `
        -SetEnv @{ ANON_SESSION_DIR = '/mnt/staging-state/anon-sessions' } -Suffix lt-1vcpu

.EXAMPLE
    # Restore: traffic back to the original revision, test revision deactivated
    ./Set-StagingTestRevision.ps1 -Restore -RestoreTo taxonomy-editor-staging--0000223 `
        -TestRevision taxonomy-editor-staging--lt-1vcpu
#>
[CmdletBinding(DefaultParameterSetName = 'Apply', SupportsShouldProcess)]
param(
    [string]$App = 'taxonomy-editor-staging',
    [string]$ResourceGroup = 'ai-triad',

    [Parameter(ParameterSetName = 'Apply')][double]$Cpu,
    [Parameter(ParameterSetName = 'Apply')][string]$Memory,
    [Parameter(ParameterSetName = 'Apply')][switch]$ReadOnlyShared,
    [Parameter(ParameterSetName = 'Apply')][hashtable]$SetEnv = @{},
    [Parameter(ParameterSetName = 'Apply')][ValidatePattern('^[^@\s]+@sha256:[0-9a-f]{64}$')][string]$Image,
    [Parameter(ParameterSetName = 'Apply')][ValidateRange(0, 600)][int]$TerminationGracePeriodSeconds,
    [Parameter(ParameterSetName = 'Apply')][ValidatePattern('^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$')][string]$Suffix,
    [Parameter(ParameterSetName = 'Apply')][int]$ReadyTimeoutSec = 420,

    [Parameter(ParameterSetName = 'Restore', Mandatory)][switch]$Restore,
    [Parameter(ParameterSetName = 'Restore', Mandatory)][string]$RestoreTo,
    [Parameter(ParameterSetName = 'Restore', Mandatory)][string]$TestRevision
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..' '..' '..' 'scripts' 'AITriad' 'Private' 'New-ActionableError.ps1')

$Location = 'operations/devops/azure/Set-StagingTestRevision.ps1'

if ($App -notmatch 'staging') {
    New-ActionableError -Goal "Create a test revision of '$App'" `
        -Problem 'This script is for staging only; the app name does not contain "staging".' `
        -Location $Location -NextSteps @('Use -App taxonomy-editor-staging', 'Change prod only through main.bicep and deploy-azure.yml') -Throw
}

function Invoke-Az([string[]]$AzArgs, [string]$Goal) {
    $out = & az @AzArgs 2>&1
    if ($LASTEXITCODE -ne 0) {
        New-ActionableError -Goal $Goal -Problem "az $($AzArgs[0..2] -join ' ') failed: $($out | Out-String)" `
            -Location $Location -NextSteps @('Run `az account show` to confirm you are logged in to the right subscription', 'Re-run; if it persists, check the Azure portal activity log') -Throw
    }
    return ($out | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] }) -join "`n"
}

function Get-Weights {
    $traffic = Invoke-Az @('containerapp', 'ingress', 'traffic', 'show', '-n', $App, '-g', $ResourceGroup, '-o', 'json') 'Read staging traffic weights' | ConvertFrom-Json
    $map = @{}
    foreach ($t in @($traffic)) { if ($t.PSObject.Properties['revisionName']) { $map[$t.revisionName] = [int]$t.weight } }
    return $map
}

# ── Restore ──────────────────────────────────────────────────────────────────
if ($PSCmdlet.ParameterSetName -eq 'Restore') {
    if ($PSCmdlet.ShouldProcess($App, "traffic $RestoreTo=100, then deactivate $TestRevision")) {
        Invoke-Az @('containerapp', 'ingress', 'traffic', 'set', '-n', $App, '-g', $ResourceGroup, '--revision-weight', "$RestoreTo=100") "Move staging traffic back to $RestoreTo" | Out-Null
        $weights = Get-Weights
        $w = if ($weights.ContainsKey($TestRevision)) { $weights[$TestRevision] } else { 0 }
        if ($w -ne 0) {
            New-ActionableError -Goal "Deactivate test revision $TestRevision" -Problem "It still holds weight $w after the traffic shift (t/4242: never deactivate a revision with weight > 0)." `
                -Location $Location -NextSteps @("Run: az containerapp ingress traffic show -n $App -g $ResourceGroup", 'Re-run -Restore once the test revision shows weight 0') -Throw
        }
        Invoke-Az @('containerapp', 'revision', 'deactivate', '-n', $App, '-g', $ResourceGroup, '--revision', $TestRevision) "Deactivate $TestRevision" | Out-Null
        Write-Host "Restored: $RestoreTo serves 100%; $TestRevision deactivated."
    }
    return
}

# ── Apply ────────────────────────────────────────────────────────────────────
if (($PSBoundParameters.ContainsKey('Cpu')) -xor ($PSBoundParameters.ContainsKey('Memory'))) {
    New-ActionableError -Goal 'Resize the staging test revision' -Problem '-Cpu and -Memory must be given together (ACA Consumption fixed pairs, e.g. 1.0/2Gi).' `
        -Location $Location -NextSteps @('Pass both, e.g. -Cpu 1.0 -Memory 2Gi') -Throw
}

$appJson = Invoke-Az @('containerapp', 'show', '-n', $App, '-g', $ResourceGroup, '-o', 'json') "Read $App" | ConvertFrom-Json
if ($appJson.properties.configuration.activeRevisionsMode -ne 'Multiple') {
    New-ActionableError -Goal "Create a test revision of $App" -Problem "Revision mode is '$($appJson.properties.configuration.activeRevisionsMode)'; restore depends on the original revision staying active (Multiple mode)." `
        -Location $Location -NextSteps @('Do not run this against a Single-mode app; restore would require re-creating the revision') -Throw
}

$weights = Get-Weights
$serving = @($weights.Keys | Where-Object { $weights[$_] -eq 100 })
if ($serving.Count -ne 1) {
    New-ActionableError -Goal "Find the revision serving $App" -Problem "Expected exactly one revision at weight 100; got: $(($weights.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ', ')" `
        -Location $Location -NextSteps @("Pin traffic first: az containerapp ingress traffic set -n $App -g $ResourceGroup --revision-weight <revision>=100") -Throw
}
$fromRevision = $serving[0]
$rev = Invoke-Az @('containerapp', 'revision', 'show', '-n', $App, '-g', $ResourceGroup, '--revision', $fromRevision, '-o', 'json') "Read revision $fromRevision" | ConvertFrom-Json
$template = $rev.properties.template

if (-not $Suffix) { $Suffix = 'test-' + (Get-Date -AsUTC -Format 'yyyyMMddHHmm') }
$template | Add-Member -NotePropertyName revisionSuffix -NotePropertyValue $Suffix -Force
$container = $template.containers[0]

if ($Image) { $container.image = $Image }
if ($PSBoundParameters.ContainsKey('TerminationGracePeriodSeconds')) {
    $template | Add-Member -NotePropertyName terminationGracePeriodSeconds -NotePropertyValue $TerminationGracePeriodSeconds -Force
}

if ($PSBoundParameters.ContainsKey('Cpu')) {
    # Drop ephemeralStorage: its allowed size is tied to the cpu/memory pair, so the platform sets it.
    $container.resources = [pscustomobject]@{ cpu = $Cpu; memory = $Memory }
}

if ($ReadOnlyShared) {
    $vol = @($template.volumes | Where-Object { $_.name -eq 'shared-data' })
    if ($vol.Count -ne 1) {
        New-ActionableError -Goal 'Mount the prod share read-only' -Problem "Revision $fromRevision has no single 'shared-data' volume." `
            -Location $Location -NextSteps @('Inspect the revision volumes: az containerapp revision show ... --query properties.template.volumes') -Throw
    }
    $vol[0].storageName = 'taxonomy-data-ro'
}

foreach ($name in $SetEnv.Keys) {
    $existing = @($container.env | Where-Object { $_.name -eq $name })
    if ($existing.Count -gt 0) { $existing[0] | Add-Member -NotePropertyName value -NotePropertyValue ([string]$SetEnv[$name]) -Force }
    else { $container.env = @($container.env) + [pscustomobject]@{ name = $name; value = [string]$SetEnv[$name] } }
}

# A revision read returns nulls for unset fields (e.g. scale.cooldownPeriod); sending them back
# in the update could reset platform defaults or be rejected, so drop them.
function Remove-NullProperty($Node) {
    if ($Node -is [System.Collections.IList]) { foreach ($i in $Node) { Remove-NullProperty $i }; return }
    if ($Node -isnot [pscustomobject]) { return }
    foreach ($p in @($Node.PSObject.Properties)) {
        if ($null -eq $p.Value) { $Node.PSObject.Properties.Remove($p.Name) } else { Remove-NullProperty $p.Value }
    }
}
Remove-NullProperty $template

$specPath = Join-Path ([System.IO.Path]::GetTempPath()) "staging-test-revision-$Suffix.json"
@{ properties = @{ template = $template } } | ConvertTo-Json -Depth 30 | Set-Content -Path $specPath -Encoding utf8 -WhatIf:$false  # written even under -WhatIf so a dry run can be inspected
$newRevision = "$App--$Suffix"
Write-Host "Copying $fromRevision -> $newRevision (spec: $specPath)"
Write-Host "  image:     $($container.image)"
Write-Host "  resources: $($container.resources | ConvertTo-Json -Compress)"
Write-Host "  grace:     $(if ($template.PSObject.Properties['terminationGracePeriodSeconds']) { "$($template.terminationGracePeriodSeconds)s" } else { 'platform default' })"
Write-Host "  volumes:   $(($template.volumes | ForEach-Object { "$($_.name)->$($_.storageName)" }) -join ', ')"
Write-Host "  env set:   $(($SetEnv.GetEnumerator() | ForEach-Object { if ($_.Key -match 'SECRET|KEY|TOKEN|PASSWORD') { "$($_.Key)=***" } else { "$($_.Key)=$($_.Value)" } }) -join ', ')"

if (-not $PSCmdlet.ShouldProcess($App, "create revision $newRevision and move traffic to it")) { return }

try {
    Invoke-Az @('containerapp', 'update', '-n', $App, '-g', $ResourceGroup, '--yaml', $specPath) "Create test revision $newRevision" | Out-Null
} finally {
    if (@($SetEnv.Keys | Where-Object { $_ -match 'SECRET|KEY|TOKEN|PASSWORD' }).Count -gt 0) { Remove-Item -LiteralPath $specPath -ErrorAction SilentlyContinue }
}

# Wait for the new revision to be provisioned and running.
$deadline = (Get-Date).AddSeconds($ReadyTimeoutSec)
$fqdn = $null
do {
    Start-Sleep -Seconds 15
    $r = Invoke-Az @('containerapp', 'revision', 'show', '-n', $App, '-g', $ResourceGroup, '--revision', $newRevision, '-o', 'json') "Read $newRevision" | ConvertFrom-Json
    $state = "$($r.properties.provisioningState)/$($r.properties.runningState)/$($r.properties.healthState)"
    Write-Host "  $newRevision : $state"
    if ($r.properties.provisioningState -eq 'Failed') { break }
    if ($r.properties.healthState -eq 'Healthy') { $fqdn = $r.properties.fqdn; break }
} while ((Get-Date) -lt $deadline)

$healthy = $false
if ($fqdn) {
    try {
        $resp = Invoke-WebRequest -Uri "https://$fqdn/healthz" -TimeoutSec 30 -SkipHttpErrorCheck
        Write-Host "  https://$fqdn/healthz -> $($resp.StatusCode)"
        $healthy = ($resp.StatusCode -eq 200)
    } catch {
        Write-Warning "WARN: /healthz probe on $fqdn threw ($($_.Exception.Message)); treating the revision as unhealthy and NOT moving traffic."
    }
}

if (-not $healthy) {
    New-ActionableError -Goal "Bring up test revision $newRevision" -Problem "It did not reach Healthy with /healthz 200 within $ReadyTimeoutSec s (last state: $state). Traffic is still on $fromRevision." `
        -Location $Location -NextSteps @(
            "Read its logs: az containerapp logs show -n $App -g $ResourceGroup --revision $newRevision --tail 100",
            "Clean up: az containerapp revision deactivate -n $App -g $ResourceGroup --revision $newRevision") -Throw
}

Invoke-Az @('containerapp', 'ingress', 'traffic', 'set', '-n', $App, '-g', $ResourceGroup, '--revision-weight', "$newRevision=100") "Move traffic to $newRevision" | Out-Null
Write-Host ""
Write-Host "Traffic: $newRevision = 100% (was $fromRevision)."
Write-Host "Restore with:"
Write-Host "  ./Set-StagingTestRevision.ps1 -Restore -RestoreTo $fromRevision -TestRevision $newRevision"
