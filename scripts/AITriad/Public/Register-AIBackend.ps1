# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Register-AIBackend {
    <#
    .SYNOPSIS
        Opens a local GUI to configure AI backend API keys and default model.
    .DESCRIPTION
        Launches a browser-based configuration panel on a local HTTP server.
        Shows existing API keys (masked) and default model, lets you update them,
        validates keys with a live API smoke test, and persists settings to both
        the current session and the user's shell profile.

        Settings are stored as environment variables:
          GEMINI_API_KEY     — Google Gemini (primary backend)
          ANTHROPIC_API_KEY  — Anthropic Claude
          GROQ_API_KEY       — Groq
          OPENAI_API_KEY     — OpenAI
          OLLAMA_BASE_URL    — Ollama local server (default: http://localhost:11434)
          AI_MODEL           — Default model for all AI commands

        On save, values are written to ~/.aitriad-env (sourced from shell profile).
    .PARAMETER Port
        Local HTTP port for the configuration UI (default: 5199).
    .PARAMETER NoBrowser
        Don't auto-open the browser; just print the URL.
    .EXAMPLE
        Register-AIBackend
    .EXAMPLE
        Register-AIBackend -Port 8888 -NoBrowser
    .LINK
        Show-AITriadHelp
    .LINK
        Get-TriadConfig
    .LINK
        Set-TriadConfig
    .LINK
        Invoke-TriadConfigReload
    .LINK
        Test-AIApiKey
    #>
    [CmdletBinding()]
    param(
        [int]$Port = 5199,
        [switch]$NoBrowser
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    $EnvFilePath = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.aitriad-env'

    # ── Load persisted values (prefer env vars, fall back to file) ────────────
    $Persisted = @{
        GEMINI_API_KEY    = ''
        ANTHROPIC_API_KEY = ''
        GROQ_API_KEY      = ''
        OPENAI_API_KEY    = ''
        OLLAMA_BASE_URL   = ''
        ZAI_API_KEY       = ''
        AI_MODEL          = ''
    }

    # Read from file first
    if (Test-Path $EnvFilePath) {
        foreach ($Line in Get-Content $EnvFilePath) {
            if ($Line -match '^\s*export\s+(\w+)=["'']?(.+?)["'']?\s*$') {
                $Key = $Matches[1]
                $Val = $Matches[2]
                if ($Persisted.ContainsKey($Key)) { $Persisted[$Key] = $Val }
            }
            elseif ($Line -match '^\s*\$env:(\w+)\s*=\s*["''](.+?)["'']\s*$') {
                $Key = $Matches[1]
                $Val = $Matches[2]
                if ($Persisted.ContainsKey($Key)) { $Persisted[$Key] = $Val }
            }
        }
    }

    # Env vars override file
    foreach ($Key in @('GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'GROQ_API_KEY', 'OPENAI_API_KEY', 'OLLAMA_BASE_URL', 'ZAI_API_KEY', 'AI_MODEL')) {
        $EnvVal = [Environment]::GetEnvironmentVariable($Key)
        if (-not [string]::IsNullOrWhiteSpace($EnvVal)) { $Persisted[$Key] = $EnvVal }
    }

    # ── Model list ────────────────────────────────────────────────────────────
    # Every id MUST be registered in ai-models.json — enforced by the picker-registry
    # guard test (t/3586). The general model-lint can't see this list (it keys on
    # 'id =', not 'model =' / -Model), so the guard is the backstop against drift.
    $Models = @(
        @{ id = 'gemini-3.5-flash-lite';          label = 'Gemini 3.5 Flash Lite (default)'; backend = 'gemini' }
        @{ id = 'gemini-2.5-pro';                 label = 'Gemini 2.5 Pro';                  backend = 'gemini' }
        @{ id = 'claude-opus-4-8';                label = 'Claude Opus 4.8';                 backend = 'claude' }
        @{ id = 'claude-sonnet-4-5';              label = 'Claude Sonnet 4.5';               backend = 'claude' }
        @{ id = 'claude-haiku-4-5';               label = 'Claude Haiku 4.5';                backend = 'claude' }
        @{ id = 'groq-openai-gpt-oss-120b';       label = 'Groq GPT-OSS 120B';               backend = 'groq' }
        @{ id = 'openai-gpt-5.5';                 label = 'OpenAI GPT-5.5';                  backend = 'openai' }
        @{ id = 'openai-gpt-5.5-pro';             label = 'OpenAI GPT-5.5 Pro';              backend = 'openai' }
        @{ id = 'ollama-gemma4-e4b-it-q4-k-m';    label = 'Ollama Gemma 4 E4B';              backend = 'ollama' }
        # t/1437 — z.ai / GLM (OpenAI-compatible, 1M-token context)
        @{ id = 'zai-glm-5-3';                    label = 'z.ai GLM-5.3';                    backend = 'zai' }
        @{ id = 'zai-glm-5-3-flash';              label = 'z.ai GLM-5.3 Flash';              backend = 'zai' }
    )

    $ModelsJson = $Models | ConvertTo-Json -Compress

    # ── Mask keys for initial display ─────────────────────────────────────────
    function Get-MaskedKey([string]$Key) {
        if ([string]::IsNullOrWhiteSpace($Key)) { return '' }
        if ($Key.Length -le 8) { return '*' * $Key.Length }
        return $Key.Substring(0, 4) + ('*' * ($Key.Length - 8)) + $Key.Substring($Key.Length - 4)
    }

    # Masked-only — unmasked keys never leave the server process (t/2527)
    $InitialState = @{
        ollama_url       = $Persisted['OLLAMA_BASE_URL']
        ai_model         = $Persisted['AI_MODEL']
        gemini_masked    = Get-MaskedKey $Persisted['GEMINI_API_KEY']
        anthropic_masked = Get-MaskedKey $Persisted['ANTHROPIC_API_KEY']
        groq_masked      = Get-MaskedKey $Persisted['GROQ_API_KEY']
        openai_masked    = Get-MaskedKey $Persisted['OPENAI_API_KEY']
        zai_masked       = Get-MaskedKey $Persisted['ZAI_API_KEY']
    } | ConvertTo-Json

    # Per-run CSPRNG bearer token — injected into the browser URL, required on every endpoint (t/2527).
    # The ?token= query param lands in browser history; this is an accepted risk for an ephemeral
    # localhost server (same pattern as Jupyter). Token is never persisted.
    $Token          = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(24))
    $ExpectedHost   = "127.0.0.1:$Port"
    $ExpectedOrigin = "http://127.0.0.1:$Port"

    # ── HTML ──────────────────────────────────────────────────────────────────
    $Html = @"
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI Triad — Backend Configuration</title>
<style>
  :root { --bg: #1a1a2e; --surface: #16213e; --border: #0f3460; --accent: #e94560;
          --text: #eee; --muted: #888; --ok: #4ecca3; --warn: #ffc107; --err: #e94560; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
         background: var(--bg); color: var(--text); padding: 2rem; max-width: 680px; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin-bottom: 0.3rem; }
  .subtitle { color: var(--muted); margin-bottom: 2rem; font-size: 0.9rem; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
          padding: 1.5rem; margin-bottom: 1.5rem; }
  .card h2 { font-size: 1.1rem; margin-bottom: 1rem; display: flex; align-items: center; gap: 0.5rem; }
  .badge { font-size: 0.7rem; padding: 2px 8px; border-radius: 10px; font-weight: 600; }
  .badge.primary { background: var(--accent); color: #fff; }
  .badge.optional { background: var(--border); color: var(--muted); }
  .field { margin-bottom: 1rem; }
  .field label { display: block; font-size: 0.85rem; color: var(--muted); margin-bottom: 4px; }
  .key-row { display: flex; gap: 8px; }
  .key-row input { flex: 1; }
  input, select { width: 100%; padding: 8px 12px; background: var(--bg); border: 1px solid var(--border);
                  border-radius: 4px; color: var(--text); font-size: 0.9rem; font-family: monospace; }
  input:focus, select:focus { outline: none; border-color: var(--accent); }
  button { padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer;
           font-size: 0.85rem; font-weight: 500; transition: opacity 0.15s; }
  button:hover { opacity: 0.85; }
  .btn-reveal { background: var(--border); color: var(--text); min-width: 70px; }
  .btn-test { background: var(--border); color: var(--ok); }
  .btn-save { background: var(--accent); color: #fff; padding: 12px 32px; font-size: 1rem;
              width: 100%; margin-top: 1rem; }
  .status { font-size: 0.8rem; margin-top: 6px; min-height: 1.2em; }
  .status.ok { color: var(--ok); }
  .status.err { color: var(--err); }
  .status.pending { color: var(--warn); }
  .model-section { margin-top: 1.5rem; }
  .model-section select { margin-top: 0.3rem; }
  .result-banner { padding: 1rem; border-radius: 6px; text-align: center; margin-top: 1rem;
                   font-weight: 500; display: none; }
  .result-banner.ok { display: block; background: rgba(78,204,163,0.15); color: var(--ok);
                      border: 1px solid var(--ok); }
  .result-banner.err { display: block; background: rgba(233,69,96,0.15); color: var(--err);
                       border: 1px solid var(--err); }
  .env-hint { font-size: 0.75rem; color: var(--muted); margin-top: 4px; font-family: monospace; }
  .btn-getkey { background: transparent; color: var(--accent); border: 1px solid var(--accent);
                font-size: 0.75rem; padding: 2px 10px; margin-left: auto; }
  .help-panel { display: none; margin-top: 1rem; padding: 1rem; background: var(--bg);
                border: 1px solid var(--border); border-radius: 6px; font-size: 0.85rem; line-height: 1.6; }
  .help-panel.open { display: block; }
  .help-panel h3 { font-size: 0.95rem; margin-bottom: 0.5rem; color: var(--accent); }
  .help-panel ol { padding-left: 1.3rem; margin: 0.5rem 0; }
  .help-panel li { margin-bottom: 0.4rem; }
  .help-panel a { color: var(--ok); text-decoration: none; }
  .help-panel a:hover { text-decoration: underline; }
  .help-panel code { background: var(--surface); padding: 1px 6px; border-radius: 3px; font-size: 0.85em; }
  .help-panel .tier { display: inline-block; font-size: 0.7rem; padding: 1px 6px; border-radius: 8px;
                      margin-left: 6px; vertical-align: middle; }
  .tier.free { background: var(--ok); color: #000; }
  .tier.paid { background: var(--warn); color: #000; }
</style>
</head>
<body>
<h1>AI Triad &mdash; Backend Configuration</h1>
<p class="subtitle">Configure API keys and default model. Keys are validated live before saving.</p>

<div class="card">
  <h2>Google Gemini <span class="badge primary">Primary</span>
    <button class="btn-getkey" onclick="toggleHelp('gemini-help')">Get Key</button></h2>
  <div class="field">
    <label>API Key</label>
    <div class="key-row">
      <input id="gemini-key" type="password" placeholder="Enter Gemini API key..." autocomplete="off">
      <button class="btn-reveal" onclick="toggleReveal('gemini-key', this)">Show</button>
      <button class="btn-test" onclick="testKey('gemini')">Test</button>
    </div>
    <div class="env-hint">GEMINI_API_KEY</div>
    <div id="gemini-status" class="status"></div>
  </div>
  <div id="gemini-help" class="help-panel">
    <h3>How to get a Gemini API key <span class="tier free">Free tier available</span></h3>
    <ol>
      <li>Go to <a href="https://aistudio.google.com/apikey" target="_blank">Google AI Studio</a></li>
      <li>Sign in with your Google account</li>
      <li>Click <strong>Create API Key</strong></li>
      <li>Select or create a Google Cloud project</li>
      <li>Copy the generated key and paste it above</li>
    </ol>
    <p>The free tier includes generous rate limits for <code>gemini-3.5-flash-lite</code> and
       <code>gemini-3.5-flash-lite</code>. The <code>gemini-2.5-pro</code> model
       requires a paid plan for higher usage.</p>
    <p><strong>Models available:</strong> Gemini 3.1 Flash Lite (fastest, cheapest),
       Gemini 2.5 Flash (balanced), Gemini 2.5 Flash Lite, Gemini 2.5 Pro (most capable).</p>
  </div>
</div>

<div class="card">
  <h2>Anthropic Claude <span class="badge optional">Optional</span>
    <button class="btn-getkey" onclick="toggleHelp('anthropic-help')">Get Key</button></h2>
  <div class="field">
    <label>API Key</label>
    <div class="key-row">
      <input id="anthropic-key" type="password" placeholder="Enter Anthropic API key..." autocomplete="off">
      <button class="btn-reveal" onclick="toggleReveal('anthropic-key', this)">Show</button>
      <button class="btn-test" onclick="testKey('anthropic')">Test</button>
    </div>
    <div class="env-hint">ANTHROPIC_API_KEY</div>
    <div id="anthropic-status" class="status"></div>
  </div>
  <div id="anthropic-help" class="help-panel">
    <h3>How to get an Anthropic API key <span class="tier paid">Paid</span></h3>
    <ol>
      <li>Go to <a href="https://console.anthropic.com/" target="_blank">Anthropic Console</a></li>
      <li>Create an account or sign in</li>
      <li>Navigate to <strong>Settings &rarr; API Keys</strong></li>
      <li>Click <strong>Create Key</strong>, give it a name</li>
      <li>Copy the key immediately (it won't be shown again) and paste it above</li>
    </ol>
    <p>Anthropic requires a credit card and charges per token. New accounts receive a
       small free credit. Keys start with <code>sk-ant-</code>.</p>
    <p><strong>Models available:</strong> Claude Opus 4 (most capable, expensive),
       Claude Sonnet 4.5 (balanced), Claude Haiku 3.5 (fastest, cheapest).</p>
  </div>
</div>

<div class="card">
  <h2>Groq <span class="badge optional">Optional</span>
    <button class="btn-getkey" onclick="toggleHelp('groq-help')">Get Key</button></h2>
  <div class="field">
    <label>API Key</label>
    <div class="key-row">
      <input id="groq-key" type="password" placeholder="Enter Groq API key..." autocomplete="off">
      <button class="btn-reveal" onclick="toggleReveal('groq-key', this)">Show</button>
      <button class="btn-test" onclick="testKey('groq')">Test</button>
    </div>
    <div class="env-hint">GROQ_API_KEY</div>
    <div id="groq-status" class="status"></div>
  </div>
  <div id="groq-help" class="help-panel">
    <h3>How to get a Groq API key <span class="tier free">Free tier available</span></h3>
    <ol>
      <li>Go to <a href="https://console.groq.com/keys" target="_blank">Groq Console</a></li>
      <li>Create an account or sign in</li>
      <li>Click <strong>Create API Key</strong></li>
      <li>Give it a name, copy the key, and paste it above</li>
    </ol>
    <p>Groq offers a free tier with rate limits. Groq runs open-source models on custom
       LPU hardware for very fast inference. Keys start with <code>gsk_</code>.</p>
    <p><strong>Models available:</strong> Llama 3.3 70B (versatile, good quality),
       Llama 4 Scout (newer, efficient). Both are open-source Meta models.</p>
  </div>
</div>

<div class="card">
  <h2>OpenAI <span class="badge optional">Optional</span>
    <button class="btn-getkey" onclick="toggleHelp('openai-help')">Get Key</button></h2>
  <div class="field">
    <label>API Key</label>
    <div class="key-row">
      <input id="openai-key" type="password" placeholder="Enter OpenAI API key..." autocomplete="off">
      <button class="btn-reveal" onclick="toggleReveal('openai-key', this)">Show</button>
      <button class="btn-test" onclick="testKey('openai')">Test</button>
    </div>
    <div class="env-hint">OPENAI_API_KEY</div>
    <div id="openai-status" class="status"></div>
  </div>
  <div id="openai-help" class="help-panel">
    <h3>How to get an OpenAI API key</h3>
    <ol>
      <li>Go to <a href="https://platform.openai.com/api-keys" target="_blank">OpenAI Platform</a></li>
      <li>Sign in or create an account</li>
      <li>Click <strong>Create new secret key</strong></li>
      <li>Copy the key and paste it above</li>
    </ol>
    <p>OpenAI requires a paid account with billing enabled. Keys start with <code>sk-</code>.</p>
    <p><strong>Models available:</strong> GPT-5.5 (balanced), GPT-5.5 Pro (most capable).</p>
  </div>
</div>

<div class="card">
  <h2>z.ai (GLM-5.2) <span class="badge optional">Optional</span>
    <button class="btn-getkey" onclick="toggleHelp('zai-help')">Setup</button></h2>
  <div class="field">
    <label>API Key</label>
    <div class="key-row">
      <input id="zai-key" type="password" placeholder="Enter your z.ai API key" autocomplete="off">
      <button class="btn-test" onclick="testKey('zai')">Test</button>
    </div>
    <div class="env-hint">ZAI_API_KEY</div>
    <div id="zai-status" class="status"></div>
  </div>
  <div id="zai-help" class="help-panel">
    <h3>How to get a z.ai API key</h3>
    <ol>
      <li>Go to <a href="https://z.ai/manage-apikey/apikey-list" target="_blank">z.ai API key management</a></li>
      <li>Sign in or create an account</li>
      <li>Create a new key and paste it above</li>
    </ol>
    <p>GLM exposes an OpenAI-compatible chat/completions endpoint with a
       <strong>1M-token context window</strong> — the largest of any registered backend.</p>
    <p><strong>Models available:</strong> GLM-5.3 (id: <code>zai-glm-5-3</code>), GLM-5.3 Flash (id: <code>zai-glm-5-3-flash</code>).</p>
  </div>
</div>

<div class="card">
  <h2>Ollama (Local) <span class="badge optional">Optional</span>
    <button class="btn-getkey" onclick="toggleHelp('ollama-help')">Setup</button></h2>
  <div class="field">
    <label>Base URL</label>
    <div class="key-row">
      <input id="ollama-url" type="text" placeholder="http://localhost:11434" autocomplete="off">
      <button class="btn-test" onclick="testKey('ollama')">Test</button>
    </div>
    <div class="env-hint">OLLAMA_BASE_URL (leave blank for http://localhost:11434)</div>
    <div id="ollama-status" class="status"></div>
  </div>
  <div id="ollama-help" class="help-panel">
    <h3>How to set up Ollama <span class="tier free">Free / Local</span></h3>
    <ol>
      <li>Download and install <a href="https://ollama.com" target="_blank">Ollama</a></li>
      <li>Run <code>ollama serve</code> to start the server (default: port 11434)</li>
      <li>Pull a model: <code>ollama pull gemma4:e4b-it-q4_K_M</code></li>
      <li>Click <strong>Test</strong> above to verify the connection</li>
    </ol>
    <p>Ollama runs models locally on your machine &mdash; no API key or cloud account needed.
       Leave the URL blank to use the default (<code>http://localhost:11434</code>).</p>
    <p><strong>Models available:</strong> Any model pulled into Ollama. The default for AI Triad
       is <code>gemma4:e4b-it-q4_K_M</code> (8B parameters, quantized).</p>
  </div>
</div>

<div class="card model-section">
  <h2>Default Model</h2>
  <div class="field">
    <label>Used when no -Model parameter is specified</label>
    <select id="ai-model"></select>
    <div class="env-hint">AI_MODEL (leave blank for gemini-3.5-flash-lite)</div>
  </div>
</div>

<button class="btn-save" onclick="save()">Save Configuration</button>
<div id="result-banner" class="result-banner"></div>

<script>
const state = $InitialState;
const models = $ModelsJson;
const TOKEN = '$Token';

// Populate fields
function init() {
  document.getElementById('gemini-key').value = state.gemini_masked || '';
  document.getElementById('anthropic-key').value = state.anthropic_masked || '';
  document.getElementById('groq-key').value = state.groq_masked || '';
  document.getElementById('openai-key').value = state.openai_masked || '';
  document.getElementById('ollama-url').value = state.ollama_url || '';
  document.getElementById('zai-key').value = state.zai_masked || '';

  // Track whether field has been edited (vs showing mask)
  document.getElementById('gemini-key').dataset.dirty = 'false';
  document.getElementById('anthropic-key').dataset.dirty = 'false';
  document.getElementById('groq-key').dataset.dirty = 'false';
  document.getElementById('openai-key').dataset.dirty = 'false';
  document.getElementById('ollama-url').dataset.dirty = 'false';
  document.getElementById('zai-key').dataset.dirty = 'false';

  ['gemini-key','anthropic-key','groq-key','openai-key','ollama-url','zai-key'].forEach(id => {
    document.getElementById(id).addEventListener('input', () => {
      document.getElementById(id).dataset.dirty = 'true';
    });
  });

  const sel = document.getElementById('ai-model');
  sel.innerHTML = '<option value="">(default: gemini-3.5-flash-lite)</option>';
  models.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label + ' [' + m.backend + ']';
    if (state.ai_model === m.id) opt.selected = true;
    sel.appendChild(opt);
  });
}

function toggleHelp(panelId) {
  const panel = document.getElementById(panelId);
  panel.classList.toggle('open');
}

function toggleReveal(inputId, btn) {
  const inp = document.getElementById(inputId);
  if (inp.type === 'password') {
    // If not dirty, show the real key
    if (inp.dataset.dirty === 'false') {
      const backendMap = { 'gemini-key': 'gemini', 'anthropic-key': 'anthropic', 'groq-key': 'groq', 'openai-key': 'openai' };
      const backend = backendMap[inputId];
      fetch('/api/reveal?backend=' + backend, { headers: { 'Authorization': 'Bearer ' + TOKEN } })
        .then(r => r.json())
        .then(d => {
          if (d.key) { inp.value = d.key; inp.dataset.dirty = 'false'; }
          inp.type = 'text';
          btn.textContent = 'Hide';
        });
      return;
    }
    inp.type = 'text';
    btn.textContent = 'Hide';
  } else {
    inp.type = 'password';
    btn.textContent = 'Show';
  }
}

function setStatus(id, cls, msg) {
  const el = document.getElementById(id + '-status');
  el.className = 'status ' + cls;
  el.textContent = msg;
}

function testKey(backend) {
  const inputMap = { gemini: 'gemini-key', anthropic: 'anthropic-key', groq: 'groq-key', openai: 'openai-key', ollama: 'ollama-url', zai: 'zai-key' };
  const inp = document.getElementById(inputMap[backend]);
  const key = inp.dataset.dirty === 'true' ? inp.value : '';

  setStatus(backend, 'pending', 'Testing...');
  fetch('/api/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOKEN },
    body: JSON.stringify({ backend, key })
  })
  .then(r => r.json())
  .then(d => {
    if (d.ok) setStatus(backend, 'ok', d.message);
    else setStatus(backend, 'err', d.message);
  })
  .catch(e => setStatus(backend, 'err', 'Request failed: ' + e.message));
}

function save() {
  const data = {
    gemini_key: document.getElementById('gemini-key').dataset.dirty === 'true'
      ? document.getElementById('gemini-key').value : null,
    anthropic_key: document.getElementById('anthropic-key').dataset.dirty === 'true'
      ? document.getElementById('anthropic-key').value : null,
    groq_key: document.getElementById('groq-key').dataset.dirty === 'true'
      ? document.getElementById('groq-key').value : null,
    openai_key: document.getElementById('openai-key').dataset.dirty === 'true'
      ? document.getElementById('openai-key').value : null,
    ollama_url: document.getElementById('ollama-url').dataset.dirty === 'true'
      ? document.getElementById('ollama-url').value : null,
    zai_key: document.getElementById('zai-key').dataset.dirty === 'true'
      ? document.getElementById('zai-key').value : null,
    ai_model: document.getElementById('ai-model').value
  };

  const banner = document.getElementById('result-banner');
  banner.className = 'result-banner';
  banner.style.display = 'none';

  fetch('/api/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOKEN },
    body: JSON.stringify(data)
  })
  .then(r => r.json())
  .then(d => {
    if (d.ok) {
      banner.className = 'result-banner ok';
      banner.textContent = d.message;
      banner.style.display = 'block';
    } else {
      banner.className = 'result-banner err';
      banner.textContent = d.message;
      banner.style.display = 'block';
    }
  })
  .catch(e => {
    banner.className = 'result-banner err';
    banner.textContent = 'Save failed: ' + e.message;
    banner.style.display = 'block';
  });
}

init();
</script>
</body>
</html>
"@

    # ── HTTP Server ───────────────────────────────────────────────────────────
    # Bound to 127.0.0.1 only — never '+', '*', or 'localhost' (which can bind
    # dual-stack or be remapped via the hosts file). t/2527 loopback-only binding.
    $Listener = [System.Net.HttpListener]::new()
    $Prefix   = "http://127.0.0.1:$Port/"
    $Listener.Prefixes.Add($Prefix)

    try {
        $Listener.Start()
    }
    catch {
        # t/3857: this used to Write-Fail + bare `return` -- never rethrow, so a failure to bind
        # the config UI's port was indistinguishable from the UI having started successfully. No
        # internal caller relies on this today, but a silent $null on failure is a trap for the
        # next one.
        throw (New-ActionableError `
                -Goal 'Open the AI backend configuration UI' `
                -Problem "Could not start HTTP listener on port ${Port}: $($_.Exception.Message)" `
                -Location 'Register-AIBackend' `
                -NextSteps 'Try a different port with -Port or close the process using that port.')
    }

    Write-Step 'AI Backend Configuration'
    Write-OK "Configuration UI running at $Prefix"
    Write-Info 'Press Ctrl+C to close when done.'

    # Open browser with one-time token in URL (token-in-URL is an accepted risk for
    # ephemeral localhost servers — same pattern as Jupyter Notebook; t/2527).
    $BrowserUrl = "http://127.0.0.1:$Port/?token=$Token"
    if (-not $NoBrowser) {
        if ($IsMacOS)     { Start-Process 'open' -ArgumentList $BrowserUrl }
        elseif ($IsLinux) { Start-Process 'xdg-open' -ArgumentList $BrowserUrl -ErrorAction SilentlyContinue }
        else              { Start-Process $BrowserUrl }
    }

    # ── Auth helpers (t/2527) ─────────────────────────────────────────────────
    function Test-OriginAndHost {
        param($Req)
        $H = $Req.Headers['Host']
        if ($H -ne $ExpectedHost) { return 'forbidden' }
        $O = $Req.Headers['Origin']
        if ($O -and $O -ne $ExpectedOrigin) { return 'forbidden' }
        return 'ok'
    }

    function Test-BearerToken {
        param($Req)
        $Auth = $Req.Headers['Authorization']
        if (-not $Auth -or -not $Auth.StartsWith('Bearer ')) { return $false }
        $Submitted = $Auth.Substring(7)
        $T = [System.Text.Encoding]::UTF8.GetBytes($Token)
        $S = [System.Text.Encoding]::UTF8.GetBytes($Submitted)
        return [System.Security.Cryptography.CryptographicOperations]::FixedTimeEquals($T, $S)
    }

    function Send-Unauthorized {
        param($Resp)
        $Resp.StatusCode = 401
        $B = [System.Text.Encoding]::UTF8.GetBytes('{"error":"Unauthorized"}')
        $Resp.ContentType = 'application/json'
        $Resp.ContentLength64 = $B.Length
        $Resp.OutputStream.Write($B, 0, $B.Length)
    }

    function Send-Forbidden {
        param($Resp)
        $Resp.StatusCode = 403
        $B = [System.Text.Encoding]::UTF8.GetBytes('{"error":"Forbidden"}')
        $Resp.ContentType = 'application/json'
        $Resp.ContentLength64 = $B.Length
        $Resp.OutputStream.Write($B, 0, $B.Length)
    }

    $ServerRunning = $true

    try {
        while ($ServerRunning -and $Listener.IsListening) {
            $ContextTask = $Listener.GetContextAsync()

            # Poll so Ctrl+C can interrupt
            while (-not $ContextTask.IsCompleted) {
                Start-Sleep -Milliseconds 100
            }

            $Context  = $ContextTask.Result
            $Request  = $Context.Request
            $Response = $Context.Response

            $Path   = $Request.Url.AbsolutePath
            $Method = $Request.HttpMethod

            try {
                switch ("$Method $Path") {

                    'GET /' {
                        # Validate ?token= (browser nav — no Bearer header available on initial load)
                        $QToken = ''
                        $Q = $Request.Url.Query
                        if ($Q -match '[?&]token=([^&]+)') { $QToken = [Uri]::UnescapeDataString($Matches[1]) }
                        $TBytes  = [System.Text.Encoding]::UTF8.GetBytes($Token)
                        $QTBytes = [System.Text.Encoding]::UTF8.GetBytes($QToken)
                        if (-not [System.Security.Cryptography.CryptographicOperations]::FixedTimeEquals($TBytes, $QTBytes)) {
                            Send-Unauthorized $Response; break
                        }
                        $ReqHost = $Request.Headers['Host']
                        if ($ReqHost -ne $ExpectedHost) { Send-Forbidden $Response; break }
                        $Buffer = [System.Text.Encoding]::UTF8.GetBytes($Html)
                        $Response.ContentType = 'text/html; charset=utf-8'
                        $Response.ContentLength64 = $Buffer.Length
                        $Response.OutputStream.Write($Buffer, 0, $Buffer.Length)
                    }

                    'GET /api/reveal' {
                        if ((Test-OriginAndHost $Request) -eq 'forbidden') { Send-Forbidden $Response; break }
                        if (-not (Test-BearerToken $Request)) { Send-Unauthorized $Response; break }
                        $Query   = $Request.Url.Query
                        if ($Query -match 'backend=(\w+)') { $Backend = $Matches[1] } else { $Backend = '' }
                        $KeyMap  = @{ gemini = 'GEMINI_API_KEY'; anthropic = 'ANTHROPIC_API_KEY'; groq = 'GROQ_API_KEY'; openai = 'OPENAI_API_KEY'; ollama = 'OLLAMA_BASE_URL'; zai = 'ZAI_API_KEY' }
                        $RealKey = ''
                        if ($KeyMap.ContainsKey($Backend)) {
                            $RealKey = $Persisted[$KeyMap[$Backend]]
                        }
                        $Json = @{ key = $RealKey } | ConvertTo-Json -Compress
                        $Buffer = [System.Text.Encoding]::UTF8.GetBytes($Json)
                        $Response.ContentType = 'application/json'
                        $Response.ContentLength64 = $Buffer.Length
                        $Response.OutputStream.Write($Buffer, 0, $Buffer.Length)
                    }

                    'POST /api/test' {
                        if ((Test-OriginAndHost $Request) -eq 'forbidden') { Send-Forbidden $Response; break }
                        if (-not (Test-BearerToken $Request)) { Send-Unauthorized $Response; break }
                        $Reader = [System.IO.StreamReader]::new($Request.InputStream)
                        $Body   = $Reader.ReadToEnd() | ConvertFrom-Json
                        $Reader.Close()

                        $TestBackend = $Body.backend
                        $TestKey     = $Body.key
                        # If no key provided (not dirty), use persisted
                        if ([string]::IsNullOrWhiteSpace($TestKey)) {
                            $KeyMap  = @{ gemini = 'GEMINI_API_KEY'; anthropic = 'ANTHROPIC_API_KEY'; groq = 'GROQ_API_KEY'; openai = 'OPENAI_API_KEY'; ollama = 'OLLAMA_BASE_URL'; zai = 'ZAI_API_KEY' }
                            if ($KeyMap.ContainsKey($TestBackend)) {
                                $TestKey = $Persisted[$KeyMap[$TestBackend]]
                            }
                        }

                        $TestResult = @{ ok = $false; message = 'No key provided' }

                        # Ollama uses a base URL, not an API key — default to localhost
                        if ($TestBackend -eq 'ollama') {
                            $OllamaUrl = if ([string]::IsNullOrWhiteSpace($TestKey)) { 'http://localhost:11434' } else { $TestKey.TrimEnd('/') }
                            try {
                                $R = Invoke-RestMethod -Uri "$OllamaUrl/api/tags" -Method Get -TimeoutSec 10 -ErrorAction Stop
                                $ModelCount = @($R.models).Count
                                $TestResult = @{ ok = $true; message = "Connected — $ModelCount model(s) available" }
                            }
                            catch {
                                $TestResult = @{ ok = $false; message = "Cannot reach Ollama at $OllamaUrl — $($_.Exception.Message)" }
                            }
                        }
                        elseif (-not [string]::IsNullOrWhiteSpace($TestKey)) {
                            try {
                                switch ($TestBackend) {
                                    'gemini' {
                                        # Key in x-goog-api-key header, not ?key= URL (t/2530 L1).
                                        $Uri = 'https://generativelanguage.googleapis.com/v1beta/models'
                                        $R = Invoke-RestMethod -Uri $Uri -Method Get -Headers @{ 'x-goog-api-key' = $TestKey } -TimeoutSec 10 -ErrorAction Stop
                                        $TestResult = @{ ok = $true; message = "Valid — $(@($R.models).Count) models available" }
                                    }
                                    'anthropic' {
                                        $Hdrs = @{
                                            'x-api-key'         = $TestKey
                                            'anthropic-version' = '2023-06-01'
                                            'content-type'      = 'application/json'
                                        }
                                        $Payload = @{
                                            model      = 'claude-3-5-haiku-20241022'  # model-lint:allow-pin raw Anthropic API liveness-probe id, intentionally not a registry backend
                                            max_tokens = 10
                                            messages   = @(@{ role = 'user'; content = 'Say OK' })
                                        } | ConvertTo-Json -Depth 5
                                        $null = Invoke-RestMethod -Uri 'https://api.anthropic.com/v1/messages' `
                                            -Method Post -Headers $Hdrs -Body $Payload -TimeoutSec 15 -ErrorAction Stop
                                        $TestResult = @{ ok = $true; message = 'Valid — API responded successfully' }
                                    }
                                    'groq' {
                                        $Hdrs = @{
                                            'Authorization' = "Bearer $TestKey"
                                            'Content-Type'  = 'application/json'
                                        }
                                        $R = Invoke-RestMethod -Uri 'https://api.groq.com/openai/v1/models' `
                                            -Method Get -Headers $Hdrs -TimeoutSec 10 -ErrorAction Stop
                                        $TestResult = @{ ok = $true; message = "Valid — $(@($R.data).Count) models available" }
                                    }
                                    'openai' {
                                        $Hdrs = @{
                                            'Authorization' = "Bearer $TestKey"
                                            'Content-Type'  = 'application/json'
                                        }
                                        $R = Invoke-RestMethod -Uri 'https://api.openai.com/v1/models' `
                                            -Method Get -Headers $Hdrs -TimeoutSec 10 -ErrorAction Stop
                                        $TestResult = @{ ok = $true; message = "Valid — $(@($R.data).Count) models available" }
                                    }
                                    'zai' {
                                        $Hdrs = @{
                                            'Authorization' = "Bearer $TestKey"
                                            'Content-Type'  = 'application/json'
                                        }
                                        # t/1437 — z.ai's OpenAI-compatible surface may not expose /v1/models,
                                        # so probe a minimal chat completion (cheap: 5 max tokens).
                                        $Payload = @{
                                            model       = 'glm-5.2'  # model-lint:allow-pin raw ZAI provider model id (registry id: zai-glm-5-2)
                                            messages    = @(@{ role = 'user'; content = 'ping' })
                                            max_tokens  = 5
                                            temperature = 0.0
                                        } | ConvertTo-Json -Depth 5
                                        $null = Invoke-RestMethod -Uri 'https://api.z.ai/api/paas/v4/chat/completions' `
                                            -Method Post -Headers $Hdrs -Body $Payload -TimeoutSec 15 -ErrorAction Stop
                                        $TestResult = @{ ok = $true; message = 'Valid — API responded successfully' }
                                    }
                                    default {
                                        $TestResult = @{ ok = $false; message = "Unknown backend: $TestBackend" }
                                    }
                                }
                            }
                            catch {
                                $StatusCode = $_.Exception.Response.StatusCode.value__
                                if ($StatusCode -eq 401 -or $StatusCode -eq 403) {
                                    $TestResult = @{ ok = $false; message = "Invalid key (HTTP $StatusCode)" }
                                }
                                else {
                                    $TestResult = @{ ok = $false; message = "API error: $($_.Exception.Message)" }
                                }
                            }
                        }

                        $Json = $TestResult | ConvertTo-Json -Compress
                        $Buffer = [System.Text.Encoding]::UTF8.GetBytes($Json)
                        $Response.ContentType = 'application/json'
                        $Response.ContentLength64 = $Buffer.Length
                        $Response.OutputStream.Write($Buffer, 0, $Buffer.Length)
                    }

                    'POST /api/save' {
                        if ((Test-OriginAndHost $Request) -eq 'forbidden') { Send-Forbidden $Response; break }
                        if (-not (Test-BearerToken $Request)) { Send-Unauthorized $Response; break }
                        $Reader = [System.IO.StreamReader]::new($Request.InputStream)
                        $Body   = $Reader.ReadToEnd() | ConvertFrom-Json
                        $Reader.Close()

                        $SaveResult = @{ ok = $true; message = '' }
                        $Changes    = [System.Collections.Generic.List[string]]::new()

                        try {
                            # Update keys (null = not changed, empty string = clear, value = set)
                            $KeyMap = [ordered]@{
                                gemini_key    = 'GEMINI_API_KEY'
                                anthropic_key = 'ANTHROPIC_API_KEY'
                                groq_key      = 'GROQ_API_KEY'
                                openai_key    = 'OPENAI_API_KEY'
                                ollama_url    = 'OLLAMA_BASE_URL'
                                zai_key       = 'ZAI_API_KEY'
                            }

                            foreach ($Field in $KeyMap.Keys) {
                                $EnvName = $KeyMap[$Field]
                                $NewVal  = $Body.$Field
                                if ($null -eq $NewVal) { continue }  # Not changed

                                if ([string]::IsNullOrWhiteSpace($NewVal)) {
                                    # Clear
                                    $Persisted[$EnvName] = ''
                                    [Environment]::SetEnvironmentVariable($EnvName, $null)
                                    $Changes.Add("Cleared $EnvName")
                                }
                                else {
                                    $Persisted[$EnvName] = $NewVal
                                    [Environment]::SetEnvironmentVariable($EnvName, $NewVal)
                                    $Changes.Add("Set $EnvName")
                                }
                            }

                            # Model
                            $ModelVal = $Body.ai_model
                            if ($null -ne $ModelVal) {
                                $Persisted['AI_MODEL'] = $ModelVal
                                if ([string]::IsNullOrWhiteSpace($ModelVal)) {
                                    [Environment]::SetEnvironmentVariable('AI_MODEL', $null)
                                }
                                else {
                                    [Environment]::SetEnvironmentVariable('AI_MODEL', $ModelVal)
                                    $Changes.Add("Set AI_MODEL=$ModelVal")
                                }
                            }

                            # Persist to ~/.aitriad-env
                            $EnvLines = [System.Collections.Generic.List[string]]::new()
                            $EnvLines.Add('# AI Triad Research — backend configuration')
                            $EnvLines.Add("# Generated by Register-AIBackend on $(Get-Date -Format 'yyyy-MM-dd HH:mm')")
                            $EnvLines.Add('')

                            # bash/zsh section
                            $EnvLines.Add('# bash/zsh — source this file from ~/.bashrc or ~/.zshrc')
                            foreach ($Key in @('GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'GROQ_API_KEY', 'OPENAI_API_KEY', 'OLLAMA_BASE_URL', 'ZAI_API_KEY', 'AI_MODEL')) {
                                $Val = $Persisted[$Key]
                                if (-not [string]::IsNullOrWhiteSpace($Val)) {
                                    $EnvLines.Add("export $Key=`"$Val`"")
                                }
                            }

                            $EnvLines.Add('')
                            $EnvLines.Add('# PowerShell — dot-source this file from `$PROFILE')
                            $EnvLines.Add('# powershell_section_start')
                            foreach ($Key in @('GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'GROQ_API_KEY', 'OPENAI_API_KEY', 'OLLAMA_BASE_URL', 'ZAI_API_KEY', 'AI_MODEL')) {
                                $Val = $Persisted[$Key]
                                if (-not [string]::IsNullOrWhiteSpace($Val)) {
                                    $EscapedVal = $Val -replace "'", "''"
                                    $EnvLines.Add("`$env:$Key = '$EscapedVal'")
                                }
                            }
                            $EnvLines.Add('# powershell_section_end')

                            Write-Utf8NoBom -Path $EnvFilePath -Value ($EnvLines -join "`n")  -Force
                            # Persisted keys are secrets — restrict to the current user (t/2530 M1).
                            Protect-UserSecretFile -Path $EnvFilePath

                            if ($Changes.Count -gt 0) {
                                $SaveResult.message = "Saved: $($Changes -join ', '). Persisted to $EnvFilePath"
                            }
                            else {
                                $SaveResult.message = "No changes to save."
                            }
                        }
                        catch {
                            $SaveResult = @{ ok = $false; message = "Save failed: $($_.Exception.Message)" }
                        }

                        $Json = $SaveResult | ConvertTo-Json -Compress
                        $Buffer = [System.Text.Encoding]::UTF8.GetBytes($Json)
                        $Response.ContentType = 'application/json'
                        $Response.ContentLength64 = $Buffer.Length
                        $Response.OutputStream.Write($Buffer, 0, $Buffer.Length)

                        if ($SaveResult.ok -and $Changes.Count -gt 0) {
                            Write-OK $SaveResult.message
                        }
                    }

                    default {
                        $Response.StatusCode = 404
                        $Buffer = [System.Text.Encoding]::UTF8.GetBytes('Not Found')
                        $Response.ContentLength64 = $Buffer.Length
                        $Response.OutputStream.Write($Buffer, 0, $Buffer.Length)
                    }
                }
            }
            catch {
                Write-Warning "Request error on $Path — $($_.Exception.Message)"
                try {
                    $Response.StatusCode = 500
                    $ErrBytes = [System.Text.Encoding]::UTF8.GetBytes('Internal Server Error')
                    $Response.ContentLength64 = $ErrBytes.Length
                    $Response.OutputStream.Write($ErrBytes, 0, $ErrBytes.Length)
                } catch { }
            }
            finally {
                try { $Response.OutputStream.Close() } catch { }
            }
        }
    }
    catch [System.OperationCanceledException] {
        # Ctrl+C — graceful shutdown
    }
    finally {
        Write-Info 'Shutting down configuration server...'
        try { $Listener.Stop(); $Listener.Close() } catch { }
    }

    # ── Print sourcing instructions ───────────────────────────────────────────
    if (Test-Path $EnvFilePath) {
        Write-Host ''
        Write-OK "Configuration saved to $EnvFilePath"
        Write-Host ''
        Write-Info 'To load these settings in future sessions, add ONE of these to your shell profile:'
        Write-Host ''
        Write-Host '  # PowerShell ($PROFILE):' -ForegroundColor Gray
        Write-Host "  . $EnvFilePath" -ForegroundColor White
        Write-Host ''
        Write-Host '  # bash/zsh (~/.bashrc or ~/.zshrc):' -ForegroundColor Gray
        Write-Host "  source $EnvFilePath" -ForegroundColor White
        Write-Host ''
        Write-Info 'The file contains both shell and PowerShell formats — each ignores the other.'
        Write-Host ''
    }
}
