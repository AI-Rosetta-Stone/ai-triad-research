# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Scheduled drift check for the fleet's shared main checkout (t/2452).
.DESCRIPTION
    Checks the shared main checkout for: commits behind origin/main, uncommitted
    tracked files (classified as 0-diff-safe or real WIP), 0-byte untracked junk
    files, and non-0-byte extension-less untracked files in source directories
    (t/2222 spray pattern + t/2473 extension; excluding linked worktrees).

    Contract (TL-approved, t/2452#4 + t/2476 amendment):
      - Always exits 0; git failures are best-effort skips.
      - SILENT on a clean + current tree (Alarm=$false, no output beyond the object).
      - Returns a PSCustomObject for the calling agent to interpret and ping on.
      - Cadence: 60 min (hourly backstop via Orca reminder; proportionate given the
        dev-start hook in check-drift.cjs already covers the acute at-dev-time case).
      - AUTO-REMEDIATES 0-byte JunkPaths with triple guard (t/2476): files that pass
        all three checks are deleted and logged in AutoRemoved. SuspiciousPaths, real
        WIP, and behind-count remain WARN-ONLY (agent ping required).

    Seeded-arm proofs must use a disposable clone (-RepoRoot <clone>), NOT the live
    shared tree. Only the clean arm runs against the real checkout.
.PARAMETER RepoRoot
    Absolute path to the shared main checkout. Defaults to the standard fleet path.
    Pass a disposable clone path when running proof/test arms.
#>

param(
    [string]$RepoRoot = 'C:\Users\jsnov\repos\ai-triad-research'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

function Invoke-Git {
    param([string[]]$GitArgs, [int]$TimeoutMs = 5000)
    try {
        $job = Start-Job { & git @using:GitArgs 2>$null }
        $completed = Wait-Job $job -Timeout ([int]($TimeoutMs / 1000))
        if (-not $completed) { Remove-Job $job -Force; return $null }
        $out = Receive-Job $job
        Remove-Job $job
        return $out
    } catch { return $null }
}

function Get-GitDiffExitCode {
    # t/3669: phantom-vs-real discriminator via git-diff EXIT CODE, never stdout. A CRLF-only /
    # normalized file still emits the `diff --git`/`index` header with ZERO hunks, so the old
    # stdout-capture read it as a real diff and mis-escalated (p/331#1363-1367). `--quiet` implies
    # `--exit-code` and prints nothing; `--ignore-cr-at-eol` makes a CRLF-only change exit 0
    # (phantom) even where autocrlf is not configured (e.g. the Linux CI runner). Returns:
    #   0  identical to origin/main modulo CRLF  -> PHANTOM
    #   1  genuine content diff                  -> REAL WIP
    #  -1  query failed / timeout / bad ref      -> caller buckets conservatively as REAL
    # Mirrors Invoke-Git's Start-Job pattern (timeout-bounded; does not touch parent $LASTEXITCODE).
    param([string]$RepoRoot, [string]$File, [int]$TimeoutMs = 5000)
    try {
        $job = Start-Job {
            & git -C $using:RepoRoot diff --quiet --ignore-cr-at-eol origin/main -- $using:File 2>$null
            $LASTEXITCODE
        }
        $completed = Wait-Job $job -Timeout ([int]($TimeoutMs / 1000))
        if (-not $completed) { Remove-Job $job -Force; return -1 }
        $out = @(Receive-Job $job)
        Remove-Job $job
        $code = if ($out.Count) { $out[-1] } else { $null }
        if ($code -eq 0) { return 0 }
        elseif ($code -eq 1) { return 1 }
        else { return -1 }
    } catch { return -1 }
}

# t/3652: pure branch-strand classifier (CLEAN/STRANDED/DIVERGED/UNKNOWN), split into its own
# dot-sourceable file (mirrors FlakeVerdict.ps1) so its three arms are unit-testable without
# running the whole drift check. Best-effort dot-source; if absent, the 5d block below no-ops.
$strandVerdictScript = Join-Path $PSScriptRoot 'BranchStrandVerdict.ps1'
if (Test-Path $strandVerdictScript) { . $strandVerdictScript }

# t/3669: pure phantom-vs-real WIP classifier (maps file->exit-code to Phantom/RealWip buckets),
# same dot-sourceable pattern so both arms are unit-testable without a git fixture.
$phantomVerdictScript = Join-Path $PSScriptRoot 'DriftPhantomVerdict.ps1'
if (Test-Path $phantomVerdictScript) { . $phantomVerdictScript }

# t/3745: pure ff-sync HOLD predicate — hold iff real WIP intersects the incoming change-set (NOT on
# any real WIP). Same dot-sourceable pattern; both arms + fail-closed arms unit-tested (DriftSyncVerdict.Tests.ps1).
$syncVerdictScript = Join-Path $PSScriptRoot 'DriftSyncVerdict.ps1'
if (Test-Path $syncVerdictScript) { . $syncVerdictScript }

# t/4789: pure untracked-collision predicate — an UNTRACKED local file colliding with an incoming ADD
# blocks `git merge --ff-only` even though SyncBlocked (tracked-WIP-only, TL p/331#1674) does not see it.
# Advisory finding, NOT a SyncBlocked flip. Same dot-sourceable pattern; unit-tested (DriftUntrackedCollisionVerdict.Tests.ps1).
$untrackedCollisionVerdictScript = Join-Path $PSScriptRoot 'DriftUntrackedCollisionVerdict.ps1'
if (Test-Path $untrackedCollisionVerdictScript) { . $untrackedCollisionVerdictScript }

# t/3801: pure hourly-ping dedup predicates (fingerprint + should-ping). Same dot-sourceable
# pattern; both arms + fail-safe arms unit-tested (DriftDedupVerdict.Tests.ps1).
$dedupVerdictScript = Join-Path $PSScriptRoot 'DriftDedupVerdict.ps1'
if (Test-Path $dedupVerdictScript) { . $dedupVerdictScript }

# t/3652: bounded gh invocation. Returns combined output + exit code + timeout flag so the caller
# can distinguish gh-absent / unauth / rate-limited / timeout — different causes, different fixes
# (TL t/3652#3 condition 2). Never throws.
function Invoke-Gh {
    param([string[]]$GhArgs, [int]$TimeoutMs = 15000)
    try {
        $job = Start-Job {
            $ErrorActionPreference = 'Continue'
            $out = & gh @using:GhArgs 2>&1
            [PSCustomObject]@{ Out = @($out | ForEach-Object { "$_" }); Code = $LASTEXITCODE }
        }
        $completed = Wait-Job $job -Timeout ([int]($TimeoutMs / 1000))
        if (-not $completed) { Remove-Job $job -Force; return [PSCustomObject]@{ Output = @(); ExitCode = -1; TimedOut = $true } }
        $res = Receive-Job $job
        Remove-Job $job
        return [PSCustomObject]@{ Output = @($res.Out); ExitCode = ([int]$res.Code); TimedOut = $false }
    } catch { return [PSCustomObject]@{ Output = @(); ExitCode = -1; TimedOut = $false } }
}

# t/3058: attribute shell-word-split junk to the scope-owning role by path prefix.
# Each Orca agent's shell cwd is its own scope dir, so a word-split fragment lands in
# the CREATING role's directory — the junk file's path IS the attribution. Ordered
# longest-prefix-first so deeper scopes (e.g. .../src/server) win over their parents.
$scopeRoleMap = [ordered]@{
    'taxonomy-editor/src/renderer/components/debate' = 'DebateUI'
    'taxonomy-editor/src/server'                     = 'ServerAPI'
    'taxonomy-editor'                                = 'Rosetta Stone'
    'lib/debate'                                     = 'DebateTool'
    'lib'                                            = 'Shared Lib'
    'engineering/tech-lead'                          = 'Tech Lead'
    'operations/devops'                              = 'DevOps'
    'operations/sage'                                = 'Sage'
    'operations/diagnostics'                         = 'Diagnostics'
    'research/comp-linguist'                         = 'Computational Linguist'
    'research/collaborator'                          = 'Collaborator'
    'scripts'                                        = 'PowerShell'
}
function Get-OwningScope {
    param([string]$Path)
    $p = ($Path -replace '\\', '/')
    foreach ($prefix in $scopeRoleMap.Keys) {
        if ($p -eq $prefix -or $p.StartsWith("$prefix/")) {
            return [PSCustomObject]@{ Scope = $prefix; Role = $scopeRoleMap[$prefix] }
        }
    }
    # Unmapped path — log the top segment as scope so it stays attributable/coachable.
    $seg = ($p -split '/')[0]
    return [PSCustomObject]@{ Scope = $seg; Role = "unmapped:$seg" }
}

$result = [PSCustomObject]@{
    Alarm            = $false
    BehindCount      = 0
    AheadCount       = 0                # t/3745: origin/main..HEAD — >0 together with behind>0 = DIVERGED
    SyncBlocked      = $false           # t/3745: ff-sync blocked by real WIP the incoming would overwrite. The t/2452 reminder branches on THIS, not HasRealDiff — a real-WIP file the incoming does not touch no longer holds the sync.
    SyncConflicts    = @()              # t/3745: the real-WIP file(s) intersecting the incoming change-set (or all WIP when diverged/broken)
    IncomingFiles    = @()              # t/3745: paths the incoming commits change (HEAD..origin/main)
    SyncReason       = ''               # t/3745: human-readable verdict rationale
    UntrackedCollisions = @()           # t/4789: untracked local file(s) colliding with an incoming ADD — git ff-only refuses these, but SyncBlocked (tracked-WIP-only, TL p/331#1674) does not see them. Advisory finding, NOT a SyncBlocked flip.
    UntrackedCollisionReason = ''       # t/4789: human-readable rationale / DEGRADED note
    DirtyFiles       = @()
    HasRealDiff      = $false           # t/3669: = RealWipFiles.Count -gt 0 (the t/2452 reminder branches on this)
    PhantomFiles     = @()              # t/3669: dirty but byte-identical to origin/main modulo CRLF — safe to restore, no owner-claim
    RealWipFiles     = @()              # t/3669: dirty with a genuine content diff — owner-claim required
    JunkPaths        = @()
    ShellFragmentPaths = @()
    SuspiciousPaths  = @()
    NestedWorktrees  = @()
    StrandedBranches = @()            # t/3652: AT-RISK branches (STRANDED / DIVERGED-UNLANDED) — these ALARM
    StrandedBranchesInfo = @()        # t/3652: DIVERGED-STALE — informational only (stale reset branch, 0 unlanded), does NOT alarm (TL p/331#1324)
    StrandedBranchesStatus = 'OK'     # t/3652: OK | PARTIAL | SKIPPED-NO-NETWORK — degraded state lives in the RETURN VALUE, not just a WARN (TL t/3652#3: WARN+success reads as clean = invisible degradation)
    StrandedBranchesReason = ''       # t/3652: WHY degraded (gh-absent / gh-unauth / gh-rate-limited / N-unresolved) — different causes need different fixes
    AutoRemoved      = @()
    Attribution      = @{}
    RemediationHint  = ''
    # t/3801: hourly-ping dedup. ShouldPing=$true is the FAIL-SAFE default (never silently
    # suppress) — flipped to $false only when an already-escalated, fingerprint-identical
    # parked state is positively confirmed below. The reminder prompt branches on THIS field,
    # not Alarm alone, to decide whether to actually notify.
    ShouldPing       = $true
    DedupCategory    = ''
    DedupFingerprint = ''
    DedupSuppressedCount = 0
    DedupParkedSince = ''
}

try {
    # 1. Fetch (best-effort; skip on failure — we compare against last-fetched ref)
    Invoke-Git @('-C', $RepoRoot, 'fetch', '--quiet', 'origin', 'main') | Out-Null

    # 2. Behind count
    $behindRaw = Invoke-Git @('-C', $RepoRoot, 'rev-list', '--count', 'HEAD..origin/main')
    $behind = if ($behindRaw -match '^\d+$') { [int]$behindRaw } else { 0 }
    $result.BehindCount = $behind

    # 3. Dirty tracked files (tracked only — untracked handled separately)
    $statusOut = Invoke-Git @('-C', $RepoRoot, 'status', '--porcelain', '--untracked-files=no')
    $dirtyFiles = @($statusOut | Where-Object { $_ } | ForEach-Object { $_.Substring(3).Trim() })
    $result.DirtyFiles = $dirtyFiles

    # 4. Classify each dirty file: PHANTOM (byte-identical to origin/main modulo CRLF) vs REAL WIP.
    #    t/3669: discriminate on the git-diff EXIT CODE, never stdout. The prior stdout-capture
    #    (`--ignore-cr-at-eol` + capture) mis-read a CRLF-only file as real WIP — `git diff` still
    #    prints the `diff --git`/`index` HEADER (zero hunks) for a blob-hash-differing file, so the
    #    captured string was non-empty and every CRLF-only file mis-escalated to an owner-claim
    #    (p/331#1363-1367). Exit-code can't be fooled by header text. Query-failure (-1) buckets as
    #    REAL — a failed diff must never read as a safe phantom (same "don't infer safe from silence").
    $fileExitCodes = [ordered]@{}
    foreach ($f in $dirtyFiles) {
        $fileExitCodes[$f] = Get-GitDiffExitCode -RepoRoot $RepoRoot -File $f
    }
    if (Get-Command Get-DriftPhantomVerdict -ErrorAction SilentlyContinue) {
        $verdict = Get-DriftPhantomVerdict -FileExitCodes $fileExitCodes
        $result.PhantomFiles = $verdict.PhantomFiles
        $result.RealWipFiles = $verdict.RealWipFiles
        $result.HasRealDiff  = $verdict.HasRealDiff
    }
    else {
        # Fail-safe if the verdict file is missing: treat every dirty file as REAL (conservative).
        $result.RealWipFiles = $dirtyFiles
        $result.HasRealDiff  = $dirtyFiles.Count -gt 0
    }
    $hasRealDiff  = $result.HasRealDiff
    $phantomFiles = $result.PhantomFiles
    $realWipFiles = $result.RealWipFiles

    # 4b. t/3745 — ff-sync HOLD predicate. The bug: the sync was held on ANY real WIP (HasRealDiff),
    #     but `git merge --ff-only` only refuses when the FF would OVERWRITE a locally-modified file —
    #     a dirty file the incoming commits don't touch is carried through. So hold iff real WIP
    #     INTERSECTS the incoming change-set (clean-behind), or on any real WIP when DIVERGED (reset
    #     --hard overwrites everything). Ahead>0 with behind>0 = diverged.
    $aheadRaw = Invoke-Git @('-C', $RepoRoot, 'rev-list', '--count', 'origin/main..HEAD')
    $ahead = if ($aheadRaw -match '^\d+$') { [int]$aheadRaw } else { 0 }
    $result.AheadCount = $ahead
    # Incoming change-set (paths the behind-commits touch). $incomingKnown=$false on git failure so the
    # verdict fails CLOSED — an empty incoming set with behind>0 is impossible; never read it as "safe".
    $incomingKnown = $true
    $incomingFiles = @()
    if ($behind -gt 0) {
        $incomingRaw = Invoke-Git @('-C', $RepoRoot, 'diff', '--name-only', 'HEAD..origin/main')
        if ($null -eq $incomingRaw) { $incomingKnown = $false }
        else { $incomingFiles = @($incomingRaw | Where-Object { $_ } | ForEach-Object { ($_ -replace '\\', '/').Trim() }) }
    }
    $result.IncomingFiles = $incomingFiles
    if (Get-Command Get-DriftSyncVerdict -ErrorAction SilentlyContinue) {
        $syncV = Get-DriftSyncVerdict -RealWipFiles $realWipFiles -IncomingFiles $incomingFiles -Behind $behind -Ahead $ahead -IncomingKnown $incomingKnown
        $result.SyncBlocked   = $syncV.SyncBlocked
        $result.SyncConflicts = $syncV.Conflicts
        $result.SyncReason    = $syncV.Reason
    }
    else {
        # Fail-safe if the verdict file is missing: block if behind>0 with any real WIP (conservative).
        $result.SyncBlocked   = ($behind -gt 0 -and @($realWipFiles).Count -gt 0)
        $result.SyncConflicts = @($realWipFiles)
        $result.SyncReason    = 'DriftSyncVerdict.ps1 missing — conservative fallback (hold on any real WIP while behind)'
    }

    # 5. Junk untracked — two classes (t/2222 + t/2473), excluding linked worktrees (.worktrees/):
    #    JunkPaths:       0-byte files anywhere in the tree
    #    SuspiciousPaths: non-0-byte, extension-less files inside source directories
    #                     (shell-quoting debris like src/server/community/22)
    # t/3634: enumerate NUL-delimited with core.quotePath=false so names containing shell
    # metacharacters or control bytes (e.g. the ESC in `lib/<ESC>[22m…`) come back LITERAL,
    # not octal-quoted. The previous plain enum + non-`-LiteralPath` Get-Item silently DROPPED
    # such names (they parsed as non-matching PowerShell wildcards → Get-Item errored → caught),
    # which is why 0-byte shell-fragment junk with these names accumulated unseen.
    $untrackedRaw = Invoke-Git @('-C', $RepoRoot, '-c', 'core.quotePath=false', 'ls-files', '--others', '--exclude-standard', '-z')
    $untracked = @((($untrackedRaw -join '') -split "`0") | Where-Object { $_ })
    # Shell-metacharacter set (t/3634 TL spec) + control chars — used to name the ShellFragmentPaths finding.
    $shellMetaChars = [char[]]('`', '{', '}', '[', ']', '(', ')', '$', '|', [char]39, [char]34)
    $sourceDirs = @('taxonomy-editor/src/', 'taxonomy-editor/lib/', 'lib/', 'engineering/', 'operations/', 'research/')
    # OS-locked files confirmed as junk but un-deletable until host restart.
    # Entries here suppress SuspiciousPaths alarm. Remove when the file clears.
    $knownOsLocked = @(
        'engineering/tech-lead/fail-open'   # vim TUI artifact, OS handle lock — clears on host restart
    )
    $junkPaths = @()
    $shellFragmentPaths = @()
    $suspiciousPaths = @()
    foreach ($f in $untracked) {
        # Skip anything under .worktrees/ — other agents' in-worktree files are not shared-tree drift
        if ($f -match '^\.worktrees[\\/]') { continue }
        $fullPath = Join-Path $RepoRoot $f
        try {
            # t/3634: -LiteralPath so `[`, `]`, backtick etc. in the name are NOT treated as
            # PowerShell wildcards (the old non-literal Get-Item silently errored on these).
            $item = Get-Item -LiteralPath $fullPath -ErrorAction Stop
            if ($item.Length -eq 0) {
                $junkPaths += $f
                # t/3634: a 0-byte untracked file whose NAME carries a shell metacharacter/control
                # char is the t/2112 word-split signature — surface it as a distinct named finding
                # (it still feeds the auto-remove below; this just makes the class explicit).
                $leaf = [System.IO.Path]::GetFileName($f)
                $hasControl = @($leaf.ToCharArray() | Where-Object { [int]$_ -lt 32 }).Count -gt 0
                if ($leaf.IndexOfAny($shellMetaChars) -ge 0 -or $hasControl) { $shellFragmentPaths += $f }
            } else {
                # Non-0-byte: flag if extension-less file found under a source directory
                $normalizedF = $f -replace '\\', '/'
                $inSourceDir = @($sourceDirs | Where-Object { $normalizedF.StartsWith($_) })
                $hasNoExtension = [System.IO.Path]::GetExtension($item.Name) -eq ''
                if ($inSourceDir.Count -gt 0 -and $hasNoExtension -and ($normalizedF -notin $knownOsLocked)) { $suspiciousPaths += $f }
            }
        } catch { continue }
    }
    $result.SuspiciousPaths = $suspiciousPaths
    $result.ShellFragmentPaths = $shellFragmentPaths   # t/3634: detected this run (also auto-removed below)

    # 5e. t/4789 — UNTRACKED-vs-incoming-ADD collision (advisory finding; does NOT flip SyncBlocked).
    #     Live gap (r/11#1619): SyncBlocked reported safe-to-ff, but `git merge --ff-only` refused
    #     ("untracked working tree files would be overwritten") for an untracked local file colliding
    #     with an incoming ADD of the same path. SyncBlocked is tracked-WIP-only BY DESIGN (TL p/331#1674)
    #     and stays so — flipping it would reverse that decision AND wrongly route into real-WIP
    #     owner-claim semantics (wrong remedy; the fix is compare-and-remove-if-identical). So detect it
    #     as its own finding + hint, and qualify the "ff-sync is SAFE" hint below. Only meaningful when
    #     behind>0 (a pending ff). The incoming-ADD set = `git diff --name-status HEAD..origin/main` with
    #     status 'A', plus the DESTINATION of 'R'/'C' rename/copy entries (a new path). $incomingAddedKnown
    #     = $false on git failure so the verdict reports DEGRADED (never a false clean or a false alarm).
    $incomingAddedKnown = $true
    $incomingAdded = @()
    if ($behind -gt 0) {
        $nameStatusRaw = Invoke-Git @('-C', $RepoRoot, 'diff', '--name-status', 'HEAD..origin/main')
        if ($null -eq $nameStatusRaw) {
            $incomingAddedKnown = $false
        } else {
            foreach ($line in @($nameStatusRaw | Where-Object { $_ })) {
                $parts = @("$line" -split "`t")       # <STATUS>\t<path>; R/C: <STATUS>\t<old>\t<new>
                $code = "$($parts[0])"
                if ($code -like 'A*' -and $parts.Count -ge 2) {
                    $incomingAdded += ($parts[1] -replace '\\', '/').Trim()
                } elseif (($code -like 'R*' -or $code -like 'C*') -and $parts.Count -ge 3) {
                    $incomingAdded += ($parts[2] -replace '\\', '/').Trim()   # rename/copy destination is a new path
                }
            }
            $incomingAdded = @($incomingAdded | Where-Object { $_ })
        }
    }
    # Untracked set (section 5's $untracked), normalized and with linked worktrees excluded — a
    # .worktrees/ file is not a shared-tree path and cannot collide with a root-relative incoming ADD.
    $untrackedForCollision = @(
        $untracked |
            Where-Object { $_ -and ($_ -notmatch '^\.worktrees[\\/]') } |
            ForEach-Object { ($_ -replace '\\', '/').Trim() } |
            Where-Object { $_ }
    )
    if (Get-Command Get-DriftUntrackedCollisionVerdict -ErrorAction SilentlyContinue) {
        $collV = Get-DriftUntrackedCollisionVerdict -UntrackedFiles $untrackedForCollision -IncomingAddedFiles $incomingAdded -Behind $behind -IncomingAddedKnown $incomingAddedKnown
        $result.UntrackedCollisions      = @($collV.Collisions)
        $result.UntrackedCollisionReason = $collV.Reason
    }
    # else: verdict file missing — leave UntrackedCollisions empty. Advisory only; behind>0 already alarms.

    # 5c. NESTED .worktrees directories outside repo root (t/3145; t/2222 cwd-reset class).
    #     A `git worktree add` run with the shell cwd reset into a subdir drops .worktrees UNDER a
    #     role subtree instead of the repo root. Legit worktrees live ONLY at <root>/.worktrees/.
    #     Warn-only (advisory). Per TL disposition (t/3145#2):
    #       - ONLY INERT (unregistered) nested dirs are drift; an ACTIVE registered worktree nested
    #         under a subtree is EXEMPT (someone's using it — it has a .git safety net).
    #       - Route each flag to the OWNING role (path-derived) so the owner cleans it, not DevOps.
    #     Root <root>/.worktrees/ is never flagged. Each entry is "<relpath> (Owner)".
    $rootFull = ((Resolve-Path $RepoRoot -ErrorAction SilentlyContinue).Path -replace '\\', '/').TrimEnd('/')
    # Registered worktree paths (absolute, normalized, lowercased) — the EXEMPT set.
    $registered = @{}
    foreach ($line in @(Invoke-Git @('-C', $RepoRoot, 'worktree', 'list', '--porcelain') | Where-Object { $_ -like 'worktree *' })) {
        $wp = ((($line -replace '^worktree\s+', '') -replace '\\', '/').TrimEnd('/')).ToLowerInvariant()
        $registered[$wp] = $true
    }
    # Find every nested .worktrees dir (not root). `git ls-files --others --directory` WITHOUT
    # --exclude-standard surfaces the .gitignore'd .worktrees; --directory collapses dirs (cheap —
    # no descent into node_modules/dist contents). Then flag each INERT child (exempt registered).
    $nestedWorktrees = @()
    $seenNested = @{}
    foreach ($d in @(Invoke-Git @('-C', $RepoRoot, 'ls-files', '--others', '--directory') | Where-Object { $_ })) {
        $nd = ($d -replace '\\', '/').TrimEnd('/')
        if ($nd -notmatch '^\.worktrees(/|$)' -and $nd -match '^(.+?/\.worktrees)(/|$)') {
            $wtDir = $matches[1]
            if ($seenNested[$wtDir]) { continue }
            $seenNested[$wtDir] = $true
            $abs = "$rootFull/$wtDir"
            $children = @(Get-ChildItem -LiteralPath $abs -Directory -Force -ErrorAction SilentlyContinue)
            if ($children.Count -eq 0) {
                $owner = Get-OwningScope -Path $wtDir
                $nestedWorktrees += "$wtDir ($($owner.Role))"     # empty nested .worktrees dir — inert leftover
            } else {
                foreach ($c in $children) {
                    if ($registered[(($c.FullName -replace '\\', '/').TrimEnd('/')).ToLowerInvariant()]) { continue } # active registered — EXEMPT
                    $childRel = "$wtDir/$($c.Name)"
                    $owner = Get-OwningScope -Path $childRel
                    $nestedWorktrees += "$childRel ($($owner.Role))"
                }
            }
        }
    }
    $nestedWorktrees = @($nestedWorktrees | Select-Object -Unique)
    $result.NestedWorktrees = $nestedWorktrees

    # 5d. STRANDED-BRANCH DETECTION (t/3652): commits pushed to a branch whose PR already MERGED/CLOSED.
    #     Silent failure class — the branch looks healthy, CI may go green, but no PR will ever land
    #     the commits (near-miss: two security fixes sat on a dead branch for hours while the epic
    #     carried the unfixed code — e/203#4). Detection-only; a human decides. Needs gh to map
    #     branch->PR, so it degrades EXPLICITLY into the return value (StrandedBranchesStatus/Reason),
    #     never a silent WARN+success (TL t/3652#3). Signal = Get-BranchStrandVerdict (squash-safe).
    # Own try/catch so a failure here can NEVER skip section 6 (alarm) — degrade into the status field.
    try {
    if (-not (Get-Command Get-BranchStrandVerdict -ErrorAction SilentlyContinue)) {
        $result.StrandedBranchesStatus = 'SKIPPED-NO-NETWORK'
        $result.StrandedBranchesReason = 'classifier-unavailable: BranchStrandVerdict.ps1 not dot-sourced'
    }
    $strandedBranches = @()
    $strandedInfo = @()
    # Only meaningful against a real GitHub repo. A temp/test repo or non-GitHub mirror has no PRs
    # to map — running gh there just errors → a spurious SKIPPED alarm (this exact case broke the
    # ShellFragment clean-tree test). No github origin => detection N/A: leave status OK, no alarm.
    $originUrl = (Invoke-Git @('-C', $RepoRoot, 'remote', 'get-url', 'origin'))
    $originUrl = if ($originUrl) { ($originUrl | Select-Object -First 1).Trim() } else { '' }
    $noGithubRemote = ($originUrl -notmatch 'github\.com')
    # Dismissal allowlist: `branch  # reason` — reason mandatory (t/3557 exemption-ratchet). Blank / full-line `#` ignored.
    $dismissed = @{}
    $dismissFile = Join-Path $RepoRoot 'operations/devops/stranded-branch-dismissals.txt'
    if (Test-Path $dismissFile) {
        foreach ($line in @(Get-Content -LiteralPath $dismissFile -ErrorAction SilentlyContinue)) {
            $t = "$line".Trim()
            if (-not $t -or $t.StartsWith('#')) { continue }
            $name = (($t -split '#', 2)[0]).Trim()
            if ($name) { $dismissed[$name] = $true }
        }
    }
    if ($noGithubRemote) {
        # No GitHub origin (temp/test repo or non-GitHub mirror) — stranded detection is N/A;
        # no PRs to map. Leave StrandedBranchesStatus='OK', no findings, no alarm.
    } elseif ($result.StrandedBranchesStatus -ne 'OK') {
        # classifier-unavailable already recorded above — skip the gh/network work entirely
    } elseif (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
        $result.StrandedBranchesStatus = 'SKIPPED-NO-NETWORK'
        $result.StrandedBranchesReason = 'gh-absent: GitHub CLI not on PATH — branch->PR mapping unavailable'
    } else {
        $gh = Invoke-Gh @('pr', 'list', '--state', 'all', '--limit', '200', '--json', 'number,state,headRefName,headRefOid') -TimeoutMs 15000
        $ghFail = Resolve-GhFailureReason -TimedOut $gh.TimedOut -ExitCode $gh.ExitCode -OutputText ($gh.Output -join ' ')
        if ($ghFail) {
            $errText = ($gh.Output -join ' ')
            $snip = if ($errText.Length -gt 180) { $errText.Substring(0, 180) } else { $errText }
            $result.StrandedBranchesStatus = 'SKIPPED-NO-NETWORK'
            $result.StrandedBranchesReason = if ($snip) { "${ghFail}: $snip" } else { $ghFail }
        } else {
            $prs = $null
            try { $prs = ($gh.Output -join '') | ConvertFrom-Json } catch { }
            if ($null -eq $prs) {
                $result.StrandedBranchesStatus = 'SKIPPED-NO-NETWORK'; $result.StrandedBranchesReason = 'gh-parse: could not parse `gh pr list` JSON output'
            } else {
                # Live remote branch tips (one call). name -> tip SHA.
                $remoteRefs = @{}
                foreach ($r in @(Invoke-Git @('-C', $RepoRoot, 'ls-remote', '--heads', 'origin') -TimeoutMs 15000)) {
                    if ("$r" -match '^([0-9a-f]{40})\s+refs/heads/(.+)$') { $remoteRefs[$matches[2]] = $matches[1] }
                }
                # Most-recent closed/merged PR per branch (a branch may have had several).
                $latestByBranch = @{}
                foreach ($p in @($prs | Where-Object { $_.state -in @('MERGED', 'CLOSED') })) {
                    $b = $p.headRefName
                    if (-not $latestByBranch.ContainsKey($b) -or $p.number -gt $latestByBranch[$b].number) { $latestByBranch[$b] = $p }
                }
                # t/3652 false positive (p/648#99): see Get-OpenPrByBranch's comment
                # (BranchStrandVerdict.ps1) for why this is checked. Reuses the one
                # `gh pr list --state all` call already made above (no extra per-branch
                # `gh pr list --head <b> --state open` round-trip needed).
                $openByBranch = Get-OpenPrByBranch -Prs $prs
                $unresolved = 0
                foreach ($b in $latestByBranch.Keys) {
                    if ($dismissed[$b]) { continue }
                    if (-not $remoteRefs.ContainsKey($b)) { continue }          # branch deleted after merge — the clean, common case
                    if ($openByBranch.ContainsKey($b)) {
                        $strandedInfo += "$b (carried-by #$($openByBranch[$b].number) -- branch name reused by a currently open PR, not stranded)"
                        continue
                    }
                    $tip = $remoteRefs[$b]
                    $mergedHead = $latestByBranch[$b].headRefOid
                    if ($tip -eq $mergedHead) { continue }                      # unchanged since merge — fast path, no fetch
                    # Bring the branch's objects local so merge-base can run (best-effort).
                    Invoke-Git @('-C', $RepoRoot, 'fetch', '--quiet', 'origin', $b) -TimeoutMs 20000 | Out-Null
                    $v = Get-BranchStrandVerdict -RepoRoot $RepoRoot -Tip $tip -MergedHead $mergedHead -MainRef 'origin/main'
                    $pn = $latestByBranch[$b].number
                    switch ($v.Verdict) {
                        'STRANDED'         { $strandedBranches += "$b ($($v.Ahead) commit(s) after PR #$pn merged)" }
                        'DIVERGED-UNLANDED' { $strandedBranches += "$b (DIVERGED — $($v.Ahead) unlanded commit(s) force-pushed off merged PR #$pn head)" }
                        'DIVERGED-STALE'   { $strandedInfo += "$b (stale reset off merged PR #$pn head — 0 unlanded, nothing at risk)" }
                        'UNKNOWN'          { $unresolved++ }
                        default            { }
                    }
                }
                if ($unresolved -gt 0 -and $result.StrandedBranchesStatus -eq 'OK') {
                    $result.StrandedBranchesStatus = 'PARTIAL'
                    $result.StrandedBranchesReason = "$unresolved branch(es) unresolved: a required commit SHA was not fetchable (deleted/gc'd) — could not classify"
                }
            }
        }
    }
    $result.StrandedBranches = @($strandedBranches)
    $result.StrandedBranchesInfo = @($strandedInfo)
    } catch {
        # 5d must never break the rest of the guard — degrade into the status field, never throw.
        $result.StrandedBranchesStatus = 'SKIPPED-NO-NETWORK'
        $result.StrandedBranchesReason = "strand-check-error: $($_.Exception.Message)"
    }

    # 5b. Auto-remediate 0-byte junk — triple guard per t/2476#1:
    #     (a) path is in $junkPaths (already classified as 0-byte untracked)
    #     (b1) not tracked in main repo (git ls-files returns empty at delete time)
    #     (b2) not tracked in overlay repo (.orca-git), if overlay is present
    #     (c) re-stat immediately before delete — still 0 bytes (TOCTOU guard)
    $overlayGitDir = Join-Path $RepoRoot '.orca-git'
    $autoRemoved = @()
    $remainingJunk = @()
    $attribution = @{}            # t/3058: role -> count for this run
    $attributionDetail = @()      # t/3058: per-file {Path, Role, Scope, Mtime, Removed}
    foreach ($f in $junkPaths) {
        $fullPath = Join-Path $RepoRoot $f
        try {
            # Guard (b1): not tracked in main repo. `:(literal)` pathspec magic (t/3634) so a name
            # containing `[` `]` `*` `?` is matched literally, not as a git pathspec glob.
            if (Invoke-Git @('-C', $RepoRoot, 'ls-files', '--', ":(literal)$f")) { $remainingJunk += $f; continue }
            # Guard (b2): not tracked in overlay (skip check when no overlay present)
            # -C $RepoRoot anchors path resolution to repo root regardless of script CWD (t/2477)
            if ((Test-Path $overlayGitDir) -and (Invoke-Git @('-C', $RepoRoot, '--git-dir', $overlayGitDir, 'ls-files', '--', ":(literal)$f"))) {
                $remainingJunk += $f; continue
            }
            # Guard (c): re-stat — file must still be 0 bytes at deletion time (TOCTOU).
            # Capture mtime here (t/3058) so attribution survives the delete.
            # -LiteralPath (t/3634): stat + remove metachar names literally (the old non-literal
            # form silently errored on `[`/backtick names, leaving fragments unremoved).
            $item = Get-Item -LiteralPath $fullPath -ErrorAction Stop
            if ($item.Length -ne 0) { $remainingJunk += $f; continue }
            $mtime = $item.LastWriteTime.ToString('o')

            Remove-Item -LiteralPath $fullPath -Force -ErrorAction Stop
            $autoRemoved += $fullPath  # full path per t/2476#1 observability requirement

            # t/3058: attribute the removed fragment to the scope-owning role (path-derived).
            $owner = Get-OwningScope -Path $f
            $attribution[$owner.Role] = ([int]($attribution[$owner.Role]) + 1)
            $attributionDetail += [PSCustomObject]@{ Path = $f; Role = $owner.Role; Scope = $owner.Scope; Mtime = $mtime; Removed = $true }
        } catch { $remainingJunk += $f }
    }
    $result.JunkPaths = $remainingJunk
    $result.AutoRemoved = $autoRemoved

    # t/3058: also attribute non-removed spray (guard-blocked junk + suspicious files) so the
    # tally covers every fragment, not just the auto-cleaned ones. mtime best-effort (may be gone).
    foreach ($f in @($remainingJunk + $suspiciousPaths)) {   # nestedWorktrees carry their own (Owner) annotation + hint; not re-attributed here
        $mtime = $null
        try { $mtime = (Get-Item -LiteralPath (Join-Path $RepoRoot $f) -ErrorAction Stop).LastWriteTime.ToString('o') } catch { }
        $owner = Get-OwningScope -Path $f
        $attribution[$owner.Role] = ([int]($attribution[$owner.Role]) + 1)
        $attributionDetail += [PSCustomObject]@{ Path = $f; Role = $owner.Role; Scope = $owner.Scope; Mtime = $mtime; Removed = $false }
    }
    $result.Attribution = $attribution

    # t/3058: append a per-role tally + per-file detail to a rolling log so recurring spray
    # offenders are visible over time (the log itself is gitignored — see operations/devops
    # entry in .gitignore). Best-effort; never let logging break the guard.
    if ($attributionDetail.Count -gt 0) {
        try {
            $logPath = Join-Path $RepoRoot 'operations/devops/junk-attribution.jsonl'
            $logLine = [PSCustomObject]@{
                ts      = (Get-Date).ToString('o')
                perRole = $attribution
                detail  = $attributionDetail
            } | ConvertTo-Json -Depth 6 -Compress
            Add-Content -Path $logPath -Value $logLine -ErrorAction Stop
        } catch { }
    }

    # 6. Determine alarm + remediation hint
    # t/3634: shell-fragment 0-byte files ALARM even when auto-removed — the t/2112 word-split
    # signature is a named finding worth surfacing (converts silent accumulation into a visible
    # event), unlike generic 0-byte junk which is swept quietly.
    # t/3652: stranded/diverged branches ALARM (a silent, dangerous class). A DEGRADED stranded-check
    # (StrandedBranchesStatus != OK) ALSO alarms — the whole point (TL t/3652#3) is that "couldn't
    # check" must not read as "clean"; surfacing it via the alarm/ping path is how it stays visible.
    $strandedAlarm = ($result.StrandedBranches.Count -gt 0) -or ($result.StrandedBranchesStatus -ne 'OK')
    $alarm = $behind -gt 0 -or $dirtyFiles.Count -gt 0 -or $remainingJunk.Count -gt 0 -or $suspiciousPaths.Count -gt 0 -or $nestedWorktrees.Count -gt 0 -or $shellFragmentPaths.Count -gt 0 -or $strandedAlarm -or $result.UntrackedCollisions.Count -gt 0
    $result.Alarm = $alarm

    # 6b. t/3801 — hourly-ping dedup. Own try/catch (like 5d) so a dedup failure can NEVER
    # suppress a real alarm or break the rest of the guard: on ANY exception here, ShouldPing
    # stays at its $true default (fail-safe, never silently muted).
    try {
        # CONTENT STATE, not just the binary classification label (live-fired bug found during
        # t/3801 build): "phantom" is itself a content-equivalence statement (byte-identical to
        # origin modulo CRLF, by definition), so the fixed label is sufficient there. "real-wip"
        # is NOT — it is an under-specified bucket meaning only "differs from origin," so two
        # DIFFERENT real-WIP contents on the SAME path (TL's "WIP swapped for something
        # dangerous" case) produced the SAME label and the SAME fingerprint, silently suppressing
        # exactly the change that matters. Fix: embed a content hash in the State string for real
        # WIP files, so any edit to that file changes the fingerprint even though its
        # classification (still "real-wip") does not.
        $dirtyFileStates = @(
            @($phantomFiles | Where-Object { $_ }) | ForEach-Object { [PSCustomObject]@{ Path = $_; State = 'phantom' } }
            @($realWipFiles | Where-Object { $_ }) | ForEach-Object {
                $contentHash = 'unreadable'
                try {
                    $fp = Join-Path $RepoRoot $_
                    if (Test-Path -LiteralPath $fp) { $contentHash = (Get-FileHash -LiteralPath $fp -Algorithm SHA256 -ErrorAction Stop).Hash }
                } catch { $contentHash = 'unreadable' }
                [PSCustomObject]@{ Path = $_; State = "real-wip:$contentHash" }
            }
        )
        $category = Get-DriftReasonCategory -Behind $behind -Ahead $ahead -RealWipFiles $realWipFiles -PhantomFiles $phantomFiles `
            -JunkPaths $remainingJunk -SuspiciousPaths $suspiciousPaths -ShellFragmentPaths $shellFragmentPaths `
            -NestedWorktrees $nestedWorktrees -StrandedBranches $result.StrandedBranches -StrandedBranchesStatus $result.StrandedBranchesStatus
        $fpArgs = @{
            ReasonCategory = $category; DirtyFileStates = $dirtyFileStates
            JunkPaths = $remainingJunk; SuspiciousPaths = $suspiciousPaths; ShellFragmentPaths = $shellFragmentPaths
            NestedWorktrees = $nestedWorktrees; StrandedBranches = $result.StrandedBranches; StrandedBranchesStatus = $result.StrandedBranchesStatus
        }
        $fingerprint = Get-DriftFingerprint @fpArgs
        # t/3880: the readable inputs behind the hash, logged on every fingerprint CHANGE so the
        # telemetry can say WHY a parked condition re-pinged (hash-only records could not).
        $fpComposite = Get-DriftFingerprintComposite @fpArgs
        $result.DedupCategory = $category
        $result.DedupFingerprint = $fingerprint

        # Read stored parked-state. FAIL-SAFE: any read/parse failure, or a shape missing the
        # fingerprint field, is treated as "nothing is reliably parked" -> StoredStateValid=$false
        # -> Get-ShouldPing always pings (never infer safe-to-suppress from an unreadable file).
        $statePath = Join-Path $RepoRoot 'operations/devops/drift-dedup-state.json'
        $storedFingerprint = $null
        $storedFirstSeen = $null
        $storedSuppressedCount = 0
        $storedStateValid = $true
        if (Test-Path -LiteralPath $statePath) {
            try {
                $stored = Get-Content -Raw -LiteralPath $statePath -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
                if ($stored.PSObject.Properties['fingerprint']) {
                    $storedFingerprint = [string]$stored.fingerprint
                    if ($stored.PSObject.Properties['firstSeen']) { $storedFirstSeen = [string]$stored.firstSeen }
                    if ($stored.PSObject.Properties['suppressedCount']) { $storedSuppressedCount = [int]$stored.suppressedCount }
                } else {
                    $storedStateValid = $false   # missing the required field -> corrupt/unreadable shape
                }
            } catch { $storedStateValid = $false }   # unreadable/unparseable -> corrupt
        }
        # else: no file yet -> $storedFingerprint stays $null, $storedStateValid stays $true
        # (Get-ShouldPing's own "nothing parked yet" arm handles the missing-file case correctly;
        # $storedStateValid is reserved for POSITIVELY detected corruption, not mere absence).

        $shouldPing = Get-ShouldPing -Alarm $alarm -CurrentFingerprint $fingerprint -StoredFingerprint $storedFingerprint -StoredStateValid $storedStateValid
        $result.ShouldPing = $shouldPing

        if (-not $alarm) {
            # Clean + current — clear any parked state (t/3801#5: "Alarm=false -> unchanged").
            if (Test-Path -LiteralPath $statePath) { Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue }
        } else {
            $isNewFingerprint = ($storedFingerprint -ne $fingerprint) -or (-not $storedStateValid)
            if ($isNewFingerprint) {
                $firstSeen = (Get-Date).ToString('o')
                $suppressedCount = 0
            } else {
                $firstSeen = $storedFirstSeen
                # PowerShell gotcha guard: an `if/else` nested as a SUB-EXPRESSION inside a larger
                # expression (e.g. `$a + (if (cond) {0} else {1})`) is unreliable -- `if` is only
                # safe as the ENTIRE right-hand side of an assignment, not embedded inline. Written
                # out as its own if/else assignment instead.
                if ($shouldPing) { $suppressedCount = $storedSuppressedCount } else { $suppressedCount = $storedSuppressedCount + 1 }
            }
            $result.DedupParkedSince = $firstSeen
            $result.DedupSuppressedCount = $suppressedCount
            try {
                [PSCustomObject]@{
                    fingerprint     = $fingerprint
                    firstSeen       = $firstSeen
                    suppressedCount = $suppressedCount
                    category        = $category
                } | ConvertTo-Json -Compress | Set-Content -LiteralPath $statePath -ErrorAction Stop
            } catch { }   # best-effort write; a failed write just means the NEXT run fails-safe to ping
        }

        # OBSERVABILITY (TL t/3801#2, mandatory): append a durable record EVERY run, suppressed or
        # not, pinged or not — "snoozed" must never mean "invisible". A daily digest / status
        # surface reads this to tell parked-and-watched apart from silently-stopped-running.
        try {
            $telemetryPath = Join-Path $RepoRoot 'operations/devops/drift-dedup-telemetry.jsonl'
            $record = [ordered]@{
                ts              = (Get-Date).ToString('o')
                alarm           = $alarm
                category        = $category
                fingerprint     = $fingerprint
                shouldPing      = $shouldPing
                suppressedCount = $result.DedupSuppressedCount
                parkedSince     = $result.DedupParkedSince
            }
            if ($storedFingerprint -ne $fingerprint) { $record.components = $fpComposite }
            [PSCustomObject]$record | ConvertTo-Json -Compress | Add-Content -LiteralPath $telemetryPath -ErrorAction Stop
        } catch { }   # best-effort; never let telemetry logging break the guard
    } catch {
        # Dedup logic itself failed — fail-safe means ShouldPing stays $true (its declared
        # default above), never flips to $false here. Never let this block throw to the caller.
    }

    if ($alarm) {
        $hints = @()
        if ($behind -gt 0) {
            # Three arms, not two. A DIVERGED tree with no real WIP is correctly NOT SyncBlocked (no
            # owner-claim needed) — but it still cannot fast-forward: the remedy is the DevOps reset-sync
            # (docs/shared-tree-divergence.md Steps 1–5), never `merge --ff-only`. Branching on
            # SyncBlocked alone recommended ff-only for a diverged tree, contradicting its own SyncReason.
            $hints += if ($result.SyncBlocked) {
                "behind ($behind commit(s)) — SYNC BLOCKED: $($result.SyncReason). Do NOT ff; resolve per the real-WIP / diverged hint below (owner-claim, or the DevOps reset-sync)."
            } elseif ($result.AheadCount -gt 0) {
                "DIVERGED (ahead=$($result.AheadCount), behind=$behind) — ff is IMPOSSIBLE; no real WIP, so no owner-claim. DevOps reset-sync per docs/shared-tree-divergence.md: classify each local commit by CONTENT (Step 1; rescue any unique), collect per-owner acks (Step 3.2 — a state read is advisory only), then 'git status --short --untracked-files=no && git fetch origin && git reset --hard origin/main'. Do NOT run merge --ff-only (it will refuse)."
            } elseif ($result.UntrackedCollisions.Count -gt 0) {
                "behind ($behind commit(s)) — no real-WIP intersection, BUT $($result.UntrackedCollisions.Count) untracked local file(s) collide with an incoming ADD: `git merge --ff-only` WILL refuse ('untracked working tree files would be overwritten'). NOT a plain safe-ff — clear the collision(s) per the untracked-collision hint below, THEN ff."
            } else {
                "behind ($behind commit(s)) — ff-sync is SAFE ($($result.SyncReason)): git fetch && git merge --ff-only origin/main"
            }
        }
        if ($result.UntrackedCollisions.Count -gt 0) {
            $listed = $result.UntrackedCollisions -join ', '
            # t/4789: an untracked local file colliding with an incoming ADD blocks ff-only even when
            # byte-identical. SyncBlocked is intentionally NOT set for this class (tracked-WIP-only,
            # TL p/331#1674) — so give the compare-and-remove-if-identical remedy directly here.
            $hints += "UNTRACKED-vs-incoming-ADD collision(s) (t/4789) [$listed]: git merge --ff-only refuses to overwrite these untracked local files even if byte-identical. For EACH: compare the local file to origin's incoming version (MSYS_NO_PATHCONV=1 git show origin/main:<path>); if IDENTICAL, Remove-Item -LiteralPath <path> then ff; if DIFFERENT, it is unsaved local work — preserve it (copy aside, or claim with the path owner) BEFORE removing. This is a failed-ff backstop, NOT data loss; SyncBlocked stays false by design."
        }
        if ($result.UntrackedCollisionReason -match '^DEGRADED') {
            $hints += "untracked-collision check DEGRADED: $($result.UntrackedCollisionReason). This is 'could-not-check', NOT 'no collision' — if a subsequent ff is refused for an untracked path, use the compare-and-remove-if-identical remedy above."
        }
        if ($autoRemoved.Count -gt 0) {
            $listed = $autoRemoved -join ', '
            $hints += "auto-removed 0-byte junk [$listed]"
        }
        if ($shellFragmentPaths.Count -gt 0) {
            $listed = $shellFragmentPaths -join ', '
            $hints += "shell-fragment 0-byte file(s) detected — t/2112 mis-quote word-split signature [$listed]: auto-removed if guards passed; prefer explicit paths over 'git add -A' and avoid pasting multi-line code into the shell (Shell Quoting Rule)"
        }
        if ($remainingJunk.Count -gt 0) {
            $listed = $remainingJunk -join ', '
            $hints += "junk 0-byte file(s) NOT auto-removed (guard blocked) [$listed]: Remove-Item <paths> manually"
        }
        if ($suspiciousPaths.Count -gt 0) {
            $listed = $suspiciousPaths -join ', '
            $hints += "suspicious extension-less file(s) in source dir [$listed]: verify untracked, then Remove-Item <paths>"
        }
        if ($result.StrandedBranches.Count -gt 0) {
            $listed = $result.StrandedBranches -join '; '
            $hints += "AT-RISK branch(es) — unlanded commits no PR will land: STRANDED (pushed after merge) or DIVERGED-UNLANDED (force-pushed off the merged head) (t/3652) [$listed]: verify with the branch owner, then cherry-pick the unlanded commits onto the live target and delete/dismiss the branch (add to operations/devops/stranded-branch-dismissals.txt WITH a reason if intentionally kept). Detection-only — a human decides; do NOT auto-merge."
        }
        if ($result.StrandedBranchesInfo.Count -gt 0) {
            $listed = $result.StrandedBranchesInfo -join '; '
            $hints += "(info) DIVERGED-STALE branch(es) — diverged from a merged PR head but 0 unlanded commits (stale reset, nothing at risk) [$listed]: no action needed; delete when convenient."
        }
        if ($result.StrandedBranchesStatus -ne 'OK') {
            $hints += "stranded-branch check DEGRADED [$($result.StrandedBranchesStatus)]: $($result.StrandedBranchesReason). This is 'could-not-check', NOT 'clean' — re-run once gh is reachable/authed; a persistent gh-unauth/gh-absent is a host-config fix, a rate-limit/timeout is transient."
        }
        if ($nestedWorktrees.Count -gt 0) {
            $listed = $nestedWorktrees -join '; '
            $hints += "INERT nested .worktrees dir(s) outside <root>/.worktrees/ (t/3145; t/2222 cwd-reset drift) — routed to owning role [$listed]: orphaned copies (no .git safety net). OWNER: confirm inert (no .git, no unpushed/unique content) then 'Remove-Item -Recurse -Force <path>'. Active registered worktrees are EXEMPT (never listed)."
        }
        # t/3669: report phantom and real WIP as SEPARATE hints so a mixed dirty set names each
        # correctly — the old single-boolean lumped all dirty files under one verdict.
        if ($realWipFiles.Count -gt 0) {
            $listed = $realWipFiles -join ', '
            $hints += "dirty tracked with REAL DIFF (WIP) [$listed]: snapshot-first + owner-claim required — do NOT stash or auto-merge; escalate to TL | POST-CLAIM pull: git restore <files> THEN git pull --ff-only (dirty tracked file silently blocks ff-merge even on byte-identical incoming content — restore first; p/331#98)"
        }
        if ($phantomFiles.Count -gt 0) {
            $listed = $phantomFiles -join ', '
            $hints += "PHANTOM dirty tracked (byte-identical to origin/main modulo CRLF — NOT real WIP, no owner-claim) [$listed]: safe to restore unilaterally — git restore <files> THEN git pull --ff-only (a phantom silently blocks ff-merge even on byte-identical incoming; t/2066, p/331#98)"
        }
        $result.RemediationHint = $hints -join ' | '
    }
} catch {
    # Catch-all — never let the guard throw to the calling agent session
}

# Emit the object, then FORCE exit 0 to honor the contract ("Always exits 0", line 14). t/3652's
# classifier uses direct `& git merge-base --is-ancestor`, which leaves $LASTEXITCODE=1 on the
# DIVERGED/UNKNOWN paths; without an explicit exit that would leak as a non-zero script exit code
# (the pre-t/3652 script stayed 0 only because every git call went through Start-Job, which does
# not touch the parent's $LASTEXITCODE). Callers read the returned object, not the exit code.
$result
exit 0
