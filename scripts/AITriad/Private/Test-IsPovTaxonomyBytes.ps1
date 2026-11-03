# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Test-IsPovTaxonomyBytes {
    <#
    .SYNOPSIS
        Cheap pre-check on a JSON file's raw bytes: returns $false only when the
        file certainly fails Test-IsPovTaxonomyData, so it can skip ConvertFrom-Json.
    .DESCRIPTION
        The taxonomy loaders (AITriad.psm1 import, Assert-TaxonomyCacheFresh)
        glob every *.json in the taxonomy dir and shape-gate each one with
        Test-IsPovTaxonomyData. That gate runs AFTER ConvertFrom-Json, so non-POV
        files are fully parsed only to be discarded — about 1.5 s per import
        (source_index.json alone, 8.4 MB, costs ~0.8 s). System.Text.Json reads
        the same shape in ~20 ms.

        Takes bytes, not a string: JsonDocument.Parse called from PowerShell
        with a [string] binds to a path that took ~600 ms on source_index.json,
        against ~15 ms for ReadOnlyMemory[byte] (measured 2026-10-28).

        This is a pre-filter, never the authority. It is deliberately
        conservative: it returns $false only for the two shapes the full gate
        is certain to reject, matching its case-insensitive property lookup:
          - a root object with no 'nodes' property;
          - a 'nodes' array whose first entry is an object without an 'id'.
        Every other shape returns $true, and the caller parses the file with
        ConvertFrom-Json and lets Test-IsPovTaxonomyData decide.

        If System.Text.Json cannot read the bytes (it is stricter than
        ConvertFrom-Json, and reads UTF-8 only), this returns $true with a WARN,
        so the file takes the full-parse path and keeps its previous behavior.
    .PARAMETER Bytes
        The raw file contents.
    .PARAMETER FileName
        Used only in the WARN message.
    .OUTPUTS
        [bool]
    #>
    [OutputType([bool])]
    param(
        [AllowNull()][AllowEmptyCollection()]
        [byte[]]$Bytes,

        [string]$FileName = '<unknown>'
    )

    if ($null -eq $Bytes -or $Bytes.Length -eq 0) { return $true }

    # JsonDocument rejects a leading UTF-8 BOM; Get-Content strips it, so do the same.
    $Offset = 0
    if ($Bytes.Length -ge 3 -and $Bytes[0] -eq 0xEF -and $Bytes[1] -eq 0xBB -and $Bytes[2] -eq 0xBF) { $Offset = 3 }

    $Options = [System.Text.Json.JsonDocumentOptions]::new()
    $Options.AllowTrailingCommas = $true
    $Options.CommentHandling = [System.Text.Json.JsonCommentHandling]::Skip
    $Options.MaxDepth = 1024   # ConvertFrom-Json's default -Depth

    $Doc = $null
    try {
        $Memory = [System.ReadOnlyMemory[byte]]::new($Bytes, $Offset, $Bytes.Length - $Offset)
        $Doc = [System.Text.Json.JsonDocument]::Parse($Memory, $Options)
    }
    catch {
        Write-Warning "Taxonomy: fast shape check could not read $FileName ($($_.Exception.Message)) — falling back to a full ConvertFrom-Json parse."
        return $true
    }

    try {
        $Root = $Doc.RootElement
        if ($Root.ValueKind -ne [System.Text.Json.JsonValueKind]::Object) { return $true }

        # -eq is case-insensitive, matching PSObject.Properties['nodes'] in the full gate.
        $NodesCount = 0
        $Nodes = $null
        foreach ($Prop in $Root.EnumerateObject()) {
            if ($Prop.Name -eq 'nodes') { $NodesCount++; $Nodes = $Prop.Value }
        }
        if ($NodesCount -eq 0) { return $false }
        if ($NodesCount -gt 1) { return $true }   # duplicate keys: let the full parse decide

        if ($Nodes.ValueKind -ne [System.Text.Json.JsonValueKind]::Array -or $Nodes.GetArrayLength() -eq 0) { return $true }

        $First = $Nodes[0]
        if ($First.ValueKind -ne [System.Text.Json.JsonValueKind]::Object) { return $true }
        foreach ($Prop in $First.EnumerateObject()) {
            if ($Prop.Name -eq 'id') { return $true }
        }
        return $false
    }
    finally {
        $Doc.Dispose()
    }
}
