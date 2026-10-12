# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Show-AICallLog {
    <#
    .SYNOPSIS
        Render the AI call log as a self-contained, sortable/filterable HTML viewer.
    .DESCRIPTION
        The HTML viewer for the AI Call Log (t/3244; epic t/3235, TL design t/3235#1). Fetches
        records via Get-AICallLog (t/3243) — inheriting all its filters — and renders them into a
        single self-contained HTML file (no external assets/CDN) with a click-to-sort table and a
        live text filter. Follows the Show-*/HTML-report pattern (mirrors Compare-Taxonomy): write
        to an unpredictable temp path, then open in the default browser.

        Reading is decoupled from the AI_CALL_LOG_ENABLED capture flag (the flag gates writes) — an
        absent/empty log still renders a valid page stating there are no records (non-fatal).
    .PARAMETER Scenario
        Passed to Get-AICallLog: keep only records whose Scenario matches this wildcard (-like).
    .PARAMETER Status
        Passed to Get-AICallLog: keep only records whose Status matches this wildcard (-like).
    .PARAMETER After
        Passed to Get-AICallLog: keep only records at or after this timestamp.
    .PARAMETER Before
        Passed to Get-AICallLog: keep only records strictly before this timestamp.
    .PARAMETER Path
        Log file override (fixtures/tests). Default: the resolved data-root log (via Get-AICallLog).
    .PARAMETER PassThru
        Return the generated HTML file path instead of opening it in a browser (used by tests and
        for scripting).
    .OUTPUTS
        None by default (opens a browser). With -PassThru: [string] path to the generated HTML file.
    .EXAMPLE
        Show-AICallLog
        Render every logged AI call and open the viewer.
    .EXAMPLE
        Show-AICallLog -Scenario Debate -Status '4*'
        View only Debate-scenario calls that returned a 4xx status.
    .EXAMPLE
        $report = Show-AICallLog -PassThru
        Generate the HTML report and capture its path without opening a browser.
    .LINK
        Get-AICallLog
    .LINK
        Clear-AICallLog
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter()]
        [SupportsWildcards()]
        [string]$Scenario,

        [Parameter()]
        [SupportsWildcards()]
        [string]$Status,

        [Parameter()]
        [datetime]$After,

        [Parameter()]
        [datetime]$Before,

        [Parameter()]
        [string]$Path,

        [Parameter()]
        [switch]$PassThru
    )
    Set-StrictMode -Version Latest

    # ── Fetch via Get-AICallLog (single source of truth) — forward only the bound filters ─────
    $fwd = @{}
    foreach ($p in 'Scenario', 'Status', 'After', 'Before', 'Path') {
        if ($PSBoundParameters.ContainsKey($p)) { $fwd[$p] = $PSBoundParameters[$p] }
    }
    $entries = @(Get-AICallLog @fwd)

    # ── Build the HTML (self-contained; every value HTML-escaped) ─────────────────────────────
    # WebUtility (not System.Web/HttpUtility) so no assembly load is needed on any platform.
    function Format-Cell ([object]$Value) { [System.Net.WebUtility]::HtmlEncode([string]$Value) }

    $cols = 'ID', 'Datetime', 'Scenario', 'PromptID', 'PromptStart', 'RetryCount', 'Status', 'Model', 'Backend', 'KeySource'

    $rowsHtml = [System.Text.StringBuilder]::new()
    foreach ($e in $entries) {
        [void]$rowsHtml.Append('<tr class="r">')
        # ID / RetryCount get data-num so the sorter compares them numerically.
        [void]$rowsHtml.Append("<td data-num=""$([int]$e.ID)"">$(Format-Cell $e.ID)</td>")
        # Emit Datetime as UTC round-trip text so sorting is lexicographic == chronological.
        $dtText = $e.Datetime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        [void]$rowsHtml.Append("<td>$(Format-Cell $dtText)</td>")
        [void]$rowsHtml.Append("<td>$(Format-Cell $e.Scenario)</td>")
        [void]$rowsHtml.Append("<td>$(Format-Cell $e.PromptID)</td>")
        [void]$rowsHtml.Append("<td>$(Format-Cell $e.PromptStart)</td>")
        [void]$rowsHtml.Append("<td data-num=""$([int]$e.RetryCount)"">$(Format-Cell $e.RetryCount)</td>")
        [void]$rowsHtml.Append("<td>$(Format-Cell $e.Status)</td>")
        [void]$rowsHtml.Append("<td>$(Format-Cell $e.Model)</td>")
        [void]$rowsHtml.Append("<td>$(Format-Cell $e.Backend)</td>")
        [void]$rowsHtml.Append("<td>$(Format-Cell $e.KeySource)</td>")
        [void]$rowsHtml.Append('</tr>')
    }

    $headHtml = ($cols | ForEach-Object { "<th onclick=""sortTable($($cols.IndexOf($_)))"">$(Format-Cell $_)</th>" }) -join ''
    $generated = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ss') + ' UTC'
    $count = $entries.Count

    $tableOrEmpty = if ($count -gt 0) {
        @"
<table id="log">
  <thead><tr>$headHtml</tr></thead>
  <tbody>
$($rowsHtml.ToString())
  </tbody>
</table>
"@
    }
    else {
        '<p class="empty">No AI call log records. Set <code>AI_CALL_LOG_ENABLED=1</code> to start capturing calls.</p>'
    }

    # NB: {} in the <style>/<script> are doubled ({{ }}) because this is an -f format string.
    $html = @"
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI Call Log</title>
<style>
  body {{ font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 2rem; color: #1a1a1a; }}
  h1 {{ font-size: 1.4rem; margin: 0 0 .25rem; }}
  .meta {{ color: #666; font-size: .85rem; margin-bottom: 1rem; }}
  #filter {{ padding: .4rem .6rem; font-size: .9rem; width: 20rem; max-width: 100%;
            border: 1px solid #ccc; border-radius: 4px; margin-bottom: 1rem; }}
  table {{ border-collapse: collapse; width: 100%; font-size: .85rem; }}
  th, td {{ border: 1px solid #e0e0e0; padding: .4rem .6rem; text-align: left; vertical-align: top; }}
  th {{ background: #f5f5f7; cursor: pointer; user-select: none; position: sticky; top: 0; }}
  th:hover {{ background: #ebebf0; }}
  tr:nth-child(even) td {{ background: #fafafa; }}
  td:nth-child(5) {{ max-width: 40rem; word-break: break-word; font-family: ui-monospace, Menlo, Consolas, monospace; }}
  .empty {{ color: #888; font-style: italic; }}
</style>
</head>
<body>
<h1>AI Call Log</h1>
<div class="meta">{0} record(s) &middot; generated {1}</div>
<input id="filter" type="text" placeholder="Filter rows (matches any column)&hellip;" oninput="filterRows(this.value)" aria-label="Filter rows">
{2}
<script>
  // Live substring filter across all cells (case-insensitive).
  function filterRows(q) {{
    q = (q || '').toLowerCase();
    var rows = document.querySelectorAll('#log tbody tr');
    for (var i = 0; i < rows.length; i++) {{
      rows[i].style.display = rows[i].textContent.toLowerCase().indexOf(q) === -1 ? 'none' : '';
    }}
  }}
  // Click-to-sort; numeric when the cell carries data-num, else string. Toggles direction.
  var sortDir = {{}};
  function sortTable(col) {{
    var table = document.getElementById('log');
    if (!table) return;
    var tbody = table.tBodies[0];
    var rows = Array.prototype.slice.call(tbody.rows);
    var dir = sortDir[col] = !sortDir[col];
    rows.sort(function (a, b) {{
      var ca = a.cells[col], cb = b.cells[col];
      var na = ca.getAttribute('data-num'), nb = cb.getAttribute('data-num');
      var va, vb;
      if (na !== null && nb !== null) {{ va = parseFloat(na); vb = parseFloat(nb); }}
      else {{ va = ca.textContent.toLowerCase(); vb = cb.textContent.toLowerCase(); }}
      if (va < vb) return dir ? -1 : 1;
      if (va > vb) return dir ? 1 : -1;
      return 0;
    }});
    for (var i = 0; i < rows.length; i++) {{ tbody.appendChild(rows[i]); }}
  }}
</script>
</body>
</html>
"@ -f $count, $generated, $tableOrEmpty

    # ── Write to an unpredictable temp path, then open (or return with -PassThru) ─────────────
    # Unpredictable name — a fixed temp filename lets a local attacker pre-create the path
    # (e.g. as a symlink) to redirect this write (t/2530).
    $tempPath = New-SecureTempPath -Prefix 'AITriad-AICallLog' -Extension 'html'
    Set-Content -LiteralPath $tempPath -Value $html -Encoding utf8
    Write-OK "AI call log viewer written to $tempPath ($count record(s))"

    if ($PassThru) { return $tempPath }

    if ($IsWindows)   { Start-Process $tempPath }
    elseif ($IsMacOS) { Start-Process 'open' -ArgumentList $tempPath }
    elseif ($IsLinux) { Start-Process 'xdg-open' -ArgumentList $tempPath }
}
