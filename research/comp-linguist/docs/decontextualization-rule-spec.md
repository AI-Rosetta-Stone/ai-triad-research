# Self-contained claims: decontextualization rule and `anchors` field

**Ticket:** t/4471 (epic t/4467) · **Author:** Computational Linguist · **Date:** 2026-10-25
**Status:** spec ready for implementation (PowerShell: document and org prompts; DebateTool: debate prompt).
**Provenance:** the baseline is a CL single-rater hand annotation of a fixed sample. The matching check is deterministic. Data and scripts are in `analyses/t4471-decontextualization/`.

## 1. What the baseline showed

The external review (t/4467) asked for decontextualized claims, meaning no pronouns or deictics pointing back into the source. It also said document factual claims are 2–5 sentence blobs that need a separate canonical form. Both claims were checked against the corpus before any wording was drafted.

| Field | Sample | Unresolved pronoun or deictic | Source-internal term or date without a year | Specific referent dropped | Artifact |
|---|---|---|---|---|---|
| key_point `canonical_proposition` | 50 | 0 | 1 | 4 (3 verified, 1 partial) | 1 |
| document `factual_claims.claim` | 50 | 2 | 5 | 0 | 1 |
| org stance `canonical_proposition` | 20 | **5** ("The organization …") | 0 | 0 | 0 |
| debate `canonical_proposition` | 19 (all in corpus) | 0 | 2 ("the attestation") | 0 | 0 |

The scale-free length check covers every item: 4,017 canonical propositions and 5,322 factual claims.

- **Canonical propositions are short:** median 17 words, 0.3% over 25, none over 30.
- **Factual claims are not blobs:** median 23 words, 17% over 30, mostly one sentence. A separate canonical form for them would mostly duplicate `claim`.

**Two failure modes, not one:**
1. **Outward references.** These are pronouns, "the organization", source-internal names and dates without a year. They are worst in org claims (25%) and present in factual claims (14%).
2. **Lost referents.** A key_point *about* a specific instrument becomes a generic one. "The EU Digital Services Act requires major platforms to …" turns into "Digital platforms must …". This comes from the current instruction to "write it in the same voice as taxonomy node descriptions", which pushes toward abstraction.

## 2. Why the referent goes in its own field

Restoring the dropped referent *inside* the canonical proposition was tested on the 11 sampled key_points where the claim is genuinely about a named instrument (`anchored.py`; the rewrites are constructed, the assignments observed). Mean cosine to the assigned node fell by 0.049. Rank was neutral overall (3 better, 3 worse, 5 the same; median 3 → 4), but one rank-1 match dropped to rank 4. The proposition is the taxonomy-matching key, so the referent goes in a separate additive field, `anchors`, and the proposition stays general.

The other 13 of the 24 sampled "dropped names" were **correct generalizations**. There the source names a country or study only as an *example* for a general claim ("a big study out of China" supporting a claim about AI and learning). The rule has to keep that distinction, or the anchors fill with incidental names.

## 3. The rule (shared wording)

Insert this block into each canonical_proposition instruction, adapting only the field names noted in §4.

```
SELF-CONTAINED:
  A reader who has never seen the source must understand the sentence on its own.
  1. Nothing may point outside the sentence: no "it", "they", "this policy",
     "the authors", "the document", "the study", "the organization", "the company".
  2. Replace a name the source invented with what it is, using only what the
     source itself says it is. Never add detail the source does not give:
     "the attestation" -> "the mandatory data-processing attestation" only if
     the source has said it is mandatory and about data processing.
  3. Every date carries a year: "by 15 December 2025", never "by Dec. 15".
  4. Keep the proposition general enough to match a taxonomy node. Put the
     specific instrument, jurisdiction, organization or date that the claim is
     ABOUT in "anchors" instead (see below). Do not invent an anchor the source
     does not give.

  Examples:
    Source: "In the EU, the Digital Services Act (DSA) requires major platforms to
             conduct and publish annual systemic risk assessments ... [and] to adopt
             reasonable, proportionate and effective mitigation measures."
    canonical_proposition: "Major online platforms ought to conduct annual systemic
             risk assessments and adopt proportionate mitigation measures."
    anchors: ["EU Digital Services Act"]

    Source: "... a big study out of China ... kids using A.I. had increases on their
             homework scores, and then when they had to test outside of that
             context, their test scores began falling."
    canonical_proposition: "Students who use AI for homework score worse on tests
             taken without it."
    anchors: []          (China is an example here, not what the claim is about)

    Earlier in the debate: "We propose a mandatory attestation of how the system
             processes personal data."
    Later turn: "The attestation should cover everything the system processes,
             bystanders included."
    canonical_proposition: "A mandatory attestation of personal-data processing
             ought to cover all data the system processes, including bystanders'."
    anchors: []          (every word traces to the two turns; nothing is added)

ANCHORS:
  "anchors": list of the specific instruments, jurisdictions, organizations or
  dates the claim is ABOUT, as named in the source, e.g. ["EU AI Act Article 62"],
  ["California Judicial Council", "2025-12-15"]. Use [] for a general claim, and
  when a name appears only as an example.
```

## 4. Per-pipeline edits

**Document extraction** (`scripts/AITriad/Prompts/pov-summary-system.prompt`, `pov-summary-chunk-system.prompt`, `pov-summary-schema.prompt`):
- Insert §3 under CANONICAL PROPOSITION.
- Replace "Write it in the same voice as taxonomy node descriptions." with "Write it in the general register of taxonomy node descriptions, following SELF-CONTAINED below."
- Add `"anchors": ["<instruments/jurisdictions/organizations/dates the claim is about, or []>"]` to the key_point schema, next to `canonical_proposition`.
- **Factual claims:** add rules 1–3 only (no anchors, no rule 4) to the `claim` instruction. A factual claim keeps its names in the text, because it is the reader-facing sentence. There is **no new canonical field** for factual claims, because §1 shows they are already short. This deliberately departs from the ticket's item 1.

**Org stance extraction** (`scripts/AITriad/Prompts/org-stance-extraction.prompt`):
- Insert §3, plus one org-specific line: "Never write 'the organization' or 'the company'. When the position concerns the organization's own policy, write the role it acts in ('A frontier AI developer ought to …'). The organization's name is already recorded on the claim; name its own instrument in anchors (e.g. ['Responsible Scaling Policy'])."
- Add `anchors` to the output schema.

**Debate claims** (`lib/debate/argumentNetwork/prompts.ts`, the claim-extraction `canonical_proposition` bullet):
- Insert rules 1–3. Rule 2 matters most here, because debaters coin names mid-debate.
- `anchors` is **optional** for debate in v1. Debate claims rarely concern named instruments (n=19), so add it only if the type change is trivial.

**Word cap:** keep ≤30. Tightening to ≤25 would affect 0.3% of current output, so it changes nothing measurable. It stays stipulated, and the register entry records that it was kept.

## 5. Tier and consumers

- `anchors` is an additive, forensic field that nothing branches on, so it is **T0** with a point-of-use exemption note (the `lib/ai-client/types.ts` model). The first consumer that branches on it, for example a display or conflict-matching use, makes that consumer's PR T1.
- The prompt-wording changes are CL mandatory review.
- QBAF conflict NLI (t/4474) keeps using `claim`. Item 4 of the ticket is moot, because no factual canonical field is added.

## 6. Measurement after landing

The spend for re-extraction is routed through the TL. Rates are reported with n, using the same rubric (`analyses/t4471-decontextualization/labels.json` classes).

1. **Document:** re-extract 10 single-call documents drawn from the baseline sample's docs. Annotate 50 new canonical propositions and 50 new factual claims.
   - **Pass:** outward references ≤ 2% in both, and no rise in artifacts.
   - **Matching guard:** on the same documents, run the t/4469 `retrieval_ceiling.py` paired comparison. Hit@5 of the assigned node in the POV+BDI pool must not fall by more than 2 points (stipulated tolerance).
2. **Org:** re-run stance extraction for the documents behind the 5 "The organization" claims, plus 15 others. Pass: 0 "the organization / the company" subjects.
3. **Debate:** the next eval batch (≥3 debates). Pass: no source-internal definite descriptions in a 20-claim sample. The ticket's t/507 debate MRR needs re-run debates, so it is reported from that batch, and not claimed before.
4. **Anchors precision:** on 30 document key_points with non-empty `anchors`, check that each anchor is what the claim is *about*, not an incidental example. Pass ≥ 80%; otherwise tighten the rule-4 wording.
