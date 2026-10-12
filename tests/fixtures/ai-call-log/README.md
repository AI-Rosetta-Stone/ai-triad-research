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
