# AI call log: record contract

This is the single contract for every writer of `ai-call-log.jsonl`. It was ruled by the TL in t/3245#3 and extended by t/4088 (TL sign-off t/4088#3). The writers are:

| Writer | File | Owner |
|---|---|---|
| PowerShell | `scripts/AITriad/Private/AICallLog.ps1` (`Write-AICallLogEntry`) | PowerShell |
| TS server | `taxonomy-editor/src/server/ai/aiCallLog.ts` | ServerAPI |
| TS Electron main | `taxonomy-editor/src/main/aiCallLog.ts` | ElectronMain |

Every writer appends one compact JSON object per line to the same file, with the fields **in this order**:

| # | Field | Type | Value |
|---|---|---|---|
| 1 | `ID` | int | monotonic within the file |
| 2 | `Datetime` | string | UTC, ISO-8601 round-trip |
| 3 | `Scenario` | string | caller tag (Debate, Chat, …), or `''` |
| 4 | `PromptID` | string | UsageID from `ai-usages.json`, or `''` |
| 5 | `PromptStart` | string | first 160 characters of the rendered prompt |
| 6 | `RetryCount` | int | 0 for the first attempt, N for the Nth retry |
| 7 | `Status` | string | HTTP/API status (`200`, `429`, `error`, …) |
| 8 | `Model` | string | the registry id **actually called**; each cascade link logs its own |
| 9 | `Backend` | string | the `ai-models.json` backend of that model, from the registry and never guessed from the id |
| 10 | `KeySource` | string | **where** the key came from, from the closed vocabulary below |

Readers read fields **by presence**. A line written before t/4088 has only fields 1–7, and readers treat 8–10 as `''`.

### Optional token fields (t/107)

A writer **may** append these after field 10, in this order, and only when the provider reported usage for the call:

| # | Field | Type | Value |
|---|---|---|---|
| 11 | `InputTokens` | int | **all** billed input tokens, **including** the cached-read and cache-write subsets below |
| 12 | `OutputTokens` | int | **all** billed output tokens, **including** thinking/reasoning tokens |
| 13 | `CachedInputTokens` | int | the cache-read subset of `InputTokens` (billed at `cachedInputPer1M`). Gemini: `cachedContentTokenCount`, which Gemini omits on a cache miss, so a Gemini line carries `0` then. Claude: `cache_read_input_tokens`, when present. |
| 14 | `CacheCreationInputTokens` | int | the cache-write subset of `InputTokens` (Claude `cache_creation_input_tokens`, when present). Billed above the input rate; `ai-models.json` stores **no** cache-write price, so a pricing reader must not price a non-zero value at the input rate. |

This log is a **budget guard** (t/106), so every billed token class is counted, in **one convention across backends**:
- **Input:** price as `(InputTokens − CachedInputTokens − CacheCreationInputTokens) × input + CachedInputTokens × cachedInput + CacheCreationInputTokens × cacheWrite`. The writer normalises each backend to it: Gemini's `promptTokenCount` already includes cached tokens; Claude's `input_tokens` excludes cache reads and writes, so they're added back.
- **Output:** Gemini's `thoughtsTokenCount` (billed at the output rate, reported apart from `candidatesTokenCount`) is added in. Claude, OpenAI and the chat-completions backends already include thinking/reasoning in their output count.
- OpenAI-style backends don't report a cached split here, so their cached input prices at the full input rate. That over-counts, which is the safe direction for a guard.
- `InputTokens` and `OutputTokens` are written together or not at all. The two cache fields only appear alongside them.
- **A missing token field means "unknown", never 0.** A call that reported no usage (including a blocked or empty response whose envelope couldn't be parsed) is written without the fields. The PowerShell writer WARNs on a `200` without usage, so a spend reader can tell "no spend source" from "free"; t/106 fails closed on it.
- The PowerShell writer emits them (`Write-AICallLogEntry`, fed from `Invoke-AIApi`'s parsed usage). The TS writers don't, and are unaffected; every reader must accept a line with or without them. `token-fields.jsonl` holds reader cases for both.

## `KeySource`: closed vocabulary

`KeySource` records where the key came from. **It never records the key, or any part of it.**

| Value | Meaning |
|---|---|
| `explicit` | the caller passed a key that is not the value of any named variable |
| `env:<VAR>` | the backend's own named variable. `<VAR>` must be one of: `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `CLAUDE_API_KEY`, `GROQ_API_KEY`, `OPENAI_API_KEY`, `AZURE_OPENAI_API_KEY`, `ZAI_API_KEY`, `MOONSHOT_API_KEY`, `XAI_API_KEY`, `DEEPSEEK_API_KEY` |
| `fallback:AI_API_KEY` | the generic fallback; only ever for gemini (t/4102) |
| `store` | the local key store file (TS server) |
| `keyvault` | Azure Key Vault (TS server) |
| `none` | a keyless backend (local Ollama) |
| `''` | unknown |

**A writer that cannot map its source to one of these values writes `''` and emits a WARN.** It never writes a free-form string, because a free-form value is where a key fragment could leak in (TL t/4088#3).

When an explicit key's value equals the backend's own named variable, writers log `env:<VAR>`, not `explicit`. That is how a cascade passes each fallback link its env-resolved key.

## `conformance.jsonl`

Each line is a record every writer must be able to **produce**, and every reader must **parse and round-trip** unchanged (same fields, same order, same values). The TS writer PRs build a test against this file.

| Line | Case |
|---|---|
| 1 | success, `env:GEMINI_API_KEY` |
| 2 | a 429 retry, `env:ANTHROPIC_API_KEY` |
| 3 | a cascade fallback link on a different model and backend, `env:GROQ_API_KEY` |
| 4 | `fallback:AI_API_KEY` (gemini only) |
| 5 | `explicit` |
| 6 | `store` |
| 7 | `keyvault` |
| 8 | `none` (local Ollama) |
| 9 | unknown source, so `''` |
| 10 | a **legacy** 7-field line written before t/4088; readers must accept it, and `Model`, `Backend` and `KeySource` read as `''` |

Line 10 is a reader case only. New writers always emit all 10 fields.

`conformance.jsonl` stays at these 10 lines: the TS writer tests count its writer lines.

## `token-fields.jsonl` (t/107)

Reader cases for the optional token fields, kept out of `conformance.jsonl` so the TS writer tests (which don't emit tokens) are untouched.

| Line | Case |
|---|---|
| 1 | success with `InputTokens` + `OutputTokens` (claude: no cached count) |
| 2 | success with all three, including `CachedInputTokens` (gemini) |
| 3 | success **without** token fields (the provider reported no usage): tokens read as absent, not 0 |
| 4 | a failed call (`429`), no token fields |
| 5 | Claude with prompt caching: `InputTokens` includes both cache subsets; `CachedInputTokens` + `CacheCreationInputTokens` |
