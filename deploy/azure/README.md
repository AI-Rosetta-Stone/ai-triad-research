# Azure Deployment — Taxonomy Editor

Deploy the Taxonomy Editor as a web app on Azure Container Apps.

## Architecture (GitHub API-First)

```
Internet ──HTTPS──> Azure Container Apps (1-5 replicas)
                        ├── Node.js server (port 7862)
                        ├── PowerShell 7 (terminal + AI commands)
                        ├── Python (embeddings)
                        └── GitHub REST API (AI-Rosetta-Stone/ai-triad-data)
                              ├── Read: Contents/Trees/Blobs APIs
                              ├── Write: session branches + PRs
                              ├── Auth: GitHub App via Key Vault PEM
                              └── Cache: /tmp/taxonomy-cache (local SSD)
```

Data is read from and written to `AI-Rosetta-Stone/ai-triad-data` via the GitHub REST API. No persistent volume, no Azure Files, no local git clone. A baked taxonomy snapshot in the container image provides fallback during GitHub outages (read-only mode).

## BYOK (Bring Your Own Key)

No API keys are stored in Azure configuration. Users enter their own
Gemini/Claude/Groq API keys through the app's settings UI. Keys are
stored in Azure Key Vault via managed identity.

## Prerequisites

- [Azure CLI](https://aka.ms/install-azure-cli) (`az`)
- An Azure subscription
- The container image built and pushed to `ghcr.io` (happens automatically on tag push via GitHub Actions)
- A GitHub App with Contents read/write access to `AI-Rosetta-Stone/ai-triad-data`

## Quick Start

```powershell
# 1. Log in to Azure
az login

# 2. Deploy (creates everything from scratch)
./deploy.ps1 -ResourceGroup ai-triad
```

The script will:
- Create a resource group (if needed)
- Deploy Container Apps + Key Vault via Bicep
- Set CORS to the app's URL
- Print the app URL when done

Open the URL and you're running — data loads from GitHub automatically.

## Cost

At low usage, this runs within Azure Container Apps' **free tier**:
- 180,000 vCPU-seconds/month
- 360,000 GiB-seconds/month

No persistent storage costs (data served via GitHub API).

**Estimated monthly cost: $0-3**

## Adding Authentication

After deploying, add GitHub login (zero code change):

```bash
az containerapp auth update \
  --name taxonomy-editor \
  --resource-group ai-triad \
  --enabled-providers GitHub \
  --github-client-id <your-github-oauth-app-id> \
  --github-client-secret <your-github-oauth-app-secret> \
  --unauthenticated-client-action RedirectToLoginPage
```

Create a GitHub OAuth App at https://github.com/settings/applications/new with callback URL:
`https://<your-app-url>/.auth/login/github/callback`

## CI/CD

The `deploy-azure.yml` workflow deploys on manual trigger. To use it:

1. Set up Azure OIDC credentials (service principal with federated identity)
2. Add repository secrets: `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`
3. Trigger with the commit SHA to deploy — the deploy pins that commit's image by immutable digest (t/3679 deploy-by-digest); `sha` is required and there is no `:latest` fallback:
   ```bash
   gh workflow run deploy-azure.yml -f environment=production -f auth_mode=optional -f sha=<commit>
   ```
   (or GitHub Actions > Deploy to Azure > Run workflow, supplying the `sha` input). See [runbooks/production-release.md](runbooks/production-release.md).

No API key secrets needed in GitHub — keys are managed per-user in the app.

## Operational Runbooks

See `deploy/azure/runbooks/` for procedures covering:
- GitHub outage (fallback mode)
- Rate limit exhaustion
- Cache corruption
- Token / Key Vault failure
- Force push recovery
- API-mode cutover checklist

## Files

| File | Purpose |
|------|---------|
| `main.bicep` | Infrastructure as Code — all Azure resources |
| `deploy.ps1` | One-command deployment script |
| `.env.template` | Azure deployment settings (no API keys) |
| `runbooks/*.md` | Operational runbooks for failure modes |

## Development workflow (post-cutover, 2026-07-31)

Agent development is rooted at the **shared `main` checkout** — role `AGENTS.md` and `.orca/` are overlay-tracked and do not exist in any worktree, so every agent session runs from the hub (t/2096). `wt-*` worktrees are **per-task landing/isolation trees**, not role homes: feature work is branched from `origin/main`, landed via PR self-merge on `ci-gate` + `CodeQL` green (t/2025), and the worktree sits detached at `origin/main` between tasks. A pre-commit guard (`.githooks/pre-commit`, t/1926/t/2009) refuses direct commits to the shared `main` and detached-HEAD worktree commits.
