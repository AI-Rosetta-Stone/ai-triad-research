# GitHub App Setup for `enable_git_sync=true`

End-to-end wiring for the Azure↔GitHub data sync feature (Phases 1-4,
shipped in v0.7.0). The code is already in the production image; this
doc is the one-time setup needed to actually turn it on.

## 1. Register the GitHub App

<https://github.com/settings/apps/new>

| Field | Value |
|---|---|
| GitHub App name | `ai-triad-sync` (or similar — must be globally unique) |
| Homepage URL | `https://taxonomy-editor.yellowbush-aeda037d.eastus.azurecontainerapps.io` |
| Webhook URL | `https://taxonomy-editor.yellowbush-aeda037d.eastus.azurecontainerapps.io/api/sync/webhook/github` |
| Webhook secret | generate with `openssl rand -hex 32` — save this, we need it below |
| Callback URL | (leave blank) |
| Expire user authorization tokens | leave default |

### Permissions (Repository permissions)

| Permission | Access |
|---|---|
| Contents | **Read & write** (create branches, push commits, fetch) |
| Metadata | Read-only (required, auto-selected) |
| Pull requests | **Read & write** (open PRs, update metadata) |

Leave all organization/account permissions at "No access."

### Subscribe to events

- **Pull request** — lets the webhook fire on `pull_request.closed` with `merged=true`,
  which is what drives the `main_updated_available` banner in the UI.

### Where can this app be installed?

"Only on this account" (your personal GitHub account).

Click **Create GitHub App**.

## 2. Generate the private key

On the App's settings page:

- **App ID** — note this number (e.g. `1234567`). Goes into `SYNC_GITHUB_APP_ID`.
- **Private keys** section → **Generate a private key**. Downloads a `.pem` file.

Keep the `.pem` file. We upload it to Key Vault next.

## 3. Install the App on `ai-triad-data`

On the App page, click **Install App** (left nav). Install on your own
account, scoped to just the `ai-triad-data` repository.

After install, the URL will look like
`https://github.com/settings/installations/<installation_id>` — note the
**installation ID**. Goes into `SYNC_GITHUB_APP_INSTALLATION_ID`.

## 4. Upload the private key to Azure Key Vault

The Key Vault name is in `deploy/azure/main.bicep` (`kv-aitriad-<suffix>`);
find the deployed instance:

```bash
az keyvault list -g ai-triad --query "[].name" -o tsv
# e.g. kv-aitriad-kvwl3nywge4iw
```

Upload the `.pem` as a secret. The secret name goes into
`SYNC_GITHUB_APP_PRIVATE_KEY_SECRET_NAME`:

```bash
az keyvault secret set \
  --vault-name kv-aitriad-<suffix> \
  --name github-app-private-key \
  --file ~/Downloads/ai-triad-sync.2026-mm-dd.private-key.pem \
  --encoding utf-8
```

## 5. Enable branch protection on `ai-triad-data`

The threat model assumes the App *cannot* push directly to `main`.
Enforce this at the repo level:

<https://github.com/AI-Rosetta-Stone/ai-triad-data/settings/branches>

- Branch name pattern: `main`
- Require a pull request before merging → at least 1 approving review
- Do **not** check "Allow force pushes" or "Allow deletions"
- Do **not** grant the GitHub App `administration` permission

This is the backstop that keeps a compromised token from rewriting history.

## 6. Set GitHub Actions variables + secret

From the root of this repo (`ai-triad-research`):

```bash
# Public variables (values visible to workflows and logs)
gh variable set SYNC_GITHUB_REPO --body "AI-Rosetta-Stone/ai-triad-data"
gh variable set SYNC_GITHUB_APP_ID --body "<app_id from step 2>"
gh variable set SYNC_GITHUB_APP_INSTALLATION_ID --body "<installation_id from step 3>"
gh variable set SYNC_GITHUB_APP_PRIVATE_KEY_SECRET_NAME --body "github-app-private-key"

# Secret (never logged)
gh secret set SYNC_GITHUB_WEBHOOK_SECRET --body "<the webhook secret from step 1>"
```

## 7. Redeploy with git sync enabled

```bash
gh workflow run "Deploy to Azure" \
  --ref main \
  -f environment=production \
  -f disable_auth=true \
  -f enable_git_sync=true
```

(Keep `disable_auth=true` until you're ready to re-enable the Easy Auth
sign-in gate — flipping either without the other is a separate decision.)

## 8. Verify end-to-end

After the deploy finishes, smoke test the full loop:

1. Edit a taxonomy node in the web UI → Save. The `Unsynced` pill in the
   status bar should increment.
2. Click the pill → drawer opens. The edit appears as a modified file
   with a unified diff.
3. Click **Create pull request**. A new PR opens at
   `https://github.com/AI-Rosetta-Stone/ai-triad-data/pulls`, with the session
   branch name `web-session/<your-principal>`.
4. Merge the PR. Within ~10 seconds (one poll cycle of `useSyncStatus`),
   the UI shows an **Upstream updated** pill — that's the webhook +
   `main_updated_available` flag.
5. Click **Resync** → **Fast-forward main**. Pill clears.

If any step 404s, check that:
- The webhook URL in the GitHub App settings exactly matches the
  deployed public URL (path `/api/sync/webhook/github`).
- `GITHUB_WEBHOOK_SECRET` env var is set in the Container App
  (`az containerapp show -g ai-triad -n taxonomy-editor --query
  properties.template.containers[0].env`).
- The container's managed identity has the **Key Vault Secrets User**
  role on the Key Vault (Bicep handles this at deploy time, but a role
  assignment delay of a few minutes is normal).

## Rotation

The GitHub App private key should be rotated annually:

1. On the App page, generate a new private key (the old one stays valid
   for 7 days by default).
2. `az keyvault secret set ... --file <new-key.pem>` with the same
   secret name — Key Vault versions the secret automatically.
3. The Container App's `secretRef` always resolves to the latest
   version, so the next app restart picks up the new key.
4. Delete the old key from the App page once the new one is verified.
