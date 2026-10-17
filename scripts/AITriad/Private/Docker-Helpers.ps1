# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Docker lifecycle helpers for Show-TaxonomyEditor container mode.
.DESCRIPTION
    Internal functions that manage the Docker container for the Taxonomy Editor
    web server. Not exported — called exclusively by Show-TaxonomyEditor.
#>

function Assert-DockerAvailable {
    <#
    .SYNOPSIS
        Verifies Docker CLI is installed and the daemon is reachable.
    #>
    [CmdletBinding()]
    param()

    $docker = Get-Command docker -ErrorAction SilentlyContinue
    if (-not $docker) {
        $msg = @(
            'Docker is required but not installed.'
            ''
            'Install Docker Desktop from:'
            '  https://www.docker.com/products/docker-desktop/'
            ''
            'After installing, ensure Docker Desktop is running, then try again.'
        ) -join "`n"
        throw (New-ActionableError `
            -Goal 'Launch Taxonomy Editor in container mode' `
            -Problem 'Docker CLI not found on PATH' `
            -Location 'Assert-DockerAvailable' `
            -NextSteps @(
                'Install Docker Desktop from https://www.docker.com/products/docker-desktop/'
                'Ensure Docker Desktop is running'
                'Run Show-TaxonomyEditor again'
            ) `
            -AsErrorRecord)
    }

    # Check that the daemon is responsive
    try {
        $null = docker info 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw 'Docker daemon not responding'
        }
    }
    catch {
        throw (New-ActionableError `
            -Goal 'Connect to Docker daemon' `
            -Problem 'Docker is installed but the daemon is not running' `
            -Location 'Assert-DockerAvailable' `
            -NextSteps @(
                'Start Docker Desktop'
                'Wait for the Docker icon to show "running"'
                'Run Show-TaxonomyEditor again'
            ) `
            -AsErrorRecord)
    }
}

function Test-DockerImageExists {
    <#
    .SYNOPSIS
        Returns $true if the specified Docker image is available locally.
    #>
    [CmdletBinding()]
    param([string]$ImageName)

    $result = docker images -q $ImageName 2>&1
    return ($null -ne $result -and $result.Trim().Length -gt 0)
}

function Pull-TaxonomyEditorImage {
    <#
    .SYNOPSIS
        Pulls the latest Taxonomy Editor Docker image.
    #>
    [CmdletBinding()]
    param([string]$ImageName = 'ghcr.io/ai-rosetta-stone/taxonomy-editor:latest')

    Write-Step "Pulling Taxonomy Editor image ($ImageName)"
    Write-Info 'This is a one-time download (~1.4 GB). Subsequent starts are instant.'
    docker pull $ImageName
    if ($LASTEXITCODE -ne 0) {
        throw (New-ActionableError `
            -Goal 'Download Taxonomy Editor container image' `
            -Problem "docker pull failed with exit code $LASTEXITCODE" `
            -Location 'Pull-TaxonomyEditorImage' `
            -NextSteps @(
                'Check your internet connection'
                'Verify Docker is working: docker pull hello-world'
                'Verify GHCR is accessible: docker pull ghcr.io/ai-rosetta-stone/taxonomy-editor:latest'
                'If behind a proxy, configure Docker proxy settings'
            ) `
            -AsErrorRecord)
    }
    Write-OK 'Image pulled successfully.'
}

function Get-ContainerName {
    <#
    .SYNOPSIS
        Returns the container name for a given port.
    #>
    [CmdletBinding()]
    param([int]$Port)

    return "aitriad-editor-$Port"
}

function Test-TaxonomyContainerRunning {
    <#
    .SYNOPSIS
        Returns $true if a Taxonomy Editor container is running on the given port.
    #>
    [CmdletBinding()]
    param([int]$Port)

    $name = Get-ContainerName -Port $Port
    $result = docker ps --filter "name=$name" --format '{{.Names}}' 2>&1
    return ($result -eq $name)
}

function Stop-TaxonomyContainer {
    <#
    .SYNOPSIS
        Stops a running Taxonomy Editor container.
    #>
    [CmdletBinding()]
    param([int]$Port)

    $name = Get-ContainerName -Port $Port
    if (Test-TaxonomyContainerRunning -Port $Port) {
        Write-Step "Stopping Taxonomy Editor ($name)"
        docker stop $name 2>&1 | Out-Null
        Write-OK 'Stopped.'
    }
    else {
        Write-Info "No running container found for port $Port."
    }
}

function Get-TaxonomyContainerStatus {
    <#
    .SYNOPSIS
        Displays the status of the Taxonomy Editor container.
    #>
    [CmdletBinding()]
    param([int]$Port)

    $name = Get-ContainerName -Port $Port
    if (Test-TaxonomyContainerRunning -Port $Port) {
        Write-OK "Taxonomy Editor is running at http://localhost:$Port (container: $name)"
    }
    else {
        Write-Info "Taxonomy Editor is not running on port $Port."
    }
}

function Wait-ForHealthEndpoint {
    <#
    .SYNOPSIS
        Polls the server health endpoint until it responds or timeout expires.
    #>
    [CmdletBinding()]
    param(
        [int]$Port,
        [int]$TimeoutSeconds = 30
    )

    $url = "http://localhost:$Port/health"
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)

    Write-Info 'Waiting for editor to be ready...'
    while ((Get-Date) -lt $deadline) {
        try {
            $resp = Invoke-RestMethod -Uri $url -TimeoutSec 2 -ErrorAction SilentlyContinue
            if ($resp.status -eq 'ok') {
                return $true
            }
        }
        catch {
            # Server not ready yet
        }
        Start-Sleep -Milliseconds 500
    }

    Write-Warn "Server did not become ready within $TimeoutSeconds seconds."
    Write-Info "Check container logs: docker logs $(Get-ContainerName -Port $Port)"
    return $false
}

function Test-ContainerVersionCompat {
    <#
    .SYNOPSIS
        Queries the container health endpoint and warns if its version differs
        from the installed module version.
    #>
    [CmdletBinding()]
    param([int]$Port)

    try {
        $health = Invoke-RestMethod -Uri "http://localhost:$Port/health" -TimeoutSec 3 -ErrorAction SilentlyContinue
        if ($health.version) {
            $mod = Get-Module AITriad -ErrorAction SilentlyContinue
            $moduleVersion = if ($mod) { $mod.Version.ToString() } else { $null }
            if (-not $moduleVersion) {
                $moduleVersion = (Import-PowerShellDataFile -Path (Join-Path $PSScriptRoot '../AITriad.psd1')).ModuleVersion
            }
            if ($moduleVersion -and $health.version -ne $moduleVersion) {
                Write-Warn "Container version ($($health.version)) differs from module version ($moduleVersion)."
                Write-Info 'Run Show-TaxonomyEditor -Pull to update the container image.'
            }
        }
    }
    catch {
        # Non-critical — don't block startup for a version check failure
    }
}

function Get-ApiKeyEnvArgs {
    <#
    .SYNOPSIS
        Builds Docker '--env-file' args for any AI API keys found in the environment.
    .DESCRIPTION
        Writes matching keys to a private, owner-only (0600) temp env-file and
        returns @('--env-file', <path>). Passing secrets by file keeps them out of
        the container's argv and `docker inspect` output — unlike `--env KEY=value`,
        which exposes every value to any local user who can inspect the container
        or its process list (t/2530 L3).

        Returns @() when no keys are set (no file is written). The caller MUST
        delete the returned file once `docker` has consumed it — the docker CLI
        reads --env-file client-side at invocation, so the file can be removed
        immediately after the `docker` call returns.
    #>
    [CmdletBinding()]
    param()

    Set-StrictMode -Version Latest

    $keyVars = @('GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'GROQ_API_KEY', 'AI_API_KEY', 'AI_MODEL')
    $lines = [System.Collections.Generic.List[string]]::new()
    foreach ($var in $keyVars) {
        $val = [System.Environment]::GetEnvironmentVariable($var)
        if ($val) {
            # docker --env-file format is literal VAR=value, one per line; docker
            # does not strip quotes, so write the raw value.
            $lines.Add("$var=$val")
        }
    }

    if ($lines.Count -eq 0) {
        return @()
    }

    $envFile = New-SecureTempPath -Prefix 'aitriad-docker-env' -Extension 'env'
    Write-Utf8NoBom -Path $envFile -Value ($lines -join "`n") -Force
    # Restrict to the current user before docker reads it.
    Protect-UserSecretFile -Path $envFile

    return @('--env-file', $envFile)
}
