# t/4614: WEO group `date_published` correction (frozen list)

**Anchor:** t/4614 (SO follow-up from t/4604, e/393#2). **Tier:** T2, a corpus write to `ai-triad-sources`. **Status:** prepared, NOT applied. Nothing written to either data repo.

## Background

t/4604's review flagged `world-economic-outlook-update-global-economy-steady-amid-2026-2`'s `date_published` (`2026-01-01`) as a likely placeholder against the verified release date (IMF page fetched 2026-10-27 for t/4495: "released January 19, 2026"). This ticket also asked me to check whether the two `duplicate_of` members share the issue.

**Finding: they don't share the same placeholder — they're missing the field entirely.** `text-2026` and `text-2026-1` both have `date_published: null` (the key exists, was never set). That's a different defect class than the canonical's wrong-but-present placeholder, but the same fix applies: all three should carry the same verified date.

## Scope decision, flagged for review rather than assumed

Filling a `null` field is a different action than correcting a wrong value, and t/4604's ticket description named only "the canonical and any member **sharing the placeholder**" — strictly, none of the members share it. I'm including all three in one frozen list anyway, since:
- the underlying evidence and correct value are identical across all three (same report, same IMF fetch);
- `date_published` already exists as a key on every target, so this is still a values-only change (no key added), consistent with the project's values-only convention for this fix class;
- leaving the members at `null` while the canonical gets `2026-01-19` would be a new, visible inconsistency within the same `duplicate_of` group.

**This is my judgment call, not something I'm asserting as decided** — the SO/TL should weigh in on whether filling a null counts as "the same fix" or needs separating.

## What changes

Three targets, one field each, in `frozen_metadata_fixes.json`. Base: `ai-triad-sources` main at the post-t/4604 state (pre-hashes read from the committed blob, matching t/4495's `post_sha256` for `text-2026`/`text-2026-1` and t/4604's `post_sha256` for the canonical — confirms I'm reading the correct current state).

| Target | Old `date_published` | New |
|---|---|---|
| `text-2026` | `null` | `2026-01-19` |
| `text-2026-1` | `null` | `2026-01-19` |
| `world-economic-outlook-update-global-economy-steady-amid-2026-2` (canonical) | `2026-01-01` | `2026-01-19` |

**Evidence: reused, not re-fetched** — the same IMF publisher-page fetch from t/4495/t/4604.

## Mechanism checks (data-mutation playbook A/B)

- **A:** same cause family as t/4495/t/4604 — unverified metadata at ingest (here, a never-populated field or an unverified placeholder), not a live bug.
- **B:** `date_published` is not re-derived by any live producer for an existing document (same finding as t/4495's and t/4604's README — only the unreferenced archived `populate_provenance.py` touches provenance-adjacent fields, and it doesn't write `date_published`).
- **Identity:** `date_published` is not part of any identity key (`Get-TrustedSourceUrlKey` is URL-only); this change has no grouping effect, unlike t/4604's url fix. No grouping check needed at apply time.

## Files

- `frozen_metadata_fixes.json`: the 3 targets, old/new, evidence, `pre_sha256`/`post_sha256`.
- `apply_metadata_fixes.py`: identical script to t/4495/t/4604's (same hash-enforced, structurally-verified applier).
- `dry_run_output.txt`: dry run against a clean scratch copy. 3/3 pass, nothing written.

## Next

Same sequence as t/4495/t/4604, scoped to the delta: SO review (flagging the null-vs-placeholder scope decision above explicitly), TL approval, second-agent pre-hash recount at apply time, apply with `--approved-sha256`, post-write check. No grouping check needed (not an identity field), so C3 here is just the diff/post-hash check.
