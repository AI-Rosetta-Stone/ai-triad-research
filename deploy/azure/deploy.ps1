# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Deploy the Taxonomy Editor to Azure Container Apps.
.DESCRIPTION
    One-command deployment: creates resource group, deploys Bicep template,
    seeds initial data from GitHub, and configures CORS.

    BYOK model: No API keys are passed to Azure. Users enter their own
    Gemini/Claude/Groq API keys through the app's UI after deployment.
    Keys are encrypted and stored on the Azure Files data volume.
.PARAMETER ResourceGroup
    Azure resource group name (created if it doesn't exist).
.PARAMETER Location
    Azure region. Default: eastus.
.PARAMETER ContainerImage
    Container image reference. Default: ghcr.io/ai-rosetta-stone/taxonomy-editor:latest
.PARAMETER SeedData
    Clone ai-triad-data into the Azure Files share on first deploy.
.PARAMETER SkipLogin
    Skip az login check (for CI/CD environments).
.PARAMETER EnableGitSync
    Turn on the Phase-2 GitHub sync feature. Requires a GitHub App (or PAT)
    plus the data directory being a real git clone.
.PARAMETER GitHubRepo
    Target repo in owner/repo form (e.g. "AI-Rosetta-Stone/ai-triad-data").
.PARAMETER GitHubAppId
    GitHub App numeric ID.
.PARAMETER GitHubAppInstallationId
    Installation ID of the App on the target repo/org.
.PARAMETER GitHubAppPrivateKeySecretName
    Name of the Key Vault secret holding the App's PEM private key.
    Upload it once with:
      az keyvault secret set --vault-name <vault> --name <name> --file key.pem
.PARAMETER GitHubWebhookSecret
    HMAC shared secret for the GitHub webhook. When set, the server verifies
    X-Hub-Signature-256 and flags "upstream updated" for the UI on merged PRs.
.EXAMPLE
    ./deploy.ps1 -ResourceGroup ai-triad
.EXAMPLE
    ./deploy.ps1 -ResourceGroup ai-triad -SeedData
.EXAMPLE
    ./deploy.ps1 -ResourceGroup ai-triad `
        -EnableGitSync `
        -GitHubRepo 'AI-Rosetta-Stone/ai-triad-data' `
        -GitHubAppId '123456' `
        -GitHubAppInstallationId '7890123' `
        -GitHubAppPrivateKeySecretName 'github-app-private-key'
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ResourceGroup,

    [string]$Location = 'eastus',

    # This MANUAL script defaults to the mutable :latest tag as a bootstrap/escape hatch.
    # NOTE — t/3679 SUPERSEDES the old t/3523 rationale that used to live here: the AUTOMATED
    # workflow path (deploy-azure.yml / deploy-staging.yml) NO LONGER uses :latest. It pins each
    # deploy to an IMMUTABLE @sha256 digest (resolved from the built commit's permanent sha-<commit>
    # tag), so on that path the ACA revision's template `image` field holds a resolved DIGEST (not a
    # tag) and a pod recycle re-pulls identical bytes. On THIS manual :latest path the deployed
    # version is still recorded at commit granularity via: the live /health buildSha (full commit
    # SHA, queryable anytime); and the ACA REVISION NAME, which encodes the deployed short-SHA
    # (e.g. `taxonomy-editor--deploy-89c3d9a-…`, `az containerapp revision list`).
    # So reproducibility here is COMMIT-granular (revision-name + /health), not digest-pinned;
    # that's sufficient for this single-app deploy. Rollback is a revision-layer op — roll back to
    # a prior commit-named revision (see production-release.md `az containerapp ingress traffic set`),
    # independent of this tag. Pinning the default would force a per-release bump — its own
    # forget/drift surface — for no gain the revision layer doesn't already provide. To pin a
    # SPECIFIC version for one deploy, pass -ContainerImage a full @sha256 digest ref.
    # t/3679 (deploy-by-digest): the AUTOMATED workflow path now ALWAYS pins by digest —
    # deploy-azure.yml takes an explicit `sha` input and resolves the commit's PERMANENT
    # sha-<commit> tag to its immutable @sha256 digest (Resolve-ImageDigest.ps1); it no longer
    # accepts image_tag or defaults to :latest. THIS script is the MANUAL path — its :latest
    # default is the hand-run/bootstrap escape hatch. For a reproducible manual deploy pass
    # -ContainerImage the digest (resolve via: Get-TaxEditorImage | ? { $_.Tags -contains "sha-<commit>" }).
    [string]$ContainerImage = 'ghcr.io/ai-rosetta-stone/taxonomy-editor:latest',

    [switch]$SeedData,

    [switch]$SkipLogin,

    # OAuth providers (optional — leave empty for anonymous-only deployment)
    [string]$GoogleClientId = '',
    [string]$GoogleClientSecret = '',
    [string]$GitHubClientId = '',
    [string]$GitHubClientSecret = '',

    # GitHub sync (Phase-2/3) options. Leave empty to keep the feature off.
    [switch]$EnableGitSync,
    [string]$GitHubRepo = '',
    [string]$GitHubAppId = '',
    [string]$GitHubAppInstallationId = '',
    [string]$GitHubAppPrivateKeySecretName = '',
    [string]$GitHubWebhookSecret = '',

    # Budget alert email (optional)
    [string]$BudgetAlertEmail = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── Helpers ──

function Write-Step { param([string]$Message) Write-Host "`n==> $Message" -ForegroundColor Cyan }
function Write-OK   { param([string]$Message) Write-Host "    $Message" -ForegroundColor Green }
function Write-Warn { param([string]$Message) Write-Host "    $Message" -ForegroundColor Yellow }

# ── Load .env file (if present) ──
# Fills in any unset parameters from deploy/azure/.env

$envFile = Join-Path $PSScriptRoot '.env'
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^\s*([A-Z_]+)\s*=\s*(.+)$' -and $_ -notmatch '^\s*#') {
            $key = $Matches[1]; $val = $Matches[2].Trim()
            switch ($key) {
                'GOOGLE_CLIENT_ID'      { if (-not $GoogleClientId)     { $GoogleClientId = $val } }
                'GOOGLE_CLIENT_SECRET'  { if (-not $GoogleClientSecret) { $GoogleClientSecret = $val } }
                'GITHUB_CLIENT_ID'      { if (-not $GitHubClientId)     { $GitHubClientId = $val } }
                'GITHUB_CLIENT_SECRET'  { if (-not $GitHubClientSecret) { $GitHubClientSecret = $val } }
                'BUDGET_ALERT_EMAIL'    { if (-not $BudgetAlertEmail)   { $BudgetAlertEmail = $val } }
            }
        }
    }
    Write-Host "    Loaded settings from .env" -ForegroundColor DarkGray
}

# ── Pre-flight checks ──

Write-Step 'Checking prerequisites'

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    throw 'Azure CLI (az) is not installed. Install from https://aka.ms/install-azure-cli'
}

if (-not $SkipLogin) {
    $acct = az account show 2>$null | ConvertFrom-Json -ErrorAction SilentlyContinue
    if (-not $acct) {
        Write-Warn 'Not logged in to Azure. Running az login...'
        az login
        $acct = az account show | ConvertFrom-Json
    }
    Write-OK "Logged in as $($acct.user.name) (subscription: $($acct.name))"
}

# ── Create resource group ──

Write-Step "Ensuring resource group '$ResourceGroup' in $Location"
$rgExists = az group exists --name $ResourceGroup 2>$null
if ($rgExists -eq 'false') {
    az group create --name $ResourceGroup --location $Location --output none
    Write-OK "Created resource group '$ResourceGroup'"
} else {
    Write-OK "Resource group '$ResourceGroup' already exists"
}

# ── Deploy Bicep template ──

Write-Step 'Deploying infrastructure (Container Apps + Storage)'

$bicepFile = Join-Path $PSScriptRoot 'main.bicep'
if (-not (Test-Path $bicepFile)) {
    throw "Bicep template not found at $bicepFile"
}

# ── Capture current active revisions for traffic pin (t/2049) ──
# In activeRevisionsMode 'Multiple' with no ingress.traffic block, a full Bicep
# apply promotes the LATEST revision to 100% before any readiness check — the
# t/2047 bypass. Capture each app's current active revision BEFORE the apply and
# pass both as traffic pins so Bicep holds 100% on the known-good revision.
# $ErrorActionPreference='Stop' (above) ensures an az failure aborts rather than
# passing a silent empty pin — empty is only correct for a genuine first deploy.
Write-Step 'Capturing current active revisions for traffic pin'
$moduleRoot = Join-Path $PSScriptRoot '..\..\scripts\AITriad\AITriad.psm1'
Import-Module $moduleRoot -Force

function Get-ActiveRevisionPin {
    param([string]$App)
    $Active = @(Get-ContainerAppRevision -Mode Active -AppName $App -ResourceGroup $ResourceGroup)
    if ($Active.Count -eq 0) { return '' }
    return (@($Active | Sort-Object -Property TrafficWeight -Descending)[0]).Name
}
$ProdPin    = Get-ActiveRevisionPin -App 'taxonomy-editor'
$StagingPin = Get-ActiveRevisionPin -App 'taxonomy-editor-staging'
Write-OK "Prod pin / rollback target: '$ProdPin'"
Write-OK "Staging pin target:         '$StagingPin'"

$deployParams = @("containerImage=$ContainerImage")
if ($GoogleClientId)                { $deployParams += "googleClientId=$GoogleClientId" }
if ($GoogleClientSecret)            { $deployParams += "googleClientSecret=$GoogleClientSecret" }
if ($GitHubClientId)                { $deployParams += "githubClientId=$GitHubClientId" }
if ($GitHubClientSecret)            { $deployParams += "githubClientSecret=$GitHubClientSecret" }
if ($EnableGitSync) { $deployParams += 'gitSyncEnabled=1' }
if ($GitHubRepo)                    { $deployParams += "githubRepo=$GitHubRepo" }
if ($GitHubAppId)                   { $deployParams += "githubAppId=$GitHubAppId" }
if ($GitHubAppInstallationId)       { $deployParams += "githubAppInstallationId=$GitHubAppInstallationId" }
if ($GitHubAppPrivateKeySecretName) { $deployParams += "githubAppPrivateKeySecretName=$GitHubAppPrivateKeySecretName" }
if ($GitHubWebhookSecret)           { $deployParams += "githubWebhookSecret=$GitHubWebhookSecret" }
if ($BudgetAlertEmail)              { $deployParams += "budgetAlertEmail=$BudgetAlertEmail" }
$deployParams += "trafficPinRevisionName=$ProdPin"
$deployParams += "trafficPinRevisionNameStaging=$StagingPin"

$deployResult = az deployment group create `
    --resource-group $ResourceGroup `
    --template-file $bicepFile `
    --parameters @deployParams `
    --output json | ConvertFrom-Json

$appUrl      = $deployResult.properties.outputs.appUrl.value
$appName     = $deployResult.properties.outputs.appName.value
$storageAcct = $deployResult.properties.outputs.storageAccountName.value
$shareName   = $deployResult.properties.outputs.fileShareName.value

Write-OK "Deployed: $appUrl"

# ── Seed data (optional) ──

if ($SeedData) {
    Write-Step 'Seeding taxonomy data from GitHub'

    # Get storage key
    $storageKey = (az storage account keys list `
        --account-name $storageAcct `
        --resource-group $ResourceGroup `
        --output json | ConvertFrom-Json)[0].value

    # Clone data repo to temp, prune unneeded files, then upload to Azure Files
    $tempDir = Join-Path ([IO.Path]::GetTempPath()) "aitriad-data-$(Get-Random)"
    try {
        git clone --depth 1 https://github.com/AI-Rosetta-Stone/ai-triad-data.git $tempDir

        # Remove large files not needed by the web app (~900 MB savings)
        # Raw PDFs/DOCX — only used by poviewer for on-demand PDF analysis
        $rawDirs = Get-ChildItem -Path (Join-Path $tempDir 'sources') -Directory -ErrorAction SilentlyContinue |
            ForEach-Object { Join-Path $_.FullName 'raw' } |
            Where-Object { Test-Path $_ }
        foreach ($dir in $rawDirs) {
            Remove-Item $dir -Recurse -Force
            Write-OK "  Pruned: $($dir | Split-Path -Parent | Split-Path -Leaf)/raw/"
        }

        # Remove unused/research artifacts
        $excludeDirs = @('conflicts-consolidated', 'conflicts-original', 'qbaf-conflicts', 'migrations', '.git')
        foreach ($name in $excludeDirs) {
            $path = Join-Path $tempDir $name
            if (Test-Path $path) {
                Remove-Item $path -Recurse -Force
                Write-OK "  Pruned: $name/"
            }
        }

        # Remove research/calibration artifacts
        Get-ChildItem -Path $tempDir -Filter 'q0-calibration*' -ErrorAction SilentlyContinue |
            Remove-Item -Force
        Get-ChildItem -Path $tempDir -Filter 'token-calibration*' -ErrorAction SilentlyContinue |
            Remove-Item -Force
        Get-ChildItem -Path $tempDir -Filter '_*_migration_manifest.json' -ErrorAction SilentlyContinue |
            Remove-Item -Force

        $sizeMB = [math]::Round((Get-ChildItem $tempDir -Recurse -File | Measure-Object Length -Sum).Sum / 1MB, 1)
        Write-OK "Data pruned to $sizeMB MB (excluded raw PDFs, research artifacts)"

        Write-OK 'Uploading data to Azure Files share...'
        az storage file upload-batch `
            --destination $shareName `
            --source $tempDir `
            --account-name $storageAcct `
            --account-key $storageKey `
            --output none

        # Write seed manifest to share for the freshness gate (t/3091).
        # Records data-repo commit SHA + per-file blob_sha (canonical freshness signal) and
        # size_bytes (upload truncation guard). The gate compares blob_sha against the data
        # repo's current canonical tree — not self-referential. (Design: e/126#4)
        Write-OK 'Writing seed manifest...'
        $dataRepoCommit = (git -C $tempDir rev-parse HEAD 2>$null).Trim()
        $manifestFiles  = [ordered]@{}
        $assertedPaths  = @('taxonomy/Origin/embeddings.json')
        foreach ($rel in $assertedPaths) {
            $localPath = Join-Path $tempDir ($rel -replace '/', [IO.Path]::DirectorySeparatorChar)
            if (Test-Path $localPath) {
                # git ls-tree output: "<mode> blob <sha>\t<path>"
                $lsLine   = git -C $tempDir ls-tree HEAD -- $rel 2>$null
                $blobSha  = if ($lsLine) { ($lsLine -split '\s+')[2] } else { '' }
                $manifestFiles[$rel] = [ordered]@{
                    size_bytes = (Get-Item $localPath).Length
                    blob_sha   = $blobSha
                }
            }
        }
        $manifestJson  = ([ordered]@{
            seeded_at        = [DateTimeOffset]::UtcNow.ToString('o')
            data_repo_commit = $dataRepoCommit
            files            = $manifestFiles
        }) | ConvertTo-Json -Depth 3
        $tmpManifest   = [IO.Path]::GetTempFileName()
        try {
            [IO.File]::WriteAllText($tmpManifest, $manifestJson, [Text.Encoding]::UTF8)
            az storage file upload `
                --share-name  $shareName `
                --source      $tmpManifest `
                --path        'seed-manifest.json' `
                --account-name $storageAcct `
                --account-key  $storageKey `
                --output none
            $embSize = if ($manifestFiles['taxonomy/Origin/embeddings.json']) {
                [math]::Round($manifestFiles['taxonomy/Origin/embeddings.json'].size_bytes / 1MB, 1)
            } else { '?' }
            Write-OK "Seed manifest written (embeddings.json: $embSize MB)"
        } finally {
            Remove-Item $tmpManifest -Force -ErrorAction SilentlyContinue
        }

        Write-OK 'Data seeded successfully'
    }
    finally {
        if (Test-Path $tempDir) { Remove-Item $tempDir -Recurse -Force }
    }
}

# ── Summary ──

Write-Host ''
Write-Host '══════════════════════════════════════════════════════════════' -ForegroundColor Green
Write-Host '  Taxonomy Editor deployed successfully!' -ForegroundColor Green
Write-Host '══════════════════════════════════════════════════════════════' -ForegroundColor Green
Write-Host ''
Write-Host "  URL:     $appUrl" -ForegroundColor White
Write-Host "  RG:      $ResourceGroup" -ForegroundColor White
Write-Host "  Storage: $storageAcct/$shareName" -ForegroundColor White
Write-Host ''
Write-Host '  Next steps:' -ForegroundColor Cyan
Write-Host '  1. Open the URL above in your browser' -ForegroundColor White
Write-Host '  2. Enter your Gemini API key when prompted (BYOK)' -ForegroundColor White
Write-Host '  3. Seed data: ./deploy.ps1 ... -SeedData' -ForegroundColor White
Write-Host '  4. Add auth: az containerapp auth update ...' -ForegroundColor White
Write-Host ''
Write-Host '  API keys are entered in-app and encrypted on the data volume.' -ForegroundColor Yellow
Write-Host '  No keys are stored in Azure configuration or deployment.' -ForegroundColor Yellow
Write-Host ''
