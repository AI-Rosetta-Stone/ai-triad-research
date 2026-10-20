# Reproduce a fixture before asserting its ground truth

**Rule (CL `AGENTS.md`, review checklist):** before asserting a repro fixture's or acceptance anchor's "correct" answer, or the mechanism that fails, run the pipeline or retrieval that produced the observed behaviour. Label every case `observed` or `constructed`.

**Owner:** CL. **Review-by:** 2027-01-31 (t/4109 #5, incident-rule class). **Origin:** t/2294.

## Why it's an empirical claim

A fixture's `correct_node`, its error class, and which improvement it reproduces are all claims about what the system does. Asserting them without running the system ships a wrong acceptance criterion: the fix gets judged against an answer nobody observed.

## The t/2294 incident

The v1 fixture was written from node and description text alone. It named a single `correct_node` and tagged the case as a rerank repro. Running the actual retrieval showed both claims were wrong:

- **The mechanism was wrong.** The wrong node was never a per-key_point retrieval candidate, so reranking couldn't have touched it. The case wasn't a rerank repro at all.
- **The answer was wrong.** The correct home was a contested node *family*, not one node.

## How to tell retrieval from free selection

Trace the run metadata in `model_info`: `taxonomy_filter`, `taxonomy_nodes`, `extraction_mode`. They show whether an assignment came from retrieval or from LLM free selection. The two have different fixes, so a fixture that confuses them targets the wrong code.

## Labels

- `observed`: the behaviour was seen in a real run, and the fixture records that run.
- `constructed`: the case was built to exercise a path.

A constructed case must never be presented as evidence about what the system does in practice.

## Related

The same discipline applies to paid experiment runs: verify the first output on the dimension you're matching before trusting a config field took effect (t/3802#8, Sage #302).
