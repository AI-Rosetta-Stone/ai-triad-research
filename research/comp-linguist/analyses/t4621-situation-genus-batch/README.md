# t/4621: 8-situation genus-template corrections (frozen list)

**Anchor:** t/4621 (follow-up from t/4620's corpus scan). **Tier:** T2, a corpus write to `ai-triad-data` (`taxonomy/Origin/situations.json`). **Status:** prepared (v2, post-SO-C1), NOT applied. Nothing written.

## Background

t/4620's full-corpus scan (t/4621#1) found 8 more situations beyond `sit-493` carrying the same defect: a description using the POV-node genus (`"A Belief within <camp(s)> discourse that..."`) instead of the situation genus. All 8 carry `interpretations` for all three camps (accelerationist/safetyist/skeptic), so each one's camp-restriction is also wrong, same as `sit-493`.

## v1 → v2: the SO found a real grammatical/propositional defect (e/396#2)

The TL ruled (t/4621#3) this batch needs its own SO round — the mechanism is inherited from t/4620, but the wording has to be reviewed per node. The SO's review of the v1 frozen list (a pure genus-prefix swap on all 8) found it was wrong on 6 of the 8:

- In the old template, `"A Belief ... that X"` introduces a **content clause** (a belief *that X is true*).
- In `"A situation concept that ..."`, `"that"` is a **relative pronoun** needing a verb whose subject is the concept.
- The swap only works when the differentia opens with a verb (`sit-326`: "...that **defines**...", `sit-397`: "...that **quantifies**...") — it breaks into an ungrammatical, still-propositional sentence on the other 6, two of which (`sit-362` "...is superior to...", `sit-428` "...should be trained...") are explicitly normative claims the v1 packet asserted none of these needed.

**v2 fix (SO's rule):** for the 6 propositional nodes, swap the prefix to `"A situation concept concerning whether <differentia verbatim>"` instead of `"A situation concept that ..."`. `sit-326` and `sit-397` keep the `"that"` form (their differentia is a real relative clause). The differentia and Encompasses/Excludes are still byte-for-byte unchanged on all 8 — only the declared prefix differs, never the content.

| Node | Old prefix | New prefix (v2) |
|---|---|---|
| `sit-283` | `A Belief within skeptic discourse that ` | `A situation concept concerning whether ` |
| `sit-292` | `A Belief within accelerationist and safetyist discourse that ` | `A situation concept concerning whether ` |
| `sit-326` | `A Belief within safetyist and skeptic discourse that ` | `A situation concept that ` |
| `sit-362` | `A Belief within safetyist and skeptic discourse that ` | `A situation concept concerning whether ` |
| `sit-370` | `A Belief within safetyist and skeptic discourse that ` | `A situation concept concerning whether ` |
| `sit-377` | `A Belief within accelerationist and safetyist discourse that ` | `A situation concept concerning whether ` |
| `sit-397` | `A Belief within safetyist discourse that ` | `A situation concept that ` |
| `sit-428` | `A Belief within safetyist and skeptic discourse that ` | `A situation concept concerning whether ` |

**Machine-checked, not asserted (SO C1):** each `line_replacement` now carries `old_prefix`/`new_prefix`/`old_desc`/`new_desc`, and `apply_description_fixes.py` asserts `new_desc[len(new_prefix):] == old_desc[len(old_prefix):]` for every target before accepting it — "differentia verbatim" is a script-enforced invariant, not a claim in prose.

## Mechanism checks (data-mutation playbook A/B)

- **A:** same root cause as `sit-493` (t/4620) — a stray POV-node genus template applied to situation nodes, likely from the same generation batch or a shared authoring script bug. Confirms the SO's suspicion (e/395#2) that this was a pattern, not an isolated case.
- **B:** no live producer regenerates situation `description` for existing nodes (same finding as t/4620's README).
- **Scope check:** the regex scan (`^A (Belief|Desire|Intention) within \w+`) covered the full 459-node corpus; these 8 plus `sit-493` (already fixed) are the complete set matching that pattern. A node using the genus correctly but still restricting to fewer camps than it has interpretations for would NOT be caught by this regex — that's a different, narrower defect class not scanned for here.

## Files

- `frozen_description_fixes.json`: 8 targets' old/new text (+ `old_prefix`/`new_prefix`/`old_desc`/`new_desc` for the mechanical check), `pre_sha256`/`post_sha256`, evidence per replacement.
- `apply_description_fixes.py`: t/4620's script plus the SO-C1 mechanical verbatim-differentia check.
- `dry_run_output.txt`: dry run (v2) against a clean scratch copy of `origin/main`'s `situations.json` (post-t/4620 state, confirmed `7d62b6a7…`). 8/8 pass, all 459 nodes confirmed unchanged elsewhere, nothing written.

## Next

Per TL ruling (t/4621#3) and SO conditions (e/396#2): send the v2 side-by-side + hashes back to the SO (C1 compliance), then — once cleared — TL approval, second-agent pre-hash recount at apply time, apply, post-write check (C3), and a C4 targeted re-embed of all 8 nodes (same method as t/4620's C4), recorded on t/4621.
