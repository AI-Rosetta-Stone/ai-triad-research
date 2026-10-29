# t/4621: 8-situation genus-template corrections (frozen list)

**Anchor:** t/4621 (follow-up from t/4620's corpus scan). **Tier:** T2, a corpus write to `ai-triad-data` (`taxonomy/Origin/situations.json`). **Status:** prepared, NOT applied. Nothing written.

## Background

t/4620's full-corpus scan (t/4621#1) found 8 more situations beyond `sit-493` carrying the same defect: a description using the POV-node genus (`"A Belief within <camp(s)> discourse that..."`) instead of the situation genus. All 8 carry `interpretations` for all three camps (accelerationist/safetyist/skeptic), so each one's camp-restriction is also wrong, same as `sit-493`.

## What changes

Eight targeted single-line description replacements in `situations.json`, same validation discipline as t/4620: each `old` text occurs exactly once; a full structural re-parse proves every other node and every non-`description` field on the eight touched nodes is byte-for-byte unchanged.

| Node | Old genus | 
|---|---|
| `sit-283` | `A Belief within skeptic discourse that...` |
| `sit-292` | `A Belief within accelerationist and safetyist discourse that...` |
| `sit-326` | `A Belief within safetyist and skeptic discourse that...` |
| `sit-362` | `A Belief within safetyist and skeptic discourse that...` |
| `sit-370` | `A Belief within safetyist and skeptic discourse that...` |
| `sit-377` | `A Belief within accelerationist and safetyist discourse that...` |
| `sit-397` | `A Belief within safetyist discourse that...` |
| `sit-428` | `A Belief within safetyist and skeptic discourse that...` |

All eight become `A situation concept that [same differentia]...`, Encompasses/Excludes preserved verbatim.

**Unlike `sit-493`, no rewording of the differentia was needed on any of these 8.** `sit-493`'s differentia was itself phrased as a normative claim ("...rights must be balanced against...") that needed restructuring into a neutral description (per SO e/395#2's review). All 8 of these nodes' differentia clauses already read as plain descriptive `"that X is/does Y"` statements — compatible with the situation genus as-is. The fix here is a pure genus-prefix swap plus removing the camp list; the rest of each sentence is untouched, which is lower-risk than `sit-493`'s rewrite (no judgment call on preserving substance while changing phrasing).

## Mechanism checks (data-mutation playbook A/B)

- **A:** same root cause as `sit-493` (t/4620) — a stray POV-node genus template applied to situation nodes, likely from the same generation batch or a shared authoring script bug. Confirms the SO's suspicion (e/395#2) that this was a pattern, not an isolated case.
- **B:** no live producer regenerates situation `description` for existing nodes (same finding as t/4620's README).
- **Scope check:** the regex scan (`^A (Belief|Desire|Intention) within \w+`) covered the full 459-node corpus; these 8 plus `sit-493` (already fixed) are the complete set matching that pattern. A node using the genus correctly but still restricting to fewer camps than it has interpretations for would NOT be caught by this regex — that's a different, narrower defect class not scanned for here.

## Files

- `frozen_description_fixes.json`: 8 targets' old/new text, `pre_sha256`/`post_sha256`, evidence per replacement.
- `apply_description_fixes.py`: identical script to t/4620's (LF-normalised hash gate, per SO condition C2).
- `dry_run_output.txt`: dry run against a clean scratch copy, post-t/4620 state. 8/8 pass, all 459 nodes confirmed unchanged elsewhere, nothing written.

## Next

Same sequence as t/4620: SO round (can likely ride on t/4620's precedent, given it's the same defect class, same mechanism, same script, and the SO already reviewed and cleared that exact pattern — TL's call on how light a review this needs), approval, second-agent pre-hash recount at apply time (confirm `ai-triad-data` HEAD is still the post-t/4620 commit, re-freeze if not), apply, post-write check, and a C4-equivalent targeted re-embed of all 8 nodes (same method as t/4620's C4).

**C4 re-embed will touch 8 nodes this time**, not 2 — same verification discipline (round-trip check before writing, full byte-identity check on every other node afterward, float-drift spot check on a sample of unchanged nodes).
