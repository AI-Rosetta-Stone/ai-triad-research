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

function New-Doc([string]$Id, [hashtable]$Meta, [string]$SnapshotSha256) {
    $d = [ordered]@{ id = $Id; metadata = $Meta }
    if ($SnapshotSha256) { $d['snapshot_sha256'] = $SnapshotSha256 }
    $d
}
$h1 = 'a' * 64; $h2 = 'b' * 64; $h3 = 'c' * 64
$groupingCases = @(
    # Strong edges.
    @{ name = 'content hash joins different slugs'; documents = @(
        (New-Doc 'alpha-2026' @{ title = 'Alpha'; content_sha256 = $h1 }),
        (New-Doc 'alpha-brookings-2026' @{ title = 'Alpha Brookings'; content_sha256 = $h1 }),
        (New-Doc 'beta-2026' @{ title = 'Beta'; content_sha256 = $h2 })) }
    @{ name = 'computed snapshot hash joins like a recorded one'; documents = @(
        (New-Doc 'old-ingest-2026' @{ title = 'Old ingest' } $h1),
        (New-Doc 'new-ingest-elsewhere-2026' @{ title = 'New ingest'; content_sha256 = $h1 })) }
    @{ name = 'search-provenance URL does not join'; documents = @(
        (New-Doc 'one-2026' @{ title = 'One'; url = 'https://x.org/p'; provenance = @(@{ scheme = 'url'; id = 'https://x.org/p'; confidence = 'search' }) }),
        (New-Doc 'two-2026' @{ title = 'Two'; url = 'https://x.org/p'; provenance = @(@{ scheme = 'url'; id = 'https://x.org/p'; confidence = 'search' }) })) }
    @{ name = 'trusted URL joins, query param order ignored'; documents = @(
        (New-Doc 'hn-a-2026' @{ title = 'A'; url = 'https://news.ycombinator.com/item?id=1&p=2' }),
        (New-Doc 'hn-b-2026' @{ title = 'B'; url = 'https://news.ycombinator.com/item?p=2&id=1&utm_source=x' })) }
    @{ name = 'different query ids stay distinct'; documents = @(
        (New-Doc 'yt-a-2026' @{ title = 'Video A'; url = 'https://www.youtube.com/watch?v=AAA' }),
        (New-Doc 'yt-b-2026' @{ title = 'Video B'; url = 'https://www.youtube.com/watch?v=BBB' })) }
    @{ name = 'explicit same_as and parent_doc_id join; dangling link ignored'; documents = @(
        (New-Doc 'base-doc' @{ title = 'Base' }),
        (New-Doc 'reprint-elsewhere' @{ title = 'Reprint'; same_as = 'base-doc' }),
        (New-Doc 'part-two' @{ title = 'Part two'; parent_doc_id = 'base-doc' }),
        (New-Doc 'orphan-link' @{ title = 'Orphan'; same_as = 'not-in-set' })) }
    @{ name = 'strong edges union transitively (union, not first matching tier)'; documents = @(
        (New-Doc 'a-2026' @{ title = 'Apple'; url = 'https://u.org/1' }),
        (New-Doc 'b-2026' @{ title = 'Banana'; url = 'https://u.org/1'; content_sha256 = $h2 }),
        (New-Doc 'aa-2026' @{ title = 'Cherry'; content_sha256 = $h2 })) }

    # Conditional suffix edge (4.4).
    @{ name = 'suffix joins with an equal title'; documents = @(
        (New-Doc 'gamma-2026' @{ title = 'Gamma report' }),
        (New-Doc 'gamma-2026-1' @{ title = 'Gamma Report!' })) }
    @{ name = 'suffix needs the base to exist'; documents = @(
        (New-Doc 'delta-2026-2' @{ title = 'Delta' }),
        (New-Doc 'delta-2026-3' @{ title = 'Delta' })) }
    @{ name = 'suffix with a different title stays separate'; documents = @(
        (New-Doc 'epsilon-2026' @{ title = 'Epsilon' }),
        (New-Doc 'epsilon-2026-1' @{ title = 'Epsilon   Brookings' })) }
    @{ name = 'suffix with no title on either side stays separate'; documents = @(
        (New-Doc 'eta-2026' @{ }),
        (New-Doc 'eta-2026-1' @{ })) }
    @{ name = 'genuine -N collision: different recorded content_sha256 stays separate'; documents = @(
        (New-Doc 'annual-report-2026' @{ title = 'Annual Report'; content_sha256 = $h1 }),
        (New-Doc 'annual-report-2026-1' @{ title = 'Annual Report'; content_sha256 = $h2 })) }
    @{ name = 'recorded hash on one side only does not veto'; documents = @(
        (New-Doc 'theta-2026' @{ title = 'Theta' }),
        (New-Doc 'theta-2026-1' @{ title = 'Theta'; content_sha256 = $h1 })) }
    @{ name = 'computed snapshot hashes that differ do not veto (conversion noise)'; documents = @(
        (New-Doc 'iota-2026' @{ title = 'Iota' } $h1),
        (New-Doc 'iota-2026-1' @{ title = 'Iota' } $h2)) }
    @{ name = 'conflicting trusted URLs veto the suffix'; documents = @(
        (New-Doc 'kappa-2026' @{ title = 'Kappa'; url = 'https://one.org/k' }),
        (New-Doc 'kappa-2026-1' @{ title = 'Kappa'; url = 'https://two.org/k' })) }
    @{ name = 'a trusted URL on one side only does not veto'; documents = @(
        (New-Doc 'lambda-2026' @{ title = 'Lambda'; url = 'https://arxiv.org/abs/1606.06565v2' }),
        (New-Doc 'lambda-2026-1' @{ title = 'Lambda' })) }
    @{ name = 'a trusted URL on the -N side only does not veto'; documents = @(
        (New-Doc 'pi-2026' @{ title = 'Pi' }),
        (New-Doc 'pi-2026-1' @{ title = 'Pi'; url = 'https://p.org/x' })) }
    @{ name = 'search-provenance URL does not count as a conflicting URL'; documents = @(
        (New-Doc 'mu-2026' @{ title = 'Mu'; url = 'https://one.org/m' }),
        (New-Doc 'mu-2026-1' @{ title = 'Mu'; url = 'https://two.org/m'; provenance = @(@{ scheme = 'url'; id = 'https://two.org/m'; confidence = 'search' }) })) }
    @{ name = 'year suffix: foo-2026 with a different title does not join foo'; documents = @(
        (New-Doc 'foo' @{ title = 'Foo framework' }),
        (New-Doc 'foo-2026' @{ title = 'Foo outlook for 2026' })) }
    @{ name = 'year suffix: foo-2026 with an equal title joins foo'; documents = @(
        (New-Doc 'bar' @{ title = 'Bar' }),
        (New-Doc 'bar-2026' @{ title = 'Bar' })) }

    # Titles add no edge, only a title_collision report (4.5).
    @{ name = 'two distinct docs titled AI Policy Bulletin stay separate (title_collision)'; documents = @(
        (New-Doc 'ai-policy-bulletin-march-2026' @{ title = 'AI Policy Bulletin'; content_sha256 = $h1 }),
        (New-Doc 'ai-policy-bulletin-april-2026' @{ title = 'AI Policy Bulletin'; content_sha256 = $h2 })) }
    @{ name = 'non-ASCII titles that reduce to the same ASCII key stay separate (title_collision)'; documents = @(
        (New-Doc 'zh-policy-2026' @{ title = ([string][char]0x653F + [char]0x7B56 + ' 2026') }),
        (New-Doc 'zh-rules-2026' @{ title = ([string][char]0x89C4 + [char]0x5219 + ' 2026') })) }
    @{ name = 'missing titles do not fall back to the id (no title_collision)'; documents = @(
        (New-Doc 'ai-act-2026' @{ }),
        (New-Doc 'aiact-2026' @{ })) }
    @{ name = 'equal titles inside one group are not reported'; documents = @(
        (New-Doc 'nu-2026' @{ title = 'Nu'; content_sha256 = $h3 }),
        (New-Doc 'nu-mirror-2026' @{ title = 'Nu'; content_sha256 = $h3 })) }
)

# Real-corpus cases (TL, t/4344): actual metadata fields. The corpus records no content_sha256 yet,
# so the hash computed from the real snapshot.md goes in snapshot_sha256 (edges, never a veto).
$src = if ($SourcesDir) { $SourcesDir } else { Import-Module (Join-Path $wt 'scripts' 'AITriad' 'AITriad.psd1') -Force 3>$null; & (Get-Module AITriad) { Get-SourcesDir } }
function Get-RealDoc([string]$Id) {
    $m = Get-Content (Join-Path $src "$Id\metadata.json") -Raw | ConvertFrom-Json
    $meta = [ordered]@{}
    foreach ($f in 'title', 'url', 'resolved_url', 'provenance', 'content_sha256', 'same_as', 'parent_doc_id') { if ($m.PSObject.Properties[$f]) { $meta[$f] = $m.$f } }
    $hash = Get-SourceContentHash -Text ([System.IO.File]::ReadAllText((Join-Path $src "$Id\snapshot.md")))
    New-Doc $Id $meta $hash
}
$queryIds = @('ai-triad-dialogue-across-differences-2026', 'artificial-intelligence-index-report-2025-2026',
    'ai-agent-published-hit-piece-me-2026', 'evaluating-impact-ai-labor-market-current-state-affairs-2026',
    'baumols-cost-disease-long-term-economic-implications-where-2026', 'dreyfus-revisited-third-wave-artificial-intelligence-2026',
    'generative-ai-copyright-training-creation-regulation-2026')
$eightIds = @(Get-ChildItem $src -Directory | Where-Object Name -like 'eight-ways-ai-will-shape-geopolitics-2026*' | Select-Object -ExpandProperty Name)
$groupingCases += @{ name = 'REAL: 7 query-string documents stay distinct'; documents = @($queryIds | ForEach-Object { Get-RealDoc $_ }) }
$groupingCases += @{ name = 'REAL: eight-ways (7 docs, 2 outlets) collapses to one'; documents = @($eightIds | ForEach-Object { Get-RealDoc $_ }) }

function Get-ExpectedGrouping($docs) {
    $objs = @($docs | ForEach-Object {
        [pscustomobject]@{ Id = $_.id; Metadata = ($_.metadata | ConvertTo-Json -Depth 6 | ConvertFrom-Json)
                           SnapshotSha256 = $(if ($_.Contains('snapshot_sha256')) { $_['snapshot_sha256'] }) } })
    $r = Get-SourceIdentityGroup -Documents $objs
    $canon = [ordered]@{}
    $keys = [string[]]@($r.Canonical.Keys); [Array]::Sort($keys, [System.StringComparer]::Ordinal)
    foreach ($k in $keys) { $canon[$k] = $r.Canonical[$k] }
    [ordered]@{ canonical = $canon; collisions = @($r.TitleCollisions | ForEach-Object { , [string[]]$_ }) }
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
    version = 2
    hash_cases = @($hashCases | ForEach-Object { [ordered]@{ name = $_.name; text = $_.text; expected_sha256 = (Get-SourceContentHash -Text $_.text) } })
    url_cases = @($urlCases | ForEach-Object { [ordered]@{ name = $_.name; input = $_.input; expected = (ConvertTo-SourceUrlKey -Url $_.input) } })
    trust_cases = @($trustCases | ForEach-Object {
        $meta = $_.metadata | ConvertTo-Json -Depth 5 | ConvertFrom-Json
        [string[]]$keys = Get-TrustedSourceUrlKey -Metadata $meta
        [ordered]@{ name = $_.name; metadata = $_.metadata; expected = $keys } })
    title_cases = @($titleCases | ForEach-Object { [ordered]@{ name = $_.name; input = $_.input; expected = (ConvertTo-SourceTitleKey -Title $_.input) } })
    grouping_cases = @($groupingCases | ForEach-Object { $g = Get-ExpectedGrouping $_.documents; [ordered]@{ name = $_.name; documents = $_.documents; expected_canonical = $g.canonical; expected_title_collisions = $g.collisions } })
}
$json = $fixture | ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText("$wt\tests\fixtures\source-identity-cases.json", $json + "`n", [System.Text.UTF8Encoding]::new($false))
"hash=$($fixture.hash_cases.Count) url=$($fixture.url_cases.Count) trust=$($fixture.trust_cases.Count) title=$($fixture.title_cases.Count) grouping=$($fixture.grouping_cases.Count)"
foreach ($t in $fixture.title_cases) { '  title {0,-36} -> "{1}"' -f $t.name, $t.expected }
foreach ($g in $fixture.grouping_cases) {
    $groups = $g.expected_canonical.GetEnumerator() | Group-Object Value
    "  group {0}: {1} docs -> {2} group(s): {3}" -f $g.name, $g.documents.Count, @($groups).Count, (($groups | ForEach-Object { '[' + (($_.Group | ForEach-Object Key) -join ', ') + ']' }) -join ' ')
}
