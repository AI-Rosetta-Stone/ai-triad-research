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

    It 'PASS ARM: an expression at the threshold passes and reports its length and path' {
        Set-StrictMode -Version Latest
        $max = Assert-ArmExpressionLength -Template (script:TemplateWith 70000) -Limit 70000
        $max.Length | Should -Be 70000
        $max.Path | Should -Be '$.resources[0].properties.template.containers[0].env'
    }

    It 'FIRE ARM: one character over the threshold throws, naming length and path' {
        Set-StrictMode -Version Latest
        { Assert-ArmExpressionLength -Template (script:TemplateWith 70001) -Limit 70000 } |
            Should -Throw '*70001 chars at $.resources?0?.properties.template.containers?0?.env*'
    }

    It 'the 11-02 incident size (89238) fails' {
        Set-StrictMode -Version Latest
        { Assert-ArmExpressionLength -Template (script:TemplateWith 89238) -Limit 70000 } | Should -Throw
    }

    It 'ignores "[[" literal escapes and plain strings' {
        Set-StrictMode -Version Latest
        $t = @{ a = '[[' + ('y' * 90000); b = ('z' * 90000); c = "[concat('a')]" }
        (Get-MaxArmExpression -Template $t).Length | Should -Be 13
    }

    It 'VACUOUS GUARD: a template with no expressions throws instead of passing' {
        Set-StrictMode -Version Latest
        { Get-MaxArmExpression -Template @{ a = 'plain'; b = @(1, 2) } } | Should -Throw '*measured nothing*'
    }
}
