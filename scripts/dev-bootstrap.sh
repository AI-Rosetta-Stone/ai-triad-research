#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

DATA_DIR="../ai-triad-data"
if [ ! -d "$DATA_DIR/taxonomy" ]; then
  # Codespaces and fresh machines have no sibling data repo. The old devcontainer post-create
  # cloned it; keep doing that when the directory is absent or empty (compose creates an empty
  # mount point when the host side doesn't exist yet) and writable.
  if [ -z "$(ls -A "$DATA_DIR" 2>/dev/null)" ] && mkdir -p "$DATA_DIR" 2>/dev/null && [ -w "$DATA_DIR" ]; then
    echo "==> Sibling data repo (../ai-triad-data) missing; cloning it"
    if ! { command -v gh >/dev/null 2>&1 && gh repo clone AI-Rosetta-Stone/ai-triad-data "$DATA_DIR"; } \
       && ! git clone https://github.com/AI-Rosetta-Stone/ai-triad-data.git "$DATA_DIR"; then
      echo "==> ERROR: could not clone AI-Rosetta-Stone/ai-triad-data into $DATA_DIR." >&2
      echo "    Clone it next to this repo yourself (or set AI_TRIAD_DATA_ROOT), then re-run." >&2
      exit 1
    fi
  else
    echo "==> ERROR: sibling data repo (../ai-triad-data) is missing and the directory is not empty or not writable." >&2
    echo "    Clone AI-Rosetta-Stone/ai-triad-data next to this repo on the host, then restart the container." >&2
    exit 1
  fi
fi

# Load powershell module (and make cmdlets available), then use cmdlets
# `Get-Tax | Measure-Object` should show several hundred nodes (785 POV nodes as of 2026-07)
pwsh -c 'Import-Module ./scripts/AITriad/AITriad.psm1; Install-AIDependencies -Fix; Get-Tax | Measure-Object'

# Setting up pwsh profile to auto-import AITriad module
PROFILE_PATH="$(pwsh -NoLogo -NoProfile -c '$PROFILE')"
mkdir -p "$(dirname "$PROFILE_PATH")"
IMPORT_LINE="Import-Module './scripts/AITriad/AITriad.psm1'"
if ! grep -qF "$IMPORT_LINE" "$PROFILE_PATH" 2>/dev/null; then
  echo "$IMPORT_LINE" >>"$PROFILE_PATH"
fi

echo "==> pnpm install (offline, from warm store)"
if ! pnpm install --frozen-lockfile --offline --store-dir /pnpm/store; then
  echo "==> WARN: offline install failed (pnpm-store volume missing a package the lockfile needs), falling back to a networked install to refresh the store" >&2
  pnpm install --frozen-lockfile --store-dir /pnpm/store
fi

if [ -z "${GEMINI_API_KEY:-}${ANTHROPIC_API_KEY:-}${GROQ_API_KEY:-}${AI_API_KEY:-}" ]; then
  echo "==> No AI API key set. Set GEMINI_API_KEY (or ANTHROPIC_API_KEY/GROQ_API_KEY/AI_API_KEY)"
  echo "    in a .env file next to compose.yaml, then restart the container."
fi

echo "==> Bootstrap complete."
