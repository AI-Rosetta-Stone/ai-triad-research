# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# t/4096: the org move rewrites the repo OWNER and must leave the jpsnover USER IDENTITY alone.

BeforeAll {
    . (Join-Path $PSScriptRoot '..' 'operations' 'devops' 'Rename-GitHubOwner.ps1')
    $script:Rules = Get-OwnerRenameRules -OldOwner 'jpsnover' -RepoOwner 'AI-Rosetta-Stone'
    function Convert-Line([string] $Text) {
        (Convert-OwnerText -Text $Text -Rules $script:Rules -OldOwner 'jpsnover').Text
    }
}

Describe 'Rename-GitHubOwner: owner references change' {
    It 'rewrites repo references with the org name as given' {
        Convert-Line 'gh api repos/jpsnover/ai-triad-research/branches/main' |
            Should -Be 'gh api repos/AI-Rosetta-Stone/ai-triad-research/branches/main'
        Convert-Line 'https://github.com/jpsnover/ai-triad-data.git' |
            Should -Be 'https://github.com/AI-Rosetta-Stone/ai-triad-data.git'
        Convert-Line 'repository: jpsnover/ai-triad-sources' |
            Should -Be 'repository: AI-Rosetta-Stone/ai-triad-sources'
    }

    It 'rewrites a shell default whose owner follows ":-"' {
        Convert-Line 'REPO="${GITHUB_REPO:-jpsnover/ai-triad-data}"' |
            Should -Be 'REPO="${GITHUB_REPO:-AI-Rosetta-Stone/ai-triad-data}"'
    }

    It 'lowercases image references, because docker rejects capitals' {
        Convert-Line 'FROM ghcr.io/jpsnover/ai-triad-base:2026-10-01@sha256:abc' |
            Should -Be 'FROM ghcr.io/ai-rosetta-stone/ai-triad-base:2026-10-01@sha256:abc'
        Convert-Line "[string]`$Package = 'jpsnover/taxonomy-editor'" |
            Should -Be "[string]`$Package = 'ai-rosetta-stone/taxonomy-editor'"
        Convert-Line "grep -oP 'FROM ghcr\.io/jpsnover/ai-triad-base:\K\S+'" |
            Should -Be "grep -oP 'FROM ghcr\.io/ai-rosetta-stone/ai-triad-base:\K\S+'"
    }

    It 'pins an IMAGE_NAME built from github.repository_owner to the lowercase owner' {
        Convert-Line '  IMAGE_NAME: ${{ github.repository_owner }}/taxonomy-editor' |
            Should -Be '  IMAGE_NAME: ai-rosetta-stone/taxonomy-editor'
    }

    It 'moves the GHCR packages API from the user endpoints to the org endpoint' {
        Convert-Line '-Endpoint "/users/$Owner/packages/container/$Package/versions"' |
            Should -Be '-Endpoint "/orgs/$Owner/packages/container/$Package/versions"'
        Convert-Line 'TAGS=$(gh api user/packages/container/ai-triad-base/versions --jq x)' |
            Should -Be 'TAGS=$(gh api orgs/ai-rosetta-stone/packages/container/ai-triad-base/versions --jq x)'
    }

    It 'rewrites owners held in a variable, a default, a param or a doc row' {
        Convert-Line '  OWNER: jpsnover' | Should -Be '  OWNER: ai-rosetta-stone'
        Convert-Line "const GITHUB_OWNER = process.env.GITHUB_OWNER || 'jpsnover';" |
            Should -Be "const GITHUB_OWNER = process.env.GITHUB_OWNER || 'AI-Rosetta-Stone';"
        Convert-Line "param githubOwner string = 'jpsnover'" | Should -Be "param githubOwner string = 'AI-Rosetta-Stone'"
        Convert-Line "else { 'jpsnover' }" | Should -Be "else { 'ai-rosetta-stone' }"
        Convert-Line '| `GITHUB_OWNER` | `jpsnover` | Repository owner |' |
            Should -Be '| `GITHUB_OWNER` | `AI-Rosetta-Stone` | Repository owner |'
    }
}

Describe 'Rename-GitHubOwner: the user identity does not change' {
    It 'leaves <Text> alone and reports it as residue' -ForEach @(
        @{ Text = '"github": "jpsnover"' }
        @{ Text = "Reset-TaxEditorSession -UserId 'jpsnover'" }
        @{ Text = 'groupId: "calibration:jpsnover"' }
        @{ Text = '/api/admin/review/detail/calibration%3Ajpsnover' }
        @{ Text = "path.resolve(DATA_ROOT, 'users/jpsnover/chats/chat-c1.json')" }
        @{ Text = "Restore-TaxEditorBlob -Container 'users' -Path 'jpsnover/chats/chat-123.json'" }
        @{ Text = 'cc @jpsnover' }
        @{ Text = "OWNER_HANDLE: 'jpsnover'" }
        @{ Text = 'ai-triad-reviewer-jpsnover' }
        @{ Text = 'ai-triad-reviewer-jpsnover/ai-triad-research' }
    ) {
        $r = Convert-OwnerText -Text $Text -Rules $script:Rules -OldOwner 'jpsnover'
        $r.Text | Should -Be $Text
        @($r.Residue).Count | Should -Be 1
    }

    It 'leaves a non-owned repo name under the old owner alone' {
        Convert-Line 'jpsnover/dotfiles' | Should -Be 'jpsnover/dotfiles'
        Convert-Line 'jpsnover/ai-triad-data-archive' | Should -Be 'jpsnover/ai-triad-data-archive'
    }

    It 'is idempotent: a second pass changes nothing' {
        $once = Convert-Line 'FROM ghcr.io/jpsnover/taxonomy-editor:latest # jpsnover/ai-triad-research'
        Convert-Line $once | Should -Be $once
    }
}

Describe 'Rename-GitHubOwner: file handling' {
    BeforeEach {
        $script:Repo = Join-Path $TestDrive ([guid]::NewGuid().ToString('n'))
        New-Item -ItemType Directory -Path $script:Repo | Out-Null
        git -C $script:Repo init -q
        git -C $script:Repo config user.email t@example.com
        git -C $script:Repo config user.name t
    }

    It 'preserves a UTF-8 BOM and CRLF line endings' {
        $p = Join-Path $script:Repo 'a.ps1'
        $bom = [byte[]](0xEF, 0xBB, 0xBF)
        $body = [System.Text.Encoding]::UTF8.GetBytes("`$x = 'jpsnover/taxonomy-editor'`r`n`$u = 'jpsnover'`r`n")
        [System.IO.File]::WriteAllBytes($p, $bom + $body)
        git -C $script:Repo add a.ps1
        $null = Invoke-OwnerRename -RepoRoot $script:Repo -RepoOwner 'AI-Rosetta-Stone' -OldOwner 'jpsnover' -Confirm:$false
        $bytes = [System.IO.File]::ReadAllBytes($p)
        $bytes[0..2] | Should -Be $bom
        $text = [System.Text.Encoding]::UTF8.GetString($bytes, 3, $bytes.Length - 3)
        $text | Should -Be "`$x = 'ai-rosetta-stone/taxonomy-editor'`r`n`$u = 'jpsnover'`r`n"
    }

    It '-WhatIf writes nothing' {
        $p = Join-Path $script:Repo 'b.yml'
        Set-Content -LiteralPath $p -Value 'repository: jpsnover/ai-triad-data' -NoNewline
        git -C $script:Repo add b.yml
        $report = @(Invoke-OwnerRename -RepoRoot $script:Repo -RepoOwner 'AI-Rosetta-Stone' -OldOwner 'jpsnover' -WhatIf)
        Get-Content -LiteralPath $p -Raw | Should -Be 'repository: jpsnover/ai-triad-data'
        @($report | Where-Object Changed).Count | Should -Be 1
    }

    It 'refuses a path that is not a git checkout' {
        { Invoke-OwnerRename -RepoRoot $TestDrive -RepoOwner 'X' -OldOwner 'jpsnover' } |
            Should -Throw '*Next Steps:*'
    }
}
