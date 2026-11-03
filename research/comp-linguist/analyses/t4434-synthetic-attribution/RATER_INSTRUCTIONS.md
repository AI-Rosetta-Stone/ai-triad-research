# t/4434 second-rater instructions

You are rating 25 paired prompts to help decide a debate-prompt rendering question: when a debate claim has already been matched to a taxonomy node, should the node be referenced in the prompt by its formal description, or by a natural-language statement about it? You are not deciding anything about which node is correct — the node is already fixed for each pair.

**Do not open or read `pairs_key.json`, `blind_ratings.json`, `results.json`, `step2_results.json`, `qualitative.json`, `RESULTS.md`, or any ticket/comment referencing t/4434, until after you submit your ratings.** Those reveal which label (X or Y) is which, and the first rater's picks. Read only `pairs.json` and this file.

## The file

`pairs.json` is a list of 25 objects, each shaped like:

```json
{
  "pair_id": "p00",
  "claim": "The current reality of AI isn't liberation; it's displacement and intensified workloads for real people.",
  "node_id": "skp-beliefs-002",
  "node_pov": "skeptic",
  "X": "Current trends strongly echo technological unemployment arguments, demonstrating that AI-driven automation is outpacing job creation, leading to net human labor displacement across administrative and creative job families.",
  "Y": "A Belief within skeptic discourse that documents current, empirical labor market contractions and the systemic displacement of human workers resulting directly from the deployment of AI automation.\nEncompasses: Statistical tracking of layoffs, role obsolescence in creative and administrative sectors, and wage depression linked to algorithmic integration.\nExcludes: Theoretical projections of post-scarcity economics and the generation of novel, unproven technological employment categories."
}
```

`node_id`/`node_pov` are there for context only (both X and Y describe the same node) — they don't bear on the question and you don't need to look anything else up.

## The question, per pair

**Which of X or Y better supports a debater making THIS specific claim, if it appeared as the node's reference text inside a debate prompt?**

**Criterion (apply the same way for every pair):** a text that is specific and concrete and reads as being about *this claim* beats a text that is generic taxonomic scope-setting (an "Encompasses: ... Excludes: ..." framing reads as documentation about the node in general, not a usable reference for this particular claim) — even if the scope-setting text is also accurate. You're judging usefulness as a debate-prompt reference for this claim, not accuracy, completeness, or writing quality in the abstract.

If both seem roughly equally useful for the claim, pick the one that leans more concrete/specific; don't skip a pair.

## What to produce

For each of the 25 pairs, record your pick (`"X"` or `"Y"`) and a one-sentence reason, written **before** you would see any reveal — don't go back and change a pick after reading later pairs or after any later information. Output as JSON in this exact shape (matching the first rater's format so results are directly comparable):

```json
{
  "rater": "<your identifier, e.g. 'agent rater (fresh sub-agent, no taxonomy context)' or a human name/role>",
  "method": "Blind: rater saw only X/Y text and the claim, not pairs_key.json or any other rater's picks, until all 25 were rated.",
  "criterion": "Which of X/Y better grounds a debater on THIS claim as a node reference inside a debate prompt: specific/concrete and on-topic for the claim beats generic taxonomic scope-setting (Encompasses/Excludes framing reads as documentation, not a usable debate reference).",
  "n": 25,
  "ratings": [
    {"pair_id": "p00", "picked": "X", "why": "<your one-sentence reason>"},
    ...
  ]
}
```

Save it as `second_rater_ratings.json` in this same directory (`research/comp-linguist/analyses/t4434-synthetic-attribution/`).

## If you are an agent rater (the TL's default, t/4434#5)

- You must be a **fresh sub-agent with no prior context on this ticket or this analysis** — don't reuse an agent that has already seen `pairs_key.json`, the CL's ratings, or this ticket's comments.
- Give it only `pairs.json` and this instructions file. Do not give it `RESULTS.md`, the key file, or the ticket.
- Record in your output's `"rater"` field that it was an agent rater, for the disclosure the TL required (t/4434#5): any citation of this result outside the project must say the second rater was an agent.
- Once `second_rater_ratings.json` exists, the CL computes agreement against the first rater's `blind_ratings.json` and posts the result on t/4434 — no further action needed from the rater.
