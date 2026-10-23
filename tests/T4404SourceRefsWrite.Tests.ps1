# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# t/4404 T2 writer (scripts/data-mutations/t4404/Invoke-T4404SourceRefsWrite.mjs): the proofs and refusals on a
# temp data repo, so the real entities.json is never touched.

BeforeAll {
    $script:Writer = Join-Path $PSScriptRoot '..' 'scripts' 'data-mutations' 't4404' 'Invoke-T4404SourceRefsWrite.mjs'
    function script:Sha([string]$s) { -join ([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($s)) | ForEach-Object { $_.ToString('x2') }) }
    function script:Canon($o) {
        $tmp = New-TemporaryFile
        [IO.File]::WriteAllText($tmp, ($o | ConvertTo-Json -Depth 10 -Compress), [Text.UTF8Encoding]::new($false))
        $out = node -e "process.stdout.write(JSON.stringify(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')),null,2)+'\n')" $tmp.FullName
        Remove-Item $tmp
        ($out -join "`n") + "`n"
    }
    function script:New-Fixture {
        $root = Join-Path ([IO.Path]::GetTempPath()) ("t4404-" + [guid]::NewGuid().ToString('N'))
        $dir = Join-Path $root 'taxonomy' 'Origin'
        New-Item -ItemType Directory -Force $dir | Out-Null
        $store = [ordered]@{
            _schema_version = 1; entity_count = 3; last_modified = '2026-10-01T00:00:00Z'
            entities = @(
                [ordered]@{ id = 'ent-001'; name = 'A'; source_refs = @('d1', 'd2', 'd3'); status = 'approved' }
                [ordered]@{ id = 'ent-002'; name = 'B'; source_refs = @('d2', 'd4'); status = 'approved' }
                [ordered]@{ id = 'ent-003'; name = 'C'; source_refs = @('d9'); status = 'deprecated' }
            )
        }
        $text = Canon $store
        [IO.File]::WriteAllText((Join-Path $dir 'entities.json'), $text, [Text.UTF8Encoding]::new($false))
        git -C $root init -q; git -C $root -c user.email=t@t -c user.name=t add -A; git -C $root -c user.email=t@t -c user.name=t commit -qm init
        $frozen = [ordered]@{
            inputs = [ordered]@{ entities_pre_sha256 = (Sha $text) }
            entities = @(
                [ordered]@{ id = 'ent-001'; old_source_refs = @('d1', 'd2', 'd3'); source_refs = @('d2'); source_refs_basis = [ordered]@{ d2 = 'quote-attributed' }; source_refs_status = 'attributed' }
                [ordered]@{ id = 'ent-002'; old_source_refs = @('d2', 'd4'); source_refs = @(); source_refs_basis = [ordered]@{}; source_refs_status = 'none-matched' }
            )
        }
        $fp = Join-Path $root 'frozen.json'
        [IO.File]::WriteAllText($fp, ($frozen | ConvertTo-Json -Depth 8) + "`n", [Text.UTF8Encoding]::new($false))
        [pscustomobject]@{ Root = $root; Ent = (Join-Path $dir 'entities.json'); Frozen = $fp; Text = $text; FrozenSha = (Sha (([IO.File]::ReadAllText($fp)) -replace "`r`n", "`n")) }
    }
    function script:Run($fx, [string[]]$More) {
        $out = node $script:Writer --data-dir $fx.Root --frozen $fx.Frozen @More 2>&1
        [pscustomobject]@{ Code = $LASTEXITCODE; Out = ($out -join "`n") }
    }
}

Describe 'Invoke-T4404SourceRefsWrite.mjs' {
    BeforeEach { $script:fx = New-Fixture }
    AfterEach { Remove-Item -Recurse -Force $script:fx.Root -ErrorAction SilentlyContinue }

    It 'dry-run proves the write and leaves the file untouched' {
        $r = Run $fx @()
        $r.Code | Should -Be 0 -Because $r.Out
        $r.Out | Should -Match 'proof OK: 2 targets'
        [IO.File]::ReadAllText($fx.Ent) | Should -BeExactly $fx.Text
    }

    It 'dry-run accepts a CRLF working tree (eol=lf blob) and compares LF-normalized' {
        [IO.File]::WriteAllText($fx.Ent, ($fx.Text -replace "`n", "`r`n"), [Text.UTF8Encoding]::new($false))
        (Run $fx @()).Code | Should -Be 0
    }

    It 'apply refuses without the approved hash, and with a wrong one' {
        (Run $fx @('--mode', 'apply')).Out | Should -Match 'approved-sha256 is required'
        $r = Run $fx @('--mode', 'apply', '--approved-sha256', ('0' * 64))
        $r.Code | Should -Be 1
        $r.Out | Should -Match 'is not the approved'
        [IO.File]::ReadAllText($fx.Ent) | Should -BeExactly $fx.Text
    }

    It 'refuses when entities.json changed since the freeze' {
        [IO.File]::WriteAllText($fx.Ent, $fx.Text.Replace('"B"', '"B2"'), [Text.UTF8Encoding]::new($false))
        (Run $fx @()).Out | Should -Match 'changed since the freeze'
    }

    It 'apply refuses a target file with uncommitted changes' {
        # The committed blob differs from the working file the freeze hashed: someone else's WIP is in the tree.
        $bytes = [Text.UTF8Encoding]::new($false)
        [IO.File]::WriteAllText($fx.Ent, $fx.Text.Replace('"B"', '"B0"'), $bytes)
        git -C $fx.Root -c user.email=t@t -c user.name=t commit -qam base
        [IO.File]::WriteAllText($fx.Ent, $fx.Text, $bytes)
        $r = Run $fx @('--mode', 'apply', '--approved-sha256', $fx.FrozenSha)
        $r.Code | Should -Be 1
        $r.Out | Should -Match 'uncommitted changes'
    }

    It 'apply writes exactly the frozen fields, and revert restores the bytes' {
        $r = Run $fx @('--mode', 'apply', '--approved-sha256', $fx.FrozenSha)
        $r.Code | Should -Be 0 -Because $r.Out
        $after = Get-Content -Raw $fx.Ent | ConvertFrom-Json
        $after.entities[0].source_refs | Should -Be @('d2')
        $after.entities[0].PSObject.Properties.Name | Should -Be @('id', 'name', 'source_refs', 'source_refs_basis', 'source_refs_status', 'status')
        @($after.entities[1].source_refs).Count | Should -Be 0
        $after.entities[1].source_refs_status | Should -Be 'none-matched'
        $after.entities[2].PSObject.Properties.Name | Should -Not -Contain 'source_refs_basis'
        (Run $fx @('--mode', 'revert')).Code | Should -Be 0
        [IO.File]::ReadAllText($fx.Ent) | Should -BeExactly $fx.Text
    }

    It 'refuses a frozen entry that would add a doc from outside the current list' {
        $fz = [IO.File]::ReadAllText($fx.Frozen) | ConvertFrom-Json
        $fz.entities[0].source_refs = @('d7'); $fz.entities[0].source_refs_basis = [pscustomobject]@{ d7 = 'mention-verified' }
        [IO.File]::WriteAllText($fx.Frozen, ($fz | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
        (Run $fx @()).Out | Should -Match 'a doc outside the current list'
    }

    It 'refuses when a target already carries the added keys' {
        $s = $fx.Text | ConvertFrom-Json
        $s.entities[0] | Add-Member source_refs_status 'attributed'
        $t = Canon $s
        [IO.File]::WriteAllText($fx.Ent, $t, [Text.UTF8Encoding]::new($false))
        $fz = [IO.File]::ReadAllText($fx.Frozen) -replace [regex]::Escape((Sha $fx.Text)), (Sha $t)
        [IO.File]::WriteAllText($fx.Frozen, $fz, [Text.UTF8Encoding]::new($false))
        (Run $fx @()).Out | Should -Match 'already has the added keys'
    }
}
