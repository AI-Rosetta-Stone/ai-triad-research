# Ephemeral Runner Setup — Step-by-Step

## Prerequisites (already done)

- [x] Azure CLI logged in (`az account show`)
- [x] `$env:GITHUB_PAT` set — GitHub PAT with `repo` + `admin:org` scope
- [x] `$env:RUNNER_WEBHOOK_SECRET` set — random HMAC secret
- [x] Azure Functions Core Tools installed (`func --version`)
- [x] Runner infrastructure code committed (`deploy/azure/runner/`)

## Step 1: Store secrets in GitHub Actions

```powershell
gh secret set GITHUB_RUNNER_PAT --body $env:GITHUB_PAT
gh secret set GITHUB_RUNNER_WEBHOOK_SECRET --body $env:RUNNER_WEBHOOK_SECRET
```

## Step 2: Deploy the runner Bicep module

Deploy just the runner module (does NOT touch existing container app resources):

```powershell
cd C:\Users\jsnov\repos\ai-triad-research

az deployment group create -g ai-triad `
  -f deploy/azure/runner/runner.bicep `
  --parameters enabled=true `
               githubRunnerPat=$env:GITHUB_PAT `
               githubRunnerWebhookSecret=$env:RUNNER_WEBHOOK_SECRET
```

Wait for it to complete (~2-3 min). Then grab the Function App name:

```powershell
$funcName = az functionapp list -g ai-triad --query "[?contains(name,'runner')].name" -o tsv
Write-Host "Function App: $funcName"
```

## Step 3: Deploy the Function code

```powershell
cd C:\Users\jsnov\repos\ai-triad-research\deploy\azure\runner\function
npm ci
func azure functionapp publish $funcName --javascript
```

## Step 4: Configure the GitHub webhook

```powershell
$funcHost = az functionapp show -n $funcName -g ai-triad --query defaultHostName -o tsv
$webhookUrl = "https://$funcHost/api/github-webhook"
Write-Host "Webhook URL: $webhookUrl"

gh api repos/AI-Rosetta-Stone/ai-triad-research/hooks --method POST `
  -f "config[url]=$webhookUrl" `
  -f "config[content_type]=json" `
  -f "config[secret]=$env:RUNNER_WEBHOOK_SECRET" `
  -F "events[]=workflow_job" `
  -F "active=true"
```

Verify:

```powershell
gh api repos/AI-Rosetta-Stone/ai-triad-research/hooks --jq '.[].config.url'
```

## Step 5: Test with a container build

Update container.yml to use the self-hosted runner for the build job:

```yaml
# In .github/workflows/container.yml, change:
runs-on: ubuntu-latest
# To:
runs-on: [self-hosted, aci]
```

Then trigger a test build:

```powershell
gh workflow run "Container Image" --ref main
```

Watch for the ACI runner:

```powershell
az container list -g ai-triad `
  --query "[?tags.purpose=='github-actions-runner'].[name,provisioningState]" -o table
```

## Step 6: Update deploy-azure.yml (optional)

Add runner params to the deploy workflow so future Bicep deploys don't disable the runner:

In `.github/workflows/deploy-azure.yml`, add to the Bicep parameters in both
the what-if and deploy steps:

```
ephemeralRunnerEnabled=true
githubRunnerPat=${{ secrets.GITHUB_RUNNER_PAT }}
githubRunnerWebhookSecret=${{ secrets.GITHUB_RUNNER_WEBHOOK_SECRET }}
```

## Troubleshooting

### Check Function App logs
```powershell
az functionapp log tail -n $funcName -g ai-triad
```

### List active runners
```powershell
az container list -g ai-triad `
  --query "[?tags.purpose=='github-actions-runner'].[name,tags.\"github-run-id\",provisioningState]" -o table
```

### Clean up orphaned runners
```powershell
az container list -g ai-triad `
  --query "[?tags.purpose=='github-actions-runner'].name" -o tsv | `
  ForEach-Object { az container delete -g ai-triad -n $_ --yes }
```

### Delete webhook (if needed)
```powershell
$hookId = gh api repos/AI-Rosetta-Stone/ai-triad-research/hooks --jq '.[] | select(.config.url | contains("runner")) | .id'
gh api repos/AI-Rosetta-Stone/ai-triad-research/hooks/$hookId --method DELETE
```

### Disable runner infrastructure
```powershell
az deployment group create -g ai-triad `
  -f deploy/azure/runner/runner.bicep `
  --parameters enabled=false
```
