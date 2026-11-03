# t/4471 round 2: factual-claim rules in the system prompt, anchors removal test

**Author:** Computational Linguist · **Date:** 2026-10-27 · **Spec:** `docs/decontextualization-rule-spec.md` §7
**Prompts measured:** the #3854 round-2 wording (t/4518), on `ai-triad-research` `fcbe33a8`. That revision contains #3854 and not #3867 (t/4519 density change), so the prompt wording is the only variable that changed from round 1. Model gemini-3.5-flash-lite, FIRE mode, temperature 0.1, matching the saved summaries.
**Spend:** about $0.2, the same document set and model as round 1. The cumulative t/4471 spend is about $0.4 of the PI's $5 cap (t/4471#3). Calls aren't logged with a cost, so this is estimated from prompt sizes.
**Isolation:** the data root was the detached `ai-triad-data` worktree `.worktrees/data-t4471-r2` at `d20bfd46`, and the sources root was a scratch copy. The run script refused to start unless both roots resolved to scratch. Afterwards, neither real repo showed a change under `summaries/`, `conflicts/`, `taxonomy/` or any measured document's source folder. Both real repos carry unrelated pre-existing changes from other roles.
**Provenance of the run:** the extraction ran on 2026-10-26, 12:36–12:54 EDT, in an earlier CL session that ended before scoring. This analysis scores those outputs and makes no new model calls.

## Method

**Blind labelling.** Round-1 and round-2 items are pooled and shuffled (seed 4471) under opaque ids (`make_sheets.py`). Every label was written before `labelling/key.json` was read (`score.py` un-blinds them).
- **Factual claims:** 89 claims (45 round 1, 44 round 2), with the baseline classes (`labels.json`).
- **Anchors:** 64 non-empty `anchors` lists (29 round 1, 35 round 2).
- **Canonical propositions:** the 73 round-2 key-point propositions, as a regression check.

Round 1 was re-labelled under the same blind conditions, so the before/after comparison uses a single label set.

**Anchors rule as labelled.** A list is correct only if every name in it is something the key point asserts about: removing the name would change the assertion. A name brought in as an example ("such as", "like", "illustrated by", "citing"), a name that is the source of a figure or quotation, or a name absent from the point's content makes the list wrong. The test is applied to the key point (`point`), because `canonical_proposition` is general by design.

**Contamination guard (§7c, registered before any run).** Three documents supply the round-2 examples: Atria Dawn, the Council of Europe piece (`ai-companies-have-become-democratically-accountable-2026`) and the Anthropic settlement. The factual-claim and anchors verdicts are read on the other 8 documents, with all-11 figures alongside.

## Results against the pre-registered bars

| Arm | Round 1 | Round 2 | Bar | Verdict |
|---|---|---|---|---|
| Factual-claim outward references, **8 uncontaminated docs** | 2/33 (6.1%) | **1/30 (3.3%)** | ≤ 2% | **FAIL** |
| Factual-claim outward references, all 11 | 6/45 (13.3%) | 2/44 (4.5%) | (reported alongside) | — |
| Factual-claim artifacts, all 11 | 3/45 | 1/44 | no rise | pass |
| `anchors` precision, **8 uncontaminated docs** | 15/26 (58%) | **8/25 (32%)** | ≥ 80% | **FAIL, worse** |
| `anchors` precision, all 11 | 15/29 (52%) | 14/35 (40%) | (reported alongside) | — |
| Key-point canonical outward references | 0/70 | **1/73 (1.4%)** | ≤ 2% | **PASS** |
| Org "the organization / the company" subjects | 0/57 | **0/44** | 0 | **PASS** |
| Hit@5 of the assigned node, POV+BDI pool | 0.621 (n=66) | **0.667 (n=63)** | no fall > 2 pts | **PASS** |

All labels are the CL's alone (single rater). This blind re-label puts round 1 at 6/45 factual and 15/29 anchors, against 5/45 and 16/29 in the unblinded round-1 labels: one item each way.

### Factual claims: a real move, mostly on the docs that supplied the examples
Over all 11 documents, the outward-reference rate fell from 13.3% to 4.5%. Most of that fall came from the documents that supplied the examples:
- **Atria Dawn:** the round-1 claims "Participants rated…", "In an analysis of 588 tasks…" and "during the development process" now name the project.
- **The settlement:** "The settlement provides…" now reads "Anthropic will compensate…".

On the 8 uncontaminated documents the change is 2/33 → 1/30, too few items to tell from noise, and the one remaining item misses the bar on its own. That item is F011, the UK AISI claim "disclosed **the cyber evaluation incident** publicly". This is exactly the "the incident" pattern that rule 1 names. The other round-2 failure, "across 21 to 22 participants", comes from the Atria Dawn document itself. So the rule hasn't transferred cleanly beyond its worked examples. Under the guard, a pass that holds only on the example documents is a fail.

### Anchors: the removal test made precision worse
Round 2 emits more non-empty lists (35 against 29) and fewer correct ones. The 21 failing round-2 lists sort into four patterns:

| Failure pattern | n | Examples |
|---|---|---|
| Example names ("such as", "like", "including") | 5 | Thaler v. Hirshfeld, Tennessee ELVIS Act, California AB 3211, Library Genesis, Hugging Face attack |
| Evidence or source of a figure or quotation | 4 | UK AISI evaluation ×2, Stanford RegLab, UCLA ITLP / Mark McKenna |
| Instance of a general claim | 7 | Anthropic / Pentagon, Trump administration, OpenAI / Sam Altman, Council of Europe ×2, Netherlands / UK / Australia, OpenAI / ChatGPT |
| Name incidental to, or absent from, the point | 5 | Claudio Novoa, Taft-Hartley Act, SB 53 / SB 813 on an executive-order point, Hugging Face attack on a kill-switch point, California |

The pre-registered negative example didn't transfer even on its own document. `['The Netherlands', 'the UK', 'Australia']` is still emitted for the same claim (A036), immediately after the prompt shows that exact case with `anchors: []`. flash-lite appears to treat `anchors` as "list the proper nouns in the evidence", whatever the wording says.

### What held
- **Org stance claims:** 0/44 role-noun subjects. The 44 claims come from 8 (org, source) pairs: 9 documents were processed, and one returned no claims. 17 of them carry anchors, and those name the policy instruments the claims are about (`Preparedness Framework`, `Responsible Scaling Policy`, `Broadband Equity Access and Deployment Program`). Org anchors were not labelled against the 80% bar, which is set for key points only.
- **Key-point canonical propositions:** 1/73. The one item, C033, is "Genie-like behavior", a term the source coined and the proposition leaves undefined.
- **Retrieval guard:** Hit@5 rose to 0.667.

## Next step (pre-registered in spec §7c; not run)

Both failures fall under the §7c rule: *if round 2 fails either bar again, run a model-tier check before any third wording round.*

**Proposed model-tier check:** re-extract the same 11 documents once with the gemini default extraction model, `gemini-3.1-pro-preview`, using the same prompts and isolation. Score them with the same blind sheets, extended with the new items.
- **Cost:** at `ai-models.json` pricing, pro is about 6.7× flash-lite on input and 4.8× on output. That puts it at **about $1.0–1.5** against round 2's ~$0.2. It fits in the remaining ~$4.6 of the PI's $5 cap, but it is the largest single draw on it, so it waits for an explicit go-ahead on the ticket.
- **Decision rule, set now:**
  - **Pro passes both bars on the 8 uncontaminated docs:** the defect is model capacity, not wording. Field-level decontextualization becomes a pro-tier (or post-hoc repair) concern, and no third wording round follows.
  - **Pro also fails anchors precision:** the field design is the problem, not the wording. Withdraw `anchors` from key points and keep it on org stance claims, where it is precise. That is a removal of an additive field nothing branches on, so it is still T0 under its exemption note.

The **debate arm** and the t/507 debate MRR are unchanged and still wait for the next debate-eval batch. They are tracked separately so that this ticket can close on the document and org arms.

## Files
- `make_sheets.py`: builds the blind sheets.
- `score.py`: un-blinds and scores.
- `scores.json`: the scored output.
- `labelling/`: the sheets, the key, and the factual-claim and anchors labels with a note on every negative.
- `org_claims_r2.json`: the round-2 org stance claims (scratch output).
- `measure_r2.json`: the `after_measure.py` output for round 2 (heuristic rates and Hit@5).
