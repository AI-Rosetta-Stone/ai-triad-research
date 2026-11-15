# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
Thin shim for the container-env snapshot diff around deploys (t/4935). WARN-ONLY: always exits 0.

.DESCRIPTION
Two modes, called from deploy-azure.yml and deploy-staging.yml:

  Snapshot: reads one revision's env with `az containerapp revision show` and writes a value-free snapshot
            (Name, SecretRef, HMAC-SHA256 of the value) to -OutFile. The HMAC key is a per-run random key
            in -KeyFile (created on first use, never printed), so both snapshots of one run are comparable
            and the hashes in the public log are not reversible by guessing.
  Diff:     reads two snapshot files and the checked-in allowlist, and prints the verdict as ::notice:: /
            ::warning:: annotations plus a step-summary table. Names, secretRef names and hash prefixes only.

The raw env values exist only inside this process, between the `az` call and ConvertTo-ContainerEnvSnapshot.
They are never printed, written to a file or put in an error message: the az output and the JSON parse have
fixed-text failure messages because a ConvertFrom-Json error can quote its input.

Any failure prints a ::warning:: (GATE-UNREADABLE for the diff) and exits 0. This check must never block or
alter a deploy; promotion to blocking the traffic shift is a separate T2 change (t/4935).

Pure logic: ContainerEnvSnapshotVerdict.ps1 (tests: tests/ContainerEnvSnapshotVerdict.Tests.ps1).
#>
[CmdletBinding(DefaultParameterSetName = 'Snapshot')]
param(
    [Parameter(Mandatory, ParameterSetName = 'Snapshot')][string] $AppName,
    [Parameter(Mandatory, ParameterSetName = 'Snapshot')][string] $ResourceGroup,
    [Parameter(ParameterSetName = 'Snapshot')][AllowEmptyString()][string] $RevisionName,
    [Parameter(Mandatory, ParameterSetName = 'Snapshot')][string] $OutFile,
    [Parameter(Mandatory, ParameterSetName = 'Snapshot')][string] $KeyFile,

    [Parameter(Mandatory, ParameterSetName = 'Diff')][switch] $Diff,
    [Parameter(Mandatory, ParameterSetName = 'Diff')][string] $BeforeFile,
    [Parameter(Mandatory, ParameterSetName = 'Diff')][string] $AfterFile,
    [Parameter(Mandatory, ParameterSetName = 'Diff')][string] $ExpectedChangesFile,
    [Parameter(ParameterSetName = 'Diff')][string] $Label = 'deploy'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ContainerEnvSnapshotVerdict.ps1')

function Write-Annotation([string] $Level, [string] $Message) {
    Write-Host "::$Level::$Message"
}

function Get-HashKey([string] $Path) {
    if (Test-Path -LiteralPath $Path) {
        return [System.Convert]::FromBase64String((Get-Content -LiteralPath $Path -Raw).Trim())
    }
    $key = [System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
    Set-Content -LiteralPath $Path -Value ([System.Convert]::ToBase64String($key)) -NoNewline
    return $key
}

function Write-SnapshotFile([string] $Path, [hashtable] $Body) {
    $Body['schema'] = 't4935-container-env-snapshot/v1'
    $Body['hash'] = 'HMAC-SHA256, per-run key'
    $Body['takenAt'] = [DateTimeOffset]::UtcNow.ToString('o')
    Set-Content -LiteralPath $Path -Value ($Body | ConvertTo-Json -Depth 5)
}

function Invoke-Snapshot {
    $label = "$AppName revision '$RevisionName'"
    if ([string]::IsNullOrWhiteSpace($RevisionName)) {
        $msg = 'no revision name was given (no serving revision, or the step that captures it did not run)'
        Write-Annotation 'warning' "t/4935 env snapshot ($AppName): WARN fallback, no snapshot taken: $msg."
        Write-SnapshotFile $OutFile @{ app = $AppName; revision = ''; error = $msg; entries = @() }
        return
    }
    $key = Get-HashKey $KeyFile
    $errFile = [System.IO.Path]::GetTempFileName()
    try {
        $raw = az containerapp revision show --name $AppName -g $ResourceGroup --revision $RevisionName `
            --query 'properties.template.containers' -o json 2>$errFile
        $exit = $LASTEXITCODE
        $global:LASTEXITCODE = 0
        if ($exit -ne 0) {
            # az's stderr for a failed GET carries the error, never the template; still cap it.
            $err = (Get-Content -LiteralPath $errFile -Raw -ErrorAction SilentlyContinue)
            $err = if ($err) { ($err -replace '\s+', ' ').Trim() } else { '' }
            if ($err.Length -gt 300) { $err = $err.Substring(0, 300) + '...' }
            $msg = "az containerapp revision show exited $exit ($err)"
            Write-Annotation 'warning' "t/4935 env snapshot ($label): WARN fallback, no snapshot taken: $msg."
            Write-SnapshotFile $OutFile @{ app = $AppName; revision = $RevisionName; error = $msg; entries = @() }
            return
        }
    } finally {
        Remove-Item -LiteralPath $errFile -Force -ErrorAction SilentlyContinue
    }
    $containers = $null
    try {
        $containers = @((@($raw) -join "`n") | ConvertFrom-Json -ErrorAction Stop)
    } catch {
        # Fixed text on purpose: the parser's own message can quote the JSON, which holds the values.
        $containers = $null
    }
    if ($null -eq $containers -or $containers.Count -eq 0) {
        $msg = 'az returned no containers or output that is not valid JSON (details withheld: the output holds env values)'
        Write-Annotation 'warning' "t/4935 env snapshot ($label): WARN fallback, no snapshot taken: $msg."
        Write-SnapshotFile $OutFile @{ app = $AppName; revision = $RevisionName; error = $msg; entries = @() }
        return
    }
    if ($containers.Count -gt 1) {
        Write-Annotation 'warning' "t/4935 env snapshot ($label): WARN revision has $($containers.Count) containers; only containers[0] ('$($containers[0].name)') is compared."
    }
    $envProp = $containers[0].PSObject.Properties['env']
    $envVars = if ($null -ne $envProp -and $null -ne $envProp.Value) { @($envProp.Value) } else { @() }
    $entries = @(ConvertTo-ContainerEnvSnapshot -EnvVars $envVars -HashKey $key)
    $raw = $null; $containers = $null; $envVars = $null
    Write-SnapshotFile $OutFile @{ app = $AppName; revision = $RevisionName; error = ''; entries = $entries }
    $secretCount = @($entries | Where-Object { $_.SecretRef }).Count
    Write-Host "t/4935 env snapshot ($label): $($entries.Count) env entries ($secretCount secretRef). Names: $(@($entries | ForEach-Object Name) -join ', ')"
}

function Read-SnapshotFile([string] $Path) {
    if (-not (Test-Path -LiteralPath $Path)) {
        return @{ Entries = $null; Error = "no snapshot file at $Path (the snapshot step did not run or failed before writing)"; Revision = '' }
    }
    $doc = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -ErrorAction Stop
    $err = if ($doc.PSObject.Properties['error']) { [string]$doc.error } else { '' }
    $rev = if ($doc.PSObject.Properties['revision']) { [string]$doc.revision } else { '' }
    if (-not [string]::IsNullOrWhiteSpace($err)) { return @{ Entries = $null; Error = $err; Revision = $rev } }
    if ($null -eq $doc.PSObject.Properties['entries']) {
        return @{ Entries = $null; Error = "snapshot file $Path has no entries field"; Revision = $rev }
    }
    $entries = @(@($doc.entries) | Where-Object { $null -ne $_ } | ForEach-Object {
        $sr = $_.PSObject.Properties['SecretRef']; $vh = $_.PSObject.Properties['ValueHash']
        [pscustomobject]@{
            Name      = [string]$_.Name
            SecretRef = if ($null -ne $sr) { $sr.Value } else { $null }
            ValueHash = if ($null -ne $vh) { $vh.Value } else { $null }
        }
    })
    return @{ Entries = $entries; Error = ''; Revision = $rev }
}

function Invoke-Diff {
    $before = Read-SnapshotFile $BeforeFile
    $after = Read-SnapshotFile $AfterFile
    $config = $null
    if (Test-Path -LiteralPath $ExpectedChangesFile) {
        $config = Get-Content -LiteralPath $ExpectedChangesFile -Raw | ConvertFrom-Json -ErrorAction Stop
    } else {
        Write-Annotation 'warning' "t/4935 env diff ($Label): WARN fallback, allowlist '$ExpectedChangesFile' not found; only the built-in per-deploy names are allowed."
    }
    $verdict = Get-ContainerEnvDiffVerdict -Before $before.Entries -After $after.Entries `
        -BeforeError $before.Error -AfterError $after.Error -ExpectedChanges $config -Now ([datetime]::UtcNow)
    Write-Host "t/4935 env diff ($Label): serving revision '$($before.Revision)' -> new revision '$($after.Revision)'"
    foreach ($line in @(Format-ContainerEnvDiffVerdict -Verdict $verdict -Label $Label)) {
        Write-Annotation $line.Level $line.Message
    }
    if ($env:GITHUB_STEP_SUMMARY) {
        $md = [System.Collections.Generic.List[string]]::new()
        $md.Add("### Container env diff ($Label), t/4935 (warn-only)")
        $md.Add('')
        $md.Add("Serving ``$($before.Revision)`` -> new ``$($after.Revision)``: **$($verdict.Status.ToUpperInvariant())**, $($verdict.Reason).")
        if (@($verdict.Differences).Count -gt 0) {
            $md.Add('')
            $md.Add('| Name | Change | Before | After | Declared |')
            $md.Add('|---|---|---|---|---|')
            foreach ($d in @($verdict.Differences)) {
                $bf = if ($d.BeforeSecretRef) { "secretRef ``$($d.BeforeSecretRef)``" } elseif ($d.BeforeHash) { "hash ``$($d.BeforeHash.Substring(0, 12))``" } else { '' }
                $af = if ($d.AfterSecretRef) { "secretRef ``$($d.AfterSecretRef)``" } elseif ($d.AfterHash) { "hash ``$($d.AfterHash.Substring(0, 12))``" } else { '' }
                $dc = if ($d.Declared) { $d.DeclaredBy } else { '**no**' }
                $md.Add("| ``$($d.Name)`` | $($d.Change)$(if ($d.Detail) { " ($($d.Detail))" }) | $bf | $af | $dc |")
            }
        }
        Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Value ($md -join "`n")
    }
}

try {
    if ($PSCmdlet.ParameterSetName -eq 'Diff') { Invoke-Diff } else { Invoke-Snapshot }
} catch {
    # Every path that touches raw values has its own fixed-text catch above, so this message carries no value.
    $what = if ($PSCmdlet.ParameterSetName -eq 'Diff') { "env diff ($Label): GATE-UNREADABLE" } else { "env snapshot ($AppName)" }
    Write-Annotation 'warning' "t/4935 ${what}: WARN check crashed, deploy continues: $($_.Exception.GetType().Name): $($_.Exception.Message)"
    if ($PSCmdlet.ParameterSetName -eq 'Snapshot') {
        try {
            Write-SnapshotFile $OutFile @{ app = $AppName; revision = $RevisionName; error = "snapshot crashed: $($_.Exception.GetType().Name)"; entries = @() }
        } catch {
            Write-Annotation 'warning' "t/4935 env snapshot ($AppName): WARN could not write the error snapshot either: $($_.Exception.Message)"
        }
    }
}
exit 0
