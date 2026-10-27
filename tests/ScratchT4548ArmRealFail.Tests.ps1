# t/4548 arm-3 live-fire proof, scratch arm 2 -- NEVER MERGE.
# A genuine Pester failure (marker present, Pester outcome=failure) must get
# ZERO automatic reruns -- proves the classifier never auto-reruns a real red.
Describe 'ScratchT4548ArmRealFail' {
    It 'deliberately fails (t/4548 scratch arm 2 -- must get zero auto-reruns)' {
        $true | Should -Be $false
    }
}
