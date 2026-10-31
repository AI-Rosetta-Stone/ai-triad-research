# t/4658 Repair 1: apply-ready frozen mojibake list

Re-scan per SO condition C1 (e/407#2), then addresses gaps G1-G3 the SO found in the first pass
of this artifact (e/407#4). t/4658#1's original scan only checked `authors` for the
`[ÃÂ][\x80-\xff]` (UTF-8-as-Latin1) signature; it missed the UTF-8-as-CP1252 signature (`â€...`)
entirely, and didn't check `title` or `one_liner`.

## Pipeline

1. **`scan.py`** (discovery, working-copy read) — finds every hit across
   `authors`/`title`/`one_liner`, computes the candidate fix. Writes `raw_scan.json`
   (`doc_id`/`field`/`index`/`old`/`new`/`codec` only — **no sha256**, since a working-copy read
   can silently diverge from the committed blob, t/4495#4's CRLF-drift class, flagged as G1).
2. **`freeze.py`** (consolidation, committed-blob read) — groups `raw_scan.json`'s hits by doc,
   reads each target's `metadata.json` via `git show <base_commit>:<path>` (not the working copy),
   applies all of that doc's fixes through the doc's own serializer, and records `pre_sha256`
   (committed blob) and `post_sha256` (the would-be result) per doc. Writes
   `frozen_metadata_fixes.json`. Refuses (exit 2) if the committed blob doesn't round-trip
   byte-exactly, or if a scanned `old` value doesn't match the committed value.
3. **`apply_metadata_fixes.py`** (validator/writer, adapted from t/4495's) — dry-run by default;
   `--apply` additionally requires `--approved-sha256 <hash>` matched against the frozen file's
   own sha256. Validates, per target, before writing any: `pre_sha256` match, byte-exact
   round-trip, every field's (or `authors[index]`'s) current value equals the frozen `old`, key
   set/order unchanged, every non-target field (and every non-target `authors` index) unchanged,
   the textual diff touches only target-owned lines, and the result hashes to the frozen
   `post_sha256`.

## Counts

| field | hits | docs | latin-1 | cp1252 |
|---|---|---|---|---|
| title | 36 | 36 | 0 | 36 |
| authors | 23 | 22 | 21 | 2 |
| one_liner | 2 | 2 | 0 | 2 |
| **total** | **61** | **57** (some docs hit on >1 field) | 21 | 40 |

(The SO's independent count is 57 docs, not the 59 in this artifact's first pass — the first pass
miscounted by treating per-field doc sets as disjoint rather than taking their union. 57 is
confirmed by `freeze.py`'s own grouping.)

All 61 entries reverse cleanly (0 irreversible) once the codec picker also tries a **lenient
cp1252 encoder** for the 5 bytes (`0x81`, `0x8D`, `0x8F`, `0x90`, `0x9D`) that Python's `cp1252`
*decoder* lenently maps to the same-valued C1 control char, but whose *encoder* then refuses to
round-trip — an asymmetry in Python's own codec, not a real cp1252 ambiguity. Without that, 6 of
the 36 title entries (the ones with doubled curly-quote mojibake, e.g. `â€œ...â€\x9d`) failed to
reverse with either plain `latin-1` or plain `cp1252`.

## Frozen list

`frozen_metadata_fixes.json` — `base_commit` (the `ai-triad-sources` commit every `pre_sha256` is
read against: `a17b5a04bb94cbbe04b4ca4abcdb7efe4d022700`), and 57 `targets`, each with `doc_id`,
`path`, `pre_sha256` (committed blob), `fields` (each with `field`, `index` for `authors`, `old`,
`new`, `codec`), `post_sha256`.

**List content hash** (sha256 of the file bytes as written — `json.dumps(..., indent=2,
ensure_ascii=False) + "\n"`): `71d35f84e5af04f75816470fac270f07ba07e0cf471c9ef0d577137c5d632306`

## Dry run

`dry_run_output.txt` — **57/57 targets pass all checks, nothing written.** Run against a
dedicated, detached, `core.autocrlf=false` worktree of `ai-triad-sources` at the frozen
`base_commit` (the shared `ai-triad-sources` checkout has `core.autocrlf=true`, which is exactly
the drift class t/4495#4 and this ticket's own first pass hit — G1). The worktree was removed
after the dry run; nothing in `ai-triad-sources` was touched.

## Not included (per SO's note)

`snapshot.md` header titles were not scanned or included — content artifacts are out of scope for
this repair, matching the t/4495 precedent of leaving content artifacts untouched.

## Reproducing

```
AI_TRIAD_SOURCES_ROOT=<path to ai-triad-sources> python3 analyses/t4658-mojibake-repair/scan.py
python3 analyses/t4658-mojibake-repair/freeze.py <path to ai-triad-sources> <base_commit>
python3 analyses/t4658-mojibake-repair/apply_metadata_fixes.py <path to a core.autocrlf=false worktree of ai-triad-sources>
```

All three steps are read-only. Nothing in this pipeline writes to `ai-triad-sources` without
`--apply --approved-sha256 <hash>` on the third step.

## C3: before/after source grouping — DONE, zero drift

Ran `Get-SourceIdentityIndex` (the real production function, `AITriad/Private/SourceDedupe.ps1`)
against a dedicated worktree at the frozen `base_commit`, then again after applying all 57
targets' fixes to that same (disposable, never-pushed) worktree — the t/4495#9 pattern.

`grouping_before.json` / `grouping_after.json`: sorted `ByHash`/`ByUrl`/`ByTitle` key→owner maps.

**Result: 0 drift.** Same key counts (697 `ByHash`, 133 `ByUrl`, 708 `ByTitle`), and a full
key-set + owner diff confirms zero keys removed, zero added, zero owner reassigned, across all
three indices. The 36 corrected titles don't change their title-identity key — the mojibake and
the clean text evidently normalize to the same key under `SourceDedupe`'s title-key computation.

## Still open before the write

- **C4 (`/data-mutation`):** second-agent pre-hash recount at the then-current `ai-triad-sources`
  HEAD immediately before applying (void if HEAD has moved since this freeze — re-freeze), claim
  on t/4658 before the shared-tree write, app quiesce, apply from a fresh `core.autocrlf=false`
  worktree, post-write check on the committed tree (not the dry-run output).
- **PI/TL authorization** on this exact frozen list's hash (`71d35f84...`), per root AGENTS.md's
  T2 process — SO clearance lets the TL approve instead of the PI (t/4096#58), if the SO clears
  with no dissent.

Not executed here. This artifact is apply-ready (dry run passes 57/57, C3 clean) but nothing has
been written to `ai-triad-sources`.
