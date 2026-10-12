# Container Workflow: Import Documents & Push to GitHub

This guide covers the end-to-end workflow for importing documents, generating
summaries, and pushing changes to GitHub when running the Taxonomy Editor in
Docker container mode.

## Architecture

The system uses two repositories:

| Repo | Contents | Typical Location |
|------|----------|------------------|
| **ai-triad-research** | Code, PowerShell module, apps | `~/source/repos/ai-triad-research` |
| **ai-triad-data** | Taxonomy, sources, summaries, conflicts, debates | `~/source/repos/ai-triad-data` |

In container mode, the data repo is bind-mounted into the container at `/data`.
All reads and writes inside the container go through this mount, so changes
appear immediately on the host filesystem.

```
Host                              Container
────                              ─────────
~/source/repos/ai-triad-data/ ──→ /data (bind mount, read-write)
  ├── taxonomy/Origin/              ├── taxonomy/Origin/
  ├── sources/                      ├── sources/
  ├── summaries/                    ├── summaries/
  ├── conflicts/                    ├── conflicts/
  └── debates/                      └── debates/
```

## Prerequisites

- Docker Desktop installed and running
- AITriad PowerShell module loaded (`Import-Module AITriad`)
- Data repo cloned (run `Install-AITriadData` if not)
- At least one AI API key set (`$env:GEMINI_API_KEY`, `$env:ANTHROPIC_API_KEY`,
  or `$env:GROQ_API_KEY`)

## Quick Reference

```powershell
# Launch the editor (starts container, opens browser)
Show-TaxonomyEditor

# Import a document
Import-AITriadDocument -File ~/Downloads/paper.pdf -Pov skeptic

# Summarize a document
Invoke-POVSummary -DocId paper-2026

# Push changes to GitHub
cd ~/source/repos/ai-triad-data
git add -A
git commit -m "docs: import and summarize paper-2026"
git push origin main
```

## Step-by-Step Workflow

### 1. Start the Taxonomy Editor

```powershell
Show-TaxonomyEditor
```

This:
- Starts a Docker container from `ghcr.io/ai-rosetta-stone/taxonomy-editor:latest`
- Mounts your data repo at `/data`
- Passes API keys from your environment
- Opens `http://localhost:7862` in your browser

To run in the background:

```powershell
Show-TaxonomyEditor -Detach
# ... work ...
Show-TaxonomyEditor -Stop
```

To check status: `Show-TaxonomyEditor -Status`

### 2. Import a Document

Run on your **host machine** (not inside the container):

```powershell
# From a local file
Import-AITriadDocument -File ~/Downloads/paper.pdf

# From a URL
Import-AITriadDocument -Url "https://example.com/article.html"

# With POV and topic tags
Import-AITriadDocument -File ~/Downloads/paper.pdf `
    -Pov accelerationist `
    -Topic "AI governance"
```

This creates:

```
ai-triad-data/sources/<doc-id>/
  ├── raw/              # Original file
  ├── snapshot.md        # Markdown conversion
  └── metadata.json      # Metadata (title, tags, status)
```

The document is also added to `.summarise-queue.json` for batch processing.

### 3. Summarize the Document

```powershell
# Summarize a specific document
Invoke-POVSummary -DocId <doc-id>

# Summarize all queued documents
Invoke-BatchSummary

# Force re-summarization
Invoke-POVSummary -DocId <doc-id> -Force
```

This creates/updates:
- `ai-triad-data/summaries/<doc-id>.json` - POV summaries with key points and
  factual claims
- `ai-triad-data/conflicts/*.json` - Any detected factual conflicts across
  viewpoints
- `ai-triad-data/sources/<doc-id>/metadata.json` - Updated summary status

### 4. Review in the Taxonomy Editor

With the editor running (`Show-TaxonomyEditor`), use the browser to:

- Browse imported sources and their summaries
- View and resolve detected conflicts
- Edit taxonomy nodes
- Run debates between POV agents
- Inspect and tune AI prompts

All changes are saved directly to your data repo through the bind mount.

### 5. Push Changes to GitHub

The container writes to your data repo via the bind mount. To push those
changes to GitHub, run standard git commands **on your host machine**:

```powershell
cd ~/source/repos/ai-triad-data

# Review what changed
git status
git diff --stat

# Stage and commit
git add sources/<doc-id>/
git add summaries/<doc-id>.json
git add conflicts/
git commit -m "docs: import and summarize <doc-id>"

# Push
git push origin main
```

For batch operations:

```powershell
cd ~/source/repos/ai-triad-data
git add -A
git commit -m "chore: batch import and summarize N documents"
git push origin main
```

### 6. Taxonomy Edits and Re-Summarization

When you edit the taxonomy in the editor:

1. Changes are saved to `ai-triad-data/taxonomy/Origin/*.json`
2. Commit and push the taxonomy changes:
   ```powershell
   cd ~/source/repos/ai-triad-data
   git add taxonomy/Origin/
   git commit -m "feat: add new taxonomy nodes for AI governance"
   git push origin main
   ```
3. If the taxonomy version was bumped (`TAXONOMY_VERSION` file), re-summarize
   affected documents:
   ```powershell
   Invoke-BatchSummary
   ```

## Using the Console Panel

The Taxonomy Editor includes a Console panel (PowerShell terminal) accessible
from the sidebar. Inside the container console you can run AITriad commands
directly:

```powershell
# Already loaded at startup
Import-Module '/app/scripts/AITriad/AITriad.psd1' -Force

# Run commands against /data
Get-AITSource | Format-Table Id, Title, SummaryStatus
Invoke-POVSummary -DocId <doc-id>
Get-TaxonomyHealth
```

Note: Git operations should be done on the **host**, not inside the container,
since the container's read-only filesystem doesn't include git credentials.

## Troubleshooting

### Port already in use

```
Failed to start container (exit code 125).
Port 7862 is already in use.
```

Fix:
```powershell
# Find what's using the port
docker ps
# Stop the old container
docker stop <container-id>
# Or use a different port
Show-TaxonomyEditor -Port 8080
```

### Container won't start (stale container)

```
A container named 'aitriad-editor-7862' already exists.
```

Fix:
```powershell
docker rm aitriad-editor-7862
Show-TaxonomyEditor
```

### Data not visible in the editor

Verify the data path:
```powershell
# Check what path is being mounted
Show-TaxonomyEditor -Status

# Override the data path explicitly
Show-TaxonomyEditor -DataPath ~/source/repos/ai-triad-data
```

### Update the container image

```powershell
Show-TaxonomyEditor -Pull
```

## Available Commands

| Command | Purpose |
|---------|---------|
| `Show-TaxonomyEditor` | Launch editor (container or Electron) |
| `Import-AITriadDocument` | Ingest PDF/URL/DOCX into sources/ |
| `Invoke-POVSummary` | AI-summarize a single document |
| `Invoke-BatchSummary` | Re-summarize all queued or stale documents |
| `Invoke-QbafConflictAnalysis` | QBAF-enhanced conflict detection |
| `Get-AITSource` | List/inspect imported sources |
| `Get-Summary` | Retrieve a summary object |
| `Get-TaxonomyHealth` | Coverage gaps and quality metrics |
| `Install-AITriadData` | Clone or update the data repo |
| `Test-TaxonomyIntegrity` | Validate taxonomy JSON files |
