# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# Checkout-independent file hashes for data-mutation freezes (t/247). Dot-source it.
# A freeze that hashes working-tree bytes records CRLF on a Windows checkout with core.autocrlf=true
# and LF elsewhere, so the same committed file verifies on one machine and false-mismatches on
# another (t/217: 19 of 29 blobs). Hash the canonical form instead: CRLF turned into LF, which equals
# what git stores for these text files. Record $FreezeHashBasis as the frozen file's `hash_basis`
# and verify with the same basis. freeze_hash.py is the Python twin; both assert the same vectors.

$script:FreezeHashBasis = 'sha256-lf'

function ConvertTo-FreezeCanonicalBytes {
    # CRLF -> LF. A lone CR is content and is kept; nothing else changes (a BOM stays).
    param([Parameter(Mandatory)][AllowEmptyCollection()][byte[]]$Bytes)
    $out = [System.IO.MemoryStream]::new($Bytes.Length)
    for ($i = 0; $i -lt $Bytes.Length; $i++) {
        if ($Bytes[$i] -eq 13 -and $i + 1 -lt $Bytes.Length -and $Bytes[$i + 1] -eq 10) { continue }
        $out.WriteByte($Bytes[$i])
    }
    , $out.ToArray()
}

function Get-FreezeSha256 {
    # sha256 hex of the canonical bytes of -Bytes or -Path.
    [CmdletBinding(DefaultParameterSetName = 'Path')]
    param(
        [Parameter(Mandatory, ParameterSetName = 'Path')][string]$Path,
        [Parameter(Mandatory, ParameterSetName = 'Bytes')][AllowEmptyCollection()][byte[]]$Bytes
    )
    if ($PSCmdlet.ParameterSetName -eq 'Path') { $Bytes = [System.IO.File]::ReadAllBytes($Path) }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { -join ($sha.ComputeHash((ConvertTo-FreezeCanonicalBytes -Bytes $Bytes)) | ForEach-Object { $_.ToString('x2') }) }
    finally { $sha.Dispose() }
}

function Test-FreezeSha256 {
    # True when the hash matches. Refuses an unknown basis instead of guessing (t/247).
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Expected, [Parameter(Mandatory)][string]$Basis)
    if ($Basis -cne $script:FreezeHashBasis) {
        throw "unsupported hash_basis '$Basis'; Test-FreezeSha256 verifies '$($script:FreezeHashBasis)' only (t/247)"
    }
    (Get-FreezeSha256 -Path $Path) -ceq $Expected
}
