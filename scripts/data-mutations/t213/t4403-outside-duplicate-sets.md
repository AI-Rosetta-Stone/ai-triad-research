# t/4403 — the 18 raw-identical sets (39 docs) the t/4337 builder never grouped

**Status: candidate list, not a frozen/authorized list.** This is step 1 of t/4403 ("find out why the builder missed them... build a frozen list"). It was not previously written down anywhere in Orca — the ticket and its source email (e/348) only state the counts (18 sets / 39 docs) and two example doc-name fragments (`tracing-thoughts-…`, `persona-vectors-…`). This document reconstructs the actual list by re-running the same method CL used, against the same commit.

**Do not treat this as authorization to write anything to the corpus.** Per t/4403 and the `/data-mutation` discipline it invokes, any actual `duplicate_of` write needs: the builder-coverage fix landed, a regression fixture, a second-agent independent recount of this exact list, and PI sign-off on a frozen list's hash — none of which has happened yet.

## Method (reproducing CL's e/348 measurement)

1. **Corpus commit:** `ai-triad-sources` @ `ec7deb133e1d6ceeb4996c2d8e4c5246cd01feb9` (current `origin/main`, same lineage as CL's `58ca2fc8` measurement — no doc additions/removals affecting this set in between).
2. For every doc's `raw/` directory, computed the git blob SHA of each file via `git ls-tree -r -l`.
3. **Substantive-file filter** (SO e/348#2 condition 1): excluded dotfiles, `Thumbs.db`, `desktop.ini`, and any file under 1 KB.
4. Grouped docs by **identical, non-empty substantive blob-ID sets** — i.e. byte-for-byte identical raw source files.
5. Resolved each doc's existing `duplicate_of` chain (from `_index.json`) to its current canonical. Kept only groups that **still resolve to more than one canonical** — i.e. genuinely-unresolved duplicates, not sets already correctly marked.
6. **Excluded** any group touching the t/4337 or t/4398/t/4405 "packet" (the 29 review groups, their marks, their review entries, and all t/4337 applied marks) — those are the 28+10 sets already accounted for elsewhere (e/348's "28 fully inside review/C9" + "10 join review to already-marked"). What's left is the **18 sets (39 docs) outside the packet entirely** — the builder-coverage gap this ticket is about.

Result: **18 sets, 39 docs** — matching the ticket's own count exactly, and including both of its named examples (`tracing-thoughts-large-language-model-2026(-1)`, `persona-vectors-monitoring-controlling-character-traits-2026(-1)`).

**Caveat:** every one of these 18 sets currently has `blob_count: 1` (a single shared raw file per pair/triple) and none has any existing `duplicate_of` set on any member — i.e. these are pairs/triples the builder has literally never looked at, not ones it looked at and got wrong. 16 of 18 sets have exactly one member with a real (non-null) title and the rest null-titled — consistent with the ticket's own description ("many have a null title on one side") and the SO's risk note in e/348#2 ("many of the 18 outside sets have a null title on one side, so this risk sits right where the new criterion will be used next" — meaning each of these still needs the full e/348 guard set applied before being marked, not just raw-identity).

## The 18 sets

| # | Docs (raw-identical) | Real title (if any) | Notes |
|---|---|---|---|
| 1 | `algorithmic-disgorgement-destruction-artificial-2026`, `-1`, `-2` | "Algorithmic Disgorgement: Destruction of Artificial Intelligence Models as the FTC's Newest Enforcement Tool for Bad Data" (on `-2`) | triple; 2 of 3 null-titled |
| 2 | `assistant-axis-situating-stabilizing-character-large-2026`, `-1` | "The assistant axis: situating and stabilizing the character of large language models" (on `-1`) | pair; base id null-titled |
| 3 | `auditing-language-models-hidden-objectives-2026`, `-1`, `-2` | "Auditing language models for hidden objectives" (on `-2`) | triple; 2 of 3 null-titled |
| 4 | `can-ai-models-reason-like-clinicians-2026`, `-1` | "Can AI models reason like clinicians?" (on `-1`) | pair; base id null-titled |
| 5 | `emotion-concepts-their-function-large-language-model-2026`, `-1` | "Emotion concepts and their function in a large language model" (on `-1`) | pair; base id null-titled |
| 6 | `frontier-reasoning-models-scaling-laws-whats-actually-2026`, `-1`, `-2` | "The Frontier: Reasoning Models, Scaling Laws & What's Actually Coming Next" (on `-2`) | triple; 2 of 3 null-titled |
| 7 | `interpretability-signs-introspection-large-language-models-2026`, `-1` | "Interpretability: Signs of introspection in large language models" (on `-1`) | pair; base id null-titled |
| 8 | `lets-not-forget-george-stiglers-lessons-about-regulatory-2026`, `-1` | "Let's Not Forget George Stigler's Lessons about Regulatory Capture" (on `-1`) | pair; base id null-titled |
| 9 | `mapping-mind-large-language-model-2026`, `-1` | "Mapping the Mind of a Large Language Model" (on `-1`) | pair; base id null-titled |
| 10 | `name-right-regime-microsoft-shareholder-suit-limits-ai-2026`, `-1` | "Name the Right Regime: The Microsoft Shareholder Suit and the Limits of AI Provenance" (on `-1`) | pair; base id null-titled |
| 11 | `natural-language-autoencoders-turning-claudes-thoughts-into-2026`, `-1` | "Natural Language Autoencoders: Turning Claude's thoughts into text" (on `-1`) | pair; base id null-titled |
| 12 | `office-public-affairs-weight-management-companies-kurbo-inc-2026`, `weight-management-companies-kurbo-inc-ww-international-inc-2026` | both titled (DOJ press release, two id-slug variants) | **only pair where BOTH sides have real titles** — titles agree after normalization (same release, one with "Office of Public Affairs" prefix) |
| 13 | `open-sourcing-circuit-tracing-tools-2026`, `-1` | "Open-sourcing circuit tracing tools" (on `-1`) | pair; base id null-titled |
| 14 | `persona-vectors-monitoring-controlling-character-traits-2026`, `-1` | "Persona vectors: Monitoring and controlling character traits in language models" (on `-1`) | pair; base id null-titled — **named in the ticket** |
| 15 | `responsible-ai-overview-from-explainability-responsibility-2026`, `-1` | "Responsible AI Overview: From Explainability to Responsibility" (on `-1`) | pair; base id null-titled |
| 16 | `theory-economic-regulation-2026`, `-1` | "The Theory of Economic Regulation" (on `-1`) | pair; base id null-titled |
| 17 | `tracing-thoughts-large-language-model-2026`, `-1` | "Tracing the thoughts of a large language model" (on `-1`) | pair; base id null-titled — **named in the ticket** |
| 18 | `verifiable-audit-evidence-ai-driven-systems-veritaschain-2026`, `-1` | "Verifiable Audit Evidence for AI-Driven Systems: VeritasChain Protocol (VCP) v1.0" (on `-1`) | pair; base id null-titled |

**17 of 18 sets** follow the exact same shape: one doc has a real title, its raw-identical twin (an `-N`-suffixed ingestion of the same source) has a **null title**. Per the e/348 criterion this is "weak title agreement" (a null title counts as trivially agreeing with anything), which per SO condition 2 needs a **second signal** (near-equal snapshot text or matching normalized source URL) before it can be auto-marked — it cannot be marked on raw-identity alone. This is almost certainly *why* the t/4337 builder missed all 17: a null-titled ingest gives the title-matching stage nothing to match against, so these pairs never got compared at all. **Set #12** is the one exception — both members have real, title-agreeing text — and is the strongest/cleanest candidate of the 18 for an eventual mark.

## What this does NOT tell you

- **Canonical choice** for each set (which of the 2–3 raw-identical ids should be `duplicate_of` which) is not decided here — that requires applying the SO's e/348 condition 3 (prefer a clean/undamaged, non-truncated snapshot) to each pair, which needs reading each snapshot, not just the raw file.
- **The required "second signal"** for the 17 weak-title pairs (near-equal snapshot or matching source URL) has not been checked here — this is read-only raw-blob identity, not the full e/348 qualification.
- This list has **not** had a second-agent independent recount, which t/4403 (via SO e/348#7/#12, TL-confirmed) explicitly requires before any PI sign-off.

## Reproducing this

```
# ai-triad-sources @ ec7deb133e1d6ceeb4996c2d8e4c5246cd01feb9
git -C <ai-triad-sources> ls-tree -r -l <commit> -- <doc-id>/raw/
```
Substantive-file filter: exclude dotfiles, `Thumbs.db`, `desktop.ini`, size < 1024 bytes. Group by identical sorted blob-SHA set. Exclude any group where a member resolves (via existing `_index.json` `duplicate_of` chains) to a canonical already covered by `scripts/data-mutations/t4405/frozen-t4405-marks.json` or `scripts/data-mutations/t4337/frozen-t4337-marks.json`.
