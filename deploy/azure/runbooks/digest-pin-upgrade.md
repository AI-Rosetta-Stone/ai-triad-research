# Digest-Pinned Base Image Upgrade

**Why pinning matters:** A floating tag (e.g. `node:22.23.2-bookworm-slim`) silently picks up patch bumps on every rebuild. CI proves the old image works; prod gets the new one. The t/2047 outage was caused by exactly this: a `node:22.23.1→22.23.2` bump changed undici's TLS behaviour and crashed `/healthz` in prod.

Both Dockerfiles now use `FROM image:tag@sha256:<digest>`. Every base-image bump is a deliberate PR.

---

## When to bump

Bump the digest when:
- A monthly base-image rebuild runs (base-image.yml fires on the 1st of each month).
- A CVE fix requires a newer node patch version.
- The `Dockerfile.base` comment says a bump is unblocked (e.g. `RE-BUMP to 22.23.2+ only after...`).

---

## How to get the new digest

### node:X.Y.Z-bookworm-slim (Docker Hub)

```powershell
$tag = "22.23.2-bookworm-slim"   # change as needed
$token = (Invoke-RestMethod -Uri "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/node:pull").token
$headers = @{ Authorization = "Bearer $token"; Accept = "application/vnd.oci.image.index.v1+json" }
$resp = Invoke-WebRequest -Uri "https://registry-1.docker.io/v2/library/node/manifests/$tag" -Headers $headers
$resp.Headers['Docker-Content-Digest']
```

Or with curl:

```bash
TOKEN=$(curl -s "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/node:pull" | jq -r .token)
curl -sI -H "Authorization: Bearer $TOKEN" \
     -H "Accept: application/vnd.oci.image.index.v1+json" \
     "https://registry-1.docker.io/v2/library/node/manifests/${TAG}" \
  | grep -i docker-content-digest
```

### ghcr.io/ai-rosetta-stone/ai-triad-base:<date-tag> (GHCR)

```bash
gh api "orgs/ai-rosetta-stone/packages/container/ai-triad-base/versions" \
  --jq '.[] | select(.metadata.container.tags[] | contains("<date-tag>")) | .name'
```

---

## Upgrade procedure

1. **Trigger base-image workflow** (if bumping the base image itself):
   - Update `FROM node:X.Y.Z-bookworm-slim@sha256:<new-digest>` in `deploy/azure/Dockerfile.base`.
   - Push via PR and run the **Base Image** workflow.
   - Note the new base-image digest from the workflow output (`steps.build.outputs.digest`).

2. **Update Dockerfiles** (worktree, never on shared main):
   - `deploy/azure/Dockerfile.base` — bump node digest if the node version changed.
   - `taxonomy-editor/Dockerfile` — bump node digest (builder + prod-deps stages) and/or base digest (runtime stage).

3. **Smoke before promoting:**
   - Container workflow builds the app image and runs `smoke-healthz.sh` against the published digest.
   - Verify `/healthz` returns HTTP 200 on **staging** before triggering `deploy-azure.yml` for prod.
   - Keep the previous GHCR digest handy as the rollback target (see [production-release.md](production-release.md)).

4. **CI gate:** The "Verify digest-pinned FROM lines" step in both `container.yml` and `base-image.yml` fails if any `FROM` line lacks `@sha256:`. A PR that reverts to a floating tag will not build.

---

## Recovery path

If a digest bump breaks prod, forward-deploy using the last known-good image digest:

```bash
az containerapp update \
  --name <app-name> --resource-group <rg> \
  --image ghcr.io/ai-rosetta-stone/taxonomy-editor@sha256:<last-good-digest>
```

The last-good digest is recorded in the container.yml build output for each successful push. Check `gh run list --workflow container.yml` for recent successful runs and read the `digest` job output.
