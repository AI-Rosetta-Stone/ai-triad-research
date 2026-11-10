# Ask a Question: Theory of Operations

## Overview

This document describes how the Ask a Question inquiry feature works end-to-end: the five pipeline stages, the models and prompts involved, how results are persisted and linked, and the failure modes the system handles.

## The Five-Stage Pipeline

Ask a Question orchestrates a single `runInquiryPipeline` across two hosts—Electron desktop and web server. The two hosts share the same stage sequence so logic never drifts between them; each host handles its own job lifecycle, storage, and TTL.

The pipeline is implemented in `lib/debate/inquiryPipeline.ts`.

### Stage 1: Derive (Grounding)

**Purpose:** Convert the user's question into a bounded debate by selecting relevant taxonomy nodes.

**Input:** User's natural-language question; the taxonomy (`taxonomy/Origin/nodes.json`).

**Process:**

1. Compute a query embedding using the shared embedding model (`ai.computeQueryEmbedding`).
2. Search the taxonomy's embedding index (`taxonomy/Origin/embeddings.json`, model: all-MiniLM-L6-v2, 384-dim) for the k most similar nodes, per camp.
3. Build a *grounding envelope*: an anchor situation (the root node defining the question's scope) plus per-camp node sets (beliefs, goals, methods relevant to the question).

**Output:** A `GroundingEnvelope` containing:
- `anchorSituation`: the situation node framing the question
- `nodesByCamp`: Map of camp → list of `{ nodeId, label }` pairs
- `campCoverage`: Which camps have low taxonomy coverage for this question (flagged for synthesis pass)

**Implementation:** `lib/debate/inquiryGrounding.ts`, `buildGroundingEnvelope()`

**Failure mode:** If the embedding search returns no results or very weak results, the grounding envelope is sparse. The synthesis pass detects this via `campCoverage.lowCoverage` and flags the camp in the output with "The taxonomy has little that speaks directly to this question."

---

### Stage 2: Debate

**Purpose:** Run the full debate engine on the question, bounded by the grounding envelope.

**Input:** The `GroundingEnvelope` from Stage 1; the user's question.

**Process:**

1. Derive a `DebateConfig` from the grounding envelope (see `lib/debate/inquiryConfig.ts`).
   - Map each grounded node to a debate agent.
   - Set agent turn order, debate depth, and convergence thresholds.
   - Set fidelity level (0.5–1.0) to control debate scope and cost. Higher fidelity = more turns, higher cost.

2. Run `debateEngine.runHeadlessDebate()` with the derived config and question.

3. The debate engine runs up to N turns per agent, emitting:
   - Turns in the transcript
   - Intermediate QBAF updates
   - Termination reason (converged, budget exhausted, rate limit, other)

**Output:** A `DebateSession` containing the full transcript, final belief states, and termination metadata.

**Implementation:** `lib/debate/inquiryConfig.ts` (config derivation); `lib/debate/debateEngine.ts` (debate run).

**Failure modes:**
- **Budget exhaustion:** The debate runs out of API budget and terminates early. The system continues to synthesis but marks metrics as low-confidence.
- **Rate limiting:** An external API (Gemini, OpenAI, etc.) rate-limits the service. Termination is captured as `api_ceiling`.
- **Convergence timeout:** The debate does not converge within the configured turn limit. The system continues to synthesis; metrics reflect incomplete convergence.

All termination reasons are tracked in `TerminationReason` (closed union in `lib/debate/calibrationLogger/extract.ts`).

---

### Stage 3: Judge (QBAF + Neutral Evaluation)

**Purpose:** Evaluate argument quality across the debate and compute neutral scores.

**Input:** The `DebateSession` from Stage 2.

**Process:**

This stage runs existing infrastructure:

1. Extract argument relations from the transcript using the QBAF (Quantified Bipolar Argumentation Framework) logic in `lib/debate/qbaf.ts`.
2. Compute neutral evaluation metrics using `lib/debate/neutralEvaluator.ts` (factual quality, logical consistency, diversity of sources).
3. These scores feed into the synthesis prompt to weight which arguments the LLM emphasizes.

**Output:** Enriched `DebateSession` with QBAF edges and neutral metrics attached to each argument.

**Implementation:** Existing; not modified for inquiry. Reuses `neutralEvaluator.ts` and `qbaf.ts`.

---

### Stage 4: Project Trust

**Purpose:** Map the debate's termination reason to per-metric confidence scores.

**Input:** The enriched `DebateSession` and its `terminationReason` from Stage 3.

**Process:**

1. Extract raw metrics from the debate: convergence scores, turn count, argument density, etc. (see `getRawMetrics()` in `lib/debate/calibrationLogger/trustProjection.ts`).

2. Apply the trust projection matrix (per ADR-0002):
   - If termination was `converged`, all metrics get high confidence.
   - If termination was `api_ceiling` (budget exhausted), metrics depending on complete information (e.g., convergence score) get low confidence.
   - If termination was `rate_limited`, similar penalty applies.

3. Return a `TrustProjection` object mapping metric name → confidence score.

**Output:** Per-metric trust scores (0–1) that synthesis uses to decide what to emphasize.

**Implementation:** `lib/debate/calibrationLogger/trustProjection.ts`, `projectTrust()`.

**Failure mode:** If the termination reason is unrecognized, trust projection fails safe: all metrics get medium confidence (0.5) and a warning is logged. This prevents silent false-trust verdicts.

---

### Stage 5: Synthesize

**Purpose:** Convert the debate session, metrics, and grounding context into a structured answer.

**Input:**
- The debate session with QBAF and neutral evaluation
- The grounding envelope (for node citation)
- Trust projection scores
- The original question

**Process:**

1. Extract debate highlights: the most salient turns from the transcript (decided by QBAF score and neutral evaluation).

2. Summarize the argument network: which arguments support which claims, which camps agree, which diverge.

3. Send this context to the synthesis LLM with a structured prompt (see `lib/debate/prompts/inquiry.ts`, `inquirySynthesisPrompt()`).

4. The LLM returns a JSON object with:
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

5. Validate the output:
   - All node IDs must exist in the grounding envelope (no hallucinated citations).
   - All figures (numbers, dates, magnitudes) must be drawn from the question or debate highlights (FIGURES RULE in the prompt).
   - If a camp has `lowCoverage: true` from the grounding stage, prepend "The taxonomy has little that speaks directly to this question; " to that camp's verdict.

6. Wrap the result in an `InquiryResult` object, including the termination reason, trust scores, and usage metrics.

**Output:** An `InquiryResult` (defined in `lib/inquiry/schema.ts`) ready for storage and rendering.

**Implementation:** `lib/debate/inquirySynthesis.ts`, `synthesizeInquiry()`. Prompts defined in `lib/debate/prompts/inquiry.ts`.

**Failure modes:**
- **Hallucinated citations:** The LLM cites a node ID that doesn't exist. Synthesis validation catches this and returns an error.
- **Missing output fields:** The LLM omits a required field. Validation catches this and re-prompts or returns a structured error.
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

### Synthesis LLM

- **Model:** Typically Claude (high reasoning quality for structured output). Configurable in `inquiryPipeline.ts`.
- **Prompt:** `lib/debate/prompts/inquiry.ts`, `inquirySynthesisPrompt()`.
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
| Synthesis LLM returns invalid JSON | Parse error in stage 5 | Return structured error with the raw response; do not fail the job. Log the error; alert SRE. |
| Synthesis hallucinates citations | Validation fails in stage 5 | Return structured error naming the bad node IDs. Do not emit the result. |
| Synthesis omits required field | Validation fails in stage 5 | Re-prompt the LLM with the same context and a "retry with missing fields" instruction. If retry fails, return structured error. |
| Synthesis misses single-run caveat | Validation succeeds but caveat is missing | Inject the standard caveat text from `inquiry.ts`. |

---

## Monitoring and Observability

### Flight Recorder Events

The inquiry pipeline emits structured events via the Flight Recorder (`lib/flight-recorder/index.ts`):

- `inquiry.stage_begin`: When each stage starts (grounding, debating, projecting, synthesizing).
- `inquiry.stage_end`: When each stage completes (includes duration, stage-specific metrics).
- `inquiry.validation_error`: When synthesis validation fails (includes error details).
- `inquiry.synthesis_retry`: When synthesis is re-prompted (includes attempt count).

### Logs

Each stage logs warnings via `getGlobalRecorder().warn()`:

- If grounding returns low-coverage nodes, log a WARN.
- If termination reason is not `converged`, log a WARN.
- If trust projection receives an unrecognized termination reason, log a WARN.
- If synthesis validation fails or is retried, log a WARN.

### Metrics

Key metrics exported to observability:

- **Stage duration** (per stage): How long grounding, debate, synthesis take.
- **Debate session size**: Turn count, transcript token count, QBAF edge count.
- **Grounding coverage**: Nodes per camp in the envelope.
- **Termination distribution**: % of runs that converge vs. budget-exhausted vs. rate-limited.
- **Synthesis validation rate**: % of synthesis outputs that pass validation on first attempt.

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
