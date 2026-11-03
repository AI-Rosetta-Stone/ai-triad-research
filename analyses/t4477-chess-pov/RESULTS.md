# t/4477: CHESS POV-classification measurement

**Author:** PowerShell · **Date:** 2026-10-29 · **Design:** CL, t/4477#3, corrected at t/4477#8
**Code measured:** `ai-triad-research` `baabf4bc` (includes the t/4477 fix, PR #3832: `Get-PovClassificationSample`, `Get-PovWindowSimilarityCheck`).
**Spend:** PI-approved, ≤50 Gemini `gemini-3.5-flash-lite` calls (t/4477#6, raised from 40). **Used 48/50** (16 docs × 3 calls).

## Design (CL, t/4477#8)

CHESS's own classification result is never persisted (traced in t/4477#7), so the noise baseline comes from re-running CHESS itself twice on the *same* unchanged input, not from diffing against a different classifier's output (`pov_tags`).

Per doc:
- **Run A**: old input, title plus the first 500 words (the pre-fix construction).
- **Run B**: the *same* old input as Run A, run again. **Flip rate A vs B is the classifier's own run-to-run noise.**
- **Run C**: new input, title plus `Get-PovClassificationSample`'s whole-document, section-stratified sample (the fix). **Flip rate vs A is the combined effect of the real input change plus noise.**

Decision rule: the fix is credible only if the new-input flip rate (A vs C) is clearly above the noise baseline (A vs B), **and** CL's adjudication favors the new input on most of the flips that survive. These are flips where A and B *agreed* (stable baseline) but C disagrees. A doc where A and B already disagreed isn't evidence about the new input; none occurred here (0/16).

Flip = the returned POV set differs, comparing substantive camps only (`accelerationist`/`safetyist`/`skeptic`; `situations` is always included as a constant catch-all and carries no signal).

## Sample

n=16, `sample.json` (frozen before any calls): the 16 longest ingested documents (≥15,000 words) whose stored `pov_tags` names exactly one substantive camp. These are the strongest candidates for "the opening set the tag and didn't represent the rest of a long document," per CL's selection criterion (t/4477#3/#8).

## Results

| Measure | Result | n |
|---|---|---|
| Noise baseline (A vs B flip rate) | **0/16 (0%)** | 16 |
| New-input effect (A vs C flip rate) | **2/16 (12.5%)** | 16 |
| Informative flips (A==B stable, A≠C) | **2/16** | 16 |
| Excluded (A≠B, baseline unstable) | 0/16 | 16 |

**2/16 is clearly above the 0/16 noise baseline.** The classifier was perfectly stable on the same input across all 16 docs (A=B in every case), so both informative flips are attributable to the input change, not run-to-run noise.

## The 2 informative flips: CL adjudication needed

| Doc | Stored `pov_tags` | Run A/B (old input) | Run C (new input) | Change |
|---|---|---|---|---|
| `ai-now-2023-landscape-confronting-tech-power-2026` | skeptic | safetyist, skeptic | accelerationist, safetyist, skeptic | **+accelerationist** |
| `nonrivalry-economics-data-2026` | accelerationist | accelerationist, safetyist, skeptic | accelerationist, skeptic | **−safetyist** |

Per the decision rule, these are the cases to adjudicate against the full document: does the whole-document sample (Run C) more accurately reflect what the document actually argues than the opening-only sample (Run A/B)?

- **`ai-now-2023-landscape-...`** (AI Now Institute's "Confronting Tech Power" report): does the full report engage an accelerationist position (e.g., presenting or responding to an industry/innovation case), or is the added `accelerationist` tag a false positive from the broader sample giving the classifier more surface area to over-include on?
- **`nonrivalry-economics-data-2026`** (Jones & Tonetti, "Nonrivalry and the Economics of Data"): the opening abstract already frames privacy/consumer-welfare trade-offs prominently (a safetyist-adjacent framing). Worth checking whether the fuller sample's drop of `safetyist` reflects the paper's actual argument reading more squarely accelerationist/skeptic once read in full (data property rights, efficiency), or whether this is a loss of real signal from sampling.

Both documents are tens of thousands of words long (49,294 and 32,011 words respectively), so the fuller sample spans far more of the document than the opening-500-words window. There is a real chance it changed what the classifier read, not just how much.

## Files
- `sample.json`: the frozen 16-doc sample, committed before any calls, per /data-mutation-adjacent discipline for a bounded spend run.
- `run_measurement.ps1`: the runner. Read-only against the corpus; makes only billed AI calls; writes only its own `results.json` in this directory. Verified zero collateral: no changes to any of the 16 target doc directories in `ai-triad-sources`, or anywhere in `ai-triad-data`.
- `results.json`: full per-doc results (all 3 runs' classifications, flip flags).
