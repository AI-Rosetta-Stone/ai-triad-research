# Runbook: Operational Commands (Quick Reference)

**Owner:** DevOps. Quick-reference for common one-off operational commands against the
production Container App. For the full deploy procedure see
[`production-release.md`](production-release.md); for remote health verification see the
Remote Diagnostics Cmdlets section in `operations/devops/AGENTS.md`.

**Live deployment identifiers** (source of truth: `operations/devops/AGENTS.md` "Live Deployment"):
Resource Group `ai-triad`, Container App `taxonomy-editor`, image
`ghcr.io/ai-rosetta-stone/taxonomy-editor:latest`, region East US.

## Container App

```bash
# Redeploy latest image
az containerapp update --name taxonomy-editor -g ai-triad --image ghcr.io/ai-rosetta-stone/taxonomy-editor:latest

# Check container status
az containerapp show --name taxonomy-editor -g ai-triad --query "properties.runningStatus"

# View console logs
az containerapp logs show --name taxonomy-editor -g ai-triad --type console
```

## Auth & Access

```bash
# Update allowed users (server-side allowlist)
az containerapp update --name taxonomy-editor -g ai-triad --set-env-vars "ALLOWED_USERS=user1,user2"

# Update GitHub OAuth secret
az containerapp auth github update --name taxonomy-editor -g ai-triad --client-secret <new-secret>
```

> **Env-var drift trap:** CLI `--set-env-vars` on the Container App is wiped by the next
> Bicep deploy. For anything durable, persist it in `deploy/azure/main.bicep` (param +
> GitHub Actions variable), not via CLI.

## Data

```bash
# Seed data from GitHub
./deploy.ps1 -ResourceGroup ai-triad -SeedData
```

## Ingress 5xx Diagnosis (t/3167)

**Alert fired**: `alert-event-loop-blocked` (primary) or `alert-ingress-5xx-backstop` (backstop).

**Step 1 — Confirm event-loop starvation** (Log Analytics):
```kql
// Find event-loop blocked WARNs (fires only on >1s blocks — not routine gauges)
ContainerAppConsoleLogs_CL
| where Log_s has "event loop blocked"
| where TimeGenerated > ago(30m)
| project TimeGenerated, Log_s
| order by TimeGenerated desc
```

**Step 2 — Determine if 5xx was envoy-fabricated or app-originated**:
```kql
// App Insights requests table — Node-processed requests only
// If client reports a 5xx for timeWindow X but nothing appears here → envoy-fabricated
requests
| where timestamp > ago(1h) and resultCode startswith "5"
| project timestamp, name, resultCode, duration, id
| order by timestamp desc
```

Cross-reference: if the 5xx appears in client logs for a time window **AND** is absent from
AppInsights `requests` → Node never processed it → ACA ingress fabricated the 5xx (event-loop
too starved to respond). See t/3165 for the incident pattern.

**Note (ACA platform limitation):** No per-request Envoy access log is available in
`ContainerAppSystemLogs_CL` or `ContainerAppConsoleLogs_CL`. `upstream_response_time` and
the "no-upstream" flag are not observable in LA. The two-step cross-reference above is the
diagnostic path within ACA's current capabilities. (t/3167)
