# Org endorsement gate: held-out validation, pre-registration (t/4545)

**Recorded:** 2026-10-27, **before any held-out data exists.** No held-out proposal has been drawn, labelled or tagged. The sampler in this folder (`holdout_sample.py`) is committed with this file.

**Why:** prompt v2 of the endorsement gate (t/4523#3) was revised after round-1 tags on the 29 labelled proposals in `labels.json` had been seen. Those 29 are therefore **development data**. A pass on them shows the round-1 defects are fixed, but it is not an unbiased estimate of the gate's accuracy. This file fixes how that estimate will be made.

## Status: blocked on data

The current corpus can't supply a held-out set:
- `organization_stance_claims.json` holds **81 claims from 6 orgs** (14 org–source pairs). It hasn't changed since 2026-07-12.
- Matching those claims yields **exactly the 29 proposals**, and all 29 are development data (t/4523#2).
- Of the 25 organizations, only **7 are linked to a source**.

New proposals need new org claims, which means linking sources to more organizations and running stance extraction (paid). That is tracked as this ticket's blocker. **The sampler is run on the first matching run that contains new claims.**

## Population

A proposal is **eligible** only if both hold:
1. its `(org, node)` pair is **not** one of the 29 in `proposals.json`;
2. **every** claim it rests on was extracted after 2026-07-12 (`extracted_at`). So no development claim leaks in, including the NIST claim that was the round-1 worked example.

## Sample

- **If there are 40 or fewer eligible proposals:** take all of them.
- **Otherwise:** a stratified random sample of 40, seed `4545`. Strata are org × cosine band (`[0.60, 0.65)`, `[0.65, 0.70)`, `≥ 0.70`), allocated in proportion to stratum size with a minimum of 1 per non-empty stratum.
- **Non-degenerate guard (t/3587):** the labelled sample needs **at least 8 Y/P and at least 8 N**. Otherwise the result is reported as **underpowered** and no verdict is drawn. Then draw again from the next matching run rather than relaxing the bar.

## Blinding

- **The label sheet shows only** the organization, the node's core proposition (label plus the Core description, Encompasses/Excludes stripped: the same construction as `node_prop`) and the proposal's supporting claims.
- **It never shows** the gate's tag, its reason, the cosine or the edge type.
- **The labels are committed to git before the gate runs on the sample.** The commit time is the evidence of blinding.
- **No prompt change** between committing the labels and scoring them. A prompt change after scoring turns this set into development data, and a fresh held-out set is needed.

## Labels

- **Rubric:** the `labels.json` `_rubric`, verbatim. Y = a claim asserts the node's proposition; P = a claim asserts part of it, or a close neighbour; N = no claim asserts it (topic overlap only, or the claims point the other way).
- **Rater:** the CL, as the single rater. The report states this. A second rater (t/4480's process) would make the estimate human-validated, and is optional here.

## Metrics and verdict

Each metric is reported **with its counts**:
- **Y/P recall:** Y/P items tagged `endorses` or `partial`.
- **N recall:** N items tagged `none`.
- **`endorses` precision:** items tagged `endorses` that are Y.
- **`partial` precision:** items tagged `partial` that are Y or P.
- The full confusion table: label (Y, P, N) × tag (`endorses`, `partial`, `none`, `unknown`).

**Pass bar**, the same proportions as the t/4523 acceptance check:
- **Y/P recall ≥ 92%**, which is 12 of 13 scaled;
- **N recall ≥ 62.5%**, which is 10 of 16 scaled.

**Verdict:**
- **PASS** if both bars are met.
- **FAIL** if either is missed.
- **UNDERPOWERED** if the non-degenerate guard fails.

`unknown` tags (a backend failure) are reported but excluded from the denominators. If more than 10% of the sample is `unknown`, the run is repeated.

**Provenance:** these bars are **stipulated**. They carry over the t/4523 acceptance bars (CL). A PASS here moves the gate's provenance to **derived**, recorded in `metric-provenance-register.md`.
