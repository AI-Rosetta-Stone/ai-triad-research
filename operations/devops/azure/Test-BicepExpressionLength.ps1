<#
.SYNOPSIS
    t/4845 early warning: fail when the compiled ARM template's longest single expression
    exceeds a threshold well below Azure's hard 81,920-character limit.

.DESCRIPTION
    Run 41463847843 (2026-11-02) failed at deploy time with `InvalidTemplate ... language
    expression length limit exceeded. Limit: '81920' and actual: '89238'`. `az bicep build`
    compiles such a template without complaint; only ARM rejects it, mid-deploy. This check
    compiles main.bicep and measures every expression string ("[...]", excluding "[[" literal
    escapes) so the next growth past the threshold fails CI, not a prod deploy.

    Dot-source for the pure functions; run as a script to compile and check a .bicep file.
#>
[CmdletBinding()]
param(
    [string] $BicepPath = (Join-Path $PSScriptRoot '..' '..' '..' 'deploy' 'azure' 'main.bicep'),
    [int] $Limit = 70000
)

# Local helper, same convention as Test-StagingContainerEnvIsolation.ps1: no dependency on
# AITriad.psm1, so a bare CI step can run this.
function New-ActionableError {
    param([string]$Goal, [string]$Problem, [string]$Location, [string]$NextSteps)
    "Goal: $Goal`nProblem: $Problem`nLocation: $Location`nResolve: $NextSteps"
}

function Get-ArmExpressionLengths {
    param([Parameter(Mandatory)] $Node, [string] $Path = '$')
    if ($Node -is [System.Collections.IDictionary]) {
        foreach ($k in $Node.Keys) { Get-ArmExpressionLengths -Node $Node[$k] -Path "$Path.$k" }
    } elseif ($Node -is [System.Collections.IList]) {
        for ($i = 0; $i -lt $Node.Count; $i++) { Get-ArmExpressionLengths -Node $Node[$i] -Path "$Path[$i]" }
    } elseif ($Node -is [string] -and $Node.StartsWith('[') -and -not $Node.StartsWith('[[')) {
        [PSCustomObject]@{ Length = $Node.Length; Path = $Path }
    }
}

function Get-MaxArmExpression {
    param([Parameter(Mandatory)] $Template)
    # @(...) guards the strict-mode empty-result unroll (#4500 lesson).
    $all = @(Get-ArmExpressionLengths -Node $Template)
    if ($all.Count -eq 0) {
        throw (New-ActionableError -Goal 'Measure ARM expression lengths (t/4845)' `
            -Problem 'The compiled template contains no expressions at all, so this check measured nothing.' `
            -Location 'Test-BicepExpressionLength.ps1 / Get-MaxArmExpression' `
            -NextSteps 'The compile output is probably empty or not an ARM template. Check the az bicep build step before trusting a pass.')
    }
    $all | Sort-Object Length -Descending | Select-Object -First 1
}

function Assert-ArmExpressionLength {
    param([Parameter(Mandatory)] $Template, [int] $Limit = 70000)
    $max = Get-MaxArmExpression -Template $Template
    if ($max.Length -gt $Limit) {
        throw (New-ActionableError -Goal 'Keep main.bicep below the ARM expression-length limit (t/4845)' `
            -Problem "Longest expression is $($max.Length) chars at $($max.Path), over the $Limit early-warning threshold (Azure rejects anything over 81920 at deploy time)." `
            -Location "deploy/azure/main.bicep (compiled path $($max.Path))" `
            -NextSteps 'Find what grew that expression. A nested `cond ? concat(prev, x) : prev` var chain copies its input into both arms per level; keep such chains flat (see the containerEnv comment in main.bicep), or move the block into a module.')
    }
    $max
}

if ($MyInvocation.InvocationName -ne '.') {
    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'
    $outFile = Join-Path ([System.IO.Path]::GetTempPath()) "bicep-expr-$([guid]::NewGuid()).json"
    try {
        az bicep build --file $BicepPath --outfile $outFile --only-show-errors
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path $outFile)) {
            throw (New-ActionableError -Goal 'Compile main.bicep to measure expression lengths (t/4845)' `
                -Problem "az bicep build exited $LASTEXITCODE or wrote no output for $BicepPath." `
                -Location 'Test-BicepExpressionLength.ps1' `
                -NextSteps 'Fix the compile error shown above. This check fails closed rather than passing on a template it never measured.')
        }
        $template = Get-Content $outFile -Raw | ConvertFrom-Json -AsHashtable -Depth 200
        $max = Assert-ArmExpressionLength -Template $template -Limit $Limit
        Write-Host "Longest ARM expression: $($max.Length) chars at $($max.Path) (threshold $Limit, Azure limit 81920) -- OK"
    } finally {
        Remove-Item $outFile -ErrorAction SilentlyContinue
    }
}
