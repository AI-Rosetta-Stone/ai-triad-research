# Tag: ingestion (t/4564)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    t/4564: markitdown (and, for real HTML, ConvertFrom-Html's own gaps) can leave Jetpack-style
    WordPress blog-footer widgets -- share buttons, a related-posts widget, comment forms,
    sidebar "Subscribe"/"Search" widgets, embedded-video galleries -- in the converted markdown,
    where they get read as article content (4 sidebar-caption/archive-link key_points extracted
    from one blog post, found in the t/4556 AC1 run). Remove-BlogChromeTail cuts everything from
    the earliest blog-footer marker onward.
#>

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'DocConverters.psm1') -Force
}

Describe 'Remove-BlogChromeTail (t/4564)' -Tag 'ingestion' {

    It 'is a no-op when no marker is present' {
        $md = "# Title`n`nSome article text with no chrome at all."
        Remove-BlogChromeTail -Markdown $md | Should -BeExactly $md
    }

    It 'cuts everything from "Share this:" onward, keeping the article body' {
        $md = "# Title`n`nThe article body goes here.`n`n### Share this:`n`n- [X](url)`n- [Facebook](url)"
        Remove-BlogChromeTail -Markdown $md | Should -BeExactly "# Title`n`nThe article body goes here."
    }

    It 'cuts at "Post navigation" when no "Share this:" is present' {
        $md = "Article text.`n`n### Post navigation`n`n« Previous Post"
        Remove-BlogChromeTail -Markdown $md | Should -BeExactly 'Article text.'
    }

    It 'cuts at "Leave a Reply"' {
        $md = "Article text.`n`n### Leave a Reply`n`nΔ"
        Remove-BlogChromeTail -Markdown $md | Should -BeExactly 'Article text.'
    }

    It 'cuts at "Subscribe to Blog Notice"' {
        $md = "Article text.`n`n## Subscribe to Blog Notice`n`nEnter your email address."
        Remove-BlogChromeTail -Markdown $md | Should -BeExactly 'Article text.'
    }

    It 'matches case-insensitively' {
        $md = "Article text.`n`n### SHARE THIS:`n`nchrome"
        Remove-BlogChromeTail -Markdown $md | Should -BeExactly 'Article text.'
    }

    It 'cuts at the EARLIEST marker when several are present' {
        $md = "Article text.`n`n### Leave a Reply`n`nblah`n`n### Share this:`n`nmore chrome"
        Remove-BlogChromeTail -Markdown $md | Should -BeExactly 'Article text.'
    }

    It 'reproduces the t/4556 AC1 blog post: sidebar video captions and archive link titles are removed' {
        $md = @'
Something big is happening. What happens next depends on whether we meet it with fear, or calm skepticism.

Ralph Losey Copyright 2026 -- All Rights Reserved

### Share this:

- [X](url)

### Like this:

<span class="button">Like</span>

### *Related*

<figcaption>Was Rene Descartes Wrong? Do the new reasoning AIs that think have being?</figcaption>

- ## Subscribe to Blog Notice

  Enter your email address to subscribe.

- Search

<figcaption>List of ALL of EDRM-Losey 'Echoes of AI' Podcasts</figcaption>
'@
        $got = Remove-BlogChromeTail -Markdown $md
        $got | Should -Match 'Ralph Losey Copyright 2026'
        $got | Should -Not -Match 'Rene Descartes'
        $got | Should -Not -Match 'Echoes of AI'
        $got | Should -Not -Match 'Subscribe to Blog Notice'
    }

    It 'leaves markdown with an empty string unchanged' {
        Remove-BlogChromeTail -Markdown '' | Should -BeExactly ''
    }
}

Describe 'Remove-BlogChromeTail corpus prevalence (t/4564 AC)' -Tag 'ingestion' {
    BeforeAll {
        Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force -WarningAction SilentlyContinue
    }

    It 'reports how many existing snapshots carry blog-chrome markers (informational, not a pass/fail gate)' {
        $sourcesDir = $null
        try { $sourcesDir = InModuleScope AITriad { Get-SourcesDir } } catch { $sourcesDir = $null }
        if (-not $sourcesDir -or -not (Test-Path $sourcesDir)) {
            Set-ItResult -Skipped -Because 'no ai-triad-sources checkout available in this environment'
            return
        }
        $markers = 'Share this:', 'Post navigation', 'Leave a Reply', 'Subscribe to Blog Notice'
        $pattern = ($markers | ForEach-Object { [regex]::Escape($_) }) -join '|'
        $snapshots = Get-ChildItem -Path $sourcesDir -Filter 'snapshot.md' -Recurse -File
        $hits = @($snapshots | Where-Object { (Get-Content -Raw -LiteralPath $_.FullName) -match $pattern })
        Write-Host "Remove-BlogChromeTail corpus prevalence: $($hits.Count) of $($snapshots.Count) snapshots carry a blog-chrome marker." -ForegroundColor Yellow
        $true | Should -BeTrue
    }
}
