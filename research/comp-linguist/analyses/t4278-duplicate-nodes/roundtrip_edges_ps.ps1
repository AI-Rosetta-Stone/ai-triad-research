# t/4278 / t/4353: round-trip the real edges.json through the PowerShell module's PRODUCTION read/write pair,
# Read-EdgesFile -> Write-EdgesFile, and compare with the committed bytes.
#
# Result at ai-triad-data 7dc19c88, on PS 7.4.21: BYTE-IDENTICAL (16,577,960 bytes).
#
# History, so this isn't cited wrongly (SO e/343#22): an earlier version read with BARE ConvertFrom-Json.
# On PS 7.4 that parses ISO timestamps to DateTime and drops trailing millisecond zeros (28 of 34,321
# edges' discovered_at changed). That's the known bare-cmdlet defect that Read-EdgesFile (t/2974) already
# fixes. It is NOT a production bug: every module writer of edges.json reads through Read-EdgesFile.
# Pass -BareRead to reproduce the bare-cmdlet defect for contrast.
#
# Usage: pwsh -NoProfile -File roundtrip_edges_ps.ps1 -Repo <repo root> -In <committed edges.json> -Out <temp path> [-BareRead]
param([string]$Repo, [string]$In, [string]$Out, [switch]$BareRead)
$ErrorActionPreference = 'Stop'
Get-ChildItem "$Repo/scripts/AITriad/Private/*.ps1" | ForEach-Object { . $_.FullName }
"PS $($PSVersionTable.PSVersion); reader: $(if ($BareRead) { 'BARE ConvertFrom-Json (defect contrast)' } else { 'Read-EdgesFile (production)' })"
$obj = if ($BareRead) { [IO.File]::ReadAllText($In) | ConvertFrom-Json } else { Read-EdgesFile -Path $In }
Write-EdgesFile -EdgesData $obj -Path $Out
$a = [IO.File]::ReadAllBytes($In); $b = [IO.File]::ReadAllBytes($Out)
"bytes committed=$($a.Length) ps=$($b.Length)"
$i = 0; $n = [Math]::Min($a.Length, $b.Length); while ($i -lt $n -and $a[$i] -eq $b[$i]) { $i++ }
if ($i -eq $a.Length -and $a.Length -eq $b.Length) { 'RESULT: BYTE-IDENTICAL' } else { "RESULT: DIFF at byte $i" }
