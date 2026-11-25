# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
Read-only check of a proposed production deploy route, run before the route goes to the PI (t/612).

.DESCRIPTION
On t/579 a proposed route ("route B": dispatch deploy-azure.yml from a non-main branch) reached the PI
and then failed its first step, because the production environment only allows deploys from main.
This script checks a route before anyone proposes it. It makes no change anywhere.

Three checks, each PASS, FAIL or UNKNOWN. UNKNOWN (an API error, a rate limit, unreadable output)
counts as a failure: the script fails closed.

  1. branch-policy  The environment's deployment-branch policy allows the dispatch ref.
  2. ci             A completed CI run on the deploy SHA, from a trusted event (push to main or
                    epic/*, merge_group, workflow_dispatch), with test-container success or skipped.
                    The same rule as operations/devops/verify-deploy-ci.sh (t/591). Pull-request runs
                    never count.
  3. what-if        Every resource change the Bicep what-if reports, classified. Create or Delete, or
                    any property change other than a container image or known what-if noise, is
                    FLAGGED and fails the check.

The output is a Markdown block to paste on the incident ticket with the proposed route. The script
exits 0 only when all three checks PASS.

.PARAMETER Environment
GitHub environment the deploy job runs in. Default 'production'.

.PARAMETER Ref
The ref deploy-azure.yml would be dispatched from (for example 'main').

.PARAMETER Sha
The commit SHA whose image would be deployed (deploy-azure.yml's 'sha' input).

.PARAMETER WhatIfJsonPath
A saved `az deployment group what-if --no-pretty-print` JSON to classify instead of running a new
what-if. Use it to re-check a what-if already posted.

.PARAMETER SkipWhatIf
Skip check 3 (reported as UNKNOWN, so the script still exits non-zero).

.EXAMPLE
./deploy/azure/Test-DeployRoute.ps1 -Ref main -Sha 7e6241b5b8d46517e948c08377afc0279e33b955 -WhatIfJsonPath ./wi.json
#>
[CmdletBinding()]
param(
    [string]$Environment = 'production',
    [string]$Ref,
    [string]$Sha,
    [string]$Repo = 'AI-Rosetta-Stone/ai-triad-research',
    [string]$WhatIfJsonPath,
    [switch]$SkipWhatIf
)

Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot '..' '..' 'scripts' 'AITriad' 'Private' 'New-ActionableError.ps1')

# ── Thin wrappers around the CLIs, so tests can replace them ───────────────────────────────────

function Invoke-RouteGh {
    param([Parameter(Mandatory)][string[]]$Arguments)
    $out = & gh @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        New-ActionableError -Goal "Read GitHub state for the deploy route check (gh $($Arguments[1]))" `
            -Problem "gh exited $LASTEXITCODE`: $out" -Location 'deploy/azure/Test-DeployRoute.ps1 Invoke-RouteGh' `
            -NextSteps @('Check gh auth status and the GitHub API rate limit (gh api rate_limit)', 'Re-run the route check; the affected check reports UNKNOWN until then') -Throw
    }
    return ($out -join "`n")
}

# ── Check 1: deployment-branch policy ───────────────────────────────────────────────────────────

function ConvertTo-RefPatternRegex {
    # GitHub deployment-branch patterns are fnmatch-style: '*' matches any run without '/',
    # '**' matches anything, '?' one character.
    param([Parameter(Mandatory)][string]$Pattern)
    $sb = [System.Text.StringBuilder]::new('^')
    for ($i = 0; $i -lt $Pattern.Length; $i++) {
        $c = $Pattern[$i]
        if ($c -eq '*' -and $i + 1 -lt $Pattern.Length -and $Pattern[$i + 1] -eq '*') { [void]$sb.Append('.*'); $i++ }
        elseif ($c -eq '*') { [void]$sb.Append('[^/]*') }
        elseif ($c -eq '?') { [void]$sb.Append('[^/]') }
        else { [void]$sb.Append([regex]::Escape([string]$c)) }
    }
    [void]$sb.Append('$')
    return $sb.ToString()
}

function Test-BranchPolicy {
    param([Parameter(Mandatory)][string]$Environment, [Parameter(Mandatory)][string]$Ref, [string]$Repo)
    try {
        $env = Invoke-RouteGh @('api', "repos/$Repo/environments/$Environment") | ConvertFrom-Json
        $policy = $env.deployment_branch_policy
        if ($null -eq $policy) {
            return [pscustomobject]@{ Check = 'branch-policy'; Status = 'PASS'; Detail = "environment '$Environment' has no deployment-branch policy; any ref may deploy" }
        }
        if ($policy.protected_branches) {
            $branch = Invoke-RouteGh @('api', "repos/$Repo/branches/$Ref") | ConvertFrom-Json
            $ok = [bool]$branch.protected
            return [pscustomobject]@{ Check = 'branch-policy'; Status = $(if ($ok) { 'PASS' } else { 'FAIL' }); Detail = "policy: protected branches only; '$Ref' protected=$ok" }
        }
        $list = Invoke-RouteGh @('api', "repos/$Repo/environments/$Environment/deployment-branch-policies") | ConvertFrom-Json
        $patterns = @($list.branch_policies | Where-Object { -not $_.PSObject.Properties['type'] -or $_.type -eq 'branch' } | ForEach-Object { $_.name })
        $match = $patterns | Where-Object { $Ref -match (ConvertTo-RefPatternRegex $_) } | Select-Object -First 1
        if ($match) {
            return [pscustomobject]@{ Check = 'branch-policy'; Status = 'PASS'; Detail = "ref '$Ref' matches allowed pattern '$match'" }
        }
        return [pscustomobject]@{ Check = 'branch-policy'; Status = 'FAIL'; Detail = "ref '$Ref' matches none of the allowed patterns: $($patterns -join ', '). GitHub will reject the deploy job before any step runs." }
    }
    catch {
        return [pscustomobject]@{ Check = 'branch-policy'; Status = 'UNKNOWN'; Detail = "cannot verify the branch policy: $($_.Exception.Message)" }
    }
}

# ── Check 2: trusted green CI on the SHA ────────────────────────────────────────────────────────

function Test-TrustedEvent {
    param([string]$Event, [string]$Branch)
    switch ($Event) {
        'merge_group' { return $true }
        'workflow_dispatch' { return $true }
        'push' { return ($Branch -eq 'main' -or $Branch -like 'epic/*') }
        default { return $false }
    }
}

function Test-TrustedCi {
    param([Parameter(Mandatory)][string]$Sha, [string]$Repo)
    try {
        $runs = (Invoke-RouteGh @('api', "repos/$Repo/actions/workflows/ci.yml/runs?head_sha=$Sha&per_page=100") | ConvertFrom-Json).workflow_runs
        $seen = @()
        foreach ($run in @($runs)) {
            $seen += "$($run.id):$($run.event):$($run.status):$($run.conclusion)"
            if (-not (Test-TrustedEvent -Event $run.event -Branch $run.head_branch)) { continue }
            if ($run.status -ne 'completed') { continue }
            $jobs = (Invoke-RouteGh @('api', "repos/$Repo/actions/runs/$($run.id)/jobs?per_page=100") | ConvertFrom-Json).jobs
            $tc = @($jobs | Where-Object { $_.name -eq 'test-container' }) | Select-Object -First 1
            if ($tc -and ($tc.conclusion -eq 'success' -or $tc.conclusion -eq 'skipped')) {
                return [pscustomobject]@{ Check = 'ci'; Status = 'PASS'; Detail = "CI run $($run.id) ($($run.event) on $($run.head_branch)): test-container $($tc.conclusion)" }
            }
        }
        $what = if ($seen.Count) { "runs seen: $($seen -join ', ')" } else { 'no CI run on this SHA' }
        return [pscustomobject]@{ Check = 'ci'; Status = 'FAIL'; Detail = "no completed green trusted CI run on $Sha ($what). Pull-request runs never count. Fix: dispatch ci.yml on a branch whose head is $Sha." }
    }
    catch {
        return [pscustomobject]@{ Check = 'ci'; Status = 'UNKNOWN'; Detail = "cannot verify CI (this is not a CI failure): $($_.Exception.Message)" }
    }
}

# ── Check 3: what-if classification ─────────────────────────────────────────────────────────────

# Property paths that every deploy's what-if shows without being a real change: values the workflow
# supplies but a local what-if cannot (secrets and the auth providers built from them), env entries
# the deploy step stamps after the Bicep apply, settings ARM normalises, and unevaluated reference()
# expressions. Each was seen in the t/579 what-ifs (t/579#8, #26, #69).
$script:NoisePaths = @(
    '^properties\.configuration\.secrets'
    '^properties\.configuration\.ingress\.exposedPort$'
    '^properties\.template\.revisionSuffix$'
    '^properties\.identityProviders\.'
    '^properties\.login\.allowedExternalRedirectUrls'
    '^properties\.(denyEncryptionScopeOverride|defaultEncryptionScope|accessTier)$'
    '^properties\.deleteRetentionPolicy\.allowPermanentDelete$'
    '^properties\.networkAcls'
    '^properties\.(logs|logAnalyticsDestinationType)'
    '^properties\.appLogsConfiguration\.logAnalyticsConfiguration\.customerId$'
    '^properties\.(peerTrafficConfiguration|peerAuthentication)'
    '^properties\.principalId$'
    '^properties\.timePeriod\.(startDate|endDate)$'
    '^properties\.(Flow_Type|Request_Source)$'
)
$script:StampedEnv = @('DEPLOY_SHA', 'DEPLOY_TAG', 'IMAGE_DIGEST', 'IMAGE_DEPLOYED_AT')

function Test-NoiseValue {
    param($Value)
    if ($Value -is [string]) { return $Value.StartsWith('[') }
    if ($null -ne $Value -and $Value.PSObject.Properties['name']) {
        if ($script:StampedEnv -contains $Value.name) { return $true }
        if ($Value.PSObject.Properties['secretRef']) { return $true }
    }
    return $false
}

function Get-WhatIfLeaves {
    # Flattens a what-if delta tree into leaves: {Path, ChangeType, Before, After}.
    param($Nodes, [string]$Prefix = '')
    foreach ($n in @($Nodes)) {
        if ($null -eq $n) { continue }
        $path = if ($Prefix) { "$Prefix.$($n.path)" } else { [string]$n.path }
        [object[]]$kids = @()
        if ($n.PSObject.Properties['children'] -and $null -ne $n.children) {
            [object[]]$kids = @($n.children | Where-Object { $null -ne $_ })
        }
        if ($kids.Length -gt 0) {
            Get-WhatIfLeaves -Nodes $kids -Prefix $path
        }
        else {
            $before = if ($n.PSObject.Properties['before']) { $n.before } else { $null }
            $after = if ($n.PSObject.Properties['after']) { $n.after } else { $null }
            [pscustomobject]@{ Path = $path; ChangeType = $n.propertyChangeType; Before = $before; After = $after }
        }
    }
}

function Get-WhatIfClassification {
    param([Parameter(Mandatory)]$WhatIf)
    $rows = [System.Collections.Generic.List[object]]::new()
    foreach ($ch in @($WhatIf.changes)) {
        $res = ($ch.resourceId -split '/providers/')[-1]
        if ($ch.changeType -in 'Create', 'Delete', 'Deploy') {
            $rows.Add([pscustomobject]@{ Resource = $res; Path = '(resource)'; Change = $ch.changeType; Class = 'FLAG' })
            continue
        }
        if ($ch.changeType -ne 'Modify') { continue }
        foreach ($leaf in Get-WhatIfLeaves -Nodes $ch.delta) {
            $class =
                if ($leaf.ChangeType -eq 'NoEffect') { 'NOISE' }
                elseif ($leaf.Path -match '^properties\.template\.containers\.\d+\.image$') { 'IMAGE' }
                elseif ($script:NoisePaths | Where-Object { $leaf.Path -match $_ }) { 'NOISE' }
                elseif ((Test-NoiseValue $leaf.After) -or (Test-NoiseValue $leaf.Before)) { 'NOISE' }
                else { 'FLAG' }
            $rows.Add([pscustomobject]@{ Resource = $res; Path = $leaf.Path; Change = $leaf.ChangeType; Class = $class })
        }
    }
    return $rows
}

function Test-WhatIf {
    param([string]$WhatIfJsonPath, [switch]$SkipWhatIf)
    if ($SkipWhatIf) {
        return [pscustomobject]@{ Check = 'what-if'; Status = 'UNKNOWN'; Detail = 'skipped (-SkipWhatIf)'; Rows = @() }
    }
    if (-not $WhatIfJsonPath) {
        return [pscustomobject]@{ Check = 'what-if'; Status = 'UNKNOWN'; Detail = 'no what-if supplied: run the what-if from the dispatch ref (deploy-azure.yml''s parameters, --no-pretty-print) and pass -WhatIfJsonPath'; Rows = @() }
    }
    try {
        $wi = Get-Content -Raw -LiteralPath $WhatIfJsonPath | ConvertFrom-Json
        $rows = @(Get-WhatIfClassification -WhatIf $wi)
        $counts = @($wi.changes) | Group-Object changeType | ForEach-Object { "$($_.Name) $($_.Count)" }
        $flags = @($rows | Where-Object Class -eq 'FLAG')
        $images = @($rows | Where-Object Class -eq 'IMAGE')
        $detail = "changes: $($counts -join ', '); image changes: $($images.Count); flagged: $($flags.Count)"
        return [pscustomobject]@{ Check = 'what-if'; Status = $(if ($flags.Count -eq 0) { 'PASS' } else { 'FAIL' }); Detail = $detail; Rows = $rows }
    }
    catch {
        return [pscustomobject]@{ Check = 'what-if'; Status = 'UNKNOWN'; Detail = "cannot read the what-if: $($_.Exception.Message)"; Rows = @() }
    }
}

# ── Report ──────────────────────────────────────────────────────────────────────────────────────

function Format-RouteReport {
    param([Parameter(Mandatory)]$Results, [string]$Environment, [string]$Ref, [string]$Sha)
    $ok = -not ($Results | Where-Object Status -ne 'PASS')
    $lines = @("## Deploy route check (t/612): $(if ($ok) { 'ALL PASS' } else { 'NOT SAFE TO PROPOSE' })",
        '', "Environment ``$Environment``, dispatch ref ``$Ref``, image SHA ``$Sha``.", '',
        '| Check | Result | Detail |', '|---|---|---|')
    foreach ($r in $Results) { $lines += "| $($r.Check) | **$($r.Status)** | $($r.Detail -replace '\|', '/') |" }
    $wi = $Results | Where-Object Check -eq 'what-if' | Select-Object -First 1
    if ($wi -and $wi.Rows) {
        $lines += '', 'What-if changes other than noise:', ''
        foreach ($row in @($wi.Rows | Where-Object Class -ne 'NOISE')) { $lines += "- **$($row.Class)** ``$($row.Resource)`` ``$($row.Path)`` ($($row.Change))" }
    }
    return ($lines -join "`n")
}

function Invoke-DeployRouteCheck {
    if (-not $Ref -or -not $Sha) {
        New-ActionableError -Goal 'Check a production deploy route (t/612)' -Problem '-Ref and -Sha are both required' `
            -Location 'deploy/azure/Test-DeployRoute.ps1' -NextSteps @('Pass -Ref <dispatch ref> -Sha <image commit SHA>') -Throw
    }
    $results = @(
        Test-BranchPolicy -Environment $Environment -Ref $Ref -Repo $Repo
        Test-TrustedCi -Sha $Sha -Repo $Repo
        Test-WhatIf -WhatIfJsonPath $WhatIfJsonPath -SkipWhatIf:$SkipWhatIf
    )
    Format-RouteReport -Results $results -Environment $Environment -Ref $Ref -Sha $Sha
    if ($results | Where-Object Status -ne 'PASS') { exit 1 }
    exit 0
}

if ($MyInvocation.InvocationName -ne '.') { Invoke-DeployRouteCheck }
