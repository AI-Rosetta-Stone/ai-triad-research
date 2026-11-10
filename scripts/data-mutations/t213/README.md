# t/213 (Orca t/4403): the 18 duplicate sets the t/4337 builder never grouped

**Candidate list only. Nothing here authorizes a corpus write.**

- `t4403-outside-duplicate-sets.md` is the PI's reconstruction (2026-11-10) of the 18 raw-identical sets (39 docs) outside the t/4337 / t/4405 packets, at `ai-triad-sources@ec7deb133e1d`. It is copied verbatim from `C:\tmp\c\t4403-outside-duplicate-sets.md` so it is versioned (`C:\tmp` isn't durable). sha256 prefix `798b1f985f91033a`.

## Root cause (measured read-only on ai-triad-sources@ec7deb133e1d)

The identity rules (`Get-SourceIdentityGroup`, spec §4) are **not** the gap. The one-off mark builders never fed these documents to them:

- `scripts/data-mutations/t4405/Invoke-T4405DuplicateMark.ps1` `Get-CorpusDocs` skips every folder with no `metadata.json` (`if (-not (Test-Path -LiteralPath $mp)) { continue }`).
- `scripts/data-mutations/t4337/Invoke-T4337DuplicateMark.ps1` feeds only `HasMeta` documents into the grouping input.
- **17 of the 18 sets** have exactly one member with **no `metadata.json` at all** (only `raw/` + `snapshot.md`) -- the "null-titled" twin. 20 such folders exist corpus-wide.
- For every one of those 26 pairs the two `snapshot.md` files are **byte-identical** (same sha256), and 25 of 26 also have identical substantive raw files. Included in the input, they join through the existing §4.2 hash edge; no §4.4 change is needed.
- **Set #12** (Kurbo DOJ release) is the exception: both members have metadata, titles differ by an "Office of Public Affairs" prefix, and the snapshots are near-equal (ratio 0.957) but not identical, so no current edge joins them. It needs a decided second signal.

## Before any `duplicate_of` write (TL, t/213#3)

1. The builder-coverage fix lands (include metadata-less folders) with a regression fixture from these sets and the reject cases (`.DS_Store` join, empty substantive set, null-title generic raw file).
2. Each weak-title set carries the e/348 second signal (here: byte-identical snapshot).
3. The canonical is chosen per e/348 condition 3 (prefer the clean, untruncated snapshot; a metadata-less twin can't carry a mark without `-CreateMissingMetadata`).
4. A second agent recounts independently.
5. The PI signs off on the frozen list's hash.
