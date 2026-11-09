# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Test-DepPythonPackages {
    <#
    .SYNOPSIS
        sentence-transformers presence (+ test-mode outdated-pip check against
        requirements.txt) and the markitdown pip auto-install path, for
        Invoke-DependencyCheck's section 6 (t/3910). Extracted verbatim.
    #>
    [CmdletBinding()]
    [OutputType([void])]
    param(
        [Parameter(Mandatory)][hashtable]$Ctx,
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)][string]$PythonCmd,
        [Parameter(Mandatory)][bool]$IsTestMode,
        [Parameter(Mandatory)][bool]$IsInstallMode,
        [Parameter(Mandatory)][bool]$Fix
    )

    $ReqFile = Join-Path (Join-Path $RepoRoot 'scripts') 'requirements.txt'
    if (Test-Path $ReqFile) {
        try {
            $ImportTest = & $PythonCmd -c "import sentence_transformers; print(sentence_transformers.__version__)" 2>$null
            if ($LASTEXITCODE -eq 0 -and $ImportTest) {
                Write-DepPass -Ctx $Ctx -Message "sentence-transformers $("$ImportTest".Trim())"

                # Test mode: check if pip packages are outdated
                if ($IsTestMode) {
                    try {
                        $PipOutdated = & $PythonCmd -m pip list --outdated --format=json 2>$null
                        if ($LASTEXITCODE -eq 0 -and $PipOutdated) {
                            $OutdatedPkgs = $PipOutdated | ConvertFrom-Json
                            # Filter to packages in our requirements.txt
                            $ReqNames = @(Get-Content $ReqFile | Where-Object { $_ -match '^\w' } | ForEach-Object { ($_ -split '[>=<]')[0].Trim().ToLower() })
                            $Relevant = @($OutdatedPkgs | Where-Object { $_.name.ToLower() -in $ReqNames })
                            if ($Relevant.Count -gt 0) {
                                Write-DepStale -Ctx $Ctx -Message "$($Relevant.Count) Python package(s) outdated (run '$PythonCmd -m pip install -U -r scripts/requirements.txt' to update)"
                                foreach ($Pkg in $Relevant | Select-Object -First 3) {
                                    Write-Host "         $($Pkg.name): $($Pkg.version) -> $($Pkg.latest_version)" -ForegroundColor DarkGray
                                }
                                if ($Relevant.Count -gt 3) {
                                    Write-Host "         ... and $($Relevant.Count - 3) more" -ForegroundColor DarkGray
                                }
                            }
                        }
                    }
                    catch { }  # pip outdated can fail gracefully
                }
            }
            else {
                Write-DepWarn -Ctx $Ctx -Message 'sentence-transformers not installed'
                if ($IsInstallMode -and $Fix) {
                    Write-DepFix 'Installing Python requirements...'
                    & $PythonCmd -m pip install -r $ReqFile 2>&1 | Out-Null
                    if ($LASTEXITCODE -eq 0) { $Ctx.Fixed++; Write-DepPass -Ctx $Ctx -Message 'Python requirements installed' }
                    else { Write-DepFail -Ctx $Ctx -Message 'pip install failed' }
                }
                else { Write-DepSkip -Message "Run '$PythonCmd -m pip install -r scripts/requirements.txt'" }
            }
        }
        catch { Write-DepWarn -Ctx $Ctx -Message "Could not check Python packages: $_" }
    }

    # markitdown auto-install (pip, only when Python is available and -Fix is set)
    if (-not (Get-Command markitdown -ErrorAction SilentlyContinue)) {
        if ($IsInstallMode -and $Fix) {
            Write-DepFix "Installing markitdown via pip..."
            & $PythonCmd -m pip install 'markitdown[all]' 2>&1 | Out-Null
            if ($LASTEXITCODE -eq 0) { $Ctx.Fixed++; Write-DepPass -Ctx $Ctx -Message 'markitdown installed' }
            else { Write-DepFail -Ctx $Ctx -Message 'markitdown pip install failed' }
        }
    }
}
