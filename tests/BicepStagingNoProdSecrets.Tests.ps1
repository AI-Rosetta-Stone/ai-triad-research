# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# t/654 (t/92 B2; PI 2026-11-25, TL p/12#265/#267; Security p/278#18): staging holds no prod secret
# except the three sign-in OAuth client secrets, a PI-accepted risk (t/92#73, review 2027-02-25).
# Static parse of the real main.bicep: an ALLOW-LIST, so any new secret reaching staging fails here.
#
# Step 1 of 2: gemini-paid-key is still in staging's secrets (stagingPaidKeyRetained) because ACA rejects an
# apply that drops a secret an active revision references, and that apply also deploys prod. Its env
# reference is already gone. Step 2 removes it and deletes it from $script:Step1Retained below.
#
# t/710 (TL review of #5551, t/658#14 and #17): the first version stayed green for five ways a prod secret
# could return. The checks are now functions over the Bicep TEXT, so the second Describe can mutate a copy of
# main.bicep and assert that each of those five is caught. Everything here is exact-match allow-listing:
# every identifier, entry name, entry source and env secretRef that staging's secrets and env are built
# from must be listed below, and anything the parse cannot read in full throws.

BeforeAll {
    $script:Bicep = Get-Content (Join-Path $PSScriptRoot '..' 'deploy' 'azure' 'main.bicep') -Raw

    # Reads one Bicep expression starting at $Start: through any ( [ { nesting and '...${...}...' strings, up
    # to the end of the line that closes it. Comments are dropped. Throws when the expression is not captured
    # in full (t/710 case 3: the old parse fell back to the first line of a multi-line var).
    function Read-BicepExpression([string]$Text, [int]$Start, [string]$What) {
        $sb = [System.Text.StringBuilder]::new()
        # -1 = inside a string; n >= 0 = inside a ${ } interpolation with n braces of its own open.
        $stack = [System.Collections.Generic.Stack[int]]::new()
        $depth = 0
        $n = $Text.Length
        $i = $Start
        while ($i -lt $n) {
            $c = $Text[$i]
            $next = if ($i + 1 -lt $n) { $Text[$i + 1] } else { [char]0 }
            if ($stack.Count -gt 0 -and $stack.Peek() -eq -1) {
                if ($c -eq '\' -and $i + 1 -lt $n) { [void]$sb.Append($c).Append($next); $i += 2; continue }
                if ($c -eq '$' -and $next -eq '{') { $stack.Push(0); [void]$sb.Append('${'); $i += 2; continue }
                if ($c -eq "'") { [void]$stack.Pop() }
                [void]$sb.Append($c); $i++; continue
            }
            if ($stack.Count -gt 0) {
                if ($c -eq "'") { $stack.Push(-1) }
                elseif ($c -eq '{') { $k = $stack.Pop(); $stack.Push($k + 1) }
                elseif ($c -eq '}') { $k = $stack.Pop(); if ($k -gt 0) { $stack.Push($k - 1) } }
                [void]$sb.Append($c); $i++; continue
            }
            if ($c -eq '/' -and $next -eq '/') { while ($i -lt $n -and $Text[$i] -ne "`n") { $i++ }; continue }
            if ($c -eq '/' -and $next -eq '*') {
                $end = $Text.IndexOf('*/', $i + 2)
                if ($end -lt 0) { throw "$What is not fully captured: a /* comment never closes. Fix main.bicep or this parser." }
                $i = $end + 2; continue
            }
            if ($c -eq "'") {
                if ($next -eq "'" -and $i + 2 -lt $n -and $Text[$i + 2] -eq "'") {
                    throw "$What is not fully captured: it uses a ''' multi-line string, which this parser does not read. Extend Read-BicepExpression before using one here."
                }
                $stack.Push(-1)
            }
            elseif ('([{'.IndexOf($c) -ge 0) { $depth++ }
            elseif (')]}'.IndexOf($c) -ge 0) {
                $depth--
                if ($depth -lt 0) { throw "$What is not fully captured: unbalanced '$c'. Fix main.bicep or this parser." }
            }
            elseif ($c -eq "`n" -and $depth -eq 0) {
                if ($Text.Substring($i) -match '\A\s*[?:]') {
                    throw "$What is not fully captured: the expression continues on the next line outside any bracket. Extend Read-BicepExpression before writing it that way."
                }
                return $sb.ToString().Trim()
            }
            [void]$sb.Append($c); $i++
        }
        if ($depth -eq 0 -and $stack.Count -eq 0) { return $sb.ToString().Trim() }
        throw "$What is not fully captured: main.bicep ended inside it (bracket depth $depth). Fix main.bicep or this parser."
    }

    # The whole expression of `var <Name> = ...`. Throws when the var is missing or declared twice.
    function Get-BicepVarExpr([string]$Bicep, [string]$Name) {
        $m = [regex]::Matches($Bicep, "(?m)^var $([regex]::Escape($Name))[ \t]*=[ \t]*")
        if ($m.Count -ne 1) { throw "var $Name was found $($m.Count) times in main.bicep (expected exactly 1). Update tests/BicepStagingNoProdSecrets.Tests.ps1 if it was renamed." }
        Read-BicepExpression $Bicep ($m[0].Index + $m[0].Length) "var $Name"
    }

    # The same text, same length, with everything inside a string literal replaced by '#' (the outer quotes
    # stay), so brackets, commas and identifiers can be found without being fooled by string contents.
    function Get-BicepMask([string]$Expr) {
        $out = $Expr.ToCharArray()
        $stack = [System.Collections.Generic.Stack[int]]::new()
        for ($i = 0; $i -lt $out.Length; $i++) {
            $c = $Expr[$i]
            if ($stack.Count -gt 0 -and $stack.Peek() -eq -1) {
                if ($c -eq '\' -and $i + 1 -lt $out.Length) { $out[$i] = '#'; $out[$i + 1] = '#'; $i++; continue }
                if ($c -eq '$' -and $i + 1 -lt $out.Length -and $Expr[$i + 1] -eq '{') { $stack.Push(0); $out[$i] = '#'; $out[$i + 1] = '#'; $i++; continue }
                if ($c -eq "'") { [void]$stack.Pop(); if ($stack.Count -eq 0) { continue } }
                $out[$i] = '#'; continue
            }
            if ($stack.Count -gt 0) {
                if ($c -eq "'") { $stack.Push(-1) }
                elseif ($c -eq '{') { $k = $stack.Pop(); $stack.Push($k + 1) }
                elseif ($c -eq '}') { $k = $stack.Pop(); if ($k -gt 0) { $stack.Push($k - 1) } }
                $out[$i] = '#'; continue
            }
            if ($c -eq "'") { $stack.Push(-1) }
        }
        if ($stack.Count -ne 0) { throw "A string literal never closes in: $Expr" }
        [string]::new($out)
    }

    # Splits an array expression into its { ... } object literals and the residual: the masked text with
    # every object blanked out. The residual holds the functions, conditions and vars the array is built from.
    function Split-BicepArrayExpr([string]$Expr) {
        $mask = Get-BicepMask $Expr
        $residual = [System.Text.StringBuilder]::new($mask)
        $objects = [System.Collections.Generic.List[string]]::new()
        $i = 0
        while ($i -lt $mask.Length) {
            if ($mask[$i] -ne '{') { $i++; continue }
            $d = 0; $j = $i
            do {
                if ($mask[$j] -eq '{') { $d++ } elseif ($mask[$j] -eq '}') { $d-- }
                $j++
            } while ($d -gt 0 -and $j -lt $mask.Length)
            if ($d -ne 0) { throw "An object literal never closes in: $Expr" }
            $objects.Add($Expr.Substring($i, $j - $i))
            for ($k = $i; $k -lt $j; $k++) { $residual[$k] = ' ' }
            $i = $j
        }
        [pscustomobject]@{ Objects = $objects.ToArray(); Residual = $residual.ToString() }
    }

    # The properties of one { key: expr, key: expr } literal, as written. Throws on anything it cannot read
    # (a quoted key, a duplicate key, a part that is not `key: expr`).
    function Get-BicepObjectProperty([string]$Object) {
        $inner = $Object.Substring(1, $Object.Length - 2)
        $mask = Get-BicepMask $inner
        $props = [ordered]@{}
        $start = 0; $d = 0
        for ($i = 0; $i -le $mask.Length; $i++) {
            $c = if ($i -lt $mask.Length) { $mask[$i] } else { [char]"`n" }
            if ('([{'.IndexOf($c) -ge 0) { $d++; continue }
            if (')]}'.IndexOf($c) -ge 0) { $d--; continue }
            if ($d -ne 0 -or ($c -ne ',' -and $c -ne "`n")) { continue }
            $part = $inner.Substring($start, $i - $start).Trim()
            $start = $i + 1
            if (-not $part) { continue }
            if ($part -notmatch '(?s)^(\w+)\s*:\s*(.+)$') { throw "Cannot read the property '$part' of the entry $Object" }
            if ($props.Contains($Matches[1])) { throw "The entry $Object sets '$($Matches[1])' twice" }
            $props[$Matches[1]] = $Matches[2].Trim()
        }
        $props
    }

    # Walks $Root and every var it is built from. Each identifier outside an entry must be an allow-listed
    # function or condition, or a var on the exact $Expandable list (which is then walked too). Returns the
    # entries (with the var each came from), the findings so far, and the expanded text.
    function Expand-BicepArrayVar([string]$Bicep, [string]$Root, [string[]]$Expandable, [string[]]$AllowedIdentifiers) {
        $findings = [System.Collections.Generic.List[string]]::new()
        $entries = [System.Collections.Generic.List[object]]::new()
        $text = [System.Collections.Generic.List[string]]::new()
        $seen = [System.Collections.Generic.HashSet[string]]::new()
        $queue = [System.Collections.Generic.Queue[string]]::new()
        $queue.Enqueue($Root)
        while ($queue.Count -gt 0) {
            $var = $queue.Dequeue()
            if (-not $seen.Add($var)) { continue }
            $expr = Get-BicepVarExpr $Bicep $var
            $text.Add($expr)
            $parts = Split-BicepArrayExpr $expr
            if ($parts.Residual.Contains("'")) { $findings.Add("${var}: a string literal stands outside any entry; only allow-listed vars and entries may be combined here") }
            foreach ($id in ([regex]::Matches($parts.Residual, '[A-Za-z_]\w*') | ForEach-Object { $_.Value } | Select-Object -Unique)) {
                if ($id -in $Expandable) { $queue.Enqueue($id) }
                elseif ($id -notin $AllowedIdentifiers) { $findings.Add("${var}: identifier '$id' is not on the allow-list, so what it adds to staging is not checked") }
            }
            foreach ($o in $parts.Objects) { $entries.Add([pscustomobject]@{ Var = $var; Text = $o; Props = (Get-BicepObjectProperty $o) }) }
        }
        [pscustomobject]@{ Findings = $findings; Entries = $entries; Expanded = ($text -join "`n"); Vars = @($seen) }
    }

    # Each secret staging may hold: the name var, the literal that var must equal, and the ONE source its value
    # may come from. The accepted-risk OAuth three, staging's own free-tier key, and (t/669) staging's OWN
    # EasyAuth cookie keys from staging's vault. Anything else, a quoted name included, is a finding.
    $script:AllowedSecrets = [ordered]@{
        googleClientSecretName       = @{ Literal = "'google-client-secret'";         Key = 'value';       Source = 'googleClientSecret' }
        githubClientSecretName       = @{ Literal = "'github-client-secret'";         Key = 'value';       Source = 'githubClientSecret' }
        aadClientSecretName          = @{ Literal = "'aad-client-secret'";            Key = 'value';       Source = 'aadClientSecret' }
        freeTierStagingSecretName    = @{ Literal = "'free-tier-gemini-key-staging'"; Key = 'value';       Source = 'freeTierGeminiKeyStaging' }
        easyAuthEncryptionSecretName = @{ Literal = "'easyauth-encryption-key'";      Key = 'keyVaultUrl'; Source = "'`${stagingKeyVaultUrl}secrets/`${easyAuthEncryptionSecretName}'" }
        easyAuthSigningSecretName    = @{ Literal = "'easyauth-signing-key'";         Key = 'keyVaultUrl'; Source = "'`${stagingKeyVaultUrl}secrets/`${easyAuthSigningSecretName}'" }
    }
    # Step 1 only; step 2 deletes this entry.
    $script:Step1Retained = [ordered]@{
        paidTierSecretName = @{ Literal = "'gemini-paid-key'"; Key = 'value'; Source = 'geminiPaidKey' }
    }
    # Prod secrets that must never reach staging.
    $script:ForbiddenSecretNameVars = @('githubTokenSecretName', 'githubWebhookSecretName', 'freeTierSecretName')
    # The exact vars stagingSecrets may be built from (SO p/298#15: no `staging\w+Secrets` pattern), and the
    # only other identifiers allowed outside an entry: concat and the switches that gate each entry.
    $script:SecretVars = @('stagingOauthSecrets', 'easyAuthKeySecretsStaging', 'stagingPaidKeyRetained')
    $script:SecretIdentifiers = @('concat', 'googleEnabled', 'githubEnabled', 'aadEnabled', 'easyAuthOwnKeysStaging', 'paidTierEnabled', 'freeTierStagingKeyProvided')

    # Staging's env: the vars it is built from, the other identifiers allowed outside an entry (the functions
    # and lambda words of stagingBaseEnv, and the one switch), the only secretRef it may carry, and the env
    # names that only prod may set.
    $script:EnvVars = @('stagingBaseEnv', 'stagingExtraFreeTier', 'stagingExtraFreePoolTokensCap', 'baseEnv', 'stagingEnvOverrides', 'stagingOverriddenKeys')
    $script:EnvIdentifiers = @('concat', 'filter', 'map', 'contains', 'e', 'name', 'freeTierStagingKeyProvided', 'empty', 'freePoolDailyTokensCapStaging')
    $script:AllowedEnvSecretRefs = @{ "'FREE_TIER_GEMINI_KEY'" = 'freeTierStagingSecretName' }
    $script:ProdOnlyEnvNames = @("'GEMINI_PAID_KEY'", "'GITHUB_TOKEN'", "'GITHUB_WEBHOOK_SECRET'")

    # Every way staging's SECRETS break the allow-list in this Bicep text. Empty means clean.
    function Get-StagingSecretReport([string]$Bicep) {
        $allowed = [ordered]@{}
        foreach ($k in $script:AllowedSecrets.Keys) { $allowed[$k] = $script:AllowedSecrets[$k] }
        foreach ($k in $script:Step1Retained.Keys) { $allowed[$k] = $script:Step1Retained[$k] }
        $walk = Expand-BicepArrayVar $Bicep 'stagingSecrets' $script:SecretVars $script:SecretIdentifiers
        $findings = $walk.Findings
        foreach ($e in $walk.Entries) {
            $name = $e.Props['name']
            if (-not $name -or $name -notmatch '^[A-Za-z_]\w*$' -or -not $allowed.Contains($name)) {
                $findings.Add("$($e.Var): secret entry $($e.Text) is named <$name>, which is not an allow-listed secret-name var (a quoted literal name is never allowed)")
                continue
            }
            $want = $allowed[$name]
            $sources = @($e.Props.Keys | Where-Object { $_ -in @('value', 'keyVaultUrl') })
            if ($sources.Count -ne 1 -or $sources[0] -ne $want.Key -or $e.Props[$want.Key] -ne $want.Source) {
                $findings.Add("$($e.Var): secret entry $($e.Text) must take its value from exactly '$($want.Key): $($want.Source)'")
            }
            $unknown = @($e.Props.Keys | Where-Object { $_ -notin @('name', 'value', 'keyVaultUrl', 'identity') })
            if ($unknown.Count) { $findings.Add("$($e.Var): secret entry $($e.Text) has properties this test does not know: $($unknown -join ', ')") }
        }
        # An allow-listed name var is only as good as the literal behind it.
        foreach ($k in $allowed.Keys) {
            $literal = Get-BicepVarExpr $Bicep $k
            if ($literal -ne $allowed[$k].Literal) { $findings.Add("var $k is $literal, expected $($allowed[$k].Literal): an allow-listed name var must not be re-pointed at another secret") }
        }
        [pscustomobject]@{ Findings = @($findings); Expanded = $walk.Expanded; Vars = $walk.Vars; EntryCount = $walk.Entries.Count }
    }

    # The names of every @secure() param: no env VALUE may be built from one.
    function Get-BicepSecureParam([string]$Bicep) {
        @([regex]::Matches($Bicep, '(?m)^@secure\(\)[ \t]*\r?\n(?:@[^\r\n]*\r?\n)*param[ \t]+(\w+)') | ForEach-Object { $_.Groups[1].Value })
    }

    # Every way staging's ENV breaks the allow-list in this Bicep text. Empty means clean. It walks
    # stagingContainerEnv through every var it concatenates (t/710 case 5), baseEnv included.
    function Get-StagingEnvReport([string]$Bicep) {
        $walk = Expand-BicepArrayVar $Bicep 'stagingContainerEnv' $script:EnvVars $script:EnvIdentifiers
        $findings = $walk.Findings
        $secure = @(Get-BicepSecureParam $Bicep)
        if ($secure.Count -eq 0) { throw 'No @secure() param was found in main.bicep, so the env value check would be vacuous. Fix Get-BicepSecureParam.' }
        $secureRx = '\b(' + (($secure | ForEach-Object { [regex]::Escape($_) }) -join '|') + ')\b'
        foreach ($e in $walk.Entries) {
            $name = $e.Props['name']
            if (-not $name) { $findings.Add("$($e.Var): env entry $($e.Text) has no name"); continue }
            if ($name -in $script:ProdOnlyEnvNames) { $findings.Add("$($e.Var): env entry $($e.Text) sets $name, which only prod may have") }
            $unknown = @($e.Props.Keys | Where-Object { $_ -notin @('name', 'value', 'secretRef') })
            if ($unknown.Count) { $findings.Add("$($e.Var): env entry $($e.Text) has properties this test does not know: $($unknown -join ', ')") }
            $hasValue = $e.Props.Contains('value'); $hasRef = $e.Props.Contains('secretRef')
            if ($hasValue -eq $hasRef) { $findings.Add("$($e.Var): env entry $($e.Text) must have exactly one of value and secretRef") }
            if ($hasRef -and $script:AllowedEnvSecretRefs[$name] -ne $e.Props['secretRef']) {
                $findings.Add("$($e.Var): env entry $($e.Text) references a secret; the only secretRef staging's env may carry is FREE_TIER_GEMINI_KEY -> freeTierStagingSecretName")
            }
            if ($hasValue -and $e.Props['value'] -match $secureRx) {
                $findings.Add("$($e.Var): env entry $($e.Text) builds its value from the @secure() param $($Matches[1])")
            }
        }
        [pscustomobject]@{ Findings = @($findings); Expanded = $walk.Expanded; Vars = $walk.Vars; EntryCount = $walk.Entries.Count; SecureParams = $secure }
    }

    # One edit to a copy of main.bicep. The old text must occur exactly once, so an arm can never go vacuous
    # because main.bicep was reworded.
    function Edit-BicepCopy([string]$Old, [string]$New) {
        $count = [regex]::Matches($script:Bicep, [regex]::Escape($Old)).Count
        if ($count -ne 1) { throw "The mutation anchor <$Old> occurs $count times in main.bicep (expected 1). Update the failing-arm test to match main.bicep." }
        $script:Bicep.Replace($Old, $New)
    }

    $script:SecretReport = Get-StagingSecretReport $script:Bicep
    $script:EnvReport = Get-StagingEnvReport $script:Bicep
    # Kept for the t/669 vault test below.
    $script:StagingSecretsBody = Get-BicepVarExpr $script:Bicep 'stagingSecrets'
    $script:Expanded = $script:SecretReport.Expanded
    # t/669: easyAuthKeySecretsStaging is a multi-line conditional array, not a concat; take its whole body.
    $script:EasyAuthStagingBody = [regex]::Match($script:Bicep, '(?s)(?m)^var easyAuthKeySecretsStaging = (.*?)\] : \[\]').Groups[1].Value
    if ($script:StagingSecretsBody -match '\beasyAuthKeySecretsStaging\b') { $script:Expanded += "`n" + $script:EasyAuthStagingBody }
}

Describe 'staging holds no prod secret except the accepted OAuth three (t/654)' {
    It 'resolves staging''s secrets (the parse works)' {
        $script:StagingSecretsBody | Should -Not -BeNullOrEmpty
        $script:Expanded | Should -Match 'googleClientSecretName'
        # Not vacuous: 3 OAuth + 2 EasyAuth + the step-1 entry + staging's free-tier key.
        $script:SecretReport.EntryCount | Should -Be 7
    }

    It 'staging''s secrets are exactly the allow-listed entries, each from its allow-listed source' {
        $script:SecretReport.Findings | Should -BeNullOrEmpty -Because 'a secret outside the allow-list reached staging'
    }

    It 't/669: staging''s EasyAuth keys come from STAGING''s vault, never the prod vault' {
        $script:EasyAuthStagingBody | Should -Match 'easyAuthEncryptionSecretName'
        # t/711: EVERY keyVaultUrl, as written, starts with the staging vault's URL. One positive match plus a
        # not-match on 'keyVault.properties' passed with a single key on the prod vault's literal URL.
        # The failing arm is in BicepEasyAuthKeys.Tests.ps1.
        $urls = @([regex]::Matches($script:EasyAuthStagingBody, 'keyVaultUrl:\s*(''[^'']*''|[^,}\r\n]+)') | ForEach-Object { $_.Groups[1].Value.Trim() })
        $urls.Count | Should -Be 2 -Because 'the parse must see both keys (not vacuous)'
        $foreign = @($urls | Where-Object { -not $_.StartsWith("'`${stagingKeyVaultUrl}secrets/", [StringComparison]::Ordinal) })
        $foreign | Should -BeNullOrEmpty -Because 'a staging EasyAuth key is not read from the staging vault'
        $script:EasyAuthStagingBody | Should -Not -Match 'keyVault\.properties'
    }

    It 'every var concatenated into stagingSecrets is expanded by this test (no silent gap)' {
        foreach ($v in $script:SecretVars) { $script:SecretReport.Vars | Should -Contain $v -Because 'the parse must reach every allow-listed var (not vacuous)' }
        $script:SecretReport.Vars | Should -HaveCount ($script:SecretVars.Count + 1)
    }

    It 'staging''s secrets never include the prod token, webhook or prod free-tier key' {
        foreach ($f in $script:ForbiddenSecretNameVars) { $script:SecretReport.Expanded | Should -Not -Match "\b$f\b" }
        $script:SecretReport.Expanded | Should -Not -Match '\bsharedOauthSecrets\b'
    }

    It 'staging''s env references no prod secret: no GEMINI_PAID_KEY, GITHUB_TOKEN or GITHUB_WEBHOOK_SECRET' {
        $env = Get-BicepVarExpr $script:Bicep 'stagingContainerEnv'
        # t/813: stagingExtraFreePoolTokensCap adds one literal-named, parameter-valued, non-secret entry (FREE_POOL_DAILY_TOKENS_CAP).
        $env | Should -Be 'concat(stagingBaseEnv, stagingExtraFreeTier, stagingExtraFreePoolTokensCap)'
        $env | Should -Not -Match '\b(extraPaidTier|extraGithubToken|extraGithubWebhook|extraFreeTier)\b'
    }

    It 'staging''s env, through every var it is built from, carries no prod secret reference or secret value' {
        foreach ($v in $script:EnvVars) { $script:EnvReport.Vars | Should -Contain $v -Because 'the parse must reach every allow-listed var (not vacuous)' }
        # Not vacuous: baseEnv (29 entries today), the staging overrides (20) and the free-tier entry were all read.
        $script:EnvReport.EntryCount | Should -BeGreaterThan 40
        $script:EnvReport.SecureParams | Should -Contain 'githubToken'
        $script:EnvReport.Findings | Should -BeNullOrEmpty -Because 'staging''s env must not reach a prod secret'
    }

    It 'staging''s EasyAuth settings name the encryption key and the signing key as two different secrets' {
        $settings = Get-BicepVarExpr $script:Bicep 'easyAuthEncryptionSettingsStaging'
        $settings | Should -Match 'containerAppAuthEncryptionSecretName:\s*easyAuthEncryptionSecretName\b'
        $settings | Should -Match 'containerAppAuthSigningSecretName:\s*easyAuthSigningSecretName\b'
    }

    It 'step 1: gemini-paid-key is retained ONLY as the named step-1 entry, with no env reference to it' {
        Get-BicepVarExpr $script:Bicep 'stagingPaidKeyRetained' | Should -Be 'paidTierEnabled ? [ { name: paidTierSecretName, value: geminiPaidKey } ] : []'
        $script:EnvReport.Expanded | Should -Not -Match 'Paid'
    }
}

# t/710: the failing arm. Each case edits a COPY of main.bicep the way a prod secret could come back, and
# asserts the same check the suite runs on the real file now reports it.
Describe 'the allow-list catches a prod secret returning to staging (t/710 failing arms)' {
    It 'case 1: a quoted literal secret name' {
        $bad = Edit-BicepCopy 'var stagingSecrets = concat(stagingOauthSecrets,' "var stagingSecrets = concat(stagingOauthSecrets, [ { name: 'github-sync-token', value: githubToken } ],"
        (Get-StagingSecretReport $bad).Findings -join "`n" | Should -Match "named <'github-sync-token'>"
    }

    It 'case 2: a prod var behind a conditional in the concat' {
        $bad = Edit-BicepCopy 'var stagingSecrets = concat(stagingOauthSecrets,' 'var stagingSecrets = concat(stagingOauthSecrets, githubTokenProvided ? sharedOauthSecrets : [],'
        $found = (Get-StagingSecretReport $bad).Findings -join "`n"
        $found | Should -Match "identifier 'sharedOauthSecrets' is not on the allow-list"
        $found | Should -Match "identifier 'githubTokenProvided' is not on the allow-list"
    }

    It 'case 3: a multi-line array var, read in full' {
        $bad = Edit-BicepCopy 'var stagingPaidKeyRetained = paidTierEnabled ? [ { name: paidTierSecretName, value: geminiPaidKey } ] : []' (
            "var stagingPaidKeyRetained = paidTierEnabled ? [`n  { name: paidTierSecretName, value: geminiPaidKey }`n  { name: githubTokenSecretName, value: githubToken }`n] : []")
        (Get-StagingSecretReport $bad).Findings -join "`n" | Should -Match 'named <githubTokenSecretName>'
    }

    It 'case 3: a new var that only looks like a staging one is not expanded on its name (SO p/298#15)' {
        $bad = Edit-BicepCopy 'var stagingSecrets = concat(stagingOauthSecrets,' (
            "var stagingMoreSecrets = [`n  { name: githubTokenSecretName, value: githubToken }`n]`nvar stagingSecrets = concat(stagingOauthSecrets, stagingMoreSecrets,")
        (Get-StagingSecretReport $bad).Findings -join "`n" | Should -Match "identifier 'stagingMoreSecrets' is not on the allow-list"
    }

    It 'case 3: a var whose body cannot be captured in full throws instead of being read short' {
        $open = $script:Bicep.Substring(0, $script:Bicep.IndexOf('var stagingOauthSecrets = concat(') + 60)
        { Get-BicepVarExpr $open 'stagingOauthSecrets' } | Should -Throw '*not fully captured*'
        { Get-BicepVarExpr $script:Bicep 'noSuchStagingVar' } | Should -Throw '*found 0 times*'
        { Get-BicepVarExpr "var x = cond`n  ? [ 1 ]`n  : []`n" 'x' } | Should -Throw '*not fully captured*'
    }

    It 'case 4: a prod value under an allow-listed name' {
        $bad = Edit-BicepCopy '{ name: freeTierStagingSecretName, value: freeTierGeminiKeyStaging }' '{ name: freeTierStagingSecretName, value: githubToken }'
        (Get-StagingSecretReport $bad).Findings -join "`n" | Should -Match "must take its value from exactly 'value: freeTierGeminiKeyStaging'"
    }

    It 'case 4: an allow-listed key pointed at the prod vault, or a name var re-pointed at a prod secret' {
        $vault = Edit-BicepCopy "{ name: easyAuthSigningSecretName, keyVaultUrl: '`${stagingKeyVaultUrl}secrets/`${easyAuthSigningSecretName}', identity: 'system' }" (
            "{ name: easyAuthSigningSecretName, keyVaultUrl: 'https://kv-ait-kvwl3nywge4iw.vault.azure.net/secrets/easyauth-signing-key', identity: 'system' }")
        (Get-StagingSecretReport $vault).Findings -join "`n" | Should -Match 'easyAuthSigningSecretName.*must take its value from exactly'
        $alias = Edit-BicepCopy "var freeTierStagingSecretName = 'free-tier-gemini-key-staging'" "var freeTierStagingSecretName = 'github-sync-token'"
        (Get-StagingSecretReport $alias).Findings -join "`n" | Should -Match 'var freeTierStagingSecretName is .github-sync-token.'
    }

    It 'case 5: extraGithubToken added to stagingBaseEnv' {
        $bad = Edit-BicepCopy 'var stagingBaseEnv = concat(' 'var stagingBaseEnv = concat(extraGithubToken,'
        (Get-StagingEnvReport $bad).Findings -join "`n" | Should -Match "stagingBaseEnv: identifier 'extraGithubToken' is not on the allow-list"
    }

    It 'case 5: a prod secret written straight into staging''s env overrides' {
        $anchor = "{ name: 'GITHUB_BRANCH',       value: 'staging' }"
        $ref = Edit-BicepCopy $anchor "$anchor`n  { name: 'SYNC_TOKEN', secretRef: 'github-sync-token' }"
        (Get-StagingEnvReport $ref).Findings -join "`n" | Should -Match 'SYNC_TOKEN.*references a secret'
        $named = Edit-BicepCopy $anchor "$anchor`n  { name: 'GITHUB_TOKEN', secretRef: freeTierStagingSecretName }"
        (Get-StagingEnvReport $named).Findings -join "`n" | Should -Match 'which only prod may have'
        $value = Edit-BicepCopy $anchor "$anchor`n  { name: 'SYNC_TOKEN', value: 'Bearer `${githubToken}' }"
        (Get-StagingEnvReport $value).Findings -join "`n" | Should -Match '@secure\(\) param githubToken'
    }
}
