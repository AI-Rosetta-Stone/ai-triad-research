param([string]$Repo, [string]$In, [string]$Out)
$ErrorActionPreference = 'Stop'
Get-ChildItem "$Repo/scripts/AITriad/Private/*.ps1" | ForEach-Object { . $_.FullName }
"PS " + $PSVersionTable.PSVersion
$hasDateKind = (Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')
"DateKind supported: $hasDateKind"
$raw = [IO.File]::ReadAllText($In)
$obj = if ($hasDateKind) { $raw | ConvertFrom-Json -DateKind String } else { $raw | ConvertFrom-Json }
Write-EdgesFile -EdgesData $obj -Path $Out
$a = [IO.File]::ReadAllBytes($In); $b = [IO.File]::ReadAllBytes($Out)
"bytes committed=$($a.Length) ps=$($b.Length)"
$i = 0; $n = [Math]::Min($a.Length, $b.Length); while ($i -lt $n -and $a[$i] -eq $b[$i]) { $i++ }
if ($i -eq $a.Length -and $a.Length -eq $b.Length) { "RESULT: BYTE-IDENTICAL" } else {
  "RESULT: DIFF at byte $i"
  "committed: " + [Text.Encoding]::UTF8.GetString($a, [Math]::Max(0,$i-80), [Math]::Min(160, $a.Length - [Math]::Max(0,$i-80)))
  "ps       : " + [Text.Encoding]::UTF8.GetString($b, [Math]::Max(0,$i-80), [Math]::Min(160, $b.Length - [Math]::Max(0,$i-80)))
}
