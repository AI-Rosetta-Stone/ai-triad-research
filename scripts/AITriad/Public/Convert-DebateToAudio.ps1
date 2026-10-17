# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Convert-DebateToAudio {
<#
.SYNOPSIS
    Converts a debate session JSON into a multi-voice audio file using OpenAI TTS.
.DESCRIPTION
    Reads a debate transcript, assigns distinct OpenAI voices to each speaker,
    generates per-turn audio clips, and concatenates them into a single output file.
    Requires ffmpeg on PATH for concatenation.
.PARAMETER Path
    Path to the debate session JSON file.
.PARAMETER OutputPath
    Path for the output audio file. Default: same directory as input, .mp3 extension.
.PARAMETER ApiKey
    OpenAI API key. Falls back to $env:OPENAI_API_KEY.
.PARAMETER Model
    OpenAI TTS model. Default: tts-1-hd.
.PARAMETER Speed
    Playback speed (0.25 to 4.0). Default: 1.0.
.PARAMETER SilenceMs
    Milliseconds of silence between turns. Default: 800.
.PARAMETER IncludeFactChecks
    Include fact-check entries narrated by the moderator voice.
.PARAMETER VoiceMap
    Hashtable overriding default voice assignments. Keys: Accelerationist, Safetyist, Skeptic, system.
.EXAMPLE
    Convert-DebateToAudio -Path './debates/session-001.json'
.EXAMPLE
    Convert-DebateToAudio -Path './debates/session-001.json' -IncludeFactChecks -Speed 1.1
.LINK
    Show-AITriadHelp
.LINK
    Show-DebateDiagnostics
.LINK
    Show-DebateHarvest
.LINK
    Get-AITClaim
.LINK
    Get-CriticalInteraction
.LINK
    Test-CriticalInteractions
.LINK
    Get-TopicFrequency
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory, Position = 0)]
    [ValidateScript({ Test-Path $_ -PathType Leaf })]
    [string]$Path,

    [string]$OutputPath,

    [string]$ApiKey,

    [ValidateSet('tts-1', 'tts-1-hd')]
    [string]$Model = 'tts-1-hd',  # model-lint:allow-pin OpenAI TTS model, not an ai-models.json chat backend

    [ValidateRange(0.25, 4.0)]
    [double]$Speed = 1.0,

    [ValidateRange(100, 5000)]
    [int]$SilenceMs = 800,

    [switch]$IncludeFactChecks,

    [hashtable]$VoiceMap
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── Resolve API key ──────────────────────────────────────────────────────────
if (-not $ApiKey) { $ApiKey = $env:OPENAI_API_KEY }
if (-not $ApiKey) {
    throw (New-ActionableError -AsErrorRecord -Goal 'Generate debate audio' `
        -Problem 'No OpenAI API key provided' `
        -Location 'Convert-DebateToAudio' `
        -NextSteps @('Set $env:OPENAI_API_KEY', 'Pass -ApiKey parameter'))
}

# ── Verify ffmpeg ────────────────────────────────────────────────────────────
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    throw (New-ActionableError -AsErrorRecord -Goal 'Concatenate audio clips' `
        -Problem 'ffmpeg not found on PATH' `
        -Location 'Convert-DebateToAudio' `
        -NextSteps @('Install ffmpeg: winget install ffmpeg', 'Add ffmpeg to PATH'))
}

# ── Default voice assignments ────────────────────────────────────────────────
$DefaultVoices = @{
    Accelerationist = 'onyx'
    Safetyist   = 'nova'
    Skeptic  = 'shimmer'
    user       = 'echo'
    system     = 'alloy'
}

if ($VoiceMap) {
    foreach ($key in $VoiceMap.Keys) {
        $DefaultVoices[$key] = $VoiceMap[$key]
    }
}

# ── Load debate session ──────────────────────────────────────────────────────
$Session = Get-Content -Raw -Path $Path | ConvertFrom-Json
if (-not $Session.transcript -or $Session.transcript.Count -eq 0) {
    throw (New-ActionableError -AsErrorRecord -Goal 'Convert debate to audio' `
        -Problem 'Debate session has no transcript entries' `
        -Location $Path `
        -NextSteps @('Ensure the debate has been run and has transcript entries'))
}

# ── Filter transcript entries ────────────────────────────────────────────────
$Entries = @($Session.transcript | Where-Object {
    if ($_.type -eq 'system') { return $false }
    if ($_.type -eq 'fact-check' -and -not $IncludeFactChecks) { return $false }
    return $true
})

if ($Entries.Count -eq 0) {
    Write-Host "  No speakable entries found in transcript." -ForegroundColor Yellow
    return
}

Write-Host "`n  DEBATE → AUDIO CONVERSION" -ForegroundColor Cyan
Write-Host "  Model: $Model | Entries: $($Entries.Count) | Speed: ${Speed}x" -ForegroundColor Gray
Write-Host "  Voices: Accelerationist=$($DefaultVoices['Accelerationist']), Safetyist=$($DefaultVoices['Safetyist']), Skeptic=$($DefaultVoices['Skeptic']), Moderator=$($DefaultVoices['system'])`n" -ForegroundColor Gray

# ── Set up temp directory ────────────────────────────────────────────────────
$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) "debate-audio-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
New-Item -ItemType Directory -Path $TempDir -Force | Out-Null

# ── Generate silence file ────────────────────────────────────────────────────
$SilencePath = Join-Path $TempDir '_silence.mp3'
$SilenceSec = $SilenceMs / 1000.0
& ffmpeg -y -f lavfi -i "anullsrc=r=24000:cl=mono" -t $SilenceSec -q:a 9 -ar 24000 $SilencePath 2>$null

# ── Generate per-turn audio ──────────────────────────────────────────────────
$Headers = @{
    'Authorization' = "Bearer $ApiKey"
    'Content-Type'  = 'application/json'
}

$ClipPaths = [System.Collections.Generic.List[string]]::new()
$TotalChars = 0

for ($i = 0; $i -lt $Entries.Count; $i++) {
    $Entry = $Entries[$i]
    $Speaker = $Entry.speaker
    if ($Entry.type -in @('concluding','synthesis','fact-check')) {
        $Voice = $DefaultVoices['system']
    } else {
        $Voice = $DefaultVoices[$Speaker]
        if (-not $Voice) { $Voice = $DefaultVoices['system'] }
    }

    $Text = $Entry.content
    if ($Entry.type -eq 'fact-check') {
        $Text = "Fact check: $Text"
    } elseif ($Entry.type -in @('concluding','synthesis')) {
        $Text = "Synthesis: $Text"
    }

    # OpenAI TTS has a 4096 char limit per request — split if needed
    $Chunks = [System.Collections.Generic.List[string]]::new()
    if ($Text.Length -le 4096) {
        $Chunks.Add($Text)
    } else {
        $Sentences = $Text -split '(?<=[.!?])\s+'
        $Current = ''
        foreach ($s in $Sentences) {
            if (($Current.Length + $s.Length + 1) -gt 4000) {
                if ($Current) { $Chunks.Add($Current) }
                $Current = $s
            } else {
                $Current = if ($Current) { "$Current $s" } else { $s }
            }
        }
        if ($Current) { $Chunks.Add($Current) }
    }

    $EntryClips = [System.Collections.Generic.List[string]]::new()
    for ($c = 0; $c -lt $Chunks.Count; $c++) {
        $Chunk = $Chunks[$c]
        $ClipPath = Join-Path $TempDir "turn-$($i.ToString('D4'))-chunk-$($c.ToString('D2')).mp3"

        $Body = @{
            model  = $Model
            voice  = $Voice
            input  = $Chunk
            speed  = $Speed
            response_format = 'mp3'
        } | ConvertTo-Json -Compress

        $attempt = 0
        $success = $false
        while ($attempt -lt 3 -and -not $success) {
            try {
                Invoke-RestMethod -Uri 'https://api.openai.com/v1/audio/speech' `
                    -Method Post -Headers $Headers -Body $Body `
                    -OutFile $ClipPath -TimeoutSec 60
                $success = $true
            } catch {
                $attempt++
                if ($attempt -ge 3) { throw }
                Start-Sleep -Seconds (2 * $attempt)
            }
        }

        $EntryClips.Add($ClipPath)
        $TotalChars += $Chunk.Length
    }

    # Add all chunks for this turn
    foreach ($clip in $EntryClips) { $ClipPaths.Add($clip) }

    # Add silence between turns (not after last)
    if ($i -lt $Entries.Count - 1) {
        $ClipPaths.Add($SilencePath)
    }

    Write-Progress -Activity 'Converting debate to audio' `
        -Status "Turn $($i+1) of $($Entries.Count) — $Speaker ($Voice)" `
        -PercentComplete (($i + 1) / $Entries.Count * 100)
}

Write-Progress -Activity 'Converting debate to audio' -Completed
Write-Host "  Generated $($ClipPaths.Count) clips ($TotalChars chars total)" -ForegroundColor Green

# ── Concatenate with ffmpeg ──────────────────────────────────────────────────
$ListFile = Join-Path $TempDir 'filelist.txt'
$ClipPaths | ForEach-Object { "file '$($_ -replace '\\','/')'" } | Set-Content -Path $ListFile -Encoding UTF8

if (-not $OutputPath) {
    $OutputPath = [System.IO.Path]::ChangeExtension($Path, '.mp3')
}

Write-Host "  Concatenating..." -ForegroundColor Gray
& ffmpeg -y -f concat -safe 0 -i $ListFile -c copy $OutputPath 2>$null

if (Test-Path $OutputPath) {
    $Size = [math]::Round((Get-Item $OutputPath).Length / 1MB, 1)
    Write-Host "  Output: $OutputPath ($Size MB)" -ForegroundColor Green
} else {
    throw (New-ActionableError -AsErrorRecord -Goal 'Produce final audio file' `
        -Problem 'ffmpeg concatenation failed' `
        -Location 'Convert-DebateToAudio' `
        -NextSteps @('Check ffmpeg output', "Clips are in: $TempDir"))
}

# ── Cleanup ──────────────────────────────────────────────────────────────────
Remove-Item -Recurse -Force $TempDir
Write-Host "  Done.`n" -ForegroundColor Cyan
}
