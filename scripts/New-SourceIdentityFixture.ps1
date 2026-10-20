# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Regenerates tests/fixtures/source-identity-cases.json (docs/specs/source-identity.md, t/4344).
.DESCRIPTION
    Expected values come from scripts/AITriad/Private/SourceIdentity.ps1. The two REAL grouping
    cases read actual metadata.json and snapshot.md from the sources directory (Get-SourcesDir,
    or -SourcesDir). Output is byte-stable: rerunning on an unchanged spec and corpus gives an
    identical file. After regenerating, confirm the new expected values with a second, from-spec
    implementation in the other runtime before committing (spec section 5).
#>
[CmdletBinding()]
param([string]$SourcesDir)
Set-StrictMode -Version Latest
$wt = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
. "$wt\scripts\AITriad\Private\SourceIdentity.ps1"

$hdr = "<!--`r`n  AI Triad Research Project — Document Snapshot`r`n  Title      : Eight ways AI will shape geopolitics in 2026`r`n  Source     : `r`n  Type       : pdf`r`n  Captured   : {0}`r`n  This file is a Markdown shadow copy for AI summarisation and POViewer display.`r`n  The original file lives in raw/ for fidelity (charts, tables, exact layout).`r`n-->`r`n`r`n# Eight ways AI will shape geopolitics in 2026`r`n`r`n> **Snapshot captured:** {0}`r`n> **Source:** `r`n> **Type:** pdf`r`n`r`n---`r`n`r`n"
$body = "Para one about AI.`n`nPara two.`n"
$cafeNfc = "Caf" + [char]0x00E9 + " r" + [char]0x00E9 + "sum" + [char]0x00E9
$cafeNfd = "Cafe" + [char]0x0301 + " re" + [char]0x0301 + "sume" + [char]0x0301

$hashCases = @(
    @{ name = 'plain body, LF';                         text = $body }
    @{ name = 'same body, CRLF (equals plain)';         text = $body.Replace("`n", "`r`n") }
    @{ name = 'same body, lone CR (equals plain)';      text = $body.Replace("`n", "`r") }
    @{ name = 'same body with BOM (equals plain)';      text = ([string][char]0xFEFF) + $body }
    @{ name = 'same body, trailing spaces/tabs (equals plain)'; text = "Para one about AI.  `t`n`nPara two. `n" }
    @{ name = 'same body, extra edge blank lines (equals plain)'; text = "`n`n  `nPara one about AI.`n`nPara two.`n`n`n" }
    @{ name = 'interior blank lines are kept (differs)'; text = "Para one about AI.`n`n`nPara two.`n" }
    @{ name = 'non-breaking space is not trimmed (differs)'; text = "Para one about AI." + [char]0x00A0 + "`n`nPara two.`n" }
    @{ name = 'leading indentation is kept (differs)';  text = "  Para one about AI.`n`nPara two.`n" }
    @{ name = 'header captured 2026-04-11 (equals plain)'; text = ($hdr -f '2026-04-11') + $body }
    @{ name = 'header captured 2026-09-22 (equals plain)'; text = ($hdr -f '2026-09-22') + $body }
    @{ name = 'header without closing rule is kept (differs)'; text = "<!--`n  AI Triad Research Project`n-->`n`n" + $body }
    @{ name = 'non-ASCII NFC';                          text = "# $cafeNfc`n`nBody.`n" }
    @{ name = 'non-ASCII NFD (equals NFC)';             text = "# $cafeNfd`n`nBody.`n" }
    @{ name = 'empty';                                  text = '' }
    @{ name = 'whitespace only';                        text = " `n`t`n" }
    @{ name = 'header only';                            text = ($hdr -f '2026-04-11') }
    @{ name = 'PDF extraction failure placeholder';     text = "# PDF EXTRACTION FAILED`n`nSource: C:\inbox\a.pdf`n`nInstall markitdown and re-run." }
    @{ name = 'binary placeholder';                     text = "# report.docx`n`n[Binary file — no text extraction available]" }
    @{ name = 'body that quotes the binary placeholder text (hashed)'; text = "# Notes`n`nThe tool printed [Binary file — no text extraction available] once.`n" }
)
$urlCases = @(
    @{ name = 'https + www + trailing slash';  input = 'https://www.Brookings.edu/articles/AI-and-Geopolitics/' }
    @{ name = 'http and https are equal';      input = 'http://brookings.edu/articles/AI-and-Geopolitics' }
    @{ name = 'path case is preserved';        input = 'https://brookings.edu/articles/ai-and-geopolitics' }
    @{ name = 'fragment dropped';              input = 'https://example.org/paper#section-2' }
    @{ name = 'utm params dropped';            input = 'https://example.org/post?utm_source=x&UTM_Medium=y&id=7' }
    @{ name = 'fbclid gclid mc_ dropped';      input = 'https://example.org/post?fbclid=a&gclid=b&mc_cid=c&mc_eid=d' }
    @{ name = 'query order normalized A';      input = 'https://news.ycombinator.com/item?id=47051956&p=2' }
    @{ name = 'query order normalized B';      input = 'https://news.ycombinator.com/item?p=2&id=47051956' }
    @{ name = 'youtube v= kept, case-sensitive'; input = 'https://www.youtube.com/watch?v=d03EjhZtShq' }
    @{ name = 'youtube different v= differs';  input = 'https://www.youtube.com/watch?v=kgA0zpfSruo' }
    @{ name = 'empty query parts dropped';     input = 'https://example.org/x?&&a=1&' }
    @{ name = 'default port dropped';          input = 'https://example.org:443/x' }
    @{ name = 'non-default port kept';         input = 'https://example.org:8443/x' }
    @{ name = 'userinfo dropped';              input = 'https://user:pw@example.org/x' }
    @{ name = 'percent-encoding kept as written'; input = 'https://example.org/a%2Fb?q=a%20b' }
    @{ name = 'surrounding whitespace trimmed'; input = '  https://example.org/x  ' }
    @{ name = 'scheme case-insensitive';       input = 'HTTPS://Example.org/X' }
    @{ name = 'bare DOI is null';              input = '10.1073/pnas.2416228122' }
    @{ name = 'non-http scheme is null';       input = 'ftp://example.org/x' }
    @{ name = 'free text is null';             input = 'Atlantic Council' }
    @{ name = 'empty is null';                 input = '' }
    @{ name = 'null is null';                  input = $null }
    @{ name = 'host only';                     input = 'https://example.org' }
    @{ name = 'non-ASCII path kept';           input = "https://example.org/caf" + [char]0x00E9 }
)
$search = @{ scheme = 'url'; id = 'https://www.brookings.edu/articles/artificial-intelligence-and-the-future-of-geopolitics/'; confidence = 'search' }
$trustCases = @(
    @{ name = 'url from search provenance is untrusted'; metadata = @{ url = $search.id; resolved_url = $search.id; provenance = @($search) } }
    @{ name = 'url and resolved_url, both trusted, deduped'; metadata = @{ url = 'https://example.org/x/'; resolved_url = 'https://www.example.org/x' } }
    @{ name = 'resolved_url differs and is kept second'; metadata = @{ url = 'https://t.co/abc'; resolved_url = 'https://example.org/x?utm_source=t' } }
    @{ name = 'non-search provenance does not untrust'; metadata = @{ url = 'https://example.org/x'; provenance = @(@{ scheme = 'url'; id = 'https://example.org/x'; confidence = 'extracted' }) } }
    @{ name = 'search provenance for a different url only untrusts that url'; metadata = @{ url = 'https://example.org/x'; resolved_url = 'https://other.org/y'; provenance = @(@{ scheme = 'url'; id = 'https://other.org/y/'; confidence = 'search' }) } }
    @{ name = 'doi provenance ignored'; metadata = @{ url = 'https://example.org/x'; provenance = @(@{ scheme = 'doi'; id = 'https://example.org/x'; confidence = 'search' }) } }
    @{ name = 'no url fields'; metadata = @{ title = 'x' } }
)

$titleCases = @(
    @{ name = 'punctuation and case';             input = 'Eight ways AI will shape geopolitics in 2026' }
    @{ name = 'site name appended stays distinct'; input = 'Eight ways AI will shape geopolitics in 2026   Atlantic Council' }
    @{ name = 'plus as space (URL-encoded title)'; input = 'Managing+Risks+from+Internal+AI+Systems' }
    @{ name = 'colon, quotes, dash removed';      input = "Managing Risks: from 'Internal' AI—Systems" }
    @{ name = 'non-ASCII letters deleted';        input = 'Café résumé' }
    @{ name = 'non-breaking space deleted';       input = 'AI' + [char]0x00A0 + 'safety' }
    @{ name = 'tabs and newlines collapse';       input = "AI`t safety`n report" }
    @{ name = 'underscore and digits kept';       input = 'gpt_4 report 2026' }
    @{ name = 'punctuation only is empty';        input = '!!! ---' }
    @{ name = 'empty';                            input = '' }
)

function New-Doc([string]$Id, [hashtable]$Meta) { [ordered]@{ id = $Id; metadata = $Meta } }
$h1 = 'a' * 64; $h2 = 'b' * 64
$groupingCases = @(
    @{ name = 'content hash joins different slugs'; documents = @(
        (New-Doc 'alpha-2026' @{ title = 'Alpha'; content_sha256 = $h1 }),
        (New-Doc 'alpha-brookings-2026' @{ title = 'Alpha Brookings'; content_sha256 = $h1 }),
        (New-Doc 'beta-2026' @{ title = 'Beta'; content_sha256 = $h2 })) }
    @{ name = 'search-provenance URL does not join'; documents = @(
        (New-Doc 'one-2026' @{ title = 'One'; url = 'https://x.org/p'; provenance = @(@{ scheme = 'url'; id = 'https://x.org/p'; confidence = 'search' }) }),
        (New-Doc 'two-2026' @{ title = 'Two'; url = 'https://x.org/p'; provenance = @(@{ scheme = 'url'; id = 'https://x.org/p'; confidence = 'search' }) })) }
    @{ name = 'trusted URL joins, query param order ignored'; documents = @(
        (New-Doc 'hn-a-2026' @{ title = 'A'; url = 'https://news.ycombinator.com/item?id=1&p=2' }),
        (New-Doc 'hn-b-2026' @{ title = 'B'; url = 'https://news.ycombinator.com/item?p=2&id=1&utm_source=x' })) }
    @{ name = 'different query ids stay distinct'; documents = @(
        (New-Doc 'yt-a-2026' @{ title = 'Video A'; url = 'https://www.youtube.com/watch?v=AAA' }),
        (New-Doc 'yt-b-2026' @{ title = 'Video B'; url = 'https://www.youtube.com/watch?v=BBB' })) }
    @{ name = 'suffix joins only when the base exists'; documents = @(
        (New-Doc 'gamma-2026' @{ title = 'Gamma' }),
        (New-Doc 'gamma-2026-1' @{ title = 'Gamma copy' }),
        (New-Doc 'delta-2026-2' @{ title = 'Delta copy' })) }
    @{ name = 'title tier joins, missing title falls back to id'; documents = @(
        (New-Doc 'report-x-2026' @{ title = 'The Report!' }),
        (New-Doc 'report-y-2026' @{ title = 'the report' }),
        (New-Doc 'thereport' @{ })) }
    @{ name = 'explicit same_as and parent_doc_id join; dangling link ignored'; documents = @(
        (New-Doc 'base-doc' @{ title = 'Base' }),
        (New-Doc 'reprint-elsewhere' @{ title = 'Reprint'; same_as = 'base-doc' }),
        (New-Doc 'part-two' @{ title = 'Part two'; parent_doc_id = 'base-doc' }),
        (New-Doc 'orphan-link' @{ title = 'Orphan'; same_as = 'not-in-set' })) }
    @{ name = 'tiers union transitively (hash + suffix + url)'; documents = @(
        (New-Doc 'zeta-2026' @{ title = 'Zeta'; content_sha256 = $h1 }),
        (New-Doc 'zeta-mirror-2026' @{ title = 'Zeta mirror'; content_sha256 = $h1; url = 'https://m.org/z' }),
        (New-Doc 'zeta-mirror-2026-1' @{ title = 'Zeta mirror again' }),
        (New-Doc 'unrelated-2026' @{ title = 'Unrelated'; url = 'https://m.org/z/' })) }
    @{ name = 'a doc matching two groups joins both (union, not first matching tier)'; documents = @(
        (New-Doc 'a-2026' @{ title = 'Apple'; url = 'https://u.org/1' }),
        (New-Doc 'b-2026' @{ title = 'Common ground'; url = 'https://u.org/1' }),
        (New-Doc 'aa-2026' @{ title = 'Common ground' })) }
)

# Real-corpus cases (TL, t/4344): actual metadata fields + content_sha256 from the real snapshot.md.
$src = if ($SourcesDir) { $SourcesDir } else { Import-Module (Join-Path $wt 'scripts' 'AITriad' 'AITriad.psd1') -Force 3>$null; & (Get-Module AITriad) { Get-SourcesDir } }
function Get-RealDoc([string]$Id) {
    $m = Get-Content (Join-Path $src "$Id\metadata.json") -Raw | ConvertFrom-Json
    $meta = [ordered]@{}
    foreach ($f in 'title', 'url', 'resolved_url', 'provenance') { if ($m.PSObject.Properties[$f]) { $meta[$f] = $m.$f } }
    $snap = Join-Path $src "$Id\snapshot.md"
    $hash = Get-SourceContentHash -Text ([System.IO.File]::ReadAllText($snap))
    if ($hash) { $meta['content_sha256'] = $hash }
    New-Doc $Id $meta
}
$queryIds = @('ai-triad-dialogue-across-differences-2026', 'artificial-intelligence-index-report-2025-2026',
    'ai-agent-published-hit-piece-me-2026', 'evaluating-impact-ai-labor-market-current-state-affairs-2026',
    'baumols-cost-disease-long-term-economic-implications-where-2026', 'dreyfus-revisited-third-wave-artificial-intelligence-2026',
    'generative-ai-copyright-training-creation-regulation-2026')
$eightIds = @(Get-ChildItem $src -Directory | Where-Object Name -like 'eight-ways-ai-will-shape-geopolitics-2026*' | Select-Object -ExpandProperty Name)
$groupingCases += @{ name = 'REAL: 7 query-string documents stay distinct'; documents = @($queryIds | ForEach-Object { Get-RealDoc $_ }) }
$groupingCases += @{ name = 'REAL: eight-ways (7 docs, 2 outlets) collapses to one'; documents = @($eightIds | ForEach-Object { Get-RealDoc $_ }) }

function Get-ExpectedCanonical($docs) {
    $objs = @($docs | ForEach-Object { [pscustomobject]@{ Id = $_.id; Metadata = ($_.metadata | ConvertTo-Json -Depth 6 | ConvertFrom-Json) } })
    $map = Get-SourceCanonicalIdMap -Documents $objs
    $o = [ordered]@{}
    foreach ($k in ($map.Keys | Sort-Object { $_ } -CaseSensitive)) { $o[$k] = $map[$k] }
    $o
}

# Deterministic output: hashtable literals have no stable key order, so every metadata object is
# rebuilt with ordinally sorted keys (recursively) before serialization.
function ConvertTo-SortedJsonValue($v) {
    if ($null -eq $v) { return $null }
    if ($v -is [string] -or $v -is [ValueType]) { return $v }
    if ($v -is [System.Collections.IDictionary]) {
        $o = [ordered]@{}
        foreach ($k in ([string[]]@($v.Keys) | Sort-Object { $_ } -CaseSensitive)) { $o[$k] = ConvertTo-SortedJsonValue $v[$k] }
        return $o
    }
    if ($v -is [System.Management.Automation.PSCustomObject]) {
        $o = [ordered]@{}
        foreach ($k in ([string[]]@($v.PSObject.Properties.Name) | Sort-Object { $_ } -CaseSensitive)) { $o[$k] = ConvertTo-SortedJsonValue $v.$k }
        return $o
    }
    if ($v -is [System.Collections.IEnumerable]) { return , @($v | ForEach-Object { ConvertTo-SortedJsonValue $_ }) }
    $v
}
foreach ($c in $trustCases) { $c.metadata = ConvertTo-SortedJsonValue $c.metadata }
foreach ($g in $groupingCases) { foreach ($d in $g.documents) { $d.metadata = ConvertTo-SortedJsonValue $d.metadata } }

$fixture = [ordered]@{
    '$schema_note' = 'docs/specs/source-identity.md section 5. Expected values: PowerShell scripts/AITriad/Private/SourceIdentity.ps1, independently confirmed by a from-spec Node implementation.'
    version = 1
    hash_cases = @($hashCases | ForEach-Object { [ordered]@{ name = $_.name; text = $_.text; expected_sha256 = (Get-SourceContentHash -Text $_.text) } })
    url_cases = @($urlCases | ForEach-Object { [ordered]@{ name = $_.name; input = $_.input; expected = (ConvertTo-SourceUrlKey -Url $_.input) } })
    trust_cases = @($trustCases | ForEach-Object {
        $meta = $_.metadata | ConvertTo-Json -Depth 5 | ConvertFrom-Json
        [string[]]$keys = Get-TrustedSourceUrlKey -Metadata $meta
        [ordered]@{ name = $_.name; metadata = $_.metadata; expected = $keys } })
    title_cases = @($titleCases | ForEach-Object { [ordered]@{ name = $_.name; input = $_.input; expected = (ConvertTo-SourceTitleKey -Title $_.input) } })
    grouping_cases = @($groupingCases | ForEach-Object { [ordered]@{ name = $_.name; documents = $_.documents; expected_canonical = (Get-ExpectedCanonical $_.documents) } })
}
$json = $fixture | ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText("$wt\tests\fixtures\source-identity-cases.json", $json + "`n", [System.Text.UTF8Encoding]::new($false))
"hash=$($fixture.hash_cases.Count) url=$($fixture.url_cases.Count) trust=$($fixture.trust_cases.Count) title=$($fixture.title_cases.Count) grouping=$($fixture.grouping_cases.Count)"
foreach ($t in $fixture.title_cases) { '  title {0,-36} -> "{1}"' -f $t.name, $t.expected }
foreach ($g in $fixture.grouping_cases) {
    $groups = $g.expected_canonical.GetEnumerator() | Group-Object Value
    "  group {0}: {1} docs -> {2} group(s): {3}" -f $g.name, $g.documents.Count, @($groups).Count, (($groups | ForEach-Object { '[' + (($_.Group | ForEach-Object Key) -join ', ') + ']' }) -join ' ')
}
