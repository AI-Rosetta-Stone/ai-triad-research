# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Get-DepPipInstallArgs {
    <#
    .SYNOPSIS
        Platform-aware `pip install` argument list for scripts/requirements.txt, for the
        native (non-container) dev path (t/4884 follow-up, Quality/TL review on #4597).
    .DESCRIPTION
        scripts/pip-constraints.txt pins torch to a `+cpu` build (t/4884) to keep a CUDA wheel
        from being pulled in. That exact `+cpu` wheel is published ONLY on PyTorch's own CPU
        wheel index (download.pytorch.org/whl/cpu), never on PyPI's default index -- so a plain
        `pip install -c pip-constraints.txt` outside the Dockerfile's container (which already
        passes `--index-url` for its own torch-specific install step) fails to resolve the pin.

        There is also no `+cpu` wheel for macOS at all -- PyTorch ships one universal wheel
        for mac, with no CUDA/CPU split to begin with. The Dockerfile's container build is
        Linux-only, so it can apply the constraint unconditionally; this native path can run
        on Windows, Linux, or macOS, so on macOS it skips the constraint file entirely and
        lets torch resolve its normal mac wheel from PyPI, rather than fail to resolve a build
        that was never published.
    .PARAMETER ReqFile
        Path to requirements.txt (passed through to -r).
    .PARAMETER ConstraintsFile
        Path to pip-constraints.txt (passed through to -c, Windows/Linux only).
    .OUTPUTS
        [string[]] -- a full `pip install ...` argument list, ready to splat: `& $PythonCmd @Args`.
    .EXAMPLE
        & $PythonCmd @(Get-DepPipInstallArgs -ReqFile $ReqFile -ConstraintsFile $ConstraintsFile)
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param(
        [Parameter(Mandatory)][string]$ReqFile,
        [Parameter(Mandatory)][string]$ConstraintsFile
    )

    $PipArgs = [System.Collections.Generic.List[string]]::new()
    $PipArgs.AddRange([string[]]@('-m', 'pip', 'install', '-r', $ReqFile))
    if (-not $IsMacOS) {
        $PipArgs.AddRange([string[]]@('-c', $ConstraintsFile, '--extra-index-url', 'https://download.pytorch.org/whl/cpu'))
    }
    , @($PipArgs)
}
