# t/284 Remaining Work — Prompt Enforcement & Relevance Metrics

This document tracks the remaining work to complete t/284 (Inquiry Anchor to Question).

**Status**: Core infrastructure (topic validation, ArCo activation, critique_suggestion) ✅ complete and tested. Three remaining features block acceptance testing.

---

## 1. Prompt Enforcement — First Sentence Answers the Question

**Goal**: Debaters must open by directly answering the user's question in the first sentence.

**Pattern**: 
- Inquiry opening: `"The answer to '[user question]' is that [debater's position]. [evidence and reasoning]"`
- Normal debate: unchanged (no requirement)

**Location to Update**:
- `lib/debate/prompts/opening.ts:210–220` (briefOpeningStagePrompt output constraint)
- `lib/debate/prompts/turn.ts` (turn draft prompt, if it exists)

**Implementation**:
1. Add optional `anchorToResolution` flag to `OpeningStagePromptInput`
2. Add constraint block: "For inquiry debates (anchorToResolution=true), the opening statement's first sentence MUST directly answer the user's question using this format: 'The answer to [question] is…'"
3. Same constraint in turn draft prompts

**Testing**: Verify debaters follow the pattern in the 6-debate acceptance run.

---

## 2. Alignment Gate — Named Entity Extraction & Validation

**Goal**: Each turn should reference key concepts from the user's question; catch topic drift early.

**Pattern**:
- Extract named entities (NE) from `request.question`
- In `turnValidation()`, check that the turn text mentions at least N/3 of the extracted entities
- If alignment score < threshold, emit WARN (non-blocking)

**Location to Update**:
- `lib/debate/turn-pipeline.ts:773` (turnValidation function)
- `lib/debate/types/turn.ts` (add optional `entities_mentioned` field to Turn, if tracking)
- `lib/debate/convergenceSignals.ts` (add NE alignment score to signals)

**Decision Needed**: NE extraction method
- Option A: Use a NER library (spaCy Python binding, or JS library like compromise.js)
- Option B: LLM-based extraction via prompt (which model? evaluator or query adapter?)

**Implementation (pending decision)**:
1. Create `extractQuestionEntities(question: string): string[]` function
2. Call in turn validation: `turnEntities = extractQuestionEntities(request.question)`
3. Measure `alignmentScore = entitiesInTurn(turn.text) / (turnEntities.length / 3)`
4. Emit WARN if `alignmentScore < 0.5` (calibrate on acceptance run)
5. Store on session for relevance metric correlation

---

## 3. Relevance Metric — Per-Turn Embedding Similarity

**Goal**: Quantify how much each turn answers the user's question (drift detection).

**Pattern**:
- Compute embedding for `request.question`
- After each turn, compute embedding similarity to question embedding
- Store per-turn score on session
- In projecting stage, check for drift: if mean < 0.35 or 3 consecutive < 0.25, emit WARN

**Location to Update**:
- `lib/debate/convergenceSignals.ts` (add arco.per_turn_similarity field)
- `lib/debate/turn-pipeline.ts` (compute similarity after turn validation)
- `lib/debate/projecting.ts` (read signal, check threshold, emit WARN)

**Decision Needed**: Embedding model
- Option A: Use evaluator model (same as debate quality evaluation)
- Option B: Use query embedding adapter from `lib/debate/aiAdapter.ts:75` (computeQueryEmbedding)
- Option C: Use all-MiniLM-L6-v2 (same as taxonomy embeddings in ai-triad-data)

**Implementation (pending decision)**:
1. Store `question_embedding` on session after topic arrives
2. After each turn execution, compute `turn.embedding` via chosen model
3. Compute `cosine_similarity(turn.embedding, question_embedding)`
4. Store in `session.convergenceSignals.arco.per_turn_similarity: number[]`
5. In projecting, check: if `mean(per_turn_similarity) < 0.35 || consecutive_below_0.25 >= 3`, emit WARN
6. Calibrate threshold on 6-debate run (start with TL's suggestion, adjust if needed)

---

## 4. Debate Test — Verify ArCo Runs for Inquiry

**Location**: `lib/debate/inquiryPipeline.t284.test.ts` (expand existing)

**Pattern**:
```typescript
it('ArCo runs and decorates session for inquiry debates', async () => {
  const session = await runDebate(inquiryConfig, adapter, taxonomy);
  expect(session.topic.clauses).toBeDefined();  // ArCo output
  expect(session.topic.clause_embeddings).toBeDefined();
  expect(Array.isArray(session.topic.clauses)).toBe(true);
  expect(session.topic.clauses.length).toBeGreaterThan(0);
});
```

**Acceptance Criteria**:
- ArCo runs and populates `topic.clauses[]` for inquiry
- Normal debate with `anchorToResolution: false` does NOT add ArCo cost

---

## 5. Regression Test — Normal Debate Unchanged

**Location**: Same test file or existing debate test suite

**Pattern**:
```typescript
it('normal debate without anchorToResolution is unchanged', async () => {
  const normalConfig = { ...inquiryConfig, anchorToResolution: false };
  const session = await runDebate(normalConfig, adapter, taxonomy);
  // Verify no ArCo output, no extra phases added
  expect(session.topic.clauses).toBeUndefined();
  expect(session.transcript.length).toBeGreaterThan(0);
});
```

---

## 6. 6-Debate Acceptance Run

**Input Data**: Choose 6 existing inquiry debates from `ai-triad-data/debates/` (grep for `origin.mode='inquiry'`)

**Before/After Capture**:
- For each debate: run with current t/284 implementation
- Verify: topic.final === request.question (no drift)
- Verify: ArCo signals present (topic.clauses, clause_embeddings, per_turn_similarity)
- Verify: alignment gate produces expected NE coverage and WARN signals
- Verify: prompt enforcement — opening sentences directly answer question
- Capture: raw before/after logs, signal values, any errors or warnings

**Output**: Post results on t/284 comment with:
- Summary: "All 6 runs completed successfully, anchor held, ArCo signals present, prompt enforcement working"
- Evidence: 3-5 key metrics per run (similarity scores, entity alignment, opening statement excerpt)

---

## Timeline & Order

1. **Immediate** (this turn): Add prompt enforcement (needs decision on NE extraction)
2. **Immediate**: Add relevance metric (needs decision on embedding model)
3. **Next**: Run 6-debate acceptance tests, capture results
4. **Next**: Route #4958 to Quality-TechLead for review

---

## Known Complexity Issues

- `topicPipeline.ts` `runTopicCritique()` complexity: 53/52 (exceeded by 1 point)
  - Caused by restructuring reframe logic into two paths (inquiry vs normal)
  - Non-blocking for T1 review; note in PR body that this is expected
  - Refactor opportunity: extract reframe logic into separate method (future epic)

---

## Open Questions

1. **Named entity extraction**: NER library vs LLM? (TL guidance needed)
2. **Relevance embedding model**: evaluator vs query adapter vs all-MiniLM-L6-v2? (TL guidance needed)
3. **Relevance threshold calibration**: Use TL's suggested mean < 0.35 or run calibration first? (TL decision)
4. **Named entity coverage**: Should N be "all entities" or "at least N/3" or something else? (TL decision)
5. **Which 6 debates for acceptance**: Have we identified them, or should TL specify? (TL input)
