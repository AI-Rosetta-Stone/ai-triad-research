# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# AI Call Log — core (t/3241; epic t/3235, TL design t/3235#1). A per-call audit log behind the
# default-off AI_CALL_LOG_ENABLED flag. Storage: append-only JSONL under the resolved data root
# (mirrors the flight-recorder file pattern; Get-/Show-AICallLog run in a SEPARATE process from the
# debate that writes, so an on-disk file — not an in-memory session — is what survives). These are
# dot-sourced Private helpers: the capture hook (t/3242) calls Write-AICallLogEntry; Get-/Show-
# AICallLog (t/3243/3244) read the same file; Clear-AICallLog (Public) rotates it.
#
# Record schema (10 fields, in order): ID, Datetime, Scenario, PromptID, PromptStart, RetryCount, Status,
# Model, Backend, KeySource. The last three were added by t/4088 (TL t/4088#3). The contract artifact,
# including the closed KeySource vocabulary, is tests/fixtures/ai-call-log/README.md, shared with the
# TS writers (taxonomy-editor/src/server/ai/aiCallLog.ts and taxonomy-editor/src/main/aiCallLog.ts).

# KeySource is a CLOSED vocabulary: a free-form value is where a key fragment could leak in. env:<VAR>
# is allowed only for these known backend key variables. AIModelBackend.Registry tests pin this list
# against AIEnrich's $script:AIApiKeyEnvVarMap, so the two cannot drift.
$script:AICallLogKeyVars = @(
    'GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_API_KEY', 'GROQ_API_KEY', 'OPENAI_API_KEY',
    'AZURE_OPENAI_API_KEY', 'ZAI_API_KEY', 'MOONSHOT_API_KEY', 'XAI_API_KEY', 'DEEPSEEK_API_KEY'
)

function Test-AICallLogKeySource {
    <#
    .SYNOPSIS
        True when a value is in the closed KeySource vocabulary (t/4088): '' (unknown), explicit,
        fallback:AI_API_KEY, store, keyvault, none, or env:<known key variable>.
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param([AllowEmptyString()][string]$Value)
    # Case-sensitive: a closed vocabulary means exact values, and the TS writers compare exactly too.
    if ($Value -cin '', 'explicit', 'fallback:AI_API_KEY', 'store', 'keyvault', 'none') { return $true }
    return ($Value -cmatch '^env:([A-Z][A-Z0-9_]*)$' -and $Matches[1] -cin $script:AICallLogKeyVars)
}

function Test-AICallLogEnabled {
    <#
    .SYNOPSIS
        Is the AI call log enabled? True iff $env:AI_CALL_LOG_ENABLED is a truthy value.
    .DESCRIPTION
        Default OFF: unset/empty/anything-not-truthy → $false, so the capture hook is a single
        early-return with zero overhead (the AC's "flag off → no perf impact"). Truthy values:
        1 | true | yes | on (case-insensitive).
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param()
    $v = [Environment]::GetEnvironmentVariable('AI_CALL_LOG_ENABLED')
    return (-not [string]::IsNullOrWhiteSpace($v)) -and ($v -match '^(1|true|yes|on)$')
}

function Get-AICallLogPath {
    <#
    .SYNOPSIS
        Absolute path to ai-call-log.jsonl under the resolved data root.
    .DESCRIPTION
        Storage-path resolution per t/3235#1: env AI_TRIAD_DATA_ROOT > .aitriad.json > platform
        default (via the shared Get-DataRoot resolver). Not guaranteed to exist — the writer
        creates the parent dir on first append.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param()
    return (Join-Path (Get-DataRoot) 'ai-call-log.jsonl')
}

function Get-AICallLogNextId {
    <#
    .SYNOPSIS
        Next monotonic record ID for the log file: last record's ID + 1, else 1.
    .DESCRIPTION
        ID is monotonic WITHIN the current file ("a session = the file"); Clear-AICallLog removes
        the file so the next id restarts at 1. Reads only the last line (Get-Content -Tail 1), not
        the whole file. A malformed/absent tail falls back to 1 (fresh session).
    #>
    [CmdletBinding()]
    [OutputType([int])]
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return 1 }
    $last = Get-Content -LiteralPath $Path -Tail 1 -Encoding utf8 -ErrorAction SilentlyContinue
    if ([string]::IsNullOrWhiteSpace($last)) { return 1 }
    try {
        $prev = $last | ConvertFrom-Json -ErrorAction Stop
        if ($prev.PSObject.Properties['ID']) { return ([int]$prev.ID + 1) }
    }
    catch {
        # Fallback-path logging (docs/error-handling.md): a corrupt tail line shouldn't wedge the
        # counter — restart the id sequence and surface why.
        Write-Warning "Get-AICallLogNextId: could not parse the last log line in '$Path' ($($_.Exception.Message)); restarting ID at 1."
    }
    return 1
}

function Write-AICallLogEntry {
    <#
    .SYNOPSIS
        Append one 10-field JSONL record to the AI call log — a no-op when the flag is off.
    .DESCRIPTION
        The single append-writer for the AI Call Log (t/3235#1). Returns immediately with ZERO
        overhead unless AI_CALL_LOG_ENABLED is truthy (the capture hook, t/3242, calls this on every
        AI call). Writes are FAIL-SAFE: an IO error is WARNed and swallowed (fallback-path logging)
        so enabling the audit log can never break the AI call it audits.

        Record fields (schema of record, in order):
          ID          monotonic within the file (Get-AICallLogNextId)
          Datetime    UTC, ISO-8601 round-trip ('o')
          Scenario    caller-supplied tag (e.g. Debate, Chat, Fact Check, Logical Form)
          PromptID    UsageID from ai-usages.json, or '' when absent
          PromptStart first 160 chars of the rendered prompt
          RetryCount  0 first attempt, N for the Nth retry
          Status      HTTP/API status (e.g. 200, 429, 500, timeout)
          Model       registry id actually called (a cascade link logs its own)          (t/4088)
          Backend     ai-models.json backend of that model, never a prefix guess         (t/4088)
          KeySource   WHERE the key came from, closed vocabulary; never the key itself   (t/4088)
    .PARAMETER KeySource
        Must be in the closed vocabulary (Test-AICallLogKeySource). Any other value is written as ''
        with a WARN, never as free-form text (TL t/4088#3).
    .PARAMETER Path
        Log file override (fixtures/tests). Default: Get-AICallLogPath.
    #>
    [CmdletBinding()]
    [OutputType([void])]
    param(
        [Parameter()]
        [AllowEmptyString()]
        [string]$Scenario = '',

        [Parameter()]
        [AllowEmptyString()]
        [string]$PromptID = '',

        [Parameter()]
        [AllowEmptyString()]
        [string]$PromptStart = '',

        [Parameter()]
        [int]$RetryCount = 0,

        [Parameter()]
        [AllowEmptyString()]
        [string]$Status = '',

        [Parameter()]
        [AllowEmptyString()]
        [string]$Model = '',

        [Parameter()]
        [AllowEmptyString()]
        [string]$Backend = '',

        [Parameter()]
        [AllowEmptyString()]
        [string]$KeySource = '',

        [Parameter()]
        [string]$Path
    )
    Set-StrictMode -Version Latest

    if (-not (Test-AICallLogEnabled)) { return }   # default-off: single early-return, zero overhead

    $logPath = if ($PSBoundParameters.ContainsKey('Path') -and $Path) { $Path } else { Get-AICallLogPath }

    try {
        $dir = Split-Path -Parent $logPath
        if ($dir -and -not (Test-Path -LiteralPath $dir)) {
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
        }

        $start = [string]$PromptStart
        if ($start.Length -gt 160) { $start = $start.Substring(0, 160) }

        # Closed vocabulary (TL t/4088#3): an unmappable value is never written as free text.
        if (-not (Test-AICallLogKeySource -Value $KeySource)) {
            Write-Warning "Write-AICallLogEntry: KeySource is not in the closed vocabulary (tests/fixtures/ai-call-log/README.md); writing '' instead (t/4088)."
            $KeySource = ''
        }

        # [ordered] so the JSONL field order matches the schema of record.
        $record = [ordered]@{
            ID          = Get-AICallLogNextId -Path $logPath
            Datetime    = [DateTime]::UtcNow.ToString('o')
            Scenario    = $Scenario
            PromptID    = $PromptID
            PromptStart = $start
            RetryCount  = $RetryCount
            Status      = $Status
            Model       = $Model
            Backend     = $Backend
            KeySource   = $KeySource
        }
        $line = $record | ConvertTo-Json -Compress -Depth 4
        Add-Content -LiteralPath $logPath -Value $line -Encoding utf8NoBOM
    }
    catch {
        # Fail-safe (t/3235#1): audit logging must never break the call it audits.
        Write-Warning "Write-AICallLogEntry: failed to append to '$logPath' ($($_.Exception.Message)); continuing (audit log is non-fatal)."
    }
}
