# Gate Signal Integrity

Rules for reviewing any PR that **introduces or modifies a gate**: a CI step, an acceptance test, a verify script, a config validation, or a feedback rule or hook. These were moved here from the Tech Lead's `AGENTS.md` (t/4109 Phase 1). They're consulted when reviewing a gate, not on every turn.

The first two come from the genus analysis in t/1589, which covers all 5 historical failures in that genus. The other four come from t/2683, t/2971, t/3396 and t/3736.

## 1. Gate Verification

Require evidence that the failure case was tested. **A gate whose failure mode has never been triggered is assumed, not verified.** Confirm:
1. a deliberately caused failure triggers the gate;
2. the success case passes cleanly;
3. the gate is at zero tolerated noise, since pre-existing failures mask new genuine ones.

**Proportionate form (t/4093):** prove both arms with unit tests of the gate's predicate **in the same PR**, injecting **one fault per decision site the diff touches**, and naming the site (file:line or function) and the test that fails.
- A count of failing tests is not evidence. #3123's fault replaced the classifier but never touched the cascade site that calls it.
- A throwaway probe PR is allowed only for workflow YAML that unit tests can't reach. At most one per gate, titled `probe`, and closed when done.
- Route enumeration (rule 6) is a section of the PR body, not a separate deliverable.

## 2. Gate Co-Location

Gate configuration metadata (exemptions, override thresholds, "warning-only until X" annotations) must live **in the gate code, at the point of use**. Not in ticket history or external docs.

## 3. Gate Promotion: real environment first (t/2683)

A **new** gate that will **block** a deploy must first run **non-blocking (warn) against the real target environment for at least one green cycle** before it's promoted to blocking.
- Offline both-arms proof (rule 1) is necessary but not sufficient. A probe validated only against mocks or locally can carry its own gap into prod. In t/2683, an analytics smoke promoted straight to blocking failed on its *own* missing-anon-session bug, not a real defect, and took down both deploys.
- Promotion to blocking is a separate, deliberate step, gated on evidence that the probe ran green against a real deployment. Making a gate blocking is **T2**.

## 4. Guard Testability (t/2971)

A guard or gate whose behaviour **PR-branch CI cannot exercise** must ship with a **direct both-arms unit test of its predicate**. That covers guards keyed on a condition present only after merge or outside the PR context, for example `branch === 'main'`, a CI-versus-local environment, or a deployed-only path.
- PR CI can never trip a main-only guard, so its real behaviour first shows up *after* landing. Proven in one context isn't verified in the other.
- In t/2971, a licenses preflight guard fired on CI's own `main` checkout and wedged `main`. Its CLEAN arm was never exercised, because PR branches aren't `main`.
- Extract the predicate into a pure function and test both arms directly: it fires when it should, and stays silent when it shouldn't.

## 5. Live-Fire Proof (t/3396)

A **rule-based blocking gate** (a feedback rule or platform-executed hook) is not verified until one deliberately triggering no-op has been **observed to visibly block in the deployed harness**. **Repeat the live-fire after any platform update.**
- Predicate tests, run-wrapper replicas and config re-reads all exercise layers *below* the platform's script execution, and that layer can be silently dead. In t/3396, all three run-gate rules were inert for months while carrying full Gate Verification evidence, because the runtime had stopped executing `run:` scripts.
- **Silence never tells "allowed" apart from "dead".** "It passed things silently" is not evidence.
- Every such gate also carries its own durable execution telemetry (the #2070 sink pattern: a pure record builder plus an isolated append that can never affect the verdict). Platform counters (`fire_count_24h`, `recent_executions`) aren't evidence while the platform writer is unverified.
- Failure class: `docs/CodeReview/failure-classes.md`, Class 8.

## 6. Route Enumeration (t/3736)

The other rules ask *does this gate work?* This one asks **what does it not look at?** Name every route that reaches the protected thing, show which mechanism covers each, and leave the uncovered ones as **visible blanks**. Then name **what the gate's own health check doesn't assert.**
- Three enforcement mechanisms failed in one week, and all three were **day-one scope gaps, not decay**. Each worked correctly *within* its scope, so a periodic re-test would have passed cleanly from its first cycle. **So the table is produced once per gate, at its Gate Verification, not on a schedule.**
- **Corollary 1:** before calling a mechanism deficient, establish that it ran. A bypassed mechanism needs mandatory invocation, not redesign, and the two look the same from the outcome alone.
- **Corollary 2: fail closed on uncertainty.** Assert that a query *could* have answered before trusting that it did, because an empty result and a wrong question look identical.
- The procedure, three worked examples, the instances, and what this rule does **not** close (a route table makes blanks visible and **missing rows invisible**) are in `docs/CodeReview/route-enumeration.md`.
