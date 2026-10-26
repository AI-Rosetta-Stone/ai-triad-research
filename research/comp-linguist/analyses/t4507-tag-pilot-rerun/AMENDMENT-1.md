# t/4507 pre-registration, amendment 1

**Recorded:** 2026-10-26, after debate 1 (`t4507-m01-a1`) and **before debate 2.** This amendment rests only on debate 1's turn structure and cost. No content, embedding or distance was computed or read.

## What was wrong in PREREG.md
PREREG.md says 5 rounds gives "4 Skeptic turns per debate". **That's wrong.** In this engine, `rounds` counts cross-respond statements **across all debaters**, and the moderator chooses who responds; there's no fixed rotation. Debate 1 had 3 openings, then 5 statements split Accelerationist 1, Safetyist 2, Skeptic 2. The speaking order was saf, skp, acc, saf, skp.

So the Skeptic gets **an opening plus roughly 1–3 statements**, varying by debate. That's about 1.5× the Skeptic content of t/3963. In t/3963, at 3 rounds, the Skeptic got an opening plus 1 statement in 50 of 53 debates, and 0 statements in 3.

## What changes
- **The round count and design don't change:** 5 rounds, the same arms, the same order, the same rules. The cost gate passed: debate 1 cost $0.2873, so the projection is about $14.4, under $23.
- **The unit is unchanged:** the mean of the Skeptic-turn embeddings, opening included. A debate with 0 Skeptic statements still counts (opening only), as in t/3963.
- **New, a reported covariate:** each debate's Skeptic statement count, with its distribution per arm.
  - **The A1r replicate floor F already includes this turn-count variance.**
  - **If one arm's mean count differs from the others by more than 1.0, flag the primary result for that arm as possibly confounded by turn count.** The flag doesn't change the verdict.
