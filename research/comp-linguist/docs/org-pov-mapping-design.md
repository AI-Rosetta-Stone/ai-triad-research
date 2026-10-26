# Organization → POV Mapping: Methodology Review and Edge-Acquisition Design

**Date:** 2026-07-12
**Author:** Computational Linguist
**Owner request:** review the organizations work; suggest better ways to map orgs to
specific POVs, including how to acquire org→node edges.
**Companion docs:** `docs/organizations-status.md` (TL status audit) and
`docs/hld-organization-relationship-graph.md` (TL HLD, approved; edge storage shipped
2026-07-12 per TL, remaining UI in progress). Those documents cover the infrastructure. This note covers the measurement
methodology they don't: where alignment scores come from, and how org→node edges
get made.

## Findings (current mapping methodology)

1. **All 75 camp scores are stipulated.** 25 orgs × 3 camps of `pov_alignment` scores,
   hand-authored 2026-07-01, `source_refs: []` on every record. No evidence pointer,
   no generation pipeline, no update mechanism. By the provenance register's rule these
   are stipulated by definition. org-001 lists Anthropic's RSP position paper in
   `external_links`, so the evidence exists; it just isn't wired as evidence.
2. **Mapping stops above the BDI-node level.** `topic_engagement` on 9/25 orgs (11
   links), `policy_engagement` on 8/25 (8 links), and (post-HLD data, 2026-07-12) 36
   curated `ADVOCATES_FOR`/`OPPOSES` edges — all targeting `sit-*` situations.
   **Org→BDI-node mappings: zero.** The question the feature exists to answer, "which
   real organizations hold *this specific position*?", still has no data path at node
   granularity.
3. **The score construct is undefined.** Anthropic's accelerationist rationale cites
   *behavior* ("builds and deploys rapidly"); its safetyist rationale cites *stated
   commitments* (RSP). Two constructs feed one undefined decimal, and nothing anchors
   what +0.4 means vs +0.3. This is the same false-precision problem the Debate-Tested
   design rejected.

## Recommendations (summary)

| # | Recommendation | Cost | Ticket |
|---|---|---|---|
| R1 | Org→node edges via the claim-matching pipeline (design below) | M | t/1553 (PS pipeline), t/1554 (review UI) |
| R2 | Derive camp scores as rollups of approved org→node edges | S (after R1) | folded into t/1553 AC |
| R3 | Replace decimal camp scores with 5-point anchored tiers; split rhetorical vs behavioral stance | S (schema decision) | t/1556 (CL, blocked by t/1553 — tier boundaries derive from R2's real score distribution, per TL p/38#4) |
| R4 | `assessed_at` field + populate `source_refs` from `external_links` | XS | t/1555 |
| R5 | Consistency audit: camp scores vs topic/policy stances | XS (manual at 25 orgs) | CL runs after R4; instrument only if roster grows |

## R1 design: acquiring org→node edges

The pipeline reuses three assets that already exist: the ingested source corpus
(~650 documents, many *by* these orgs), the claim-extraction and
`canonical_proposition` register normalization from the debate engine, and the
claim→node embedding matcher evaluated end-to-end during the t/524 experiments. It
follows the machine-proposes / human-disposes pattern used everywhere else in the
system, because the matcher's measured accuracy (MRR ≈ 0.31 against the automated
golden set) is nowhere near auto-write quality. The HLD already commits to org edges
being "curated facts, not LLM-discovered claims"; proposal-then-curation automates the
expensive part while keeping that commitment true.

### Stage 0: Link orgs to documents (`PUBLISHED` edges)

Before any stance can be attributed, the system needs to know which documents speak
*for* an org.

- **Seed set:** each org's `external_links` (position papers, already curated, so this
  set is free).
- **Corpus match:** match org `name`/`short_name`/aliases against source-record
  metadata (publisher, author affiliation, URL domain) across the ingested corpus.
  Domain matching (`anthropic.com` → org-001) is high-precision; author-affiliation
  matching is noisier and goes to review rather than auto-link.
- **Output:** proposed `PUBLISHED` edges (`org-* → source id`) into the HLD's
  `organization_edges.json` with `status: "proposed"`. A human approves; approved edges
  are the document set for Stage 1.
- **Authorship ≠ endorsement caveat:** a document *hosted* by an org (a workshop paper,
  a guest post) is not the org's voice. The review step is the filter; the proposal
  carries the match basis (domain / metadata / manual) so the reviewer can judge.

### Stage 1: Extract stance claims per document

New UsageID `enrichment.org-stance-extraction`, with a CL-owned prompt. Given a
document published by the org, it extracts the positions **the org itself asserts or
opposes**, as distinct from positions the document merely reports, quotes, or attacks.
Each claim comes back with:
- `text` (near-verbatim) and `canonical_proposition` (≤30 words, register-normalized;
  the same field and rules as debate claim extraction, so the matcher sees the register
  it was tuned for),
- `polarity`: `asserts` | `opposes`,
- `extraction_confidence` (the existing 0–1 rubric).

Documents already carrying POV summaries provide a cross-check, not a substitute.
Summaries describe what a document says about the camps; this extraction captures what
the org commits to.

### Stage 2: Match claims to BDI nodes

Embedding match of each claim's `canonical_proposition` against node embeddings,
top-k = 5 candidates with cosine scores. Two implementation notes from the t/524
experiment series:
- Use description+assumes weights **0.67/0.33**, the grid-search optimum (MRR 0.3128)
  over the production 0.80/0.20 (MRR 0.3009). If production embeddings haven't been
  re-weighted yet, this pipeline is the second consumer that justifies doing it.
- Do NOT fine-tune the matcher for this task. All four fine-tuning attempts degraded
  the baseline (catastrophic forgetting at 22M params); composition and thresholds are
  the available levers.

### Stage 3: Aggregate into proposed edges

- Group matched claims by (node, polarity). A proposal is emitted when **either**
  ≥2 independent claims (different documents, or well-separated passages) agree, **or**
  1 claim matches with cosine at or above a high-precision threshold (stipulated start
  0.60, reevaluable from the review queue's accept/reject telemetry).
- `asserts` produces a proposed `ADVOCATES_FOR org-* → node` edge; `opposes` produces
  `OPPOSES`.
- Each proposal bundles its evidence (claim texts, source doc ids, similarity scores,
  match basis). That bundle **is** the `source_refs` and `rationale` of the eventual
  edge, so provenance is built in rather than bolted on.
- Per-org cap per batch (stipulated 20) so review stays a session, not a backlog.

### Stage 4: Human review

Proposals land in the HLD's `organization_edges.json` as `status: "proposed"`; the
reviewer approves, rejects, or edits. Two viable surfaces, in preference order:
1. **Extend the claim-attribution annotation tool** (`_annotation_tool.html`), which
   already has exactly the right interaction shape (claim text, candidate nodes,
   search by ID/label, POV/BDI filters, accept/reject, keyboard flow). An "org edge"
   mode is a variant, not a new tool.
2. The taxonomy-editor `OrganizationDetail` UI once the HLD's edge display lands.
   Better long-term home, but blocked on that work.

Rejected proposals are kept with status `rejected`. They are free threshold telemetry:
the accept rate per similarity band is the data that later moves the Stage 3 threshold
from stipulated to derived.

### Stage 5: Camp-score rollup (R2)

Once an org has approved edges, its per-camp alignment becomes computable from the
share and polarity of approved edges into each camp's nodes (a signed ratio, or the
anchored tier of R3 chosen by thresholds on that ratio). Scores become **derived**,
with the edges as evidence; the hand-written rationales remain as human context.
The rhetorical-vs-behavioral split (R3) stays orthogonal. This pipeline measures the
*rhetorical* stance (what the org publishes); the behavioral assessment stays a
human-curated annotation.

### Scale and cost

25 orgs × ~3–10 linked documents × ~5–15 stance claims ≈ 1–3K claims, reducing to a
few hundred proposals after aggregation. All extraction and matching runs on
flash-lite plus local embeddings; the binding cost is human review time, which the
per-org cap and evidence bundles are designed around.

### Provenance declarations (register entries at implementation time)

| Parameter | Value | Class |
|---|---|---|
| High-precision single-claim cosine threshold | 0.60 | stipulated |
| Multi-claim agreement minimum | 2 | stipulated |
| Per-org review batch cap | 20 | stipulated |
| Stage-2 field weights | 0.67/0.33 | derived (t/524 grid search) |
| Camp rollup formula (R2) | signed edge ratio | stipulated until validated |

## What this deliberately does not do

- **No auto-written edges.** Every edge a user sees passed human review.
- **No web-research stance inference.** Deriving org positions from live web search
  (rather than the ingested corpus) is hallucination-prone and unauditable. If the
  corpus lacks an org's documents, the fix is ingesting them, not asking a model to
  remember.
- **No debate-derived org stances.** Debater personas citing an org is evidence about
  our debates, not about the org.
- **Camp scores don't feed scoring/relevance anywhere**, matching the presentational
  discipline of `aphorism` and `external_evidence`, until R2 rollups are validated.

## Amendment (t/4475, 2026-10-26): recency rule and the single-claim threshold

Evidence: `analyses/t4475-org-r2/` on `ai-triad-data` `b93a2dbc`.

### State of the pipeline

- 6 of 25 orgs have stance claims (81 claims, `organization_stance_claims.json`).
- The matcher wrote **29** org→POV-node proposals on 2026-07-13, and **none has been reviewed**. All 29 are still `proposed`. The 92 approved and 5 rejected org edges are all other types (`PUBLISHED`, `ALLIED_WITH`, and situation-node `ADVOCATES_FOR`).
- So the R2 rollup (`Invoke-OrgDerivedCampScores`, approved edges only) has **no input**. Every org's derived camp score is the null state. The review tool from t/1554 exists; the review hasn't been done.

### Recency (7a): supersession, not decay

**Rule.** For one (org, node) pair with both an approved `ADVOCATES_FOR` and an approved `OPPOSES` edge, only the edge whose evidence is newer counts in the rollup. The other is reported as `superseded` and kept, not deleted. An edge's evidence date is the latest `date_published` among its `source_refs`. When either edge has no dated evidence, or both share a date, both count (their contributions cancel in the net ratio) and the rollup WARNs that the pair is unresolved, for a reviewer.

**Why supersession:**
- **Explainable.** "The 2026 statement replaced the 2023 one" is a sentence a reviewer can check against the evidence bundle. A decay weight is not.
- **Decay needs dates the corpus doesn't have.** 34 of 81 stance claims come from documents with no `date_published`. A half-life would weight 42% of the evidence by whatever fallback is chosen, which is a hidden stipulation.
- **Decay would also discount old positions an org still holds.** An org that said X in 2023 and hasn't said otherwise still holds X. Supersession only acts on a recorded change of position.

**Scope.** Supersession acts only on opposite-polarity pairs on the same node. Same-polarity evidence already merges into one edge at Stage 3 (one edge per org, node and type). A position on a *related* node is not a supersession. That is a judgement for the reviewer, not the rollup.

**Current effect: none.** No (org, node) pair has more than one edge today. The rule is cheap and deterministic, and it is specified now so the first pivot that appears is handled by design rather than by accident. Class: **stipulated**.

### Single-claim threshold (7b): no accept-rate data yet

**The ticket's telemetry doesn't exist.** The accept rate per similarity band has n = 0 in every band, because nothing has been reviewed. The threshold stays **stipulated at 0.60**.

**Interim precision estimate** (CL single rater; the edge statuses are unchanged; `labels.json`). Y = an org claim asserts the node; P = partial; N = topic overlap only:

| Cosine band | n | Y | P | N |
|---|---|---|---|---|
| < 0.60 (multi-claim basis) | 1 | 1 | 0 | 0 |
| 0.60–0.65 | 13 | 3 | 2 | 8 |
| 0.65–0.70 | 8 | 3 | 1 | 4 |
| ≥ 0.70 | 7 | 2 | 1 | 4 |
| **All** | **29** | **9** | **4** | **16** |

- **Cosine doesn't separate supported from unsupported proposals in this range.** The ≥ 0.70 band is no cleaner than 0.60–0.65. Raising the threshold would cut recall without buying precision, so it stays at 0.60.
- **False positives concentrate in large claim pools.** NIST has 34 claims and 8 of its 11 proposals are N. Taking the best cosine over many near-duplicate claims finds *some* topical neighbour for many nodes. This is a best-of-many effect, not a band effect.
- **The existing directional gate isn't a precision gate.** By design (t/2751#3) it only detects opposition, and it rates a genuine agreement 'unrelated'. It cannot reject a topical-only match.

**Decision: add an endorsement-confirmation gate rather than moving cosine.** For each proposal's representative claims, an LLM judges whether the claim *asserts* the node's proposition (entails or restates it), as opposed to sharing its topic. Proposals with no endorsing claim are still written, as `proposed`, but tagged `endorsement: none` and sorted after the endorsed ones in the review queue. A gate on a review queue should reorder and annotate, not delete, until its precision is known. Acceptance before it can drop anything: on the 29 labelled proposals it keeps ≥ 12 of the 13 Y/P and tags ≥ 10 of the 16 N, followed by a check on the first human-reviewed batch. Class: **stipulated** until that human-reviewed check.

**Re-check trigger for the 0.60 threshold:** once ≥ 20 proposals are human-reviewed in each of the 0.60–0.65 and ≥ 0.65 bands, compare accept rates. Move the threshold only if the lower band's accept rate is ≥ 15 points below the upper band's. Until then it stays where it is.

### Provenance additions

| Parameter | Value | Class |
|---|---|---|
| Rollup recency rule | supersession on opposite-polarity pairs by evidence date; undated → both count, WARN | stipulated |
| Single-claim cosine threshold | 0.60 (unchanged, n = 0 reviewed) | stipulated; re-check at ≥ 20 reviewed per band |
| Endorsement-confirmation gate | reorder and tag, never drop, until validated | stipulated |
