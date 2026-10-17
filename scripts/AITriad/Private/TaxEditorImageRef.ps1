# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function ConvertFrom-TaxEditorImageRef {
    <#
    .SYNOPSIS
        Splits a container image reference into the manifest reference to fetch.
    .DESCRIPTION
        Returns [pscustomobject]@{ Reference; Tag; Digest } or $null when the ref has neither.
          ghcr.io/o/r@sha256:<hex>      -> Reference = sha256:<hex>, Tag = $null, Digest = sha256:<hex>
          ghcr.io/o/r:1.2@sha256:<hex>  -> the digest wins (it pins the exact image); Tag = '1.2'
          ghcr.io/o/r:1.2               -> Reference = '1.2', Tag = '1.2', Digest = $null
        A colon in the registry host (host:5000/repo) is not a tag: only the last path segment
        is searched for one. Splitting the whole ref on ':' used to turn a digest ref into the
        bare hex, which isn't a tag (p/682#28).
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param([AllowEmptyString()][string]$ImageRef)

    if ([string]::IsNullOrWhiteSpace($ImageRef)) { return $null }
    $Name = $ImageRef
    $Digest = $null
    if ($ImageRef -match '^(?<name>.+)@(?<digest>sha256:[0-9a-fA-F]{64})$') {
        $Name = $Matches['name']
        $Digest = $Matches['digest'].ToLowerInvariant()
    }
    $LastSegment = ($Name -split '/')[-1]
    $Tag = $null
    if ($LastSegment -match ':(?<tag>[^:]+)$') { $Tag = $Matches['tag'] }

    if ($Digest) { return [pscustomobject]@{ Reference = $Digest; Tag = $Tag; Digest = $Digest } }
    if ($Tag) { return [pscustomobject]@{ Reference = $Tag; Tag = $Tag; Digest = $null } }
    $null
}

function Get-OciManifestDigest {
    <#
    .SYNOPSIS
        The manifest digest (sha256:<hex>) of an OCI manifest GET response: the registry's
        Docker-Content-Digest header, or else sha256 over the exact response bytes.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)]$Response)

    $Header = $null
    if ($Response.PSObject.Properties['Headers'] -and $Response.Headers) {
        $Header = $Response.Headers['Docker-Content-Digest']
        if ($Header -is [array]) { $Header = $Header[0] }
    }
    if ($Header) { return ([string]$Header).ToLowerInvariant() }

    $Bytes = $null
    if ($Response.PSObject.Properties['RawContentStream'] -and $Response.RawContentStream) {
        $Bytes = $Response.RawContentStream.ToArray()
    }
    elseif ($Response.PSObject.Properties['Content'] -and $null -ne $Response.Content) {
        $Bytes = if ($Response.Content -is [byte[]]) { $Response.Content } else { [System.Text.Encoding]::UTF8.GetBytes([string]$Response.Content) }
    }
    if ($null -eq $Bytes) { return $null }
    $Sha = [System.Security.Cryptography.SHA256]::HashData([byte[]]$Bytes)
    'sha256:' + ([System.Convert]::ToHexString($Sha).ToLowerInvariant())
}
