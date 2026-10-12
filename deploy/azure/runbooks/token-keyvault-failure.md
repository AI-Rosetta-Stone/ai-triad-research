# Runbook: Token / Key Vault Failure

**Trigger:** Auth errors in flight recorder (`github.api.error` with 401), or app fails to start

## Symptoms
- Flight recorder shows `github.api.error` with status 401
- `/health` may show `github.rateLimit` as null (no valid token)
- App starts but can't load data (falls back to baked snapshot)
- Container logs: "Failed to get installation token" or "Key Vault access denied"

## Steps

1. **Check Key Vault accessibility:**
   ```bash
   KV_NAME=$(az keyvault list -g ai-triad --query "[0].name" -o tsv)
   az keyvault show --name "$KV_NAME" --query "properties.provisioningState"
   ```

2. **Check managed identity assignment:**
   ```bash
   az containerapp show --name taxonomy-editor -g ai-triad --query "identity"
   ```
   Should show `type: SystemAssigned` with a `principalId`.

3. **Check Key Vault role assignment:**
   ```bash
   az role assignment list --scope "/subscriptions/.../resourceGroups/ai-triad/providers/Microsoft.KeyVault/vaults/$KV_NAME" --query "[?principalType=='ServicePrincipal'].{role:roleDefinitionName, principal:principalId}" -o table
   ```
   Should show `Key Vault Secrets Officer` for the container app's principal.

4. **Check PEM secret exists:**
   ```bash
   az keyvault secret show --vault-name "$KV_NAME" --name github-app-private-key --query "attributes.enabled"
   ```

5. **Check GitHub App installation:**
   - Verify App ID 3646042 is still installed on `AI-Rosetta-Stone/ai-triad-data`
   - Check https://github.com/settings/installations → find the app → verify repo access

6. **Force token refresh:**
   ```bash
   # Restart the container to clear cached token
   ACTIVE=$(az containerapp revision list --name taxonomy-editor -g ai-triad --query "[?properties.trafficWeight > \`0\`].name | [0]" -o tsv)
   az containerapp revision restart --name taxonomy-editor -g ai-triad --revision "$ACTIVE"
   ```

## Prevention
- PEM key is only fetched from Key Vault (never inline env var)
- Token auto-refreshes 5 minutes before expiry
- Key Vault audit logs in Log Analytics (KV diagnostics resource)
