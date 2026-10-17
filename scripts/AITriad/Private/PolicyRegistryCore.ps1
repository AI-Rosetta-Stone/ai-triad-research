# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# ── The one copy of policy-ID minting and registration (t/4004) ──────────────
# Moved out of Update-PolicyRegistry so every policy_actions writer shares one implementation of
# "scan references", "next ID", "build entry", "write ids onto nodes" and "recount members".
# Divergent copies (Update-PolicyRegistry and Find-PolicyAction each minted their own) are how IDs
# collide and member_count drifts. Callers: Update-PolicyRegistry (corpus -Fix and node-scoped -NodeId),
# and through it Invoke-AttributeExtraction and Find-PolicyAction.

$script:PolicyPovFiles = @('accelerationist', 'safetyist', 'skeptic', 'situations')

function Get-NodePolicyActions {
    # A node's policy_actions array, or @() when the node has none.
    param([Parameter(Mandatory)]$Node)
    if (-not $Node.PSObject.Properties['graph_attributes'] -or $null -eq $Node.graph_attributes) { return @() }
    if (-not $Node.graph_attributes.PSObject.Properties['policy_actions']) { return @() }
    return @($Node.graph_attributes.policy_actions)
}

function Get-GraphAttributePolicyIds {
    # The policy ids on one node's graph_attributes (prior-ids capture for -PriorPolicyIds), @() when none.
    param($GraphAttributes)
    if ($null -eq $GraphAttributes -or -not $GraphAttributes.PSObject.Properties['policy_actions']) { return @() }
    return @(@($GraphAttributes.policy_actions) | Where-Object { $null -ne $_ -and $_.PSObject.Properties['policy_id'] -and $_.policy_id } |
        ForEach-Object { [string]$_.policy_id })
}

function Enter-PolicyRegistryLock {
    <#
    .SYNOPSIS
        Advisory lock for Update-PolicyRegistry -Fix (t/4028): `policy_actions.lock` beside the
        registry, taken from the registry read to the registry write. Reuses the grounding-lock
        mechanism (atomic create, 120s staleness break, bounded 60s wait, ActionableError on timeout).
        It closes the window between Assert-PolicyIdsUnminted and the write. It does NOT let a second
        writer through a dirty registry: that is the BLOCK-tier guard's job, and the preflight in
        Update-PolicyRegistry refuses it before any node file is written. Returns the protocol-v2 lock
        object (t/4193); Invoke-PolicyRegistryUpdate calls Assert-GroundingLockHeld before each write.
    #>
    [CmdletBinding()]
    [OutputType('AITriad.GroundingLockV2.LockHandle')]
    param([Parameter(Mandatory)][string]$LockPath)
    return Enter-GroundingLock -LockPath $LockPath -Holder 'Update-PolicyRegistry' `
        -Purpose 'policy id minting and registration (policy_actions.json and the POV files)' `
        -OtherWriters 'another Update-PolicyRegistry -Fix, Invoke-AttributeExtraction or Find-PolicyAction'
}

function Invoke-NodePolicyRegistration {
    <#
    .SYNOPSIS
        What every policy_actions writer calls after its own taxonomy write (t/4004): registers the
        written nodes through Update-PolicyRegistry -Fix -NodeId. A registration failure never undoes
        the taxonomy write (it stands, as before); it WARNs with the node ids left unregistered and
        the remedy, so the gap is visible instead of persisting silently.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$NodeId,
        [AllowEmptyCollection()][string[]]$PriorPolicyIds = @(),
        [Parameter(Mandatory)][string]$Caller
    )
    if (@($NodeId).Count -eq 0) { return }
    try {
        $null = Update-PolicyRegistry -Fix -NodeId $NodeId -PriorPolicyIds @($PriorPolicyIds | Sort-Object -Unique)
    }
    catch {
        # Fallback-path logging: the taxonomy write landed but its policy actions are unregistered.
        # The remedy is node-scoped on purpose: a corpus-wide -Fix rewrites unrelated policies' counts
        # into an unattributed commit (t/3943). The usual cause is an uncommitted earlier registry
        # change (policy_actions.json is BLOCK-tier), hence "commit first".
        $Scoped = "Update-PolicyRegistry -Fix -NodeId " + (($NodeId | ForEach-Object { "'$_'" }) -join ',')
        Write-Warning ("{0}: policy registration failed for {1} node(s): {2} -- {3}. Their new policy_actions have no policy_id. Remedy: commit policy_actions.json if it has uncommitted changes, then run: {4} (t/4004, t/4028)." -f
            $Caller, @($NodeId).Count, ($NodeId -join ', '), $_.Exception.Message, $Scoped)
    }
}

function Get-PolicyReferenceScan {
    <#
    .SYNOPSIS
        One read-only pass over the four taxonomy files. Returns Referenced (policy_id -> list of
        { NodeId, POV, Action, Framing }, one entry per reference) and Unregistered (actions with no
        policy_id, as { NodeId, POV, Action, Framing }).
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param([Parameter(Mandatory)][string]$TaxDir)

    $Referenced   = @{}
    $Unregistered = [System.Collections.Generic.List[object]]::new()
    foreach ($PovKey in $script:PolicyPovFiles) {
        $FileData = Read-PolicyPovFile -TaxDir $TaxDir -PovKey $PovKey
        foreach ($Node in $FileData.nodes) {
            foreach ($PA in (Get-NodePolicyActions -Node $Node)) {
                Add-PolicyReference -Referenced $Referenced -Unregistered $Unregistered -NodeId $Node.id -PovKey $PovKey -PolicyAction $PA
            }
        }
    }
    return [pscustomobject]@{ Referenced = $Referenced; Unregistered = $Unregistered }
}

function Read-PolicyPovFile {
    # One POV file for the reference scan, or a refusal. The scan feeds the recount, which writes
    # member_count from what it saw, so a POV that silently contributes nothing becomes committed zeros
    # for every policy it references (t/4065, the PS twin of #3048). Missing, unreadable, unparseable,
    # null, no nodes array and an empty nodes array all refuse. The four refusals match the TS lib's
    # recountPolicyMembers guard (#3050, SO e/274#2), so the two recount paths agree on what a
    # complete corpus is. No real POV file is legitimately empty.
    param([Parameter(Mandatory)][string]$TaxDir, [Parameter(Mandatory)][string]$PovKey)
    $FilePath = Join-Path $TaxDir "$PovKey.json"
    $Problem = $null
    $FileData = $null
    if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
        $Problem = "$PovKey.json does not exist"
    }
    else {
        try {
            $FileData = Get-Content -Raw -LiteralPath $FilePath -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
        } catch {
            $Problem = "$PovKey.json could not be read or parsed: $($_.Exception.Message)"
        }
        if (-not $Problem) {
            if ($null -eq $FileData) { $Problem = "$PovKey.json is empty or null" }
            elseif (-not $FileData.PSObject.Properties['nodes'] -or $FileData.nodes -isnot [array]) { $Problem = "$PovKey.json has no nodes array" }
            elseif (@($FileData.nodes).Count -eq 0) { $Problem = "$PovKey.json has an empty nodes array" }
        }
    }
    if ($Problem) {
        throw (New-ActionableError -PassThru `
            -Goal 'Scan the four POV files for policy references before recounting member_count' `
            -Problem "$Problem. A partial scan would write member_count 0 for every policy that file references." `
            -Location "Read-PolicyPovFile ($FilePath)" `
            -NextSteps @("Restore $FilePath (git status / git diff in the data repo) and re-run", 'Nothing was written'))
    }
    return $FileData
}

function Add-PolicyReference {
    # Files one policy_actions entry into the scan: Unregistered if it has no policy_id, else Referenced.
    param($Referenced, $Unregistered, [string]$NodeId, [string]$PovKey, $PolicyAction)
    $PA = $PolicyAction
    $PolicyId = if ($PA.PSObject.Properties['policy_id']) { $PA.policy_id } else { $null }
    # Guarded under StrictMode: one action without framing (or action) anywhere in the corpus must not
    # throw the whole scan, which every policy_actions writer now runs (t/4004).
    $Ref = [PSCustomObject]@{
        NodeId  = $NodeId
        POV     = $PovKey
        Action  = if ($PA.PSObject.Properties['action']) { $PA.action } else { $null }
        Framing = if ($PA.PSObject.Properties['framing']) { $PA.framing } else { $null }
    }
    if (-not $PolicyId) {
        $Unregistered.Add($Ref)
        return
    }
    if (-not $Referenced.ContainsKey($PolicyId)) {
        $Referenced[$PolicyId] = [System.Collections.Generic.List[object]]::new()
    }
    # Action/framing are kept so a referenced-but-unregistered id can be re-added to the registry (t/3435).
    $Referenced[$PolicyId].Add($Ref)
}

function New-PolicyRegistryEntry {
    # The one shape of a registry entry, for minted and re-added ids alike.
    param([string]$Id, [string]$Action, [string[]]$SourcePovs, [int]$MemberCount)
    return [PSCustomObject]@{
        id           = $Id
        action       = $Action
        source_povs  = @($SourcePovs)
        member_count = $MemberCount
        status       = 'active'
    }
}

function Get-TakenPolicyIdMax {
    # Highest pol-NNNN number across every id already taken: registry ids AND ids referenced on nodes.
    # Referenced ids count too (t/3431): a prior partial run can reference an id it never registered.
    param([Parameter(Mandatory)][AllowEmptyCollection()][string[]]$TakenIds)
    $MaxId = 0
    foreach ($Key in $TakenIds) {
        if ($Key -match 'pol-(\d+)') {
            $Num = [int]$Matches[1]
            if ($Num -gt $MaxId) { $MaxId = $Num }
        }
    }
    return $MaxId
}

function New-PolicyRegistryAssignments {
    <#
    .SYNOPSIS
        The one copy of "next ID". Mints a pol-NNN for each unregistered action above every taken id,
        adds the registry entry to $Policies (in memory), and returns the assignments
        { POV, NodeId, Action, NewId } for Set-PolicyIdsOnNodes.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()]$Unregistered,
        [Parameter(Mandatory)][hashtable]$Policies,
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$TakenIds
    )
    $MaxId = Get-TakenPolicyIdMax -TakenIds (@($Policies.Keys) + @($TakenIds))
    $Assignments = [System.Collections.Generic.List[object]]::new()
    foreach ($U in $Unregistered) {
        $MaxId++
        $NewId = 'pol-{0:D3}' -f $MaxId
        $Policies[$NewId] = New-PolicyRegistryEntry -Id $NewId -Action $U.Action -SourcePovs @($U.POV) -MemberCount 1
        $Assignments.Add([PSCustomObject]@{ POV = $U.POV; NodeId = $U.NodeId; Action = $U.Action; NewId = $NewId })
        $Text = [string]$U.Action
        Write-Info "  Assigned $NewId to $($U.NodeId)`: $($Text.Substring(0, [Math]::Min(50, $Text.Length)))"
    }
    return [pscustomobject]@{ Assignments = $Assignments }
}

function Assert-PolicyIdsUnminted {
    <#
    .SYNOPSIS
        Refuses (New-ActionableError) when any freshly minted id is already taken on disk. "Taken" is
        the SAME set minting uses: registry ids UNION ids referenced on nodes, both re-read from disk now.
        A concurrent writer that minted the same id between our scan and our write is caught here, so a
        collision refuses rather than writing a duplicate. No lock is taken (t/4028).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$TaxDir,
        [Parameter(Mandatory)][string]$RegistryPath,
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$MintedIds
    )
    if (@($MintedIds).Count -eq 0) { return }
    $Taken = [System.Collections.Generic.HashSet[string]]::new()
    $Disk = Read-PolicyRegistryFile -RegistryPath $RegistryPath
    if ($Disk) { foreach ($Pol in @($Disk.policies)) { [void]$Taken.Add([string]$Pol.id) } }
    foreach ($Id in (Get-PolicyReferenceScan -TaxDir $TaxDir).Referenced.Keys) { [void]$Taken.Add([string]$Id) }
    $Collisions = @($MintedIds | Where-Object { $Taken.Contains($_) })
    if ($Collisions.Count -gt 0) {
        throw (New-ActionableError -PassThru `
            -Goal 'Register new policy actions with unique ids' `
            -Problem "Minted policy id(s) already taken on disk: $($Collisions -join ', '). Another writer registered them after this run scanned the registry." `
            -Location 'Assert-PolicyIdsUnminted' `
            -NextSteps @('Nothing was written. Re-run the command so it mints above the current ids', 'If this recurs, see t/4028 (no lock on registry writers)'))
    }
}

function Read-PolicyRegistryFile {
    # The registry parsed from disk, or $null when the file doesn't exist. A file that exists but
    # won't parse refuses with New-ActionableError rather than being treated as empty.
    param([Parameter(Mandatory)][string]$RegistryPath)
    if (-not (Test-Path $RegistryPath)) { return $null }
    try {
        return (Get-Content -Raw -Path $RegistryPath | ConvertFrom-Json)
    } catch {
        throw (New-ActionableError -PassThru `
            -Goal 'Read the policy action registry' `
            -Problem "policy_actions.json is not valid JSON: $($_.Exception.Message)" `
            -Location 'Read-PolicyRegistryFile' `
            -NextSteps @("Repair $RegistryPath (git diff / restore it) and re-run", 'Nothing was written'))
    }
}

function Set-PolicyIdsOnNodes {
    <#
    .SYNOPSIS
        Writes minted ids onto their nodes: ONE whole-file rewrite per touched POV file (t/3431 — a
        per-assignment rewrite self-dirties the file and the dirty-tree guard false-blocks the next write).
        Matches action text on an entry with no policy_id, first match wins, so duplicate action text
        within a node maps to distinct ids in order.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$TaxDir,
        [Parameter(Mandatory)][AllowEmptyCollection()]$Assignments
    )
    $ByPov = @{}
    foreach ($Asg in $Assignments) {
        if (-not $ByPov.ContainsKey($Asg.POV)) { $ByPov[$Asg.POV] = [System.Collections.Generic.List[object]]::new() }
        $ByPov[$Asg.POV].Add($Asg)
    }
    foreach ($PovKey in $ByPov.Keys) {
        $FilePath = Join-Path $TaxDir "$PovKey.json"
        $FileData = Get-Content -Raw -Path $FilePath | ConvertFrom-Json
        foreach ($Asg in $ByPov[$PovKey]) {
            $Node = @($FileData.nodes | Where-Object { $_.id -eq $Asg.NodeId })[0]
            if ($Node) { Set-FirstUnassignedPolicyId -Node $Node -Action $Asg.Action -NewId $Asg.NewId }
        }
        $FileData | ConvertTo-Json -Depth 20 | Write-Utf8NoBom -Path $FilePath
    }
}

function Set-FirstUnassignedPolicyId {
    param($Node, [string]$Action, [string]$NewId)
    foreach ($PA in $Node.graph_attributes.policy_actions) {
        if ($PA.action -eq $Action -and (-not $PA.PSObject.Properties['policy_id'] -or $null -eq $PA.policy_id)) {
            $PA | Add-Member -NotePropertyName 'policy_id' -NotePropertyValue $NewId -Force
            return
        }
    }
}

function Update-PolicyMemberCounts {
    <#
    .SYNOPSIS
        The one copy of the recount. Sets member_count and source_povs from a fresh reference scan for
        each policy in $Ids (every policy when $Ids is $null). A node-scoped caller passes the union of
        the ids its nodes held before AND after the write, so a dropped id decrements while unrelated
        policies' counts are left as they are (t/4004).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][hashtable]$Policies,
        [Parameter(Mandatory)]$Referenced,
        [string[]]$Ids
    )
    $Targets = if ($PSBoundParameters.ContainsKey('Ids')) { @($Ids | Where-Object { $Policies.ContainsKey($_) }) } else { @($Policies.Keys) }
    foreach ($PolicyId in $Targets) {
        $Pol = $Policies[$PolicyId]
        if ($Referenced.ContainsKey($PolicyId)) {
            $Refs = @($Referenced[$PolicyId])
            $Pol.member_count = $Refs.Count
            $Pol.source_povs  = @($Refs | ForEach-Object { $_.POV } | Sort-Object -Unique)
        }
        elseif ($PSBoundParameters.ContainsKey('Ids')) {
            # Node-scoped: the id was on a target node before the write and is referenced nowhere now.
            $Pol.member_count = 0
        }
        # Preserve real_world_refs, last_refined_at, superseded_by, etc.; only ensure status exists.
        if (-not $Pol.PSObject.Properties['status']) { $Pol | Add-Member -NotePropertyName 'status' -NotePropertyValue 'active' }
    }
}
