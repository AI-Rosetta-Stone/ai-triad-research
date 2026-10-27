# t/4495: source metadata corrections (frozen list)

**Anchor:** t/4402. **Tier:** T2, a corpus write to `ai-triad-sources`. **Status:** prepared, NOT applied. Nothing has been written to either data repo.

The apply needs, in order:
1. the Second Opinion round;
2. the PI's sign-off on the frozen list's sha256, recorded on t/4495;
3. a claim on the anchor;
4. an app quiesce;
5. `--apply`;
6. a post-write check on the committed tree;
7. a second agent's independent count.

## What changes

The full per-field old and new values, with evidence, are in `frozen_metadata_fixes.json`.

Base: `ai-triad-sources` `689d214`. All six files are byte-identical to `cf27561`, the R1 apply.

| Target | Fields | New value (main one) | Evidence |
|---|---|---|---|
| `text-2026` | title, url, resolved_url, provenance, provenance_status | IMF *World Economic Outlook Update, January 2026* | Our snapshot opens with the WEO title page; the IMF page was fetched 2026-10-27 |
| `text-2026-1` | the same five | the same | the same (identical raw blob) |
| `california-lawyers-chatgpt-use-…-2026` (canonical) | title, url, date_published, **source_time**, **authors** | headline "California issues historic fine over lawyer's ChatGPT fabrications"; CalMatters URL; 2025-09-22; Khari Johnson | Our snapshot byline; the CalMatters page fetched 2026-10-27; the member doc already carries these values |
| `how-existing-liability-…-2026` (canonical) | url, resolved_url, provenance, provenance_status | lawfaremedia.org article | The Lawfare page fetched 2026-10-27 matches the title, author and date |
| `international-ai-safety-report-2026-2026-1` | url, resolved_url, provenance | internationalaisafetyreport.org publication page | Our snapshot is a print of that page (325 footer URLs) |
| `scaling-laws-…-2026-1` | url, resolved_url, provenance, provenance_status | proceedings.mlr.press/v267/mckenna25a.html | Raw file `mckenna25a.pdf` contains "PMLR 267"; the PMLR page was fetched 2026-10-27 |

**Beyond t/4402#1, flagged for the SO:**
- **`resolved_url` and `provenance` go with every `url` fix.** Debate citations read `resolved_url` before `url` (`lib/debate/debateEngine.ts:1375-1377`, `lib/debate/citationResolution.ts`). So a `url`-only fix would leave debates linking to Collins, LinkedIn or GitHub.
- **The California `source_time` and `authors`** are added for consistency with the member document. Both are evidenced in our snapshot.

**Dropped or not included:**
- **The California SEO title as an alias.** The schema has no alias field, and adding one is a shape change. The SEO title remains visible in the raw PDF metadata and in its file name.
- **Snapshot headers.** They still show the old titles; they're content files, so this list doesn't touch them.
- **The scaling-laws `-1` date_published `2025-01-01`.** It looks like a placeholder, but no exact date is evidenced in our artifacts.
- **The WEO canonical's third-party mirror URL.** Out of scope; it's a candidate follow-up.

## Mechanism checks (the playbook's checks A and B)

- **A, mechanism per entry.** Every old URL is a `confidence:"search"` provenance guess copied into `url` and `resolved_url`. The two wrong titles have separate causes: `text-2026` and `-1` were AI title extraction at ingest, and California used the SEO title.
- **B, whether anything re-derives the fields:** no live producer rewrites `title`, `url`, `resolved_url` or `date_published` for an existing source.
  - **Ingest** (`Import-AITriadDocument` → `Get-AIMetadata`) writes them only for new documents, and it refuses duplicates by URL or content hash.
  - **The summary writers** only touch `summary_*`, `claims_by_pov` and similar.
  - **taxonomy-editor** only reads source metadata (`fileIO.ts:829`, t/4391).
  - **The one re-deriving producer is the archived `scripts/archive/populate_provenance.py`.** It is unreferenced. If it were re-run, it would rebuild `provenance` and `resolved_url` from the existing `url` and snapshot headers. That would no longer reproduce the bad URLs, since `url` is corrected and the snapshot `Source:` headers are empty. It only writes `url` when `url` is empty.
- **Identity:** none of the 863 metadata files already carries any of the new URLs, so no new identity collision is possible. `SourceIdentity` untrusts only the URLs that match a `confidence:"search"` provenance entry. Every such entry here is replaced.

## Files

- `frozen_metadata_fixes.json`: the frozen list. The targets, per-field old and new values with evidence, `pre_sha256`, and the expected `post_sha256`.
- `apply_metadata_fixes.py <sources_root> [--apply]`: reads only the frozen file. It defaults to a dry run, and checks every target before writing anything. It refuses on any of:
  - a `pre_sha256` mismatch;
  - a file that doesn't round-trip byte for byte;
  - an `old` value that has drifted;
  - an added, removed or reordered key;
  - a changed non-target field;
  - a diff line outside the target fields;
  - a `post_sha256` mismatch.
- `dry_run_output.txt`: the dry run against a scratch copy of the six files at `689d214`. 6 of 6 pass, and nothing is written.
