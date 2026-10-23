BeforeAll {
    . "$PSScriptRoot/../operations/devops/ConvertFrom-CheckRunsResponse.ps1"
}

Describe 'ConvertFrom-CheckRunsResponse' {
    It 'parses a recorded real check-runs response for a known-green SHA (f55a0ead, #3386)' {
        # TL finding (p/331#2104): ci-gate/CodeQL are check runs, not commit statuses — this
        # fixture is the real `gh api repos/.../commits/f55a0ead/check-runs` response, trimmed to
        # a handful of runs, not hand-written, so it can't silently drift from the real API shape.
        $fixture = Get-Content "$PSScriptRoot/fixtures/check-runs-f55a0ead.json" -Raw | ConvertFrom-Json
        $byName = ConvertFrom-CheckRunsResponse -CheckRunsResponse $fixture

        $byName['ci-gate'].Conclusion | Should -Be 'success'
        $byName.ContainsKey('CodeQL') | Should -Be $false  # legitimately absent (push path-filtered) — not an error
    }

    It 'keeps only the most-recently-started run when a name appears twice' {
        $fixture = [PSCustomObject]@{
            check_runs = @(
                [PSCustomObject]@{ name = 'ci-gate'; status = 'completed'; conclusion = 'failure'; started_at = '2026-10-19T10:00:00Z' }
                [PSCustomObject]@{ name = 'ci-gate'; status = 'completed'; conclusion = 'success'; started_at = '2026-10-19T10:19:41Z' }
            )
        }
        $byName = ConvertFrom-CheckRunsResponse -CheckRunsResponse $fixture
        $byName['ci-gate'].Conclusion | Should -Be 'success'
    }

    It 'reports status (not conclusion) for a still-running check' {
        $fixture = [PSCustomObject]@{
            check_runs = @(
                [PSCustomObject]@{ name = 'ci-gate'; status = 'in_progress'; conclusion = $null; started_at = '2026-10-19T10:19:41Z' }
            )
        }
        $byName = ConvertFrom-CheckRunsResponse -CheckRunsResponse $fixture
        $byName['ci-gate'].Conclusion | Should -Be 'in_progress'
    }
}
