# Ephemeral Self-Hosted GitHub Actions Runner

Scale-to-zero self-hosted runners using Azure Functions + Azure Container Instances.

## How it works

1. GitHub sends a `workflow_job.queued` webhook to an Azure Function
2. The Function generates a runner registration token via GitHub API
3. The Function creates an ACI container group with `myoung34/github-runner` (ephemeral mode)
4. The runner picks up the job, executes it, and exits
5. GitHub sends `workflow_job.completed` → the Function deletes the ACI group

**Cost:** ~$0/month idle. ~$0.05 per build (2 vCPU × 4 GiB × ~5 min).

## Prerequisites

1. A GitHub PAT with `repo` and `admin:org` scopes (for runner registration tokens)
2. Azure CLI logged in with permissions to deploy Bicep and create ACI groups

## Deploy

### 1. Add secrets to GitHub Actions

```bash
gh secret set GITHUB_RUNNER_PAT --body "<your-pat>"
gh secret set GITHUB_RUNNER_WEBHOOK_SECRET --body "$(openssl rand -hex 32)"
```

### 2. Deploy the Bicep module

The runner module is deployed as part of `main.bicep`. Enable it:

```bash
az deployment group create -g ai-triad -f deploy/azure/main.bicep \
  --parameters ephemeralRunnerEnabled=true \
               githubRunnerPat=<your-pat> \
               githubRunnerWebhookSecret=<your-secret>
```

### 3. Deploy the Function code

```bash
cd deploy/azure/runner/function
npm ci
func azure functionapp publish func-runner-<suffix>
```

### 4. Configure the GitHub webhook

```bash
WEBHOOK_URL=$(az functionapp show -n func-runner-<suffix> -g ai-triad --query defaultHostName -o tsv)
gh api repos/AI-Rosetta-Stone/ai-triad-research/hooks --method POST \
  -f "config[url]=https://${WEBHOOK_URL}/api/github-webhook" \
  -f "config[content_type]=json" \
  -f "config[secret]=<your-webhook-secret>" \
  -F "events[]=workflow_job" \
  -F "active=true"
```

### 5. Update workflows to use self-hosted runners

Change `runs-on: ubuntu-latest` to `runs-on: [self-hosted, aci]` in workflows
that benefit from faster runners (e.g., container builds):

```yaml
jobs:
  build-and-push:
    runs-on: [self-hosted, aci]  # ephemeral ACI runner — no queue wait
```

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `RUNNER_IMAGE` | `myoung34/github-runner:latest` | Runner container image |
| `RUNNER_CPU` | `2` | vCPU cores per runner |
| `RUNNER_MEMORY` | `4` | GiB RAM per runner |
| `RUNNER_LABELS` | `self-hosted,aci` | Runner labels (comma-separated) |
| `GITHUB_OWNER` | `AI-Rosetta-Stone` | Repository owner |
| `GITHUB_REPO` | `ai-triad-research` | Repository name |

## Monitoring

Runner container groups are tagged with `purpose=github-actions-runner` and
`github-run-id=<id>`. To list active runners:

```bash
az container list -g ai-triad --query "[?tags.purpose=='github-actions-runner'].[name,tags.\"github-run-id\"]" -o table
```

To clean up orphaned runners (older than 1 hour):

```bash
az container list -g ai-triad --query "[?tags.purpose=='github-actions-runner'].name" -o tsv | \
  xargs -I {} az container delete -g ai-triad -n {} --yes
```
