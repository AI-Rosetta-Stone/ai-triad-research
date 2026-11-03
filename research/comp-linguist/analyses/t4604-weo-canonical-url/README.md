# t/4604: WEO canonical URL correction (frozen list)

**Anchor:** t/4604 (SO follow-up F1 from t/4495, e/391#2). **Tier:** T2, a corpus write to `ai-triad-sources`. **Status:** prepared, NOT applied. Nothing written to either data repo.

## Background

`text-2026` and `text-2026-1` are `duplicate_of` `world-economic-outlook-update-global-economy-steady-amid-2026-2`. t/4495 corrected the two duplicates' own metadata (they're also marked `duplicate_of` this same canonical, independently, per t/4405). The canonical itself was never touched — its `url`/`resolved_url`/`provenance` still point to a `betterregulation.com` mirror, from a `confidence:"search"` guess.

## What changes

One target, four fields, in `frozen_metadata_fixes.json`. Base: `ai-triad-sources` `1b7717d` (post t/4495 apply; confirmed byte-identical at `pre_sha256`, read from the committed blob via `git show HEAD:<path>` to avoid the local-checkout CRLF drift t/4495#4/#8 already documented for this machine).

| Field | Old | New |
|---|---|---|
| `url` | `https://service.betterregulation.com/document/829028` | `https://www.imf.org/en/Publications/WEO/Issues/2026/01/19/world-economic-outlook-update-january-2026` |
| `resolved_url` | same mirror | same IMF URL |
| `provenance` | `[{search, mirror}]` | `[{verified, IMF URL}]` |
| `provenance_status` | `extracted` | `verified` |

**Evidence: reused, not re-fetched.** This is the identical report as `text-2026` (t/4495) — confirmed by byte-comparing the snapshots: both open "INTERNATIONAL MONETARY FUND / WORLD ECONOMIC OUTLOOK UPDATE / Global Economy: Steady amid Divergent Forces", and this canonical's own title field already reads "World Economic Outlook Update: Global Economy: Steady amid Divergent Forces" — the same report t/4495's IMF URL fetch (2026-10-27, "released January 19, 2026") already verified. No new fetch was needed or performed.

**Left alone, on purpose:** `date_published` is `2026-01-01`, which looks like a placeholder given the verified release date is January 19, 2026 — but fixing it wasn't in t/4604's scope (url/resolved_url/provenance only, per t/4495#2's F1) and I'm not expanding scope on an unverified inference. Flagging it here rather than fixing it silently; a follow-up can pick it up if wanted.

## Mechanism checks (data-mutation playbook A/B)

- **A, mechanism per entry:** same cause as t/4495's other targets — a `confidence:"search"` URL guess at ingest, never corrected.
- **B, re-deriving producer:** same finding as t/4495's README — no live producer rewrites `url`/`resolved_url`/`provenance_status` for an existing document; the only one that would (`scripts/archive/populate_provenance.py`) is unreferenced, and would no longer reproduce the mirror URL once this lands anyway.
- **Identity:** the new URL is not yet a trusted key anywhere in the corpus (checked: no other `metadata.json` carries it). This *will* become this canonical's trusted URL key once applied — expected, not a new finding; t/4495's own apply already established the identical IMF URL for `text-2026`'s key (the two won't collide because they're different docs claiming different, both-correct IMF URLs... actually they're the same URL. See note below.)

**Note on identity overlap with t/4495:** `text-2026`'s new URL and this canonical's new URL are **the same IMF URL** (both are the same report). Once this lands, `text-2026` (already fixed, `duplicate_of` this canonical) and the canonical itself will share one trusted URL key — the identical situation `text-2026-1` is already in today, which t/4495#9 confirmed is expected behavior ("the index records one canonical owner per key... not a new duplicate or a crash"), not a new risk.

## Files

- `frozen_metadata_fixes.json`: the one target, old/new values with evidence, `pre_sha256`/`post_sha256`.
- `apply_metadata_fixes.py`: identical script to t/4495's (same hash-enforced, structurally-verified applier), pointed at this directory's frozen file.
- `dry_run_output.txt`: dry run against a clean LF scratch copy of the target file. 1/1 passes, nothing written.

## Next

Same sequence as t/4495: SO round (can likely be lighter given this reuses t/4495's own evidence and pattern exactly — TL/PI's call), then approval, second-agent pre-hash recount at apply time, apply with `--approved-sha256`, post-write check, and a repeat of the source-grouping check from t/4495#9 (expect: one more trusted URL key, no canonical drift, no error from the shared-key-with-text-2026 case already proven safe).
