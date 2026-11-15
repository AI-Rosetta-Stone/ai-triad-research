# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Get-GhcrVersionTag {
    <#
    .SYNOPSIS
        Pure. Tags of one GitHub Packages container version.
    .DESCRIPTION
        Returns metadata.container.tags, or nothing when the version object
        lacks that shape. Callers wrap the call in @() before using .Count.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [AllowNull()]
        [object]$Version
    )

    if ($null -ne $Version -and
        $Version.PSObject.Properties['metadata'] -and
        $Version.metadata.PSObject.Properties['container'] -and
        $Version.metadata.container.PSObject.Properties['tags']) {
        return @($Version.metadata.container.tags)
    }
}
