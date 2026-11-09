#Requires -Modules Pester

<#
.SYNOPSIS
    Both arms for Test-BicepExpressionLength.ps1 (t/4845), under Set-StrictMode -Version Latest as
    the CI step runs it (the #4500 lesson: tests that skip strict mode missed a clean-arm crash).
#>

Describe 'Test-BicepExpressionLength (t/4845)' {
    BeforeAll {
        $repoRoot = Split-Path $PSScriptRoot -Parent
        . (Join-Path $repoRoot 'operations/devops/azure/Test-BicepExpressionLength.ps1')

        function script:TemplateWith([int]$ExprLength) {
            $expr = '[' + ('x' * ($ExprLength - 2)) + ']'
            @{
                resources = @(
                    @{ properties = @{ template = @{ containers = @( @{ env = $expr } ) } } }
                    @{ name = "[parameters('appName')]" }
                )
                variables = @{ literal = '[[not an expression]'; plain = 'no brackets' }
            }
        }
    }

    It 'PASS ARM: an expression exactly at the default threshold passes and reports its length and path' {
        Set-StrictMode -Version Latest
        $limit = $script:DefaultArmExpressionLimit
        $max = Assert-ArmExpressionLength -Template (script:TemplateWith $limit)
        $max.Length | Should -Be $limit
        $max.Path | Should -Be '$.resources[0].properties.template.containers[0].env'
    }

    It 'FIRE ARM: one character over the default threshold throws, naming length and path' {
        Set-StrictMode -Version Latest
        $over = $script:DefaultArmExpressionLimit + 1
        { Assert-ArmExpressionLength -Template (script:TemplateWith $over) } |
            Should -Throw "*$over chars at `$.resources?0?.properties.template.containers?0?.env*"
    }

    # Real templates (e/436#12-13), as length-preserving fixtures: same JSON paths and expression
    # lengths, no content. Regenerate with operations/devops/azure/New-BicepExpressionLengthFixture.ps1
    # -Sha <sha> -OutFile tests/fixtures/bicep-expression-length/<name>.json (needs full git history).
    Context 'Real templates at the default threshold' {
        BeforeAll {
            function script:Fixture([string]$Name) {
                $path = Join-Path $repoRoot "tests/fixtures/bicep-expression-length/$Name.json"
                (Get-Content $path -Raw | ConvertFrom-Json -AsHashtable -Depth 200).template
            }
        }

        It 'FIRE ARM: the 11-02 incident template (70a7e08f, run 41463847843, ARM "actual: 89238") fails' {
            Set-StrictMode -Version Latest
            $t = script:Fixture 'incident-70a7e08f'
            (Get-MaxArmExpression -Template $t).Length | Should -Be 89240 -Because 'the fixture must stay faithful to the real incident template'
            { Assert-ArmExpressionLength -Template $t } | Should -Throw '*89240 chars*'
        }

        It 'PASS ARM: the template that deployed on 11-08 (229da270, run 42516135244) passes' {
            Set-StrictMode -Version Latest
            $t = script:Fixture 'deployed-229da270'
            (Assert-ArmExpressionLength -Template $t).Length | Should -Be 45288
        }
    }

    It 'ignores "[[" literal escapes and plain strings' {
        Set-StrictMode -Version Latest
        $t = @{ a = '[[' + ('y' * 90000); b = ('z' * 90000); c = "[concat('a')]" }
        (Get-MaxArmExpression -Template $t).Length | Should -Be 13
    }

    It 'tolerates JSON null leaves (DevOps Lead nit, p/241#152)' {
        Set-StrictMode -Version Latest
        $t = '{"a": null, "b": [null, "[concat(''x'')]"], "c": {"d": null}}' | ConvertFrom-Json -AsHashtable
        (Get-MaxArmExpression -Template $t).Length | Should -Be 13
    }

    It 'VACUOUS GUARD: a template with no expressions throws instead of passing' {
        Set-StrictMode -Version Latest
        { Get-MaxArmExpression -Template @{ a = 'plain'; b = @(1, 2) } } | Should -Throw '*measured nothing*'
    }
}
