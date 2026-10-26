// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// ═══════════════════════════════════════════════════════════════════════════════
// Azure Container Apps deployment for Taxonomy Editor
//
// BYOK (Bring Your Own Key) model: API keys are NOT passed at deployment time.
// Users enter their own Gemini/Claude/Groq API keys through the app UI.
// Keys stored in Azure Key Vault via managed identity.
//
// Data access: GitHub API-first — reads/writes go to AI-Rosetta-Stone/ai-triad-data
// via GitHub Contents/Trees APIs. No Azure Files, no local git clone.
//
// Resources created:
//   - Container Apps Environment (serverless)
//   - Container App (the Taxonomy Editor, system-assigned managed identity)
//   - Log Analytics Workspace (diagnostics)
//   - Key Vault (per-user BYOK secrets + GitHub App PEM, accessed via managed identity)
//   - Storage Account (Azure Blob — per-user content + community library)
//
// Usage:
//   az deployment group create -g ai-triad -f main.bicep
// ═══════════════════════════════════════════════════════════════════════════════

@description('Azure region for all resources')
param location string = resourceGroup().location

// t/3679 (deploy-by-digest): the AUTOMATED deploy path ALWAYS passes a resolved, IMMUTABLE
// `…@sha256:<digest>` here — deploy-azure.yml / deploy-staging.yml resolve the deploy commit's
// permanent `sha-<commit>` tag to its digest (Resolve-ImageDigest.ps1) and pin the revision to it,
// so a pod recycle re-pulls IDENTICAL bytes (closing the t/3522/t/3523 mutable-:latest recycle-swap).
// The `:latest` DEFAULT below is retained ONLY as a manual escape hatch (a hand-run `az deployment
// group create` with no containerImage) and for a genuine first deploy — NOT a path any automated
// deploy takes. It is NOT cosmetic: it avoids a hard failure on a manual bootstrap. Detect half
// (t/3679#7): the resolved digest + deploy-time timestamp are also injected as IMAGE_DIGEST /
// IMAGE_DEPLOYED_AT env on the revision (deploy-azure.yml) — a recycle without a deploy keeps the
// SAME IMAGE_DEPLOYED_AT, so the reconcile check's purpose is OUT-OF-BAND revision creation, not
// recycle-swap (condition 6), which digest-pinning already makes unreachable.
@description('Container image. The automated deploy path passes a resolved @sha256 digest (t/3679 deploy-by-digest). Default :latest is a manual/first-deploy escape hatch only. ghcr.io/ai-rosetta-stone/taxonomy-editor:latest')
param containerImage string = 'ghcr.io/ai-rosetta-stone/taxonomy-editor:latest'

@description('Unique suffix for globally unique resource names')
param uniqueSuffix string = uniqueString(resourceGroup().id)

// ── Traffic pin (t/2049 — pre-traffic canary/health gate) ──
// In activeRevisionsMode 'Multiple' with NO ingress.traffic block, a full Bicep
// apply reconciles traffic and promotes the LATEST revision to 100% — before the
// deploy workflow's readiness gate ever runs (the t/2047 bypass). Worse: this
// template defines BOTH the prod and staging apps, so EVERY apply reconciles
// BOTH — a staging-intent deploy would silently wipe a manual prod rollback pin
// and re-promote prod's latest (t/2049#6 landmine). To close this, each app's
// ingress pins 100% traffic to an explicit, already-live revision. The deploy
// workflow and deploy.ps1 capture each app's CURRENT ACTIVE revision and pass it
// here, so a newly-created revision starts at 0% and is promoted only after
// /healthz readiness + acceptance + persona gates pass. Empty = genuine
// first/only deploy -> latest gets 100% (safe; there is nothing to hold).
// NEVER pass empty as a silent fallback when the capture step FAILED — the
// capture must abort instead (t/2049#6).
@description('Full name of the revision to hold 100% PROD ingress traffic on during a Bicep apply (e.g. "taxonomy-editor--restore-gem"). Empty = first/only deploy (latest gets 100%).')
param trafficPinRevisionName string = ''

@description('Full name of the revision to hold 100% STAGING ingress traffic on during a Bicep apply. Empty = first/only staging deploy (latest gets 100%).')
param trafficPinRevisionNameStaging string = ''

// ── Staging write-isolation (t/2643) ──
// FLIPPED TO true (t/4298 escalation, 2026-10-19): staging was still RW on prod's own
// `taxonomy-data` share — any staging writer to the data root (e.g. G8a inline grounding
// reconcile, confirmed live on staging today, independent of GROUNDING_SWEEP_ENABLED) wrote
// directly to the same share prod reads, which also holds authorized-users.json and
// taxonomy/Origin/embeddings.json. arm-B verification is satisfied: Azure's test revisions
// already ran successfully against `taxonomy-data-ro` via `-ReadOnlyShared`, no boot problems
// (p/241#90) — confirming class-A writes already route to /mnt/staging-state, not /mnt/shared.
// The RO flip makes the hard boundary live: missed write sites EROFS instead of silently
// mutating prod. Lands with the first deploy after the t/4258 hold, with the PI's go.
@description('Flip /mnt/shared to read-only on staging (ARM step 3 of t/2643 isolation).')
param stagingSharedReadOnly bool = true

// ── Staging load-test sizing (t/4203) ──
// A PARAMETER, not a hand-applied resize: t/4176's own history (t/4242) shows a manual
// `az containerapp update` resize gets silently reverted by the next ordinary deploy, because
// the deploy re-applies this template's declared (small) values. Defaulting this to false means
// every normal deploy-staging run (which never sets it) keeps staging small automatically — the
// resize can never be "left large" by someone forgetting to revert it (t/4203 AC4).
@description('Temporarily size staging like prod (2 vCPU/4Gi, maxReplicas 3, concurrentRequests scale rule) for a load test (t/4203). Revert to false for the next ordinary deploy.')
param stagingLoadTestSize bool = false

// ── Resource Tags ──
var tags = {
  project: 'ai-triad-research'
  environment: 'production'
  'managed-by': 'bicep'
}

// ── OAuth identity providers ──
// Bicep owns the container app's secret store. Pass the client secrets as
// secure params at deploy time (the workflow reads them from GH Actions
// secrets). If a param is empty, the corresponding provider self-disables
// below and its secret is omitted.

@description('Google OAuth 2.0 client ID (from https://console.cloud.google.com)')
param googleClientId string = ''

@description('GitHub OAuth app client ID (from https://github.com/settings/developers)')
param githubClientId string = ''

@secure()
@description('Google OAuth 2.0 client secret')
param googleClientSecret string = ''

@secure()
@description('GitHub OAuth app client secret')
param githubClientSecret string = ''

@description('Azure AD (Microsoft Entra ID) app client ID')
param aadClientId string = ''

@secure()
@description('Azure AD app client secret')
param aadClientSecret string = ''

@description('Azure AD OpenID issuer — use "common" for multi-tenant + personal accounts, or a specific tenant ID')
param aadIssuer string = 'common'

@description('Auth mode: set authDisabled="1" for anonymous-only (no login page), or authOptional="1" for login page with anonymous option. If neither, sign-in is required (needs authorized-users.json).')
param authDisabled string = ''

@description('Set to "1" to show login page with sign-in + anonymous options. Signed-in users get full access (AI + editing); anonymous users get read-only, non-AI access.')
param authOptional string = '1'

@description('Comma-separated list of admin userIds (derived storage IDs, not raw emails — see deriveStorageUserId in userContext.ts). Grants the community/calibration review UI and /api/admin/* endpoints. Sourced from the ADMIN_USERS GitHub Actions variable so personal emails stay out of public source. Defaults to jpsnover (matches the server default).')
param adminUsers string = 'jpsnover,jsnover13-at-gmail-com'

@description('Comma-separated `<idp>:<stableId>=<legacy principal name>` entries (t/4326, read by taxonomy-editor/src/server/principalName.ts): maps a stable provider id (e.g. `github:<numeric id>`) onto the legacy principal name existing data, ADMIN_USERS and READ_ONLY_PRINCIPALS are keyed by. Not secret (numeric ids), but sourced from the IDENTITY_MAP GitHub Actions variable like ADMIN_USERS so personal names stay out of public source. Legacy names may contain spaces; they must not contain quote characters (deploy-azure.yml refuses the value if they do).')
param identityMap string = ''

// ── GitHub data-sync (optional Phase-2 feature) ──
// When enabled, web edits commit to a per-user branch in the working tree and
// the user can open / update a pull request against origin/main from the UI.
// Set GIT_SYNC_ENABLED to '1' to turn the feature on at runtime. Authenticate
// either with a GitHub App (preferred) or a PAT fallback (dev/test only).
// The App's private key is NOT passed through Bicep — upload it to Key Vault
// once (`az keyvault secret set --name github-app-private-key --file key.pem`)
// and pass the secret NAME here.

@description('Enable GitHub data-sync feature. "1" = on, empty = off.')
param gitSyncEnabled string = ''

@description('GitHub repo in owner/repo form (e.g. "AI-Rosetta-Stone/ai-triad-data") that the server pushes to.')
param githubRepo string = ''

@description('GitHub App numeric ID. Leave empty to fall back to GITHUB_TOKEN (PAT).')
param githubAppId string = ''

@description('GitHub App installation ID on the target repo/org.')
param githubAppInstallationId string = ''

@description('Name of the Key Vault secret holding the GitHub App private key (PEM). Upload separately via az keyvault secret set.')
param githubAppPrivateKeySecretName string = ''

@secure()
@description('Optional GITHUB_TOKEN (PAT) fallback when no App is registered. Prefer the App for production.')
param githubToken string = ''

@secure()
@description('HMAC shared secret for the Phase-3 GitHub webhook. When set, /api/sync/webhook/github verifies X-Hub-Signature-256 and flags upstream-updated.')
param githubWebhookSecret string = ''

@secure()
@description('Gemini API key for the anonymous free tier. When set, keyless web users get limited Gemini access (pinned model, rate-limited). Omit to keep the free tier disabled.')
param freeTierGeminiKey string = ''

@secure()
@description('Paid Gemini API key for fallback when user has no key and free tier is exhausted. Omit to disable paid fallback.')
param geminiPaidKey string = ''

// ── Ephemeral self-hosted runner (ACI + Azure Function) ──
@description('Enable ephemeral GitHub Actions runner infrastructure (Azure Function + ACI)')
param ephemeralRunnerEnabled bool = false

@secure()
@description('GitHub PAT with repo + admin:org scope for runner registration tokens')
param githubRunnerPat string = ''

@secure()
@description('HMAC secret for verifying GitHub runner webhook signatures')
param githubRunnerWebhookSecret string = ''

// Prod's own resources, as a single source of truth (t/4203 SO C1, p/682#44 / e/307#2):
// stagingLoadTestSize below reads these instead of a hardcoded literal, so the load test
// always measures whatever prod's CURRENT size actually is, not a stale snapshot of it — the
// exact gap that made the first version of stagingLoadTestSize "prove it at the size you're
// moving away from" when t/4263 proposed changing prod's own cpu/memory.
var prodCpu = '1.5'
var prodMemory = '3Gi'

var googleEnabled = !empty(googleClientId) && !empty(googleClientSecret)
var githubEnabled = !empty(githubClientId) && !empty(githubClientSecret)
var aadEnabled = !empty(aadClientId) && !empty(aadClientSecret)
var googleClientSecretName = 'google-client-secret'
var githubClientSecretName = 'github-client-secret'
var aadClientSecretName = 'aad-client-secret'
var githubTokenSecretName = 'github-sync-token'
var githubWebhookSecretName = 'github-webhook-secret'
var githubTokenProvided = !empty(githubToken)
var githubWebhookSecretProvided = !empty(githubWebhookSecret)
var freeTierEnabled = !empty(freeTierGeminiKey)
var freeTierSecretName = 'free-tier-gemini-key'
var paidTierEnabled = !empty(geminiPaidKey)
var paidTierSecretName = 'gemini-paid-key'
var oauthSecrets = concat(
  googleEnabled ? [ { name: googleClientSecretName, value: googleClientSecret } ] : [],
  githubEnabled ? [ { name: githubClientSecretName, value: githubClientSecret } ] : [],
  aadEnabled ? [ { name: aadClientSecretName, value: aadClientSecret } ] : [],
  githubTokenProvided ? [ { name: githubTokenSecretName, value: githubToken } ] : [],
  githubWebhookSecretProvided ? [ { name: githubWebhookSecretName, value: githubWebhookSecret } ] : [],
  freeTierEnabled ? [ { name: freeTierSecretName, value: freeTierGeminiKey } ] : [],
  paidTierEnabled ? [ { name: paidTierSecretName, value: geminiPaidKey } ] : []
)

// ── Log Analytics ──

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-aitriad-${uniqueSuffix}'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 90
  }
}

// ── Key Vault (per-user BYOK secrets) ──
// Uses RBAC authorization; the container app's system-assigned managed
// identity is granted 'Key Vault Secrets Officer' on this vault below.
// Secret names: apikey-<backend>-<sha256(principal)[:32]>

resource keyVault 'Microsoft.KeyVault/vaults@2026-02-01' = {
  name: 'kv-ait-${uniqueSuffix}'
  location: location
  tags: tags
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    enablePurgeProtection: true
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      // Allow required for consumption-tier ACA — managed identity calls
      // use unpredictable Azure SNAT IPs that can't be allowlisted, and
      // ACA is not a Key Vault "trusted service" for bypass purposes.
      // Still protected by RBAC (only the container app's MSI has access).
      defaultAction: 'Allow'
      bypass: 'AzureServices'
    }
  }
}

// ── Key Vault Diagnostics ──
// Sends audit events (secret reads, writes, deletes) to Log Analytics.

resource kvDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: keyVault
  name: 'kv-audit-logs'
  properties: {
    workspaceId: logAnalytics.id
    logs: [
      {
        categoryGroup: 'audit'
        enabled: true
        retentionPolicy: {
          enabled: false
          days: 0
        }
      }
    ]
    metrics: [
      {
        category: 'AllMetrics'
        enabled: true
        retentionPolicy: {
          enabled: false
          days: 0
        }
      }
    ]
  }
}

// ── Application Insights (error monitoring) ──
// Free tier: 5 GB/month ingestion. Connected to the same Log Analytics workspace.
// The connection string is injected as APPLICATIONINSIGHTS_CONNECTION_STRING env var.
// The taxonomy-editor server uses the @azure/monitor-opentelemetry SDK to send
// exceptions, request traces, and custom events.

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: 'appi-aitriad-${uniqueSuffix}'
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalytics.id
    RetentionInDays: 90
  }
}

// ── Container Apps Environment ──

resource containerAppEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'cae-aitriad'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }
}

// ── Azure Blob Storage (user content + community library) ──
// User-generated content (chats, debates, settings) and the community library
// live in Blob Storage instead of the GitHub repo. Auth via managed identity
// (DefaultAzureCredential) — no connection strings or SAS tokens.

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: 'staitriad${uniqueSuffix}'
  location: location
  tags: tags
  sku: { name: 'Standard_ZRS' }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    // allowSharedKeyAccess left enabled — Azure Files mount (taxonomy-data)
    // uses account key via managed environment storage; disabling breaks the mount.
    // Migrate environment storage to identity-based auth before enabling.
    networkAcls: {
      // Allow required for consumption-tier ACA — SMB/CIFS mounts use Azure
      // SNAT outbound IPs which are unpredictable and can't be allowlisted.
      // VNet integration + private endpoints would allow Deny but exceed
      // the $0-5/month cost target. Still protected by shared-key auth.
      defaultAction: 'Allow'
      bypass: 'AzureServices, Logging, Metrics'
    }
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storageAccount
  name: 'default'
  properties: {
    isVersioningEnabled: true
    deleteRetentionPolicy: {
      enabled: true
      days: 30
    }
    containerDeleteRetentionPolicy: {
      enabled: true
      days: 30
    }
  }
}

resource userContentContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'user-content'
  properties: {
    publicAccess: 'None'
  }
}

resource communityContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'community'
  properties: {
    publicAccess: 'None'
  }
}

resource analyticsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'analytics'
  properties: {
    publicAccess: 'None'
  }
}

// ── Staging-isolated blob containers (H5) ──
// Staging writes to its own containers to prevent cross-contamination with
// production user data. The staging Container App env needs updating to
// use these container names (BLOB_CONTAINER_PREFIX=staging-).
//
// SYNC WITH deploy-azure.yml: the "Verify blob containers exist post-deploy"
// step (t/2701 gate) holds a hard-coded list of these 8 container names
// (analytics, staging-analytics, user-content, staging-user-content, community,
// staging-community, brief-exports, staging-brief-exports). Adding or removing
// a container resource here requires updating that list in the workflow.

resource stagingUserContentContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'staging-user-content'
  properties: {
    publicAccess: 'None'
  }
}

resource stagingCommunityContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'staging-community'
  properties: {
    publicAccess: 'None'
  }
}

resource stagingAnalyticsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'staging-analytics'
  properties: {
    publicAccess: 'None'
  }
}

// ── Brief Export artifact containers (t/2821) ──
// Dedicated containers isolate brief export blobs so the lifecycle policy
// (managementPolicies below) can target them without touching user-content.
// SYNC WITH Invoke-BlobContainerGateCheck.ps1: update the container list there too.

resource briefExportsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'brief-exports'
  properties: {
    publicAccess: 'None'
  }
}

resource stagingBriefExportsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'staging-brief-exports'
  properties: {
    publicAccess: 'None'
  }
}

// ── Brief Export artifact lifecycle policy (t/2821) ──
// 30-day flat delete on brief-exports and staging-brief-exports.
// Zero runtime cost; runs even when the app is scaled to 0.
// Count-quota (t/2831) handles live hygiene; this rule handles stale cleanup.
resource briefExportsLifecyclePolicy 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: storageAccount
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          name: 'delete-stale-brief-exports'
          enabled: true
          type: 'Lifecycle'
          definition: {
            actions: {
              baseBlob: {
                delete: {
                  daysAfterModificationGreaterThan: 30
                }
              }
            }
            filters: {
              blobTypes: ['blockBlob']
              prefixMatch: [
                'brief-exports/'
                'staging-brief-exports/'
              ]
            }
          }
        }
      ]
    }
  }
}

// ── Staging Azure Files — writable state share (t/2643) ──
// Class-A writes (flags, config, calibration, keys) from staging route here.
// Prod's 'taxonomy-data' share is NOT declared here (managed externally) — it
// will be flipped to ReadOnly in a follow-up deploy once getStateRoot() is live.

resource stagingStateShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = {
  name: '${storageAccount.name}/default/taxonomy-data-staging'
  properties: { shareQuota: 100 }
}

resource envStorageStagingState 'Microsoft.App/managedEnvironments/storages@2024-03-01' = {
  parent: containerAppEnv
  name: 'taxonomy-data-staging'
  properties: {
    azureFile: {
      accountName: storageAccount.name
      accountKey: storageAccount.listKeys().keys[0].value
      shareName: 'taxonomy-data-staging'
      accessMode: 'ReadWrite'
    }
  }
  dependsOn: [stagingStateShare]
}

// Read-only registration of the shared taxonomy-data share.
// Always provisioned so the RO flip (stagingSharedReadOnly=true) is a
// single-param redeploy — no resource creation race at flip time.
// Arm A verification: with staging referencing this, a write to /mnt/shared
// must fail with EACCES/EPERM (Azure Files surfaces RO writes as EACCES).
resource envStorageSharedRO 'Microsoft.App/managedEnvironments/storages@2024-03-01' = {
  parent: containerAppEnv
  name: 'taxonomy-data-ro'
  properties: {
    azureFile: {
      accountName: storageAccount.name
      accountKey: storageAccount.listKeys().keys[0].value
      shareName: 'taxonomy-data'
      accessMode: 'ReadOnly'
    }
  }
}

// ── Container App ──

var baseEnv = [
  // t/2602: repoint data root from ephemeral /tmp to durable Azure Files mount.
  // Fixes class-A durability (admin flags, runtime-config, calibration logs) and
  // taxonomy reads (supersedes t/2612 startup.sh symlink).
  { name: 'AI_TRIAD_DATA_ROOT', value: '/mnt/shared' }
  // t/4298/t/4299/t/4300: TAXONOMY_CACHE_DIR no longer tracks AI_TRIAD_DATA_ROOT (the
  // t/2061 "must stay in sync" invariant above was superseded by PR #1078's toRepoPath()
  // fix, which made the two independent — staging already overrides this one on its own,
  // below). Co-locating the github-api disk cache with the data root meant any direct
  // writer to /mnt/shared (reconcile_grounding.py --apply, PS cmdlets) silently became
  // what prod served, with no check against GitHub — the exact bug validateCacheDirDisjoint()
  // (t/4300) now catches at boot. Fixed to the SAME ephemeral homedir path config.ts's own
  // unset-TAXONOMY_CACHE_DIR fallback would compute for github-api mode
  // (path.join(os.homedir(), '.cache', 'taxonomy-github-api'), HOME=/home/aitriad below) —
  // set EXPLICITLY here rather than left unset, because an unset value would fall through
  // to the Dockerfile's own ENV TAXONOMY_CACHE_DIR=/tmp/taxonomy-cache default instead,
  // landing back in a world-writable /tmp path (the exact symlink-race class config.ts's
  // own comment says to avoid). TL-approved (t/4299, p/538#77): this cache is intentionally
  // EPHEMERAL on cold start now — see config.ts's cost arithmetic for why that's acceptable.
  { name: 'TAXONOMY_CACHE_DIR', value: '/home/aitriad/.cache/taxonomy-github-api' }
  // t/4176: the code splits per-replica AI RPM and per-client rate limits by this (t/4177, t/4178).
  // MUST equal the container app's maxReplicas below, and deploy-azure.yml ExpectedEnvVars.
  { name: 'MAX_REPLICAS', value: '1' }
  // PROD's origin. Staging overrides it with its own FQDN in stagingEnvOverrides (t/4406).
  { name: 'ALLOWED_ORIGINS', value: 'https://taxonomy-editor.${containerAppEnv.properties.defaultDomain}' }
  { name: 'HOME', value: '/home/aitriad' }
  { name: 'NODE_ENV', value: 'production' }
  // BYOK model: users enter keys via the app UI. In Azure the server
  // routes them to Key Vault (one secret per user+backend), accessed
  // via the container app's system-assigned managed identity.
  { name: 'AZURE_KEYVAULT_URL', value: keyVault.properties.vaultUri }
  // Auth mode: AUTH_OPTIONAL='1' shows login page with sign-in + anonymous
  // option. AUTH_DISABLED='1' skips auth entirely. Neither = required sign-in.
  { name: 'AUTH_DISABLED', value: authDisabled }
  { name: 'AUTH_OPTIONAL', value: authOptional }
  // t/4296 G1: principals forced read-only (writes blocked by #3429's guard) regardless of
  // proxy-tiers.json — the hosted signed-in smoke identity (t/4134). Fail-closed static list,
  // idp-scoped `idp:login`. MUST stay in sync with deploy-azure.yml's ExpectedEnvVars gate.
  // t/4326 SO C2: since #3691 an UNMAPPED GitHub account's principal name is `github-<id>`, so the
  // smoke account (id 344897154) is listed under BOTH names — read-only holds whether or not
  // IDENTITY_MAP maps it back to `ai-triad-smoke` (fail-closed either way).
  { name: 'READ_ONLY_PRINCIPALS', value: 'github:ai-triad-smoke,github:github-344897154' }
  // Admin allowlist — comma-separated derived userIds gating the review UI and
  // /api/admin/* endpoints. Declared here so it survives Bicep deploys (a CLI
  // --set-env-vars value would be wiped by the next full template deployment).
  { name: 'ADMIN_USERS', value: adminUsers }
  // t/4326: stable-provider-id → legacy principal name map (principalName.ts). Inherited by
  // staging through stagingBaseEnv (not filtered). MUST stay in sync with ExpectedEnvVars.
  { name: 'IDENTITY_MAP', value: identityMap }
  // Tell the server to trust Easy Auth headers (X-MS-CLIENT-PRINCIPAL-*).
  // Container Apps should auto-inject this but doesn't reliably do so.
  { name: 'WEBSITE_AUTH_ENABLED', value: 'true' }
  // GitHub sync (Phase-2). GIT_SYNC_ENABLED is the master switch;
  // githubAppAuth.ts tries App credentials first, then GITHUB_TOKEN.
  // The App private key itself lives in Key Vault and is fetched by
  // name via the managed identity; it is never injected as an env.
  { name: 'GIT_SYNC_ENABLED', value: gitSyncEnabled }
  { name: 'GITHUB_REPO', value: githubRepo }
  { name: 'GITHUB_APP_ID', value: githubAppId }
  { name: 'GITHUB_APP_INSTALLATION_ID', value: githubAppInstallationId }
  { name: 'GITHUB_APP_PRIVATE_KEY_SECRET_NAME', value: githubAppPrivateKeySecretName }
  // Application Insights — runtime error monitoring and request tracing.
  { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsights.properties.ConnectionString }
  // Azure Blob Storage — user content (chats, debates) and community library.
  // Auth via managed identity (DefaultAzureCredential), no connection string needed.
  { name: 'AZURE_STORAGE_ACCOUNT_URL', value: storageAccount.properties.primaryEndpoints.blob }
  // t/3165 DURABLE close: the worker-offload flag lives HERE (baseEnv), not a CLI --set-env-vars —
  // a CLI value is wiped by the next full template deploy (the ephemeral-drift trap). It routes the
  // ONNX embedding compute to the off-thread worker (t/3183) so a large novel-text batch can't starve
  // the event loop past ACA's liveness deadline — the t/3165 fabricated-500 root cause. Designed for
  // a 2 vCPU worker floor (t/3182); prod now runs 1.5 vCPU by PI decision (t/4263), so the worker and
  // the loop share 1.5 cores — see the resources comment below. Storm-canary proof was at 2 vCPU:
  // GREEN + prod staged-flip AC-1/AC-3 green (loop max 39.6ms under 1536 concurrent computes). MUST stay in sync with deploy-azure.yml's
  // ExpectedEnvVars config-drift gate (Gate Co-Location — the gate verifies this value is deployed).
  { name: 'EMBEDDING_WORKER_OFFLOAD', value: '1' }
  // t/4263 SO C3: pin the worker pool to ONE worker at 1.5 vCPU. configureEmbeddingWorkerPool clamps
  // to availableParallelism()-1, which counts VISIBLE cores, not the cgroup CPU quota, so an unpinned
  // pool could oversubscribe the 1.5-vCPU quota. Raise only together with prodCpu (or after the
  // cgroup-aware clamp lands in lib/embeddings/offThreadEmbedding.ts). Gate-verified in deploy-azure.yml.
  { name: 'EMBEDDING_WORKER_POOL_SIZE', value: '1' }
  // t/4312/#3467: PI-approved overlay-commit conflict fence (p/331#2174). Lands ON for both
  // prod and staging with #3469/#3470's server code, which reads this flag from the
  // environment and defaults OFF when unset — this entry is what actually arms it. MUST stay
  // in sync with deploy-azure.yml's ExpectedEnvVars config-drift gate (Gate Co-Location).
  { name: 'OVERLAY_CONFLICT_STATE_ENABLED', value: '1' }
  // t/4298: both GROUNDING_RECONCILE_INLINE (G8a, was '1') and GROUNDING_SWEEP_ENABLED (G8b, was
  // '1') removed from hosted profiles.
  // - G8b: groundingSweepScheduler.ts's decideSweepArm returns 'blocked-github-api' on the hosted
  //   github-api profile unconditionally (the t/3333 guard — the sweep shells
  //   `reconcile_grounding.py --apply`, which writes the local filesystem, and the github-api read
  //   path never sees that write). Confirmed via Log Analytics: 351/351 prod boots and 89/89
  //   staging boots over 14 days logged the refusal, 0 "Grounding sweep started".
  // - G8a: SO review (e/326#2) first flagged that groundingReconcileHook.ts runs the SAME
  //   reconcile_grounding.py --apply with no STORAGE_MODE guard, so it was suspected to have the
  //   same no-op problem as G8b. **Resolved, C2 answer (TL, t/4298#8/e/327#5): G8a is gated by the
  //   `grounding_reconcile_inline` feature flag, which is OFF — G8a has never run at all.
  //   GROUNDING_RECONCILE_INLINE is an env var nothing reads.**
  // Kept certifying/enabling two things that never ran: ~25 boot error lines/day in prod from G8b,
  // plus a deploy gate that passed a check corresponding to nothing. Hosted grounding via a
  // CI-committed sweep (t/3333 Option A) is unfiled — not asked for; re-add either flag only if
  // that or an equivalent fix lands.
  // t/3309 step-3: DATA_ROOT_VALIDATION_ENFORCE (t/3305 boot hard-fail) RETIRED. The boot-time
  // exit(1) in server.ts is superseded by the /readyz warm-gate: a misprovisioned data root now
  // makes /readyz report failed → the deploy warm-gate blocks the traffic-shift and rolls back
  // (Arm-A/Arm-B proven on staging, t/3309). Co-landed with the server.ts exit(1) removal (joint-gv).
  // The t/3308 warn-alert remains as the warn-only observability backstop for any un-gated path.
]
var envWithToken = githubTokenProvided
  ? concat(baseEnv, [ { name: 'GITHUB_TOKEN', secretRef: githubTokenSecretName } ])
  : baseEnv
var envWithWebhook = githubWebhookSecretProvided
  ? concat(envWithToken, [ { name: 'GITHUB_WEBHOOK_SECRET', secretRef: githubWebhookSecretName } ])
  : envWithToken
var envWithFreeTier = freeTierEnabled
  ? concat(envWithWebhook, [ { name: 'FREE_TIER_GEMINI_KEY', secretRef: freeTierSecretName } ])
  : envWithWebhook
var containerEnv = paidTierEnabled
  ? concat(envWithFreeTier, [ { name: 'GEMINI_PAID_KEY', secretRef: paidTierSecretName } ])
  : envWithFreeTier

// ── Staging env isolation (t/2643) ──
// Override baseEnv keys for staging class-A write isolation.
// ALL must be Bicep-declared (never --set-env-vars — wiped by next apply).
// Get-BicepBaseEnv.ps1 -ForStaging also parses stagingEnvOverrides so
// Sync-StagingEnv.ps1 keeps staging's template in sync on every deploy.
//
// t/2670: toRepoPath() fix (PR #1078) makes AI_TRIAD_DATA_ROOT and TAXONOMY_CACHE_DIR
// independent — staging inherits AI_TRIAD_DATA_ROOT=/mnt/shared from baseEnv and
// overrides only TAXONOMY_CACHE_DIR to the isolated mount. The old must-match
// invariant (t/2061) is lifted by PR #1078's code fix.
var stagingEnvOverrides = [
  // Force off: staging must not sync to prod's git backend (t/2643 git-worktree hazard)
  { name: 'GIT_SYNC_ENABLED',    value: '0' }
  // Isolated cache dir only — AI_TRIAD_DATA_ROOT=/mnt/shared inherited from baseEnv
  { name: 'TAXONOMY_CACHE_DIR',  value: '/mnt/staging-state/cache' }
  // Routes all class-A writes (flags, config, calibration, keys) to isolated mount
  { name: 'AI_TRIAD_STATE_ROOT', value: '/mnt/staging-state' }
  // t/4264 / t/2643 SO (e/307#6): without this, AnonymousSessionStore.defaultBaseDir()
  // falls back to /mnt/shared/anon-sessions and staging's own TTL/maxSessions eviction
  // runs over PROD's anonymous session files. Isolates it like the two overrides above.
  { name: 'ANON_SESSION_DIR',    value: '/mnt/staging-state/anon-sessions' }
  // github-api writes go to the staging branch, not main (t/2650 class-B isolation)
  { name: 'GITHUB_BRANCH',       value: 'staging' }
  // t/4446 C1: BRANCH_PREFIX was a hardcoded constant shared with prod, so a user signed into
  // both environments wrote the SAME api-session/* branch in the prod data repo -- the actual
  // live exposure the SO found (t/4446#5), broader than the already-closed direct-write-to-main
  // path above. Staging gets its own prefix; prod stays on the code default ('api-session/').
  { name: 'SESSION_BRANCH_PREFIX', value: 'staging-api-session/' }
  // t/4406: staging's OWN origin. Inheriting baseEnv's (prod's) value made staging send prod's host
  // as its CORS access-control-allow-origin and treat prod's origin as allowed. Hygiene only: it did
  // NOT block same-origin staging requests (the guard passes Origin host == Host before reading this
  // list; Host is preserved through ingress, probed t/4406#3) and is NOT the staging sign-in bounce.
  // Host MUST match the staging app's name below; tests/BicepAllowedOrigins.Tests.ps1 asserts it.
  { name: 'ALLOWED_ORIGINS',     value: 'https://taxonomy-editor-staging.${containerAppEnv.properties.defaultDomain}' }
  // NOTE: DATA_ROOT_VALIDATION_ENFORCE was retired in t/3309 step-3 (see baseEnv above) — the
  // /readyz warm-gate replaces the boot hard-fail. Nothing to override here.
  // NOTE: S2 (GROUNDING_RECONCILE_INLINE=0 override) DROPPED per TL (e/327#5) — G8a is gated by
  // the grounding_reconcile_inline feature flag, OFF, and has never run; the env var is inert and
  // is being removed entirely from hosted baseEnv/the deploy gate in #3431 instead.
]
// stagingBaseEnv = baseEnv with the isolation overrides applied.
// filter() removes the baseEnv entries that stagingEnvOverrides supersedes.
var stagingBaseEnv = concat(
  filter(baseEnv, e => e.name != 'TAXONOMY_CACHE_DIR' && e.name != 'GIT_SYNC_ENABLED' && e.name != 'ALLOWED_ORIGINS'),
  stagingEnvOverrides
)
// Rebuild the secret chain for staging — mirrors the prod chain so staging
// is a faithful pre-prod proxy (same oauth/ai secrets, different write path).
var stagingEnvWithToken = githubTokenProvided
  ? concat(stagingBaseEnv, [ { name: 'GITHUB_TOKEN', secretRef: githubTokenSecretName } ])
  : stagingBaseEnv
var stagingEnvWithWebhook = githubWebhookSecretProvided
  ? concat(stagingEnvWithToken, [ { name: 'GITHUB_WEBHOOK_SECRET', secretRef: githubWebhookSecretName } ])
  : stagingEnvWithToken
var stagingEnvWithFreeTier = freeTierEnabled
  ? concat(stagingEnvWithWebhook, [ { name: 'FREE_TIER_GEMINI_KEY', secretRef: freeTierSecretName } ])
  : stagingEnvWithWebhook
var stagingContainerEnv = paidTierEnabled
  ? concat(stagingEnvWithFreeTier, [ { name: 'GEMINI_PAID_KEY', secretRef: paidTierSecretName } ])
  : stagingEnvWithFreeTier

// API 2025-01-01 (was 2024-03-01): first GA version whose Scale type has cooldownPeriod (t/4249).
resource containerApp 'Microsoft.App/containerApps@2025-01-01' = {
  name: 'taxonomy-editor'
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    managedEnvironmentId: containerAppEnv.id
    configuration: {
      activeRevisionsMode: 'Multiple'
      // t/2050: retain recent inactive revisions so a rollback / forensic target
      // survives ACA garbage collection. The t/2047 outage's auto-rollback was a
      // no-op because the prior good revision had been GC'd. 10 keeps roughly a
      // sprint of history at negligible cost (inactive revisions run no replicas).
      maxInactiveRevisions: 10
      ingress: {
        external: true
        targetPort: 7862
        transport: 'auto' // supports both HTTP and WebSocket
        allowInsecure: false
        // t/2049: hold 100% traffic on an explicit, already-live revision so this
        // apply never auto-promotes a new one (see the trafficPinRevisionName
        // param header). Empty pin -> latest@100 (first/only deploy).
        traffic: empty(trafficPinRevisionName)
          ? [ { latestRevision: true, weight: 100 } ]
          : [ { revisionName: trafficPinRevisionName, weight: 100 } ]
      }
      secrets: oauthSecrets
    }
    template: {
      containers: [
        {
          name: 'taxonomy-editor'
          image: containerImage
          resources: {
            // 1.5 vCPU / 3Gi by PI decision (t/4263, 2026-10-19), overriding the 2 vCPU
            // worker floor of t/3182 / t/2977 C1. That floor was justified as "Cost ~$0
            // (free grant)"; in fact always-on 2 vCPU / 4Gi is well over the $30 budget
            // (deploy/azure/runbooks/cost-investigation-2026-10.md).
            // NOT 1.0/2Gi: the C1b test (t/4263#5) failed it — the synthetic-embeddings
            // serialize blocked the loop 3.8s and 500'd, novel embeds starved, and a full
            // serialize peaks ~2.0 GiB (more than a 2Gi limit). The bar is "no worse than
            // 2.0/4Gi", and 1.5/3Gi met it (2.0's 2,076 MiB serialize peak is 68% of 3Gi). The serialize
            // loop-block (t/4286) and the 45s novel-embed chunk budget (t/4287) fail at 2.0
            // too; they are code fixes, not sizing. Before raising back to 2.0, check
            // alert-event-loop-blocked / ingress-5xx history.
            // Memory MUST match the fixed ACA Consumption pair: 1.5 vCPU is valid ONLY
            // with 3.0Gi (Test-BicepAcaResourcePairs.ps1; the #1771 ARM-rejection bug).
            //
            // t/4203 SO C1: these are the prodCpu/prodMemory vars (single source of truth),
            // not independent literals — whoever changes prod's size (this PR) edits the var
            // near the top of this file, not this line, so stagingLoadTestSize stays correct.
            cpu: json(prodCpu)
            memory: prodMemory
          }
          env: containerEnv
          probes: [
            {
              type: 'Liveness'
              // /health, NOT /healthz (t/4176 incident, 2026-10-13): /healthz is the DATA-LOADED
              // signal and returns 503 'warming' until the data load finishes. As a liveness path
              // it killed any replica whose warm-up took longer than 3 x 30s, and at 5 replicas
              // warming at once every replica crash-looped ("failed liveness probe, will be
              // restarted"), users got the "Taxonomy data not found" page whenever no replica was
              // ready. Liveness = process alive (dataRootReadiness.ts design note); readiness
              // (/healthz, below) still keeps traffic off a replica until its data is loaded.
              // /health is served by the same event loop, so the loop-block deadline below holds.
              httpGet: { path: '/health', port: 7862 }
              periodSeconds: 30
              failureThreshold: 3
              // timeoutSeconds made EXPLICIT (was defaulting to ACA's ~1s). This is
              // the DETERMINISTIC liveness deadline the storm-replay canary gates on
              // (t/3182/t/3199, Diagnostics p/168#13): /healthz can't answer while the
              // event loop is ONNX-blocked, so a loop-block > this timeout fails
              // liveness → 503/kill. The worker-offload must keep p99 loop-lag under
              // this with margin. Explicit (not defaulted) so the pass line is a
              // documented value, not a silent platform default. 1s preserves current
              // prod behavior (the ACA default) — it does NOT loosen liveness.
              timeoutSeconds: 1
            }
            {
              type: 'Readiness'
              httpGet: { path: '/healthz', port: 7862 }
              periodSeconds: 10
              failureThreshold: 3
            }
            {
              type: 'Startup'
              httpGet: { path: '/health', port: 7862 }
              periodSeconds: 10
              failureThreshold: 30
            }
          ]
          volumeMounts: [
            // Shared persistent Azure Files mount — survives revision/replica
            // restarts and is visible to ALL replicas (not an ephemeral
            // per-replica emptyDir). Backs replica-independent anonymous
            // session storage (t/683); the server writes session files under
            // <mountPath>/anon-sessions/.
            {
              volumeName: 'shared-data'
              mountPath: '/mnt/shared'
            }
          ]
        }
      ]
      volumes: [
        {
          name: 'shared-data'
          storageType: 'AzureFile'
          // References the managed-environment storage 'taxonomy-data'
          // (Azure Files share on staitriadkvwl3nywge4iw, accessMode ReadWrite).
          storageName: 'taxonomy-data'
        }
      ]
      scale: {
        // Scale-out restored after t/683 (ed489b9): AnonymousSessionStore is now
        // file-backed on the shared /mnt/shared volume — AnonymousSessionStore
        // (debate/session state) IS replica-independent. Job stores and the allowlist
        // cache are replica-safe since t/4177; see the maxReplicas cap below.
        // minReplicas reverted 1->0 (t/1354, 2026-07-07): prod was costing
        // ~$24 in its first 6 days of July alone (~$120+/mo projected) from
        // running 1 vCPU/2GiB continuously. Owner accepted the cold-start
        // latency tradeoff this reintroduces (previously fixed for the same
        // reason in e247ef75, 2026-05-05) in exchange for scale-to-zero savings.
        minReplicas: 0
        // t/4249 cost: scale to zero after 120s with no HTTP requests (ACA default 300s).
        // Each wake bills at least this long. Re-landed after t/4258: on SIGTERM the server
        // flushes every pending overlay commit (shutdownOverlayFlush.ts, 40s deadline),
        // inside the 60s terminationGracePeriodSeconds below.
        cooldownPeriod: 120
        // Explicit at the live value: under API 2025-01-01, omitting it shows as a what-if Delete (SO C1, #3579).
        pollingInterval: 30
        // maxReplicas capped at 1 (t/4176 incident, 2026-10-13: back from 5 to 1).
        // NOTE: the phrase "maxReplicas capped at" on this line is load-bearing —
        // Test-InMemoryJobStoreScaleGuard.ps1 uses it as a regex anchor to locate
        // the maxReplicas value. Do not edit this comment string without updating the gate.
        // Why 1: at 5, copies starting together each fetched their data from GitHub, drew
        // refusals ("non-ok response", "circuit open"), failed the data-loaded probe and were
        // restarted in a loop — production went down 10:00-10:28Z. The job stores ARE
        // replica-safe (t/4177); what's missing is a startup that doesn't depend on GitHub
        // per copy. Raise again only after: liveness on /health (this PR), the refusal type
        // confirmed, startup reading the shared cache (or the t/4179 lease), and a monitored
        // 2-copy test. MUST equal MAX_REPLICAS in baseEnv (t/4177, t/4178).
        maxReplicas: 1
        rules: [
          {
            name: 'http-scaler'
            http: { metadata: { concurrentRequests: '10' } }
          }
        ]
      }
      terminationGracePeriodSeconds: 60
    }
  }
}

// ── Staging Container App ──
// Separate app for staging deploys — shares the environment and storage but
// runs independently so a bad staging deploy cannot affect production.

resource containerAppStaging 'Microsoft.App/containerApps@2025-01-01' = {
  name: 'taxonomy-editor-staging'
  location: location
  tags: union(tags, { environment: 'staging' })
  identity: {
    type: 'SystemAssigned'
  }
  // storageName strings create no implicit dependency — explicit dependsOn ensures
  // both managed env storage registrations exist before the container app is deployed.
  dependsOn: [envStorageStagingState, envStorageSharedRO]
  properties: {
    managedEnvironmentId: containerAppEnv.id
    configuration: {
      activeRevisionsMode: 'Multiple'
      // t/2050: retain recent inactive revisions (see prod app comment).
      maxInactiveRevisions: 10
      ingress: {
        external: true
        targetPort: 7862
        transport: 'auto'
        allowInsecure: false
        // t/2049: hold 100% staging traffic on an explicit live revision so a
        // Bicep apply never auto-promotes a new one. Empty -> latest@100.
        traffic: empty(trafficPinRevisionNameStaging)
          ? [ { latestRevision: true, weight: 100 } ]
          : [ { revisionName: trafficPinRevisionNameStaging, weight: 100 } ]
      }
      secrets: oauthSecrets
    }
    template: {
      containers: [
        {
          name: 'taxonomy-editor'
          image: containerImage
          // t/4203: prod-size only while stagingLoadTestSize=true, for the t/4180 load test to
          // run at a representative size. Defaults back to staging's normal small footprint on
          // the very next ordinary deploy. SO C1 (p/682#44, e/307#2): reads prodCpu/prodMemory
          // rather than a hardcoded 2.0/4Gi, so the load test always matches prod's CURRENT
          // size — if prod's own resources change (e.g. t/4263), this follows automatically.
          resources: stagingLoadTestSize
            ? { cpu: json(prodCpu), memory: prodMemory }
            : { cpu: json('0.25'), memory: '0.5Gi' }
          env: stagingContainerEnv
          probes: [
            {
              type: 'Startup'
              httpGet: { path: '/health', port: 7862 }
              periodSeconds: 5
              failureThreshold: 10
            }
          ]
          volumeMounts: [
            // Shared grounding data (taxonomy, embeddings) — read-only after
            // getStateRoot() is live (t/2643 step 3; RO flip is a follow-up deploy).
            {
              volumeName: 'shared-data'
              mountPath: '/mnt/shared'
            }
            // Staging-isolated writable state: class-A writes (flags, config,
            // calibration, keys) land here, never on the shared /mnt/shared (t/2643).
            {
              volumeName: 'staging-state'
              mountPath: '/mnt/staging-state'
            }
          ]
        }
      ]
      volumes: [
        {
          name: 'shared-data'
          storageType: 'AzureFile'
          // RO flip (step 3): deploy with stagingSharedReadOnly=true AFTER arm-B
          // confirms class-A writes route to /mnt/staging-state. The -ro registration
          // (ReadOnly accessMode) makes the hard boundary live: any missed write site
          // fails with EACCES rather than silently mutating prod (t/2643#3 cond 3,
          // t/2643#5 binding correction — RO must come last, never before getStateRoot).
          //
          // t/4203 SO C3 (p/682#44): coupled to stagingLoadTestSize too — without this,
          // 3 load-test replicas mount PROD's own taxonomy-data share RW, making the load
          // test itself a write load against production storage. Confirming staging runs
          // correctly against RO shared data is exactly the open t/2643 arm-B question, so
          // this also doubles as that verification once a load test actually runs.
          storageName: (stagingSharedReadOnly || stagingLoadTestSize) ? 'taxonomy-data-ro' : 'taxonomy-data'
        }
        {
          // Staging-isolated RW share for class-A state (t/2643).
          name: 'staging-state'
          storageType: 'AzureFile'
          storageName: 'taxonomy-data-staging'
        }
      ]
      scale: {
        minReplicas: 0
        // t/4203: max 3 with an HTTP scale rule only while stagingLoadTestSize=true, so the
        // t/4180 load test can observe real multi-replica behavior (job-poll 404s, limiter
        // totals, GitHub calls per startup). Reverts to 1/no-rule on the next ordinary deploy —
        // same parameter, same reasoning as the resources block above.
        maxReplicas: stagingLoadTestSize ? 3 : 1
        // t/4249: match prod's 120s scale-to-zero cooldown (ACA default 300s).
        cooldownPeriod: 120
        pollingInterval: 30
        rules: stagingLoadTestSize
          ? [
              {
                name: 'http-scaler'
                http: { metadata: { concurrentRequests: '10' } }
              }
            ]
          : []
      }
      // t/4249 (DevOps Lead review of #3579): explicit, matching prod. Unset, ACA uses 30s,
      // shorter than the 40s SIGTERM overlay flush deadline (shutdownOverlayFlush.ts, t/4258).
      terminationGracePeriodSeconds: 60
    }
  }
}

// ── Role assignment: container app → Key Vault ──
// Grants 'Key Vault Secrets Officer' (get/set/delete secrets) to the
// container app's system-assigned managed identity on this vault only.

var kvSecretsOfficerRoleId = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'

resource kvRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: keyVault
  name: guid(keyVault.id, containerApp.id, kvSecretsOfficerRoleId)
  properties: {
    principalId: containerApp.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', kvSecretsOfficerRoleId)
  }
}

// Staging gets read-only Key Vault access (Secrets User, not Officer)
// to prevent staging from modifying production user secrets (H5).
var kvSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'

resource kvRoleAssignmentStaging 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: keyVault
  name: guid(keyVault.id, containerAppStaging.id, kvSecretsUserRoleId)
  properties: {
    principalId: containerAppStaging.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', kvSecretsUserRoleId)
  }
}

// ── Role assignment: container apps → Blob Storage ──
// Grants 'Storage Blob Data Contributor' (read/write/delete blobs) to both
// prod and staging container apps via their system-assigned managed identities.

var blobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'

resource blobRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storageAccount
  name: guid(storageAccount.id, containerApp.id, blobDataContributorRoleId)
  properties: {
    principalId: containerApp.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobDataContributorRoleId)
  }
}

// Staging blob access scoped to staging-specific containers only (H5).
// Prevents staging from reading/writing production user data.
resource blobRoleAssignmentStagingUserContent 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: stagingUserContentContainer
  name: guid(stagingUserContentContainer.id, containerAppStaging.id, blobDataContributorRoleId)
  properties: {
    principalId: containerAppStaging.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobDataContributorRoleId)
  }
}

resource blobRoleAssignmentStagingCommunity 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: stagingCommunityContainer
  name: guid(stagingCommunityContainer.id, containerAppStaging.id, blobDataContributorRoleId)
  properties: {
    principalId: containerAppStaging.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobDataContributorRoleId)
  }
}

// t/2701: analytics was missing — staging app had no Storage Blob Data Contributor on staging-analytics.
resource blobRoleAssignmentStagingAnalytics 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: stagingAnalyticsContainer
  name: guid(stagingAnalyticsContainer.id, containerAppStaging.id, blobDataContributorRoleId)
  properties: {
    principalId: containerAppStaging.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobDataContributorRoleId)
  }
}

// ── Authentication (Easy Auth for Container Apps) ──
// Enables /.auth/login/<provider> endpoints. On successful OAuth, Azure injects
// X-MS-CLIENT-PRINCIPAL-* headers into requests to the container. The server
// (src/server/server.ts) reads those headers and gates access via
// authorized-users.json.
//
// unauthenticatedClientAction: 'AllowAnonymous' — we don't auto-redirect because
// the server renders its own login picker (multi-provider), then the picker
// buttons link to /.auth/login/google or /.auth/login/github.

resource authConfig 'Microsoft.App/containerApps/authConfigs@2024-10-02-preview' = {
  parent: containerApp
  name: 'current'
  properties: {
    platform: {
      enabled: true
    }
    globalValidation: {
      unauthenticatedClientAction: 'AllowAnonymous'
    }
    identityProviders: {
      google: {
        enabled: googleEnabled
        registration: {
          clientId: googleClientId
          clientSecretSettingName: googleClientSecretName
        }
        validation: {
          allowedAudiences: []
        }
      }
      gitHub: {
        enabled: githubEnabled
        registration: {
          clientId: githubClientId
          clientSecretSettingName: githubClientSecretName
        }
      }
      azureActiveDirectory: {
        enabled: aadEnabled
        registration: {
          clientId: aadClientId
          clientSecretSettingName: aadClientSecretName
          #disable-next-line no-hardcoded-env-urls
          openIdIssuer: 'https://login.microsoftonline.com/${aadIssuer}/v2.0'
        }
      }
    }
    login: {
      routes: {
        logoutEndpoint: '/.auth/logout'
      }
      allowedExternalRedirectUrls: [
        'https://${containerApp.properties.configuration.ingress.fqdn}'
      ]
      preserveUrlFragmentsForLogins: false
      tokenStore: {
        // No blob storage backing is configured. enabled:true causes Easy Auth to use
        // in-memory token storage that is lost on replica recycle → HTTP 500 for signed-in
        // users (prod incident 2026-10-08). Stateless cookie validation requires no backing
        // store and survives replica recycling.
        enabled: false
      }
    }
  }
}

// ── Authentication — Staging (Easy Auth for containerAppStaging) ──
// Mirrors the prod authConfig above. Identical identity-provider wiring so
// staging is a faithful pre-prod OAuth proxy.
//
// Part 2 (human gate, t/2695): Before deploying this resource, register the
// staging callback URIs with each provider:
//   Google:  https://<staging-fqdn>/.auth/login/google/callback
//   GitHub:  https://<staging-fqdn>/.auth/login/github/callback
//   AAD:     https://<staging-fqdn>/.auth/login/aad/callback
// The FQDN can be read from containerAppStaging.properties.configuration.ingress.fqdn
// after a deploy or via: az containerapp show -n taxonomy-editor-staging -g ai-triad --query properties.configuration.ingress.fqdn
//
// The authConfig can land and CI-green independently of Part 2; the deploy step
// waits for the URIs to be registered (unauthenticated staging remains accessible
// since unauthenticatedClientAction='AllowAnonymous').

resource authConfigStaging 'Microsoft.App/containerApps/authConfigs@2024-10-02-preview' = {
  parent: containerAppStaging
  name: 'current'
  properties: {
    platform: {
      enabled: true
    }
    globalValidation: {
      unauthenticatedClientAction: 'AllowAnonymous'
    }
    identityProviders: {
      google: {
        enabled: googleEnabled
        registration: {
          clientId: googleClientId
          clientSecretSettingName: googleClientSecretName
        }
        validation: {
          allowedAudiences: []
        }
      }
      gitHub: {
        enabled: githubEnabled
        registration: {
          clientId: githubClientId
          clientSecretSettingName: githubClientSecretName
        }
      }
      azureActiveDirectory: {
        enabled: aadEnabled
        registration: {
          clientId: aadClientId
          clientSecretSettingName: aadClientSecretName
          #disable-next-line no-hardcoded-env-urls
          openIdIssuer: 'https://login.microsoftonline.com/${aadIssuer}/v2.0'
        }
      }
    }
    login: {
      routes: {
        logoutEndpoint: '/.auth/logout'
      }
      allowedExternalRedirectUrls: [
        'https://${containerAppStaging.properties.configuration.ingress.fqdn}'
      ]
      preserveUrlFragmentsForLogins: false
      tokenStore: {
        // Same fix as prod: no blob backing, so stateless cookie validation.
        enabled: false
      }
    }
  }
}

// ── Budget Alert ──
// Monthly Azure cost budget for this resource group (t/4181). PI set the limit to $30/month on 2026-10-15
// (was $5 since t/3155). Alerts at 50% and 80% actual, 100% actual, and 100% FORECAST, so an overrun is
// flagged mid-month while there is still time to act, not only after the money is spent.
// Gemini spend on the operator pool keys is billed outside Azure and is not in this budget.

@description('Monthly Azure cost limit for the resource group, in USD (PI, 2026-10-15).')
param monthlyBudgetUsd int = 30

@description('Email address for budget alerts')
param budgetAlertEmail string = ''

@description('IMMUTABLE start date of budget-aitriad-monthly, pinned to its original creation month (2026-08-01). Azure Consumption Budgets FORBID updating startDate in place ("Start date of budgets cannot be updated"), so this MUST NOT be recomputed per-deploy with utcNow() — doing so rolls the date forward each month and fails every deploy in a later month (t/3155). For a brand-new environment with no existing budget, override this param to the first of the current month at create time.')
param budgetStartDate string = '2026-08-01'

var budgetAlertConfigured = !empty(budgetAlertEmail)

resource budget 'Microsoft.Consumption/budgets@2023-11-01' = if (budgetAlertConfigured) {
  name: 'budget-aitriad-monthly'
  properties: {
    category: 'Cost'
    amount: monthlyBudgetUsd
    timeGrain: 'Monthly'
    timePeriod: {
      startDate: budgetStartDate
    }
    notifications: {
      warning50: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 50
        contactEmails: [ budgetAlertEmail ]
      }
      warning80: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 80
        contactEmails: [ budgetAlertEmail ]
      }
      limit100: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 100
        contactEmails: [ budgetAlertEmail ]
      }
      forecast100: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 100
        thresholdType: 'Forecasted'
        contactEmails: [ budgetAlertEmail ]
      }
    }
  }
}

// ── Container Restart Loop Alert ──
// Fires when a revision has 5+ restart events in 10 minutes.
// Uses the Log Analytics workspace connected to the Container Apps Environment.

resource restartAlertActionGroup 'Microsoft.Insights/actionGroups@2023-09-01-preview' = if (budgetAlertConfigured) {
  name: 'ag-aitriad-restart-alert'
  location: 'global'
  tags: tags
  properties: {
    groupShortName: 'RestartLoop'
    enabled: true
    emailReceivers: budgetAlertConfigured ? [
      { name: 'owner', emailAddress: budgetAlertEmail, useCommonAlertSchema: true }
    ] : []
  }
}

// t/4426 SO C1: the 10-13 incident (t/4176, OOM-kill) produced Reason_s=="Error" x16 — it never
// produced a ContainerBackOff/ImagePullBackOff burst. Backtested over 30d prod logs:
// BackOff/ImagePullBackOff alone never exceeds 3 events total (never fires); adding "Error" fires
// EXACTLY once, 17 events at 2026-10-13T10:10Z (the real incident), and nowhere else. Dropping
// StoppingContainer (t/4426's original fix, still correct — it's deploy churn, not a crash signal)
// without adding Error would have made this alert blind to the one incident it exists to catch.
//
// t/4426 SO C2: ContainerAppName_s is injected via replace() from containerApp.name, the single
// source of truth, instead of a second hardcoded "taxonomy-editor" literal — a future rename of
// the prod app can't silently blind this alert the way two independent literals could.
var restartLoopQuery = replace('''
  ContainerAppSystemLogs_CL
  | where ContainerAppName_s == "__APP_NAME__"
  | where Reason_s in ("ContainerBackOff", "ImagePullBackOff", "Error")
  | summarize RestartCount = count() by RevisionName_s
  | where RestartCount > 5
''', '__APP_NAME__', containerApp.name)

resource restartLoopAlert 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: 'alert-restart-loop'
  location: location
  tags: tags
  properties: {
    displayName: 'taxonomy-editor PROD — Restart Loop Detected'
    // t/4426: was unscoped (any app) and counted StoppingContainer, which every deploy emits —
    // 38h of data showed 12 prod StoppingContainer events (all deploy churn, 0 real backoffs)
    // plus staging canary/test-revision crash loops, both firing this as if they were prod.
    // Scoped to the prod app (see restartLoopQuery above) + Error added back (SO C1) + dropping
    // StoppingContainer leaves the real crash-loop signals: ContainerBackOff, ImagePullBackOff, Error.
    description: 'Fires when the PRODUCTION container revision crash-loops (ContainerBackOff/ImagePullBackOff/Error, e.g. OOM-kill) 5+ times in 10 minutes. Scoped to prod only — staging crash loops do not page this (t/4426).'
    severity: 1
    enabled: true
    scopes: [ logAnalytics.id ]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT10M'
    criteria: {
      allOf: [
        {
          query: restartLoopQuery
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
        }
      ]
    }
    actions: {
      actionGroups: budgetAlertConfigured ? [ restartAlertActionGroup.id ] : []
    }
  }
}

// ── Image Pull Failure Alert ──
// Fires on any ImagePullBackOff event — severity 0 (critical) because this is
// a hard-down scenario (no app container starts). Added after the 2026-07-05
// outage where an expired GHCR PAT caused ImagePullBackOff on replica recycle.

resource imagePullFailureAlert 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: 'alert-image-pull-failure'
  location: location
  tags: tags
  properties: {
    displayName: 'Image Pull Failure (Critical)'
    description: 'Container image cannot be pulled. App is hard-down. Check GHCR package visibility and registry config.'
    severity: 0
    enabled: true
    scopes: [ logAnalytics.id ]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT10M'
    criteria: {
      allOf: [
        {
          // ACA's own diagnostic logs never emit the raw Kubernetes reason
          // string "ImagePullBackOff" — verified against the 2026-07-05 GHCR
          // PAT outage, which produced Reason_s "ContainerBackOff" /
          // "ContainerCrashing" with Log_s describing the pull failure.
          query: '''
            ContainerAppSystemLogs_CL
            | where Reason_s in ("ContainerBackOff", "ContainerCrashing")
            | where Log_s has "pull"
            | summarize Count = count() by RevisionName_s
            | where Count > 0
          '''
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
        }
      ]
    }
    actions: {
      actionGroups: budgetAlertConfigured ? [ restartAlertActionGroup.id ] : []
    }
  }
}

// ── GitHub API Alerts ──
// Alert rules for the GitHub API-first data layer.
// All use the same action group and Log Analytics workspace as the restart alert.

resource rateLimitWarning 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: 'alert-github-rate-limit-warning'
  location: location
  tags: tags
  properties: {
    displayName: 'GitHub API Rate Limit Warning'
    description: 'Rate limit remaining below 1,000 within a 15-minute window. At 145 calls/hr typical, this indicates unusual consumption.'
    severity: 2
    enabled: true
    scopes: [ logAnalytics.id ]
    // t/4248 cost: PT5M -> PT15M eval (log-alert price is per-rule by frequency).
    evaluationFrequency: 'PT15M'
    windowSize: 'PT15M'
    criteria: {
      allOf: [
        {
          query: '''
            ContainerAppConsoleLogs_CL
            | where Log_s contains "github.api.rate_limit"
            | where Log_s contains "remaining"
            | extend remaining = toint(extract("remaining.:(\\d+)", 1, Log_s))
            | where remaining < 1000
          '''
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
        }
      ]
    }
    actions: {
      actionGroups: budgetAlertConfigured ? [ restartAlertActionGroup.id ] : []
    }
  }
}

resource rateLimitCritical 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: 'alert-github-rate-limit-critical'
  location: location
  tags: tags
  properties: {
    displayName: 'GitHub API Rate Limit Critical'
    description: 'Rate limit below 500 or 429 response received. Polling disabled, serving from cache only.'
    severity: 1
    enabled: true
    scopes: [ logAnalytics.id ]
    // t/4248 cost: PT1M -> PT5M eval (log-alert price is per-rule by frequency).
    evaluationFrequency: 'PT5M'
    windowSize: 'PT5M'
    criteria: {
      allOf: [
        {
          query: '''
            ContainerAppConsoleLogs_CL
            | where Log_s contains "github.api.error" and Log_s contains "429"
              or (Log_s contains "github.api.rate_limit" and Log_s contains "degraded")
          '''
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
        }
      ]
    }
    actions: {
      actionGroups: budgetAlertConfigured ? [ restartAlertActionGroup.id ] : []
    }
  }
}

resource aadstsConfigErrorAlert 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: 'alert-aadsts-config-error'
  location: location
  tags: tags
  properties: {
    displayName: 'AADSTS Config Error (sev-1)'
    description: 'A config-class AADSTS error (bad/expired client secret, app not found, app disabled, reply-URL mismatch) in the Easy Auth sidecar logs within 10 minutes — e.g. the 2026-10-19 invalid-client-secret incident (t/4288). These codes are ops-caused, never user-caused, so this is sev-1. Split by ContainerAppName_s (t/4288 SO review, e/318 A1) so prod and staging page independently — a staging-only config error should not look like a prod sev-1, or vice versa.'
    severity: 1
    enabled: true
    scopes: [ logAnalytics.id ]
    evaluationFrequency: 'PT10M'
    windowSize: 'PT10M'
    criteria: {
      allOf: [
        {
          // Config-class error_codes only (SO e/318 A1): 7000215 (invalid client secret),
          // 7000222 (expired secret), 700016 (app not found in tenant), 7000112 (app disabled),
          // 50011/500113 (reply URL mismatch). Deliberately narrower than the broad \d+ regex
          // below — these are the codes an operator caused and must act on immediately.
          query: '''
            ContainerAppConsoleLogs_CL
            | where ContainerName_s == "http-auth"
            | where Log_s matches regex @"AADSTS(7000215|7000222|700016|7000112|50011|500113)\b"
            | summarize Count = count() by ContainerAppName_s
          '''
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          dimensions: [
            {
              name: 'ContainerAppName_s'
              operator: 'Include'
              values: [ '*' ]
            }
          ]
        }
      ]
    }
    actions: {
      actionGroups: budgetAlertConfigured ? [ restartAlertActionGroup.id ] : []
    }
  }
}

resource aadstsAnyErrorAlert 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: 'alert-aadsts-any-error'
  location: location
  tags: tags
  properties: {
    displayName: 'AADSTS Any Error (sev-3)'
    description: 'Any AADSTS error at all in the Easy Auth sidecar logs within 10 minutes, including user-caused codes (e.g. 50020 account issue, 65001 consent required, 50126 bad credentials). Sev-3 (not sev-1): these are routine and often user-side, not an operator page — kept as a broader backstop/trend signal. Split by ContainerAppName_s, same rationale as alert-aadsts-config-error.'
    severity: 3
    enabled: true
    scopes: [ logAnalytics.id ]
    evaluationFrequency: 'PT10M'
    windowSize: 'PT10M'
    criteria: {
      allOf: [
        {
          query: '''
            ContainerAppConsoleLogs_CL
            | where ContainerName_s == "http-auth"
            | where Log_s matches regex @"AADSTS\d+"
            | summarize Count = count() by ContainerAppName_s
          '''
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          dimensions: [
            {
              name: 'ContainerAppName_s'
              operator: 'Include'
              values: [ '*' ]
            }
          ]
        }
      ]
    }
    actions: {
      actionGroups: budgetAlertConfigured ? [ restartAlertActionGroup.id ] : []
    }
  }
}

resource apiErrorSpike 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: 'alert-github-api-error-spike'
  location: location
  tags: tags
  properties: {
    displayName: 'GitHub API Error Spike'
    description: 'More than 15 GitHub API errors in 15 minutes (same rate as the former 5 in 5 min). May indicate GitHub outage or auth failure.'
    severity: 1
    enabled: true
    scopes: [ logAnalytics.id ]
    // t/4248 cost: PT5M -> PT15M eval (log-alert price is per-rule by frequency).
    evaluationFrequency: 'PT15M'
    windowSize: 'PT15M'
    criteria: {
      allOf: [
        {
          query: '''
            ContainerAppConsoleLogs_CL
            | where Log_s contains "github.api.error"
            | summarize ErrorCount = count()
            | where ErrorCount > 15
          '''
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
        }
      ]
    }
    actions: {
      actionGroups: budgetAlertConfigured ? [ restartAlertActionGroup.id ] : []
    }
  }
}

resource cacheDegraded 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: 'alert-cache-degraded'
  location: location
  tags: tags
  properties: {
    displayName: 'Cache Hit Rate Degraded'
    description: 'Cache hit rate below 85% over 15 minutes. Indicates excessive cache misses — possible invalidation storm or cache corruption.'
    severity: 2
    enabled: true
    scopes: [ logAnalytics.id ]
    // t/4248 cost: PT5M -> PT15M eval (log-alert price is per-rule by frequency).
    evaluationFrequency: 'PT15M'
    windowSize: 'PT15M'
    criteria: {
      allOf: [
        {
          query: '''
            ContainerAppConsoleLogs_CL
            | where Log_s contains "cache.miss"
            | summarize Misses = count()
            | where Misses > 150
          '''
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
        }
      ]
    }
    actions: {
      actionGroups: budgetAlertConfigured ? [ restartAlertActionGroup.id ] : []
    }
  }
}

resource fallbackActive 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: 'alert-fallback-active'
  location: location
  tags: tags
  properties: {
    displayName: 'Fallback Data Active'
    description: 'App served from baked fallback data within the last 15 minutes. GitHub API is likely unreachable.'
    severity: 1
    enabled: true
    scopes: [ logAnalytics.id ]
    // t/4248 cost: PT5M -> PT15M eval (log-alert price is per-rule by frequency).
    evaluationFrequency: 'PT15M'
    windowSize: 'PT15M'
    criteria: {
      allOf: [
        {
          query: '''
            ContainerAppConsoleLogs_CL
            | where Log_s contains "storage.fallback"
            | summarize FallbackCount = count()
            | where FallbackCount > 0
          '''
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
        }
      ]
    }
    actions: {
      actionGroups: budgetAlertConfigured ? [ restartAlertActionGroup.id ] : []
    }
  }
}

// ── Arm-2 Worker-Queue Saturation Alert (t/3372; trigger for the K=2/Dedicated migration, t/3211) ──
// Fires on SUSTAINED novel-embed load-shed: the K-slot embedding pool rejected enqueues past its
// dynamic MAX_QUEUE_DEPTH×liveSlotCount cap (16 at K=1). Sustained sheds = organic demand crossed the
// ~20 texts/s bar the single worker can serve → the "add a worker / do the Dedicated-profile migration
// → K=2" trigger (t/3211; ServerAPI then verifies ≈2× throughput + flat main-loop delay). Consumption-
// compatible — a monitoring resource, no SKU/cost change.
//
// MATCH-TOKEN IS A CONTRACT: "embeddings worker-pool shed" is the clean STDOUT token (component:'api',
// subsystem:'ai-backends'; t/3373) emitted on a genuine worker-pool queue-shed (the 503; carries
// queueDepth/cap/liveSlots). Do NOT match the pool's flight-recorder-only "queue full" WARN — it never
// reaches stdout/Log_s, so a KQL match silently NEVER fires (the t/3110/t/3308 sink trap). This is the
// "already shedding" signal; the PRE-shed early-warning (the ticket's REAL trigger — fire before users
// feel the shed) is the sibling alert-worker-queue-nearcap below. >5 sheds / 15 min = sustained, not a burst.
resource workerQueueSaturation 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: 'alert-worker-queue-saturation'
  location: location
  tags: tags
  properties: {
    displayName: 'Embedding Worker Queue Saturation (K=2 migration trigger)'
    description: 'The K-slot embedding worker pool load-shed (503) past its queue cap repeatedly over 15 minutes — sustained novel-embed demand exceeding single-worker capacity. Trigger to evaluate the Dedicated-profile migration to K=2 (t/3211/t/3372). Paired with alert-worker-queue-nearcap (the pre-shed early-warning).'
    severity: 2
    enabled: true
    scopes: [ logAnalytics.id ]
    // t/4248 cost: PT5M -> PT15M eval (log-alert price is per-rule by frequency).
    evaluationFrequency: 'PT15M'
    windowSize: 'PT15M'
    criteria: {
      allOf: [
        {
          query: '''
            ContainerAppConsoleLogs_CL
            | where Log_s contains "embeddings worker-pool shed"
            | summarize Sheds = count()
            | where Sheds > 5
          '''
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
        }
      ]
    }
    actions: {
      actionGroups: budgetAlertConfigured ? [ restartAlertActionGroup.id ] : []
    }
  }
}

// ── Arm-2 Worker-Queue NEAR-CAP early-warning (t/3372/t/3373; the REAL t/3211 K=2 trigger) ──
// Fires BEFORE users feel the 503 (the ticket's real intent). ServerAPI's pool emits the stdout token
// when queue depth is SUSTAINED ≥75% of the dynamic MAX_QUEUE_DEPTH×liveSlotCount cap (t/3373); a paired
// "…recovered" INFO clears. Consumption-compatible (a monitoring resource, no SKU/cost change).
//
// MATCH-TOKEN IS A CONTRACT: "embeddings worker-pool queue depth high" (component:'api',
// subsystem:'embed-queue'; t/3373) — the near-cap gauge. Lower/sooner than the shed alert; on fire,
// evaluate the Dedicated-profile migration → K=2 while there's still headroom. >2 hits / 15 min.
resource workerQueueNearCap 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: 'alert-worker-queue-nearcap'
  location: location
  tags: tags
  properties: {
    displayName: 'Embedding Worker Queue Near Cap (pre-shed K=2 early-warning)'
    description: 'The K-slot embedding worker pool queue was sustained near its dynamic cap (>=75%) repeatedly over 15 minutes — pre-shed early warning that novel-embed demand is approaching single-worker capacity. Fires BEFORE the 503 load-shed; the real trigger to evaluate the Dedicated-profile migration to K=2 (t/3211/t/3372/t/3373).'
    severity: 2
    enabled: true
    scopes: [ logAnalytics.id ]
    // t/4248 cost: PT5M -> PT15M eval (log-alert price is per-rule by frequency).
    evaluationFrequency: 'PT15M'
    windowSize: 'PT15M'
    criteria: {
      allOf: [
        {
          query: '''
            ContainerAppConsoleLogs_CL
            | where Log_s contains "embeddings worker-pool queue depth high"
            | summarize NearCap = count()
            | where NearCap > 2
          '''
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
        }
      ]
    }
    actions: {
      actionGroups: budgetAlertConfigured ? [ restartAlertActionGroup.id ] : []
    }
  }
}

// ── G8b Grounding-Sweep Stall Alert (t/3279) ──
// Detects the failed-inline-then-cold edge: a G8a inline reconcile FAILED (emitting the stdout
// `log.server.warn 'inline grounding reconcile failed'` from groundingReconcileHook.ts → Log_s;
// condition 1 pre-verified) AND no `Grounding sweep complete` drained the backlog within N hours.
// Scoped to the REAL edge, NOT bare sweep-absence — under minReplicas=0, no-sweep-while-cold is
// benign (cold ⇒ no writes ⇒ no failures ⇒ correctly silent). Grace period: only failures OLDER
// than N are considered (a fresh failure's sweep may still come — TL GV t/3279#2, cond. 2).
// Correlation logic mirrors operations/devops/Get-SweepStallVerdict.ps1 (both arms unit-proven);
// the KQL is validated against real prod Log_s for ≥1 cycle before it's trusted (real-env-first).
//
// N = 2h (cond. 4): MUST exceed the 15-min sweep cadence with margin so one benign cold gap +
// container-warmth jitter can't trip it. windowSize 6h covers a failure + its 2h window + slack.
resource sweepStallAlert 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: 'alert-grounding-sweep-stall'
  location: location
  tags: tags
  properties: {
    displayName: 'G8b Grounding Sweep Stalled (failed inline reconcile un-swept > N)'
    description: 'A G8a inline grounding reconcile FAILED and no G8b sweep drained the backlog within N hours — grounding may be silently stale (the failed-inline-then-cold edge, t/3279).'
    severity: 2
    // DISABLED (t/4298). CORRECTED rationale (SO review, e/326#2 — my first version was wrong):
    // this query reads ContainerAppConsoleLogs_CL exclusively (Azure-only), so it only ever
    // covered the hosted (github-api profile) sweep. That sweep is unconditionally refused on
    // hosted (t/3333 guard), so the query's "no sweep complete within N hours of the failure"
    // condition can NEVER be satisfied there — meaning this does NOT "never fire": it fires on
    // EVERY inline-reconcile-failure log line on hosted, unconditionally. That's not a "sweep
    // stalled" signal (there's never a backstop to have stalled); it's a relabeled, always-firing
    // copy of "an inline failure happened," which is misleading under this alert's name/severity.
    // Disabling it is still correct, but for THIS reason, not the originally-stated one.
    // Re-enable only if hosted grounding via a CI-committed sweep (t/3333 Option A) lands.
    enabled: false
    scopes: [ logAnalytics.id ]
    evaluationFrequency: 'PT30M'
    windowSize: 'PT6H'
    criteria: {
      allOf: [
        {
          // Rows = inline-reconcile failures older than N with NO sweep-complete in [failTime, failTime+N].
          // k=1 cross-join is cheap: both markers are rare. Fire iff any such stale failure exists.
          query: '''
            let N = 2h;
            let sweeps = ContainerAppConsoleLogs_CL
              | where TimeGenerated > ago(6h)
              | where Log_s has "Grounding sweep complete"
              | project sweepTime = TimeGenerated, k = 1;
            ContainerAppConsoleLogs_CL
            | where TimeGenerated > ago(6h)
            | where Log_s has "inline grounding reconcile failed"
            | where TimeGenerated < ago(N)
            | project failTime = TimeGenerated, k = 1
            | join kind=leftouter (sweeps) on k
            | summarize sweptInWindow = countif(sweepTime >= failTime and sweepTime <= failTime + N) by failTime
            | where sweptInWindow == 0
          '''
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
        }
      ]
    }
    actions: {
      actionGroups: budgetAlertConfigured ? [ restartAlertActionGroup.id ] : []
    }
  }
}

// Paid Gemini fallback overflow (t/3110). The anon key pool is free-primary +
// single paid key as overflow-only fallback (t/3111); the default path is free,
// so paid-fallback usage should be ~0. Any sustained nonzero is a real operational
// signal that the free pool is under-provisioned or throttling — NOT steady-state
// cost. 60-min window distinguishes sustained overflow from a lone transient.
//
// MATCH-TOKEN IS A CONTRACT: the substring "Paid fallback succeeded" below is a
// shared marker that EVERY paid-fallback success emitter must include verbatim, or
// its overflow goes unmonitored. Emitters today: routes/ai.ts:187 (generate) ✓ and
// routes/ai.ts:232 (generate+search) — the search path must carry the same marker
// (t/3110 GV coverage-gap fix, ServerAPI). A mirror of this comment lives at each
// emitter. Change the token in one place → change it in all, or this alert silently
// misses the overflow it exists to catch (the t/3165 debate-search second front).
resource paidFallbackOverflow 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: 'alert-paid-fallback-overflow'
  location: location
  tags: tags
  properties: {
    displayName: 'Paid Gemini Fallback Overflow'
    description: 'The paid Gemini fallback key served a request (expected ~0 on the free-primary path). Sustained hits mean the free key pool is under-provisioned or throttling into billable overflow — consider adding a free key.'
    severity: 2
    enabled: true
    scopes: [ logAnalytics.id ]
    evaluationFrequency: 'PT15M'
    windowSize: 'PT1H'
    criteria: {
      allOf: [
        {
          query: '''
            ContainerAppConsoleLogs_CL
            | where Log_s contains "Paid fallback succeeded"
            | summarize PaidFallbacks = count()
            | where PaidFallbacks > 0
          '''
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
        }
      ]
    }
    actions: {
      actionGroups: budgetAlertConfigured ? [ restartAlertActionGroup.id ] : []
    }
  }
}

// Data-root boot validation WARN (t/3308 — observability backstop for the t/3296 warn-only default).
// server.ts validates taxonomy/ + dictionary/ are present & non-empty at boot via the ACTIVE backend.
// When DATA_ROOT_VALIDATION_ENFORCE is unset (default) a failed validation is WARN-only and the
// container KEEPS SERVING — empty panels with just a log line nobody watches. This alert is what makes
// warn-only safe: it fires on that WARN so a misprovisioned data root is never silent (the t/3110 trap,
// one layer up). Especially load-bearing until DATA_ROOT_VALIDATION_ENFORCE=1 lands in prod (t/3305) —
// until then this is the ONLY signal a prod revision is serving empty. Still useful for staging + any
// un-flagged env after ENFORCE lands (ENFORCE crash-loops visibly; this keeps catching the WARN).
//
// MATCH-TOKEN IS A CONTRACT: the substring "Data root validation failed at boot" is emitted by
// server.ts:1314 (ENFORCE → refuse-to-start error) and :1317 (WARN-only) — matching the shared prefix
// catches BOTH paths (a superset: any misprovisioned boot). Change that message prefix in server.ts →
// change it here, or a misprovisioned boot goes unmonitored (the paid-fallback-overflow lesson, t/3110).
resource dataRootBootWarn 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: 'alert-data-root-boot-warn'
  location: location
  tags: tags
  properties: {
    displayName: 'Data Root Boot Validation Failed (warn-only serving empty)'
    description: 'The server failed to validate the data root at boot (taxonomy/ or dictionary/ missing or empty) and — in warn-only mode — kept serving. Panels may be empty. Re-check data-root provisioning for the affected revision. Load-bearing until DATA_ROOT_VALIDATION_ENFORCE=1 lands in prod (t/3305).'
    severity: 1
    enabled: true
    scopes: [ logAnalytics.id ]
    evaluationFrequency: 'PT15M'
    windowSize: 'PT1H'
    criteria: {
      allOf: [
        {
          query: '''
            ContainerAppConsoleLogs_CL
            | where Log_s contains "Data root validation failed at boot"
            | summarize BootValidationFailures = count()
            | where BootValidationFailures > 0
          '''
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
        }
      ]
    }
    actions: {
      actionGroups: budgetAlertConfigured ? [ restartAlertActionGroup.id ] : []
    }
  }
}

resource branchDivergence 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: 'alert-branch-divergence'
  location: location
  tags: tags
  properties: {
    displayName: 'Session Branch Divergence'
    description: 'A session branch is more than 10 commits behind main. User may encounter merge conflicts.'
    severity: 3
    enabled: true
    scopes: [ logAnalytics.id ]
    evaluationFrequency: 'PT15M'
    windowSize: 'PT15M'
    criteria: {
      allOf: [
        {
          query: '''
            ContainerAppConsoleLogs_CL
            | where Log_s contains "branch.divergence"
            | where Log_s contains "behind_by"
            | extend behind = toint(extract("behind_by.:(\\d+)", 1, Log_s))
            | where behind > 10
          '''
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
        }
      ]
    }
    actions: {
      actionGroups: budgetAlertConfigured ? [ restartAlertActionGroup.id ] : []
    }
  }
}

// ── Staging ContainerBackOff Alert (t/2659) ──
// Fires within ~5 min (PT5M eval since t/4248) on any ContainerBackOff or ContainerCrashing event on
// taxonomy-editor-staging. Staging-specific so it can be distinguished from
// the generic restartLoopAlert (all apps, 5+ threshold, 5-min eval).
// Historical proof: staging-151d3e7 incident produced ContainerBackOff rows
// in LA at 2026-08-15T00:13-00:23; query returned matching rows on a P7D
// look-back (verified 2026-08-15). ContainerBackOff is the correct Reason_s —
// ACA never emits the raw Kubernetes string "ImagePullBackOff" (see imagePullFailureAlert).

resource stagingBackoffAlert 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: 'alert-staging-container-backoff'
  location: location
  tags: tags
  properties: {
    displayName: 'taxonomy-editor-staging — ContainerBackOff'
    description: 'Staging container entered a restart loop. No direct user impact; investigate before next isolation deploy. (t/2659)'
    severity: 1
    enabled: true
    scopes: [ logAnalytics.id ]
    // t/4248 cost: PT1M -> PT5M eval (log-alert price is per-rule by frequency).
    evaluationFrequency: 'PT5M'
    windowSize: 'PT5M'
    criteria: {
      allOf: [
        {
          query: '''
            ContainerAppSystemLogs_CL
            | where ContainerAppName_s == "taxonomy-editor-staging"
            | where Reason_s in ("ContainerBackOff", "ContainerCrashing")
          '''
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
        }
      ]
    }
    actions: {
      actionGroups: budgetAlertConfigured ? [ restartAlertActionGroup.id ] : []
    }
  }
}

// ── Prod ContainerBackOff Alert (t/2659 — severity 0, direct user impact) ──
// Same query as staging alert but scoped to taxonomy-editor (prod).
// Severity 0 (Critical) because a prod restart loop means users cannot load the app.
// Complements the generic restartLoopAlert (all apps, 5-restart threshold)
// with no restart-count threshold (PT5M eval since t/4248; was per-minute).

resource prodBackoffAlert 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: 'alert-prod-container-backoff'
  location: location
  tags: tags
  properties: {
    displayName: 'taxonomy-editor PROD — ContainerBackOff (Critical)'
    description: 'Production container entered a restart loop — direct user impact. Investigate immediately. (t/2659)'
    severity: 0
    enabled: true
    scopes: [ logAnalytics.id ]
    // t/4248 cost: PT1M -> PT5M eval (log-alert price is per-rule by frequency).
    evaluationFrequency: 'PT5M'
    windowSize: 'PT5M'
    criteria: {
      allOf: [
        {
          query: '''
            ContainerAppSystemLogs_CL
            | where ContainerAppName_s == "taxonomy-editor"
            | where Reason_s in ("ContainerBackOff", "ContainerCrashing")
          '''
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
        }
      ]
    }
    actions: {
      actionGroups: budgetAlertConfigured ? [ restartAlertActionGroup.id ] : []
    }
  }
}

// ── Ingress 5xx Observability Alerts (t/3167) ──
// Root cause: ACA ingress fabricates empty-body 5xx when Node event loop is starved
// (no server-side record — only the client sees it). ACA exposes no per-request Envoy
// access log, so we can't grep upstream_response_time directly (platform limitation).
//
// Two-arm detection:
//   PRIMARY  — event-loop-lag WARN (server-side, fires BEFORE ingress fabricates the 5xx)
//   BACKSTOP — ACA Requests/5xx metric rate (advisory; whether it counts envoy-fabricated
//              5xx unverified — deferred to natural repro or controlled synthetic)
//
// Diagnosis: AppInsights `requests` absent + client log present → envoy-fabricated.
// See operational-commands.md for the KQL cross-reference runbook.

// t/4426 SO C2: injected via replace() from containerApp.name — see restartLoopQuery's comment.
var eventLoopBlockedQuery = replace('''
  ContainerAppConsoleLogs_CL
  | where ContainerAppName_s == "__APP_NAME__"
  | where Log_s has "event loop blocked"
''', '__APP_NAME__', containerApp.name)

resource eventLoopLagAlert 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: 'alert-event-loop-blocked'
  location: location
  tags: tags
  properties: {
    displayName: 'taxonomy-editor PROD — Event Loop Blocked (>1s starvation) — t/3167'
    description: '''Node.js event loop blocked >1s on the PRODUCTION app — leading indicator of ingress-fabricated 5xx under load (t/3165 pattern).
Signal: Pino WARN "event loop blocked" fires ONLY on blocks >EVENT_LOOP_LAG_WARN_MS (1000ms); routine 5s gauges say "event-loop max…" without "blocked" and do not trip this.
Structured fields: component="event-loop", level=warn(40). Primary detector for t/3167.
t/4426: scoped to the prod app (see eventLoopBlockedQuery above) — unscoped, 200/202 matching lines
in a 38h window came from staging (load-test/canary traffic), so this paged on staging noise. (t/3167, t/4426)'''
    severity: 1
    enabled: true
    scopes: [ logAnalytics.id ]
    // t/4248 cost: PT1M -> PT5M eval (log-alert price is per-rule by frequency).
    evaluationFrequency: 'PT5M'
    windowSize: 'PT5M'
    criteria: {
      allOf: [
        {
          query: eventLoopBlockedQuery
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
        }
      ]
    }
    actions: {
      actionGroups: budgetAlertConfigured ? [ restartAlertActionGroup.id ] : []
    }
  }
}

resource ingressFiveXxBackstopAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  // Metric alerts must use 'global' location regardless of resource region.
  name: 'alert-ingress-5xx-backstop'
  location: 'global'
  tags: tags
  properties: {
    description: '''Advisory backstop: ACA Requests metric >2 5xx in 5 min → possible ingress-fabricated 500 or app error burst.
Threshold 2/5min: incident window (t/3165, 07:14–07:15 UTC) showed 3–4 5xx; normal baseline outside incident is 0–1/5min.
NOT load-bearing: whether this metric counts envoy-fabricated 5xx (Node-never-ran) is unverified — deferred to natural repro.
Primary detector is eventLoopLagAlert. (t/3167)'''
    severity: 2
    enabled: true
    scopes: [ containerApp.id ]
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: '5xx-rate'
          criterionType: 'StaticThresholdCriterion'
          metricName: 'Requests'
          metricNamespace: 'Microsoft.App/containerApps'
          dimensions: [
            {
              name: 'statusCodeCategory'
              operator: 'Include'
              values: [ '5xx' ]
            }
          ]
          operator: 'GreaterThan'
          threshold: 2
          timeAggregation: 'Total'
        }
      ]
    }
    actions: budgetAlertConfigured ? [
      { actionGroupId: restartAlertActionGroup.id }
    ] : []
  }
}

// ── GitHub API Refusal + Circuit-Open Alerts (t/4202) ──
// t/4198 investigation: GitHub's 403 ("secondary rate limit" / abuse detection) is a
// distinct refusal class from the 429 above, and until githubRestClient.ts's t/4202
// change, its headers (Retry-After, x-ratelimit-*) were never captured at all — the
// request just fell through to the generic failure path. Logged as 'github.api.refused'
// so this alert can target that specific refusal class without conflating it with
// ordinary 429s (already covered by rateLimitWarning/rateLimitCritical above).

resource githubRefusalAlert 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: 'alert-github-api-refused'
  location: location
  tags: tags
  properties: {
    displayName: 'GitHub API Refused (403 secondary rate limit / abuse detection)'
    description: 'GitHub returned 403 (not 429) — secondary rate limit or abuse detection, a distinct refusal class from the primary rate limit. (t/4202)'
    severity: 2
    enabled: true
    scopes: [ logAnalytics.id ]
    // SO C4 (optional cost margin, applied): PT5M -> PT15M. windowSize matches so the
    // 15-min eval gap has no blind spot between checks.
    evaluationFrequency: 'PT15M'
    windowSize: 'PT15M'
    criteria: {
      allOf: [
        {
          // Matches logGithubRefusal()'s Pino message (githubRestClient.ts, t/4202) —
          // NOT the FlightRecorder event type string, which never reaches console
          // output (FlightRecorder.record() only writes an in-memory ring buffer).
          query: '''
            ContainerAppConsoleLogs_CL
            | where Log_s contains "github-api-refused-403"
          '''
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
        }
      ]
    }
    actions: {
      actionGroups: budgetAlertConfigured ? [ restartAlertActionGroup.id ] : []
    }
  }
}

// Circuit breaker opening means every GitHub call is being short-circuited (serving
// from cache only, t/4179). Matches "circuit-breaker-open" — the cause string
// githubAPIBackend.ts's listDirectory already emits via log.server.warn whenever it's
// blocked by the open circuit (NOT githubRestClient.ts's FlightRecorder event, which
// never reaches console output — confirmed 0 hits during the 10-13 outage, vs this
// string's 31,747 hits in the same window). Red-armed (t/4202, Lead review):
//   10-13 09:55-10:30Z (outage window): 31,747 hits
//   10-14 09:55-10:30Z (clean window):       0 hits

resource circuitOpenAlert 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: 'alert-github-circuit-open'
  location: location
  tags: tags
  properties: {
    displayName: 'GitHub API Circuit Breaker Open'
    description: 'The GitHub API circuit breaker opened — all calls are being short-circuited, serving from cache only. (t/4202)'
    severity: 1
    enabled: true
    scopes: [ logAnalytics.id ]
    // Kept at PT5M by t/4248 SO C1 (e/306#3): since #3266 an open circuit fails hosted saves
    // closed (503), so this is a user-facing outage signal. Do not slow it for cost (~$1/mo).
    evaluationFrequency: 'PT5M'
    windowSize: 'PT5M'
    criteria: {
      allOf: [
        {
          query: '''
            ContainerAppConsoleLogs_CL
            | where Log_s contains "circuit-breaker-open"
          '''
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
        }
      ]
    }
    actions: {
      actionGroups: budgetAlertConfigured ? [ restartAlertActionGroup.id ] : []
    }
  }
}

// ── Ephemeral Runner Module ──
module ephemeralRunner 'runner/runner.bicep' = {
  name: 'ephemeral-runner'
  params: {
    location: location
    uniqueSuffix: uniqueSuffix
    enabled: ephemeralRunnerEnabled
    githubRunnerPat: githubRunnerPat
    githubRunnerWebhookSecret: githubRunnerWebhookSecret
    logAnalyticsWorkspaceId: logAnalytics.id
    keyVaultName: keyVault.name
  }
}

// ── Outputs ──

output appUrl string = 'https://${containerApp.properties.configuration.ingress.fqdn}'
output appName string = containerApp.name
output resourceGroup string = resourceGroup().name
output keyVaultName string = keyVault.name
output keyVaultUri string = keyVault.properties.vaultUri
output stagingUrl string = 'https://${containerAppStaging.properties.configuration.ingress.fqdn}'
output appInsightsName string = appInsights.name
output storageAccountName string = storageAccount.name
output storageAccountBlobUrl string = storageAccount.properties.primaryEndpoints.blob
output runnerWebhookUrl string = ephemeralRunner.outputs.webhookUrl
