# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Strips inline `data:` URIs (embedded base64 images) from snapshot markdown (t/4385).
.DESCRIPTION
    Some snapshot.md files open with inline images such as `![](data:image/svg+xml;base64,...)`.
    A reader that truncates the text to a character window before sending it to a model can then
    send mostly base64: in one snapshot 19,214 of the first 20,000 characters were base64, and the
    model invented every claim it returned. Strip the URIs BEFORE truncating.

    Removes, in order:
      - markdown images whose target is a data URI: `![alt](data:...)`;
      - any remaining bare `data:<type>;base64,<payload>` run (an HTML `<img src="data:...">`, a
        link target, or a stray URI).
    Text outside the URIs is unchanged.
.OUTPUTS
    [pscustomobject] with Text (the stripped text), StrippedChars (characters removed) and
    UriCount (URIs removed).
#>
function Remove-MarkdownDataUri {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [AllowEmptyString()]
        [string]$Text
    )
    Set-StrictMode -Version Latest

    # The base64 payload class has no whitespace, so a bare URI stops at the first space and never
    # swallows the prose after it.
    $imagePattern = '!\[[^\]]*\]\(\s*data:[^)]*\)'
    $barePattern  = 'data:[A-Za-z0-9.+/-]+(?:;[A-Za-z0-9=.+-]+)*;base64,[A-Za-z0-9+/=]+'
    $count = [regex]::Matches($Text, $imagePattern).Count
    $out = [regex]::Replace($Text, $imagePattern, '')
    $count += [regex]::Matches($out, $barePattern).Count
    $out = [regex]::Replace($out, $barePattern, '')

    [pscustomobject]@{
        Text          = $out
        StrippedChars = $Text.Length - $out.Length
        UriCount      = $count
    }
}

function Read-SnapshotForModel {
    <#
    .SYNOPSIS
        Reads a snapshot.md for use as model input: console-code-page mojibake repaired (t/4394) and
        inline data: URIs stripped (t/4386).
    .DESCRIPTION
        Used where a snapshot feeds a model, a RAG query or a token estimate. WARNs (naming the
        caller) when it repairs mojibake (Repair-SnapshotMojibake) or strips more than 1,000
        characters. The file on disk is unchanged: content_sha256 is computed over the snapshot
        exactly as written (source-identity spec 1.1), so both happen on read, never on write.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)][string]$Path,
        [string]$CallerName = 'Read-SnapshotForModel'
    )
    Set-StrictMode -Version Latest
    # Explicit UTF-8: Windows PowerShell 5.1's default is the ANSI code page, the same class of misread.
    $raw = [string](Get-Content -LiteralPath $Path -Raw -Encoding utf8)
    $repair = Repair-SnapshotMojibake -Text $raw
    if ($repair.Variant -ne 'none') {
        Write-Warning "${CallerName}: repaired $($repair.Variant) mojibake in '$Path' before model input; the file on disk is unchanged (t/4394)."
        $raw = $repair.Text
    }
    $stripped = Remove-MarkdownDataUri -Text $raw
    if ($stripped.StrippedChars -gt 1000) {
        Write-Warning "${CallerName}: stripped $($stripped.StrippedChars) chars of inline data: URIs ($($stripped.UriCount)) from '$Path' before model input (t/4385)."
    }
    $stripped.Text
}
