# Deployment Facts — Canonical Source of Truth

**Owner:** DevOps. **Last verified:** 2026-07-27 against Azure via `az containerapp list` / `az containerapp env list` (see [Re-verify](#re-verify)).

This is the single source of truth for the deployment's identity facts. The DevOps, Azure, and Docker `AGENTS.md` files **link here — they must not restate these values inline** (inline copies drift out of sync; that drift was the t/1735 bug).

## Production

| Fact | Value |
|---|---|
| Container App | `taxonomy-editor` |
| Resource Group | `ai-triad` |
| Region | East US |
| ACA Environment | `cae-aitriad` (Consumption plan) |
| App URL | https://taxonomy-editor.yellowbush-aeda037d.eastus.azurecontainerapps.io |
| Env domain suffix | `yellowbush-aeda037d.eastus.azurecontainerapps.io` |
| Container Image | `ghcr.io/ai-rosetta-stone/taxonomy-editor:latest` — **GHCR, not Azure Container Registry** |
| Storage Account / File Share | `staitriadkvwl3nywge4iw` / `taxonomy-data` |
| Scale | 0–1 replicas, 1.0 CPU / 2 GiB RAM (scale-to-zero) |
| Auth | GitHub + Google OAuth via Azure Easy Auth |
| API keys | BYOK: users supply their own keys through the app UI (ADR-002). **Exception:** two operator-funded Gemini pool secrets, each optional and enabled only when its `main.bicep` param is set: `free-tier-gemini-key` (`FREE_TIER_GEMINI_KEY`, the anonymous free tier) and `gemini-paid-key` (`GEMINI_PAID_KEY`, a last-resort fallback, t/950, [design](../../../docs/design/paid-gemini-fallback.md)). Both are live in prod (verified 2026-10-12). No other provider key belongs in infra. |
| Cost target | $0–5/month for **Azure** resources. Gemini usage on the two pool keys is billed to the operator's Google account, outside Azure, and is not covered by this target. |

## Staging

| Fact | Value |
|---|---|
| Container App | `taxonomy-editor-staging` |
| Resource Group | `ai-triad` |
| Region | East US |
| App URL | https://taxonomy-editor-staging.yellowbush-aeda037d.eastus.azurecontainerapps.io |

## Re-verify

```
az containerapp list --query "[].{name:name, rg:resourceGroup, location:location, fqdn:properties.configuration.ingress.fqdn}" -o table
az containerapp env list --query "[].{name:name, rg:resourceGroup, location:location, defaultDomain:properties.defaultDomain}" -o table
```

Whenever the deployment identity changes, update **this file** — not the AGENTS.md files (which only link here). Related: [operational-commands.md](operational-commands.md), [production-release.md](production-release.md).

## Drift corrected (t/1735, 2026-07-27)

The Azure `AGENTS.md` "Current Deployment" block had drifted on four facts; corrected here against live Azure:

| Fact | Stale (wrong) | Actual |
|---|---|---|
| App name | `ai-triad-taxonomy-editor` | `taxonomy-editor` |
| Region | East US 2 | East US |
| ACA Environment | `ai-triad-prod` | `cae-aitriad` |
| Registry | Azure Container Registry (Basic) | GHCR (`ghcr.io/ai-rosetta-stone/taxonomy-editor`) |

The DevOps `AGENTS.md` "Live Deployment" block was already correct and matched Azure.
