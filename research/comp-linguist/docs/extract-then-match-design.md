# Extract-then-match for document claim mapping: design spike

**Ticket:** t/4469 (epic t/4467) · **Author:** Computational Linguist · **Date:** 2026-10-24
**Ruling:** **NO-GO** for the three-pass design as specified. Three pieces of it are adopted separately (§7).
**Provenance:** derived (this study). Retrieval-layer measurements are deterministic, so the replication gate does not apply (t/2306 reasoning). Scripts and raw results are in `analyses/t4469-extract-then-match/`.

## 1. The question

An external review (t/4467) proposed changing how the document pipeline maps claims to taxonomy nodes. Today the extraction LLM receives up to 40 nodes (single call) or 150 per chunk (chunked), and picks a node for each key_point as it extracts. The proposal had three passes:

1. Extract atomic `canonical_proposition`s with no taxonomy in context.
2. Embed each proposition and retrieve its top 15 nodes, then rerank them with a cross-encoder.
3. A batched LLM adjudicates each claim against its top 5, or returns null.

The review gave three reasons: retrieval stops depending on truncated chunk text, extraction prompts get smaller, and one matcher could serve documents, debates and orgs.

## 2. What already exists

Most of the "match second" idea is already in the pipeline, and earlier studies have measured it:

- **Per-key_point retrieval after extraction already runs.** Mechanism #5 (t/2341, shipped in t/2357) scores every key_point against its own top candidates and surfaces alternatives when the top-1 beats the assigned node by more than 0.06. Auto-correct was cancelled because no safe margin band exists.
- **t/2341 adjudication (CL, n=30 random + 20 divergent, safetyist, single rater):** about 67% of assignments are correct, 20% borderline and 13% clear misfires. **About half of the misfires have no clean home that retrieval could find.** These are thematic-pillar nodes, out-of-scope extractions and taxonomy gaps. Retrieval-fixable misfires are about 7% of all assignments.
- **t/2306:** the ms-marco cross-encoder promotes Beliefs nodes when the pool mixes BDI categories, so it is NO-GO for default-on.
- **The chunk-truncation defect** that motivated part of the review is being fixed directly in t/4468. That fix does not need a pipeline redesign.

## 3. Measurement 1: the retrieval ceiling

**The question:** if pass 3 shows the adjudicator only a claim's top-k nodes, how often is the node the pipeline assigns today inside that k?

**Method:** `retrieval_ceiling.py`. The sample is every key_point that has all four query fields and an assigned node with an embedding: **n = 3,484 key_points from 317 documents**. Queries are encoded with the production model (all-MiniLM-L6-v2), and nodes are scored against the vectors in `embeddings.json`. Pools are the same POV (230–390 nodes), or the same POV and BDI category.

**The reference is the LLM-assigned node, which is not gold.** By t/2341 it is right about 67% of the time. Hit@k here therefore measures recall of a mostly-correct reference.

| Query field | Pool | Hit@1 | Hit@5 | Hit@15 | Hit@30 | Hit@50 | MRR |
|---|---|---|---|---|---|---|---|
| canonical_proposition | POV | .211 | .408 | .571 | .678 | .764 | .310 |
| canonical_proposition | POV+BDI | .264 | **.495** | .676 | **.789** | .869 | .378 |
| attribution_text | POV+BDI | .373 | .582 | .733 | .825 | .891 | .475 |
| point | POV+BDI | .251 | .525 | .727 | .828 | .898 | .382 |
| verbatim | POV+BDI | .107 | .306 | .533 | .688 | .799 | .213 |

By POV, canonical_proposition with the POV+BDI pool gives Hit@5 of .582 for acc (n=822), .450 for saf (n=1,469) and .492 for skp (n=1,193).

**How to read it:**
- **Top-5 adjudication would lose the current node for half of all claims.** Hit@5 is .495 on the field the design would match on.
- **These figures are upper bounds for a real pass 1.** In the corpus, `canonical_proposition` is written with the taxonomy in the prompt, and the extraction prompt tells the model to mirror node descriptions. A pass-1 proposition written without the taxonomy would sit further from node wording. `attribution_text`, the best field, explains an attribution after the node was chosen, so it cannot serve as a pass-1 query.
- **BDI scoping is nearly free and helps.** The key_point's own BDI category matches the assigned node's category for **99.3%** of items. Restricting the pool to that category raises Hit@5 by 5–11 points on every field and makes only 0.7% of assigned nodes unreachable.

**A rough accuracy ceiling for top-5 adjudication.** The adjudicator can only be right when the correct node is among the five it sees. Combining the table with t/2341:
- about 49.5% × ~0.9 of claims have a correct current node inside the top 5;
- about 7–10% have a misfire whose better home retrieval could surface.

That puts the ceiling at roughly **52–55% correct, against about 67% today**, before any adjudication errors. The same arithmetic at k=30 (78.9%) gives about 70–75%, roughly parity with today. The 0.9, the 7–10% and the 67% all rest on t/2341's n=30 single-rater sample, so these are bounds on direction, not point estimates.

## 4. Measurement 2: adjudication prompt budget

**Method:** `adjudication_budget.py`, over n = 4,017 claims in 321 documents with a median of 6 claims per document. Pass 3 batched per document carries the union of each claim's top-k.

| k | Distinct nodes per doc (median) | p90 | Candidate slots, unbatched (median) |
|---|---|---|---|
| 5 | 30 | 93 | 30 |
| 15 | 83 | 234 | 90 |
| 30 | **159** | 392 | 180 |

Today's single-call RAG prompt carries **40 nodes** (`model_info.taxonomy_nodes`, the median document). At k=30, the level where the ceiling reaches parity, the adjudication pass carries about **4× the taxonomy text** of today's extraction prompt for the median document, and needs an extra LLM call. **The "smaller prompts" benefit runs backwards** for most of the corpus. It holds only for long chunked documents, which today see up to 150 nodes per chunk.

## 5. Measurement 3: cross-encoder rerank within one BDI category

t/2306's NO-GO came from the cross-encoder's pull toward Beliefs in a mixed-BDI pool. A single-category pool removes that mechanism, so this re-tests rerank under the condition extract-then-match would create (t/4469#1).

**Method:** `rerank_within_bdi.py`, over n = 3,497 claims (those whose assigned node also has a label and description in the taxonomy files). The canonical_proposition query takes the bi-encoder top 15 in the POV+BDI pool, and `cross-encoder/ms-marco-MiniLM-L-6-v2` reranks them on "label: description". The reference is the LLM-assigned node. The assigned node is in the bi-encoder top 15 for 2,365 claims (67.6%), so no rerank of the top 15 can do better than that.

| Ranker | Hit@1 | Hit@3 | Hit@5 | Hit@10 | MRR@15 |
|---|---|---|---|---|---|
| bi-encoder | .263 | .418 | .496 | .612 | .369 |
| bi-encoder + cross-encoder | **.381** | .506 | **.565** | .637 | .462 |

The rerank moves the assigned node to rank 1 for 544 claims and off rank 1 for 134.

**How to read it:**
- **Within one BDI category, the t/2306 failure mode does not appear.** Agreement with the current assignment rises at every k.
- **But agreement is not accuracy.** The cross-encoder and the extraction LLM both read label and description text, and t/2341 found that real misfires are vocabulary collisions, which a lexically sensitive reranker would also favour. Part of the gain may be agreement with misfires. Only gold (t/4480) can separate the two.
- **It does not change the ruling.** A reranked top 5 holds the current node for 56.5% of claims, so the §3 arithmetic gives a ceiling of about 58–60%, still below today's ~67%.

**Cross-encoder decision, provenance stipulated → pending gold:** `Get-RelevantTaxonomyNodes` keeps rerank **off by default**, because its pools mix BDI categories and t/2306 stands. Within-BDI rerank is a **candidate** for Mechanism #5 surfacing (t/4478), to be turned on only after it beats the bi-encoder on the t/4480 gold.

## 6. Things this spike could not measure

- **Whether the single multi-lens prompt overloads flash-lite** (review claim 5). Neither the summaries nor `ai-call-log.jsonl` record JSON repair, truncation or finish reason for summary calls. The only trace of degraded output is malformed keys in 5 of 13,722 key_points (`canonical_pproposition`, `vergaon`, a leading-space `" mechanism_type"`). That rate is too low to support the claim. Observability follow-up filed (§8).
- **Mapping accuracy against real document gold.** Every accuracy number here leans on t/2341's 30-item single-rater sample. The debate gold set (515 claims, `claim-matching-experiments-report.md`) is system-generated and in a different register. The project has no human-validated document key_point → node gold set. Follow-up filed (§8).
- **Cost and latency of a full three-pass run** were not measured with live calls. §4 gives the token-side bound, and there was no reason to spend on a design the ceiling already rules out at k=5.

## 7. Ruling

**NO-GO on extract-then-match as specified.**
1. At k=5 the retrieval ceiling sits below today's accuracy (§3).
2. At k=30, where the ceiling reaches about parity, the adjudication prompt is about 4× today's taxonomy text, plus an extra call, for no measured gain (§4).
3. The useful half of "match second" already runs as Mechanism #5 surfacing, and about half of the remaining misfires are taxonomy-structure problems that no retrieval change reaches (t/2341).

**Reopen condition:** a two-rater document gold set (§8) shows current assignment accuracy clearly below the k=30 ceiling, with confidence intervals that don't overlap.

**Adopted separately:**
- **BDI-scoped per-key_point retrieval for Mechanism #5.** It costs nothing and adds 5–11 Hit@5 points, at 0.7% unreachable. The 0.06 surfacing margin was calibrated on the POV pool and must be re-checked.
- **The t/4468 whole-chunk query fix**, already in flight. It removes the truncation defect without a redesign.
- **Summary-call telemetry**, so that review claim 5 can be tested.

**Not adopted, with provenance unchanged:**
- **An embedder change** (bge or nomic). It was not evaluated here, and nothing in this study argues for or against it. It stays with `embedding-experiment-design.md`.
- **Cross-encoder on by default:** it stays off. Within-BDI rerank is a gold-gated candidate for Mechanism #5 (§5).

**One shared matcher module** for documents, debates and orgs is a code-hygiene question. Debates match in TypeScript (`lib/debate`) and orgs in `Invoke-OrgClaimMatching`. This study measured nothing that makes unification an accuracy lever, so it is out of scope.

## 8. Follow-ups

- **t/4478:** BDI-scoped Mechanism #5 retrieval, with the margin re-check (PowerShell, CL validates).
- **t/4479:** summary-call telemetry for JSON repair, truncation and finish reason (PowerShell).
- **t/4480:** a two-rater document key_point → node gold set, n ≥ 200 (CL). The reopen condition depends on it.
- **t/4470** (the implementation child) is cancelled with this ruling.
