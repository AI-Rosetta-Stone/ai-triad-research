# t/4658 Repair 1: frozen mojibake list

Re-scan per SO condition C1 (e/407#2). t/4658#1's original scan only checked `authors` for the
`[ÃÂ][\x80-\xff]` (UTF-8-as-Latin1) signature; it missed the UTF-8-as-CP1252 signature (`â€...`)
entirely, and didn't check `title` or `one_liner`.

## Scope

Fields scanned: `authors`, `title`, `one_liner`, across all 902 `ai-triad-sources/*/metadata.json`.

## Counts

| field | hits | docs | latin-1 | cp1252 |
|---|---|---|---|---|
| title | 36 | 36 | 0 | 36 |
| authors | 23 | 22 | 21 | 2 |
| one_liner | 2 | 2 | 0 | 2 |
| **total** | **61** | **59** (some docs hit on >1 field) | 21 | 40 |

All 61 entries reverse cleanly (0 irreversible) once the codec picker also tries a **lenient
cp1252 encoder** for the 5 bytes (`0x81`, `0x8D`, `0x8F`, `0x90`, `0x9D`) that Python's `cp1252`
*decoder* lenently maps to the same-valued C1 control char, but whose *encoder* then refuses to
round-trip — an asymmetry in Python's own codec, not a real cp1252 ambiguity. Without that, 6 of
the 36 title entries (the ones with doubled curly-quote mojibake, e.g. `â€œ...â€\x9d`) failed to
reverse with either plain `latin-1` or plain `cp1252`.

## Frozen list

`frozen_list.json` — 61 entries, each with `doc_id`, `field`, `index` (for the `authors` array),
`old`, `new`, `codec` (`latin-1` or `cp1252`), `pre_sha256` (the doc's `metadata.json` as it
stands today), `reversible: true`.

**List content hash** (sha256 of the entries array, JSON-dumped with `sort_keys=True,
ensure_ascii=False, indent=2`): `a40988391fa228a4877aabc7a1ad479c065ef99e1a46a4090cedf9100c2e79f2`

## Not included (per SO's note)

`snapshot.md` header titles were not scanned or included — content artifacts are out of scope for
this repair, matching the t/4495 precedent of leaving content artifacts untouched.

## Reproducing this scan

```
AI_TRIAD_SOURCES_ROOT=<path to ai-triad-sources> python3 analyses/t4658-mojibake-repair/scan.py
```

Read-only. Writes only `frozen_list.json` in this directory; makes no change to `ai-triad-sources`.

## Still open before any write (SO conditions C2-C4)

- **C2:** the actual write, once authorized, goes through each doc's own JSON serializer
  (`ensure_ascii=False`), with a 0-collateral check that only the frozen fields change.
- **C3:** since 36 `title` entries are included and `title` feeds `SourceDedupe`/`SourceIdentity`'s
  title key, the corpus-wide source grouping must be run before and after the write, with the
  result recorded (unchanged, or the expected deltas named).
- **C4:** `/data-mutation` discipline — second-agent pre-hash recount, a clean worktree of
  `ai-triad-sources` (the shared `ai-triad-sources` checkout may be dirty per e/397#2 — check
  before writing), pathspec-only commit.

Not executed here. This artifact only freezes the target list per C1.
