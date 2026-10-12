# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Show-TaxonomyEditor {
    <#
    .SYNOPSIS
        Launch the Taxonomy Editor.
    .DESCRIPTION
        Starts the Taxonomy Editor and opens it in your default web browser.

        By default, runs in container mode (Docker): all dependencies are
        encapsulated in a Docker image, so nothing beyond Docker needs to be
        installed on the host.

        Falls back to legacy dev mode (Electron via npm run dev) if Docker is
        not available but Node.js is installed.

        Use -Dev to force legacy Electron dev mode even when Docker is available.

        Before launching, the local data repository (and, in dev mode, the code
        repository) is synced with GitHub via a fast-forward-only pull. If GitHub
        is unreachable or local history has diverged, a warning is shown and the
        launch proceeds with the local copy.

        In dev mode the app is rebuilt from source on every launch (npm run dev),
        and Node dependencies are reinstalled automatically when pnpm-lock.yaml no
        longer matches the installed node_modules.
    .PARAMETER Port
        Port for the web server. Default: 7862.
    .PARAMETER DataPath
        Override the data directory path. By default, resolved via .aitriad.json
        or $env:AI_TRIAD_DATA_ROOT.
    .PARAMETER NoBrowser
        Start the server without opening a browser.
    .PARAMETER Pull
        Force-pull the latest Docker image even if one is already cached.
    .PARAMETER Detach
        Run the container in the background and return immediately.
    .PARAMETER Stop
        Stop a detached Taxonomy Editor container.
    .PARAMETER Status
        Show whether a Taxonomy Editor container is running.
    .PARAMETER Dev
        Force legacy Electron dev mode (npm run dev) instead of container mode.
        Alias: -NoDocker.
    .EXAMPLE
        Show-TaxonomyEditor
        # Opens in browser via Docker container
    .EXAMPLE
        Show-TaxonomyEditor -Port 8080 -DataPath ~/research-data
        # Custom port and data directory
    .EXAMPLE
        Show-TaxonomyEditor -Detach
        # ... later ...
        Show-TaxonomyEditor -Stop
    .EXAMPLE
        Show-TaxonomyEditor -Dev
        # Legacy Electron desktop app (requires Node.js)
    .EXAMPLE
        Show-TaxonomyEditor -NoDocker
        # Same as -Dev — skip Docker, use Electron directly
    .LINK
        Show-AITriadHelp
    .LINK
        Show-POViewer
    .LINK
        Show-SummaryViewer
    .LINK
        Show-WorkflowRunner
    .LINK
        Show-AITriadHelp
    #>
    [CmdletBinding(DefaultParameterSetName = 'Run')]
    param(
        [Parameter(ParameterSetName = 'Run')]
        [Parameter(ParameterSetName = 'Dev')]
        [int]$Port = 7862,

        [Parameter(ParameterSetName = 'Run')]
        [string]$DataPath,

        [Parameter(ParameterSetName = 'Run')]
        [Parameter(ParameterSetName = 'Dev')]
        [switch]$NoBrowser,

        [Parameter(ParameterSetName = 'Run')]
        [switch]$Pull,

        [Parameter(ParameterSetName = 'Run')]
        [switch]$Detach,

        [Parameter(ParameterSetName = 'Stop')]
        [switch]$Stop,

        [Parameter(ParameterSetName = 'Status')]
        [switch]$Status,

        [Parameter(ParameterSetName = 'Dev')]
        [Alias('NoDocker')]
        [switch]$Dev
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    # ── Handle -Stop and -Status immediately ──────────────────────────────────
    if ($Stop) {
        Stop-TaxonomyContainer -Port $Port
        return
    }
    if ($Status) {
        Get-TaxonomyContainerStatus -Port $Port
        return
    }

    # ── Decide launch mode ────────────────────────────────────────────────────
    if ($Dev) {
        # Forced legacy Electron dev mode — needs Node.js, npm, code repo
        Start-LegacyElectronMode -NoBrowser:$NoBrowser
        return
    }

    # ── Container mode: check if Docker is already working first ────────────
    $DockerReady = $false
    if (Get-Command docker -ErrorAction SilentlyContinue) {
        try {
            $null = docker info 2>&1
            if ($LASTEXITCODE -eq 0) { $DockerReady = $true }
        }
        catch { }
    }

    # Only check Windows prerequisites if Docker isn't already working
    if (-not $DockerReady -and $IsWindows) {
        # 1. Windows Containers feature must be enabled first
        $ContainersEnabled = $false
        try {
            $Feature = Get-WindowsOptionalFeature -Online -FeatureName Containers -ErrorAction SilentlyContinue
            if ($Feature -and $Feature.State -eq 'Enabled') { $ContainersEnabled = $true }
        }
        catch { }

        if (-not $ContainersEnabled) {
            Write-Warn 'The Windows Containers feature is not enabled. This is required before WSL or Docker can be installed.'
            $Choice = $Host.UI.PromptForChoice(
                'Enable Containers',
                'Would you like to enable the Windows Containers feature now? (requires admin privileges and a restart)',
                @('&Yes', '&No'),
                0
            )
            if ($Choice -eq 0) {
                Write-Step 'Enabling Windows Containers feature'
                try {
                    Enable-WindowsOptionalFeature -Online -FeatureName Containers -All -NoRestart 2>&1 | ForEach-Object { Write-Info "$_" }
                    Write-OK 'Containers feature enabled'
                    Write-Warn 'A restart is required. After restarting, run: Show-TaxonomyEditor'
                }
                catch {
                    Write-Fail "Failed to enable Containers feature: $_"
                    Write-Info 'Try running from an elevated (Admin) terminal:'
                    Write-Info '  Enable-WindowsOptionalFeature -Online -FeatureName Containers -All'
                }
            }
            else {
                Write-Info 'Enable it manually from an Admin terminal:'
                Write-Info '  Enable-WindowsOptionalFeature -Online -FeatureName Containers -All'
            }
        }

        # 2. WSL must be installed
        $WslReady = $false
        try {
            $WslOutput = wsl --status 2>&1
            if ($LASTEXITCODE -eq 0) { $WslReady = $true }
        }
        catch { }

        if (-not $WslReady) {
            Write-Warn 'WSL (Windows Subsystem for Linux) is required for Docker Desktop on Windows.'
            $Choice = $Host.UI.PromptForChoice(
                'Install WSL',
                'Would you like to install WSL now? (requires admin privileges and a restart)',
                @('&Yes', '&No'),
                0
            )
            if ($Choice -eq 0) {
                Write-Step 'Installing WSL'
                try {
                    wsl --install --no-distribution 2>&1 | ForEach-Object { Write-Info $_ }
                    if ($LASTEXITCODE -eq 0) {
                        Write-OK 'WSL installed'
                        Write-Warn 'A restart may be required before Docker can use WSL 2.'
                        Write-Info 'After restarting, run: Show-TaxonomyEditor'
                    }
                    else {
                        Write-Fail 'WSL installation returned a non-zero exit code.'
                        Write-Info 'Try running "wsl --install" from an elevated (Admin) terminal.'
                    }
                }
                catch {
                    Write-Fail "WSL installation failed: $_"
                    Write-Info 'Try running "wsl --install" from an elevated (Admin) terminal.'
                }
            }
            else {
                Write-Info 'WSL is required for Docker. Install it with: wsl --install'
            }
        }
    }

    if (-not $DockerReady) {
        $DockerInstalled = [bool](Get-Command docker -ErrorAction SilentlyContinue)

        if ($DockerInstalled) {
            # Docker installed but daemon not running — offer to start it
            Write-Warn 'Docker is installed but the daemon is not running.'
            $Choice = $Host.UI.PromptForChoice(
                'Start Docker',
                'Would you like to start Docker Desktop now?',
                @('&Yes', '&No'),
                0
            )
            if ($Choice -eq 0) {
                Write-Step 'Starting Docker Desktop'
                if ($IsWindows) {
                    $DockerExe = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
                    if (-not (Test-Path $DockerExe)) {
                        # Try common alternate location
                        $DockerExe = Join-Path ${env:ProgramFiles(x86)} 'Docker\Docker\Docker Desktop.exe'
                    }
                    if (Test-Path $DockerExe) {
                        Start-Process $DockerExe
                    }
                    else {
                        # Fall back to searching PATH
                        Start-Process 'Docker Desktop' -ErrorAction SilentlyContinue
                    }
                }
                elseif ($IsMacOS) {
                    open -a Docker 2>&1 | Out-Null
                }

                # Wait for the daemon to become ready
                Write-Info 'Waiting for Docker daemon to start...'
                $Timeout = 60
                $Elapsed = 0
                while ($Elapsed -lt $Timeout) {
                    Start-Sleep -Seconds 3
                    $Elapsed += 3
                    try {
                        $null = docker info 2>&1
                        if ($LASTEXITCODE -eq 0) { $DockerReady = $true; break }
                    }
                    catch { }
                    Write-Host '.' -NoNewline
                }
                Write-Host ''
                if ($DockerReady) {
                    Write-OK 'Docker daemon is running'
                }
                else {
                    Write-Warn "Docker daemon did not start within $Timeout seconds."
                    Write-Info 'Start Docker Desktop manually and try again.'
                }
            }
        }
        else {
            # Docker not installed — offer to install it
            Write-Warn 'Docker is not installed. It is the only dependency needed to run the Taxonomy Editor.'
            $Choice = $Host.UI.PromptForChoice(
                'Install Docker',
                'Would you like to install Docker Desktop now?',
                @('&Yes', '&No'),
                0
            )
            if ($Choice -eq 0) {
                $PM = $null
                if ($IsWindows) {
                    if     (Get-Command winget -ErrorAction SilentlyContinue) { $PM = 'winget' }
                    elseif (Get-Command choco  -ErrorAction SilentlyContinue) { $PM = 'choco' }
                } elseif ($IsMacOS) {
                    if (Get-Command brew -ErrorAction SilentlyContinue) { $PM = 'brew' }
                }
                if ($PM) {
                    Write-Step "Installing Docker via $PM"
                    switch ($PM) {
                        'winget' { winget install --id Docker.DockerDesktop --accept-package-agreements --accept-source-agreements 2>&1 | ForEach-Object { Write-Info $_ } }
                        'choco'  { choco install docker-desktop -y 2>&1 | ForEach-Object { Write-Info $_ } }
                        'brew'   { brew install --cask docker 2>&1 | ForEach-Object { Write-Info $_ } }
                    }
                    Write-Info 'You may need to restart your terminal and start Docker Desktop before continuing.'
                }
                else {
                    Write-Info 'No package manager found. Download Docker Desktop from:'
                    Write-Info '  https://www.docker.com/products/docker-desktop/'
                }
            }
        }

        if (-not $DockerReady) {
            # Fall back to dev mode if npm is available
            if (Get-Command npm -ErrorAction SilentlyContinue) {
                Write-Info 'Falling back to Electron dev mode (npm detected).'
                Start-LegacyElectronMode -NoBrowser:$NoBrowser
                return
            }

            throw (New-ActionableError `
                -Goal 'Launch Taxonomy Editor' `
                -Problem 'Docker is not available' `
                -Location 'Show-TaxonomyEditor' `
                -NextSteps @(
                    'Start Docker Desktop, then try: Show-TaxonomyEditor'
                ))
        }
    }

    # ── Ensure data is available (clone from GitHub if needed) ────────────────
    $ResolvedData = $DataPath
    if (-not $ResolvedData) {
        try { $ResolvedData = Get-DataRoot } catch { $ResolvedData = $null }
    }
    $TaxDir = $null
    if ($ResolvedData) {
        $TaxDir = Join-Path $ResolvedData (Join-Path 'taxonomy' 'Origin')
    }
    if (-not $TaxDir -or -not (Test-Path (Join-Path $TaxDir 'accelerationist.json') -ErrorAction SilentlyContinue)) {
        Write-Warn 'AI Triad data not found.'
        $Choice = $Host.UI.PromptForChoice(
            'Missing Data',
            'Would you like to download the data from GitHub now?',
            @('&Yes', '&No'),
            0
        )
        if ($Choice -eq 0) {
            if (Get-Command git -ErrorAction SilentlyContinue) {
                Install-AITriadData
            }
            else {
                Write-Warn 'git is not available to clone the data repository.'
                Write-Info 'Install git, then run: Install-AITriadData'
            }
        }
    }

    # ── Keep the local data repo current with GitHub (t/2478) ────────────────
    if ($ResolvedData -and (Test-Path (Join-Path $ResolvedData '.git'))) {
        Write-Step 'Syncing data repository with GitHub'
        $null = Update-GitRepository -Path $ResolvedData -Label 'data repository'
    }

    # ── Launch container ─────────────────────────────────────────────────────
    Start-ContainerMode -Port $Port -DataPath $DataPath -NoBrowser:$NoBrowser `
        -Pull:$Pull -Detach:$Detach
}

# ── Private: Legacy Electron mode ─────────────────────────────────────────────

function Start-LegacyElectronMode {
    [CmdletBinding()]
    param([switch]$NoBrowser)

    $CodeRoot = Get-CodeRoot
    if (-not $CodeRoot) {
        throw (New-ActionableError `
            -Goal 'Launch Taxonomy Editor (dev mode)' `
            -Problem 'Cannot find the ai-triad-research code repository' `
            -Location 'Start-LegacyElectronMode' `
            -NextSteps @(
                'Set $env:AI_TRIAD_CODE_ROOT to the path where you cloned ai-triad-research'
                'Or cd into the ai-triad-research directory before running this command'
                'Or clone the repo: git clone https://github.com/jsnov/ai-triad-research'
            ))
    }
    $AppDir = Join-Path $CodeRoot 'taxonomy-editor'
    if (-not (Test-Path $AppDir)) {
        Write-Fail "App directory not found: $AppDir"
        return
    }

    # ── Keep local repos current with GitHub (t/2478) ─────────────────────
    # Dev mode builds from source, so the code repo matters here too.
    Write-Step 'Syncing code repository with GitHub'
    $null = Update-GitRepository -Path $CodeRoot -Label 'code repository'
    $DevDataRoot = $null
    try { $DevDataRoot = Get-DataRoot } catch { $DevDataRoot = $null }
    if ($DevDataRoot -and (Test-Path (Join-Path $DevDataRoot '.git'))) {
        Write-Step 'Syncing data repository with GitHub'
        $null = Update-GitRepository -Path $DevDataRoot -Label 'data repository'
    }

    # Check data
    $TaxDir  = Get-TaxonomyDir
    $DataOk  = Test-Path (Join-Path $TaxDir 'accelerationist.json')
    if (-not $DataOk) {
        Write-Warn "AI Triad data not found at: $TaxDir"
        $Choice = $Host.UI.PromptForChoice(
            'Missing Data',
            'Run Install-AITriadData to clone the data repository?',
            @('&Yes', '&No'),
            0
        )
        if ($Choice -eq 0) {
            Install-AITriadData
            if (-not (Test-Path (Join-Path $TaxDir 'accelerationist.json'))) {
                Write-Fail 'Data installation did not complete. Cannot launch Taxonomy Editor.'
                return
            }
        }
        else {
            Write-Warn 'Launching without data — the app may not function correctly.'
        }
    }

    # Check npm
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        Write-Warn 'npm not found — Node.js is required for Electron dev mode.'
        $Choice = $Host.UI.PromptForChoice(
            'Missing Dependency',
            'Run Install-AIDependencies to install Node.js and other dependencies?',
            @('&Yes', '&No'),
            0
        )
        if ($Choice -eq 0) {
            Install-AIDependencies -SkipPython
        }
        if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
            Write-Fail 'npm still not found after install attempt. Cannot launch Taxonomy Editor.'
            return
        }
    }

    # Check node_modules against the committed lockfile. `npm run dev` rebuilds the app
    # from source on every launch, but not its dependencies — so a pull that changed
    # pnpm-lock.yaml would otherwise run against the stale install. A first-time install
    # still asks; a lockfile change reinstalls without prompting.
    $Deps = Test-NodeModulesCurrent -RepoRoot $CodeRoot
    if (-not $Deps.Current) {
        $DoInstall = $true
        if ($Deps.Reason -eq 'not-installed') {
            Write-Warn 'Node modules are not installed.'
            $Choice = $Host.UI.PromptForChoice(
                'Missing Node Modules',
                "Run 'pnpm install' in the code repository?",
                @('&Yes', '&No'),
                0
            )
            $DoInstall = ($Choice -eq 0)
        }
        else {
            Write-Warn 'Dependencies changed since the last install (pnpm-lock.yaml differs from node_modules) — reinstalling'
        }

        if ($DoInstall) {
            Write-Step 'Installing Node modules'
            Push-Location $CodeRoot
            try {
                pnpm install --frozen-lockfile
                if ($LASTEXITCODE -ne 0) {
                    Write-Fail "pnpm install failed (exit code $LASTEXITCODE)."
                    return
                }
                Write-OK 'Node modules installed.'
            }
            finally { Pop-Location }
        }
        else {
            Write-Warn "Proceeding without node_modules — 'npm run dev' will likely fail."
        }
    }

    # Warn on orphaned worktrees (t/2769). A leftover dir under .worktrees/ that git
    # no longer tracks can pollute node_modules resolution for `npm run dev`, surfacing
    # as TS errors that look like source bugs (t/2768). Non-blocking.
    #
    # t/3846: Get-OrphanedWorktree finds directories present on disk but NOT
    # registered in `git worktree list` -- the inverse of what `git worktree prune`
    # cleans up (registered-but-missing directories). `prune` is a no-op here;
    # the remedy is deletion, gated on the safety check below. Worktree removal on
    # Windows routinely leaves node_modules/ behind (Sage #78), so confirmed residue
    # is deleted automatically in the background rather than reported for hand cleanup.
    $Orphaned = @(Get-OrphanedWorktree -RepoRoot $CodeRoot)
    if ($Orphaned.Count -gt 0) {
        foreach ($OrphanPath in $Orphaned) {
            $OrphanRel = [System.IO.Path]::GetRelativePath($CodeRoot, $OrphanPath)
            $Safety = Test-OrphanedWorktreeSafeToDelete -Path $OrphanPath
            if ($Safety.SafeToDelete) {
                if (Remove-OrphanedWorktree -Path $OrphanPath) {
                    Write-Info "Removing orphaned worktree residue in background: $OrphanRel ($($Safety.Reason))"
                }
            } else {
                Write-Warn "Orphaned worktree directory (not registered in git worktree list): $OrphanRel"
                Write-Warn "   NOT auto-removable: $($Safety.Reason)"
            }
        }
    }

    # Clear any stale process on port 5173 (vite dev server port) before launching
    $staleConn = Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue
    if ($staleConn) {
        $stalePid = $staleConn.OwningProcess | Select-Object -First 1
        Write-Info "Port 5173 in use by PID $stalePid — stopping stale dev server"
        Stop-Process -Id $stalePid -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 500
    }

    # Launch
    Push-Location $AppDir
    try {
        npm run dev
        if ($LASTEXITCODE -ne 0) {
            Write-Fail "npm run dev exited with code $LASTEXITCODE."
        }
    }
    finally { Pop-Location }
}

# ── Private: Container mode ───────────────────────────────────────────────────

function Start-ContainerMode {
    [CmdletBinding()]
    param(
        [int]$Port,
        [string]$DataPath,
        [switch]$NoBrowser,
        [switch]$Pull,
        [switch]$Detach
    )

    $ImageName     = 'ghcr.io/ai-rosetta-stone/taxonomy-editor:latest'
    $ContainerName = Get-ContainerName -Port $Port

    # ── Resolve data path ─────────────────────────────────────────────────
    if (-not $DataPath) {
        # Use the same resolution logic as the module
        if ($env:AI_TRIAD_DATA_ROOT) {
            $DataPath = $env:AI_TRIAD_DATA_ROOT
        }
        else {
            try {
                $DataPath = Resolve-DataPath '.'
            }
            catch {
                # Last resort: sibling directory of code repo, or platform default
                $CodeRoot = Get-CodeRoot
                if ($CodeRoot) {
                    $DataPath = Join-Path (Split-Path $CodeRoot -Parent) 'ai-triad-data'
                } else {
                    $DataPath = Get-PlatformDataDir
                }
            }
        }
    }

    $resolved = Resolve-Path -Path $DataPath -ErrorAction SilentlyContinue
    $DataPath = if ($resolved) { $resolved.Path } else { $null }
    if (-not $DataPath -or -not (Test-Path $DataPath)) {
        Write-Warn "Data directory not found: $DataPath"
        Write-Info  'The editor will show the First Run dialog to set up data.'
        # Create the directory so Docker can mount it
        $CodeRoot = Get-CodeRoot
        $DataPath = if ($env:AI_TRIAD_DATA_ROOT) { $env:AI_TRIAD_DATA_ROOT }
                    elseif ($CodeRoot) { Join-Path (Split-Path $CodeRoot -Parent) 'ai-triad-data' }
                    else { Get-PlatformDataDir }
        $null = New-Item -ItemType Directory -Path $DataPath -Force -ErrorAction SilentlyContinue
    }

    Write-Info "Data directory: $DataPath"

    # ── Check for existing container on this port ─────────────────────────
    if (Test-TaxonomyContainerRunning -Port $Port) {
        Write-OK "Taxonomy Editor is already running at http://localhost:$Port"
        if (-not $NoBrowser) {
            Start-Process "http://localhost:$Port"
        }
        return
    }

    # ── Clean up stale container with same name ──────────────────────────
    $stale = docker ps -a --filter "name=$ContainerName" --format '{{.Names}}' 2>&1
    if ($stale -eq $ContainerName) {
        docker rm $ContainerName 2>&1 | Out-Null
    }

    # ── Pull image if needed ──────────────────────────────────────────────
    if ($Pull -or -not (Test-DockerImageExists -ImageName $ImageName)) {
        Pull-TaxonomyEditorImage -ImageName $ImageName
    }

    # ── Build docker run arguments ────────────────────────────────────────
    # Get-ApiKeyEnvArgs writes keys to a 0600 temp env-file and returns
    # @('--env-file', <path>) — we delete that file once docker has read it (t/2530 L3).
    $envArgs = Get-ApiKeyEnvArgs
    $envFilePath = if ($envArgs.Count -ge 2 -and $envArgs[0] -eq '--env-file') { $envArgs[1] } else { $null }
    $removeEnvFile = {
        if ($envFilePath -and (Test-Path -LiteralPath $envFilePath)) {
            Remove-Item -LiteralPath $envFilePath -Force -ErrorAction SilentlyContinue
        }
    }

    # UID/GID for bind mount and tmpfs ownership
    $uid = $null
    $gid = $null
    if ($IsLinux -or $IsMacOS) {
        $uid = id -u 2>$null
        $gid = id -g 2>$null
    }
    $tmpfsUidOpt = if ($uid -and $gid) { ",uid=$uid,gid=$gid" } else { '' }

    $runArgs = @(
        'run', '--rm'
        '--name', $ContainerName
        '-p', "${Port}:7862"
        '-v', "${DataPath}:/data"
        # Security hardening
        '--cap-drop', 'ALL'
        '--read-only'
        '--tmpfs', "/tmp:rw,noexec,nosuid,size=256m${tmpfsUidOpt}"
        '--tmpfs', "/app/.cache:rw,noexec,nosuid,size=512m${tmpfsUidOpt}"
        # Writable home for PowerShell config/cache (needed with --read-only)
        '--tmpfs', "/home/aitriad:rw,noexec,nosuid,size=64m${tmpfsUidOpt}"
        '-e', 'HOME=/home/aitriad'
        # Resource limits
        '--memory', '4g'
        '--cpus', '2'
    )

    # UID/GID matching — prevent file permission mismatches on the bind mount
    if ($uid -and $gid) {
        $runArgs += '--user'
        $runArgs += "${uid}:${gid}"
    }

    $runArgs += $envArgs

    if ($Detach) {
        $runArgs += '-d'
    }

    $runArgs += $ImageName

    # ── Launch ────────────────────────────────────────────────────────────
    if ($Detach) {
        Write-Step 'Starting Taxonomy Editor (detached)'
        $dockerOutput = docker @runArgs 2>&1
        & $removeEnvFile   # docker has read --env-file; remove the secret now
        if ($LASTEXITCODE -ne 0) {
            $errorText = ($dockerOutput | Out-String).Trim()
            Write-Fail "Failed to start container (exit code $LASTEXITCODE)."
            if ($errorText -match 'port is already allocated|address already in use') {
                Write-Warn "Port $Port is already in use by another process."
                Write-Info "Fix: Stop whatever is using port ${Port}:"
                Write-Info "  docker ps                          # find the container"
                Write-Info "  docker stop <container-id>         # stop it"
                Write-Info "  lsof -i :$Port                     # or find non-Docker process"
                Write-Info "Or use a different port: Show-TaxonomyEditor -Port 8080"
            }
            elseif ($errorText -match 'is already in use by container') {
                Write-Warn "A container named '$ContainerName' already exists."
                Write-Info "Fix: Remove the stale container and retry:"
                Write-Info "  docker rm $ContainerName"
                Write-Info "  Show-TaxonomyEditor"
            }
            elseif ($errorText -match 'No such image') {
                Write-Warn 'Docker image not found locally.'
                Write-Info "Fix: Pull the image first:"
                Write-Info "  Show-TaxonomyEditor -Pull"
            }
            else {
                Write-Info "Docker error: $errorText"
                Write-Info "Try: docker logs $ContainerName"
            }
            return
        }

        $ready = Wait-ForHealthEndpoint -Port $Port -TimeoutSeconds 30
        if ($ready) {
            Test-ContainerVersionCompat -Port $Port
            if (-not $NoBrowser) {
                Start-Process "http://localhost:$Port"
            }
        }
        Write-OK "Taxonomy Editor running at http://localhost:$Port (detached)"
        Write-Info "Stop with: Show-TaxonomyEditor -Stop"
    }
    else {
        Write-Step 'Starting Taxonomy Editor'

        # Start the container detached, then block here until Ctrl+C
        $fgArgs = $runArgs.Clone()
        # Insert -d flag before the image name (last element)
        $fgArgs = @($fgArgs[0..($fgArgs.Count - 2)]) + @('-d') + @($fgArgs[-1])

        $dockerOutput = docker @fgArgs 2>&1
        & $removeEnvFile   # docker has read --env-file; remove the secret now
        if ($LASTEXITCODE -ne 0) {
            $errorText = ($dockerOutput | Out-String).Trim()
            Write-Fail "Failed to start container (exit code $LASTEXITCODE)."
            if ($errorText -match 'port is already allocated|address already in use') {
                Write-Warn "Port $Port is already in use by another process."
                Write-Info "Fix: Stop whatever is using port ${Port}:"
                Write-Info "  docker ps                          # find the container"
                Write-Info "  docker stop <container-id>         # stop it"
                Write-Info "  lsof -i :$Port                     # or find non-Docker process"
                Write-Info "Or use a different port: Show-TaxonomyEditor -Port 8080"
            }
            elseif ($errorText -match 'is already in use by container') {
                Write-Warn "A container named '$ContainerName' already exists."
                Write-Info "Fix: Remove the stale container and retry:"
                Write-Info "  docker rm $ContainerName"
                Write-Info "  Show-TaxonomyEditor"
            }
            elseif ($errorText -match 'No such image') {
                Write-Warn 'Docker image not found locally.'
                Write-Info "Fix: Pull the image first:"
                Write-Info "  Show-TaxonomyEditor -Pull"
            }
            else {
                Write-Info "Docker error: $errorText"
                Write-Info "Try: docker logs $ContainerName"
            }
            return
        }

        # Wait for the health endpoint
        $ready = Wait-ForHealthEndpoint -Port $Port -TimeoutSeconds 30
        if ($ready) {
            Test-ContainerVersionCompat -Port $Port
            if (-not $NoBrowser) {
                Start-Process "http://localhost:$Port"
            }
            Write-OK "Taxonomy Editor running at http://localhost:$Port"
            Write-Info 'Press Ctrl+C to stop.'
        }

        # Block until the user presses Ctrl+C
        try {
            while (Test-TaxonomyContainerRunning -Port $Port) {
                Start-Sleep -Seconds 2
            }
        }
        catch {
            # Ctrl+C
        }
        finally {
            if (Test-TaxonomyContainerRunning -Port $Port) {
                Write-Step 'Stopping container...'
                docker stop $ContainerName 2>&1 | Out-Null
            }
            # Clean up the stopped container
            docker rm $ContainerName 2>&1 | Out-Null
            Write-OK 'Stopped.'
        }
    }
}
