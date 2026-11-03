# GitHub App Setup for Staging (t/4587)

A second, independent GitHub App for staging — so staging's installation rate-limit quota
is no longer shared with prod. Both environments currently use the same App
(`ai-triad-taxonomy-sync`, id `3646042`, installation `170629125`), and in the t/4584
incident, concurrent staging cold builds drained that shared 5000/hour quota, taking
prod's `/api/entities` and `/api/organizations` down with it.

**This step is PI-only.** DevOps never handles the private key value — the PI creates
the App and stores the key in Key Vault, then hands DevOps only the App ID, installation
ID, and the Key Vault secret *name* to wire into Bicep. Tier: T2 (auth/secrets) — one SO
round plus `consult-hold`, TL approval at the cleared head.

## 1. Register the GitHub App

<https://github.com/settings/apps/new>

| Field | Value |
|---|---|
| GitHub App name | `ai-triad-taxonomy-sync-staging` (must be globally unique) |
| Homepage URL | `https://taxonomy-editor-staging.yellowbush-aeda037d.eastus.azurecontainerapps.io` |
| Webhook | **Inactive** (uncheck "Active") — staging doesn't need the merge webhook, only read/write access |
| Callback URL | (leave blank) |
| Expire user authorization tokens | leave default |

### Permissions (Repository permissions) — identical to the prod App

| Permission | Access |
|---|---|
| Contents | **Read & write** |
| Metadata | Read-only (required, auto-selected) |
| Pull requests | **Read & write** |

Leave all organization/account permissions at "No access."

### Where can this app be installed?

"Only on this account."

Click **Create GitHub App**.

## 2. Generate the private key

On the App's settings page:

- **App ID** — note this number. This becomes staging's `GITHUB_APP_ID` (a distinct
  value from prod's `3646042`).
- **Private keys** section → **Generate a private key**. Downloads a `.pem` file.

## 3. Install the App on `ai-triad-data` ONLY

On the App page, click **Install App** (left nav). Install on your own account, scoped
to just the `ai-triad-data` repository — same scope as the prod App, nothing wider.

After install, the URL will look like
`https://github.com/settings/installations/<installation_id>` — note the
**installation ID**. This becomes staging's `GITHUB_APP_INSTALLATION_ID` (a distinct
value from prod's `170629125`).

## 4. Upload the private key to Azure Key Vault

The Key Vault is `kv-ait-kvwl3nywge4iw` (resource group `ai-triad`). Upload the `.pem`
under a **staging-specific secret name** — this is the one piece of information that
goes back to DevOps, never the key itself:

```bash
az keyvault secret set \
  --vault-name kv-ait-kvwl3nywge4iw \
  --name github-app-private-key-staging \
  --file ~/Downloads/ai-triad-taxonomy-sync-staging.<date>.private-key.pem \
  --encoding utf-8
```

Confirm it landed, without printing the value:

```bash
az keyvault secret list --vault-name kv-ait-kvwl3nywge4iw \
  --query "[?contains(name,'staging')].{name:name, updated:attributes.updated}"
```

## 5. Hand off to DevOps

Give DevOps exactly these three values (never the `.pem` file or its contents):

1. The App ID from step 2
2. The installation ID from step 3
3. The secret name from step 4 (`github-app-private-key-staging`, if you used the name above)

DevOps then:
- adds `githubAppIdStaging` / `githubAppInstallationIdStaging` /
  `githubAppPrivateKeySecretNameStaging` Bicep params (prod's existing params stay
  untouched);
- wires them into `stagingEnvOverrides` so staging's container gets its own
  `GITHUB_APP_ID` / `GITHUB_APP_INSTALLATION_ID` / `GITHUB_APP_PRIVATE_KEY_SECRET_NAME`,
  distinct from prod's;
- confirms staging's managed identity can read the new secret (Key Vault Secrets User
  role, same mechanism as the prod App's key);
- deploys staging and verifies: sign-in works, a staging-branch write succeeds, a read
  succeeds, and staging's rate-limit remaining (visible in structured logs,
  `github.api.rate_limit`) moves independently of prod's.

This goes through the normal T2 process — one SO round, `consult-hold` label, TL
approval at the cleared head — before the staging deploy that picks it up.

## Why this matters (t/4584 recap)

Both apps installed on the same `ai-triad-data` repo under one GitHub App installation
share **one** 5000-request/hour quota across every replica and environment using that
installation. Two environments cold-booting at the same time (each re-fetching the full
taxonomy from GitHub) can exhaust that shared quota in minutes, and the resulting `null`
reads collapse indistinguishably into empty-array responses at the route layer — which
is exactly what happened to prod's `/api/entities`/`/api/organizations` during a staging
deploy window. A separate App per environment gives each its own 5000/hour budget, so a
staging cold-boot storm can no longer take prod down with it.

## Rotation

Same as the prod App (`docs/sync-github-app-setup.md`'s Rotation section) — generate a
new private key on the App's settings page, `az keyvault secret set` with the same
secret name (Key Vault versions it automatically), next container restart picks up the
new key, delete the old key from the App page once verified.
