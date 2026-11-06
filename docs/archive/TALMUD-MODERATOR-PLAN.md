# Talmudic Moderator Mode — Implementation Plan

## Status

Implementation started on branch `feature/talmud-moderator-mode`.

## Scope of the first release

Add Talmudic dialectic as an optional **moderator strategy**, not as a fourth debate agent.

- Existing debaters remain Accelerationist, Safetyist, and Skeptic.
- Default moderation remains unchanged with `moderatorMode: "standard"`.
- `moderatorMode: "talmudic"` changes moderator guidance only.
- No Talmud corpus, quotation retrieval, new Talmud POV, or Talmud taxonomy is required for this first experiment.
- Existing moderator moves remain in use; no new `TALMUDIC_CITE` move is introduced initially.

## Implemented first slice

- Added `ModeratorMode = "standard" | "talmudic"` to the debate types.
- Added optional `moderatorMode` to `DebateConfig`.
- Persisted `moderator_mode` on new debate sessions.
- Passed the mode through the CLI and moderator orchestration path.
- Added a feature-flagged prompt block that directs the moderator to:
  - Identify exact cruxes.
  - Classify disagreements.
  - Surface premises and category distinctions.
  - Test analogies, edge cases, and counterexamples.
  - Request conditions for changing position.
  - Preserve competing interpretations and unresolved disagreement.
  - Avoid invented authorities, quotations, and textual citations.
- Added prompt regression tests for standard and Talmudic modes.

## Next implementation phases

### Phase 1 — Complete configuration surfaces

- Expose the mode in MCP, PowerShell, and Taxonomy Editor debate configuration where those callers launch debates.
- Ensure legacy sessions default to standard mode.
- Add validation for invalid mode values at configuration boundaries.

### Phase 2 — Dialectical diagnostics (implemented)

Record or display the moderator’s:

- Focused crux
- Disagreement type
- Premise under examination
- Distinction or analogy being tested
- Unresolved outcome

Reuse existing crux, argument-network, commitment, QBAF, and convergence data.

Diagnostics are persisted both on each moderator transcript entry under
`metadata.moderator_trace.dialectical_diagnostic` and in the session-level
`dialectical_diagnostics` review index. Standard mode does not emit the index;
legacy sessions remain valid without it. Unsupported fields are recorded as
`null` rather than inferred or invented.

Review the newest local run with:

```powershell
./scripts/TalmudicDebate/Review-TalmudicDebate.ps1
./scripts/TalmudicDebate/Review-TalmudicDebate.ps1 -AsJson
./scripts/TalmudicDebate/Review-TalmudicDebate.ps1 -Path ./debates/<slug>-debate.json -IncludeRawModeratorResponse
```

The reviewer verifies activation, prompt delivery, diagnostic completeness,
response follow-through, validation outcomes, claim-ID integrity, disagreement
type consistency, analogy diagnostics, and subsequent fact-check results. It
does not claim causal attribution; that requires matched standard/Talmudic runs.

### Phase 3 — Compare behavior

Run matched standard/Talmudic debates and compare:

- Crux engagement
- Repetition
- Responsiveness
- Useful distinctions
- Counterexample quality
- Preservation of unresolved disagreement
- Token/API usage and cost

### Phase 4 — Optional verified corpus

Only if source-specific Talmudic citations are required:

- Curate a small pilot corpus.
- Record tractate, folio, attribution, language, translation, edition, commentary layer, topic tags, and provenance.
- Establish licensing and editorial policy.
- Distinguish quotation, paraphrase, interpretation, and analogy.
- Add retrieval and citation validation as a separate capability.

## Materials needed before corpus work

1. Definition of what Talmudic mode may and may not claim.
2. Ten to twenty example moderator questions.
3. Transcript-review rubric covering fidelity, attribution, anachronism, respect, and usefulness.
4. Representative debate topics for matched experiments.
5. API/token budget for the experiment.
6. If citations are required: curated passages, translations, provenance, licensing, and editorial policy.

## Taxonomy decision

A Talmud taxonomy is **not needed for the first moderator-mode experiment**. Existing POV taxonomy, conflicts, cruxes, organizations, and corroboration data are sufficient. If recurring Talmudic concepts later need indexing, begin with corpus metadata or analytical tags. Create a separate taxonomy only if the research question explicitly requires modeling multiple Talmudic positions with provenance and preserved disagreement.

## Verification

- Focused prompt and orchestration tests pass.
- Run full debate tests after configuration surfaces are complete.
- Run TypeScript checks for the root/dependent app packages.
- Perform human transcript review before enabling the feature broadly.
