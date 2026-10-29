# Failure-Class Taxonomy — Prospective Review Checklist

**Last updated:** 2026-10-29
**Owner:** Diagnostics (source analysis) / Tech Lead (review checklist)
**Source:** e/84 systemic quality analysis of the 2026-08-09 Azure production bug sweep; Class 6 added from the 2026-08-15 dual-build / staging-prod-isolation sweep (t/2669); Class 7 added from the 2026-08-27 embeddings-cache incident (t/3085); Class 8 from the 2026-09-07 silent-inert run-gate audit (t/3396); Class 9 from the 2026-09-25 model-resolution and merge-guard consults (t/3664, t/3687); Class 10 from the 2026-10-29 getting-started-panel Hide regression (t/4639).

Purpose: turn post-incident hindsight into foresight. Before landing a change — especially at a producer/consumer seam, on a deploy path, or touching config — ask **"which of these classes could this change introduce?"** and require the corresponding test or gate. Each incident maps to one of ten structural classes.

## The Core Gap

CI proves individual components work **in isolation, in the CI environment, with authenticated users.** Production requires **integrated** components, for **all user types**, in the **prod environment**. Every gap between those two sentences is one of the classes below.

## Class 1 — Cross-scope semantic contract violations

Two components each correct in isolation, broken at the seam. The invariant *"what I can list, I can load"* holds for neither producer nor consumer alone.

- **Examples:** community debate 404 (`listDebateSessionsMeta` surfaces it, `loadDebateSession` can't resolve it for the user — t/2368); CORS crash (`getCorsOrigin()` returns `[]` → `undefined` → Node 22 `setHeader()` throws — t/723); AUTH_OPTIONAL serving HTML to JSON-expecting API clients.
- **Prevention:** contract-invariant tests at every producer→consumer seam.

## Class 2 — User/identity path gaps

A flow tested for only one identity type.

- **Examples:** community 404 — the anonymous user path was never tested; AUTH_OPTIONAL acceptance tests ran without establishing an anonymous session.
- **Prevention:** an explicit user-type matrix `{anon, authenticated, admin}` × key flows.

## Class 3 — Runtime / environment divergence

Works in dev/CI, fails in prod because the runtime environment differs.

- **Examples:** `NODE_ENV=production` changes config init and produces the CORS crash; a floating `FROM node:22` picked up a patch bump (22.23.1→22.23.2) on rebuild — CI tested the old image, prod got the new one (t/2047).
- **Prevention:** a prod-config CI variant; pinned base-image digests; a pre-promotion smoke gate (t/2376/2377).

## Class 4 — Infrastructure configuration drift

Deployed state diverges from declared intent between deploys.

- **Examples:** CLI `--set-env-vars` config wiped by the next Bicep apply (t/2049/2050); ACA auto-promotes traffic to the latest revision unless `ingress.traffic` is explicitly pinned.
- **Prevention:** post-deploy config verification — actual ACA state vs Bicep intent (t/2378).

## Class 5 — CI gate blind spots

A gate that was sufficient when written, outgrown as the system added surfaces.

- **Examples:** renderer type errors invisible to the server `tsconfig`; the shell-quoting junk-spray guard condition was too narrow (t/2222).
- **Prevention:** gate-coverage review after every incident (the Prevention-per-incident rule); cross-project `tsc` in CI.

## Class 6 — Silent degradation under single-context validation

A failure that **returns a success-shaped result** (empty list + HTTP 200, swallowed write + continue, "renders without error" on zero data) in a code path that was **validated in only one context** (local not hosted, staging not prod, authenticated not anonymous). The two properties are lethal *together*: single-context validation means the broken context is never exercised, and silent degradation means that when it does run, it looks like success. The failure is invisible in the context you checked and silent in the one you didn't.

- **Examples (2026-08-15 dual-build / staging-prod-isolation sweep):**
  - **Dual-build read parity** — Entities/Organizations render locally (Electron/filesystem) but return `[]` on hosted web — the github-api read fell through to empty and ADR-001 graceful-empty rendered zero with no error (t/2648/t/2661); the github-api backend read the session branch not `main`, and `toRepoPath` stripped `cacheDir` not `getDataRoot()`, so a divergent staging cache mount 404'd every read into a silent empty (t/2662/t/2670). The deploy smoke went **26/26 green while entities were visibly broken** because it asserted "endpoints respond," not "data populates" (t/2669).
  - **Swallow-and-continue** — analytics `appendEvents` swallowed a blob error and returned success → events dropped invisibly (t/2664); a route-layer `log.error` that never fired because `log` was a child-logger map (PR #1065).
  - **Deploy/env false-greens** — AUTH_OPTIONAL smoke reclassified the cookie-less Sign-In **HTML interstitial** as a PASS for JSON endpoints; a durability check passed on `revision restart` (≠ scale-to-zero), a false-positive from validating the wrong condition (t/2642); a staging `AI_TRIAD_DATA_ROOT` pointed at the empty cache mount so reads were silently empty (t/2670).
  - **Concurrency swallow** — a multi-replica stale-cache clobber overwrote a prod feature flag and returned success (t/2644).
- **Prevention (three coupled countermeasures — one alone is insufficient):**
  1. **Validate in the deployed context, not a proxy for it.** A dual-build/data-reading feature is verified on the **hosted web profile via the github-api path against real deployed data** before Done — "works locally" is not sign-off (tech-lead `AGENTS.md` Cross-Profile Impact; t/2669 AC2).
  2. **Assert the positive outcome, not the absence of error.** Smokes assert **data presence** (count > 0 / expected shape), never "renders" / "endpoint responds" — a graceful-empty page and a broken page are indistinguishable to a renders-without-error check (t/2671 data-presence smoke).
  3. **Make degradation observable.** Every graceful-empty (ADR-001) and swallow-and-continue path emits a log/metric ("loaded 0 / write failed") so a zero/failed result is **detectable**, not invisible — this turns "silently empty" into "detectably empty" (t/2664 analytics signal; Server-Storage graceful-empty observability).
- **Tickets:** t/2669 (process-gap epic), t/2671 (hosted data-presence smoke), t/2672 (graceful-empty observability), t/2664 (analytics swallow signal). Process rule landed in the tech-lead `AGENTS.md` **Cross-Profile Impact** ("Data-read parity").

## Class 7 — Migration remnant / incomplete-abstraction bypass

A migration moves data consumers behind a shared abstraction (storage backend, resolver, client) but leaves **one consumer on the old raw path**. That straggler silently diverges — the abstraction's guarantees (hydration, freshness, observability, error handling) never apply to it, so it reads a stale, absent, or empty source and returns a success-shaped result. Distinct from Class 1: there is no *seam* between two live components, just the one consumer the migration forgot.

- **Examples:** the 2026-08-27 debate re-embed storm — `loadEmbeddingsFile` kept a raw `fs.readFileSync` of the data-root `embeddings.json` after the May-14 API-First migration routed every *other* taxonomy consumer through `StorageBackend`. When the share held a **stale 36MB file** (vs the 63MB / 4,144-node canonical), the precomputed-cache lookup missed and every debate re-embedded ~3,600 static texts in-process for ~3.5 months — invisible, because the file was **present** (no ENOENT) and **non-empty** (no empty-guard trip), so neither an absence check nor a presence>0 check would have caught it (t/3085/t/3090).
- **Prevention (three coupled):**
  1. **A single sanctioned reader.** All data-root reads route through one storage-owned function (`readDataFile()`, t/3092) that owns the large-file branch, hydration, and the guard — no consumer touches a resolver result with raw `fs`.
  2. **A shape/freshness guard, not just presence.** The sanctioned reader asserts *expected shape/count* (a stale/short file is non-empty and non-ENOENT — presence>0 passes it); an empty/missing/invalid read emits a loud `ActionableError` + flight-recorder event, never a silent empty result.
  3. **An empty-baseline conjunction gate** (t/3087) flags any file outside `storage/` that calls a data-root resolver *and* raw `fs.readFile*` — catching the next straggler at review time.
- **Convention — data-root reader location:** any new exported function whose return value is a data-root path (wraps `resolveDataPath`, `getTaxonomyDir`, or `getEmbeddingsPath`) must live in `src/server/storage/` or `src/server/config.ts` — not a separate helper module. This closes the cross-file data-flow hole the conjunction gate cannot statically track: a caller importing `getEmbeddingsPath` from an outside module and passing it straight to `fs.readFile` never trips the same-file conjunction.
- **Tickets:** t/3085 (root cause), t/3090 (delivery fix), t/3092 (`readDataFile`), t/3087 (gate + convention).

## Class 8 — Silent-inert enforcement layer (run-gate class)

A blocking gate whose **predicate is fully verified but whose execution layer never runs it**. Every proof — unit tests, run-wrapper replicas, warn-phase measurement, config re-reads — exercises the gate *below* the layer that failed (the platform invoking the script at all), so the gate is provably correct and operationally dead at the same time. The tell is structural: **silence is consistent with both allow and dead** — a gate that "passed things silently" has demonstrated nothing until it has been observed to visibly block. Distinct from Class 5 (a running gate with a coverage hole) and Class 6 (a code path returning success-shaped results): here the enforcement mechanism itself is the silently-degraded component.

- **Examples (t/3396, 2026-09-07):** all three run-gate feedback rules — pre-self-merge merge-guard (t/3270), done-evidence gate (t/3360), joint-gv auto-merge guard (t/3318) — were inert from their flips onward: the Orca runtime stopped executing `run:` scripts in a late-May update while static-template rules kept firing. Each flip carried a strong GV (13/13 + 7/7 wrapper; 19/19 both-arms + live-shim probes) — every one below the dead layer. Surfaced only because the t/3394 durable-sink re-audit found **zero execution records from real transitions** (the #2070 sink built for a different purpose became the discriminator); confirmed by an in-harness probe (`gh pr merge 99999` executed unblocked while a static rule fired in the same call). The paired telemetry failure (fire_count/recent_executions unfed since 2026-05-29) made the inertness invisible — Class 6 applied to the observability of the enforcement layer itself.
- **Prevention (the closing gate for this class):**
  1. **End-to-end live-fire in the DEPLOYED harness.** A rule-based blocking gate's GV is incomplete until a deliberately-triggering no-op (the `gh pr merge 99999` template) is observed to **visibly block in the real runtime** — not a replica, not the predicate invoked directly. Predicate tests prove the gate *would* work; only a live fire proves it *is* working.
  2. **Repeat the live-fire after any platform update.** The execution layer is platform-owned and can regress independently of the gate's code; a passing live-fire is evidence about a point in time, not a property of the config.
  3. **Every gate carries its own durable execution telemetry** (the #2070/t/3395 sink pattern: pure record-builder + isolated append that can never affect the verdict) so "zero executions" is a queryable fact, not an unfalsifiable absence — and never cite platform counters (`fire_count_24h`, `recent_executions`) as evidence while the platform writer is unverified.
- **Tickets:** t/3396 (incident + re-verification), t/3394 (the re-audit that surfaced it), t/3395 (sink extension), t/3270/t/3360/t/3318 (annotated flips). SO rec e/150#2.

## Class 9 — Verdict narrower than its reading (the gate asserts what the system doesn't do)

A gate that **runs, is exercised, has both arms proven — and whose green asserts something the system does not do.** Distinct from Class 5 (a running gate with a coverage hole), Class 6 (a code path returning success-shaped results), and Class 8 (a correct predicate never executed): here the gate is fully operational and fully verified, and its *claim* is false. Every existing gate-integrity rule asks whether the gate **works**; none asks whether what it asserts is **true**.

The tell is that the true and false readings are the same sentence until you compare implementations: *"every usage resolves"* and *"every usage resolves to the model production calls"* read identically right up to the moment someone reads both resolvers.

Two generators:

- **Parallel implementation.** The gate reproduces the production path instead of calling it, and the copy drifts. *Does the gate resolve/parse/evaluate through the same code production uses? If not, what makes the copy faithful?*
- **Partial evaluation reading as total.** The check covers a subset — one scanner's roots, workflow-backed contexts, present check-runs — and phrases its verdict over the whole. *What is not in this check's input set, and does its green claim anything about those?*

- **Examples (2026-09-25):**
  - **t/3664** — a resolve-only gate validated `ai-usages.json` via `buildModelEntryMap` (alias-aware); production's `resolveModel` does exact `models.find` plus a silent prefix passthrough. For six production usages the gate's green certified a binding to the pinned `gemini-3.5-flash-lite` entry while production shipped the literal string `gemini-flash-lite-latest` to the provider. Gate correct, both-armed, exercised — asserting a binding that never happens. *Parallel implementation.*
  - **t/3687** — the same staleness comparison was specified wrongly **three times** (`completed_at`; then `ci-gate.started_at`, a 3s aggregator that starts *after* its 18 `needs`; then `CodeQL`'s 2s app-posted start, ~6 minutes after the run doing the work). Each was caught in review by someone actively hunting that failure. Three wrong answers from one design is a property of the design, not of the reviewers.
  - **t/3688** — `required-contexts.json` records `CodeQL` with `workflow: null`, so `workflow-lint.py` skips it. R1 — the rule that mechanizes the anti-strand property — therefore never opens `codeql.yml`, the one file whose comment names that risk. The lint's green was silent about a file it never read. *Partial evaluation.*
- **Prevention (the closing check for this class):** before approving any gate, **write a one-sentence answer to: "What does this gate's green assert, and is that what the system does?"** It must be *written*, not considered — the failure mode is that the answer feels obvious, and wrong answers only become visible on the page. Nobody reviewing t/3664 would have claimed the gate asserted the alias binding; nobody wrote down which binding it asserted either. Where the sentence is hard to write, that difficulty *is* the finding.
- **Tickets:** t/3664 (the live defect), t/3687 (three wrong boundaries), t/3688 (unread-file green), t/3690 (this entry). SO framing: e/210#4, e/212#30.

## Class 10 — UI state assertion a test can't observe (no-CSS blind spot)

A component's visible state is asserted via an HTML attribute (`hidden`, `aria-expanded`, `data-*`) whose *rendered effect* depends on CSS the test environment never loads. jsdom builds a DOM and an accessibility tree from attributes directly — it does not download, parse, or apply stylesheets. A component's own `display`/`visibility` rule can out-specificity a reset or a conditional style the component sets elsewhere, so the real browser cascade keeps an element visible while every attribute-level check says it's hidden. The test is green; the UI is broken.

- **Examples (2026-10-29):** `LibraryGettingStarted.tsx` set `hidden={!expanded}` on its body; `.lib-getting-started-body { display: flex; ... }` in the same component's own CSS out-specificities the UA stylesheet's `[hidden] { display: none; }`. Collapsing the panel left `hidden` correctly set in the DOM, and testing-library's `toBeVisible()`/role-query assertions (which read the attribute and computed ARIA state, not a real layout pass) passed — but the panel stayed visually open in every one of the four tools it shipped to, because jsdom never loaded the component's CSS file at all. Caught only by Design's manual click-through (t/4639#4), not by any of the existing unit tests.
- **Prevention (two coupled countermeasures):**
  1. **A renderer-wide `[hidden] { display: none !important; }` reset** (t/4647, `BaseReset.css`) closes the specific defeat mechanism — no component rule can out-specificity an `!important` global — but this is a vector fix, not a class fix: a component could still defeat a *different* visibility mechanism (e.g., `aria-hidden` plus its own `visibility: visible`) the same way.
  2. **A CSS-source regression test** for any component whose visibility hinges on an attribute the test suite can't see applied — read the `.css` file's text directly (as `BaseReset.test.ts` and `LibraryGettingStarted.test.tsx` do) and assert the overriding/defining rule is present, rather than asserting only on rendered DOM. This is the generalizable pattern: whenever a unit test's claim ("the panel is hidden") depends on a CSS rule actually applying, and the test harness doesn't load CSS, add a source-text assertion alongside the DOM assertion — the DOM assertion alone cannot distinguish "styled correctly" from "the governing rule was deleted."
- **Tickets:** t/4639 (the live defect + component-level fix), t/4647 (the global reset + this entry).

## How to use this

- **Reviewing a change:** ask which class(es) it could introduce; require the corresponding contract test, user-type coverage, prod-config check, or gate before approving.
- **Reviewing a gate specifically:** answer Class 9's question in writing — *what does this gate's green assert, and is that what the system does?* — in addition to the Gate Signal Integrity rules (both arms, co-location, promotion, guard testability, live-fire). Those establish that it works; this establishes that its claim is true.
- **After an incident:** classify it here, then file a **prevention** ticket (not only observability) that closes that class's gap *for the affected surface* — per the *Prevention-per-incident* rule in the root `AGENTS.md` **Incident Response** section.
- **Gate-touching prevention** routes to **Main (TL)** for a Gate-Verification review (both arms proven, reliable enough to block, config co-located).

Coverage is point-in-time. This checklist exists so it tracks system growth prospectively, rather than waiting for the next prod bug to find the next gap.
