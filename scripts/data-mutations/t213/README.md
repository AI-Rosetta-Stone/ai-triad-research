# t/213 (Orca t/4403): the 18 duplicate sets outside the t/4337 / t/4405 packets

**Candidate list only. Nothing here authorizes a corpus write.**

- `t4403-outside-duplicate-sets.md` is the PI's reconstruction (2026-11-10) of the 18 raw-identical sets (39 docs) outside the t/4337 / t/4405 packets, at `ai-triad-sources@ec7deb133e1d`. It is copied verbatim from `C:\tmp\c\t4403-outside-duplicate-sets.md` so it is versioned (`C:\tmp` isn't durable). sha256 prefix `798b1f985f91033a`.
- `manual-marks.json` records set #12 as an enumerated manual mark (TL ruling t/213#8).

## What actually happened (measured read-only on ai-triad-sources@ec7deb133e1d; t/213#5)

**There is no builder-coverage gap.** An earlier version of this README blamed the mark builders for skipping metadata-less folders. That was wrong:

- **Sets #1–11 and #13–18 (17 sets):** t/4337's Freeze feeds every folder, metadata or not, to `Get-SourceIdentityGroup`, and all 17 join through the §4.2 hash edge (byte-identical `snapshot.md`). `frozen-t4337-marks.json` → `marks_without_metadata` lists exactly their 20 metadata-less twins, each with its `duplicate_of` target. Apply wrote only twins that have a `metadata.json`, and left these 20 alone **by design, per SO C10** (no reader; `-CreateMissingMetadata` off). The PI reconstruction counts them as never grouped because it excludes only *applied* t/4337 marks.
  - **TL ruling (p/37#38):** keep SO C10. No metadata creation, no quarantine, no write.
  - **Regression test:** `tests/SourceIdentity.MetadataLessTwin.Tests.ps1` (#4913) locks in the §4.2 join for the 17 sets and the reject cases.
- **Set #12 (Kurbo DOJ release):** a genuine identity miss. Both members have metadata. The body is under the §1.3 100-word floor, so there is no hash; the URLs are empty; the ids aren't a `-N` pair; and one title carries the DOJ page banner. The raw PDF is byte-identical, and the snapshots differ only in the title and H1.
  - **TL ruling (t/213#8):** no general rule (a banner-substring title match is too loose). Recorded instead as an enumerated manual mark in `manual-marks.json`: A `duplicate_of` B, with B canonical.

## Before any `duplicate_of` write

The #12 manual mark rides the next `duplicate_of` batch that gets:

1. an independent second-agent recount of the frozen list; and
2. PI sign-off on the frozen list's hash (`/data-mutation`).

No standalone write.
