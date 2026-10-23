# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    t/4457: freeze ent-361's re-embedded vector for the post-t/4449 record (SO e/357#2 C2; TL p/360#692).
.DESCRIPTION
    t/4449 renames ent-361 and replaces its aliases and description, so its stored vector (which embeds name + aliases +
    description) goes stale. This freeze computes the replacement ONCE and records it, so the Apply writes the frozen
    numbers and never re-embeds:
      - reads entity_embeddings.json at the data repo's origin/main (= the clean working tree);
      - takes ent-361's post-rename name, aliases and description from t/4449's frozen list (the record as it will be
        once that Apply lands), and builds the source text and _src_hash with Get-EntityVectorSource;
      - embeds it with Get-TextEmbedding (local all-MiniLM-L6-v2; no billed call), the same sub-ids Import-Entity uses;
      - renders the new vectors["ent-361"] block and _src_hashes line with ConvertTo-Json, after proving the renderer
        reproduces the file's CURRENT ent-361 block byte for byte (the file is PowerShell-written);
      - writes frozen-t4457-ent361.json: the old and new blocks, the src text and hash, and both files' expected
        pre-write sha256 (entities.json = t/4449's post-write, so this applies only after t/4449).
    Invoke-T4457Ent361ReEmbedWrite.mjs reads only the frozen list.
#>
[CmdletBinding()]
param(
    [string]$DataDir = 'C:\Users\jsnov\repos\ai-triad-data',
    [string]$T4449Frozen = (Join-Path $PSScriptRoot '..' 't4449' 'frozen-t4449-ent361.json'),
    [string]$T4449PostWriteSha256 = '5155f678d5bb2dd5a10e5ca29e60e618391d046007659ffc66cfcca96dc21d1c',
    [string]$FrozenPath = (Join-Path $PSScriptRoot 'frozen-t4457-ent361.json')
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..' '..' '..')).Path
Import-Module (Join-Path $repo 'scripts' 'AITriad' 'AITriad.psd1') -Force
. (Join-Path $repo 'scripts' 'AITriad' 'Private' 'New-ActionableError.ps1')
$Id = 'ent-361'
$Emb = 'taxonomy/Origin/entity_embeddings.json'

function Get-Sha256Hex([string]$Text) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { -join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)) | ForEach-Object { $_.ToString('x2') }) } finally { $sha.Dispose() }
}
function Stop-Freeze([string]$Problem, [string]$Next) {
    throw (New-ActionableError -PassThru -Goal 'Freeze the t/4457 ent-361 re-embed' -Problem $Problem -Location 'Invoke-T4457Ent361ReEmbedFreeze' -NextSteps @($Next))
}
# One vectors[] member rendered exactly as the PowerShell writer (ConvertTo-Json -Depth 12, 2-space indent) lays it out.
function Format-VectorBlock([string]$MemberId, $Record) {
    $l = ((($Record | ConvertTo-Json -Depth 12) -replace "`r`n", "`n") -split "`n")
    , ([string[]]@("    `"$MemberId`": {") + [string[]]@($l[1..($l.Count - 2)] | ForEach-Object { '    ' + $_ }) + [string[]]@('    },'))
}

$head = (git -C $DataDir rev-parse HEAD).Trim(); $main = (git -C $DataDir rev-parse origin/main).Trim()
if ($head -cne $main) { Stop-Freeze "data HEAD $head is not origin/main $main" 'Fast-forward the data repo to origin/main' }
if (@(git -C $DataDir status --porcelain -- $Emb).Count) { Stop-Freeze "$Emb has uncommitted changes" 'Commit or set aside that WIP first' }

$embText = [IO.File]::ReadAllText((Join-Path $DataDir $Emb)) -replace "`r`n", "`n"
$lines = $embText -split "`n"
$store = $embText | ConvertFrom-Json
if (-not $store.vectors.PSObject.Properties[$Id]) { Stop-Freeze "$Emb has no vectors[$Id]" 'Check the record id' }
if ($store.PSObject.Properties['_schema_version'] -and [string]$store._schema_version -ne '2.0.0') { Stop-Freeze "unexpected embeddings schema $($store._schema_version)" 'This freeze writes a v2 record' }

# The old block, located and proven reproducible by the renderer.
$s = [Array]::IndexOf($lines, "    `"$Id`": {"); if ($s -lt 0) { Stop-Freeze "vectors[$Id] block not found" 'Inspect the file layout' }
$e = $s + 1; while ($lines[$e] -cne '    },') { if ($lines[$e] -ceq '    }') { Stop-Freeze "vectors[$Id] is the last member" 'This writer handles a mid-object member only' }; $e++ }
$oldBlock = [string[]]$lines[$s..$e]
$rendered = Format-VectorBlock $Id $store.vectors.$Id
if (($rendered -join "`n") -cne ($oldBlock -join "`n")) { Stop-Freeze 'the renderer does not reproduce the current block byte for byte' 'Do not write: the new block would not match the writer''s format' }
$hashLine = "    `"$Id`": `"$([string]$store._src_hashes.$Id)`","
$h = [Array]::IndexOf($lines, $hashLine); if ($h -lt 0) { Stop-Freeze "_src_hashes[$Id] line not found (or it is the last member)" 'Inspect the file layout' }

# The post-rename record, from t/4449's frozen list.
$t4449 = Get-Content -Raw -LiteralPath $T4449Frozen | ConvertFrom-Json
if ([string]$t4449.id -cne $Id) { Stop-Freeze "t/4449 frozen list is for $($t4449.id)" 'Point -T4449Frozen at the ent-361 list' }
$t4449Sha = Get-Sha256Hex ((Get-Content -Raw -LiteralPath $T4449Frozen) -replace "`r`n", "`n")
$src = & (Get-Module AITriad) { param($n) Get-EntityVectorSource -Name ([string]$n.name) -Aliases @($n.aliases) -Description ([string]$n.description) } $t4449.new
$ids = @("$Id#name"); $texts = @($src.NameText)
if ($src.DescText) { $ids += "$Id#desc"; $texts += $src.DescText }
$vec = & (Get-Module AITriad) { param($t, $i) Get-TextEmbedding -Texts $t -Ids $i } $texts $ids
if (-not $vec -or -not $vec.ContainsKey("$Id#name")) { Stop-Freeze 'Get-TextEmbedding returned no name vector' 'Check Python and sentence-transformers are available' }
$descVec = if ($src.DescText -and $vec.ContainsKey("$Id#desc")) { $vec["$Id#desc"] } else { $null }
$newRec = & (Get-Module AITriad) { param($nv, $dv) New-EntityVectorRecord -NameVector $nv -DescriptionVector $dv } $vec["$Id#name"] $descVec
$newBlock = Format-VectorBlock $Id $newRec
foreach ($k in @($newRec.PSObject.Properties.Name)) { if (@($newRec.$k).Count -ne 384) { Stop-Freeze "$k has $(@($newRec.$k).Count) dims, not 384" 'Check the embedding model' } }

$frozen = [ordered]@{
    _doc        = 't/4457 frozen list: ent-361 re-embedded for its post-t/4449 name, aliases and description (Invoke-T4457Ent361ReEmbedFreeze.ps1). The write reads only this file and applies only after t/4449.'
    inputs      = [ordered]@{
        data_commit                 = $head
        embeddings_pre_sha256       = Get-Sha256Hex $embText
        entities_required_sha256    = $T4449PostWriteSha256
        t4449_frozen_sha256         = $t4449Sha
        model                       = $(if ($store.PSObject.Properties['model']) { [string]$store.model } else { $null })
    }
    id          = $Id
    source      = [ordered]@{ name_text = $src.NameText; desc_text = $src.DescText; src_hash = $src.SrcHash }
    old         = [ordered]@{ block_start = $s; block = $oldBlock; hash_line_index = $h; hash_line = $hashLine }
    new         = [ordered]@{ block = $newBlock; hash_line = "    `"$Id`": `"$($src.SrcHash)`"," ; keys = @($newRec.PSObject.Properties.Name) }
}
[IO.File]::WriteAllText($FrozenPath, ((($frozen | ConvertTo-Json -Depth 8) -replace "`r`n", "`n") + "`n"), [Text.UTF8Encoding]::new($false))
"frozen list: $FrozenPath sha256=$(Get-Sha256Hex ([IO.File]::ReadAllText($FrozenPath) -replace "`r`n", "`n"))"
"old block $($oldBlock.Count) lines (renderer reproduces it); new block $($newBlock.Count) lines, keys $($newRec.PSObject.Properties.Name -join ','); src_hash $($src.SrcHash)"
