# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Set-IssueTypeTags {
    <#
    .SYNOPSIS
        Batch writer for the corpus-wide `graph_attributes.issue_types` /
        `issue_types_provenance` write (t/4836, TL conditions at t/4836#7/#8).
    .DESCRIPTION
        Validates the WHOLE batch against the issue-type schema (docs/issue-type-taxonomy.md,
        lib/schema/issueTypes.ts) BEFORE writing anything: every `Types` value must be a flat
        array (no nesting) of 0-3 unique strings, each one of the six allowed enum ids. A single
        bad entry anywhere in the batch aborts the WHOLE write -- nothing is written, not even
        the valid entries (TL cond, t/4836#7: "If any single value fails, it aborts the whole
        write. It doesn't skip that value.").

        Only after a clean validation does it make the surgical per-field writes, via
        Update-JsonNodePath's Upsert mode (through Save-JsonNodeFieldEdits), one file per POV
        (accelerationist/safetyist/skeptic/situations). `issue_types_provenance` is an object in
        the schema, but Update-JsonNodePath is scalar/flat-array leaf only (t/2921 Q2) -- an
        object-valued Upsert is out of scope for that primitive -- so this cmdlet flattens it
        into individual leaf writes: `.method`, `.model`, `.prompt_version`, `.run_id`,
        `.classified_at`, `.rationale` (each a scalar), and one `.confidence.<type>` scalar leaf
        per chosen type. Upsert creates every missing intermediate object container
        (`graph_attributes`, `issue_types_provenance`, `issue_types_provenance.confidence`)
        along the way. Every leaf write is individually surgical and batch-verified exactly like
        every other Save-JsonNodeFieldEdits caller -- the "zero collateral" proof (t/4836's own
        requirement: the diff touches only these two keys) comes from that shared, already-proven
        machinery, not from anything new in this cmdlet.
    .PARAMETER Assignment
        One or more node/types/provenance triples (pipeline-friendly). Each is an
        IssueTypeAssignment: NodeId (string), Types (string[], 0-3 entries, primary first), and
        Provenance (hashtable with keys Method, Model, PromptVersion, RunId, ClassifiedAt,
        Confidence [hashtable, type -> number, one entry per Types element], Rationale).
    .PARAMETER TargetPath
        Directory holding the taxonomy node files (accelerationist/safetyist/skeptic/
        situations.json). Defaults to Get-TaxonomyDir. Pass a /data-mutation worktree's taxonomy
        dir so this never writes directly to the shared data checkout.
    .OUTPUTS
        [pscustomobject] { Checked; Applied; NotFound }. Checked is always equal to the number of
        assignments submitted (the batch either validates completely or nothing is written).
        NotFound lists NodeIds that passed validation but do not exist in their POV file
        (surfaced, never silently dropped). Throws New-ActionableError (writing NOTHING) on any
        validation failure.
    .EXAMPLE
        Set-IssueTypeTags -Assignment @(
            @{ NodeId = 'sit-160'; Types = @('political','misuse'); Provenance = @{
                Method = 'llm-adjudicated'; Model = 'claude-sonnet-5'; PromptVersion = 'issue-types-v1'
                RunId = 'issue-types-full-2026-11-04'; ClassifiedAt = '2026-11-04T13:02:12Z'
                Confidence = @{ political = 0.8; misuse = 0.7 }; Rationale = '...' } }
        )
    #>
    [CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory, ValueFromPipeline)]
        [IssueTypeAssignment[]]$Assignment,

        [string]$TargetPath
    )

    begin {
        Set-StrictMode -Version Latest
        $script:_IssueTypeTagsBatch = [System.Collections.Generic.List[IssueTypeAssignment]]::new()
    }

    process {
        foreach ($a in $Assignment) { $script:_IssueTypeTagsBatch.Add($a) }
    }

    end {
        $all = $script:_IssueTypeTagsBatch
        Remove-Variable -Name _IssueTypeTagsBatch -Scope Script -ErrorAction SilentlyContinue

        $fail = {
            param($problem, $steps)
            throw (New-ActionableError -Goal "Validate and write issue_types for $($all.Count) node(s)" `
                -Problem $problem -Location 'Set-IssueTypeTags' -NextSteps $steps -PassThru)
        }

        if ($all.Count -eq 0) {
            return [pscustomobject]@{ Checked = 0; Applied = 0; NotFound = @() }
        }

        # --- Validate the WHOLE batch before writing anything (t/4836#7) -------------------
        $ValidTypes = @('loss_of_control', 'misuse', 'power_concentration', 'economic', 'political', 'social')
        $violations = [System.Collections.Generic.List[string]]::new()
        foreach ($a in $all) {
            $nodeId = [string]$a.NodeId
            if ([string]::IsNullOrWhiteSpace($nodeId)) {
                $violations.Add("(blank NodeId): assignment has no NodeId")
                continue
            }
            # $a.Types is typed [string[]] by the class: PowerShell's own element binding
            # coercion already stringifies (via .ToString()) anything that isn't already a
            # string -- confirmed empirically, [string[]]@(@('a','b'),'c') becomes @('a b','c').
            # A genuinely nested element (the exact t/4835#10 bug shape: final:[["a","b"]]
            # instead of ["a","b"]) therefore can never survive into $a.Types at all; this check
            # is defense-in-depth against a caller that somehow bypasses the typed property
            # (e.g. direct hashtable manipulation in a future refactor), not a live code path
            # through this cmdlet's public surface today. A coerced-to-garbage-string element
            # still gets caught below by the enum-membership check either way.
            $types = @($a.Types)
            foreach ($t in $types) {
                if ($t -is [System.Collections.IEnumerable] -and $t -isnot [string]) {
                    $violations.Add("$nodeId`: Types contains a nested array/collection element, not a flat string")
                }
            }
            if ($types.Count -gt 3) {
                $violations.Add("$nodeId`: Types has $($types.Count) entries, more than the allowed 0-3")
            }
            $dupes = @($types | Group-Object | Where-Object { $_.Count -gt 1 })
            if ($dupes.Count -gt 0) {
                $violations.Add("$nodeId`: Types has duplicate entries: $(($dupes | ForEach-Object { $_.Name }) -join ', ')")
            }
            $unknown = @($types | Where-Object { $ValidTypes -notcontains $_ })
            if ($unknown.Count -gt 0) {
                $violations.Add("$nodeId`: Types has unknown id(s): $($unknown -join ', ')")
            }
        }
        if ($violations.Count -gt 0) {
            & $fail "schema validation failed for $($violations.Count) of $($all.Count) assignment(s) -- writing NOTHING:`n$($violations -join [Environment]::NewLine)" `
                @('Fix every listed assignment and resubmit the whole batch', 'This guard aborts the WHOLE write on any single failure, by design (t/4836#7)')
        }

        # --- Validated. Group by owning POV file. ------------------------------------------
        $filesByPrefix = @{ acc = 'accelerationist.json'; saf = 'safetyist.json'; skp = 'skeptic.json'; sit = 'situations.json' }
        $root = if ($TargetPath) { $TargetPath } else { Get-TaxonomyDir }
        $groups = [ordered]@{}
        foreach ($a in $all) {
            $prefix = ([regex]::Match($a.NodeId, '^([a-z]+)-')).Groups[1].Value
            $file = $filesByPrefix[$prefix]
            if (-not $file) {
                & $fail "node '$($a.NodeId)' has no recognized taxonomy file prefix (acc-/saf-/skp-/sit-)" `
                    @('This indicates a bug: the frozen list should never contain an id outside these prefixes')
            }
            $filePath = Join-Path $root $file
            if (-not $groups.Contains($filePath)) { $groups[$filePath] = [System.Collections.Generic.List[hashtable]]::new() }
            $edits = $groups[$filePath]

            $edits.Add(@{ NodeId = $a.NodeId; Path = @('graph_attributes', 'issue_types'); Value = @($a.Types); ArrayValue = $true; Upsert = $true })

            $p = $a.Provenance
            $provFields = @{
                method         = [string]$p['Method']
                model          = [string]$p['Model']
                prompt_version = [string]$p['PromptVersion']
                run_id         = [string]$p['RunId']
                rationale      = [string]$p['Rationale']
            }
            foreach ($field in $provFields.Keys) {
                $edits.Add(@{ NodeId = $a.NodeId; Path = @('graph_attributes', 'issue_types_provenance', $field); Value = $provFields[$field]; Upsert = $true })
            }

            # ClassifiedAt: ConvertFrom-Json auto-detects an ISO-8601-shaped STRING and parses it
            # into a [DateTime] (confirmed empirically -- a caller that read this value back out
            # of a JSON file, e.g. the frozen-list runner, hands this cmdlet a DateTime, not a
            # string). A naive [string] cast then formats via the CURRENT CULTURE's default
            # DateTime.ToString(), producing e.g. "11/04/2026 13:02:12" -- ambiguous, no
            # timezone, inconsistent with every other timestamp in the corpus (SO finding, t/4836
            # e/421#2 C1). Passing a pre-formatted ISO string instead (via .ToString('o')) looked
            # like the fix, but tripped Save-JsonNodeFieldEdits' OWN re-parse-verify: its re-parse
            # ALSO auto-detects the written string as a DateTime, and ConvertTo-Json's DEFAULT
            # DateTime formatter drops a trailing ZERO fractional-second component that 'o' always
            # includes (".0000000Z" -> "Z") -- a real, if narrow, divergence between the
            # "expected" and "actual" verify baselines for exactly-zero-fraction instants, not
            # present for non-zero fractions (confirmed empirically). Passing the [DateTime]
            # OBJECT itself as Value sidesteps this entirely: both sides of the verify are then
            # DateTime objects formatted by the SAME ConvertTo-Json default formatter, so they
            # agree by construction regardless of fractional-second quirks.
            $rawClassifiedAt = $p['ClassifiedAt']
            $classifiedAtDt = if ($rawClassifiedAt -is [DateTime]) {
                $rawClassifiedAt
            } else {
                [DateTime]::Parse([string]$rawClassifiedAt, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind)
            }
            $edits.Add(@{ NodeId = $a.NodeId; Path = @('graph_attributes', 'issue_types_provenance', 'classified_at'); Value = $classifiedAtDt.ToUniversalTime(); Upsert = $true })

            $confidence = $p['Confidence']
            if ($confidence) {
                foreach ($type in @($confidence.Keys)) {
                    $edits.Add(@{ NodeId = $a.NodeId; Path = @('graph_attributes', 'issue_types_provenance', 'confidence', $type); Value = [double]$confidence[$type]; Upsert = $true })
                }
            }
        }

        $applied = 0
        $notFound = [System.Collections.Generic.List[string]]::new()
        if ($PSCmdlet.ShouldProcess("$($all.Count) node(s) across $($groups.Count) file(s) under '$root'", 'Write issue_types + issue_types_provenance')) {
            foreach ($filePath in $groups.Keys) {
                $result = Save-JsonNodeFieldEdits -Path $filePath -Edits $groups[$filePath].ToArray() -Confirm:$false
                # Each node contributes several edits (issue_types + provenance leaves); Applied
                # from the writer counts EDITS, not nodes, so recompute per-node applied/not-found
                # from NotFound's node-id set instead of trusting the writer's raw count directly.
                $fileNotFound = [System.Collections.Generic.HashSet[string]]::new([string[]]@($result.NotFound))
                foreach ($nf in $fileNotFound) { $notFound.Add($nf) }
            }
        }
        $notFoundSet = [System.Collections.Generic.HashSet[string]]::new([string[]]@($notFound.ToArray()))
        foreach ($a in $all) { if (-not $notFoundSet.Contains([string]$a.NodeId)) { $applied++ } }

        return [pscustomobject]@{
            Checked  = $all.Count
            Applied  = $applied
            NotFound = $notFound.ToArray()
        }
    }
}
