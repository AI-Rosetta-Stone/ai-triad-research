#!/usr/bin/env bash
# Codespaces post-create: install system deps, clone sibling data repo, npm ci for each app.
set -euo pipefail

echo "==> apt deps (pandoc for DocConverters)"
sudo apt-get update
sudo apt-get install -y --no-install-recommends pandoc ghostscript

echo "==> Python deps (sentence-transformers for embeddings)"
pip install --no-cache-dir --upgrade pip
pip install --no-cache-dir sentence-transformers numpy

echo "==> Clone sibling data repo (../ai-triad-data) if missing"
cd "$(dirname "$0")/.."
if [ ! -d "../ai-triad-data" ]; then
  # Prefer gh auth so private-repo access works if applicable
  if command -v gh >/dev/null 2>&1; then
    gh repo clone AI-Rosetta-Stone/ai-triad-data ../ai-triad-data || \
      git clone https://github.com/AI-Rosetta-Stone/ai-triad-data.git ../ai-triad-data || \
      echo "WARN: could not clone ai-triad-data — set AI_TRIAD_DATA_ROOT manually"
  else
    git clone https://github.com/AI-Rosetta-Stone/ai-triad-data.git ../ai-triad-data || \
      echo "WARN: could not clone ai-triad-data — set AI_TRIAD_DATA_ROOT manually"
  fi
fi

for app in taxonomy-editor poviewer summary-viewer; do
  if [ -f "$app/package.json" ]; then
    echo "==> npm ci in $app"
    (cd "$app" && npm ci)
  fi
done

echo "==> Done."
echo ""
echo "Taxonomy-editor in the browser (data-backed, with hot reload):"
echo "    cd taxonomy-editor && npm run dev:container"
echo "    # serves API on :7862, Vite (proxied) on :5173 — open 5173"
echo ""
echo "Other Vite apps (static, no data API):"
echo "    cd poviewer       && npm run dev:vite     # port 5174"
echo "    cd summary-viewer && npm run dev:vite     # port 5175"
