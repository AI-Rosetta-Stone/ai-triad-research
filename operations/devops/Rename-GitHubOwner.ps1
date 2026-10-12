# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
Rewrites the repo OWNER references for the move from the jpsnover account to a GitHub organization (t/4096).

.DESCRIPTION
"jpsnover" means two different things in this codebase, and only one of them moves:

  * The REPO OWNER: jpsnover/ai-triad-research, ghcr.io/jpsnover/taxonomy-editor, the GHCR packages API.
    These change to the organization.
  * The USER IDENTITY: ALLOWED_USERS entries, "calibration:jpsnover", "@jpsnover", users/jpsnover/...
    data paths, the App name ai-triad-reviewer-jpsnover. These are the PI's login and MUST NOT change;
    rewriting them would break sign-in and orphan the user's data.

So this is an exact mapping over the owner shapes, never a blind s/jpsnover/<org>/. Every jpsnover hit it
leaves alone is reported as residue, so a reviewer can confirm each one is an identity.

Container image references must be lowercase, while GitHub accepts any case, so the two get different
spellings: repo references use -RepoOwner as given (AI-Rosetta-Stone), and image references and the
packages API use its lowercase form (ai-rosetta-stone). Workflows that build IMAGE_NAME from
${{ github.repository_owner }} are pinned to the lowercase owner, because after the transfer that
expression yields the mixed-case org name and docker rejects it.

The GHCR packages API differs by owner type: /users/<u>/packages and user/packages (the authenticated
user) do not find an organization's packages; they become /orgs/<org>/packages.

Run with -WhatIf first: it lists every change and every residue line without writing.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [string] $RepoRoot = (Get-Location).Path,
    [string] $RepoOwner,
    [string] $OldOwner = 'jpsnover',
    [switch] $PassThru
)

Set-StrictMode -Version Latest

# Names the old owner owns, split by which spelling they take after the move.
$script:RepoNames  = @('ai-triad-research', 'ai-triad-data', 'ai-triad-sources')
$script:ImageNames = @('taxonomy-editor', 'ai-triad-base')

function Get-OwnerRenameRules {
    # PURE: the ordered rewrite rules for one old-owner -> new-owner move.
    param(
        [Parameter(Mandatory)][string] $OldOwner,
        [Parameter(Mandatory)][string] $RepoOwner
    )
    $old   = [regex]::Escape($OldOwner)
    $image = $RepoOwner.ToLowerInvariant()
    $repos = ($script:RepoNames  | ForEach-Object { [regex]::Escape($_) }) -join '|'
    $imgs  = ($script:ImageNames | ForEach-Object { [regex]::Escape($_) }) -join '|'
    # An owner reference is "<old>/<owned name>" with nothing name-like on either side, so
    # users/jpsnover/chats and ai-triad-reviewer-jpsnover never match. A hyphen is refused only
    # after a name character (ai-triad-reviewer-jpsnover), so a shell default like
    # ${GITHUB_REPO:-jpsnover/ai-triad-data} still matches.
    $before = '(?<![A-Za-z0-9_]|[A-Za-z0-9]-)'
    $after  = '(?![A-Za-z0-9_-])'
    @(
        [pscustomobject]@{ Name = 'repo-ref';  Pattern = "$before$old/(?=(?:$repos)$after)"; Replacement = "$RepoOwner/" }
        [pscustomobject]@{ Name = 'image-ref'; Pattern = "$before$old/(?=(?:$imgs)$after)";  Replacement = "$image/" }
        [pscustomobject]@{ Name = 'image-name-from-owner'; Pattern = '\$\{\{\s*github\.repository_owner\s*\}\}/(?=(?:' + $imgs + ')' + $after + ')'; Replacement = "$image/" }
        [pscustomobject]@{ Name = 'packages-api-users';    Pattern = '/users/\$Owner/packages/'; Replacement = '/orgs/$Owner/packages/' }
        [pscustomobject]@{ Name = 'packages-api-authuser'; Pattern = '(?<![A-Za-z0-9_/-])user/packages/container/'; Replacement = "orgs/$image/packages/container/" }
        # Owner held in a variable or default rather than an owner/name path.
        [pscustomobject]@{ Name = 'owner-env';     Pattern = "(?m)^(\s*OWNER:\s*)$old\s*$"; Replacement = "`${1}$image" }
        [pscustomobject]@{ Name = 'owner-default'; Pattern = "(GITHUB_OWNER\s*\|\|\s*')$old(')"; Replacement = "`${1}$RepoOwner`${2}" }
        [pscustomobject]@{ Name = 'owner-param';   Pattern = "(githubOwner\s+string\s*=\s*')$old(')"; Replacement = "`${1}$RepoOwner`${2}" }
        [pscustomobject]@{ Name = 'owner-doc-row'; Pattern = "(\|\s*``GITHUB_OWNER``\s*\|\s*``)$old(``)"; Replacement = "`${1}$RepoOwner`${2}" }
        [pscustomobject]@{ Name = 'ghcr-owner-fallback'; Pattern = "(else\s*\{\s*')$old('\s*\})"; Replacement = "`${1}$image`${2}" }
        [pscustomobject]@{ Name = 'ghcr-owner-doc';      Pattern = "(GITHUB_REPOSITORY_OWNER, then ')$old(')"; Replacement = "`${1}$image`${2}" }
    )
}

function Convert-OwnerText {
    # PURE: applies the rules to one file's text. Returns the new text, the per-rule hit counts and
    # the lines that still mention the old owner (the residue a reviewer checks).
    param(
        [Parameter(Mandatory)][AllowEmptyString()][string] $Text,
        [Parameter(Mandatory)][object[]] $Rules,
        [Parameter(Mandatory)][string] $OldOwner
    )
    $hits = [ordered]@{}
    $new  = $Text
    foreach ($rule in $Rules) {
        $count = ([regex]::Matches($new, $rule.Pattern)).Count
        if ($count -gt 0) {
            $hits[$rule.Name] = $count
            $new = [regex]::Replace($new, $rule.Pattern, $rule.Replacement)
        }
    }
    $residue = @()
    $lineNo = 0
    foreach ($line in ($new -split "`n")) {
        $lineNo++
        if ($line -match [regex]::Escape($OldOwner)) {
            $residue += [pscustomobject]@{ Line = $lineNo; Text = $line.TrimEnd("`r").Trim() }
        }
    }
    [pscustomobject]@{ Text = $new; Hits = $hits; Residue = $residue }
}

function Invoke-OwnerRename {
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)][string] $RepoRoot,
        [Parameter(Mandatory)][string] $RepoOwner,
        [Parameter(Mandatory)][string] $OldOwner
    )
    if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot '.git'))) {
        throw ("Goal: rewrite owner references for the organization move.`n" +
               "Problem: '$RepoRoot' is not the root of a git checkout.`n" +
               "Location: Rename-GitHubOwner.ps1, Invoke-OwnerRename.`n" +
               "Next Steps: pass -RepoRoot pointing at the repo root (or a worktree root).")
    }
    $rules = Get-OwnerRenameRules -OldOwner $OldOwner -RepoOwner $RepoOwner
    $files = @(git -C $RepoRoot grep -l -I -F -- $OldOwner) + @(git -C $RepoRoot grep -l -I -F -- 'github.repository_owner') +
             @(git -C $RepoRoot grep -l -I -E -- '(/users/\$Owner/packages/|user/packages/container/)') |
             Where-Object { $_ } | Sort-Object -Unique
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    foreach ($rel in $files) {
        $path  = Join-Path $RepoRoot $rel
        $bytes = [System.IO.File]::ReadAllBytes($path)
        $hasBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
        $text  = $utf8NoBom.GetString($bytes, ($hasBom ? 3 : 0), $bytes.Length - ($hasBom ? 3 : 0))
        $result = Convert-OwnerText -Text $text -Rules $rules -OldOwner $OldOwner
        $changed = $result.Text -ne $text
        if ($changed -and $PSCmdlet.ShouldProcess($rel, "rewrite owner references ($(($result.Hits.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ', '))")) {
            $enc = [System.Text.UTF8Encoding]::new($hasBom)
            [System.IO.File]::WriteAllText($path, $result.Text, $enc)
        }
        [pscustomobject]@{
            Path    = $rel
            Changed = $changed
            Hits    = $result.Hits
            Residue = $result.Residue
        }
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    if ([string]::IsNullOrWhiteSpace($RepoOwner)) {
        throw ("Goal: rewrite owner references for the organization move.`n" +
               "Problem: -RepoOwner was not given.`n" +
               "Location: Rename-GitHubOwner.ps1.`n" +
               "Next Steps: pass the organization name, e.g. -RepoOwner AI-Rosetta-Stone, and run with -WhatIf first.")
    }
    $report = @(Invoke-OwnerRename -RepoRoot $RepoRoot -RepoOwner $RepoOwner -OldOwner $OldOwner)
    $changed = @($report | Where-Object Changed)
    $residue = @($report | Where-Object { @($_.Residue).Count -gt 0 })
    Write-Host ("{0} file(s) with owner references rewritten; {1} file(s) keep '{2}' as residue (identity, review below)." -f $changed.Count, $residue.Count, $OldOwner)
    foreach ($f in $residue) {
        foreach ($r in $f.Residue) { Write-Host ("  RESIDUE {0}:{1}: {2}" -f $f.Path, $r.Line, $r.Text) }
    }
    if ($PassThru) { $report }
}
