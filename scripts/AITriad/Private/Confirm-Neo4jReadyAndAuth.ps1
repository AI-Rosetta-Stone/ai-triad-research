# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Confirm-Neo4jReadyAndAuth {
    <#
    .SYNOPSIS
        Install-GraphDatabase's Step 6/6b: wait for Neo4j to come up, then AUTHENTICATE
        against it with the intended credential (t/3877 -- extracted verbatim from
        Install-GraphDatabase to bring that function's complexity back under its
        complexity-ratchet baseline; no behavior change).
    .DESCRIPTION
        Polls http://localhost:7474 until ready or timeout. On ready, makes ONE
        AUTHENTICATED request (Test-Neo4jAuthProbe) — the HTTP port being up does NOT
        prove the credential took; if the image ignored NEO4J_AUTH_FILE it is running on
        DEFAULT credentials (SO cond.1). Fails LOUDLY on a confirmed credential mismatch
        rather than silently shipping a default-cred DB.

        -PassThru emits the verified [PSCredential] on the pipeline (as a bare Write-Output,
        reaching the CALLER's pipeline transparently) only on the one path where authentication
        was actually confirmed this invocation — every other outcome (timeout, unauthorized,
        unreachable) warns naming why and emits nothing (the single invariant, SO e/242#2).
    .PARAMETER ContainerName
        The running container's name, for log/remediation text only.
    .PARAMETER Principal
        Resolved username to authenticate as. Named Principal, not "User" (paired with a
        "Password"-named parameter below), to avoid PSAvoidUsingUsernameAndPasswordParams --
        same convention as ConvertTo-Neo4jCredential's -Principal/-Secret.
    .PARAMETER Secret
        Resolved plaintext password to authenticate with (point-of-use materialization;
        not persisted here). Named Secret, not "Password", for the same PSSA reason.
    .PARAMETER AuthFile
        Path to the short-lived host auth-secret file — scrubbed to zero bytes on confirmed
        auth, left in place (with a warning) on any unconfirmed outcome (SO cond.2: fail-open
        is the dangerous case, so the file is never deleted on a path that didn't prove auth).
    .PARAMETER PassThru
        Emit the authenticated [PSCredential] on the pipeline when verification succeeds.
    .OUTPUTS
        [PSCredential] on the pipeline when -PassThru and authentication succeeded. Nothing
        otherwise. Throws New-ActionableError when the container is reachable but confirmed
        to have rejected the intended credential.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$ContainerName,

        [Parameter(Mandatory)]
        [string]$Principal,

        [Parameter(Mandatory)]
        [string]$Secret,

        [Parameter(Mandatory)]
        [string]$AuthFile,

        [switch]$PassThru
    )

    Set-StrictMode -Version Latest

    Write-Step 'Waiting for Neo4j to initialize'
    $MaxWait = 30
    $Ready = $false
    for ($i = 0; $i -lt $MaxWait; $i++) {
        Start-Sleep -Seconds 2
        try {
            $null = Invoke-RestMethod -Uri 'http://localhost:7474' -TimeoutSec 2 -ErrorAction Stop
            $Ready = $true
            break
        } catch {
            Write-Host '.' -NoNewline -ForegroundColor DarkGray
        }
    }
    Write-Host ''

    if ($Ready) {
        Write-OK 'Neo4j is ready'

        # Step 6b (SO cond.1): the HTTP port being up does NOT prove the credential took — if the image
        # ignored NEO4J_AUTH_FILE it is running on DEFAULT creds. Make one AUTHENTICATED request with the
        # intended credential; fail LOUDLY on mismatch rather than silently shipping a default-cred DB.
        #
        # t/3856: this used to probe via Invoke-CypherQuery -ErrorAction Stop. That cmdlet catches its own
        # HTTP/auth exceptions internally and never rethrows, so -ErrorAction Stop there was a no-op —
        # $AuthVerified became $true regardless of whether authentication actually succeeded. Probing via
        # Test-Neo4jAuthProbe (direct Invoke-RestMethod call) instead of through Invoke-CypherQuery means
        # this detection is not blocked on fixing that cmdlet for its other callers (t/3855, separate).
        # t/3839: ConvertTo-Neo4jCredential centralizes the AppendChar SecureString build (not
        # ConvertTo-SecureString -AsPlainText, which PSSA flags) — the plaintext is one we just
        # resolved/generated, re-typed here only to satisfy Test-Neo4jAuthProbe's -Credential contract.
        $ProbeCred = ConvertTo-Neo4jCredential -Principal $Principal -Secret $Secret
        $Probe = Test-Neo4jAuthProbe -Credential $ProbeCred
        $AuthVerified = $Probe.Verified
        if (-not $AuthVerified) {
            Write-Fail "Neo4j credential verification failed: $($Probe.Message)"
        }

        if ($AuthVerified) {
            Write-OK 'Neo4j credential verified (authenticated RETURN 1)'
            # SO cond.2: scrub the secret ONLY after the credential is confirmed. TRUNCATE to zero bytes
            # rather than Remove-Item (Docker/WSL2 verify, t/3833#4, p/707): deleting a live bind-mount
            # source makes Docker recreate it as a DIRECTORY, so every later `docker start` fails with
            # "not a directory: mount a directory onto a file". A zero-byte file holds no secret, keeps the
            # bind source a file, and restarts cleanly (neo4j only reads NEO4J_AUTH_FILE at first init).
            [System.IO.File]::WriteAllBytes($AuthFile, [byte[]]@())
            # t/3839: proof already established above (Step 6b's own probe) — emit directly
            # rather than re-probing. Satisfies the single invariant: authenticated this invocation.
            if ($PassThru) { Write-Output $ProbeCred }
        } else {
            # SO cond.2: leave the file on failure; fail loudly (fail-open is the dangerous case).
            Write-Warn "Auth secret file LEFT at $AuthFile (contains the Neo4j password) — not removed; credential unverified."
            # t/3856 (SO cond.5): distinguish wrong-credential from unreachable — opposite remedies.
            $ProblemDetail = if ($Probe.Reason -eq 'unauthorized') {
                "The container started and port 7474 is up, but it REJECTED the intended credential (HTTP 401) — Neo4j likely did not apply NEO4J_AUTH_FILE and may be running on DEFAULT credentials (a silent credential downgrade)."
            } else {
                "The container started and port 7474 is up, but the authenticated verification request could not reach it: $($Probe.Message)"
            }
            throw (New-ActionableError `
                    -Goal 'Install Neo4j with a hardened credential channel' `
                    -Problem $ProblemDetail `
                    -Location 'Install-GraphDatabase' `
                    -NextSteps @(
                        "Check: docker logs $ContainerName (look for auth/NEO4J_AUTH_FILE errors)",
                        'Confirm the image honors NEO4J_AUTH_FILE; fallback is neo4j-admin dbms set-initial-password (t/3833)',
                        "The secret file was left at $AuthFile — remove it after resolving",
                        'Then re-run Install-GraphDatabase -Force') `
                    -AsErrorRecord)
        }
    } else {
        # SO cond.2: timeout only WARNS (never fails) — so do NOT delete the file out from under a
        # still-initializing container; leave it with its path + secret note.
        Write-Warn 'Neo4j may still be starting. Check docker logs ai-triad-neo4j'
        Write-Warn "Auth secret file LEFT at $AuthFile (contains the Neo4j password) — not removed while readiness is unconfirmed; remove it once auth is confirmed, or re-run -Force."
        if ($PassThru) { Write-Warn '-PassThru: no credential emitted (readiness timeout — nothing to authenticate against yet).' }
    }
}
