# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Pure parser: per-file wall-clock durations from a test-powershell shard's CI job log.
.DESCRIPTION
    ShardBalancer.ps1 bin-packs test files by the durations in test-powershell-shard-durations.json.
    That file was built from the sum of each file's TEST durations, which excludes BeforeAll,
    module imports and other per-file setup, so it recorded ~742s for a suite whose six shards
    actually take ~40 min combined, and the LPT packing balanced the wrong numbers (shard 4
    ran 11 min while others ran 5-7).

    A CI job log prints a timestamped "Running tests from '<file>'" line as each file starts, and
    "Tests completed in" when the first run ends. A file's real cost is therefore the gap to the
    next file's start (setup included); the last file runs until "Tests completed in". Lines after
    that marker (the t/3530 flake rerun) are ignored, so a rerun never double-counts a file.
#>

function ConvertFrom-PesterShardLog {
    [CmdletBinding()]
    [OutputType([System.Collections.Specialized.OrderedDictionary])]
    param(
        [Parameter(Mandatory)] [AllowEmptyString()] [string[]]$LogLine,
        [string]$Source = '<log>'
    )

    $ansi = [regex]'\x1b\[[0-9;]*m'
    $start = [regex]"^(?<ts>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s+Running tests from '(?<path>[^']+)'"
    $done = [regex]'^(?<ts>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s+Tests completed in'
    $toTime = { param($s) [datetimeoffset]::Parse($s, [Globalization.CultureInfo]::InvariantCulture) }

    $starts = [System.Collections.Generic.List[object]]::new()
    $end = $null
    foreach ($raw in $LogLine) {
        $line = $ansi.Replace($raw, '')
        $m = $start.Match($line)
        if ($m.Success) {
            $p = $m.Groups['path'].Value -replace '\\', '/'
            $rel = if ($p -match '(?:^|/)(tests/.+)$') { $Matches[1] } else { $p }
            $starts.Add([pscustomobject]@{ Path = $rel; At = (& $toTime $m.Groups['ts'].Value) })
            continue
        }
        $d = $done.Match($line)
        if ($d.Success) { $end = & $toTime $d.Groups['ts'].Value; break }
    }

    if ($starts.Count -eq 0) {
        throw ("ConvertFrom-PesterShardLog: no test files found in $Source.`n" +
            "  Goal:       read per-file durations from a test-powershell shard log.`n" +
            "  Problem:    no timestamped `"Running tests from '<file>'`" lines.`n" +
            "  Location:   operations/devops/ShardDurationsFromLog.ps1.`n" +
            "  Next steps: confirm the log is from a test-powershell job with Output.Verbosity=Detailed.")
    }
    if ($null -eq $end) {
        throw ("ConvertFrom-PesterShardLog: $Source has no 'Tests completed in' line.`n" +
            "  Goal:       read per-file durations from a test-powershell shard log.`n" +
            "  Problem:    the run did not finish (timeout or cancellation), so the last file's duration is unknown.`n" +
            "  Location:   operations/devops/ShardDurationsFromLog.ps1.`n" +
            "  Next steps: use a run where every test-powershell shard completed.")
    }

    $result = [ordered]@{}
    for ($i = 0; $i -lt $starts.Count; $i++) {
        $next = if ($i + 1 -lt $starts.Count) { $starts[$i + 1].At } else { $end }
        $result[$starts[$i].Path] = [math]::Round(($next - $starts[$i].At).TotalSeconds, 3)
    }
    $result
}

<#
.SYNOPSIS
    Pure: per-file MEDIAN across several runs' duration maps.
.DESCRIPTION
    One run's per-file times are noisy: two consecutive green runs differed by ~25% of the suite
    in total, with single files swinging 119s -> 173s, and the first file in each shard absorbing
    one-time warm-up. Balancing against one run overfits that run. The median of several runs
    keeps one slow sample from moving a file. A file missing from some runs uses the runs it
    appears in.
#>
function Merge-ShardDurationSample {
    [CmdletBinding()]
    [OutputType([hashtable])]
    param([Parameter(Mandatory)] [System.Collections.IDictionary[]]$Sample)

    $values = @{}
    foreach ($s in $Sample) {
        foreach ($k in $s.Keys) {
            if (-not $values.ContainsKey($k)) { $values[$k] = [System.Collections.Generic.List[double]]::new() }
            $values[$k].Add([double]$s[$k])
        }
    }
    $merged = @{}
    foreach ($k in $values.Keys) {
        $sorted = @($values[$k] | Sort-Object)
        $n = $sorted.Count
        $median = if ($n % 2 -eq 1) { $sorted[($n - 1) / 2] } else { ($sorted[$n / 2 - 1] + $sorted[$n / 2]) / 2 }
        $merged[$k] = [math]::Round($median, 3)
    }
    $merged
}
