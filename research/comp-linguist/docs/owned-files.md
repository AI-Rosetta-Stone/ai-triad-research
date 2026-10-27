# Computational Linguist — Owned Files

**Last updated:** 2026-10-27 (t/4523: `org-endorsement-gate.prompt`, the LLM endorsement-confirmation gate for org claim matching.)
**Author:** Computational Linguist (Orca)

Files the Computational Linguist holds **mandatory review authority** over. Changes to any of these block merge until CL review (see `research/comp-linguist/AGENTS.md` → *When to Engage*). This list is updated in any PR that adds new prompt-bearing or metric-bearing code — see the Maintenance rule at the bottom.

| File | Domain | Review type |
|---|---|---|
| **Prompt templates** | | |
| `scripts/AITriad/Prompts/*.prompt` | PS prompt templates | Mandatory |
| `scripts/AITriad/Prompts/org-endorsement-gate.prompt` | Endorsement-confirmation gate for org claim matching (t/4475 7b, t/4523) — distinguishes an org position that asserts a node's proposition from one that only shares its topic | Mandatory |
| `scripts/AITriad/Private/Test-OrgEndorsement.ps1` | PS wrapper over the endorsement gate's AI call (t/4523) | Mandatory |
| `scripts/AITriad/Private/Get-Prompt.ps1` | PS prompt loader | Mandatory |
| `lib/debate/prompts/**` | TS debate prompts. The former `prompts.ts` is now a folder (opening, turn, turn-pipeline, moderator, synthesis, reflection, `reflectionTagCheck` custodian judge, and others) | Mandatory |
| `lib/debate/soul-docs/**` | POV and tag soul documents plus `pov-tags.json`; they feed every persona and the custodian judge (t/3975, t/4211) | Mandatory |
| `taxonomy-editor/src/renderer/prompts/**` | Renderer prompts. Rows below name the original four; the folder also holds aphorism, argumentNetwork, debate and newDebateDialog | Mandatory |
| `lib/debate/topicCritique.ts` | Topic evaluation rubric | Mandatory |
| `lib/debate/synthesisPhases.ts` | Synthesis phase prompts | Mandatory |
| `lib/debate/neutralEvaluator.ts` | Neutral evaluation prompts | Mandatory |
| `taxonomy-editor/src/renderer/prompts/chat.ts` | Chat prompts | Mandatory |
| `taxonomy-editor/src/renderer/prompts/analysis.ts` | Analysis prompts | Mandatory |
| `taxonomy-editor/src/renderer/prompts/research.ts` | Research prompts | Mandatory |
| `taxonomy-editor/src/renderer/prompts/vernacular.ts` | Vernacular rewriting prompt | Mandatory |
| `taxonomy-editor/src/renderer/data/promptCatalog.ts` | Prompt catalog | Mandatory |
| `lib/oped/prompts/*.prompt` | Op-ed generation/edit/source-brief prompts (outlet-aware `{{STYLE_*}}` slots, t/3796) | Mandatory |
| `lib/oped/outletBands.ts` | Op-ed outlet bands: word targets, per-outlet `guidance` + `style` wording + readability thresholds (register §16); default outlet = TechPolicyPress (t/3796) | Mandatory |
| `lib/oped/readabilityMeasure.ts` | Op-ed readability edit-pass thresholds + banned-tell list (register §16, t/3707/t/3796) | Mandatory |
| **Metric definitions & calibration** | | |
| `lib/debate/calibrationLogger.ts` + `lib/debate/calibrationLogger/**` (barrel + sub-modules post-t/1686: `schema.ts`, `extract.ts`, `extract-metrics.ts` — incl. semantic crux matching t/1853 — `coverage.ts`, `history.ts`, `io.ts`, `replicationGate.ts`) | Metric extraction logic | Mandatory |
| `lib/debate/aif/**` (`types.ts`, `graph.ts`; AIF v1 node/edge shapes, SO-cleared t/3589) | AIF data-model substrate for crux/convergence metrics (B5) | Mandatory |
| `lib/debate/beliefConfidence.ts` | Belief confidence formula | Mandatory |
| `lib/debate/desirePriority.ts` | Desire priority assignment | Mandatory |
| `lib/debate/intentionOperationality.ts` | Intention operationality | Mandatory |
| `lib/debate/pragmaticSignals.ts` | Convergence lexicons | Mandatory |
| `lib/debate/claimOutcomes.ts` | Claim outcome thresholds | Mandatory |
| `lib/debate/convergenceSignals.ts` | Convergence signal computation | Mandatory |
| `lib/debate/situationScoring.ts` | Situation scoring weights | Mandatory |
| `lib/debate/schemeStagnation.ts` | Stagnation & diversity metrics | Mandatory |
| `lib/debate/confidenceDedup.ts` | Cross-debate dedup thresholds | Mandatory |
| `lib/debate/repairHintScoring.ts` | Repair hint relevance scoring | Mandatory |
| `lib/debate/operationalClosure.ts` | Operational-closure metric (self- vs opponent-targeted AN edges; t/1537) | Mandatory |
| `lib/debate/debateTested.ts` | Debate-Tested tier/verdict/sort-key computation (t/1523/t/1545) | Mandatory |
| `lib/debate/affectSignals.ts` | Affect lexicons, saturation rates, phase baselines (register §1, §5) | Mandatory |
| `lib/debate/clarityMetrics.ts` | Clarity metrics (sentence length, lexical diversity, jargon density) | Mandatory |
| `lib/debate/signalConfidence.ts` | Confidence gating for adaptive-staging signals | Mandatory |
| `lib/debate/policyScoring.ts` | Policy consensus score composition | Mandatory |
| `lib/debate/wellTestedSelection.ts` | Exclude-well-tested mode and under-tested boost (register: `UNDER_TESTED_BOOST`) | Mandatory |
| **Convergence & phase transitions** | | |
| `lib/debate/phaseTransitions.ts` | Phase transition logic | Mandatory |
| `lib/debate/cruxResolution.ts` | Crux resolution thresholds | Mandatory |
| `lib/debate/exclusionGuard.ts` | Exclusion boundary thresholds | Mandatory |
| `lib/debate/doctrinalAnchoring.ts` | Doctrinal anchoring config | Mandatory |
| `lib/debate/operationalityEvolution.ts` | Post-debate evolution thresholds | Mandatory |
| `lib/debate/lookaheadGate.ts` | Move-quality lookahead gate | Mandatory |
| `lib/debate/revoiceGate.ts` | Revoice anchor checking | Mandatory |
| `lib/debate/tieredCompression.ts` | Context compression windows | Mandatory |
| **Prompt assembly & taxonomy** | | |
| `lib/debate/debateRunner.ts` | Prompt assembly | Mandatory |
| `lib/debate/argumentNetwork.ts` | Argument network | Mandatory |
| `lib/debate/taxonomyContext.ts` | Taxonomy context formatting | Mandatory |
| `lib/debate/taxonomyRelevance.ts` | Taxonomy relevance scoring | Mandatory |
| `lib/debate/situationRefs.ts` | Situation reference extraction | Mandatory |
| `lib/debate/vocabularyContext.ts` | Vocabulary constraints | Mandatory |
| `lib/debate/counterfactualCrux.ts` | Counterfactual crux identification | Mandatory |
| `lib/debate/cruxTaxonomyFeedback.ts` | Crux-to-situation promotion | Mandatory |
| **Tag-aware reflection (t/4211)** | | |
| `lib/debate/reflectionScope.ts` | Reflection engagement scope, evidence check, `classifyTagRelation` custodian rule (spec §2) | Mandatory |
| `taxonomy-editor/src/renderer/hooks/useDebateStore/slices/reflectionTagGate.ts` | Custodian-check stamp and apply gate; `CUSTODIAN_CHECK_MODEL` pin, `TENSION_NEEDS_CONFIRMATION` and `TAG_GATE_ENFORCED` (register §19) | Mandatory |
| **Entity ontology (t/1767, t/1803)** | | |
| `ai-usages.json` → `enrichment.entity-extraction` | Entity extraction prompt (CL-owned instrument) | Mandatory |
| `<data>/taxonomy/Origin/entities.json` | Entity records — DOLCE-typed (`entity_type` + `dolce_category`, genus-differentia descriptions) | Mandatory |
| `<data>/taxonomy/Origin/entity_edges.json` | `EntityEdgeType` vocabulary — AIF-adjacent edge semantics | Mandatory |
| `<data>/taxonomy/Origin/entity_embeddings.json` | Entity linking/dedup vectors; `model` + `dim` recorded in-file so a silent model swap is detectable (t/1804) | Mandatory |
| `<data>/taxonomy/Origin/entity_mentions.json` | Entity-mention index — per-container mentions (derived artifact, rebuildable by re-index); schema/`Mention` type in `lib/entities/mentionTypes.ts` (t/1893) | Mandatory |
| **Other** | | |
| `scripts/AITriad/Private/Get-EmbeddingClusters.ps1` | Embeddings | Mandatory |
| `validation-report.json` | Validation outputs | Mandatory (sign-off) |
| `research/comp-linguist/docs/frame-survival-metric-spec.md` | Frame-survival metric family — definitions, thresholds, validation gates (t/2042) | Mandatory |
| `research/comp-linguist/analyses/edge-rationale-quality/check_rationale_quality.py` | Edge-rationale mechanical quality screen — stipulated flag thresholds (t/2444 A′) | Mandatory |
| `research/comp-linguist/analyses/edge-rationale-quality/judge-prompt.txt` | Edge-rationale LLM-judge scoring prompt (t/2444 A′) | Mandatory |
| `research/comp-linguist/data/conflict-outcome-labels.json` | Labeled conflict-outcome set — Pollock attack-type labels + outcome labels (prevail-claim/prevail-dispute/tie/undecided) for all 19 dispute-bearing conflicts; gates Potyka-2021 pilot and attack_weights gradient validation (t/3152) | Mandatory |
| `research/comp-linguist/analyses/t3597-grounding-coverage/compute_grounding_coverage.py` | Grounding-coverage metric — belief→primary-source traceability by summary-inversion; derived, no threshold (t/3597) | Mandatory |
| **logical_form / prover tooling (t/3126, t/3162, t/3127, t/3239)** | | |
| `research/comp-linguist/tools/formalize_node_lf.py` | Node `logical_form` populator — ports the formalization prompt over BDI nodes; one-identity grounding + mechanical modality; writes DOLCE-sorted frames (t/3162) | Mandatory |
| `research/comp-linguist/tools/frame_to_tptp.py` | `logical_form` → TPTP FOF serializer + fail-safe prover harness; axiom-independent (axiom module held for TL review) (t/3127) | Mandatory |
| `research/comp-linguist/tools/dolce_prover_pilot.py` | DOLCE-lite axiom module (5 flat-disjoint sorts, no covering, UNA grounded-ids, comparability filter — TL t/3127#4) + z3 frame-incompatibility prover + t/3128 edge-verification pilot (prover vs NLI) | Mandatory |
| `research/comp-linguist/tools/build_lf_golden_worksheet.py` | Deterministic stratified sampler → human-labeling worksheet for the `logical_form` golden set (t/3239) | Mandatory |
| `research/comp-linguist/tools/score_lf_golden.py` | `formalization_accuracy` scorer (per-stratum/macro/overall) + deterministic off-enum-sort hard gate over all frames (t/3239) | Mandatory |

## Maintenance rule

When any file is added that contains prompt text, computes a quality metric, defines a convergence/transition threshold, or touches DOLCE-typed data — it must be added to this table in the same PR.
