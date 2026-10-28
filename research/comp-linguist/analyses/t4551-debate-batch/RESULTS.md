# t/4551: decontextualization rate and claim→node MRR on the first post-#3799 debate batch

**Author:** Computational Linguist · **Date:** 2026-10-28 · **Ticket:** t/4551 (split from t/4471, spec §6 item 3) · **Spend:** none (local all-MiniLM-L6-v2 + CL hand-labeling)

**Batch used:** t/4507's pre-registered 50-debate re-run (`analyses/t4507-tag-pilot-rerun/`), run 2026-10-26/27 — the first eval batch of ≥3 debates after the decontextualization prompt change (t/4483, #3799, merged 2026-10-23). This satisfies the ticket's gate ("the next debate-eval batch of 3 or more debates run after #3799 completes"); no new spend needed, exactly as the ticket anticipated.

## Part 1 — 20-claim blind-labelled decontextualization rate

**Method:** pooled every `argument_network` node's `text` field (the debate's `canonical_proposition`, per `decontextualization-rule-spec.md`'s own naming) across all 50 successful debates — 1,076 claims total. Blind-sampled 20 with seed 4551 (`build_sample_and_mrr.py`), hand-labeled against the baseline classes from `analyses/t4471-decontextualization/labels.json` (`ok` / `pronoun` / `internal` / `date_no_year` / `elided` / `artifact`).

**Result: 1/20 flagged (`internal`), 19/20 `ok`.**

| | n | internal | rate |
|---|---|---|---|
| **Baseline** (pre-#3799, `decontextualization-rule-spec.md` row "debate `canonical_proposition`") | 19 | 2 | 10.5% |
| **This run** (post-#3799) | 20 | 1 | 5.0% |

**Pass per the ticket's criterion** ("no source-internal definite descriptions or coined names"): the one flagged item isn't a coined name — it's `"Safetyists counter that rigid validation protocols are necessary..."`, which names the speaking camp (`Safetyists`) instead of stating the substantive position. This is the same violation class the org-stance sample found as its dominant defect (`"The organization..."`, 5/20) — a debate-side instance of referencing the speaker/camp rather than the claim, just worded via a camp name instead of a generic noun. The rule's SELF-CONTAINED check (§3) bans `"the organization"`/`"the company"` explicitly but doesn't name camp labels (`"Safetyists"`, `"Accelerationists"`) — this is a gap in the banned-phrase list worth closing, not evidence the rule failed on a case it was meant to catch.

**n=20 is small** (one single blind rater, as the baseline sample also was) — a 1/20 vs 2/19 difference is not a strong statistical claim, just a directional read consistent with the rest of t/4471's post-change findings (defect rates fell, didn't vanish).

## Part 2 — claim→node MRR

**Finding, stated before the number:** `decontextualization-rule-spec.md` (§6 item 3, line 114) already says this metric "needs re-run debates, so it is reported from that batch, and not claimed before" — **there is no genuine pre-#3799 value for this specific debate-claim MRR to compare against.** The ticket's "against its pre-#3799 value" phrasing doesn't have a real prior number to point to; this run establishes the first one. (The original t/507 report's MRR, 0.1558, is a different population entirely — same-perspective Belief-only nodes, human-verified gold, document key_points — not debate claims, and not a valid comparison point.)

**Method:** for every `argument_network` node with a populated `claim_taxonomy_attribution.primary_ref` (the pipeline's assigned node), ranked that node's cosine similarity against the same-POV candidate pool (all-MiniLM-L6-v2, same method as `stage0_mrr.py` / t/4434's SECONDARY arm). **This is pipeline-assigned, not human-gold** — confounded toward self-consistency (the assignment and the rank both derive from the same embedding method), direction-only, same caveat as every other SECONDARY-style reading in this project.

**Result: n=215, MRR=0.4446, Hit@1=0.298, Hit@5=0.660, median rank 3.**
- 272 of 1,076 pooled claims (25%) have a populated `primary_ref` (the rest are unattributed — mostly `direction_mismatch`, a separate concern from decontextualization).
- 57 of those 272 were excluded: either the assigned ref falls outside the claim's own POV pool (cross-POV attribution) or no embedding was stored on the node.

## What this does and doesn't decide

- **Decides:** the post-#3799 debate decontextualization rate (1/20) doesn't clear an obvious bar higher than the pre-change baseline (2/19) — reads as an improvement, though n is too small to call it more than directional. No wording follow-up filed per the ticket's own fail-condition, since this passes.
- **Flags, doesn't fix:** the camp-self-reference gap (`"Safetyists counter..."`) in the SELF-CONTAINED banned-phrase list — worth a small follow-up prompt tweak, not urgent enough to block this ticket's close.
- **Establishes, doesn't compare:** the claim→node MRR (0.4446, n=215) is a first reading, not a before/after delta — there was never a valid prior number for this exact population and method.
