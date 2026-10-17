# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Install-GraphDatabase {
    <#
    .SYNOPSIS
        Sets up a Neo4j instance via Docker for graph visualization and Cypher queries.
    .DESCRIPTION
        Pulls and runs the Neo4j Community Edition Docker container with persistent
        storage at ~/ai-triad-graphdb/. The container exposes:
        - Bolt protocol on port 7687 (for Cypher queries)
        - HTTP browser on port 7474 (for Neo4j Browser UI)

        If a container named 'ai-triad-neo4j' already exists, it will be started
        (not recreated) unless -Force is specified.
    .PARAMETER Force
        Remove and recreate the container even if it already exists.
    .PARAMETER Credential
        Neo4j credential (PSCredential — same type as Invoke-CypherQuery / Export-TaxonomyToGraph).
        Username defaults to 'neo4j'. Falls back to the NEO4J_PASSWORD env var (user 'neo4j'). If neither
        is provided, a random password is generated and printed ONCE — copy it to $env:NEO4J_PASSWORD or
        re-run with -Credential to reuse it.

        SECURITY NOTE (t/3830 + t/3833): typing this as PSCredential keeps the password out of
        $PSBoundParameters, transcripts, and shell history (PSSA-clean) — it is NOT an encryption boundary.
        The credential reaches the container via a bind-mounted NEO4J_AUTH_FILE (t/3833), so it is absent
        from the docker argv AND from `docker inspect` Config.Env (only the file PATH appears). A short-lived
        host file holds the secret during container init and is removed once an authenticated `RETURN 1`
        confirms the credential took; if it does not authenticate the install FAILS LOUDLY rather than
        silently leaving Neo4j on default credentials. (The host ACL restricts the host path only — on
        Docker Desktop/WSL2 it is not preserved inside the container VM, which is the intended reader.)
    .PARAMETER DataPath
        Path for persistent database storage. Default: ~/ai-triad-graphdb.
    .PARAMETER PassThru
        Emit a [PSCredential] on the pipeline (t/3839) so the install→query handoff can skip the
        plaintext $env:NEO4J_PASSWORD hop and pass straight to Invoke-CypherQuery/Export-TaxonomyToGraph
        via -Credential.

        SINGLE INVARIANT (SO e/242#2): a credential is emitted IF AND ONLY IF it has been
        authenticated against the running database during THIS invocation — the value's meaning
        never depends on which code path produced it. Every other outcome (unauthenticated,
        unreachable, timeout, install failure) emits nothing and WARNS naming why; it does not
        throw for this reason alone, since several of those paths are the install already
        succeeding at a different job (e.g. an already-running container).
    .OUTPUTS
        [PSCredential] when -PassThru is specified and the credential verified this invocation.
        Nothing otherwise (warnings explain why on every non-emit path).
    .EXAMPLE
        Install-GraphDatabase
    .EXAMPLE
        Install-GraphDatabase -Credential (Get-Credential neo4j)
    .EXAMPLE
        Install-GraphDatabase -Force
    .EXAMPLE
        $cred = Install-GraphDatabase -PassThru
        Export-TaxonomyToGraph -Full -Credential $cred
    .LINK
        Show-AITriadHelp
    .LINK
        Find-GraphPath
    .LINK
        Find-Conflict
    .LINK
        Invoke-GraphQuery
    .LINK
        Invoke-CypherQuery
    .LINK
        Invoke-QbafConflictAnalysis
    .LINK
        Show-GraphOverview
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [switch]$Force,

        [PSCredential]$Credential,

        [string]$DataPath = (Join-Path $HOME 'ai-triad-graphdb'),

        [switch]$PassThru
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    # Resolve credential → ($Neo4jUser, $Neo4jPassword): -Credential > NEO4J_PASSWORD env > generate once.
    # $Neo4jPassword is the materialized plaintext; it is used ONLY at the docker NEO4J_AUTH point-of-use
    # below (and printed once on the generate branch). See the SECURITY NOTE in the help — this typing
    # keeps the secret out of transcripts/history/$PSBoundParameters, it does NOT encrypt it.
    $Neo4jUser = 'neo4j'
    $Generated = $false
    if ($Credential) {
        $Neo4jUser = $Credential.UserName
        $Neo4jPassword = $Credential.GetNetworkCredential().Password   # point-of-use materialization
    } elseif ($env:NEO4J_PASSWORD) {
        # Env fallback matches the sibling cmdlets. NOTE: the env value is already plaintext in this
        # process (and inherited by children) — this path is not hardened by the retype; it is unchanged.
        $Neo4jPassword = $env:NEO4J_PASSWORD
    } else {
        $Neo4jPassword = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(18))
        $Generated = $true
        # The ONE sanctioned print of the secret — the generated password is otherwise unrecoverable.
        Write-Host ''
        Write-Host '  Neo4j password generated (not persisted):' -ForegroundColor Yellow
        Write-Host "    $Neo4jUser / $Neo4jPassword" -ForegroundColor Cyan
        Write-Host '  Set $env:NEO4J_PASSWORD = ''<above>'' or re-run with -Credential to reuse it.' -ForegroundColor Yellow
        Write-Host ''
    }

    $ContainerName = 'ai-triad-neo4j'
    # Single source for the image tag (pull + run). t/3833/SO cond.4: `community` is a floating tag — the
    # runtime credential check (Step 6b) is the guarantee against a version that doesn't honor NEO4J_AUTH_FILE.
    # RECOMMEND the Docker agent confirm the current `community` resolution and pick a non-downgrading pin.
    $Neo4jImage = 'neo4j:community'

    # ── Step 1: Check Docker ──
    Write-Step 'Checking Docker'
    try {
        $null = & docker version 2>&1
        if ($LASTEXITCODE -ne 0) { throw 'Docker not responding' }
        Write-OK 'Docker is available'
    } catch {
        # t/3857: this used to Write-Fail + bare `return` -- never rethrow, so a missing/stopped
        # Docker daemon was indistinguishable from a successful (silent no-op) install. No internal
        # caller relies on this today, but a silent $null on failure is a trap for the next one.
        throw (New-ActionableError -AsErrorRecord `
                -Goal 'Install Neo4j via Docker' `
                -Problem 'Docker is not installed or not running.' `
                -Location 'Install-GraphDatabase' `
                -NextSteps 'Install Docker Desktop from https://www.docker.com/products/docker-desktop')
    }

    # ── Step 2: Check for existing container ──
    $Existing = & docker ps -a --filter "name=$ContainerName" --format '{{.Names}}' 2>&1
    if ($Existing -eq $ContainerName) {
        if ($Force) {
            if ($PSCmdlet.ShouldProcess($ContainerName, 'Remove existing container')) {
                Write-Step 'Removing existing container'
                & docker rm -f $ContainerName 2>&1 | Out-Null
                Write-OK 'Removed'
            }
        } else {
            # Check if running
            $Running = & docker ps --filter "name=$ContainerName" --format '{{.Names}}' 2>&1
            if ($Running -eq $ContainerName) {
                Write-OK "Container '$ContainerName' is already running"
                Write-Info "Neo4j Browser: http://localhost:7474"
                Write-Info "Bolt URI: bolt://localhost:7687"
                # t/3839: this container may have been created on a prior run with a DIFFERENT
                # credential than the one just resolved above — resolution has no way to know what
                # it was created with. Write-PassThruCredential enforces the single invariant: probe
                # THIS invocation and emit only on proof, never the resolved-but-unproven value.
                if ($PassThru) {
                    Write-PassThruCredential -Credential (ConvertTo-Neo4jCredential -Principal $Neo4jUser -Secret $Neo4jPassword)
                }
                return
            } else {
                Write-Step 'Starting existing container'
                & docker start $ContainerName 2>&1 | Out-Null
                Write-OK "Container '$ContainerName' started"
                Write-Info "Neo4j Browser: http://localhost:7474"
                Write-Info "Bolt URI: bolt://localhost:7687"
                if ($PassThru) {
                    Write-PassThruCredential -Credential (ConvertTo-Neo4jCredential -Principal $Neo4jUser -Secret $Neo4jPassword)
                }
                return
            }
        }
    }

    # ── Step 3: Create data directory ──
    if (-not (Test-Path $DataPath)) {
        if ($PSCmdlet.ShouldProcess($DataPath, 'Create data directory')) {
            New-Item -ItemType Directory -Path $DataPath -Force | Out-Null
            New-Item -ItemType Directory -Path (Join-Path $DataPath 'data') -Force | Out-Null
            New-Item -ItemType Directory -Path (Join-Path $DataPath 'logs') -Force | Out-Null
            Write-OK "Created $DataPath"
        }
    }

    # ── Step 4: Pull Neo4j image ──
    Write-Step 'Pulling Neo4j image'
    & docker pull $Neo4jImage 2>&1 | ForEach-Object { Write-Info $_ }
    Write-OK 'Image ready'

    # ── Step 5: Run container ──
    # SECRET CHANNEL (t/3833): the credential is passed via a bind-mounted NEO4J_AUTH_FILE, NOT `-e NEO4J_AUTH`,
    # so the plaintext is absent from the docker argv (process list) AND from `docker inspect` Config.Env (only
    # the in-container PATH appears). The host file is short-lived and removed after Step 6b verifies the
    # credential actually took. ACL note (SO cond.5): the host ACL restricts the host path only — on Docker
    # Desktop/WSL2 it is not preserved inside the container VM (the container is the intended reader).
    Write-Step 'Starting Neo4j container'
    $AuthFile = Join-Path $DataPath '.neo4j-auth'   # NOT under the data/ or logs/ mounted subdirs
    $ContainerStarted = $false
    if ($PSCmdlet.ShouldProcess($ContainerName, 'Create and start Neo4j container')) {
        # BOM-free UTF-8, no trailing newline — a BOM or newline would corrupt the NEO4J_AUTH value the
        # entrypoint reads (and -Encoding utf8 writes a BOM on PS 5.1). Any bad encoding is caught loudly by
        # the Step 6b auth check rather than silently mis-setting the password.
        [System.IO.File]::WriteAllText($AuthFile, "$Neo4jUser/$Neo4jPassword", (New-Object System.Text.UTF8Encoding $false))
        try { & icacls $AuthFile /inheritance:r /grant:r "${env:USERNAME}:(R)" *> $null }
        catch { Write-Verbose "Best-effort ACL on the auth file failed (non-fatal): $($_.Exception.Message)" }
        & docker run -d `
            --name $ContainerName `
            -p 7474:7474 `
            -p 7687:7687 `
            -v "$DataPath/data:/data" `
            -v "$DataPath/logs:/logs" `
            -v "${AuthFile}:/run/secrets/neo4j-auth:ro" `
            -e "NEO4J_AUTH_FILE=/run/secrets/neo4j-auth" `
            -e "NEO4J_PLUGINS=[""apoc""]" `
            $Neo4jImage 2>&1 | Out-Null

        if ($LASTEXITCODE -eq 0) {
            $ContainerStarted = $true
            Write-OK "Neo4j container '$ContainerName' started"
        } else {
            # Don't leave the secret on a failed start.
            Remove-Item -LiteralPath $AuthFile -Force -ErrorAction SilentlyContinue
            Write-Fail 'Failed to start Neo4j container'
            if ($PassThru) { Write-Warn '-PassThru: no credential emitted (container start failed).' }
            return
        }
    }

    # ── Step 6 / 6b: readiness + AUTHENTICATED verify (only when we actually started a container) ──
    # t/3877: extracted to Confirm-Neo4jReadyAndAuth (Private/) -- this whole block is one
    # self-contained unit (readiness poll, then the authenticated verify + its three outcomes),
    # moved verbatim; Write-Output inside it still reaches Install-GraphDatabase's own pipeline
    # since it's called as a bare statement here, never captured.
    if ($ContainerStarted) {
        Confirm-Neo4jReadyAndAuth -ContainerName $ContainerName -Principal $Neo4jUser `
            -Secret $Neo4jPassword -AuthFile $AuthFile -PassThru:$PassThru
    }

    Write-Host ''
    Write-Host '=== Neo4j Installation Complete ===' -ForegroundColor Cyan
    Write-Host "  Neo4j Browser: http://localhost:7474" -ForegroundColor Green
    Write-Host "  Bolt URI:      bolt://localhost:7687" -ForegroundColor Green
    Write-Host "  Username:      $Neo4jUser" -ForegroundColor Green
    # Deliberately NOT printing the password here (t/3830 cond.1): the only sanctioned print is the
    # one-time generate-branch output above. Reprinting the resolved secret in this summary would leak a
    # provided/env password into console scrollback + any active transcript.
    $PwHint = if ($Generated) { 'see generated value above' } elseif ($Credential) { 'as provided via -Credential' } else { 'from $env:NEO4J_PASSWORD' }
    Write-Host "  Password:      ($PwHint)" -ForegroundColor Green
    Write-Host "  Data path:     $DataPath" -ForegroundColor Green
    Write-Host ''
    Write-Host 'Next steps:' -ForegroundColor Cyan
    Write-Host '  1. Export-TaxonomyToGraph -Full' -ForegroundColor White
    Write-Host '  2. Open http://localhost:7474 in your browser' -ForegroundColor White
    Write-Host ''
}
