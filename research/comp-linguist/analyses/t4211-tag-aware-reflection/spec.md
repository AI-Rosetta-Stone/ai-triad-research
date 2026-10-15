# Tag-aware post-debate reflection: specification

**Author:** Computational Linguist
**Date:** 2026-10-15
**Ticket:** t/4211 (asked for by the PI in p/314#196, approved in p/314#198). **Tier:** T1, because a new gate branches on `pov_tags`.
**Status:** Spec for the two implementation children. CL owns the rule, the judge prompt's contract and the measurement.
**Background:** POV tags spec `analyses/t3935-pov-tags/spec.md`; tag souls t/3975 and t/4007; evidence gate t/3512.

## 1. The problem

Skeptic has three souls: the umbrella `skeptic` soul and the tag souls `skeptic.critical` and `skeptic.institutional`. A seat in a debate is either untagged, in which case it speaks with the umbrella soul, or tagged with one tag (`session.seat_tags[speaker].pov_tag`).

After the debate, each seat reflects and proposes edits to its camp's nodes: `revise`, `qualify` or `deprecate` an existing node, or `propose_new`. Today the reflector is checked only against **its own** soul:

- `reflectionPrompt(...)` receives the seat's soul (t/3975) and renders that soul's character block and doctrinal boundaries. No other soul is in view.
- The candidate nodes come from `computeNodeEngagement(input, 'skp-')` in `lib/debate/reflectionScope.ts`. It filters by **POV prefix, not by tag**, and so does the optional full-taxonomy sweep.
- `ReflectionTaxonomyNode` carries no `pov_tags`, so the reflector cannot tell which wing a node belongs to.
- `ReflectionsPanel.tsx` shows no tags, so the person approving an edit cannot tell either.
- `createProposalNode` (the `propose_new` apply path) writes no `pov_tags`. Every reflection-created Skeptic node lands **untagged**, which breaks the t/3962 coverage rule, and Scope mode then silently leaves it out.

The only safeguard is the human approving each edit, and that person isn't shown what they would need to catch a conflict.

### 1.1 How often this happens (baseline)

`scripts/t4211_reflection_tag_baseline.py`, run against data commit `b030e2b3`, classifies every past Skeptic reflection edit by its target node's **current** tags:

| Skeptic nodes (n=377) | count |
|---|---|
| critical only | 147 |
| both tags | 130 |
| institutional only | 94 |
| untagged | 6 |

| Skeptic reflection edits to existing nodes (n=177, from 91 debates) | count | share |
|---|---|---|
| target is critical only | 70 | 40% |
| target is both | 59 | 33% |
| target is institutional only | 48 | 27% |
| target is untagged | 0 | 0% |

Another 14 edits name a node that no longer exists, and they are excluded. No debate yet has `seat_tags`, so all 177 edits came from **untagged** seats and were judged against the umbrella soul only. Even so, **67% of them (118 of 177) edited ground that is now held by exactly one wing**, and none were checked against that wing's soul. The exposure is not limited to tagged seats; the untagged seat is the larger population today.

The stored edits all read `status: "pending"`, because the apply or dismiss decision is not saved into the debate file. Applied and override rates therefore cannot be measured from data yet (see §6 and child R-5).

## 2. Definitions

- **Seat tag `s`:** the seat's `pov_tag`, or `none` for an untagged seat.
- **Target tags `T`:** the target node's `pov_tags` as currently stored (absent or empty means `∅`).
- **Tag souls of a POV:** one per tag in `lib/debate/soul-docs/pov-tags.json`. Only Skeptic has tags today.
- **Custodian souls `C`:** the souls whose positions an edit to the target must stay true to, *other than the seat's own soul*:

| Seat | Target tags `T` | Relation | Custodians `C` |
|---|---|---|---|
| tagged `s` | `T = {s}` | `own` | ∅ (no check) |
| tagged `s` | `s ∈ T`, `|T| > 1` | `shared` | souls of `T \ {s}` |
| tagged `s` | `s ∉ T`, `T ≠ ∅` | `foreign` | n/a (refused, §3) |
| tagged `s` | `T = ∅` | `untagged_target` | umbrella soul + every tag soul except `s` |
| untagged | `T ≠ ∅` | `umbrella_on_tagged` | souls of `T` |
| untagged | `T = ∅` | `untagged_target` | every tag soul of the POV |
| any | POV has no tags | `no_tags` | ∅ (rule is a no-op) |

The rule is POV-general. Accelerationist and Safetyist have no tags, so for them it is a no-op (`no_tags`) until they get some, and their reflection prompts stay byte-identical.

## 3. The rule

For every `revise`, `qualify` and `deprecate` edit, after the DOLCE compliance retries have produced the final text:

1. **`own`, `no_tags`:** no change from today.
2. **`foreign`:** the edit is **flagged and refused** at apply time unless the reviewer overrides it. The panel shows "This node belongs to *<tags>*, not *<s>*". A tagged seat speaks for one wing and has no warrant to rewrite another wing's position. The edit is still shown rather than dropped, because the debate may have tested that node (Prioritize mode, or the full sweep).
3. **`shared`, `untagged_target`, `umbrella_on_tagged`:** run the **custodian check** (§4) against `C`. Then:
   - every custodian returns `consistent`: the edit is applied as today;
   - any custodian returns `tension`: the edit is applied as today, with the tension shown in the panel;
   - any custodian returns `conflict`: the edit is flagged and refused at apply time unless the reviewer overrides it;
   - the check fails (model error, unparseable output): the edit is flagged `unchecked` and refused unless the reviewer overrides it. A WARN is logged saying the check failed and why. This fails closed, because a silently skipped check is the failure this ticket closes.
4. **`deprecate` on a `shared` node from a tagged seat** is a special case. Deprecating shared ground removes it from the other wing too, so it is always treated as `conflict`, with the note "To drop this node from *<s>* only, remove the *<s>* tag instead". A tag change goes through the pov-tag proposal queue (`pov-tag-proposals.json`, t/4052), not through reflection.

**Re-check on change.** The relation and the verdict are stamped with the target's `pov_tags` fingerprint and a hash of the checked text. At apply time, if the node's tags changed, or the reviewer edited the label or description (the `overrides` argument), the stamp is stale. The edit is then refused with "re-run the tag check" unless the reviewer overrides it.

**Overrides** follow the t/3512 evidence-gate precedent. There is a separate option (`allowCrossTag`), a confirmation in the panel, and a recorded `applyReflectionEdit.cross_tag_overridden` WARN carrying the relation, the custodians and the verdicts. The human keeps the final say; the system makes the conflict impossible to miss, not impossible to apply.

### 3.1 New nodes (`propose_new`)

- **Tagged seat `s`:** the new node gets `pov_tags: [s]`. The reviewer may change it in the proposal card before applying. The value passes `validatePovTags` like any other write.
- **Untagged seat:** the new node stays untagged, the apply records a WARN naming the node as a coverage gap, and the node is listed for the tag-proposal pipeline. It is never silently left out of Scope with nothing to show for it.

## 4. The custodian check (judge prompt contract)

One model call per checked edit, covering every custodian soul at once. The prompt lives in `lib/debate/prompts/reflectionTagCheck.ts`, and CL has mandatory review of it.

**Input:**
- the edit type, the current label and description, the proposed label and description, and the reflector's rationale;
- for each custodian soul: its label, `value_hierarchy` (ranked), `boundaries.hardcoded` and `boundaries.softcoded`;
- the node's tags and the seat's tag, so the judge knows whose ground it is.

**Instructions (normative content; wording is DebateTool's under CL review):**
- Judge only whether the **proposed** text would be false, or unacceptable, to the custodian. Do not judge whether it is well written or whether the custodian would have phrased it differently.
- `conflict`: the proposed text asserts something a `hardcoded` boundary forbids, **or** it inverts the order of two values in the custodian's `value_hierarchy`.
- `tension`: it strains a `softcoded` boundary, or shifts emphasis between values without inverting them.
- `consistent`: neither.
- For `conflict` and `tension`, quote the boundary or value text verbatim, and give one sentence of reason.
- Compare against the current text. A change that keeps an existing conflict, without making it worse, is `consistent`. The gate is about what the edit **introduces**.

**Output (strict JSON):**

```json
{ "verdicts": [ { "soul": "skeptic.institutional", "verdict": "consistent" | "tension" | "conflict",
                  "cited": "<verbatim boundary or value text, or null>", "reason": "<one sentence>" } ] }
```

A verdict is required for every custodian; a missing one is treated as `unchecked`. The call uses temperature 0 and the configured debate model, and the model id is recorded on the annotation.

**Why one model call and not a rule or embedding check:** boundaries are prose positions. A lexical or embedding test would fire on shared vocabulary between the wings (both write about power and institutions) and miss real contradictions phrased differently. That is the same reason the t/3512 evidence gate checks claim references, not text similarity.

## 5. Prompt and UI changes

**Reflection prompt (`lib/debate/prompts/reflection.ts`):**
- Each node line gains its `pov_tags`, for example `[tags: critical, institutional]` or `[tags: none]`, but only for a POV whose registry has tags.
- **Tagged seat:** add a short block telling the reflector that it speaks for the *<s>* wing. Nodes tagged only for another wing are not its to revise; if the debate showed one is wrong, it should say so in `reflection_summary`. Nodes tagged for several wings are shared ground, and a revision must stay true for every wing listed.
- **Untagged seat:** add a block saying some nodes belong to one wing, and a revision must stay true to the wings listed.

This guidance is **advisory**. The gate in §3 is what enforces the rule.

**ReflectionsPanel (`taxonomy-editor/.../ReflectionsPanel.tsx`):**
- Each edit card shows the target's tags as chips, and the relation for anything other than `own` and `no_tags`.
- `foreign`, `conflict` and `unchecked` edits show the reason and the cited boundary. Their Apply button asks for confirmation before passing `allowCrossTag`, as the unsupported-evidence button already does.
- `tension` is shown and does not block.
- The `propose_new` card shows the proposed `pov_tags` and lets the reviewer edit them.

## 6. Measurement (CL)

- **M0 (done):** the baseline in §1.1.
- **M1 result (2026-10-15): the gate was not met.** See `m1-report.md`. The judge v2 changes, the constructed challenge set, and the interim "tension or conflict, confirm before apply" rule replace the go-live condition below.
- **M1, before the gate goes live (calibration):** run the judge offline over all 177 baseline edits. Each edit's custodians are computed as for an untagged seat, so `C` is the target's tag souls.
  - Report the `consistent`, `tension` and `conflict` counts, each with n.
  - Hand-label a stratified sample of at least 30 edits (spanning the three target classes, with at least 5 judged `conflict` and 5 judged `consistent`, so agreement can't be degenerate). Report agreement with the judge, as counts plus Cohen's κ with its n and prevalence (statistic-provenance rule).
  - Go-live condition: κ ≥ 0.6 on that sample **and** both the `conflict` and `consistent` cells are non-empty in both raters' labels. If κ is lower, revise the judge prompt and re-run M1.
- **M2, after go-live (monitoring):** per seat tag, over the first 50 Skeptic reflection edits:
  - the relation distribution;
  - the share of edits that were `foreign`, `conflict` or `unchecked`;
  - the override rate;
  - new nodes left untagged.

  M2 needs the apply or dismiss decision saved into the debate file (child R-5); flight-recorder events alone are not durable enough.

The classification table (§2) and the go-live κ threshold are **stipulated** (register §19). The judge's validity becomes **human-validated** once M1 passes.

## 7. Implementation split

**DebateTool (`lib/debate`):**
- **D-1:** a pure `classifyTagRelation(seatTag, targetTags, registry)` that returns the relation and the custodian soul ids from §2. Unit tests cover every row of the table, plus the `no_tags` byte-identical case.
- **D-2:** the custodian-check prompt and its output parser (§4), in `prompts/reflectionTagCheck.ts`. Parser tests cover a missing verdict, an invalid verdict value, and a `conflict` with no citation (that last one is treated as `unchecked`).
- **D-3:** add `pov_tags` to `ReflectionTaxonomyNode` and render the tag lines and tag blocks (§5). Snapshot tests: a Skeptic prompt for each of the three seat kinds; Accelerationist and Safetyist prompts unchanged.

**Rosetta Stone (`taxonomy-editor`):**
- **R-1:** in `buildReflectionNodes`, pass `pov_tags` through to the prompt nodes.
- **R-2:** after `runDolceComplianceRetries`, annotate each edit with the relation, the custodians and the verdicts (calling D-1 and D-2), stamped with the tag fingerprint and a hash of the checked text.
- **R-3:** add the `applyReflectionEdit` gate with the `allowCrossTag` override and the stale-stamp re-check (§3), following the evidence-gate pattern, including its flight-recorder events.
- **R-4:** `createProposalNode` writes `pov_tags: [s]` for a tagged seat; for an untagged seat it records the coverage-gap WARN (§3.1).
- **R-5:** save each edit's final decision (applied, dismissed, overridden) into the debate file, so M2 can be measured.
- **R-6:** the ReflectionsPanel changes in §5.

R-2 depends on D-1 and D-2, and R-1 lands together with D-3. Each child is T1; the gate in R-3 is the first branching reader of `pov_tags` in the reflection path.

## 8. What this does not close

- **Human override:** a reviewer can still apply a flagged edit. That is by design, and every override is recorded.
- **Edges:** `propose_new` edges can point at another wing's nodes (for example `CONTRADICTS`). Edges are not checked against custodian souls here. That's a known gap; file a follow-up if M2 shows such edges.
- **Judge error:** the judge can miss a conflict. M1 bounds the miss rate on the baseline set, and M2 sampling re-checks it.
- **Tag drift:** an edit applied correctly under today's tags can later sit on a node whose tags change. The tag-proposal queue owns tag changes, and that queue does not re-check prose against the new wing.
