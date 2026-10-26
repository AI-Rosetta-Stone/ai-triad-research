# t/4507 pre-registration: POV-tag pilot re-run with seat tags live

**Written:** 2026-10-26, **before any debate in this run.** Author: Computational Linguist.
**Approval:** the PI approved the spend and set a $25 hard cap, first-hand in the CL session (t/4507#1, #2).
**Code:** frozen at `00aff3a6`, which includes t/4438 (#3736). Seat tags now drive per-turn Skeptic node selection. Model gemini-3.5-flash-lite.
**Plan:** `plan.json` in this folder, run with `research/comp-linguist/scripts/paid_batch_runner.py`.

## Why a re-run
t/3963 came out INCONCLUSIVE, for two reasons:
- **Its tag modes were a no-op** (t/4438), so the Scope/Prioritize contrast was really run-to-run noise.
- **2 Skeptic turns per debate** were too few to separate the wings.

This run fixes both.

## Design
- **Motions:** the 10 frozen t/3963 motions (`analyses/t3963-tag-pilot/motions.json`).
- **Arms:** each runs once per motion, so 50 debates.

| Arm | Skeptic seat |
|---|---|
| A1 | Critical, Scope |
| A2 | Critical, Prioritize |
| A3 | Institutional, Scope |
| A4 | Institutional, Prioritize |
| A1r | Critical, Scope (**a replicate of A1**) |

  The untagged arm (A0) and old-umbrella-soul arm (A5) are dropped. They didn't feed the primary outcome, and dropping them pays for the replicate, which t/3963 lacked: a pure run-to-run noise floor.
- **Format:** fixed **5 rounds**, so 4 Skeptic turns per debate, double t/3963's. Fixed length keeps the Skeptic turn count identical across arms.
- **Order:** motion by motion, m01 to m10, with arms in the order A1, A2, A3, A4, A1r. A spend stop therefore loses whole motions, never single arms.

## Cost gate (checked after debate 1, cost only)
After the first debate, read its cost from the ledger. **If 50 × that cost exceeds $23, switch every debate to 4 rounds before the second one runs,** and record the switch on t/4507. The decision uses cost alone; no output is read.

## Primary outcomes
**Unit:** as in t/3963#7. A debate's Skeptic content is the mean of its Skeptic-turn embeddings, using the production all-MiniLM-L6-v2 ONNX embedder offline. Distance is cosine distance, d = 1 − cos.

**The noise floor for motion *m*:** F = d(A1, A1r).

**Q1. Are the Critical and Institutional wings distinct?**
- B = the mean of d(A1, A3) and d(A2, A4).
- The wings are distinct on motion *m* if B > F.

**Q2. Do Scope and Prioritize produce distinct content?**
- M = the mean of d(A1, A2) and d(A3, A4).
- The modes are distinct on motion *m* if M > F.

**Decision rule, the same for each question:**

| Motions where it's distinct | Verdict |
|---|---|
| ≥ 7 of 10 | distinct |
| ≤ 3 | not distinct |
| 4 to 6 | inconclusive |

**If the cap stops the run early:** use complete motions only. With fewer than 8 complete motions, report the verdict as **underpowered**.

**Non-degenerate guard (t/3587):** the comparison is void if the median F across motions is below 0.01. That would mean near-identical replicates, i.e. the generation is effectively deterministic. Every distance is reported with its motion n.

**A named limitation:** F comes from one replicate pair per motion, and only for the Critical/Scope seat. It assumes run-to-run noise is similar across the other three seats.

## Manipulation checks (they must pass before reading Q1 or Q2)
From each debate's per-turn injected Skeptic node ids (`povNodeIds`, t/4438#5):
- **Scope arms (A1, A3, A1r):** ≥ 95% of injected Skeptic nodes carry the seat's tag.
- **Prioritize arms (A2, A4):** the tagged share of injected Skeptic nodes exceeds that tag's corpus base rate. Institutional's base rate is 0.59 (t/4438). Critical's comes from `skeptic.json` at the frozen data commit.

**If a check fails, the primary result isn't read.** Report it as a selection defect instead.

## Secondary (exploratory, declared now)
- Tagged-cited share per arm (from Skeptic `taxonomy_refs`).
- Crux overlap, A1 vs A3.
- **The Prioritize lift at the current `TAG_BOOST_INCREMENT`:** the tagged share in A2 and A4 minus the corpus base rate. **This run doesn't *tune* the boost**, which would need two or more boost values. It measures the lift at the stipulated value. The register entry stays stipulated, with the measured lift noted.

## Out of scope
**Convergence and censoring metrics.** Fixed-round debates never reach a natural conclusion, so `termination_reason` currently records `unknown` for them. That's by design here, not a defect to fix before running. Labelling fixed-round completion properly, so it stops counting toward the unknown-rate monitor (t/3503), goes to DebateTool as a separate T1 ticket.
