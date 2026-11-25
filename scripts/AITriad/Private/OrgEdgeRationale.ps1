# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# t/584: the text a researcher reads under an organization edge. The pipeline writers
# (Invoke-OrgClaimMatching, Invoke-OrgPublishedSeeding) used to put their match diagnostics in
# `rationale` ("match_basis=high-cosine families=1 best_cosine=0.738 ..."), and the org page shows
# `rationale` as the reason for the relationship. The rationale is now a sentence, and the diagnostics
# live in `match_meta`.
#
# The wording is fixed: agreed by Comp-Linguist (t/584#4) and Design (t/584#6), final table on t/584#8.
# Do not reword it here without their review.
#
# match_meta is provenance only: NO consumer branches on it. THE EXEMPTION LAPSES the moment a reader
# of organization_edges.json branches on match_meta or any field inside it (docs/change-tiers.md, T0/T1;
# the model is lib/ai-client/types.ts). Until then it may be absent on any edge.

function New-OrgEdgeRationale {
    <#
    .SYNOPSIS
        The plain-language rationale of a pipeline-written organization edge (t/584).
    .DESCRIPTION
        Kind 'Matched': an ADVOCATES_FOR or OPPOSES edge from claim matching. The org's own words are
        quoted, whole, under "states" only when -ClaimText is given AND the claim's document is the
        org's own (-OwnDocument). With only a canonical proposition (a paraphrase) there are no
        quotation marks and the sentence says it is not the org's words. For OPPOSES the direction is
        in the sentence. Kind 'SiteListed': what domain seeding stores for a PUBLISHED edge it proposes. It
        states only what the pipeline saw and names no status, because nothing rewrites an organization
        edge's rationale when the edge is approved or rejected (CL p/70#99, Design p/113#11). Kind
        'Published': a PUBLISHED edge a review has approved, on the org's own domain; no pipeline writes
        it. Kind 'Withdrawn': a matched edge whose supporting claim no longer exists.
        The text is never cut. The document is named by its title, or by its id when it has none.
    .OUTPUTS
        [string]
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)][ValidateSet('Matched', 'SiteListed', 'Published', 'Withdrawn')][string]$Kind,
        [string]$OrgName,
        [string]$DocumentTitle,
        [string]$DocumentId,
        [string]$ClaimText,
        [string]$Proposition,
        [ValidateSet('ADVOCATES_FOR', 'OPPOSES')][string]$EdgeType = 'ADVOCATES_FOR',
        [bool]$OwnDocument = $true,
        [string]$SiteHost
    )
    Set-StrictMode -Version Latest
    $Open = [string][char]0x201C; $Close = [string][char]0x201D
    $Fail = {
        param($Problem)
        throw (New-ActionableError -AsErrorRecord -Goal 'Write the rationale of an organization edge (t/584)' `
                -Problem $Problem -Location 'OrgEdgeRationale.ps1: New-OrgEdgeRationale' `
                -NextSteps @('Pass the missing value from the writer', 'See the wording table on t/584#8'))
    }
    if ($Kind -eq 'Withdrawn') { return 'Proposed by automated claim matching; the supporting claim was later withdrawn.' }
    if ([string]::IsNullOrWhiteSpace($OrgName)) { & $Fail "No organization name was given for a '$Kind' rationale." }
    if ($Kind -in 'Published', 'SiteListed') {
        if ([string]::IsNullOrWhiteSpace($SiteHost)) { & $Fail "No site host was given for a '$Kind' rationale." }
        if ($Kind -eq 'SiteListed') { return "The document is on $($SiteHost.Trim()), one of the sites listed in $($OrgName.Trim())'s links." }
        return "Published on $($OrgName.Trim())'s own site ($($SiteHost.Trim()))."
    }
    $Document = if (-not [string]::IsNullOrWhiteSpace($DocumentTitle)) { $DocumentTitle.Trim() } else { ([string]$DocumentId).Trim() }
    if (-not $Document) { & $Fail 'Neither a document title nor a document id was given for a Matched rationale.' }
    $Opposes = $EdgeType -eq 'OPPOSES'
    $Text = ([string]$ClaimText).Trim()
    if ($Text) {
        if (-not $OwnDocument) { return "Matched claim from $Document (not the org's own statement): $Open$Text$Close." }
        if ($Opposes) { return "$($OrgName.Trim()) states, in opposition: $Open$Text$Close ($Document)." }
        return "$($OrgName.Trim()) states: $Open$Text$Close ($Document)."
    }
    $Para = ([string]$Proposition).Trim()
    if (-not $Para) { & $Fail 'Neither the claim text nor a canonical proposition was given for a Matched rationale.' }
    if ($Opposes) { return "Matched opposing claim (paraphrase, not the org's words): $Para ($Document)." }
    "Matched claim (paraphrase, not the org's words): $Para ($Document)."
}

function New-OrgEdgeMatchMeta {
    <#
    .SYNOPSIS
        The match diagnostics of a pipeline-written organization edge, as the `match_meta` object (t/584).
    .DESCRIPTION
        Holds what the rationale string used to hold. Only values that were given are written, in a fixed
        key order, so the stored object is stable. Provenance only: nothing branches on it (see the note
        at the top of this file).
    .OUTPUTS
        [System.Collections.Specialized.OrderedDictionary]
    #>
    [CmdletBinding()]
    [OutputType([System.Collections.Specialized.OrderedDictionary])]
    param(
        [Parameter(Mandatory)][int]$Stage,
        [Parameter(Mandatory)][string]$Basis,
        [Nullable[int]]$Families,
        [Nullable[double]]$BestCosine,
        [string]$ClaimSourceId,
        [string]$ClaimText,
        [string]$NliDirection,
        [Nullable[double]]$NliMargin,
        [string]$DirectionalFlip,
        [string]$Endorsement,
        [switch]$DirectionConflict
    )
    Set-StrictMode -Version Latest
    $Meta = [ordered]@{ stage = $Stage; basis = $Basis }
    if ($null -ne $Families) { $Meta['families'] = [int]$Families }
    if ($null -ne $BestCosine) { $Meta['best_cosine'] = [Math]::Round([double]$BestCosine, 3) }
    if ($ClaimSourceId) { $Meta['claim_source_id'] = $ClaimSourceId }
    if ($ClaimText) {
        # The representative claim, identified without copying it: sha256 of its exact text (UTF-8).
        $Sha = [System.Security.Cryptography.SHA256]::HashData([System.Text.Encoding]::UTF8.GetBytes($ClaimText))
        $Meta['claim_text_sha256'] = [System.Convert]::ToHexString($Sha).ToLowerInvariant()
    }
    if ($NliDirection) { $Meta['nli_direction'] = $NliDirection }
    if ($null -ne $NliMargin) { $Meta['nli_margin'] = [Math]::Round([double]$NliMargin, 4) }
    if ($DirectionalFlip) { $Meta['directional_flip'] = $DirectionalFlip }
    if ($Endorsement) { $Meta['endorsement'] = $Endorsement }
    if ($DirectionConflict) { $Meta['direction_conflict'] = $true }
    $Meta
}

function Get-OrgDisplayNameMap {
    <#
    .SYNOPSIS
        Organization id -> display name (the `name` the organization page shows), from organizations.json.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param()
    Set-StrictMode -Version Latest
    $Map = @{}
    try {
        $Store = Get-OrganizationsStore -ErrorAction Stop
    } catch {
        Write-Warning "Get-OrgDisplayNameMap: the organization registry could not be read ($($_.Exception.Message)); no display names are available (t/584)"
        return $Map
    }
    if ($Store -and $Store.PSObject.Properties['organizations']) {
        foreach ($O in @($Store.organizations)) {
            if (-not $O.PSObject.Properties['id']) { continue }
            $Name = if ($O.PSObject.Properties['name']) { ([string]$O.name).Trim() } else { '' }
            if ($Name) { $Map[[string]$O.id] = $Name }
        }
    }
    $Map
}

function Get-OrgEdgeDocumentTitle {
    <#
    .SYNOPSIS
        The title of a source document from its metadata.json, or '' when it has none (t/584).
    .DESCRIPTION
        '' makes the rationale name the document by its id, which is the agreed wording for a document
        with no title. A metadata.json that is missing or unreadable is the same case, with a WARN.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)][string]$SourceId,
        [string]$SourcesDir
    )
    Set-StrictMode -Version Latest
    if (-not $SourcesDir) {
        try { $SourcesDir = Get-SourcesDir } catch { $SourcesDir = '' }
        if (-not $SourcesDir) {
            Write-Warning "Get-OrgEdgeDocumentTitle: the sources directory could not be resolved; the rationale names '$SourceId' by its id (t/584)"
            return ''
        }
    }
    $MetaPath = Join-Path (Join-Path $SourcesDir $SourceId) 'metadata.json'
    if (-not (Test-Path -LiteralPath $MetaPath)) {
        Write-Warning "Get-OrgEdgeDocumentTitle: no metadata.json for '$SourceId' under $SourcesDir; the rationale names the document by its id (t/584)"
        return ''
    }
    try {
        $Meta = Get-Content -Raw -LiteralPath $MetaPath | ConvertFrom-Json
    } catch {
        Write-Warning "Get-OrgEdgeDocumentTitle: metadata.json for '$SourceId' is unreadable ($($_.Exception.Message)); the rationale names the document by its id (t/584)"
        return ''
    }
    if ($Meta.PSObject.Properties['title'] -and -not [string]::IsNullOrWhiteSpace([string]$Meta.title)) { return ([string]$Meta.title).Trim() }
    ''
}
