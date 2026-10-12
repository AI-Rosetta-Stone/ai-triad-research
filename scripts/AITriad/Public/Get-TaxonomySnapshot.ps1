# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Get-TaxonomySnapshot {
    <#
    .SYNOPSIS
        Fetches the taxonomy + conflict file set from the ai-triad-data repo, stamped with the source commit SHA.
    .DESCRIPTION
        Consolidates the multi-file fetch pattern hand-rolled in
        `.github/workflows/container.yml` (t/1493). Downloads 11 files
        (9 taxonomy + 2 conflict) from raw.githubusercontent.com, queries
        the source repo for its latest commit SHA, writes a
        snapshot-meta.json manifest, and validates that the six required
        files are present and non-empty.

        Used by the container build to bake a fallback taxonomy snapshot
        into the image; safe for any other consumer that needs a
        point-in-time copy of the data repo.
    .PARAMETER OutputPath
        Directory to write the snapshot into. Layout mirrors the source
        repo — `<OutputPath>/taxonomy/Origin/*.json` and
        `<OutputPath>/conflicts/*.json` — plus `snapshot-meta.json` at
        the root.
    .PARAMETER Repo
        Source repo in `owner/repo` form. Default: 'AI-Rosetta-Stone/ai-triad-data'.
    .PARAMETER Branch
        Source branch. Default: 'main'.
    .PARAMETER TimeoutSec
        Per-file HTTP timeout in seconds. Default: 30.
    .EXAMPLE
        Get-TaxonomySnapshot -OutputPath ./taxonomy-snapshot
    .EXAMPLE
        Get-TaxonomySnapshot -OutputPath ./snap -Branch feature-x
    .LINK
        Show-AITriadHelp
    .LINK
        Get-TaxEditorBlob
    .LINK
        Get-TaxEditorDataCommit
    .LINK
        Restore-TaxEditorBlob
    .LINK
        Restore-TaxEditorKnownGood
    .LINK
        Set-TaxEditorKnownGood
    .LINK
        Sync-TaxEditorData
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [Alias('Path')]
        [string]$OutputPath,

        [Parameter()]
        [string]$Repo = 'AI-Rosetta-Stone/ai-triad-data',

        [Parameter()]
        [string]$Branch = 'main',

        [Parameter()]
        [ValidateRange(1, 300)]
        [int]$TimeoutSec = 30
    )

    Set-StrictMode -Version Latest

    # 9 taxonomy files under taxonomy/Origin/ + 2 conflict files under conflicts/ = 11 total.
    # Required-set matches container.yml: the 5 POV files + edges + policy registry.
    $TaxonomyFiles = @(
        'accelerationist.json'
        'safetyist.json'
        'skeptic.json'
        'situations.json'
        'edges.json'
        'policy_actions.json'
        'embeddings.json'
        'lineage_categories.json'
        'aggregated-cruxes.json'
    )
    $ConflictFiles = @(
        '_conflict-index.json'
        '_conflict-clusters.json'
    )
    $RequiredTaxonomy = @(
        'accelerationist.json'
        'safetyist.json'
        'skeptic.json'
        'situations.json'
        'edges.json'
        'policy_actions.json'
    )

    $SnapDir      = Join-Path $OutputPath 'taxonomy' | Join-Path -ChildPath 'Origin'
    $ConflictDir  = Join-Path $OutputPath 'conflicts'
    $null = New-Item -ItemType Directory -Path $SnapDir     -Force -ErrorAction Stop
    $null = New-Item -ItemType Directory -Path $ConflictDir -Force -ErrorAction Stop

    $RawBase = "https://raw.githubusercontent.com/$Repo/$Branch"

    $Files = [System.Collections.Generic.List[object]]::new()

    foreach ($f in $TaxonomyFiles) {
        $Url  = "$RawBase/taxonomy/Origin/$f"
        $Dest = Join-Path $SnapDir $f
        $Files.Add((Get-SnapshotFile -Url $Url -Destination $Dest -Category 'taxonomy' -TimeoutSec $TimeoutSec))
    }
    foreach ($f in $ConflictFiles) {
        $Url  = "$RawBase/conflicts/$f"
        $Dest = Join-Path $ConflictDir $f
        $Files.Add((Get-SnapshotFile -Url $Url -Destination $Dest -Category 'conflict' -TimeoutSec $TimeoutSec))
    }

    # ── Resolve source-repo commit SHA ────────────────────────────────────
    $Commit = 'unknown'
    try {
        $CommitInfo = Invoke-GitHubApi -Endpoint "/repos/$Repo/commits/$Branch" `
            -Method 'GET' -CallerName 'Get-TaxonomySnapshot'
        if ($CommitInfo -and $CommitInfo.PSObject.Properties['sha']) {
            $Commit = [string]$CommitInfo.sha
        }
    } catch {
        Write-Warning "Could not resolve commit SHA for $Repo@$Branch — snapshot-meta.commit will be 'unknown' ($($_.Exception.Message))"
    }

    # ── Validate required set ────────────────────────────────────────────
    $Missing = [System.Collections.Generic.List[string]]::new()
    foreach ($f in $RequiredTaxonomy) {
        $Dest = Join-Path $SnapDir $f
        if (-not (Test-Path $Dest) -or (Get-Item $Dest).Length -eq 0) {
            $Missing.Add($f)
        }
    }
    $Valid = ($Missing.Count -eq 0)

    # ── Stamp manifest ───────────────────────────────────────────────────
    $Generated = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    $Meta = [ordered]@{
        generated = $Generated
        commit    = $Commit
        repo      = $Repo
        branch    = $Branch
        valid     = $Valid
    }
    if (-not $Valid) { $Meta['missing'] = @($Missing) }
    $MetaPath = Join-Path $OutputPath 'snapshot-meta.json'
    $Meta | ConvertTo-Json -Depth 4 | Set-Content -Path $MetaPath -Encoding utf8NoBOM

    $Result = [TaxonomySnapshotResult]::new()
    $Result.OutputPath        = (Resolve-Path $OutputPath).Path
    $Result.Repo              = $Repo
    $Result.Branch            = $Branch
    $Result.Commit            = $Commit
    $Result.Generated         = $Generated
    $Result.Files             = @($Files)
    $Result.Valid             = $Valid
    $Result.MissingRequired   = @($Missing)
    $Result.SnapshotMetaPath  = $MetaPath
    $Result
}

function Get-SnapshotFile {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Url,

        [Parameter(Mandatory)]
        [string]$Destination,

        [Parameter(Mandatory)]
        [string]$Category,

        [Parameter(Mandatory)]
        [int]$TimeoutSec
    )

    Set-StrictMode -Version Latest

    $Entry = [ordered]@{
        Url       = $Url
        Path      = $Destination
        Category  = $Category
        Ok        = $false
        SizeBytes = 0
        Error     = $null
    }

    try {
        $Response = Invoke-WebRequest -Uri $Url -OutFile $Destination `
            -TimeoutSec $TimeoutSec -UseBasicParsing -ErrorAction Stop
        $null = $Response
        if (Test-Path $Destination) {
            $Entry.SizeBytes = (Get-Item $Destination).Length
            $Entry.Ok        = ($Entry.SizeBytes -gt 0)
        }
    } catch {
        $Entry.Error = $_.Exception.Message
        Write-Warning "Failed to fetch $Url — $($_.Exception.Message)"
    }
    [PSCustomObject]$Entry
}
