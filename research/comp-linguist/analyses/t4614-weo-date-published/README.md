# t/4614: WEO group `date_published`/`source_time` correction (frozen list)

**Anchor:** t/4614 (SO follow-up from t/4604, e/393#2). **Tier:** T2, a corpus write to `ai-triad-sources`. **Status:** prepared, NOT applied. Nothing written to either data repo.

**Re-frozen per SO condition C1 (e/394#2) — superseding the first version.** The first draft covered 3 of the group's 5 docs and 1 of its 2 date fields; the SO caught both gaps before any apply happened.

## Background

t/4604's review flagged `world-economic-outlook-update-global-economy-steady-amid-2026-2`'s `date_published` (`2026-01-01`) as a likely placeholder against the verified release date (IMF page fetched 2026-10-27 for t/4495: "released January 19, 2026"). This ticket also asked me to check whether the two `text-*` `duplicate_of` members share the issue.

**First finding: they don't share the same placeholder — they're missing the field entirely.** `text-2026`/`text-2026-1` have `date_published: null`. A different defect class than the canonical's wrong-but-present placeholder, but the same fix applies.

**SO found two more gaps (e/394#2), both now folded in:**
- **G1 — two more group members, missed.** `world-economic-outlook-update-global-economy-steady-amid-2026` and `-2026-1` are also `duplicate_of` the canonical (4 members, not 2) and also carry the `2026-01-01` placeholder. Applying only the original 3 would have left the group reading `19, 19, 19, 01-01, 01-01` — a worse inconsistency than the one being fixed.
- **G2 — `source_time` left behind.** The canonical and the two newly-found members have `source_time: 2026-01-01`; the `text-*` members have `source_time: null`. `source_time` equals `date_published` everywhere in this group, and `taxonomy-editor` reads `source_time` (`fileIO.ts:841`). Fixing `date_published` alone would leave the canonical internally inconsistent (`01-19` against `01-01`).

**On the null-fill-vs-correction scope question I raised:** the SO ruled one list is fine — same keys, same evidence, same values-only class, same precedent as California's `source_time`/`authors` in t/4495 (e/391#2).

## What changes

**Five targets, two fields each** (`date_published`, `source_time`), in `frozen_metadata_fixes.json`. Base: `ai-triad-sources` main `3cf6732` (post t/4604). Pre-hashes read from the committed blob.

| Target | Old `date_published` / `source_time` | New |
|---|---|---|
| `text-2026` | `null` / `null` | `2026-01-19` / `2026-01-19` |
| `text-2026-1` | `null` / `null` | `2026-01-19` / `2026-01-19` |
| `world-economic-outlook-update-…-2026` | `2026-01-01` / `2026-01-01` | `2026-01-19` / `2026-01-19` |
| `world-economic-outlook-update-…-2026-1` | `2026-01-01` / `2026-01-01` | `2026-01-19` / `2026-01-19` |
| `world-economic-outlook-update-…-2026-2` (canonical) | `2026-01-01` / `2026-01-01` | `2026-01-19` / `2026-01-19` |

**Evidence: reused, not re-fetched** — the same IMF publisher-page fetch from t/4495/t/4604.

## Mechanism checks (data-mutation playbook A/B)

- **A:** same cause family as t/4495/t/4604 — unverified metadata at ingest, not a live bug.
- **B:** neither `date_published` nor `source_time` is re-derived by any live producer for an existing document (same finding as t/4495's/t/4604's READMEs).
- **Identity:** neither field is part of any identity key (`Get-TrustedSourceUrlKey` is URL-only). No grouping effect, no grouping check needed at apply time.

## Files

- `frozen_metadata_fixes.json`: the 5 targets, old/new, evidence, `pre_sha256`/`post_sha256`.
- `apply_metadata_fixes.py`: identical script to t/4495/t/4604's (same hash-enforced, structurally-verified applier).
- `dry_run_output.txt`: dry run against clean scratch copies of all 5. 5/5 pass, nothing written.

## Next

SO clearance on the new frozen hash (`8652ebec303e66c98e6a05ca25a32db6cdaef99f9c32de01a3a57a2dd249ab29`), TL approval, second-agent pre-hash recount at apply time, apply with `--approved-sha256` **from this branch's head, not from `main`** (the list isn't merged yet), post-write check on exactly 5 files. No grouping check needed.
