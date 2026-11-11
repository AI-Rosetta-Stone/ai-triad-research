# Tag: health (t/121)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    t/121 (Interweave): deploys tag the exact digest they pin with a non-moving pinned-* tag.
.DESCRIPTION
    Both arms against the real cleanup code (Remove-StaleContainerImages +
    Get-StaleImageDeletionVerdict):
      - a container.yml re-run moves sha-<commit> to a new digest; the digest prod pinned keeps
        its pinned-* tag, so it and its child manifests are NOT deleted;
      - without the pinned tag (main before t/121) the same digest and children ARE deleted;
      - a digest nothing pins or tags is still cleaned.
    GHCR and the GitHub API are fully mocked.
#>

BeforeAll {
    $ModulePath = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1'
    Import-Module $ModulePath -Force -WarningAction SilentlyContinue
    $script:Root = Join-Path $PSScriptRoot '..'
}

Describe 'Get-PinnedImageTagName (t/121, pure)' -Tag 'health' {
    It 'names the tag pinned-RUNID-HEX12 (first 12 hex of the digest; no run attempt)' {
        InModuleScope AITriad {
            Get-PinnedImageTagName -Digest "sha256:$('ab' * 32)" -RunId '42621970336' |
                Should -Be 'pinned-42621970336-abababababab'
        }
    }

    It 'is a valid OCI tag and always starts with pinned-' {
        InModuleScope AITriad {
            $t = Get-PinnedImageTagName -Digest "sha256:$('F' * 64)" -RunId '99999999999999999999'
            $t | Should -Match '^pinned-'
            $t | Should -MatchExactly '^[a-z0-9_][a-z0-9._-]{0,127}$'
        }
    }

    It 'gives the same digest the same tag on every attempt of a run, so a re-run or the post-deploy retry is AlreadyPinned' {
        InModuleScope AITriad {
            $a = Get-PinnedImageTagName -Digest "sha256:$('a' * 64)" -RunId '7'
            $b = Get-PinnedImageTagName -Digest "sha256:$('A' * 64)" -RunId '7'
            $a | Should -Be $b
            (Get-PinnedImageTagVerdict -Digest "sha256:$('a' * 64)" -ExistingDigest "sha256:$('a' * 64)").Action | Should -Be 'AlreadyPinned'
        }
    }

    It 'gives different digests different tags under the same run, so a tag never has a reason to move' {
        InModuleScope AITriad {
            $a = Get-PinnedImageTagName -Digest "sha256:$('a' * 64)" -RunId '1'
            $b = Get-PinnedImageTagName -Digest "sha256:$('b' * 64)" -RunId '1'
            $a | Should -Not -Be $b
        }
    }

    It 'refuses <Case>' -ForEach @(
        @{ Case = 'a tag instead of a digest'; Digest = 'sha-4b8d8830'; RunId = '1' }
        @{ Case = 'a short digest';            Digest = 'sha256:abc';   RunId = '1' }
        @{ Case = 'an empty digest';           Digest = '';             RunId = '1' }
        @{ Case = 'a non-numeric run id';      Digest = "sha256:$('a' * 64)"; RunId = '1;rm' }
        @{ Case = 'an empty run id';           Digest = "sha256:$('a' * 64)"; RunId = '' }
    ) {
        InModuleScope AITriad -Parameters @{ D = $Digest; R = $RunId } {
            param($D, $R)
            { Get-PinnedImageTagName -Digest $D -RunId $R } | Should -Throw
        }
    }
}

Describe 'Get-PinnedImageTagVerdict (t/121, pure)' -Tag 'health' {
    It 'Create when the tag does not exist' {
        InModuleScope AITriad {
            (Get-PinnedImageTagVerdict -Digest 'sha256:a' -ExistingDigest '').Action | Should -Be 'Create'
        }
    }
    It 'AlreadyPinned when the tag already names this digest (a re-run)' {
        InModuleScope AITriad {
            (Get-PinnedImageTagVerdict -Digest 'sha256:a' -ExistingDigest 'SHA256:A').Action | Should -Be 'AlreadyPinned'
        }
    }
    It 'Refuse when the tag names a different digest (a pinned tag never moves)' {
        InModuleScope AITriad {
            $v = Get-PinnedImageTagVerdict -Digest 'sha256:a' -ExistingDigest 'sha256:b'
            $v.Action | Should -Be 'Refuse'
            $v.Reason | Should -Match 'never moves'
        }
    }
}

Describe 'Set-TaxEditorPinnedTag (t/121, shim)' -Tag 'health' {
    BeforeAll {
        $script:Hex    = 'c' * 64
        $script:Digest = "sha256:$($script:Hex)"
        $script:Ref    = "ghcr.io/ai-rosetta-stone/taxonomy-editor@$($script:Digest)"
        $script:Tag    = "pinned-123-$('c' * 12)"
    }
    BeforeEach {
        # $script:TagState: the digest the pinned tag names in the fake registry ('' = 404).
        InModuleScope AITriad -Parameters @{ Digest = $script:Digest } {
            param($Digest)
            $script:TagState = ''
            $script:FetchDigest = $Digest
            $script:TagReadFails = $false
            Mock Get-GhcrAuthToken { 'fake-ghcr-token' }
            Mock Invoke-WebRequest {
                if ($Uri -like '*/manifests/sha256:*') {
                    return [pscustomobject]@{ StatusCode = 200; Content = '{"schemaVersion":2,"manifests":[]}'
                        Headers = @{ 'Content-Type' = 'application/vnd.oci.image.index.v1+json'; 'Docker-Content-Digest' = $script:FetchDigest } }
                }
                if ($Uri -like '*/manifests/pinned-*') {
                    if ($script:TagReadFails) { throw 'connection reset' }
                    if (-not $script:TagState) { return [pscustomobject]@{ StatusCode = 404; Content = ''; Headers = @{} } }
                    return [pscustomobject]@{ StatusCode = 200; Content = '{}'
                        Headers = @{ 'Docker-Content-Digest' = $script:TagState } }
                }
                throw "unexpected GET $Uri"
            }
            Mock Invoke-RestMethod -ParameterFilter { $Method -eq 'PUT' } {
                if ($Uri -like '*/manifests/pinned-*') { $script:TagState = $script:FetchDigest }
            }
        }
    }

    It 'creates the tag on the exact pinned digest and confirms it by re-reading' {
        InModuleScope AITriad -Parameters @{ Ref = $script:Ref; Tag = $script:Tag; Digest = $script:Digest } {
            param($Ref, $Tag, $Digest)
            $r = Set-TaxEditorPinnedTag -ImageRef $Ref -RunId '123' -Confirm:$false
            $r.Action | Should -Be 'Create'
            $r.Tag    | Should -Be $Tag
            $r.Digest | Should -Be $Digest
            Should -Invoke Invoke-WebRequest -Times 1 -Exactly -ParameterFilter { $Uri -like "*/manifests/$Digest" }
            Should -Invoke Invoke-RestMethod -Times 1 -Exactly -ParameterFilter { $Method -eq 'PUT' -and $Uri -like "*/manifests/$Tag" }
            Should -Invoke Invoke-WebRequest -Times 2 -Exactly -ParameterFilter { $Uri -like "*/manifests/$Tag" }
            Should -Invoke Get-GhcrAuthToken -Times 1 -Exactly -ParameterFilter { $Scope -eq 'pull,push' }
        }
    }

    It 'a re-run of the same deploy writes nothing (AlreadyPinned)' {
        InModuleScope AITriad -Parameters @{ Ref = $script:Ref; Digest = $script:Digest } {
            param($Ref, $Digest)
            $script:TagState = $Digest
            (Set-TaxEditorPinnedTag -ImageRef $Ref -RunId '123' -Confirm:$false).Action | Should -Be 'AlreadyPinned'
            Should -Invoke Invoke-RestMethod -Times 0 -ParameterFilter { $Method -eq 'PUT' }
        }
    }

    It 'refuses to move a pinned tag that names another digest' {
        InModuleScope AITriad -Parameters @{ Ref = $script:Ref } {
            param($Ref)
            $script:TagState = "sha256:$('d' * 64)"
            { Set-TaxEditorPinnedTag -ImageRef $Ref -RunId '123' -Confirm:$false } | Should -Throw '*never moves*'
            Should -Invoke Invoke-RestMethod -Times 0 -ParameterFilter { $Method -eq 'PUT' }
        }
    }

    It 'fails closed: writes nothing when the tag cannot be read' {
        InModuleScope AITriad -Parameters @{ Ref = $script:Ref } {
            param($Ref)
            $script:TagReadFails = $true
            { Set-TaxEditorPinnedTag -ImageRef $Ref -RunId '123' -Confirm:$false } | Should -Throw '*nothing was written*'
            Should -Invoke Invoke-RestMethod -Times 0 -ParameterFilter { $Method -eq 'PUT' }
        }
    }

    It 'fails closed on an unexpected HTTP status for the tag read' {
        InModuleScope AITriad -Parameters @{ Ref = $script:Ref } {
            param($Ref)
            Mock Invoke-WebRequest -ParameterFilter { $Uri -like '*/manifests/pinned-*' } {
                [pscustomobject]@{ StatusCode = 503; Content = ''; Headers = @{} }
            }
            { Set-TaxEditorPinnedTag -ImageRef $Ref -RunId '123' -Confirm:$false } | Should -Throw '*HTTP 503*'
            Should -Invoke Invoke-RestMethod -Times 0 -ParameterFilter { $Method -eq 'PUT' }
        }
    }

    It 'refuses when GHCR returns a different manifest than the pinned digest' {
        InModuleScope AITriad -Parameters @{ Ref = $script:Ref } {
            param($Ref)
            $script:FetchDigest = "sha256:$('e' * 64)"
            { Set-TaxEditorPinnedTag -ImageRef $Ref -RunId '123' -Confirm:$false } | Should -Throw '*refusing to tag a different image*'
            Should -Invoke Invoke-RestMethod -Times 0 -ParameterFilter { $Method -eq 'PUT' }
        }
    }

    It 'throws when the PUT returned but the tag does not name the digest afterwards' {
        InModuleScope AITriad -Parameters @{ Ref = $script:Ref } {
            param($Ref)
            Mock Invoke-RestMethod -ParameterFilter { $Method -eq 'PUT' } { $script:TagState = "sha256:$('f' * 64)" }
            { Set-TaxEditorPinnedTag -ImageRef $Ref -RunId '123' -Confirm:$false } | Should -Throw '*After the PUT*'
        }
    }

    It 'refuses a tag-only image ref, before any registry call' {
        InModuleScope AITriad {
            { Set-TaxEditorPinnedTag -ImageRef 'ghcr.io/ai-rosetta-stone/taxonomy-editor:sha-4b8d8830' -RunId '123' -Confirm:$false } |
                Should -Throw '*not digest-pinned*'
            Should -Invoke Get-GhcrAuthToken -Times 0
            Should -Invoke Invoke-WebRequest -Times 0
        }
    }

    It '-WhatIf makes no registry call' {
        InModuleScope AITriad -Parameters @{ Ref = $script:Ref } {
            param($Ref)
            Set-TaxEditorPinnedTag -ImageRef $Ref -RunId '123' -WhatIf
            Should -Invoke Get-GhcrAuthToken -Times 0
            Should -Invoke Invoke-RestMethod -Times 0
        }
    }
}

Describe 'Cleanup keeps the digest a deploy pinned after sha-COMMIT moves (t/121, both arms)' -Tag 'health' {
    BeforeAll {
        $script:PinnedHex = '1' * 64
        $script:Pinned    = "sha256:$($script:PinnedHex)"   # the index prod's revision is pinned to
        $script:PinnedRef = "ghcr.io/ai-rosetta-stone/taxonomy-editor@$($script:Pinned)"
    }

    BeforeEach {
        InModuleScope AITriad { $env:GITHUB_TOKEN = 'fake-token' }
    }

    # The registry after a container.yml re-run for the same commit: sha-abc now names the
    # rebuilt index; the index prod pinned carries only $PinnedTags (none on main before t/121).
    function script:Invoke-CleanupAfterRerun([string[]]$PinnedTags) {
        InModuleScope AITriad -Parameters @{ PinnedTags = $PinnedTags; Pinned = $script:Pinned } {
            param($PinnedTags, $Pinned)
            $oldIso = (Get-Date).AddDays(-90).ToUniversalTime().ToString('o')
            $newIso = (Get-Date).AddDays(-60).ToUniversalTime().ToString('o')
            $mk = { param($id, $digest, $iso, $tags) [PSCustomObject]@{
                id = $id; updated_at = $iso; name = $digest
                metadata = [PSCustomObject]@{ container = [PSCustomObject]@{ tags = @($tags) } } } }
            $versions = @(
                & $mk 900 'sha256:rebuilt'       $newIso @('sha-abc')     # re-run: sha-abc moved here
                & $mk 901 'sha256:rebuiltamd64'  $newIso @()
                & $mk 910 $Pinned                $oldIso @($PinnedTags)   # what prod's revision pulls
                & $mk 911 'sha256:pinnedamd64'   $oldIso @()
                & $mk 912 'sha256:pinnedattest'  $oldIso @()
                & $mk 920 'sha256:orphan'        $oldIso @()              # nothing pins or tags it
            )
            $script:DeletedIds = [System.Collections.Generic.List[long]]::new()
            Mock Invoke-GitHubApi -ParameterFilter { $Method -eq 'GET' } -MockWith { ,$versions }
            Mock Invoke-GitHubApi -ParameterFilter { $Method -eq 'DELETE' } -MockWith {
                if ($Endpoint -match '/versions/(\d+)$') { $script:DeletedIds.Add([long]$Matches[1]) }
            }
            Mock Get-GhcrAuthToken { 'fake-pull-token' }
            Mock Get-GhcrManifestChildDigest -MockWith {
                switch ($Reference) {
                    'sha256:rebuilt' { 'sha256:rebuiltamd64' }
                    $Pinned          { 'sha256:pinnedamd64'; 'sha256:pinnedattest' }
                }
            }
            $null = Remove-StaleContainerImages -Package 'taxonomy-editor' -Owner 'test-owner' `
                -KeepLatest 0 -OlderThanDays 30 -Confirm:$false
            @($script:DeletedIds | Sort-Object)
        }
    }

    It 'PASS arm: the tag Set-TaxEditorPinnedTag writes keeps the pinned index and its children; the orphan is still deleted' {
        # Run the real shim against a fake registry and take the tag name from its actual PUT.
        $pinTag = InModuleScope AITriad -Parameters @{ Ref = $script:PinnedRef; Pinned = $script:Pinned } {
            param($Ref, $Pinned)
            $script:PutUri = $null
            Mock Get-GhcrAuthToken { 'fake-ghcr-token' }
            Mock Invoke-WebRequest {
                if ($Uri -like '*/manifests/sha256:*') {
                    return [pscustomobject]@{ StatusCode = 200; Content = '{}'; Headers = @{ 'Content-Type' = 'application/vnd.oci.image.index.v1+json'; 'Docker-Content-Digest' = $Pinned } }
                }
                if ($script:PutUri) { return [pscustomobject]@{ StatusCode = 200; Content = '{}'; Headers = @{ 'Docker-Content-Digest' = $Pinned } } }
                [pscustomobject]@{ StatusCode = 404; Content = ''; Headers = @{} }
            }
            Mock Invoke-RestMethod -ParameterFilter { $Method -eq 'PUT' } { $script:PutUri = $Uri }
            $null = Set-TaxEditorPinnedTag -ImageRef $Ref -RunId '42621970336' -Confirm:$false
            ($script:PutUri -split '/manifests/')[-1]
        }
        $pinTag | Should -Match '^pinned-42621970336-1{12}$'

        $deleted = Invoke-CleanupAfterRerun -PinnedTags @($pinTag)
        $deleted | Should -Be @(920)
        $deleted | Should -Not -Contain 910
        $deleted | Should -Not -Contain 911
        $deleted | Should -Not -Contain 912
    }

    It 'FAIL arm (main before t/121): with no pinned tag the pinned index and its children ARE deleted' {
        $deleted = Invoke-CleanupAfterRerun -PinnedTags @()
        $deleted | Should -Contain 910
        $deleted | Should -Contain 911
        $deleted | Should -Contain 912
    }

    It 'rule 2 protects a pinned-* digest on its own, even if listed again untagged' {
        InModuleScope AITriad {
            $old = [datetimeoffset]::UtcNow.AddDays(-90).ToString('o')
            $versions = @(
                [pscustomobject]@{ id = 1; name = 'sha256:p'; updated_at = $old
                    metadata = [pscustomobject]@{ container = [pscustomobject]@{ tags = @('pinned-1-pppppppppppp') } } }
                [pscustomobject]@{ id = 2; name = 'sha256:p'; updated_at = $old
                    metadata = [pscustomobject]@{ container = [pscustomobject]@{ tags = @() } } }
                [pscustomobject]@{ id = 3; name = 'sha256:o'; updated_at = $old
                    metadata = [pscustomobject]@{ container = [pscustomobject]@{ tags = @() } } }
            )
            $v = Get-StaleImageDeletionVerdict -Versions $versions -Cutoff ([datetimeoffset]::UtcNow.AddDays(-30)) -KeepLatest 0
            @($v.ToDelete.id) | Should -Be @(3)
            @($v.Protected.id) | Should -Be @(2)
        }
    }
}

Describe 'deploy-azure.yml wiring (t/121, t/121#5)' -Tag 'health' {
    BeforeAll {
        $script:Wf = (Get-Content (Join-Path $script:Root '.github' 'workflows' 'deploy-azure.yml') -Raw) -replace "`r`n", "`n"
        # The text of one top-level job (from '  <name>:' to the next '  <job>:' line).
        function script:Get-WfJob([string]$Name) {
            $m = [regex]::Match($script:Wf, "(?ms)^  $([regex]::Escape($Name)):\s*\n(.*?)(?=^  [A-Za-z0-9_-]+:\s*$|\z)")
            if (-not $m.Success) { throw "job '$Name' not found in deploy-azure.yml" }
            $m.Groups[1].Value
        }
        # A job-level key (4-space indent), for example needs, if, continue-on-error.
        function script:Get-WfJobKey([string]$Job, [string]$Key) {
            $m = [regex]::Match($Job, "(?m)^    $([regex]::Escape($Key)):[ \t]*([^\n#]*?)[ \t]*(#[^\n]*)?$")
            if ($m.Success) { $m.Groups[1].Value } else { $null }
        }
        function script:Get-WfNeeds([string]$Job) {
            $v = Get-WfJobKey $Job 'needs'
            if (-not $v) { return @() }
            @(($v.Trim('[', ']') -split ',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
        }
        function script:Get-WfPermissions([string]$Job) {
            $perm = [regex]::Match($Job, '(?s)\n    permissions:\n(.*?)\n    steps:').Groups[1].Value
            @($perm -split "`n" | Where-Object { $_ -match '^      [a-z-]+:\s*[a-z]+' } | ForEach-Object { ($_ -replace '#.*$', '').Trim() })
        }
        $script:Pin    = Get-WfJob 'pin-digest'
        $script:Deploy = Get-WfJob 'deploy'
        $script:TagKg  = Get-WfJob 'tag-known-good'
        $script:PreflightOnly = '${{ !cancelled() && needs.preflight.result == ''success'' }}'
    }

    It 'pin-digest runs after preflight and BEFORE deploy (deploy needs it)' {
        Get-WfNeeds $script:Pin | Should -Be @('preflight')
        Get-WfNeeds $script:Deploy | Should -Contain 'pin-digest'
        Get-WfNeeds $script:Deploy | Should -Contain 'preflight'
        $script:Wf.IndexOf("`n  pin-digest:") | Should -BeLessThan $script:Wf.IndexOf("`n  deploy:")
    }

    It 'pin-digest does NOT gate deploy: deploy''s if reads preflight only, with !cancelled()' {
        $if = Get-WfJobKey $script:Deploy 'if'
        $if | Should -Be $script:PreflightOnly
        $if | Should -Not -Match 'pin-digest'
    }

    It 'pin-digest runs whenever preflight succeeded (explicit !cancelled(), Check 5)' {
        Get-WfJobKey $script:Pin 'if' | Should -Be $script:PreflightOnly
    }

    It 'pin-digest is warn-only: job and step continue-on-error, try/catch, ::warning:: and a WARN' {
        Get-WfJobKey $script:Pin 'continue-on-error' | Should -Be 'true'
        $step = [regex]::Match($script:Pin, '(?s)- name: Tag the digest this deploy will pin.*\z').Value
        $step | Should -Match 'continue-on-error: true'
        $step | Should -Match '(?s)try \{.*Set-TaxEditorPinnedTag -ImageRef \$env:DEPLOYED_IMAGE_REF -RunId \$env:RUN_ID -Confirm:\$false.*\} catch \{'
        $step | Should -Match 'DEPLOYED_IMAGE_REF: \$\{\{ needs\.preflight\.outputs\.image_ref \}\}'
        $step | Should -Match '::warning::t/121'
        $step | Should -Match 'Write-Warning'
    }

    It 'pin-digest has packages:write scoped to itself only, and no Azure identity' {
        Get-WfPermissions $script:Pin | Should -Be @('contents: read', 'packages: write')
        $script:Pin | Should -Not -Match 'azure/login'
        Get-WfJobKey $script:Pin 'environment' | Should -BeNullOrEmpty
    }

    It 'preflight and deploy gain no job permissions; the workflow default stays packages: read' {
        (Get-WfJob 'preflight') | Should -Not -Match '(?m)^    permissions:'
        $script:Deploy | Should -Not -Match '(?m)^    permissions:'
        $script:Wf | Should -Match '(?m)^  packages: read'
    }

    It 'tag-known-good keeps exactly its existing permissions' {
        Get-WfPermissions $script:TagKg | Should -Be @('contents: read', 'id-token: write', 'packages: write')
    }

    It 'the post-deploy retry uses the same inputs (same tag, so AlreadyPinned), runs before known-good, warn-only' {
        $step = [regex]::Match($script:TagKg, '(?s)- name: Re-check the pinned tag.*?(?=\n      - name: )').Value
        $step | Should -Not -BeNullOrEmpty
        $step | Should -Match 'continue-on-error: true'
        $step | Should -Match 'Set-TaxEditorPinnedTag -ImageRef \$env:DEPLOYED_IMAGE_REF -RunId \$env:RUN_ID -Confirm:\$false'
        $step | Should -Match 'DEPLOYED_IMAGE_REF: \$\{\{ needs\.preflight\.outputs\.image_ref \}\}'
        $step | Should -Not -Match 'RunAttempt|run_attempt'
        $step | Should -Match '::warning::t/121'
        $script:TagKg.IndexOf('Set-TaxEditorPinnedTag') | Should -BeLessThan $script:TagKg.IndexOf('Set-TaxEditorKnownGood -')
    }

    It 'only deploy-azure.yml calls Set-TaxEditorPinnedTag: once in pin-digest, once in tag-known-good' {
        $calls = @(Get-ChildItem (Join-Path $script:Root '.github' 'workflows') -File -Filter *.yml |
            Select-String -Pattern '^\s*[^#]*Set-TaxEditorPinnedTag\s+-' |
            ForEach-Object { Split-Path $_.Path -Leaf })
        $calls | Should -Be @('deploy-azure.yml', 'deploy-azure.yml')
        @([regex]::Matches($script:Pin, '(?m)^[^#\n]*Set-TaxEditorPinnedTag\s+-')).Count | Should -Be 1
        @([regex]::Matches($script:TagKg, '(?m)^[^#\n]*Set-TaxEditorPinnedTag\s+-')).Count | Should -Be 1
    }
}
