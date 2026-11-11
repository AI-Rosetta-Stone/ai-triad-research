# t/358 — is the merged summarizer under-extracting?

**Summary.** No, the merge isn't losing evidence. The yield problem is upstream, in **single-call
extraction**.
- `Invoke-DocumentSummary` chunks only documents above 20,000 estimated tokens (~80k chars,
  `Invoke-DocumentSummary.ps1:85`). Everything shorter gets **one** extraction call.
- Across the corpus, single-call yield is **flat** at a median of 3 facts and 6–7 key points whether
  the document is 5k or 80k characters. It **steps up exactly at the chunking threshold** (80–160k:
  6 facts / 20 key points).
- The merge keeps a median **99%** of chunk items (p10 92%) on the 245 chunked documents that
  record it.
- The t/292 document (`explaining-womens-skepticism…`, 67k chars) never went through a merge. Its
  fresh summary came from the single-call path, and its 19-fact legacy chunk summaries came from an
  older chunk-level run.
- **About 485 documents in the 10–80k band are likely under-extracted.**

All figures are read-only, from data `origin/main` (summaries + snapshots), with no AI calls.
`yield_scan.py` produces `rows.json`. n = 873 summaries that have a source snapshot.

## 1. Yield vs length

| Doc length (chars) | Path | n | Facts median (p25–p75) | Key points median (p25–p75) |
|---|---|---|---|---|
| < 10k | single call | 125 | 3 (2–3) | 5 (4–8) |
| 10–30k | single call | 265 | 3 (3–4) | 7 (6–12) |
| 30–80k | single call | 220 | **3 (2–7)** | **6 (5–9)** |
| 80–160k | chunked | 172 | **6 (5–8)** | **20 (16–24)** |
| > 160k | chunked | 91 | 12 (8–20) | 38 (29–57) |

A 16× range of length gives the same yield on the single-call path, and yield rises sharply the
moment chunking starts. **The yield follows the number of model calls, not the content.** 0 of 873
summaries are marked truncated, so the output-token limit isn't the cause.

## 2. The merge is not the loss point

`context_rot.stages[merge_dedup]` records items before and after the merge (n = 245 chunked
summaries): median out/in **0.99**, p10 **0.92**. The fold thresholds (`Merge-ChunkSummaries.ps1`)
are conservative:
- key points fold above 0.90 cosine within camp and category;
- facts fold at ≥ 0.90 cosine with a numeric guard, or ≥ 0.95 with no numbers;
- cosine alone never folds facts.

Chunking itself keeps 1.00.

## 3. What drives single-call yield (10–80k band, n = 485)

| Factor | Facts median | Key points median |
|---|---|---|
| FIRE mode (n = 459) | 3 | 7 |
| single_shot mode (n = 26) | 3 | **13** |
| any gemini flash-lite variant (n = 482) | 2–4 | 5–9 |
| gemini-2.5-flash (n = 3, too few to rely on) | 15 | 86 |

- **One long-context call on flash-lite saturates at about 3 facts.** Every flash-lite variant
  gives the same ceiling.
- **The single-call prompt asks for less than the chunk prompt does.**
  - `pov-summary-chunk-system.prompt`: "extract EVERY specific empirical or factual assertion … Do
    not cap or limit your output."
  - `pov-summary-system.prompt`: "count every statistic …", but also "there is no quota. An honest
    extraction of 3 points beats a padded extraction of 7", plus "At most about {{KP_MAX}}". KP_MAX
    = max(8, words/200), which isn't binding at these yields.
- **FIRE about halves key points** compared with single-shot (7 vs 13; the single-shot n is small).
  Facts are unchanged.
- **Not the cause:** the KP_MAX cap, output truncation, and the merge.

## 4. Recommendation

**Don't re-summarize the corpus yet.** First, a small paired pilot on documents from the 30–80k
band, run as a spend ask:
- **Arm A:** current settings.
- **Arm B:** chunk threshold lowered, so 30–80k documents take the chunked path with the chunk prompt.
  This is the cheapest lever and doesn't touch any prompt. The threshold is a CL-owned algorithmic
  parameter, and the code change would be PowerShell's.
- **Measure:** yield, and **precision**, by spot-checking that each new fact is a verbatim-grounded
  claim from the source. A yield gain from padding is worse than no gain.
- **Size and cost:** about 10 documents, roughly 50 flash-lite calls, cents.

If Arm B gains yield without losing precision, the PI decision is a re-summarize of the
under-extracted band:
- 220 documents at 30–80k (and optionally the 265 at 10–30k);
- roughly 1–2k flash-lite calls;
- coordinated with t/355's fold of legacy chunk summaries into their base doc_ids, so evidence isn't
  double-counted.

The prompt framing ("honest 3 beats padded 7") is a separate, optional lever. It guards against
padding, so change it only with the same precision check.

**Provenance:** all numbers are derived (corpus scan, counts given).
