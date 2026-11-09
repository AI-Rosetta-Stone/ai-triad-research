<#
.SYNOPSIS
    Regenerates a length-preserving fixture of main.bicep's compiled template at a given commit,
    for tests/BicepExpressionLength.Tests.ps1 (t/4845).

.DESCRIPTION
    Compiles deploy/azure/main.bicep exactly as it was at -Sha, then keeps the JSON structure and
    every expression's LENGTH and PATH while dropping all content: each expression string becomes
    '[' + 'x' * (length - 2) + ']', every other string becomes ''. So the fixture measures the same
    as the real template, with nothing from it (env values, names) committed.

    Needs full git history (the CI checkout is shallow, which is why the fixtures are committed).

.EXAMPLE
    ./operations/devops/azure/New-BicepExpressionLengthFixture.ps1 -Sha 70a7e08f -OutFile tests/fixtures/bicep-expression-length/incident-70a7e08f.json
    ./operations/devops/azure/New-BicepExpressionLengthFixture.ps1 -Sha 229da270 -OutFile tests/fixtures/bicep-expression-length/deployed-229da270.json
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $Sha,
    [Parameter(Mandatory)] [string] $OutFile
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function ConvertTo-LengthOnly {
    param([AllowNull()] $Node)
    if ($null -eq $Node) { return $null }
    if ($Node -is [System.Collections.IDictionary]) {
        $out = [ordered]@{}
        foreach ($k in $Node.Keys) { $out[$k] = ConvertTo-LengthOnly $Node[$k] }
        return $out
    }
    if ($Node -is [System.Collections.IList]) {
        return , @(foreach ($v in $Node) { ConvertTo-LengthOnly $v })
    }
    if ($Node -is [string]) {
        if ($Node.Length -ge 2 -and $Node.StartsWith('[') -and -not $Node.StartsWith('[[')) {
            return '[' + ('x' * ($Node.Length - 2)) + ']'
        }
        return ''
    }
    $Node
}

$work = Join-Path ([System.IO.Path]::GetTempPath()) "bicep-fixture-$([guid]::NewGuid())"
New-Item -ItemType Directory $work | Out-Null
try {
    $zip = Join-Path $work 'src.zip'
    git archive --format=zip -o $zip $Sha deploy/azure
    if ($LASTEXITCODE -ne 0) { throw "git archive failed for $Sha (shallow clone? fetch full history first)" }
    Expand-Archive -Path $zip -DestinationPath $work
    $bicep = Join-Path $work 'deploy/azure/main.bicep'
    if (-not (Test-Path $bicep)) { throw "main.bicep missing after extracting $Sha" }
    $json = Join-Path $work 'main.json'
    az bicep build --file $bicep --outfile $json --only-show-errors
    if ($LASTEXITCODE -ne 0) { throw "az bicep build failed for $Sha" }
    $template = Get-Content $json -Raw | ConvertFrom-Json -AsHashtable -Depth 200
    $fixture = [ordered]@{
        '_fixture' = [ordered]@{ source = "deploy/azure/main.bicep at $Sha"; generator = 'operations/devops/azure/New-BicepExpressionLengthFixture.ps1' }
        template   = ConvertTo-LengthOnly $template
    }
    $fixture | ConvertTo-Json -Depth 100 -Compress | Set-Content $OutFile -Encoding utf8NoBOM
    Write-Host "Wrote $OutFile from $Sha"
} finally {
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
