# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Import-AITriadDocument {
    <#
    .SYNOPSIS
        AI Triad document ingestion.
    .DESCRIPTION
        Ingests a document into the AI Triad repository.

        What this function does:
            0. Refuses a duplicate: the same trusted source URL (checked before download) or
               the same content (content_sha256 of the snapshot, checked before anything is
               written). A matching title or raw file name only warns (t/4337).
            1. Generates a stable doc-id slug from the title/URL.
            2. Creates sources/<doc-id>/raw/ and saves the original file.
            3. Converts to Markdown snapshot (sources/<doc-id>/snapshot.md).
            4. Creates sources/<doc-id>/metadata.json with summary_status: pending.
            5. Optionally triggers Wayback Machine save (fire-and-forget).
            6. Returns the doc-id for use in follow-up commands.
    .PARAMETER Url
        URL of web article to ingest.
    .PARAMETER File
        Path to a local PDF/DOCX/HTML file to ingest.
    .PARAMETER Inbox
        Process all files in sources/_inbox/.
    .PARAMETER Pov
        One or more POV tags: accelerationist, safetyist, skeptic, cross-cutting.
    .PARAMETER Topic
        One or more topic tags.
    .PARAMETER SkipWayback
        Skip the Wayback Machine archival submission.
    .PARAMETER NoSummaryQueue
        Do not mark the document for AI summarisation.
    .PARAMETER SameAs
        Doc id of an existing source this document is a reprint of (the same work at another
        outlet, with its own URL or text). Written as metadata same_as, so the source index
        groups the two (docs/specs/source-identity.md). It does not bypass duplicate detection.
    .PARAMETER ParentDocId
        Doc id of an existing source this document is a deliberate part of. Written as metadata
        parent_doc_id. It does not bypass duplicate detection.
    .PARAMETER Force
        No longer bypasses duplicate detection (t/4337). It used to, and that minted -N copies
        of documents already in the corpus. A document with the same content (content_sha256)
        or the same trusted source URL as an existing source is always refused; use -SameAs or
        -ParentDocId to record a deliberate relationship instead.
    .PARAMETER SkipAiMeta
        Skip the AI metadata-enrichment step.
    .PARAMETER Model
        AI model to use for metadata enrichment and summarization.
        Supports Gemini, Claude, and Groq backends.
        Default: gemini-3.5-flash-lite
    .PARAMETER Temperature
        Sampling temperature (0.0-1.0) passed to summarization.
        Lower values produce more deterministic output.
        Default: 0.1
    .EXAMPLE
        Import-AITriadDocument -Url 'https://example.com/article' -Pov accelerationist, skeptic
    .EXAMPLE
        Import-AITriadDocument -Inbox
    .EXAMPLE
        Import-AITriadDocument -File 'path/to/file.pdf' -Pov skeptic
    .NOTES
        Set the backend-specific env var for the model (GEMINI_API_KEY,
        ANTHROPIC_API_KEY, GROQ_API_KEY, ...) for metadata enrichment.
        AI_API_KEY is a fallback for gemini models only.
    .LINK
        Show-AITriadHelp
    .LINK
        Save-AITSource
    .LINK
        Find-AITSource
    .LINK
        Get-AITSource
    .LINK
        Update-AITSourceIndex
    .LINK
        Get-IngestionPriority
    .LINK
        Get-ImportReport
    #>
    [CmdletBinding(DefaultParameterSetName = 'ByUrl')]
    param(
        [Parameter(ParameterSetName = 'ByUrl', Mandatory)]
        [string]$Url,

        [Parameter(ParameterSetName = 'ByFile', Mandatory)]
        [ValidateScript({ Test-Path $_ })]
        [string]$File,

        [Parameter(ParameterSetName = 'ByInbox', Mandatory)]
        [switch]$Inbox,

        [Parameter(ParameterSetName = 'ByUrl')]
        [Parameter(ParameterSetName = 'ByFile')]
        [ValidateSet('accelerationist', 'safetyist', 'skeptic', 'cross-cutting', 'situations')]
        [string[]]$Pov = @(),

        [Parameter(ParameterSetName = 'ByUrl')]
        [Parameter(ParameterSetName = 'ByFile')]
        [string[]]$Topic = @(),

        [Parameter(ParameterSetName = 'ByUrl')]
        [Parameter(ParameterSetName = 'ByFile')]
        [string]$SameAs,

        [Parameter(ParameterSetName = 'ByUrl')]
        [Parameter(ParameterSetName = 'ByFile')]
        [string]$ParentDocId,

        [switch]$SkipWayback,

        [switch]$NoSummaryQueue,

        [switch]$SkipAiMeta,

        [switch]$Force,

        [switch]$NoSummarize,

        [ValidateScript({ Test-AIModelId $_ })]
        [ArgumentCompleter({ param($cmd, $param, $word) $script:ValidModelIds | Where-Object { $_ -like "$word*" } })]
        [Alias('GeminiModel')]
        [string]$Model = (Get-AITierModel -Tier basic),

        [ValidateRange(0.0, 1.0)]
        [double]$Temperature = 0.1
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    # -- Paths ----------------------------------------------------------------
    $SourcesDir = Get-SourcesDir
    $InboxDir   = Join-Path $SourcesDir '_inbox'

    # -- AI API key (read once; absence is non-fatal) -------------------------
    # Backend from ai-models.json, never guessed. Only presence is checked here: Get-AIMetadata gets no
    # key, so Invoke-AIApi resolves it for the registry backend (t/4087).
    $AIKeyStatus = Get-AIModelKeyStatus -Model $Model -ApiKey ''

    # -- Source identity index (t/4337) ---------------------------------------
    # Built once per invocation on first use and extended after every ingest, so a batch (-Inbox)
    # also catches duplicates within itself. A holder object, because inner functions cannot
    # assign to this scope's variables.
    $IdentityIndexHolder = @{ Value = $null }
    $GetIdentityIndex = {
        if ($null -eq $IdentityIndexHolder.Value) { $IdentityIndexHolder.Value = Get-SourceIdentityIndex -SourcesDir $SourcesDir }
        $IdentityIndexHolder.Value
    }

    if ($SameAs -and $ParentDocId) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal      'Ingest document' `
            -Problem   '-SameAs and -ParentDocId were both given; a document is either a reprint of another or a part of one' `
            -Location  'Import-AITriadDocument' `
            -NextSteps @('Use -SameAs <docId> for a reprint of the same document at another outlet', 'Use -ParentDocId <docId> for a deliberate part of a larger document'))
    }
    foreach ($Link in @(@{ Name = '-SameAs'; Value = $SameAs }, @{ Name = '-ParentDocId'; Value = $ParentDocId })) {
        if ($Link.Value -and -not (& $GetIdentityIndex).Ids.Contains($Link.Value)) {
            throw (New-ActionableError -AsErrorRecord `
                -Goal      'Ingest document' `
                -Problem   "$($Link.Name) '$($Link.Value)' is not an existing source document under $SourcesDir" `
                -Location  'Import-AITriadDocument' `
                -NextSteps @("Find the doc id with: Find-AITSource <words from its title>", "Pass the exact id, e.g. $($Link.Name) 'some-title-2026'"))
        }
        # A link to a marked copy still works (the copy resolves to its canonical doc), but the
        # canonical is the doc to name (t/4337 C1, spec 6.2).
        if ($Link.Value -and (& $GetIdentityIndex).Marked.ContainsKey($Link.Value)) {
            Write-Warning "Import-AITriadDocument: $($Link.Name) '$($Link.Value)' is marked duplicate_of '$((& $GetIdentityIndex).Marked[$Link.Value])'; consider linking to that document instead."
        }
    }

    # =========================================================================
    # Inner function — called once per document
    # =========================================================================
    function Invoke-IngestDocument {
        [CmdletBinding()]
        param(
            [string]  $SourceUrl   = '',
            [string]  $SourceFile  = '',
            [string[]]$PovTags     = @(),
            [string[]]$TopicTags   = @()
        )

        # -- Early duplicate check (t/4337): same trusted URL refuses, same raw file name warns --
        # Runs before download or conversion. The content check runs once the snapshot is built.
        $IncomingName = if ($SourceFile) { [System.IO.Path]::GetFileName($SourceFile) } else { '' }
        Assert-NoSourceDuplicate -Index (& $GetIdentityIndex) -Url $SourceUrl -RawFileName $IncomingName -ForceRequested:$Force

        $RawContent   = $null
        $MarkdownText = ''
        $Title        = ''
        $Authors      = @()
        $SourceType   = 'unknown'
        $RawExtension = ''
        $IsUrl        = -not [string]::IsNullOrWhiteSpace($SourceUrl)

        if ($IsUrl) {
            # -- URL ingestion ------------------------------------------------
            Write-Step "Fetching URL: $SourceUrl"
            $SourceType   = 'web_article'
            $RawExtension = '.html'

            # Fetch via the shared Node fetch-CLI (t/3310) — Node's undici passes WAFs that block the
            # PowerShell client (t/3306); SSRF-guarded. Convert-only PS: dispatch on Content-Type
            # (authoritative), which unifies the HTML/PDF branches and closes the PDF-over-WAF gap.
            $Fetch = Get-UrlViaSharedFetcher -Url $SourceUrl -TimeoutMs 60000
            try {
                if ($Fetch.Status -ne 200 -or $Fetch.Error) {
                    $code = if ($null -ne $Fetch.Status) { $Fetch.Status } else { 'transport-failure' }
                    $detail = if ($Fetch.Error) { "; $($Fetch.Error)" } else { '' }
                    throw (New-ActionableError -PassThru -ErrorType 'FetchFailed' `
                        -Goal "Ingest document from $SourceUrl" `
                        -Problem "Could not fetch '$SourceUrl' (status: $code$detail)." `
                        -Location 'Import-AITriadDocument' `
                        -NextSteps @(
                            'The shared fetcher (Node) already passes most WAFs; a persistent failure usually means the URL is unreachable, access-blocked, or SSRF-guarded',
                            'Download the document and import it as a local file with -SourceFile instead'
                        ))
                }

                if ($Fetch.ContentType -match 'application/pdf') {
                    Write-OK "Fetched PDF ($($Fetch.ContentType))"
                    $RawContent   = [System.IO.File]::ReadAllBytes($Fetch.OutPath)
                    $MarkdownText = ConvertFrom-Pdf -PdfPath $Fetch.OutPath
                    $RawExtension = '.pdf'
                    $SourceType   = 'pdf'
                    $Title        = $SourceUrl
                }
                else {
                    $HtmlContent  = [System.IO.File]::ReadAllText($Fetch.OutPath, [System.Text.Encoding]::UTF8)
                    Write-OK "Fetched $([int]$HtmlContent.Length) characters ($($Fetch.ContentType))"
                    $Meta    = Get-HtmlMeta -Html $HtmlContent
                    if ($Meta.Title) { $Title = $Meta.Title } else { $Title = $SourceUrl }
                    $Authors = $Meta.Author
                    $MarkdownText = Remove-BlogChromeTail -Markdown (ConvertFrom-Html -Html $HtmlContent -SourceUrl $SourceUrl)
                    $RawContent   = $HtmlContent
                    $RawExtension = '.html'
                    $SourceType   = 'web_article'
                }
            } finally {
                if ($Fetch -and $Fetch.OutPath -and (Test-Path -LiteralPath $Fetch.OutPath)) {
                    Remove-Item -LiteralPath $Fetch.OutPath -Force -ErrorAction SilentlyContinue
                }
            }
        } else {
            # -- Local file ingestion -----------------------------------------
            $ResolvedFile = Resolve-Path $SourceFile
            $Ext = [System.IO.Path]::GetExtension($ResolvedFile).ToLower()
            $RawExtension = $Ext

            Write-Step "Ingesting file: $ResolvedFile"
            $RawContent = [System.IO.File]::ReadAllBytes($ResolvedFile)

            switch ($Ext) {
                '.pdf' {
                    $SourceType   = 'pdf'
                    $MarkdownText = ConvertFrom-Pdf -PdfPath $ResolvedFile
                    $Title = [System.IO.Path]::GetFileNameWithoutExtension($ResolvedFile) -replace '[-_]', ' '
                }
                { $_ -in '.docx', '.doc' } {
                    $SourceType   = 'docx'
                    $MarkdownText = ConvertFrom-Docx -DocxPath $ResolvedFile
                    $Title        = [System.IO.Path]::GetFileNameWithoutExtension($ResolvedFile) -replace '[-_]', ' '
                }
                { $_ -in '.html', '.htm' } {
                    $SourceType   = 'web_article'
                    $HtmlContent  = [System.IO.File]::ReadAllText($ResolvedFile)
                    $Meta         = Get-HtmlMeta -Html $HtmlContent
                    if ($Meta.Title) { $Title = $Meta.Title } else {
                        $Title = [System.IO.Path]::GetFileNameWithoutExtension($ResolvedFile) }
                    $Authors      = $Meta.Author
                    # Prefer markitdown for HTML (better semantic extraction)
                    $MidMd = ConvertFrom-MarkItDown -FilePath $ResolvedFile
                    if ($MidMd) { $MarkdownText = $MidMd } else { $MarkdownText = ConvertFrom-Html -Html $HtmlContent }
                    # markitdown renders blog-chrome widgets as plain markdown instead of dropping
                    # them (ConvertFrom-Html's own tag-level strip only fires on real HTML), t/4564.
                    $MarkdownText = Remove-BlogChromeTail -Markdown $MarkdownText
                }
                { $_ -in '.pptx', '.ppt' } {
                    $SourceType   = 'presentation'
                    $MarkdownText = ConvertFrom-Office -FilePath $ResolvedFile
                    $Title        = [System.IO.Path]::GetFileNameWithoutExtension($ResolvedFile) -replace '[-_]', ' '
                }
                { $_ -in '.xlsx', '.xls', '.csv' } {
                    $SourceType   = 'spreadsheet'
                    $MarkdownText = ConvertFrom-Office -FilePath $ResolvedFile
                    $Title        = [System.IO.Path]::GetFileNameWithoutExtension($ResolvedFile) -replace '[-_]', ' '
                }
                { $_ -in '.epub' } {
                    $SourceType   = 'ebook'
                    $MarkdownText = ConvertFrom-Office -FilePath $ResolvedFile
                    $Title        = [System.IO.Path]::GetFileNameWithoutExtension($ResolvedFile) -replace '[-_]', ' '
                }
                { $_ -in '.md', '.txt' } {
                    if ($Ext -eq '.md') { $SourceType = 'markdown' } else { $SourceType = 'plaintext' }
                    $MarkdownText = [System.IO.File]::ReadAllText($ResolvedFile)
                    $Title        = [System.IO.Path]::GetFileNameWithoutExtension($ResolvedFile) -replace '[-_]', ' '
                    $H1Match = [regex]::Match($MarkdownText, '(?m)^#\s+(.+)$')
                    if ($H1Match.Success) { $Title = $H1Match.Groups[1].Value.Trim() }
                }
                Default {
                    # Try markitdown as a last-resort universal converter
                    $MidMd = ConvertFrom-MarkItDown -FilePath $ResolvedFile
                    if ($MidMd) {
                        $SourceType   = 'document'
                        $MarkdownText = $MidMd
                        $Title        = [System.IO.Path]::GetFileNameWithoutExtension($ResolvedFile) -replace '[-_]', ' '
                    } else {
                        Write-Warn "Unsupported file type '$Ext' — storing raw, no Markdown conversion"
                        $SourceType   = 'unknown'
                        $MarkdownText = "# $(Split-Path $ResolvedFile -Leaf)`n`n[Binary file — no text extraction available]"
                        $Title        = [System.IO.Path]::GetFileNameWithoutExtension($ResolvedFile)
                    }
                }
            }

            Write-OK "Read $($RawContent.Length) bytes from file"
        }

        # -- Gemini metadata enrichment ---------------------------------------
        $AiMeta = $null

        if (-not $SkipAiMeta -and $AIKeyStatus.HasKey) {
            try {
                # The model sees the text with inline base64 images stripped; the snapshot written
                # below stays as converted, because content_sha256 covers it (t/4385).
                $AiMeta = Get-AIMetadata `
                    -MarkdownText  (Remove-MarkdownDataUri -Text ([string]$MarkdownText)).Text `
                    -SourceUrl     $SourceUrl `
                    -FallbackTitle $Title `
                    -Model         $Model
            } catch {
                Write-Warn "AI enrichment threw an exception — continuing with heuristics: $_"
                $AiMeta = $null
            }
        } elseif ($SkipAiMeta) {
            Write-Info "Skipping AI enrichment (-SkipAiMeta)"
        } else {
            Write-Warn "No API key found for the $($AIKeyStatus.Backend) backend — metadata enrichment skipped. Set $($AIKeyStatus.EnvHint)."
        }

        # Merge AI results with heuristic values and user-supplied flags
        if ($null -ne $AiMeta) {
            if (-not [string]::IsNullOrWhiteSpace($AiMeta.title)) { $Title = $AiMeta.title }
            $AiAuthors = @($AiMeta.authors | Where-Object { $_ })
            if ($AiAuthors.Count -gt 0) { $Authors = $AiAuthors }

            $AiPovTags = @($AiMeta.pov_tags | Where-Object { $_ })
            if ($PovTags.Count -eq 0 -and $AiPovTags.Count -gt 0) {
                $PovTags = $AiPovTags
                Write-Info "POV tags from AI: $($PovTags -join ', ')"
            } elseif ($PovTags.Count -gt 0) {
                Write-Info "POV tags from -Pov flag (AI suggestion ignored): $($PovTags -join ', ')"
            }

            $MergedTopics = @(@($TopicTags) + @($AiMeta.topic_tags) |
                Select-Object -Unique |
                Where-Object { $_ })
            $TopicTags = $MergedTopics
            if ($TopicTags.Count -gt 0) {
                Write-Info "Topic tags (merged): $($TopicTags -join ', ')"
            }
        }

        # -- Normalize markdown (encoding artifacts, ligatures, etc.) ----------
        $MarkdownText = Repair-Markdown -Text $MarkdownText

        # -- Strip vertical-text artifacts (ArXiv watermarks, rotated margin text) --
        $MarkdownText = Remove-VerticalTextArtifact -Markdown $MarkdownText

        # -- Build the snapshot (provenance header) ---------------------------
        $FinalMarkdown = Add-SnapshotHeader `
            -Markdown    $MarkdownText `
            -Title       $Title `
            -SourceUrl   $SourceUrl `
            -SourceType  $SourceType `
            -CapturedAt  (Get-Date -Format 'yyyy-MM-dd')

        # -- Content duplicate check (t/4337), BEFORE anything is written -----
        # content_sha256 is over the snapshot text exactly as written (docs/specs/source-identity.md 1.1).
        $ContentHash = Get-SourceContentHash -Text $FinalMarkdown
        Assert-NoSourceDuplicate -Index (& $GetIdentityIndex) -ContentHash $ContentHash -Title $Title -ForceRequested:$Force

        # -- Generate doc-id --------------------------------------------------
        # A -N suffix now only ever means a genuine slug collision with DIFFERENT content.
        $SlugSource = $Title
        if ([string]::IsNullOrWhiteSpace($SlugSource)) {
            if ($IsUrl) { $SlugSource = $SourceUrl } else { $SlugSource = [System.IO.Path]::GetFileNameWithoutExtension($SourceFile) }
        }
        $BaseSlug = New-Slug -Text $SlugSource
        $DocId    = Resolve-DocId -BaseSlug $BaseSlug

        Write-OK "Doc ID: $DocId"

        # -- Create directory structure ---------------------------------------
        $DocDir = Join-Path $SourcesDir $DocId
        $RawDir = Join-Path $DocDir 'raw'
        New-Item -ItemType Directory -Path $RawDir -Force | Out-Null
        Write-OK "Created: sources/$DocId/"

        # -- Save raw file ----------------------------------------------------
        if ($IsUrl) {
            $RawFilename = 'original' + $RawExtension
        } else {
            $RawFilename = [System.IO.Path]::GetFileName($SourceFile)
        }
        $RawPath = Join-Path $RawDir $RawFilename

        if ($RawContent -is [byte[]]) {
            # Use .NET directly — Set-Content -AsByteStream is PS 6+ only, and
            # WriteAllBytes is symmetric with the ReadAllBytes used to load it.
            [System.IO.File]::WriteAllBytes($RawPath, $RawContent)
        } else {
            Write-Utf8NoBom -Path $RawPath -Value $RawContent
        }
        Write-OK "Raw file saved: raw/$RawFilename"

        # -- Write snapshot.md ------------------------------------------------
        $SnapshotPath = Join-Path $DocDir 'snapshot.md'
        Write-Utf8NoBom -Path $SnapshotPath -Value $FinalMarkdown 
        Write-OK "Snapshot written: snapshot.md ($([int]$FinalMarkdown.Length) chars)"

        # -- Write metadata.json ----------------------------------------------
        $Metadata = New-Metadata `
            -DocId       $DocId `
            -Title       $Title `
            -DocumentUrl $SourceUrl `
            -Author      $Authors `
            -SourceType  $SourceType `
            -PovTag      $PovTags `
            -TopicTag    $TopicTags

        if ($null -ne $AiMeta) {
            if ($AiMeta.date_published) {
                $ValidatedDate = $AiMeta.date_published
                [datetime]$ParsedDate = [datetime]::MinValue
                if ([datetime]::TryParse($ValidatedDate, [ref]$ParsedDate)) {
                    $Now = Get-Date
                    $DaysAhead = ($ParsedDate - $Now).Days
                    if ($DaysAhead -gt 30) {
                        Write-Warn "date_published '$ValidatedDate' is $DaysAhead days in the future — likely extraction error, clearing"
                        $ValidatedDate = $null
                    } elseif ($DaysAhead -gt 0) {
                        Write-Info "Pre-print: publication date $ValidatedDate is $DaysAhead day(s) ahead of import"
                    }
                    if ($ParsedDate.Month -eq 1 -and $ParsedDate.Day -eq 1) {
                        Write-Info "Generic date detected ($ValidatedDate) — may be incomplete metadata"
                    }
                }
                if ($ValidatedDate) {
                    $Metadata['date_published'] = $ValidatedDate
                    $Metadata['source_time']    = $ValidatedDate
                }
            }
            if ($AiMeta.one_liner) { $Metadata['one_liner'] = $AiMeta.one_liner }
        }

        # Source-identity fields (docs/specs/source-identity.md section 0, t/4337).
        if ($ContentHash) { $Metadata['content_sha256'] = $ContentHash }
        if ($SameAs)      { $Metadata['same_as']        = $SameAs }
        if ($ParentDocId) { $Metadata['parent_doc_id']  = $ParentDocId }

        $MetaPath = Join-Path $DocDir 'metadata.json'
        $Metadata | ConvertTo-Json -Depth 5 | Write-Utf8NoBom -Path $MetaPath
        Write-OK "Metadata written: metadata.json"

        # Later documents in the same run (e.g. -Inbox) are checked against this one too.
        Add-SourceIdentityIndexEntry -Index (& $GetIdentityIndex) -DocDir $DocDir

        # -- Rebuild source index ---------------------------------------------
        try { Update-AITSourceIndex -Quiet } catch { Write-Verbose "Index rebuild skipped: $_" }

        # -- Summary queue ----------------------------------------------------
        if (-not $NoSummaryQueue) {
            Add-ToSummaryQueue -DocId $DocId
        }

        # -- Wayback Machine --------------------------------------------------
        if ($IsUrl -and -not $SkipWayback) {
            Submit-ToWaybackMachine -TargetUrl $SourceUrl
        }

        # -- Done -------------------------------------------------------------
        Write-Host ''
        Write-Host "  ════════════════════════════════════════════════" -ForegroundColor Cyan
        Write-Host "  Ingested: $DocId" -ForegroundColor Green
        Write-Host "  ════════════════════════════════════════════════" -ForegroundColor Cyan
        Write-Host "  sources/$DocId/" -ForegroundColor White
        Write-Host "    ├── raw/$RawFilename" -ForegroundColor Gray
        Write-Host "    ├── snapshot.md" -ForegroundColor Gray
        Write-Host "    └── metadata.json  (summary_status: pending)" -ForegroundColor Gray
        Write-Host ''

        return $DocId
    }

    # =========================================================================
    # Dispatch based on parameter set
    # =========================================================================
    switch ($PSCmdlet.ParameterSetName) {

        'ByUrl' {
            $DocId = Invoke-IngestDocument `
                -SourceUrl   $Url `
                -PovTags     $Pov `
                -TopicTags   $Topic

            if (-not $NoSummarize -and $DocId) {
                Write-Step "Running POV summarization for $DocId"
                Invoke-BatchSummary -DocId $DocId -Model $Model -Temperature $Temperature
            }
        }

        'ByFile' {
            $ResolvedFile = (Resolve-Path -LiteralPath $File).Path
            $ResolvedInbox = if (Test-Path $InboxDir) { (Resolve-Path -LiteralPath $InboxDir).Path } else { $null }
            $FromInbox = $ResolvedInbox -and $ResolvedFile.StartsWith($ResolvedInbox, [System.StringComparison]::OrdinalIgnoreCase)

            $DocId = Invoke-IngestDocument `
                -SourceFile  $ResolvedFile `
                -PovTags     $Pov `
                -TopicTags   $Topic

            $SummarizeOk = $true
            if (-not $NoSummarize -and $DocId) {
                Write-Step "Running POV summarization for $DocId"
                try {
                    Invoke-BatchSummary -DocId $DocId -Model $Model -Temperature $Temperature
                } catch {
                    $SummarizeOk = $false
                    Write-Fail "Summarization failed for $DocId`: $_"
                    if ($FromInbox) { Write-Info "File left in inbox for retry." }
                    throw
                }
            }

            # If the source lives under sources/_inbox/, clean it up after a fully
            # successful ingest+summarize — symmetrical with the -Inbox branch.
            if ($FromInbox -and $DocId -and $SummarizeOk) {
                $SidecarPath = $ResolvedFile + '.meta.json'
                if (Test-Path $ResolvedFile) { Remove-Item $ResolvedFile -Force }
                if (Test-Path $SidecarPath)  { Remove-Item $SidecarPath -Force }
                Write-OK "Removed inbox copy: $(Split-Path $ResolvedFile -Leaf)"
            }
        }

        'ByInbox' {
            if (-not (Test-Path $InboxDir)) {
                throw (New-ActionableError -AsErrorRecord `
                    -Goal      'Process inbox documents' `
                    -Problem   "Inbox directory not found: $InboxDir" `
                    -Location  'Import-AITriadDocument -Inbox' `
                    -NextSteps @(
                        "Create the inbox directory: New-Item -ItemType Directory -Path '$InboxDir'"
                        'Drop files into sources/_inbox/ and re-run with -Inbox'
                    ))
            }

            # Skip VCS placeholders, OS-metadata junk (e.g. macOS .DS_Store /
            # AppleDouble ._* files, Windows Thumbs.db/desktop.ini), and the
            # *.meta.json sidecars — none of these are documents to ingest.
            # Without this, .DS_Store falsely "matches" an existing source via
            # filename in Find-ExistingSource and gets skipped as a duplicate.
            $InboxJunk = @('.gitkeep', '.DS_Store', 'Thumbs.db', 'desktop.ini')
            $InboxFiles = @(Get-ChildItem -Path $InboxDir -File |
                Where-Object {
                    $InboxJunk -notcontains $_.Name -and
                    $_.Name -notlike '.*' -and
                    $_.Name -notlike '*.meta.json'
                })

            if ($InboxFiles.Count -eq 0) {
                Write-Warn "Inbox is empty: $InboxDir"
                Write-Info "Drop files into sources/_inbox/ and re-run with -Inbox"
                return
            }

            Write-Step "Processing $($InboxFiles.Count) file(s) from inbox"
            $IngestedIds = @()
            # Track inbox files for deferred cleanup — only remove after full pipeline succeeds
            $InboxCleanup = @{}  # DocId → @{ File = path; Sidecar = path }

            foreach ($InboxFile in $InboxFiles) {
                Write-Host ''
                Write-Host "  Processing: $($InboxFile.Name)" -ForegroundColor White
                Write-Host "  $('─' * 48)" -ForegroundColor DarkGray

                $SidecarPath = $InboxFile.FullName + '.meta.json'
                $SidecarPov  = @()
                $SidecarTopic= @()

                if (Test-Path $SidecarPath) {
                    try {
                        $Sidecar     = Get-Content $SidecarPath -Raw | ConvertFrom-Json
                        if ($Sidecar.pov_tags)   { $SidecarPov   = $Sidecar.pov_tags }   else { $SidecarPov   = @() }
                        if ($Sidecar.topic_tags) { $SidecarTopic = $Sidecar.topic_tags } else { $SidecarTopic = @() }
                        Write-Info "Sidecar found: pov=$($SidecarPov -join ',')  topics=$($SidecarTopic -join ',')"
                    } catch {
                        Write-Warn "Sidecar parse failed, ignoring: $SidecarPath"
                    }
                }

                try {
                    $DocId = Invoke-IngestDocument `
                        -SourceFile $InboxFile.FullName `
                        -PovTags    $SidecarPov `
                        -TopicTags  $SidecarTopic

                    $IngestedIds += $DocId
                    $InboxCleanup[$DocId] = @{
                        File    = $InboxFile.FullName
                        Sidecar = $SidecarPath
                    }

                } catch {
                    Write-Fail "Failed to ingest $($InboxFile.Name): $_"
                    Write-Verbose "Stack trace: $($_.ScriptStackTrace)"
                    Write-Info "File left in inbox for retry."
                }
            }

            Write-Host ''
            Write-Host "  Inbox complete. Ingested $($IngestedIds.Count) document(s):" -ForegroundColor Cyan
            foreach ($id in $IngestedIds) {
                Write-Host "    • $id" -ForegroundColor Green
            }
            Write-Host ''

            if (-not $NoSummarize -and $IngestedIds.Count -gt 0) {
                foreach ($id in $IngestedIds) {
                    Write-Step "Running POV summarization for $id"
                    try {
                        Invoke-BatchSummary -DocId $id -Model $Model -Temperature $Temperature
                    } catch {
                        Write-Fail "Summarization failed for $id`: $_"
                        Write-Info "File left in inbox for retry."
                        $null = $InboxCleanup.Remove($id)
                    }
                }
            }

            # -- Remove inbox files only for fully successful documents ----------
            foreach ($entry in $InboxCleanup.GetEnumerator()) {
                $paths = $entry.Value
                if (Test-Path $paths.File) { Remove-Item $paths.File -Force }
                if (Test-Path $paths.Sidecar) { Remove-Item $paths.Sidecar -Force }
            }
        }
    }
}
