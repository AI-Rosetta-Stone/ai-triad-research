# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# The PowerShell write funnel for POV taxonomy files (t/4356 PR C, C5; TL t/4356#1, #2, #4, #7 C-a).
# A POV file is written in its canonical TS format, JSON.stringify(o, null, 2) + "\n", by piping through
# Node (scripts/json-canonical.mjs), which also refuses any file whose registry format isn't that one.
# Read the file with Read-PovTaxonomyFile so ISO timestamps stay strings: a [datetime] coerced on read
# would be re-emitted with a different value (t/4366).

function Read-PovTaxonomyFile {
    <#
    .SYNOPSIS
        Reads a POV taxonomy file for a read-modify-write through Write-PovTaxonomyFile.
    .DESCRIPTION
        ConvertFrom-JsonPreserveShape: timestamps stay strings and one-element arrays stay arrays, so an
        untouched field comes back byte-identical. Every node is returned, superseded ones included.
    #>
    [CmdletBinding()]
    [OutputType([object])]
    param([Parameter(Mandatory)][string]$Path)
    ConvertFrom-JsonPreserveShape -Json ([System.IO.File]::ReadAllText($Path, [System.Text.UTF8Encoding]::new($false)))
}

function Write-PovTaxonomyFile {
    <#
    .SYNOPSIS
        Writes a POV taxonomy file in its canonical format through Node. Never falls back.
    .DESCRIPTION
        Serializes -Data to compact JSON (only as a carrier: Node re-parses it), then runs
        scripts/json-canonical.mjs, which re-emits JSON.stringify(o, null, 2) + "\n" and writes -Path
        atomically. If node is missing, the script is missing, or Node exits non-zero, this throws an
        ActionableError: a ConvertTo-Json fallback would silently reformat the file (TL t/4356#7 C-a).
        Carries Write-Utf8NoBom's guards, so moving a writer onto the funnel drops none of them: the
        t/2902 dirty-tree guard (Assert-DataWriteAllowed, or Assert-CleanDataTree with -RequireCleanTree)
        and the 10 MB corrupted-content block, which here throws instead of skipping. Callers keep their
        own ShouldProcess checks.
    .PARAMETER Path
        The target POV file. Its registry entry (lib/data-formats/file-writers.json) must be pretty2-lf-nl.
    .PARAMETER Data
        The whole document, as read by Read-PovTaxonomyFile and modified.
    .PARAMETER RequireCleanTree
        Hard-block unless the target is clean (Write-Utf8NoBom -RequireCleanTree semantics).
    .PARAMETER AllowDirty
        Opt a legitimate sequential rewriter out of the dirty-tree guard (Write-Utf8NoBom semantics).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][object]$Data,
        [switch]$RequireCleanTree,
        [switch]$AllowDirty
    )
    $Node = Get-Command -Name node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $Node) {
        New-ActionableError -Goal "write $Path in its canonical format" `
            -Problem 'node is not on PATH; the PowerShell taxonomy write funnel needs Node to serialize (no ConvertTo-Json fallback, by design)' `
            -Location 'Write-PovTaxonomyFile' `
            -NextSteps @('Install Node 22 (the version CI uses) and make sure `node` is on PATH', 'Re-run the command; nothing was written') -Throw
    }
    $Script = Join-Path $script:RepoRoot 'scripts' 'json-canonical.mjs'
    if (-not (Test-Path -LiteralPath $Script)) {
        New-ActionableError -Goal "write $Path in its canonical format" `
            -Problem "the canonical serializer $Script is missing" `
            -Location 'Write-PovTaxonomyFile' `
            -NextSteps @('Run from a full ai-triad-research checkout (scripts/json-canonical.mjs ships with the repo)', 'Nothing was written') -Throw
    }

    $Json = ConvertTo-Json -InputObject $Data -Depth 100 -Compress
    if ($Json.Length -gt 10MB) {
        New-ActionableError -Goal "write $Path in its canonical format" `
            -Problem "the serialized document is $([math]::Round($Json.Length / 1MB, 1)) MB, which signals corrupted content (Write-Utf8NoBom's 10 MB block)" `
            -Location 'Write-PovTaxonomyFile' `
            -NextSteps @('Check the document for runaway encoding or duplicated content', 'Nothing was written') -Throw
    }
    # t/2902 dirty-tree guard, exactly as Write-Utf8NoBom applies it.
    if ($RequireCleanTree) {
        if (-not $AllowDirty -and (Get-Command Assert-CleanDataTree -ErrorAction SilentlyContinue)) { Assert-CleanDataTree -Path $Path }
    }
    elseif (Get-Command Assert-DataWriteAllowed -ErrorAction SilentlyContinue) {
        Assert-DataWriteAllowed -Path $Path -AllowDirty:$AllowDirty
    }

    $Carrier = [System.IO.Path]::GetTempFileName()
    try {
        [System.IO.File]::WriteAllText($Carrier, $Json, [System.Text.UTF8Encoding]::new($false))
        $Output = & $Node.Source $Script --in $Carrier --out $Path 2>&1
        $Exit = $LASTEXITCODE
        if ($Exit -ne 0) {
            New-ActionableError -Goal "write $Path in its canonical format" `
                -Problem "json-canonical.mjs exited $Exit`: $(@($Output) -join ' ')" `
                -Location 'Write-PovTaxonomyFile' `
                -NextSteps @('Exit 3 or 4: the file has no pretty2-lf-nl entry in lib/data-formats/file-writers.json; use its own writer or add the entry', 'Exit 5: the data did not serialize to valid JSON', 'The target file was not modified') -Throw
        }
    }
    finally {
        Remove-Item -LiteralPath $Carrier -Force -ErrorAction SilentlyContinue
    }
}
