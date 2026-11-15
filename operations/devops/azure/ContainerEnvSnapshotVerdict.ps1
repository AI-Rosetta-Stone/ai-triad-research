# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
Pure core for the container-env snapshot diff around deploys (t/4935): turns a revision's env array into a
value-free snapshot, and diffs two snapshots (added / removed / changed, by name) against a checked-in
expected-change allowlist.

.DESCRIPTION
`az deployment group what-if` reports `template.containers[0].env` as a raw, unevaluated ARM expression, not
as an array, so the deploy's "Preview Bicep changes (what-if)" step cannot see a dropped secretRef or a wrong
override. This file lets the deploy workflows compare the env of the revision serving traffic BEFORE the deploy
with the env of the new 0%-traffic revision BEFORE traffic shifts to it.

VALUE SAFETY. A snapshot entry is (Name, SecretRef, ValueHash). The raw value never leaves
ConvertTo-ContainerEnvSnapshot. The hash is HMAC-SHA256 under a caller-supplied key: the workflow generates a
random key per run (kept in RUNNER_TEMP, never printed), so the hashes in the public Actions log cannot be
reversed by guessing a low-entropy value ("true", a container name) and cannot be linked across runs. Without
-HashKey the hash is plain SHA-256; that mode is for tests only.

PURE: no I/O. Invoke-ContainerEnvSnapshot.ps1 is the thin shim that calls `az` and reads/writes files.
#>

Set-StrictMode -Version Latest

# The project's helper lives in AITriad's Private/ (not exported). Dot-source it directly, the same way
# deploy-staging.yml does, so this file works from CI steps that do not import AITriad.psm1.
if (-not (Get-Command New-ActionableError -ErrorAction SilentlyContinue)) {
    . (Join-Path $PSScriptRoot '..' '..' '..' 'scripts' 'AITriad' 'Private' 'New-ActionableError.ps1')
}

# Names whose value is EXPECTED to differ on every deploy: New-ContainerAppRevision stamps them with the
# deployed commit and time (deploy-azure.yml / deploy-staging.yml "Deploy new revision" steps). They are
# allowed to be 'changed' or 'added', never 'removed'. Kept in code, not only in the JSON file, so an edit to
# the allowlist file can't accidentally drop them and turn every deploy into a warning.
$script:BuiltInAlwaysChanges = @('DEPLOY_SHA', 'DEPLOY_TAG', 'IMAGE_DIGEST', 'IMAGE_DEPLOYED_AT')

$script:ValidChangeKinds = @('added', 'removed', 'changed', 'any')

$script:ErrorGoal = "Snapshot a container app revision's env for the deploy env diff (t/4935)"
$script:ErrorLocation = 'operations/devops/azure/ContainerEnvSnapshotVerdict.ps1: ConvertTo-ContainerEnvSnapshot'

function Get-ContainerEnvValueHash {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][AllowEmptyString()][string] $Value,
        [byte[]] $HashKey
    )
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value)
    if ($null -ne $HashKey -and $HashKey.Length -gt 0) {
        $digest = [System.Security.Cryptography.HMACSHA256]::HashData($HashKey, $bytes)
    } else {
        $digest = [System.Security.Cryptography.SHA256]::HashData($bytes)
    }
    return ([System.Convert]::ToHexString($digest)).ToLowerInvariant()
}

function ConvertTo-ContainerEnvSnapshot {
    <#
    .SYNOPSIS
    Converts a container's env array (the shape `az containerapp revision show` returns under
    properties.template.containers[N].env) into value-free entries, sorted by name.
    .OUTPUTS
    [pscustomobject[]] with Name, SecretRef (string or $null) and ValueHash (string or $null; $null when the
    entry has no `value` property, e.g. a secretRef entry). An empty string value is hashed, so "" and
    "absent" stay distinguishable.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][AllowNull()][object[]] $EnvVars,
        [byte[]] $HashKey
    )
    $entries = [System.Collections.Generic.List[object]]::new()
    $seen = @{}
    foreach ($e in @($EnvVars)) {
        if ($null -eq $e) { continue }
        $nameProp = $e.PSObject.Properties['name']
        if ($null -eq $nameProp -or [string]::IsNullOrWhiteSpace([string]$nameProp.Value)) {
            # Never echo the entry: it may carry a value.
            throw (New-ActionableError -AsErrorRecord -Goal $script:ErrorGoal -Location $script:ErrorLocation `
                -Problem 'An env entry has no name.' `
                -NextSteps @('Inspect the revision env shape with: az containerapp revision show ... --query "properties.template.containers[0].env[].name"'))
        }
        $name = [string]$nameProp.Value
        if ($seen.ContainsKey($name)) {
            throw (New-ActionableError -AsErrorRecord -Goal $script:ErrorGoal -Location $script:ErrorLocation `
                -Problem "The env array has more than one entry named '$name'." `
                -NextSteps @("Remove the duplicate '$name' from the template (main.bicep baseEnv or the --set-env-vars caller).",
                             'ACA normally rejects duplicates, so this also points at a malformed az response.'))
        }
        $seen[$name] = $true
        $secretProp = $e.PSObject.Properties['secretRef']
        $secretRef = if ($null -ne $secretProp -and -not [string]::IsNullOrEmpty([string]$secretProp.Value)) { [string]$secretProp.Value } else { $null }
        $valueProp = $e.PSObject.Properties['value']
        $valueHash = if ($null -ne $valueProp) {
            $raw = if ($null -eq $valueProp.Value) { '' } else { [string]$valueProp.Value }
            Get-ContainerEnvValueHash -Value $raw -HashKey $HashKey
        } else { $null }
        $entries.Add([pscustomobject]@{ Name = $name; SecretRef = $secretRef; ValueHash = $valueHash })
    }
    return @($entries | Sort-Object -Property Name -CaseSensitive)
}

function Get-ContainerEnvExpectedChange {
    <#
    .SYNOPSIS
    Normalises the checked-in allowlist (container-env-expected-changes.json) into rules, and reports malformed
    or expired entries as warnings. An expired or malformed entry allows nothing.
    .OUTPUTS
    @{ Rules = [pscustomobject[]] (Name, Change, Ticket, Source); Warnings = [string[]] }
    #>
    [CmdletBinding()]
    param(
        [AllowNull()][object] $Config,
        [Parameter(Mandatory)][datetime] $Now
    )
    $rules = [System.Collections.Generic.List[object]]::new()
    $warnings = [System.Collections.Generic.List[string]]::new()
    foreach ($n in $script:BuiltInAlwaysChanges) {
        $rules.Add([pscustomobject]@{ Name = $n; Change = 'changed'; Ticket = 't/4935'; Source = 'built-in (stamped every deploy)' })
        $rules.Add([pscustomobject]@{ Name = $n; Change = 'added'; Ticket = 't/4935'; Source = 'built-in (stamped every deploy)' })
    }
    if ($null -eq $Config) {
        return @{ Rules = @($rules); Warnings = @($warnings) }
    }
    $listProp = $Config.PSObject.Properties['expectedChanges']
    $list = if ($null -ne $listProp -and $null -ne $listProp.Value) { @($listProp.Value) } else { @() }
    $i = 0
    foreach ($entry in $list) {
        $i++
        $get = { param($p) $prop = $entry.PSObject.Properties[$p]; if ($null -ne $prop -and $null -ne $prop.Value) { [string]$prop.Value } else { '' } }
        $name = & $get 'name'
        $change = (& $get 'change').ToLowerInvariant()
        $ticket = & $get 'ticket'
        $expires = & $get 'expires'
        if ([string]::IsNullOrWhiteSpace($name) -or [string]::IsNullOrWhiteSpace($ticket) -or [string]::IsNullOrWhiteSpace($expires) -or $script:ValidChangeKinds -notcontains $change) {
            $warnings.Add("expectedChanges[$i] is malformed (needs name, change in {$($script:ValidChangeKinds -join ', ')}, ticket and expires) and allows nothing.")
            continue
        }
        $expiry = [datetime]::MinValue
        if (-not [datetime]::TryParseExact($expires, 'yyyy-MM-dd', [System.Globalization.CultureInfo]::InvariantCulture,
                [System.Globalization.DateTimeStyles]::AssumeUniversal -bor [System.Globalization.DateTimeStyles]::AdjustToUniversal, [ref]$expiry)) {
            $warnings.Add("expectedChanges[$i] ($name) has expires '$expires', not yyyy-MM-dd, and allows nothing.")
            continue
        }
        # Inclusive: an entry expiring 2026-11-30 still applies on that whole UTC day.
        if ($Now.ToUniversalTime() -ge $expiry.AddDays(1)) {
            $warnings.Add("expectedChanges[$i] ($name, $ticket) expired on $expires and allows nothing. Remove it from the allowlist.")
            continue
        }
        $rules.Add([pscustomobject]@{ Name = $name; Change = $change; Ticket = $ticket; Source = 'allowlist' })
    }
    return @{ Rules = @($rules); Warnings = @($warnings) }
}

function Get-ContainerEnvDiffVerdict {
    <#
    .SYNOPSIS
    Diffs two snapshots by name and classifies each difference as declared (allowed) or undeclared.
    .OUTPUTS
    [pscustomobject] Status ('clean' | 'declared' | 'drift' | 'unreadable'), Reason, Differences (each Name,
    Change, Detail, BeforeSecretRef, AfterSecretRef, BeforeHash, AfterHash, Declared, DeclaredBy), Undeclared,
    ConfigWarnings.
    #>
    [CmdletBinding()]
    param(
        [AllowNull()][AllowEmptyCollection()][object[]] $Before,
        [AllowNull()][AllowEmptyCollection()][object[]] $After,
        [AllowEmptyString()][AllowNull()][string] $BeforeError,
        [AllowEmptyString()][AllowNull()][string] $AfterError,
        [AllowNull()][object] $ExpectedChanges,
        [Parameter(Mandatory)][datetime] $Now
    )
    $expected = Get-ContainerEnvExpectedChange -Config $ExpectedChanges -Now $Now
    $unreadable = @()
    if (-not [string]::IsNullOrWhiteSpace($BeforeError)) { $unreadable += "before snapshot unreadable: $BeforeError" }
    elseif ($null -eq $Before) { $unreadable += 'before snapshot missing' }
    if (-not [string]::IsNullOrWhiteSpace($AfterError)) { $unreadable += "after snapshot unreadable: $AfterError" }
    elseif ($null -eq $After) { $unreadable += 'after snapshot missing' }
    if ($unreadable.Count -gt 0) {
        return [pscustomobject]@{
            Status = 'unreadable'; Reason = ($unreadable -join '; ')
            Differences = @(); Undeclared = @(); ConfigWarnings = @($expected.Warnings)
        }
    }

    $b = @{}; foreach ($e in @($Before)) { $b[[string]$e.Name] = $e }
    $a = @{}; foreach ($e in @($After)) { $a[[string]$e.Name] = $e }
    $names = @(@($b.Keys) + @($a.Keys) | Sort-Object -Unique -CaseSensitive)
    $diffs = [System.Collections.Generic.List[object]]::new()
    foreach ($n in $names) {
        $be = if ($b.ContainsKey($n)) { $b[$n] } else { $null }
        $ae = if ($a.ContainsKey($n)) { $a[$n] } else { $null }
        $change = $null; $detail = $null
        if ($null -eq $be) { $change = 'added' }
        elseif ($null -eq $ae) { $change = 'removed' }
        else {
            $refDiff = [string]$be.SecretRef -cne [string]$ae.SecretRef
            $hashDiff = ($null -eq $be.ValueHash) -ne ($null -eq $ae.ValueHash) -or [string]$be.ValueHash -cne [string]$ae.ValueHash
            if ($refDiff -and $hashDiff) { $change = 'changed'; $detail = 'source' }
            elseif ($refDiff) { $change = 'changed'; $detail = 'secretRef' }
            elseif ($hashDiff) { $change = 'changed'; $detail = 'value' }
        }
        if ($null -eq $change) { continue }
        $rule = @($expected.Rules | Where-Object { $_.Name -ceq $n -and ($_.Change -eq $change -or $_.Change -eq 'any') }) | Select-Object -First 1
        $diffs.Add([pscustomobject]@{
            Name            = $n
            Change          = $change
            Detail          = $detail
            BeforeSecretRef = if ($null -ne $be) { $be.SecretRef } else { $null }
            AfterSecretRef  = if ($null -ne $ae) { $ae.SecretRef } else { $null }
            BeforeHash      = if ($null -ne $be) { $be.ValueHash } else { $null }
            AfterHash       = if ($null -ne $ae) { $ae.ValueHash } else { $null }
            Declared        = ($null -ne $rule)
            DeclaredBy      = if ($null -ne $rule) { "$($rule.Source) $($rule.Ticket)" } else { $null }
        })
    }
    $undeclared = @($diffs | Where-Object { -not $_.Declared })
    $status = if ($diffs.Count -eq 0) { 'clean' } elseif ($undeclared.Count -eq 0) { 'declared' } else { 'drift' }
    $reason = switch ($status) {
        'clean'    { 'no env differences' }
        'declared' { "$($diffs.Count) env difference(s), all declared" }
        'drift'    { "$($undeclared.Count) undeclared env difference(s) of $($diffs.Count)" }
    }
    return [pscustomobject]@{
        Status = $status; Reason = $reason
        Differences = @($diffs); Undeclared = $undeclared; ConfigWarnings = @($expected.Warnings)
    }
}

function Format-ContainerEnvDiffVerdict {
    <#
    .SYNOPSIS
    Renders a verdict as annotation lines. Names, secretRef names and 12-hex hash prefixes only: the verdict
    holds no raw values, so nothing here can print one.
    .OUTPUTS
    [pscustomobject[]] Level ('warning' | 'notice'), Message.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][object] $Verdict,
        [Parameter(Mandatory)][string] $Label
    )
    $short = { param($h) if ([string]::IsNullOrEmpty($h)) { '(none)' } else { $h.Substring(0, [Math]::Min(12, $h.Length)) } }
    $describe = {
        param($d)
        switch ($d.Change) {
            'added'   { if ($d.AfterSecretRef) { "added (secretRef $($d.AfterSecretRef))" } else { "added (value hash $(& $short $d.AfterHash))" } }
            'removed' { if ($d.BeforeSecretRef) { "removed (was secretRef $($d.BeforeSecretRef))" } else { "removed (was value hash $(& $short $d.BeforeHash))" } }
            'changed' {
                switch ($d.Detail) {
                    'secretRef' { "secretRef changed $($d.BeforeSecretRef) -> $($d.AfterSecretRef)" }
                    'value'     { "value changed, hash $(& $short $d.BeforeHash) -> $(& $short $d.AfterHash)" }
                    default {
                        $from = if ($d.BeforeSecretRef) { "secretRef $($d.BeforeSecretRef)" } else { "value hash $(& $short $d.BeforeHash)" }
                        $to   = if ($d.AfterSecretRef)  { "secretRef $($d.AfterSecretRef)" }  else { "value hash $(& $short $d.AfterHash)" }
                        "source changed, $from -> $to"
                    }
                }
            }
        }
    }
    $lines = [System.Collections.Generic.List[object]]::new()
    foreach ($w in @($Verdict.ConfigWarnings)) {
        $lines.Add([pscustomobject]@{ Level = 'warning'; Message = "t/4935 env diff ($Label): WARN allowlist: $w" })
    }
    switch ($Verdict.Status) {
        'unreadable' {
            $lines.Add([pscustomobject]@{ Level = 'warning'; Message = "t/4935 env diff ($Label): GATE-UNREADABLE, not a pass: $($Verdict.Reason). Env changes on this deploy were NOT checked." })
        }
        'clean' {
            $lines.Add([pscustomobject]@{ Level = 'notice'; Message = "t/4935 env diff ($Label): PASS, no env differences between the serving and new revision." })
        }
        default {
            foreach ($d in @($Verdict.Differences)) {
                if ($d.Declared) {
                    $lines.Add([pscustomobject]@{ Level = 'notice'; Message = "t/4935 env diff ($Label): declared: $($d.Name) $(& $describe $d) [$($d.DeclaredBy)]" })
                } else {
                    $lines.Add([pscustomobject]@{ Level = 'warning'; Message = "t/4935 env diff ($Label): UNDECLARED: $($d.Name) $(& $describe $d). Declare it in operations/devops/azure/container-env-expected-changes.json if intended (warn-only, deploy not blocked)." })
                }
            }
            $lines.Add([pscustomobject]@{ Level = if ($Verdict.Status -eq 'drift') { 'warning' } else { 'notice' }; Message = "t/4935 env diff ($Label): $($Verdict.Status.ToUpperInvariant()): $($Verdict.Reason)." })
        }
    }
    return @($lines)
}
