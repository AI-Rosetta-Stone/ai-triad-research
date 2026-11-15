# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function New-OpEd {
    <#
    .SYNOPSIS
        Generates a publication-ready op-ed (guest essay) on a topic or URL,
        written in the authentic voice of one of the AI Triad POV camps.
    .DESCRIPTION
        New-OpEd assembles a system prompt from two sources — the OpEd Project /
        Harvard Kennedy School structural blueprint (lede + news hook, early
        thesis, two-to-three evidence pillars, a "To Be Sure" counterargument,
        and a solution that names specific actors) and the camp's Soul document
        (disposition, rhetorical style, signature move, prose-style and
        voice-hygiene rules, value hierarchy, epistemic stance, and
        anti-patterns) — then asks the model to draft the essay in that voice.

        The subject can be supplied as free text (-Topic) or fetched from a URL
        (-Url), which is converted to Markdown and passed as source material. The
        target length is derived from the chosen -Outlet's editorial limits (or
        set explicitly with -WordCount). Optionally writes a Markdown file
        (-OutputPath).

        The substance is grounded (by default) in the project taxonomy: the POV's
        most topic-relevant BDI nodes (its actual beliefs / desires / intentions)
        and situation-library stress cases are retrieved via the same embedding
        relevance the debate engine uses (Get-RelevantTaxonomyNodes) and injected
        as the positions the essay must argue from — so the op-ed reflects THIS
        project's registered camp, not the model's generic priors. The elements
        used and their relevance scores are returned on the Grounding field, each
        annotated (via a second lightweight AI call that reads the finished essay)
        with a Reflection explaining how and where it is reflected in the draft.
        Pass -VoiceOnly (or set the counts to 0) to write from voice alone; if the
        taxonomy / embeddings / Python are unavailable, retrieval degrades to
        voice-only with a warning rather than failing.

        Prompts are production artifacts: the structural rules live in
        Prompts/op-ed-generation-system.prompt and the task contract in
        Prompts/op-ed-generation-user.prompt; the voice block is built from the
        Soul document at lib/debate/soul-docs/<pov>.soul.json.
    .PARAMETER Topic
        The subject or angle for the essay, as free text. Mandatory in the
        default 'FromTopic' parameter set; optional alongside -Url to steer the
        angle of a fetched source.
    .PARAMETER Url
        A web page to use as source material. Fetched and converted to Markdown
        via Get-OpEdSource (with format detection and readability gate), then
        handed to the model as factual grounding. Mandatory in 'FromUrl'.
    .PARAMETER SourcePrep
        A pre-built SourcePrep object from Get-OpEdSource. Use this in the
        multi-POV orchestrated path so the fetch/convert/gate work happens once
        and is reused per voice. Mandatory in 'FromPrep'.
    .PARAMETER Pov
        The camp voice to write in. One of accelerationist, safetyist, skeptic
        (short forms acc / saf / skp accepted). Loads the matching Soul document.
    .PARAMETER Outlet
        Target publication category. Sets the default word-count band and
        audience/tone guidance from real editorial specifications. Overridden by
        an explicit -WordCount.

        The valid set and every outlet's data are read from lib/oped/outlets.json
        (the single source of truth shared with the TS renderer, t/3819) on EVERY
        call — not cached for the session, confirmed empirically (t/3863). Editing
        the file takes effect on your very next call with no module reload needed.
        A missing or malformed outlets.json is refused LOUDLY at parameter binding
        (before this cmdlet's body ever runs) naming the file and the parse/schema
        failure, rather than silently falling back to a stale or empty set.
    .PARAMETER WordCount
        Explicit target length (300-2000 words). Overrides the -Outlet default.
    .PARAMETER NewsHook
        The timely peg (a pending vote, ruling, report, or milestone) that
        justifies publishing now. Strongly recommended — op-eds without a news
        hook are routinely rejected. If omitted, the model constructs a plausible
        hook and the draft should be re-checked against real current events.
    .PARAMETER Thesis
        An explicit stance to argue. If omitted, the model derives a thesis
        consistent with the camp's value hierarchy.
    .PARAMETER AuthorBio
        Author credentials for the authority line / bio (e.g.,
        'a health economist at ...').
    .PARAMETER OutputPath
        If supplied, writes the headline and body to a Markdown file
        at this path (UTF-8, no BOM).
    .PARAMETER Model
        AI model to use. Defaults to gemini-3.7-flash — a deliberate step up from
        the flash-lite enrichment default because long-form persuasive prose needs
        a stronger tier; a GA model is preferred over a preview as a default. For
        maximum polish, pass -Model gemini-3.1-pro-preview.
    .PARAMETER Temperature
        Sampling temperature. Defaults to 0.8 for creative prose.
    .PARAMETER VoiceOnly
        Skip taxonomy grounding and write from the camp voice + general knowledge
        alone. By default the essay is grounded in retrieved BDI nodes and
        situations.
    .PARAMETER MaxGroundingNodes
        Maximum POV BDI nodes to retrieve and inject as registered positions
        (0-40, default 12). 0 disables BDI grounding.
    .PARAMETER MaxSituations
        Maximum situation-library stress cases to retrieve and inject (0-15,
        default 3). 0 disables situation grounding.
    .PARAMETER PovTag
        NOT IMPLEMENTED. Tagged op-eds are generated through the app/server path
        only (SO e/254#6 cond 2a) — passing this throws an ActionableError rather
        than silently ignoring the tag or diverging from the TS implementation's
        included/excludedUntagged counts.
    .PARAMETER TagMode
        NOT IMPLEMENTED. See -PovTag.
    .OUTPUTS
        [PSCustomObject] with Headline, Subtitle, Body, WordCount, Pov,
        Outlet, Model, Backend, Grounding, StanceRelationship, SourceFormat,
        SourceExtractionTool, ReadableWords, ReadableRatio, and SourceUnderstanding.
        Grounding is an array of taxonomy elements injected (Id, Type [bdi|situation],
        POV, Category, Label, RelevanceScore, Reflection). SourceUnderstanding is
        the CL source_brief object (thesis/author/actor_type/stance/
        primary_recommendations/key_claims/readable) or null if no source was supplied.
    .EXAMPLE
        New-OpEd -Topic 'Mandatory pre-deployment audits for frontier AI models' `
            -Pov safetyist -Outlet WashingtonPost `
            -NewsHook 'the Senate AI oversight bill scheduled for a floor vote next week'

        Drafts an 800-word Washington Post-length guest essay in the Safetyist
        voice, grounded in the Safetyist camp's most relevant belief/desire/
        intention nodes and situations.
    .EXAMPLE
        $oped = New-OpEd -Topic 'Open-weight models and biosecurity' -Pov skeptic
        $oped.Grounding | Format-Table Id, Category, RelevanceScore, Reflection

        Inspects which taxonomy nodes and situations grounded the essay, how
        relevant each was, and how/where each is reflected in the draft.
    .EXAMPLE
        New-OpEd -Url 'https://example.com/ai-jobs-report' -Pov accelerationist `
            -Outlet WallStreetJournal -OutputPath ./oped.md

        Fetches the article as source material, writes a WSJ-length essay in the
        Accelerationist voice, and saves it to disk.
    .LINK
        Invoke-AIApi
    .LINK
        Show-TriadDialogue
    #>
    [CmdletBinding(DefaultParameterSetName = 'FromTopic')]
    [OutputType([PSCustomObject])]
    param(
        [Parameter(Mandatory, Position = 0, ParameterSetName = 'FromTopic')]
        [Parameter(Position = 0, ParameterSetName = 'FromUrl')]
        [Parameter(ParameterSetName = 'FromPrep')]
        [ValidateNotNullOrEmpty()]
        [string]$Topic,

        [Parameter(Mandatory, ParameterSetName = 'FromUrl')]
        [ValidateNotNullOrEmpty()]
        [string]$Url,

        [Parameter(Mandatory, ParameterSetName = 'FromPrep')]
        [ValidateNotNullOrEmpty()]
        [PSObject]$SourcePrep,

        [Parameter(Mandatory)]
        [ValidateSet('accelerationist', 'safetyist', 'skeptic', 'acc', 'saf', 'skp')]
        [string]$Pov,

        # t/3863: dynamic set read from lib/oped/outlets.json (t/3861 SSOT) via
        # OutletsSsotValuesGenerator, not a hardcoded literal list. Fails CLOSED —
        # a missing/malformed SSOT throws at parameter binding (see
        # Get-OpEdOutletsData for why). The default reads $script:RepoRoot's
        # defaultOutlet on every call (no caching, t/3863#1), so it is live too.
        [ValidateSet([OutletsSsotValuesGenerator])]
        [string]$Outlet = (Get-OpEdOutletsData).defaultOutlet,

        [ValidateRange(300, 2000)]
        [int]$WordCount,

        [string]$NewsHook = '',

        [string]$Thesis = '',

        [string]$AuthorBio = '',

        [string]$OutputPath,

        [ValidateScript({ Test-AIModelId $_ })]
        [string]$Model = 'gemini-3.7-flash',

        [ValidateRange(0.0, 2.0)]
        [double]$Temperature = 0.8,

        [switch]$VoiceOnly,

        [ValidateRange(0, 40)]
        [int]$MaxGroundingNodes = 12,

        [ValidateRange(0, 15)]
        [int]$MaxSituations = 3,

        # t/3997 (SO e/254#6 cond 2a): accepted ONLY so a caller gets this cmdlet's own
        # ActionableError instead of PowerShell's generic "parameter not found" — never read
        # beyond the refusal check below. PowerShell does not implement tag selection; if it
        # did, the included/excludedUntagged counts would come from two implementations and
        # lose the comparability they exist for (the e/241 hand-mirroring pattern).
        [string]$PovTag,

        [ValidateSet('scope', 'prioritize')]
        [string]$TagMode
    )

    Set-StrictMode -Version Latest

    # t/3997: refuse tag selection immediately, before any other work (soul load, outlet
    # resolution, source fetch) — tagged op-eds are TS-only (app/server path).
    if ($PSBoundParameters.ContainsKey('PovTag') -or $PSBoundParameters.ContainsKey('TagMode')) {
        throw (New-ActionableError -PassThru `
            -Goal 'Generate a tag-scoped op-ed' `
            -Problem "Tagged op-eds are generated through the app/server path only. PowerShell doesn't implement tag selection, so its counts can't diverge (SO e/254#6 condition 2)." `
            -Location 'New-OpEd' `
            -NextSteps 'Use the app or server op-ed generator.')
    }

    # The steps live in Private/NewOpEdSteps.ps1 (t/3910).
    # Shared prompt artifacts live in lib/oped/prompts/ (canonical TS-core location, t/2609).
    $OPedPromptsDir = [System.IO.Path]::GetFullPath((Join-Path $script:ModuleRoot '..\..\lib\oped\prompts'))

    # ── Normalize the POV to its canonical Soul-document name ────────────────
    $PovMap = @{
        acc = 'accelerationist'; accelerationist = 'accelerationist'
        saf = 'safetyist';       safetyist       = 'safetyist'
        skp = 'skeptic';         skeptic         = 'skeptic'
    }
    $PovKey = $PovMap[$Pov.ToLowerInvariant()]

    $Soul       = Read-OpEdSoul -PovKey $PovKey
    $VoiceBlock = Get-OpEdVoiceBlock -Soul $Soul
    $OutletInfo = Resolve-OpEdOutlet -Outlet $Outlet -WordCount $WordCount -HasWordCount:($PSBoundParameters.ContainsKey('WordCount'))

    # ── Source material, then grounding in the camp's registered taxonomy ────
    $Prep          = Resolve-OpEdSourcePrep -ParameterSetName $PSCmdlet.ParameterSetName -SourcePrep $SourcePrep -Url $Url
    $SourceContext = Get-OpEdSourceContext -Prep $Prep -Topic $Topic -TopicBound:($PSBoundParameters.ContainsKey('Topic'))
    $Topic         = $SourceContext.Topic
    $GroundingInfo = Get-OpEdGrounding -PovKey $PovKey -Topic $Topic -NewsHook $NewsHook -Thesis $Thesis `
        -SourceMaterial $SourceContext.SourceMaterial -ParameterSetName $PSCmdlet.ParameterSetName `
        -MaxGroundingNodes $MaxGroundingNodes -MaxSituations $MaxSituations -VoiceOnly:$VoiceOnly
    $Grounding     = $GroundingInfo.Grounding
    $SBrief        = Get-OpEdSourceBrief -Prep $Prep -Model $Model -PromptsDir $OPedPromptsDir

    # ── Draft ─────────────────────────────────────────────────────────────────
    $Prompts = Get-OpEdPromptPair -Soul $Soul -VoiceBlock $VoiceBlock -OutletInfo $OutletInfo -Topic $Topic `
        -NewsHook $NewsHook -Thesis $Thesis -AuthorBio $AuthorBio -SourceMaterial $SourceContext.SourceMaterial `
        -Grounding $GroundingInfo -SBrief $SBrief -PromptsDir $OPedPromptsDir

    # Budget output tokens generously. The default model is a "thinking" model
    # (gemini-3.x pro/flash) whose reasoning tokens are billed against the same
    # output budget — too small a cap starves the visible response and truncates
    # the JSON mid-string (parse then falls back to raw text). Allow ~3 tokens
    # per target word for prose plus a large fixed reserve for reasoning, the
    # optional pitch, and JSON overhead.
    $TargetWords = $OutletInfo.TargetWords
    $MaxTokens = [int]([math]::Ceiling($TargetWords * 3)) + 5000

    Write-Verbose "Generating op-ed: pov='$PovKey' outlet='$Outlet' words=$TargetWords model='$Model' temp=$Temperature"

    $Result = Invoke-OpEdDraft -UserPrompt $Prompts.User -SystemPrompt $Prompts.System -Model $Model `
        -Temperature $Temperature -MaxTokens $MaxTokens
    $Draft  = ConvertFrom-OpEdDraftResponse -Text $Result.Text

    # ── Readability edit pass, word count, reflection ────────────────────────
    $Limits    = Get-OpEdReadabilityLimit -OutletInfo $OutletInfo
    $EditStyle = Get-OpEdEditStyle -OutletInfo $OutletInfo
    $Edit      = Invoke-OpEdReadabilityEdit -Body $Draft.Body -Limits $Limits -Style $EditStyle -Model $Model -MaxTokens $MaxTokens -PromptsDir $OPedPromptsDir
    $FinalBody = $Edit.FinalBody
    $ActualWords = Measure-OpEdWordCount -Text $FinalBody
    Add-OpEdGroundingReflection -Grounding $Grounding -FinalBody $FinalBody -SBrief $SBrief -Model $Model -PromptsDir $OPedPromptsDir

    $PrepField = Get-OpEdPrepField -Prep $Prep
    $Output = [PSCustomObject]@{
        Headline             = $Draft.Headline
        Subtitle             = $Draft.Subtitle
        Body                 = $FinalBody
        WordCount            = $ActualWords
        Pov                  = $PovKey
        Outlet               = $Outlet
        Model                = $Model
        Backend              = $Result.Backend
        Grounding            = $Grounding.ToArray()
        StanceRelationship   = $Draft.StanceRelationship
        SourceFormat         = $PrepField.SourceFormat
        SourceExtractionTool = $PrepField.SourceExtractionTool
        ReadableWords        = $PrepField.ReadableWords
        ReadableRatio        = $PrepField.ReadableRatio
        SourceUnderstanding  = $SBrief
        EditingMeta          = $Edit.EditingMeta
    }

    # ── Optionally write a Markdown file ─────────────────────────────────────
    # The file carries the same body the cmdlet returns: after the edit pass and the para-split (t/4069).
    if (-not [string]::IsNullOrWhiteSpace($OutputPath)) {
        $Markdown = Format-OpEdMarkdown -Headline $Draft.Headline -Subtitle $Draft.Subtitle -Body $FinalBody -Grounding $Grounding
        $Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
        [System.IO.File]::WriteAllText($OutputPath, $Markdown, $Utf8NoBom)
        Write-Verbose "Wrote op-ed to $OutputPath"
    }

    return $Output
}
