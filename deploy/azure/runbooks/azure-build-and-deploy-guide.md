# Building and deploying AI Triad Research (Taxonomy Editor) to Azure: a guide for AI agents

**Written:** 2026-11-21 by the Tech Lead. Facts were checked against `origin/main` at `bcff74e38` and against live GitHub. The pipeline changes often, so re-check the line references before relying on them.

**Repo:** `C:\Users\jsnov\repos\ai-triad-research`, GitHub `AI-Rosetta-Stone/ai-triad-research`.

**Canonical sources** (read these if anything here disagrees, and report the disagreement):
- `deploy/azure/runbooks/production-release.md`: the procedure. Four details are stale; see §8.
- `deploy/azure/runbooks/deployment-facts.md`: the resource names and URLs. This is the only place they should be stated.
- `.github/workflows/container.yml`, `deploy-staging.yml` and `deploy-azure.yml`: the actual behavior.

---

## 0. Ground rules (read first)

1. **A production deploy needs a human go from the PI (Jeffrey) on the exact commit SHA you will deploy.** Get it first-hand and record it on the ticket before you dispatch. A go for one SHA does not cover another. **GitHub does not enforce this:** the `production` environment has no required reviewers, so the rule is all that stands between an agent and prod. Don't treat "it let me dispatch" as permission.
2. **One team dispatches at a time.** Two agent fleets (Orca and Interweave) work in this repo under the same GitHub login. On 2026-11-09 both deployed different SHAs on the same afternoon. Before you dispatch, check that no other deploy for the same go is already running or done (`gh run list --workflow=deploy-azure.yml --limit 3`). Who owns prod deploys is still an open PI decision (t/4965); if you're unsure, ask.
3. **Never change Azure config with ad-hoc `az containerapp update`.** Persistent config changes go into `deploy/azure/main.bicep` and ship through the deploy workflow. CLI writes are only for diagnostics and the emergency rollback in §6 (`operations/devops/azure/AGENTS.md:81`).
4. **Never build or deploy `:latest`.** Every deploy is by commit SHA, resolved to an immutable `@sha256` digest. There is no `:latest` deploy path.
5. **Dispatch each deploy once.** The workflow queues duplicates (`cancel-in-progress: false`); it doesn't cancel them. A duplicate runs a second deploy after the first.
6. **Changes to `deploy/azure/main.bicep`, `deploy/azure/deploy.ps1` or `.github/workflows/deploy-azure.yml` are T2.** They need a Second Opinion review and `consult-hold` before merge. Don't edit them as part of a deploy.
7. **If a gate refuses, stop.** Don't work around a failed gate, a refused rollback, or a blocked command (for example a session safety classifier that blocks prod dispatch). Report it with the run URL and the failing step, and hand the action to a human.

---

## 1. The pipeline at a glance

```
merge to main ──► CI (ci.yml) green
                     │
                     ▼  (manual: Invoke-ContainerBuild.ps1 -Sha <sha>)
          Container Image build (container.yml)  ── image ghcr.io/ai-rosetta-stone/taxonomy-editor:sha-<40hex>
                     │ completed + pushed
                     ▼  (automatic, workflow_run)
          Auto-Deploy to Staging (deploy-staging.yml) ── taxonomy-editor-staging
                     │ staging healthy, smoke green
                     ▼  (manual, PI go on the exact SHA)
          Deploy to Azure (deploy-azure.yml, environment=production) ── taxonomy-editor
                     │ gates green → 100% traffic → 15-min soak → retire previous → tag known-good
```

`continuous-deploy.yml`, `nudge-container-build.yml` and `deploy-drift-check.yml` are **report-only**. They never build or deploy anything.

**Resources:** see `deployment-facts.md`.

| | Value |
|---|---|
| Resource group | `ai-triad` (East US, ACA environment `cae-aitriad`) |
| Prod app | `taxonomy-editor`: https://taxonomy-editor.yellowbush-aeda037d.eastus.azurecontainerapps.io |
| Staging app | `taxonomy-editor-staging`: https://taxonomy-editor-staging.yellowbush-aeda037d.eastus.azurecontainerapps.io |
| Image | `ghcr.io/ai-rosetta-stone/taxonomy-editor`, a public GHCR package (no Azure Container Registry) |
| Base image | `ghcr.io/ai-rosetta-stone/ai-triad-base` (`base-image.yml`, weekly) |
| Revision names | prod `taxonomy-editor--deploy-<sha7>-<epoch5>`, staging `taxonomy-editor-staging--staging-<sha7>` |

---

## 2. Step 1: build and verify locally (before merge)

From `taxonomy-editor/`:
```bash
npm run verify        # tsc (main + server + renderer) + eslint + depcruise + vitest + vite build
```
Other scripts in `taxonomy-editor/package.json`: `npm run build`, `npm run build:container`, `npm test` (vitest), `npm run dev`, `npm run dev:container` (server plus web).

**Optional local container run** (`compose.yaml`, README ~85-185):
1. Copy `.env.example` to `.env`. Set `NEO4J_PASSWORD` (required) and an AI key.
2. Run `docker compose --profile taxonomy-editor up --build`. It serves on `127.0.0.1:7863`; check `curl -sf http://127.0.0.1:7863/health`.
3. Lighter path without Docker: set `AUTH_DISABLED=1`, `cd taxonomy-editor && npm run dev:container`, then `curl -sf http://localhost:7862/health`.

**Landing:** code reaches `main` only through a PR and the merge queue, following the repo rules (`docs/pr-landing.md`). Enqueue with `node operations/devops/enqueue-pr.mjs AI-Rosetta-Stone/ai-triad-research <N>`. If it refuses, stop; never use `gh pr merge --auto`. Never push to a queued PR.

---

## 3. Step 2: build the container image

**When:** after the commit is on `main` and its CI run is green.

```powershell
./operations/devops/Invoke-ContainerBuild.ps1 -Sha <full-or-short-sha>
```
- The script resolves short SHAs, waits for that commit's `ci.yml` run to succeed, then dispatches `container.yml` with `push=true` and `sha=<sha>`.
- **Don't use bare `gh workflow run container.yml`.** It bypasses those guards, and a blank `sha` builds whatever HEAD is at dispatch time.

Watch it: `gh run watch <run-id> --exit-status`. The run is named `Container Image (sha-<sha>) (push=true)`, and staging parses that name.

**What the build does** (`container.yml`):
1. **`ci-gate`:** requires the commit's `ci.yml` job `test-container` to be `success`/`skipped`. For a docs-only tip with no CI run, it dispatches CI and waits.
2. **`build-and-push`:**
   - hadolint, and a check that every FROM line is digest-pinned;
   - base image exists, taxonomy snapshot fetch, build and push;
   - verify the `sha-<SHA>` tag is visible in GHCR;
   - **Trivy gate:** blocks on CRITICAL/HIGH with `ignore-unfixed`;
   - build-provenance attestation.
3. **`smoke-published`:** pull by digest and smoke-test it. *Currently never runs on a dispatched build; this is a known bug, see §8.*

**Confirm the image exists:**
```bash
gh api orgs/ai-rosetta-stone/packages/container/taxonomy-editor/versions --jq '.[0].metadata.container.tags'
```

**If Trivy fails** on a new CVE, it's usually a stale base-image pin. Don't add `.trivyignore` entries yourself, because a time-boxed ignore is a reviewed change. Report it to DevOps or Docker.

---

## 4. Step 3: staging (automatic)

`deploy-staging.yml` runs automatically when a Container Image build completes **and pushed** an image. You don't dispatch it.

**Gate:** it reads the built SHA from the build's run name and staging's current `DEPLOY_SHA`, then decides:

| Result | When |
|---|---|
| **Proceed** | First deploy, or the built SHA descends from the current SHA (a forward deploy). It also proceeds, with a warning, when the current SHA can't be resolved. |
| **Skip** | `push=false`, the current SHA can't be read, the SHA is already deployed, the built SHA doesn't resolve, or it would be a **downgrade** (the built SHA doesn't descend from the current SHA). |

**Deploy job, in order:**
1. Wait for any running prod deploy.
2. Resolve `sha-<sha>` to a digest.
3. Record the rollback target.
4. Sync staging env from Bicep baseEnv. (Staging has no what-if.)
5. Create a 0%-traffic revision, then assert it is digest-pinned.
6. Env diff, warn only.
7. Smoke test on the revision URL.
8. `/readyz` warm-gate (300s).
9. GitHub App quota check.
10. Container-isolation asserts. Staging must use `staging-*` storage containers, never prod's.
11. Promote to 100%.
12. Deactivate stale revisions, keeping the serving and prior ones.
13. Post-deploy check: revision active and `/health` 200.

On failure, it keeps the prior revision at 100%.

**Before asking for a prod go, verify staging:**
```bash
curl -s https://taxonomy-editor-staging.yellowbush-aeda037d.eastus.azurecontainerapps.io/health   # buildSha must equal your SHA
gh run list --workflow="Auto-Deploy to Staging" --limit 3
gh run view <run-id> --log | grep -E "gate: |Smoke test passed|AC2 verified"
```
Put the staging run ID, the smoke result (for example "33/33 endpoints") and `buildSha` in your request for the prod go.

---

## 5. Step 4: production deploy (manual, PI go required)

### 5.1 Before you dispatch
- [ ] **PI go on this exact SHA**, recorded on the ticket (quote it and give the date).
- [ ] Staging is serving this SHA, or an image whose app content is identical, and its smoke test passed (§4).
- [ ] The image `sha-<sha>` exists in GHCR (§3).
- [ ] **Forward deploy only:** prod's current SHA must be an ancestor of yours. The workflow enforces this too.
  - Prod's SHA is in `curl -s <prod>/health` (`buildSha`).
  - Check with `git merge-base --is-ancestor <prod-sha> <your-sha> && echo forward`.
- [ ] No other deploy is running or queued: `gh run list --workflow=deploy-azure.yml --limit 3`.
- [ ] **Not a normal forward deploy from `main`** (a hotfix SHA, an old SHA, any other ref)? Read §5.5 first and run its route check.
- [ ] **If the release touches `deploy/azure/main.bicep` or env vars:**
  - Have the Azure owner take a **container env baseline** first: `operations/devops/azure/Invoke-ContainerEnvSnapshot.ps1`, compared after the deploy with `ContainerEnvSnapshotVerdict.ps1` against `container-env-expected-changes.json`. Both apps' config entries must come out identical apart from the expected changes.
  - The workflow's own env diff is **warn-only**, so this manual compare is the real check.
- [ ] **If the release touches the serialize path** (the synthetic-embeddings endpoint, `httpKit.ts` `jsonStringifyChunked`, `fileIO.loadSyntheticEmbeddings`): run the serialize canary on staging first (`deploy/azure/runbooks/serialize-canary.md`).

### 5.2 Dispatch (once)
```bash
gh workflow run deploy-azure.yml --repo AI-Rosetta-Stone/ai-triad-research --ref main \
  -f environment=production \
  -f auth_mode=optional \
  -f sha=<full-40-char-sha>
```

**Inputs** (`deploy-azure.yml:19-52`):

| Input | Values | Default | Notes |
|---|---|---|---|
| `environment` | `production` | `production` | The only option; staging is rejected. |
| `sha` | 7-40 hex | `''` | **Required in practice**; empty aborts. Pass the full SHA. |
| `auth_mode` | `optional` / `required` / `disabled` | `optional` | Prod runs `optional` (sign-in plus anonymous read-only). Changing it is a product decision for the PI. |
| `staging_load_test_size` | `'false'` / `'true'` | `'false'` | Only for the t/4203 load test. |

The run is named `Deploy to Azure (production, sha-<sha>)`. **Check that the run name shows your SHA.**

### 5.3 What the workflow does
1. **`preflight`:**
   - validates the SHA and resolves `sha-<sha>` to a digest (fails closed if the image is missing);
   - checks `vars.IDENTITY_MAP`;
   - requires a **trusted** green CI run for the SHA (`operations/devops/verify-deploy-ci.sh`, #5505, t/591). Trusted means a push to `main` or `epic/**`, `merge_group`, or `workflow_dispatch`; a `pull_request` run never counts. Its `test-container` job must be success or skipped. If the SHA has no CI run, it accepts the nearest ancestor that has one only when every file changed since then is in ci.yml's `paths-ignore`. If a trusted run is still in progress, it waits for it. A GitHub rate limit or API error blocks with "cannot verify CI", never "CI failed".
2. **`pin-digest`:** ordering only.
3. **`deploy`:**
   1. Waits for any staging deploy.
   2. Records the current prod and staging revisions as the rollback target.
   3. **Downgrade gate:** refuses a non-descendant SHA.
   4. **Bicep what-if:** fails on any resource `Delete`.
   5. **Bicep apply** of `main.bicep`, which reconciles both apps.
   6. New prod revision at 0%, pinned to the digest. Env is stamped with `DEPLOY_SHA`, `DEPLOY_TAG`, `IMAGE_DIGEST` and `IMAGE_DEPLOYED_AT`.
   7. Digest-pin assert. Env diff, warn only.
   8. **Pre-shift gates:** health, mount readiness, full acceptance smoke, persona matrix, and the `/readyz` warm-gate. All must pass.
   9. **Traffic shift to 100%.**
   10. **Automatic rollback on any failed gate:** traffic goes back to the previous revision and the restored revision is re-verified. A Sev-1 alert fires if it isn't serving.
   11. **AC2** post-deploy check (serving and `/health` 200), with automatic rollback if it fails.
   12. The **rollback target and command** are written to the job summary.
4. **`retire-previous-revision`:** a 15-minute soak of health plus smoke, then the previous revision is deactivated. If the soak fails, the previous revision is kept and a `prod-soak-alert` issue opens; the run stays green, so the issue is the signal.
5. **`tag-known-good`:** moves the GHCR `known-good` tag to the deployed digest.

Watch with `gh run watch <run-id>`. Allow about 30-45 minutes including the soak.

### 5.4 After the deploy
```bash
curl -s https://taxonomy-editor.yellowbush-aeda037d.eastus.azurecontainerapps.io/health    # buildSha == your SHA
curl -s https://taxonomy-editor.yellowbush-aeda037d.eastus.azurecontainerapps.io/healthz
```
- **Don't** confirm the deployed SHA with `gh run view --json headSha`. That's the dispatch branch tip, not the deployed SHA; use `/health` `buildSha` or the run name.
- PowerShell smoke: `Import-Module ./scripts/AITriad/AITriad.psm1; Invoke-TaxEditorSmokeTest -Detailed`.
- Logs: `az containerapp logs show --name taxonomy-editor -g ai-triad --type console --tail 50`.
- If there was a baseline (§5.1), run the env compare now and post the result.
- Record the deployed SHA, run ID, revision name and compare result on the ticket.

### 5.5 Hotfix and image-only deploys (lessons from t/579, 2026-11-24)
The incident path itself is in `docs/incident-response.md` ("Prod hotfix path"). These are the mechanics behind it.

1. **There is no image-only deploy.** Every `deploy-azure.yml` run does the Bicep what-if and apply (§5.3 step 3.4-3.5) before it touches the image. A run that "only ships a fix" also applies the template from the ref you dispatch.
2. **The `production` environment accepts deploys only from `main`.** Its deployment-branch policy is custom and lists `main` alone. A run dispatched from `epic/*`, a hotfix branch or an old tag fails when the deploy job starts. A hotfix image deploys by dispatching from `main` with `-f sha=<hotfix-sha>`. Widening the policy is a PI decision.
   - Before you ask for the go, run a what-if of **main's** template against prod and post it. It must show nothing but the image plus known noise (revision suffix, stamped `DEPLOY_*` env, `secretRef`/`[reference(...)]` values). Any other change, such as cpu, memory, env or a role, is a change the PI hasn't approved, so stop. The run's own what-if appears only in its log, too late to stop the apply.
   - Before proposing any route (environment, ref, SHA), run `deploy/azure/Test-DeployRoute.ps1 -Ref <ref> -Sha <sha> -WhatIfJsonPath <what-if.json>`. It checks the branch policy, the trusted CI run and the what-if, and exits non-zero unless all three pass (lands with t/612).
3. **Build hotfix images from an `epic/` ref.** `Invoke-ContainerBuild.ps1` dispatches from `main`, which moves `:latest`. Push the hotfix commit to `epic/<ticket>-hotfix` and build there.
   - Pushing a commit that already exists on another branch may not start CI. Then dispatch it yourself: `gh workflow run ci.yml --ref epic/<ticket>-hotfix`.
   - **The preflight needs a trusted CI run on the hotfix SHA** (§5.3; fixed in #5505, t/591, 2026-11-25). Before #5505, a queued `pull_request` run displaced a green dispatch run, and a rate limit read as "CI failed". Now only trusted runs count, so a hotfix SHA needs a CI run from a push to `epic/**` or a `workflow_dispatch`. A PR run alone fails closed. Don't cancel CI runs on a hotfix SHA; the gate may need them.
4. **The shared `containerImage` parameter feeds both apps.** A prod apply writes the deployed image into staging's template too, and an apply from an older template resets staging's cpu and memory to that template's values. After any prod apply, check staging:
   ```bash
   az containerapp show -n taxonomy-editor-staging -g ai-triad --query "properties.template.containers[0].{image:image,cpu:resources.cpu,memory:resources.memory}"
   ```
   The next staging auto-deploy (§4) puts staging's own image back, but it never sets cpu or memory. If those changed, tell the Azure owner.

---

## 6. Rollback

**The workflow rolls back by itself** when a pre-shift gate or AC2 fails. Manual rollback is for problems found after a successful deploy.

**Gated rollback (preferred):** the revision name is in the deploy run's job summary under "Rollback target".
```powershell
./operations/devops/Invoke-GatedRollback.ps1 -RevisionName <previous-revision>
```
- It activates the revision, waits until it is **Provisioned** and `/readyz` is warm on its own URL, then shifts 100% traffic and verifies.
- It **refuses and shifts nothing** if the revision won't provision or warm up. Budget about 1-2 minutes.

**Manual fallback,** only if the script can't run. **Never shift traffic to a cold revision:**
```bash
az containerapp revision activate --name taxonomy-editor -g ai-triad --revision <prev>
FQDN=$(az containerapp revision show --name taxonomy-editor -g ai-triad --revision <prev> --query properties.fqdn -o tsv)
curl -s -w ' %{http_code}\n' "https://$FQDN/readyz"     # repeat until {"status":"ready"} + 200; "failed" = STOP
az containerapp ingress traffic set --name taxonomy-editor -g ai-triad --revision-weight "<prev>=100"
```
Then deactivate the broken revision. A rollback changes prod, so tell the PI right away.

**A rollback moves traffic only.** Both the script and the manual fallback leave the template naming the image you rolled away from, so `az containerapp show` still reports the bad image and the next Bicep apply reconciles against it. Record the rollback on the ticket, and treat the next deploy as a forward deploy of a fixed SHA.

**Don't** run a raw `az containerapp ingress traffic set` while a deploy run is in flight or about to start (t/4242). **Don't** cancel a prod deploy during the Bicep apply or the traffic shift. Cancelling `retire-previous-revision` during the soak is safe; it leaves the previous revision active.

### 6.1 When something fails

| Symptom | Meaning | Do this |
|---|---|---|
| Deploy job rejected by the environment | The dispatch ref isn't allowed by `production`'s branch policy | Dispatch from `main` with `-f sha=` (§5.5). Don't ask for the policy to be widened as a workaround. |
| Preflight: tag absent or digest not found | No image was pushed for that SHA | Build it (§3) with the same SHA. |
| Preflight: no trusted green CI run for the SHA | Only `pull_request` runs exist, or the trusted run failed | Check `gh run list --workflow=ci.yml --commit <sha>`; dispatch `ci.yml` on the branch if there's no trusted run (§5.5). |
| Preflight: "cannot verify CI" | GitHub rate limit or API error; not a CI failure | Wait for the reset it names, then re-dispatch once. |
| Preflight: `IDENTITY_MAP` incomplete | Repo variable unset or partial | Stop and escalate to DevOps; it touches auth. |
| "NOT a descendant of the commit already running in prod" | The deploy would move prod backward | Deploy a newer commit, or roll back (§6). |
| What-if shows a delete or a change you didn't expect | Drift or a bad Bicep change | Stop and escalate to the Azure owner. |
| A gate failed and the workflow rolled back | The new revision was unhealthy | Read "Collect failure diagnostics" with `gh run view <id> --log-failed`, and report to the owning role in the format in `docs/error-diagnosis-format.md`. |
| Sev-1: restored revision not serving | The rollback didn't recover | It's an incident now (`docs/incident-response.md`): ping the TL, DevOps and the PI. |
| `prod-soak-alert` issue opened | The soak failed after the shift | The previous revision is still active. Decide with DevOps whether to roll back. |

---

## 7. Who does what
- **App or feature agents:** make `npm run verify` green, land through PR plus merge queue, and request the image build.
- **DevOps / Docker:** own `container.yml` and the image build.
- **DevOps / Azure:** own the deploy workflows and Azure resources, run the env baseline and compare for Bicep or env changes, and do rollbacks.
- **PI:** gives the go on each prod SHA, and decides `auth_mode`, spend and anything on the PI-only list.
- **Tech Lead:** brings the PI the exact SHA plus staging evidence, and approves T2 changes to the pipeline.

If you're not part of the Orca agent team, put your PR, SHA and staging evidence on the PR or ticket and ask the human for the go. Don't dispatch prod yourself unless you've been told to.

---

## 8. Known issues and stale docs (as of 2026-11-21)
- **`container.yml` `smoke-published` never runs on dispatched builds.** Its `if:` (~:540) compares the boolean input as `inputs.push == 'true'`, which is always false. Live run 43760986890 shows it skipped. Staging's smoke test is the effective image check until this is fixed.
- **`production-release.md` has four stale details:**
  1. It says duplicate dispatches are cancelled; they're queued.
  2. It says CI checks `test-electron` + `test-container`; only `test-container` is checked.
  3. It says "all 6 jobs".
  4. It verifies the deployed SHA with `headSha`, which is wrong; use `/health`.
- **`docs/branch-protection-and-deployment.md` (~:86-119)** describes an old tag-a-release pipeline. No `v*` tags exist.
- **The workflow env diff is warn-only.** Bicep or env releases need the manual baseline and compare in §5.1.
- **State at writing:**
  - The newest Container Image run (43939175382, 2026-11-16) **failed**. Check why before building.
  - The last prod deploy was run 43107045461 (2026-11-11), `sha-233b03191a9e2e18c85ae2d4797f23ed5738e274`.
  - Re-check both before you act.
