# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Test-DepDockerNeo4j {
    <#
    .SYNOPSIS
        Section 7b of Invoke-DependencyCheck (t/3910): Docker + the Neo4j container.
        Extracted verbatim.
    #>
    [CmdletBinding()]
    [OutputType([void])]
    param(
        [Parameter(Mandatory)][hashtable]$Ctx,
        [Parameter(Mandatory)][bool]$IsInstallMode,
        [Parameter(Mandatory)][bool]$Fix,
        [Parameter(Mandatory)][string]$Platform
    )

    Write-DepSection 'DOCKER & NEO4J (optional — graph database)'

    # NEO4J_URI pointing at a non-local host means Neo4j is managed externally
    # (e.g. a sibling `neo4j` container via docker compose) — same signal
    # Install-GraphDatabase uses to skip spinning up its own local container.
    $Neo4jManagedExternally = $env:NEO4J_URI -and $env:NEO4J_URI -notmatch 'localhost|127\.0\.0\.1'

    if (Get-Command docker -ErrorAction SilentlyContinue) {
        try {
            $DockerVer = ((docker --version 2>&1) -replace 'Docker version ', '' -replace ',.*', '').Trim()
            if ($DockerVer) {
                $DockerPing = docker info 2>&1
                if ($LASTEXITCODE -eq 0) {
                    Write-DepPass -Ctx $Ctx -Message "Docker $DockerVer (daemon running)"
                    if ($Neo4jManagedExternally) {
                        Write-DepSkip -Message "Neo4j managed externally ($env:NEO4J_URI) — skipping local container check"
                    }
                    else {
                        $Neo4jContainer = docker ps -a --filter 'name=ai-triad-neo4j' --format '{{.Status}}' 2>&1
                        if ($Neo4jContainer) {
                            if ($Neo4jContainer -match 'Up') { Write-DepPass -Ctx $Ctx -Message "Neo4j container running" }
                            else { Write-DepWarn -Ctx $Ctx -Message "Neo4j container exists but stopped — docker start ai-triad-neo4j" }
                        }
                        else { Write-DepSkip -Message 'Neo4j container not created — run Install-GraphDatabase' }
                    }
                }
                else { Write-DepWarn -Ctx $Ctx -Message "Docker $DockerVer installed but daemon not running" }
            }
            else { Write-DepWarn -Ctx $Ctx -Message 'Docker found but version check failed' }
        }
        catch { Write-DepWarn -Ctx $Ctx -Message "Docker smoke test failed: $_" }
    }
    elseif ($Neo4jManagedExternally) {
        Write-DepSkip -Message "Docker not installed — Neo4j is managed externally ($env:NEO4J_URI); Taxonomy Editor container mode unavailable here"
    }
    else {
        Write-DepWarn -Ctx $Ctx -Message 'Docker not installed (needed for Taxonomy Editor container mode and Neo4j)'
        if ($IsInstallMode) {
            Install-DependencyPackage -Ctx $Ctx -Fix $Fix -Platform $Platform -Name 'docker' -PackageNames @{
                brew = 'docker'; winget = 'Docker.DockerDesktop'; choco = 'docker-desktop'
            }
        }
    }
}
