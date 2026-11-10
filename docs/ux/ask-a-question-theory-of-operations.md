# Ask a Question: Theory of Operations

## Overview

This document describes how the Ask a Question inquiry feature works end-to-end: the five pipeline stages, the models and prompts involved, how results are persisted and linked, and the failure modes the system handles.

## The Five-Stage Pipeline

Ask a Question orchestrates a single `runInquiryPipeline` across two hosts—Electron desktop and web server. The two hosts share the same stage sequence so logic never drifts between them; each host handles its own job lifecycle, storage, and TTL.

The pipeline stages are defined in `lib/debate/inquiryPipeline.ts:37` as: `'deriving' | 'grounding' | 'debating' | 'projecting' | 'synthesizing'`.

### Stage 1: Deriving

**Purpose:** Create a bounded debate configuration from the user's question.

**Input:** User's natural-language question.

**Process:**

1. Derive a `DebateConfig` from the question and fidelity level (see `lib/debate/inquiryConfig.ts`).
   - Map question intent to relevant agent roles and debate shape.
   - Set turn order, debate depth, and convergence thresholds.
   - Set fidelity level (0.5–1.0) to control debate scope and cost. Higher fidelity = more turns, higher cost.

**Output:** A `DebateConfig` ready for the debate stage.

**Implementation:** `lib/debate/inquiryConfig.ts`, `deriveDebateConfig()`.

---

### Stage 2: Grounding

**Purpose:** Convert the user's question into a bounded debate by selecting relevant taxonomy nodes.

**Input:** User's question; the taxonomy (`taxonomy/Origin/nodes.json`).

**Process:**

1. Compute a query embedding using the shared embedding model (`ai.computeQueryEmbedding`).
2. Search the taxonomy's embedding index (`taxonomy/Origin/embeddings.json`, model: all-MiniLM-L6-v2, 384-dim) for the k most similar nodes, per camp.
3. Build a *grounding envelope*: an anchor situation (the root node defining the question's scope) plus per-camp node sets (beliefs, goals, methods relevant to the question).

**Output:** A `GroundingEnvelope` containing:
- `anchorSituation`: the situation node framing the question
- `nodesByCamp`: Map of camp → list of `{ nodeId, label }` pairs
- `campCoverage`: Which camps have low taxonomy coverage for this question (flagged for synthesis pass)

**Implementation:** `lib/debate/inquiryGrounding.ts`, `buildGroundingEnvelope()`.

**Failure mode:** If the embedding search returns no results or very weak results, the grounding envelope is sparse. The synthesis pass detects this via `campCoverage.lowCoverage` and flags the camp in the output with "The taxonomy has little that speaks directly to this question."

---

### Stage 3: Debating

**Purpose:** Run the full debate engine on the question, bounded by the grounding envelope.

**Input:** The `DebateConfig` from Stage 1; the `GroundingEnvelope` from Stage 2; the user's question.

**Process:**

1. Run `debateEngine.runHeadlessDebate()` with the config and question.
2. The debate engine runs up to N turns per agent, emitting:
   - Turns in the transcript
   - Intermediate QBAF relations (Quantified Bipolar Argumentation Framework, see `lib/debate/qbaf.ts`)
   - Termination reason (converged, budget exhausted, rate limit, other)

**Output:** A `DebateSession` containing the full transcript, argument network with QBAF edges, neutral evaluation scores (see `lib/debate/neutralEvaluator.ts`), final belief states, and termination metadata.

**Implementation:** `lib/debate/debateEngine.ts`, `runHeadlessDebate()`. QBAF and neutral evaluation are computed in-place during the debate.

**Failure modes:**
- **Budget exhaustion:** The debate runs out of API budget and terminates early. Termination is captured as `api_ceiling`.
- **Rate limiting:** An external API (Gemini, OpenAI, etc.) rate-limits the service. Termination is captured as `api_ceiling`.
- **Convergence timeout:** The debate does not converge within the configured turn limit. Termination is captured as `max_turns`.

All termination reasons are tracked in `TerminationReason` (closed union in `lib/debate/calibrationLogger/extract.ts`).

---

### Stage 4: Projecting

**Purpose:** Map the debate's termination reason to per-metric confidence scores.

**Input:** The `DebateSession` from Stage 3 and its `terminationReason`.

**Process:**

1. Extract raw metrics from the debate: convergence scores, turn count, argument density, etc. (see `getRawMetrics()` in `lib/debate/calibrationLogger/trustProjection.ts`).

2. Apply the trust projection matrix (per ADR-0002):
   - If termination was `converged`, all metrics get high confidence.
   - If termination was `api_ceiling` (budget exhausted or rate-limited), metrics depending on complete information (e.g., convergence score) get low confidence.
   - If termination was `max_turns`, convergence metric gets low confidence.

3. Return a `TrustProjection` object mapping metric name → confidence score.

**Output:** Per-metric trust scores (0–1) that synthesis uses to decide what to emphasize.

**Implementation:** `lib/debate/calibrationLogger/trustProjection.ts`, `projectTrust()`.

**Failure mode:** If the termination reason is unrecognized, trust projection fails safe: all metrics get medium confidence (0.5) and a warning is logged. This prevents silent false-trust verdicts.

---

### Stage 5: Synthesizing

**Purpose:** Convert the debate session, trust scores, and grounding context into a structured answer.

**Input:**
- The debate session with QBAF and neutral evaluation
- The grounding envelope (for node citation)
- Trust projection scores
- The original question

**Process:**

1. Extract debate highlights: the most salient turns from the transcript (decided by QBAF score and neutral evaluation).

2. Summarize the argument network: which arguments support which claims, which camps agree, which diverge.

3. Determine the synthesis model: `derivation.models['evaluator'] ?? derivation.models['debaters']` (`lib/debate/inquirySynthesis.ts:240`). The model comes from the debate config, not a separate selection.

4. Send the context to the synthesis LLM via a single evaluator call with a structured prompt (see `lib/debate/prompts/inquiry.ts`, `inquirySynthesisPrompt()`).

5. The LLM returns a JSON object with:
   ```json
   {
     "campVerdicts": [{"camp": "acc", "verdict": "...", "nodeIds": ["acc-beliefs-001"]}],
     "convergences": [{"claim": "...", "nodeIds": [...]}],
     "evidenceLayers": [{"title": "...", "role": "...", "solves": "..."}],
     "unresolvedGaps": [{"description": "...", "confidence": "high"}],
     "singleRunCaveat": "This result is based on a single debate run...",
     "synthesizedHeadline": "..."
   }
   ```

6. Parse and validate the output:
   - Resolve node IDs to grounding-snapshot NodeRefs. **IDs not in the snapshot are dropped with a warn** — the LLM may hallucinate IDs that were never in the prompt context (`lib/debate/inquirySynthesis.ts:187`).
   - All figures (numbers, dates, magnitudes) must be drawn from the question or debate highlights (FIGURES RULE in the prompt).
   - If a camp has `lowCoverage: true` from the grounding stage, prepend "The taxonomy has little that speaks directly to this question; " to that camp's verdict.

7. Wrap the result in an `InquiryResult` object, including the termination reason, trust scores, and usage metrics.

**Output:** An `InquiryResult` (defined in `lib/inquiry/schema.ts`) ready for storage and rendering.

**Implementation:** `lib/debate/inquirySynthesis.ts`, `synthesizeInquiry()`. Prompts defined in `lib/debate/prompts/inquiry.ts`.

**Failure modes:**
- **Malformed JSON:** The LLM returns invalid JSON. `synthesizeInquiry()` throws an `ActionableError` with instructions to retry and check flight-recorder logs (`lib/debate/inquirySynthesis.ts:274`).
- **Hallucinated node citations:** Resolved node IDs are dropped with a warn. The result still emits with those IDs absent from the output (`lib/debate/inquirySynthesis.ts:187`).
- **Single-run caveat missing:** If the LLM doesn't include the caveat, `synthesizeInquiry()` injects it using the standard text from `inquiry.ts`.

---

## Models and Prompts

### Query Embedding

- **Model:** all-MiniLM-L6-v2 (384-dim, already embedded in the taxonomy).
- **Where:** `lib/embeddings/computeEmbedding.ts`
- **Use:** Similarity search over `embeddings.json` to find relevant taxonomy nodes.

### Debate Engine

- **Models:** Configured per `DebateConfig`, typically Gemini and Claude (see `lib/ai-client/index.ts` for provider registry).
- **Where:** `lib/debate/debateEngine.ts`
- **Temperature:** 1.0 (higher creativity to explore disagreement); can be lowered for fidelity < 0.5.

### Synthesis Model

- **Model selection:** The synthesis model is drawn from the derived debate config: `derivation.models['evaluator'] ?? derivation.models['debaters']` (`lib/debate/inquirySynthesis.ts:240`). It is NOT independently selected (TL t/3580#3 note 1).
- **Prompt:** `lib/debate/prompts/inquiry.ts`, `inquirySynthesisPrompt()`.
- **Invocation:** Single evaluator call; does not use debate-turn prompts.
- **Key rules in the prompt:**
  - Return ONLY valid JSON.
  - FIGURES RULE: No new numbers or magnitudes; only cite figures from the question or debate.
  - Node IDs must exist in the grounding envelope.
  - If a camp has low taxonomy coverage, flag it in the verdict.

---

## How Results Are Kept and Linked

### Electron Desktop (t/3579)

- Job store: In-memory `Map` in `taxonomy-editor/src/main/inquiryJobStore.ts`.
- Persistence: Results are written to `userData/inquiries/<jobId>.json` on the local filesystem.
- Linking: The inquiry is accessible via `electron://inquiry/<jobId>` within the taxonomy-editor.
- TTL: 7 days (configurable); jobs older than TTL are cleaned up on app start.

### Web Server (t/3578)

- Job store: PostgreSQL via `server/inquiryJobs.ts` (mirrors Electron's `briefs` table pattern).
- Persistence: Results are stored in the `inquiry_results` table with per-user foreign key.
- Linking: Results are accessible via `GET /api/inquiries/<jobId>` and rendered in the web UI.
- TTL: 30 days (enforced by database retention policy); jobs older than TTL are archived.

### Result Contract

Both hosts return the same `InquiryResult` type (defined in `lib/inquiry/schema.ts`). The result includes:

- `id`: Job ID (UUID).
- `question`: The original question.
- `groundingEnvelope`: The nodes used to bound the debate (for traceability).
- `synthesisResult`: The structured answer (campVerdicts, convergences, etc.).
- `metrics`: Raw metrics (turn count, convergence score, etc.).
- `trustProjection`: Per-metric confidence scores.
- `terminationReason`: Why the debate ended.
- `createdAt`: Timestamp.

---

## Failure Modes and Recovery

| Failure | Signal | Recovery |
|---------|--------|----------|
| Embedding search returns no results | `groundingEnvelope.nodesByCamp` is empty | Synthesis flags all camps as low-coverage; result is sparse but valid. |
| Debate budget exhausted | `terminationReason: 'api_ceiling'` | Continue to synthesis; trust projection marks convergence/completeness metrics as low-confidence. |
| API rate limit | `terminationReason: 'api_ceiling'` | Same as budget exhaustion. |
| Debate convergence timeout | `terminationReason: 'max_turns'` | Continue to synthesis; convergence metric gets low trust. |
| Synthesis LLM returns invalid JSON | `ActionableError` at `lib/debate/inquirySynthesis.ts:274` | Throw error with user-actionable steps: check flight-recorder logs, retry the inquiry, inspect prompt template if consistently fails. No automatic re-prompt or SRE alert. |
| Synthesis hallucinates node IDs | **Dropped with warn** at `lib/debate/inquirySynthesis.ts:187` | IDs not in grounding snapshot are removed from the output. Result emits with those citations absent. |
| Synthesis misses single-run caveat | (not a failure) | If the LLM doesn't include the caveat, `synthesizeInquiry()` injects it using the standard text from `inquiry.ts`. |

---

## Monitoring and Observability

### Flight Recorder Events

The inquiry pipeline emits structured events via the Flight Recorder (`lib/flight-recorder/index.ts`):

- `inquiry.stage_begin`: When each stage starts (deriving, grounding, debating, projecting, synthesizing).
- `inquiry.stage_end`: When each stage completes (includes duration, stage-specific metrics).
- `inquiry.validation_error`: When synthesis validation fails (includes error details).

### Logs

Each stage logs warnings via `getGlobalRecorder().warn()`:

- If grounding returns low-coverage nodes, log a WARN.
- If termination reason is not `converged`, log a WARN.
- If trust projection receives an unrecognized termination reason, log a WARN.
- If synthesis drops hallucinated node IDs, log a WARN.

### Metrics

Key metrics exported to observability:

- **Stage duration** (per stage): How long deriving, grounding, debating, projecting, synthesizing take.
- **Debate session size**: Turn count, transcript token count, QBAF edge count.
- **Grounding coverage**: Nodes per camp in the envelope.
- **Termination distribution**: % of runs that converge vs. api_ceiling vs. max_turns.
- **Synthesis fidelity**: % of result node IDs that were successfully resolved from grounding.

---

## Related Documentation

- `docs/hld-inquiry-ux.md` — High-level design and constraints
- `docs/adr/ADR-0002-inquiry-result-contract.md` — Result contract and trust projection rules
- `lib/debate/inquiryPipeline.ts` — Orchestrator source
- `lib/debate/inquiryGrounding.ts` — Grounding stage
- `lib/debate/inquiryConfig.ts` — Config derivation
- `lib/debate/inquirySynthesis.ts` — Synthesis stage
- `lib/debate/prompts/inquiry.ts` — Prompt templates
- `lib/debate/calibrationLogger/trustProjection.ts` — Trust projection logic
