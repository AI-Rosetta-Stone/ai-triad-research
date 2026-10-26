# Replacing the summary density floor: tag-aware camp expectations and persisted emptiness

**Ticket:** t/4473 (epic t/4467) · **Author:** Computational Linguist · **Date:** 2026-10-26
**Status:** spec ready for implementation (PowerShell).
**Provenance:** the corpus counts are deterministic scans of `ai-triad-data` `b93a2dbc` and `ai-triad-sources` (864 summaries with a snapshot). The off-lens and gap labels are a CL single-rater annotation, blind to on/off-tag. Data and scripts are in `analyses/t4473-density/`.

## 1. What the code does now

The ticket described a per-camp linear floor (`KpMin = max(3, wordCount/500)` per camp) that drives a retry. The code on `main` is a little different, and the difference matters for the fix:

- **The retry check (`Test-SummaryDensity`, `Invoke-DocumentSummary.ps1:473`) is document-level.** It fails when the total key_points across the three camps fall below `TotalFloor = max(6, 2 × KpMin)` (about wordCount/250). It also fails when a camp has 0 key_points and doesn't declare all three of its BDI cells in `empty_cells`, or when `unmapped_concepts` falls below `max(2, wordCount/2000)`.
- **The per-camp pressure is in the prompt.** `pov-summary-system.prompt` asks for "key_points: target {{KP_MIN}}-{{KP_MAX}} per camp" for every camp, and tells the model to re-examine the document if the total falls below `{{TOTAL_FLOOR}}`.
- **Single-shot retries once** with `Build-DensityRetryNudge` ("Go back through the document and extract MORE points. Examine ALL nine BDI cells …"). Chunked runs are warn-only. FIRE runs have no density check.
- **Licensed emptiness half-exists.** The prompt and schema already support `empty_cells` (REC-1, t/529). The density check reads it. But `New-SummaryDocument` (`FinalizeSummarySteps.ps1:485`) builds the saved summary from a fixed field list that omits `empty_cells`, so it is dropped before the write. **0 of 864 saved summaries carry `empty_cells`.**
- The dry-run preview (`InvokePOVSummarySteps.ps1:163`) recomputes the same floors inline instead of calling `Get-DensityFloors`.

## 2. What the corpus shows

`scan.py`, `kp_sample.py`, `windows.py`, `gap_sample.py`:

| Finding | Count |
|---|---|
| Single-shot summaries whose saved output still fails the check | **281 / 288 (98%)**. A failing saved output means the retry fired and didn't fix it. |
| ... failing the total floor | 268 / 288. Median floor 68 against a median 22 key_points achieved. |
| ... failing the unmapped-concepts floor | 275 / 288. In all modes: 768 / 864. |
| Summaries with any empty camp | 35 / 864. Only 2 of them have a camp the document's `pov_tags` name. |
| Documents with `pov_tags` | 722 / 864 |
| Key_points in a camp the document is **not** tagged for | **3,930 / 10,836 (36%)**. Single-tag docs: 2,842 / 5,427 (52%). |
| Verbatim quote found in the snapshot, on-tag vs off-tag | 82.5% vs 83.7%. Off-tag points don't invent quotes. |
| `strongly_aligned` stance, on-tag vs off-tag | 23.6% vs 2.6% |

**The floor is unreachable.** At the current formula, almost every single-shot document fails, retries, and fails again. The retry is a second full extraction call on ~98% of single-shot documents, and its only lever is "extract MORE … examine ALL nine BDI cells".

**Off-lens points, blind labelling** (`labels.json`, n=60: 30 off-tag and 30 on-tag key_points, one per document, seeded sample; tags hidden while labelling):

| | n | Genuine | Stretched | Unsupported |
|---|---|---|---|---|
| On-tag | 30 | 26 | 3 | 1 |
| Off-tag | 30 | 10 | **18** | 2 |

*Stretched* means the quote is real but the camp lens is imposed: "The document prioritizes auditing AI outputs … this aligns with accelerationist goals of using empirical telemetry" for a privacy-leakage benchmark, or a renewable-energy price claim filed under an accelerationist AI-economics node. Off-tag accelerationist points are the worst (11 of 14 stretched or unsupported). *Unsupported* is a missing verbatim, a bibliography entry, or an author bio.

**Two consequences for the design:**
1. The ticket's fabrication pressure is real. Off-tag points are stretched or unsupported at 67%, against 13% on-tag. These are not fabricated quotations; they are real quotations given a lens the document doesn't take.
2. **Untagged camps can't be banned.** 10 of 30 off-tag points are genuine: the document does engage that camp, and the metadata tagger missed it. Expectations for an untagged camp have to be "only where the document engages it", not "none".

**Section coverage isn't viable on this corpus:**
- **No headings.** 793 of 864 snapshots have at most one `#` heading (the title), because PDF and HTML conversion rarely keeps headings. A `##`-section check would apply to 8% of documents.
- **A positional proxy fails on precision.** The substitute is fixed 2,500-word windows, flagging a run of ≥2 windows with no key_point verbatim, final window ignored. It flags 79 of 445 eligible documents (18%), but only **2 of 15** sampled gaps hold a claim the extraction should have caught (`gap_labels.json`: 1 yes, 1 borderline). The rest are reference lists in the middle of the document (multi-part papers), maths, methods, survey demographics, and garbled table conversions.

A coverage retry would mostly re-prompt on bibliographies. This spec recommends none.

## 3. The design

### 3a. Remove the floors and the retry

- Delete the single-shot density retry loop (`Invoke-SummaryPipeline.ps1:214-283`) and `Build-DensityRetryNudge`. Single-shot makes one extraction call.
- Delete `TotalFloor`, the unmapped-concepts floor and the `{{TOTAL_FLOOR}}` / `{{KP_MIN}}` / `{{UC_MIN}}` substitutions. `Get-DensityFloors` and the inline dry-run copy go with them.
- **Keep one check, WARN-only, in all three paths (single-shot, chunked, FIRE):** a camp named in the document's `pov_tags` that has 0 key_points and no `empty_cells` entry for that camp. The WARN names the camp: `WARN: <doc>: tagged camp '<camp>' has 0 key_points and no empty_cells rationale`. It fired on 2 of 864 summaries in the current corpus, so it stays quiet enough to be read. It never triggers a retry.
- **No document-level total floor.** The data doesn't justify one: every value that would bind on more than a handful of documents binds on nearly all of them.

### 3b. Tag-aware expectations in the prompt

In `pov-summary-system.prompt` and `pov-summary-chunk-system.prompt`, replace the per-camp density targets and the TOTAL_FLOOR re-examine line with:

```
CAMP EXPECTATIONS:
  The document's POV tags (given with the document) name the camps it was
  classified as engaging. Treat them as a strong hint, not a limit.
  • Tagged camps: be thorough. Extract every distinct point the document makes
    that bears on that camp's beliefs, desires or intentions.
  • Untagged camps: extract a point only when the document itself argues for or
    against a position that camp holds. A document's topic overlapping a camp's
    interests is not enough. Never write "From an <camp> perspective, this …" to
    connect a point to a camp the document does not engage.
  • If no POV tags are given, treat every camp as tagged.
  • An empty camp is a correct answer when the document does not engage it.
    Declare each empty cell in "empty_cells" with a one-line reason.
  Longer documents usually yield more points, but there is no quota. An honest
  extraction of 3 points beats a padded extraction of 7.
```

The existing ANTI-FABRICATION RULE stays. The `{{KP_MAX}}` / `{{UC_MAX}}` upper guidance can stay as "up to" targets, since nothing reads them as a floor.

The chunk prompt already carries the document's POV tags (`Invoke-DocumentSummary.ps1:640`), and the single-shot prompt does too (`Invoke-SummaryPipeline.ps1:165`). FIRE's initial call uses the same system instruction. The AutoFire Stage 2 re-run (`Invoke-SummaryPipeline.ps1`, after the sniff) calls `Invoke-IterativeExtraction` **without** `-SystemInstruction`. Check whether that drops the system prompt, these rules included, and fix it in the same PR if it does.

### 3c. Persist `empty_cells`

- Add `empty_cells` (array of `{camp, category, reason}`, default `[]`) to the `New-SummaryDocument` field list.
- `Merge-ChunkSummaries` doesn't carry `empty_cells` today. In the chunked path, a cell is empty for the document only if every chunk declared it empty and the merged summary has no key_point in it. Keep the first chunk's reason.
- **No new `no_points_rationale` field.** `empty_cells` already exists in the prompt, the schema and the density check. It is per cell, which is finer than the ticket's per camp. A second field for the same fact would split the signal.
- **Tier T0:** additive and forensic. Put a point-of-use exemption note on the field (the `lib/ai-client/types.ts` model): nothing branches on it, and the exemption lapses when a consumer does. The first consumer that displays or filters on it is T1.
- **Empty camps already occur:** 35 saved summaries have one, and nothing has been reported broken. That is weak evidence, not a consumer audit. A Pester case should cover a summary with an empty camp plus `empty_cells` through finalize and the metadata rollup (`claims_by_pov`).

### 3d. Out of scope

- Coverage-driven retry (§2 shows it would be low precision). If snapshot conversion starts keeping headings, revisit with a `##`-section check.
- Metadata `pov_tags` recall. The 10/30 genuine off-tag points show the tagger under-tags. That's a metadata-prompt question, raised separately rather than fixed here.
- Snapshot conversion defects seen in the gap sample (character-reversed text, collapsed tables). These are noted for whoever owns the converters.

## 4. Thresholds and provenance

| Parameter | Class | Note |
|---|---|---|
| Tagged-camp-empty WARN (0 key_points and no `empty_cells` in a `pov_tags` camp) | stipulated | Fires on 2 / 864 at baseline |
| Removal of the total and unmapped floors | derived | 98% single-shot retry-and-still-fail; `scan.py` |
| No coverage retry | derived | 2/15 gap precision; `gap_sample.py`, `gap_labels.json` |

Recorded in `docs/metric-provenance-register.md`.

## 5. Measurement after landing

Re-extraction needs a TL-routed spend request (t/4471's PI approval does not carry over).

1. **Sample:** 15 single-tag documents, drawn with the `kp_sample.py` seed from documents not in the 60-item label sheet. Same model and settings as their saved summary. Scratch data and sources roots, with both real repos checked clean after every run (the t/4471 near-miss).
2. **Off-lens rate:** blind-label 30 off-tag key_points (or all of them, if fewer) with the §2 rubric. **Pass:** stretched + unsupported ≤ 33% (half the 67% baseline), with the count reported.
3. **On-tag guard:** on-tag key_point count per document falls by no more than 10% in the median, and blind-labelled on-tag genuine stays ≥ 80% (baseline 26/30).
4. **Cost:** extraction calls per single-shot document go to 1 (baseline ~2).
5. **`empty_cells`:** present in every new summary. Every camp with 0 key_points has a declaration, or the WARN fired.

The on-tag guard and the 33% bar are **stipulated**.
