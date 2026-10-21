# Runbook: Serialize-Phase Canary Probe

**Trigger:** Any staging canary of a change that touches the **serialize path specifically** — the synthetic-embeddings endpoint (`routes/taxonomy.ts`, `getSyntheticEmbeddingsBuffer`), the chunk-yield JSON serializer (`httpKit.ts` `jsonStringifyChunked`), or the corpus loader (`fileIO.loadSyntheticEmbeddings`). Run this probe **before** promoting the revision to production.

> **Scope note (t/3236#11):** the trigger is deliberately the serialize path, **not** the broader "embeddings load/serve." Compute-path-only deltas (worker-pool internals, queue-depth gauges, shed-token observability) do **not** touch the ~400MB serialize tail this probe guards and are **N/A** — the earlier broad phrasing spuriously matched a compute-only delta (main `39445130`). If the diff over the deploy range leaves `getSyntheticEmbeddingsBuffer` / `jsonStringifyChunked` / `loadSyntheticEmbeddings` byte-identical, the canary is N/A.

**Owner:** DevOps. Endpoint + loop-sampler owned by ServerAPI (`taxonomy-editor/src/server/`).

**Origin:** t/3236 (prevention arm of t/3165). The offload storm-canary green-lit the t/3165 worker fix while its workload hit only `/api/embeddings/compute` — it never exercised the response **serialize** tail, so the ~3s un-yielded `JSON.stringify` of the ~400MB synthetic corpus went undetected until production. Failure class: **phase-blind sampling** — observability scoped to one phase of a request green-lights a fix that leaves another phase unaddressed (`docs/CodeReview/failure-classes.md`; same genus as t/3166). This probe closes that gap by exercising **and asserting** the serialize phase under the loop-sampler.

## What it proves

The synthetic-embeddings serialize tail lives server-side in `getSyntheticEmbeddingsBuffer()` (`routes/taxonomy.ts:42`/`:60`): the cold path builds + `jsonStringifyChunked`-serializes the ~400MB corpus **once** (chunk-yielded so even the cold serialize doesn't block the event loop), then caches the serialized `Buffer`; every later GET serves it near-free. The probe drives one **cold** serialize and one **warm** hit while the canary loop-sampler is recording, and asserts the event loop never blocked.

Post-t/3259 the corpus GET is **auth-only** (never anon-reachable); anon debates route through the tiny `/api/taxonomy/relevant-nodes` (t/3257), which has no 400MB serialize. So the tail only fires for **authed** callers — the probe must authenticate.

## Prerequisites

- A **fresh** staging canary revision. A fresh revision = new process → the `_synthEmbeddingsBuffer` module-level cache (`taxonomy.ts:38`) is `null`, populated lazily only on the first GET. So **the first authed synth GET on a fresh revision IS the cold path** — no cache-drop endpoint is needed (confirmed ServerAPI, t/3236#7). If you must force-cold a *warm* revision, redeploy a fresh one; do not add a cache-drop route just for this.
- On that revision, set three env vars (staging-only; all three are **production-inert** by construction):
  - `CANARY_LOOP_SAMPLER=1` — exposes `/internal/canary/loop-sampler/{start,report}` (default off → both routes 404 and the anon-exemption doesn't exist; `canary.ts`).
  - `ENABLE_TEST_PERSONA_HEADER=1` and `TEST_PERSONA_SECRET=<staging-only-secret>` — enables the test-persona auth short-circuit (`resolveTestPersonaOverride`, `accessControl.ts:172`; the same mechanism `Test-PersonaEndpoints` uses). Unset in prod → the `X-Test-Persona` header is ignored entirely.

  Create the canary with `operations/devops/azure/Set-StagingTestRevision.ps1`, **not** a bare
  `az containerapp update` (that builds from the app's latest template, not the serving revision, and
  can replay a previously rejected template; t/4376). The script copies the serving revision, checks
  its own `/healthz`, moves traffic, and returns only once one replica has settled (t/4378):

  ```powershell
  ./operations/devops/azure/Set-StagingTestRevision.ps1 -ReadOnlyShared -Cpu 1.5 -Memory 3Gi -Suffix canary-<sha7> -SetEnv @{
    CANARY_LOOP_SAMPLER        = '1'
    ENABLE_TEST_PERSONA_HEADER = '1'
    TEST_PERSONA_SECRET        = '<throwaway secret; never paste it into a ticket or ping>'
    TAXONOMY_CACHE_DIR         = '/tmp/canary-cache'
  }
  ```

  - **Prod size (`-Cpu 1.5 -Memory 3Gi`, prod's current size per [deployment-facts](./deployment-facts.md)).** Staging's own 0.25 vCPU / 0.5 GiB can't hold the ~300MB corpus, so a staging-size canary measures nothing useful (t/4286#12).
  - **`TAXONOMY_CACHE_DIR=/tmp/canary-cache`** forces the cold GET through the **GitHub blob fetch**. Staging's normal cache (`/mnt/staging-state/cache`) is persistent, so a fresh revision otherwise reads the corpus from disk and never exercises the GitHub path (t/4286#34).
  - **Optional, for GC timing:** add `-ContainerArgs 'node','--trace-gc','dist/server/taxonomy-editor/src/server/server.js'`. `NODE_OPTIONS=--trace-gc` is rejected by Node and the revision fails to start (t/4286#17).

  The new revision is a fresh process, which is exactly the cold-cache state the probe needs.

Staging URL: see the canonical [deployment-facts](./deployment-facts.md) doc — do not inline it here (drift; t/1735).

## Authentication (why no OAuth / no new identity)

The probe authenticates with the **test-persona header**, not a browser OAuth round-trip or a canary service principal:

```
X-Test-Persona: authenticated
X-Test-Persona-Secret: <TEST_PERSONA_SECRET>
```

This yields a real **authed non-admin** principal, which passes the t/3259 auth-only gate on `/synthetic-embeddings` **without touching `isAnonAllowedRoute`** — the anon gate stays closed. No ALLOWED_USERS entry and no secret rotation are required. Production stays inert because `ENABLE_TEST_PERSONA_HEADER` is unset there.

## Procedure

Run serially — the loop-sampler is a module-level singleton; a second `start` resets the first's window (`canaryLoopSampler.ts`).

1. **Start the window:**
   ```bash
   curl -sS -X POST "$STAGING_URL/internal/canary/loop-sampler/start"   # → {"started":true}
   ```
2. **Cold GET — fully await the 200 before step 3:**
   ```bash
   curl -sS -o /dev/null -w '%{http_code}\n' \
     -H "X-Test-Persona: authenticated" -H "X-Test-Persona-Secret: $TEST_PERSONA_SECRET" \
     "$STAGING_URL/api/taxonomy/synthetic-embeddings"
   ```
   > **Sequencing is mandatory (ServerAPI t/3236#7).** A warm GET fired *before* the cold build completes dedupes onto the in-flight cold promise (`taxonomy.ts:52`) and returns the buffer **without** emitting the warm `serialize_ms:0` line. Await the cold 200 fully, *then* fire the warm GET — otherwise step 3's warm proof is silently missing.
3. **Warm GET** (same headers) — only after step 2's 200 returns.
4. **Report + assert:**
   ```bash
   curl -sS -X POST "$STAGING_URL/internal/canary/loop-sampler/report"
   ```
   Assert `gate.pass === true` in the response (the frozen p99/max event-loop gate: `max < 1000ms` hard, `p99 < 500ms` + `max < 500ms` margin; `CANARY_GATE` in `canaryLoopSampler.ts`).

## Close criteria (all three)

Read the two phase-timing log lines from Log Analytics (both `component:'api'`, `route:'synthetic-embeddings'`):

| Phase | Log message | Assert |
|-------|-------------|--------|
| Cold (step 2) | `synthetic-embeddings built + serialized + cached (cold path)` — `cache:'cold', load_ms, serialize_ms, serialize_slices, serialize_max_slice_ms, bytes, heap_before/after` | `serialize_max_slice_ms` **< 100** (the longest synchronous stretch of the chunk-yielded serialize). **Not** total `serialize_ms`: that is wall time across all yields (~2.6s on prod size) and doesn't measure blocking (t/4286#39). The per-file `synthetic embeddings: per-file load timing` lines give the same breakdown for the load phase (`read_ms`, `extract_max_slice_ms`). |
| Warm (step 3) | `synthetic-embeddings served from cache (warm)` — `cache:'hit', serialize_ms:0, bytes` | `serialize_ms === 0` (cache hit skips the serialize) |
| Window (step 4) | `/report` response | `gate.pass === true` (no in-window event-loop block) |

All three must hold. A missing warm line almost always means the cold→warm sequencing was violated (step 2 not fully awaited) — re-run.

**To locate a failing gate, use separate windows.** One window covering both GETs reports a single max. Instead run `start` → cold GET → `report`, then `start` → warm GET → `report`, plus a 10s idle window as a baseline. That separates the cold build from the send path (t/4286#17).

Example query:
```bash
az containerapp logs show -n taxonomy-editor-staging -g ai-triad --type console --tail 200 \
  | grep 'synthetic-embeddings'
```

## Teardown

Restore traffic to the revision that served before the canary, then reset the app template. After a restore, the template still holds the canary's settings, **including the test-persona secret**. Any later bare `az containerapp update` would replay them.

```powershell
./operations/devops/azure/Set-StagingTestRevision.ps1 -Restore -RestoreTo <prior serving revision> -TestRevision taxonomy-editor-staging--canary-<sha7>
./operations/devops/azure/Set-StagingTestRevision.ps1 -Suffix tmpl-reset-<sha7>   # copies the serving revision; rewrites the template
```

Then verify: `az containerapp show … --query "properties.template.containers[0].env[?contains(name,'PERSONA') || contains(name,'CANARY')]"` returns nothing, `args` is null, `TAXONOMY_CACHE_DIR` is back to `/mnt/staging-state/cache`, and `provisioningState` is `Succeeded`. Delete your local copy of the secret.

## Notes

- **Why not anon:** the anon storm (free-tier debates) correctly 403s on `/synthetic-embeddings` post-t/3259 and no longer needs the corpus. To exercise a real anon debate path under load, point the storm at `/api/taxonomy/relevant-nodes` (t/3257) — its risk is server-side corpus *assembly*, not a 400MB serialize, and the existing loop-sampler event-loop-delay gate already catches any block there.
- **Live prod caller of the serialized corpus:** the claim-taxonomy attribution path (`lib/debate/argumentNetwork/` → `loadSyntheticVectors`, `taxonomyContext.ts:48` → the endpoint). The probe's direct authed GET hits the same server serializer — caller identity is irrelevant to the probe (ServerAPI t/3236#7).
