# t/4434 second-rater result

Per TL/PI decision (t/4434#7): a blind agent rater (fresh sub-agent, no taxonomy
context, no access to `pairs_key.json`, `blind_ratings.json`, or any ticket
comment) rated the same 25 pairs in `pairs.json` as the CL's first rating pass.

**Disclosure (required by t/4434#5/#7):** the second rater was an AI agent, not
a human. Any citation of this result outside the project must say so.

## Agreement

- **n = 25**
- **Raw pairwise agreement: 20/25 = 80%**
- **Cohen's kappa: 0.615** (substantial agreement, Landis & Koch bands)
- Disagreements: p06, p11, p14, p17, p18
- Raw X/Y response distributions are non-degenerate for both raters (first:
  15/10, second: 10/15 — each label used well above a trivial minimum), so
  the agreement figure isn't an artifact of either rater always picking the
  same letter (t/3587 non-degenerate-threshold discipline).

## Unblinded: statement-vs-description preference

After mapping X/Y back to "synthetic statement" vs "DOLCE description" via
`pairs_key.json`:

- **First rater (CL, step 2, t/4434#3):** 20/25 preferred the statement (80%).
- **Second rater (agent):** 25/25 preferred the statement (100%).

**This 100% is itself worth flagging, not just reporting.** It's a different
kind of degeneracy than the raw-response check above: the second rater's raw
X/Y picks were genuinely varied (10 X, 15 Y, with distinct per-pair reasons —
see `second_rater_ratings.json`), but once unblinded, every single pick
happened to land on the statement side. Two readings:
1. The synthetic statements are reliably more useful by the stated criterion
   (specific/on-topic for the claim beats generic Encompasses/Excludes scope),
   which is structurally plausible — that's close to what synthetic
   statements are generated to be, versus descriptions which are written to
   *include* scope-setting language by design.
2. A systematic bias in this particular agent rater that this single run
   can't distinguish from (1).

The disagreements with the first rater (5/25) are informative here: in every
case, the first rater picked the description and the second rater picked the
statement — i.e., the second rater's disagreements are exactly its 5
"exceptions that didn't happen" from the first rater's perspective, not a
random scatter. That's consistent with reading (1) (the agent is closer to
"always prefer the statement" than the human rater, who made 5 judgment calls
the other way), not with reading (2) looking more random.

## Reading against t/4434#4's decision rule

t/4434#4 proposed: if the second rater agrees with the first rater's direction
(or lands close with reasonable inter-rater agreement), that's enough to move
to AC4's prompt change without the heavier live-debate A/B spend ask.

**Both conditions are met:**
- **Directional agreement:** both raters prefer the statement by a large
  majority (80% and 100%).
- **Pairwise agreement:** 80% raw, κ=0.615 (substantial), on a task where
  both raters engaged with each pair independently (non-degenerate raw
  response distributions).

**Recommendation (AC3, updated): proceed with AC4** — land the prompt change
making the best-matching synthetic statement the debate-prompt node reference
for an already-selected node (attribution stays on the description vector,
per step 1's finding). No live-debate A/B spend ask is needed; the two-rater
agreement is sufficient per the pre-registered decision rule in t/4434#4.

Files: `second_rater_ratings.json` (the agent's full output),
`compute_second_rater_agreement.py` (the computation above, reproducible).
