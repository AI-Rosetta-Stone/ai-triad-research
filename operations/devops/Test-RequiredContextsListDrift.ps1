# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    t/3646 drift-guard: verify the committed required-contexts SSOT matches live branch protection.
.DESCRIPTION
    The SSOT (.github/ci/required-contexts.json) is a MIRROR of the required status checks on main;
    branch protection is authoritative. workflow-lint enforces its required-context rules against the
    workflows named in the SSOT, so a STALE SSOT makes the lint enforce the wrong set. This guard must
    be green on main BEFORE the lint is promoted to blocking (TL t/3646 ruling 1).

    Reading branch protection requires admin scope. The GitHub Actions default GITHUB_TOKEN does NOT
    have it, so this guard is intended to run where an admin-authenticated gh is available (the fleet
    host / a job with an admin PAT). If it cannot read protection it FAILS DEGRADED (exit 2), never a
    silent green — "could not verify" must not read as "in sync".

    Exit codes: 0 = in sync; 1 = DRIFT (details printed); 2 = could-not-verify (gh/SSOT unavailable).
.PARAMETER Repo
    owner/name. Default AI-Rosetta-Stone/ai-triad-research.
.PARAMETER SsotPath
    Path to the SSOT JSON. Default: <repo-root>/.github/ci/required-contexts.json.
#>

[CmdletBinding()]
param(
    [string]$Repo = 'AI-Rosetta-Stone/ai-triad-research',
    [string]$SsotPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

. "$PSScriptRoot/RequiredContextsDriftVerdict.ps1"

if (-not $SsotPath) {
    $repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # operations/devops -> repo root
    $SsotPath = Join-Path $repoRoot '.github/ci/required-contexts.json'
}

# ── Load the SSOT ────────────────────────────────────────────────────────────
if (-not (Test-Path -LiteralPath $SsotPath)) {
    Write-Host "::error::required-contexts drift-guard: SSOT not found at $SsotPath — cannot verify (exit 2)."
    exit 2
}
try {
    $ssotJson = Get-Content -LiteralPath $SsotPath -Raw | ConvertFrom-Json
    $ssotContexts = @($ssotJson.required_contexts | ForEach-Object { $_.context } | Where-Object { $_ })
} catch {
    Write-Host "::error::required-contexts drift-guard: SSOT malformed ($($_.Exception.Message)) — cannot verify (exit 2)."
    exit 2
}
if ($ssotContexts.Count -eq 0) {
    Write-Host "::error::required-contexts drift-guard: SSOT has no required_contexts — cannot verify (exit 2)."
    exit 2
}
# t/3804 PR-1: `strict` must be DECLARED in the SSOT, not assumed or hardcoded in this script body
# — an undeclared expectation is prose again, which is the t/3803 root cause this whole thread
# traces back to. Missing field -> cannot verify (same discipline as empty required_contexts).
if (-not $ssotJson.PSObject.Properties['strict']) {
    Write-Host "::error::required-contexts drift-guard: SSOT has no 'strict' field — cannot verify (exit 2)."
    exit 2
}
$ssotStrict = [bool]$ssotJson.strict

# ── Query live branch protection (needs admin gh) ────────────────────────────
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    Write-Host "::error::required-contexts drift-guard: gh not on PATH — cannot read branch protection (exit 2)."
    exit 2
}
$apiRaw = & gh api "repos/$Repo/branches/main/protection/required_status_checks" 2>&1
$apiExit = $LASTEXITCODE
if ($apiExit -ne 0) {
    $txt = ($apiRaw | ForEach-Object { "$_" }) -join ' '
    $why = if ($txt -match '(?i)404|not.*admin|must have admin|resource not accessible|403') {
        'no admin access to branch protection (the Actions default GITHUB_TOKEN lacks it — run with an admin gh/PAT)'
    } elseif ($txt -match '(?i)auth|login|token') { 'gh not authenticated' }
    else { "gh error: $($txt.Substring(0,[Math]::Min(160,$txt.Length)))" }
    Write-Host "::error::required-contexts drift-guard: could not read branch protection — $why (exit 2, NOT in-sync)."
    exit 2
}
try {
    $api = ($apiRaw | ForEach-Object { "$_" }) -join "`n" | ConvertFrom-Json
    # Prefer the modern `checks[].context`; fall back to the legacy `contexts[]`.
    $apiContexts = @()
    if ($api.PSObject.Properties['checks'] -and $api.checks) { $apiContexts = @($api.checks | ForEach-Object { $_.context }) }
    elseif ($api.PSObject.Properties['contexts']) { $apiContexts = @($api.contexts) }
    $apiContexts = @($apiContexts | Where-Object { $_ })
} catch {
    Write-Host "::error::required-contexts drift-guard: branch-protection payload unparseable ($($_.Exception.Message)) — cannot verify (exit 2)."
    exit 2
}
if ($apiContexts.Count -eq 0) {
    Write-Host "::error::required-contexts drift-guard: branch protection returned zero required contexts — cannot verify (exit 2)."
    exit 2
}
# t/3804 PR-1: `strict` is ALREADY IN THIS PAYLOAD (`{checks, contexts, contexts_url, strict, url}`
# per the sub-resource this guard already queries at :63) — no second API call, no endpoint change.
# Missing field here would mean GitHub changed its response shape; fail degraded, never silent-pass.
if (-not $api.PSObject.Properties['strict']) {
    Write-Host "::error::required-contexts drift-guard: branch-protection payload has no 'strict' field — cannot verify (exit 2)."
    exit 2
}
$apiStrict = [bool]$api.strict

# t/3804 PR-2: `enforce_admins` is NOT in the required_status_checks sub-resource (confirmed:
# [checks, contexts, contexts_url, strict, url] — no enforce_admins key). It lives on the PARENT
# /protection endpoint. Per TL/SO's parse-trap warning: do NOT repoint the call above to /protection
# — its contexts nest at .required_status_checks.checks[].context, not .checks[].context, so the
# existing parse at :86-88 would silently find zero contexts and fall into the exit-2 "zero
# contexts" arm (degraded, but with a misleading PAT/permissions-looking signature). Add a SEPARATE
# second call instead; the working contexts parse above is untouched.
if (-not $ssotJson.PSObject.Properties['enforce_admins']) {
    Write-Host "::error::required-contexts drift-guard: SSOT has no 'enforce_admins' field — cannot verify (exit 2)."
    exit 2
}
$ssotEnforceAdmins = [bool]$ssotJson.enforce_admins

$protectionRaw = & gh api "repos/$Repo/branches/main/protection" 2>&1
$protectionExit = $LASTEXITCODE
if ($protectionExit -ne 0) {
    $txt = ($protectionRaw | ForEach-Object { "$_" }) -join ' '
    $why = if ($txt -match '(?i)404|not.*admin|must have admin|resource not accessible|403') {
        'no admin access to branch protection (the Actions default GITHUB_TOKEN lacks it — run with an admin gh/PAT)'
    } elseif ($txt -match '(?i)auth|login|token') { 'gh not authenticated' }
    else { "gh error: $($txt.Substring(0,[Math]::Min(160,$txt.Length)))" }
    Write-Host "::error::required-contexts drift-guard: could not read branch protection (parent endpoint, for enforce_admins) — $why (exit 2, NOT in-sync)."
    exit 2
}
try {
    $protection = ($protectionRaw | ForEach-Object { "$_" }) -join "`n" | ConvertFrom-Json
} catch {
    Write-Host "::error::required-contexts drift-guard: branch-protection (parent) payload unparseable ($($_.Exception.Message)) — cannot verify (exit 2)."
    exit 2
}
if (-not $protection.PSObject.Properties['enforce_admins'] -or -not $protection.enforce_admins.PSObject.Properties['enabled']) {
    Write-Host "::error::required-contexts drift-guard: branch-protection (parent) payload has no 'enforce_admins.enabled' field — cannot verify (exit 2)."
    exit 2
}
$apiEnforceAdmins = [bool]$protection.enforce_admins.enabled

# ── Compare ──────────────────────────────────────────────────────────────────
$v = Get-RequiredContextsDriftVerdict -Ssot $ssotContexts -Api $apiContexts -SsotStrict $ssotStrict -ApiStrict $apiStrict -SsotEnforceAdmins $ssotEnforceAdmins -ApiEnforceAdmins $apiEnforceAdmins
Write-Host "SSOT:  $([string]::Join(', ', ($ssotContexts | Sort-Object))) | strict=$ssotStrict | enforce_admins=$ssotEnforceAdmins"
Write-Host "API:   $([string]::Join(', ', ($apiContexts | Sort-Object))) | strict=$apiStrict | enforce_admins=$apiEnforceAdmins"
if ($v.InSync) {
    Write-Host 'required-contexts drift-guard: IN SYNC — SSOT matches live branch protection.'
    exit 0
}
if ($v.MissingFromApi.Count -gt 0) {
    Write-Host "::error::required-contexts drift-guard: SSOT lists context(s) NOT required by branch protection (stale SSOT over-claims): $([string]::Join(', ', $v.MissingFromApi)) — update the SSOT or branch protection."
}
if ($v.MissingFromSsot.Count -gt 0) {
    Write-Host "::error::required-contexts drift-guard: branch protection requires context(s) MISSING from the SSOT (SSOT under-claims — the lint won't guard them): $([string]::Join(', ', $v.MissingFromSsot)) — add them to $SsotPath."
}
if (-not $v.StrictInSync) {
    # Anomaly direction matters (SO e/227#27): the SSOT's declared expectation is `false`, so
    # `strict: true` live is the regression to name explicitly — not a bare "values differ".
    $regressionNote = if ($apiStrict -and -not $ssotStrict) {
        " — live `strict: true` is a REGRESSION from the expected `false` (a busy main can flip a PR behind mid-check; see docs/shared-tree-divergence.md)."
    } else {
        ''
    }
    Write-Host "::error::required-contexts drift-guard: 'strict' mismatch — SSOT expects $ssotStrict, branch protection has $apiStrict.$regressionNote"
}
if (-not $v.EnforceAdminsInSync) {
    # Anomaly direction (SO e/227#27, same discipline as strict): the SSOT's declared expectation
    # is `true`, so `enforce_admins: false` live is the regression to name explicitly — this is
    # the setting that currently substitutes for two inert feedback rules (root AGENTS.md, t/3695).
    $eaRegressionNote = if ((-not $apiEnforceAdmins) -and $ssotEnforceAdmins) {
        " — live `enforce_admins: false` is a REGRESSION from the expected `true` (this silently re-opens the merge-on-untested-head and joint-gv auto-merge-stranding incident classes; see root AGENTS.md Pre-Self-Merge Verification, t/3695)."
    } else {
        ''
    }
    Write-Host "::error::required-contexts drift-guard: 'enforce_admins' mismatch — SSOT expects $ssotEnforceAdmins, branch protection has $apiEnforceAdmins.$eaRegressionNote"
}
exit 1
