# t/4620: sit-493/sit-484 description corrections (frozen list)

**Anchor:** t/4620 (2026-10-29 session-start DOLCE audit). **Tier:** T2, a corpus write to `ai-triad-data` (`taxonomy/Origin/situations.json`). **Status:** prepared, NOT applied. Nothing written.

## What changes

Two targeted single-line description replacements within one 5.5MB taxonomy file, both validated by exact-string-count (each `old` text occurs exactly once) plus a full structural re-parse proving every other node, and every other field on the two touched nodes, is byte-for-byte unchanged.

| Node | Defect | Fix |
|---|---|---|
| `sit-493` | Description used the POV-node genus (`"A Belief within safetyist and skeptic discourse that..."`) instead of the situation genus, and arbitrarily named only 2 of the node's camps despite carrying interpretations for all of them | Rephrased to the situation genus (`"A situation concept that describes..."`), POV-neutral. `Encompasses`/`Excludes` content preserved verbatim |
| `sit-484` | Duplicate `Encompasses:` clause (one inline after the differentia, a second on its own line) | Merged into one `Encompasses:` clause, concatenating both lists; no content dropped |

**Evidence:** `docs/ontology-reference.md:11` — situations use the genus `"A situation that [differentia]..."`; checked against the other 9 of the 10 newest situations (all correctly use the corpus's actual convention, `"A situation concept that..."`) to confirm `sit-493` is the outlier, not the genus text being stale.

## Mechanism checks (data-mutation playbook A/B)

- **A, mechanism per entry:** `sit-493`'s description reads as a stray copy from a POV-node generation pass (the exact POV-node genus template, including the "within X discourse" clause) rather than a situation-specific defect; `sit-484`'s duplicate clause reads as an LLM generation artifact (restating Encompasses with near-synonymous items) that a merge step should have caught and didn't.
- **B, re-deriving producer:** situation descriptions aren't regenerated for existing nodes by any live producer I found (situations are authored once and edited by hand/data-mutation, same as POV node descriptions) — confirmed no code path rewrites `description` on an existing situation node.
- **Scope:** did not re-check the remaining ~449 situations for the same genus-template mismatch pattern in this pass — the ticket's AC asks for that as a follow-up scan, separate from this fix.

## Files

- `frozen_description_fixes.json`: the one target file, two line-level replacements, `pre_sha256`/`post_sha256`, full old/new text and evidence per replacement.
- `apply_description_fixes.py`: dry-run by default, reads only the frozen file, refuses on any occurrence-count mismatch, structural drift, or hash mismatch; `--apply` requires `--approved-sha256` (same C1 discipline as t/4495/t/4604/t/4614).
- `dry_run_output.txt`: dry run against a clean scratch copy of `situations.json`. 2/2 replacements pass, all 459 nodes confirmed unchanged elsewhere, nothing written.

## Next

Same sequence as the prior metadata fixes: SO round (T2, corpus write), approval, second-agent pre-hash recount at apply time, apply with `--approved-sha256`, post-write check (exactly one file changed, post-hash matches). The broader-corpus genus-mismatch scan (t/4620's second AC) is separate, no-spend, bounded follow-up work — not done here.
