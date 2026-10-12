#!/usr/bin/env pwsh
<#
.SYNOPSIS
    GUI tool to manage free-tier Gemini API keys for the Taxonomy Editor.
.DESCRIPTION
    Opens a Windows Forms dialog to add/remove Gemini API keys used by the
    free tier (anonymous web users). On save, updates the GitHub Actions
    secret FREE_TIER_GEMINI_KEY with a comma-separated key list and
    optionally triggers a redeployment.

    Requires: gh CLI (authenticated), az CLI (for immediate deploy).
.EXAMPLE
    .\Set-FreeTierKeys.ps1
.EXAMPLE
    .\Set-FreeTierKeys.ps1 -Repo AI-Rosetta-Stone/ai-triad-research
#>
[CmdletBinding()]
param(
    [string]$Repo = 'AI-Rosetta-Stone/ai-triad-research'
)

Set-StrictMode -Version Latest
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# ── Helpers ──

function Mask-Key([string]$key) {
    if ($key.Length -le 8) { return "$($key.Substring(0,2))***" }
    return "$($key.Substring(0,6))...$($key.Substring($key.Length - 4))"
}

# ── Build Form ──

$form = [System.Windows.Forms.Form]@{
    Text            = 'Free-Tier Gemini API Keys'
    Size            = [System.Drawing.Size]::new(520, 460)
    StartPosition   = 'CenterScreen'
    FormBorderStyle = 'FixedDialog'
    MaximizeBox     = $false
    Font            = [System.Drawing.Font]::new('Segoe UI', 10)
}

$lblTitle = [System.Windows.Forms.Label]@{
    Text     = 'Manage Gemini API keys for anonymous free-tier users.'
    Location = [System.Drawing.Point]::new(16, 12)
    Size     = [System.Drawing.Size]::new(480, 24)
}

$lblSubtitle = [System.Windows.Forms.Label]@{
    Text      = 'Keys are stored as a GitHub Actions secret and injected at deploy time.'
    Location  = [System.Drawing.Point]::new(16, 34)
    Size      = [System.Drawing.Size]::new(480, 20)
    ForeColor = [System.Drawing.Color]::Gray
    Font      = [System.Drawing.Font]::new('Segoe UI', 8.5)
}

$listBox = [System.Windows.Forms.ListBox]@{
    Location = [System.Drawing.Point]::new(16, 64)
    Size     = [System.Drawing.Size]::new(370, 180)
}

$btnRemove = [System.Windows.Forms.Button]@{
    Text     = 'Remove'
    Location = [System.Drawing.Point]::new(396, 64)
    Size     = [System.Drawing.Size]::new(90, 32)
    Enabled  = $false
}

$btnClear = [System.Windows.Forms.Button]@{
    Text     = 'Clear All'
    Location = [System.Drawing.Point]::new(396, 102)
    Size     = [System.Drawing.Size]::new(90, 32)
}

$lblAdd = [System.Windows.Forms.Label]@{
    Text     = 'Add key:'
    Location = [System.Drawing.Point]::new(16, 258)
    Size     = [System.Drawing.Size]::new(60, 24)
}

$txtKey = [System.Windows.Forms.TextBox]@{
    Location    = [System.Drawing.Point]::new(80, 256)
    Size        = [System.Drawing.Size]::new(306, 28)
    UseSystemPasswordChar = $true
}

$btnAdd = [System.Windows.Forms.Button]@{
    Text     = 'Add'
    Location = [System.Drawing.Point]::new(396, 254)
    Size     = [System.Drawing.Size]::new(90, 28)
}

$chkDeploy = [System.Windows.Forms.CheckBox]@{
    Text     = 'Trigger redeployment after saving (recommended)'
    Location = [System.Drawing.Point]::new(16, 300)
    Size     = [System.Drawing.Size]::new(380, 24)
    Checked  = $true
}

$lblStatus = [System.Windows.Forms.Label]@{
    Text      = ''
    Location  = [System.Drawing.Point]::new(16, 336)
    Size      = [System.Drawing.Size]::new(480, 40)
    ForeColor = [System.Drawing.Color]::DarkGreen
    Font      = [System.Drawing.Font]::new('Segoe UI', 8.5)
}

$btnSave = [System.Windows.Forms.Button]@{
    Text     = 'Save to GitHub Secret'
    Location = [System.Drawing.Point]::new(140, 380)
    Size     = [System.Drawing.Size]::new(200, 36)
    Font     = [System.Drawing.Font]::new('Segoe UI', 10, [System.Drawing.FontStyle]::Bold)
}

# Raw keys stored here (never displayed unmasked after entry).
$rawKeys = [System.Collections.Generic.List[string]]::new()

# ── Event Handlers ──

function Refresh-List {
    $listBox.Items.Clear()
    for ($i = 0; $i -lt $rawKeys.Count; $i++) {
        $listBox.Items.Add("[$($i + 1)]  $(Mask-Key $rawKeys[$i])")
    }
    $btnRemove.Enabled = $listBox.SelectedIndex -ge 0
    $btnSave.Enabled = $rawKeys.Count -gt 0
}

$listBox.add_SelectedIndexChanged({ $btnRemove.Enabled = $listBox.SelectedIndex -ge 0 })

$btnAdd.add_Click({
    $key = $txtKey.Text.Trim()
    if (-not $key) {
        $lblStatus.ForeColor = [System.Drawing.Color]::DarkRed
        $lblStatus.Text = 'Enter a key first.'
        return
    }
    if ($rawKeys.Contains($key)) {
        $lblStatus.ForeColor = [System.Drawing.Color]::DarkRed
        $lblStatus.Text = 'Duplicate key — already in the list.'
        return
    }
    $rawKeys.Add($key)
    $txtKey.Clear()
    $txtKey.Focus()
    $lblStatus.ForeColor = [System.Drawing.Color]::DarkGreen
    $lblStatus.Text = "Added key $(Mask-Key $key). Total: $($rawKeys.Count) key(s)."
    Refresh-List
})

$btnRemove.add_Click({
    $idx = $listBox.SelectedIndex
    if ($idx -ge 0 -and $idx -lt $rawKeys.Count) {
        $removed = Mask-Key $rawKeys[$idx]
        $rawKeys.RemoveAt($idx)
        $lblStatus.ForeColor = [System.Drawing.Color]::DarkGreen
        $lblStatus.Text = "Removed $removed. Total: $($rawKeys.Count) key(s)."
        Refresh-List
    }
})

$btnClear.add_Click({
    $rawKeys.Clear()
    $lblStatus.Text = 'All keys cleared.'
    Refresh-List
})

$txtKey.add_KeyDown({
    if ($_.KeyCode -eq [System.Windows.Forms.Keys]::Enter) {
        $btnAdd.PerformClick()
        $_.SuppressKeyPress = $true
    }
})

$btnSave.add_Click({
    if ($rawKeys.Count -eq 0) {
        $lblStatus.ForeColor = [System.Drawing.Color]::DarkRed
        $lblStatus.Text = 'Add at least one key.'
        return
    }

    $joined = $rawKeys -join ','
    $btnSave.Enabled = $false
    $lblStatus.ForeColor = [System.Drawing.Color]::Gray
    $lblStatus.Text = "Setting GitHub secret ($($rawKeys.Count) key(s))..."
    $form.Refresh()

    try {
        $joined | gh secret set FREE_TIER_GEMINI_KEY --repo $Repo 2>&1
        if ($LASTEXITCODE -ne 0) { throw "gh secret set failed (exit code $LASTEXITCODE)" }
        $lblStatus.ForeColor = [System.Drawing.Color]::DarkGreen
        $lblStatus.Text = "Secret saved ($($rawKeys.Count) key(s)). "

        if ($chkDeploy.Checked) {
            $lblStatus.Text += 'Triggering deploy...'
            $form.Refresh()
            # t/3679 (deploy-by-digest): deploy-azure.yml now requires an explicit `sha` input — it resolves
            # that commit's sha-<commit> tag to an immutable digest and no longer defaults to :latest. So a
            # bare dispatch fail-closes. Deploy the current origin/main HEAD by resolving its SHA first.
            $deploySha = (gh api "repos/$Repo/commits/main" --jq '.sha' 2>&1)
            if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($deploySha)) {
                $lblStatus.Text += ' Could not resolve main HEAD — run deploy manually: gh workflow run deploy-azure.yml -f sha=<commit>.'
                $lblStatus.ForeColor = [System.Drawing.Color]::DarkOrange
            } else {
                $deploySha = $deploySha.Trim()
                gh workflow run deploy-azure.yml --repo $Repo -f sha=$deploySha 2>&1
                if ($LASTEXITCODE -eq 0) {
                    $lblStatus.Text = "Done! $($rawKeys.Count) key(s) saved + deploy triggered (sha $($deploySha.Substring(0, [Math]::Min(7, $deploySha.Length))))."
                } else {
                    $lblStatus.Text += ' Deploy trigger failed — run manually.'
                    $lblStatus.ForeColor = [System.Drawing.Color]::DarkOrange
                }
            }
        }
    }
    catch {
        $lblStatus.ForeColor = [System.Drawing.Color]::DarkRed
        $lblStatus.Text = "Error: $_"
    }
    finally {
        $btnSave.Enabled = $rawKeys.Count -gt 0
    }
})

# ── Assemble & Show ──

$form.AcceptButton = $btnAdd
$form.Controls.AddRange(@(
    $lblTitle, $lblSubtitle,
    $listBox, $btnRemove, $btnClear,
    $lblAdd, $txtKey, $btnAdd,
    $chkDeploy, $lblStatus, $btnSave
))

$btnSave.Enabled = $false
$txtKey.Focus()
[void]$form.ShowDialog()
$form.Dispose()
