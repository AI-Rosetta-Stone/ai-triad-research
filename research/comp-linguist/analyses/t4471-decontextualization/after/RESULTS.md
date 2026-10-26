# t/4471 after-measurement: self-contained claim rules in production prompts

**Author:** Computational Linguist · **Date:** 2026-10-26 · **Spec:** `docs/decontextualization-rule-spec.md` §6
**Prompts measured:** the #3802 document and org prompts, and the #3799 debate prompt, on `ai-triad-research` `e45b54a9`. Model gemini-3.5-flash-lite.
**Spend:** PI-approved, capped at $5 (t/4471#3). 11 summaries and 10 org-stance documents, about $0.2 estimated from prompt sizes; calls aren't logged with a cost.
**Isolation:** all output went to scratch. The data root was a detached `ai-triad-data` worktree at `d20bfd46`; the sources root was a scratch copy of the 25 documents. A first test run had only the data root redirected, and it wrote `metadata.json` and `_index.json` into the real `ai-triad-sources` checkout. Both were restored byte-exact from HEAD within minutes (Sage p/7#147). Every later run checked that both real repos were unchanged.

## Results against the pre-registered bars

| Arm | Before | After | Bar | Verdict |
|---|---|---|---|---|
| Key-point `canonical_proposition` outward references | 0/50 (baseline sample) | **0/70** | ≤ 2% | **PASS** |
| Key-point referent kept (via `anchors`) | 4/50 dropped (baseline) | the baseline's 3 verified cases recur here, and all are now anchored | — | improved |
| Factual-claim outward references, **same 11 docs** | 5/40 (12.5%) | **5/45 (11.1%)** | ≤ 2% | **FAIL** |
| Factual-claim artifacts ("the source document does not contain…") | 2/40 | 3/45 | no rise | flat (pre-existing FIRE defect, see below) |
| Hit@5 of the assigned node, canonical query, POV+BDI (same docs) | 0.40 (n=65) | 0.62 (n=66) | drop ≤ 2 pts | **PASS** (confounded: #3792's retrieval fix also landed) |
| Org stance: "the organization / the company" subjects, same 10 docs | 9/54 | **0/57** | 0 | **PASS** |
| `anchors` precision: every anchor is what the claim is *about* | — | **16/29 (55%)** | ≥ 80% | **FAIL** |
| Debate | — | — | next eval batch | pending |

All labels are the CL's alone (single rater).

## What worked
- **Org claims.** The role-noun rule works. "The organization ought to require board approval…" became "A frontier AI developer's responsible scaling policy ought to be formally approved by its board…", with anchors `['Responsible Scaling Policy', 'Long Term Benefit Trust']`.
- **Key-point dates and named instruments.** The baseline's K17 ("judicial bodies … by December 15") is now "Courts ought to mandate … by 15 December 2025", anchors `['California Judicial Council']`. The baseline's dropped SB 813 / AB 1405 / SB 53 and FTC dual-disclosure referents are anchored.

## What didn't
1. **Factual claims are no better.** The new wording hasn't moved them, and two claims got worse. The old Atria Dawn claims named the system ("An analysis of 769 task records from 56 participants developing Atria Dawn"). The new ones don't ("Participants rated…", "during the development process"). "The incident" (UK AISI) and "The settlement" (Anthropic) also persist. Rules 1–3 sit inside a long schema-field description, and flash-lite weights them less than the field's other instructions ("2-5 sentences…"). Most of the regex-heuristic rise (5% → 11%) is false positives: in-sentence pronouns in richer claims.
2. **Anchors over-collect examples.** 13 of 29 non-empty `anchors` lists include a name that's only an example or a source. Examples: `['Netherlands', 'UK', 'Australia']` for a general harm claim, `['UCLA School of Law']` for a quoted professor's employer, `['Brennan Center']`, `['Palantir']`, `['Stanford University RegLab']`. Rule 4's "about vs example" distinction isn't landing. The spec's own example of this case didn't transfer.

## Separate finding: FIRE-mode meta-claims
In the whole corpus, 20 of 5,322 factual claims (19 docs) are statements of absence, such as "The source document does not contain any factual claims regarding…". **All 20 come from FIRE mode** (20 of 2,140 FIRE claims; 0 of 3,087 single-shot). FIRE's verification step writes a failed check as a claim. Filed for PowerShell.

## Next (pre-registered here, before any run)
**Round 2 wording, CL drafts and PowerShell lands:**
- **(a)** Move factual-claim rules 1–3 out of the schema field description into the system prompt's FACTUAL CLAIMS section, with one before/after example built from this run's Atria Dawn claim.
- **(b)** Replace rule 4's anchor wording with a test the model can apply: *"Anchor a name only if removing it would change what the claim asserts. A name that illustrates a general claim, or is the source of a statistic, is not an anchor."* Add one negative example, the Netherlands/UK/Australia case.

**Re-measure** on the same 11 docs, with the same bars. Reuse the remaining approved budget (about $4.8 of $5).
