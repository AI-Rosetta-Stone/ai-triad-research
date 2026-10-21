// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// AI Call Log — TS-originated capture (t/3245; epic t/3235, core t/3241, TL ruling t/3245#3).
//
// The TS counterpart to the PowerShell writer (scripts/AITriad/Private/AICallLog.ps1). It appends
// TS-originated AI calls to the SAME append-only `ai-call-log.jsonl` under the resolved data root, so
// Get-/Show-AICallLog read a UNIFIED PS+TS log. Per TL ruling t/3245#3 the interface is a SCHEMA
// CONTRACT (field names + types), NOT byte-identity with PS `ConvertTo-Json` — the PS reader already
// parses each line as JSON and reads fields by property presence (Get-AICallLog), so JS `JSON.stringify`
// output conforms as long as the 7 field names + types match. Datetime is ISO-8601 ('Z'), which the PS
// reader parses via TryParse(RoundtripKind) regardless of fractional-second precision.
//
// Record schema (7 fields, in order): ID, Datetime, Scenario, PromptID, PromptStart, RetryCount, Status.
//
// Two TL conditions (t/3245#3):
//  1. Schema contract, not serializer-mimicry (above).
//  2. ID is ADVISORY (no reader joins on it) → no cross-process uniqueness coordination. The real
//     integrity guarantee is ATOMIC SINGLE-LINE APPEND: one O_APPEND write per record, record < PIPE_BUF,
//     so a concurrent PS append and a TS append can never interleave a line. Every field is bounded
//     (PromptStart ≤160), so a record is always well under PIPE_BUF (4096 on Linux).
//
// Fail-safe (mirrors the PS writer): an IO error is recorded as a WARN and swallowed — enabling the
// audit log must NEVER break the AI call it audits.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getStateRoot, getApiKeySource, type AIBackend } from '../config.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { BACKEND_KEY_ENV_VARS, GENERIC_FALLBACK_ENV, GENERIC_FALLBACK_BACKEND } from '../../../../lib/ai-client/apiKeyFallback.js';

/** Conservative PIPE_BUF floor (Linux = 4096; POSIX minimum = 512). A single write() of a buffer
 *  below this to an O_APPEND fd is atomic, so concurrent PS+TS appends can't interleave a line. */
const PIPE_BUF = 4096;

/** Max PromptStart length — matches the PS writer's 160-char truncation (schema of record). */
const PROMPT_START_MAX = 160;

/** Bytes read from the file tail to derive the next advisory ID (avoids reading the whole log). */
const TAIL_READ_BYTES = 8192;

/**
 * Classify where an EXPLICIT key came from. Compares the key against known env var values
 * (so a cascade link that passes an env-resolved key explicitly still logs `env:<VAR>`).
 * Only for explicit keys; for internally-resolved keys use `getApiKeySource` in config.ts.
 * If ElectronMain also needs this, extract to lib/ai-client (TL shared-utility rule, t/4088).
 */
export function classifyKeySource(
  key: string,
  backend: string,
  env: Readonly<Record<string, string | undefined>> = process.env as Record<string, string | undefined>,
): string {
  if (!key) return '';
  const backendVars = BACKEND_KEY_ENV_VARS[backend] ?? [`${backend.toUpperCase()}_API_KEY`];
  for (const v of backendVars) {
    if (env[v] === key) return `env:${v}`;
  }
  if (env[GENERIC_FALLBACK_ENV] === key) return `fallback:${GENERIC_FALLBACK_ENV}`;
  return 'explicit';
}

export type ChainLinkComplete = (link: { model: string; backend: string; keySource: string; retryCount: number; status: string }) => void;

// t/4088 (PowerShell, p/567#16): extracted out of aiBackends.ts's generateText so its own
// optional-chain checks for a listener that's usually absent don't count against that
// function's complexity budget. Only resolves a real key source when someone is listening.
export async function resolveChainLinkKeySource(
  onChainLinkComplete: ChainLinkComplete | undefined,
  explicitKeys: string[] | undefined,
  keys: string[],
  backend: AIBackend,
): Promise<string> {
  if (!onChainLinkComplete) return '';
  return explicitKeys !== undefined ? classifyKeySource(keys[0] ?? '', backend) : await getApiKeySource(backend);
}

// t/4088: single call site for the optional chain-link-complete callback — the three fire points
// in generateText's loop (success/abort/failure) become one plain statement each there.
export function emitChainLinkComplete(onChainLinkComplete: ChainLinkComplete | undefined, link: Parameters<ChainLinkComplete>[0]): void {
  onChainLinkComplete?.(link);
}

/** Valid env var names for KeySource — derived from the canonical map (t/4088, Shared Lib e/290#4). */
const VALID_KEYSOURCE_ENV_VARS: ReadonlySet<string> = new Set(
  Object.values(BACKEND_KEY_ENV_VARS).flat(),
);

function isValidKeySource(value: string): boolean {
  if (value === '' || value === 'explicit' || value === `fallback:${GENERIC_FALLBACK_ENV}` ||
      value === 'store' || value === 'keyvault' || value === 'none') return true;
  if (value.startsWith('env:')) return VALID_KEYSOURCE_ENV_VARS.has(value.slice(4));
  return false;
}

/** Validate a KeySource value. Returns it unchanged if valid; writes `''` + WARN if not. */
function normalizeKeySource(value: string): string {
  if (isValidKeySource(value)) return value;
  getGlobalRecorder()?.record({
    type: 'system.error', component: 'ai-call-log', level: 'warn',
    message: `AI call-log: unrecognized KeySource '${value}' — writing '' (closed vocabulary, t/4088)`,
    data: { value },
  });
  return '';
}

export interface AICallLogEntry {
  /** Caller tag (e.g. a UsageID, or Debate/Chat/Fact Check/Logical Form). Never blank in practice. */
  scenario: string;
  /** UsageID from ai-usages.json, or '' when absent. */
  promptId: string;
  /** The rendered prompt; truncated to the first 160 chars on write. */
  promptStart: string;
  /** 0 on the first attempt, N for the Nth retry. */
  retryCount: number;
  /** HTTP/API status (e.g. '200', '429', '500', 'timeout', 'error'). */
  status: string;
  /** The registry id of the model actually called (the serving chain link's model). */
  model: string;
  /** The backend from the registry for that model. Never a prefix guess. */
  backend: string;
  /** Where the key came from. Must be from the closed vocabulary (see tests/fixtures/ai-call-log/README.md). */
  keySource: string;
}

/**
 * Is the AI call log enabled? True iff `AI_CALL_LOG_ENABLED` is truthy (1|true|yes|on, case-insensitive).
 * Default OFF — unset/empty/anything-else → false, so the capture hook is a single early-return with
 * zero overhead. Mirrors the PS `Test-AICallLogEnabled` contract exactly.
 */
export function isAICallLogEnabled(): boolean {
  const v = process.env.AI_CALL_LOG_ENABLED;
  return !!v && /^(1|true|yes|on)$/i.test(v.trim());
}

/** Absolute path to `ai-call-log.jsonl` under the resolved STATE root (t/4372, t/4264: class-A
 *  writable state, never `getDataRoot()` — a staging deployment must not append into prod's
 *  shared data share). `getStateRoot()` falls back to `getDataRoot()` on prod/local/Electron,
 *  where it stays the SAME file the PS writer targets (`Get-DataRoot` ⟷ `getDataRoot()`); only
 *  on staging (`AI_TRIAD_STATE_ROOT` set) does this diverge from the PS desktop writer, which
 *  never runs against a staging container anyway. Parent dir is created lazily on first append. */
export function getAICallLogPath(): string {
  return path.join(getStateRoot(), 'ai-call-log.jsonl');
}

/**
 * Next advisory record ID: last record's ID + 1, else 1 (mirrors PS `Get-AICallLogNextId`). Reads only
 * the file's tail (not the whole log). ID is ADVISORY (t/3245#3) — a concurrent PS/TS append may race to
 * the same value; that's acceptable, no reader joins on ID. A missing/unparseable tail restarts at 1.
 */
function nextAdvisoryId(logPath: string): number {
  // Race-free (no existsSync/statSync check-then-open TOCTOU, js/file-system-race): open the fd FIRST —
  // a fresh/rotated file throws ENOENT, handled silently below — then fstat/read on that same fd only.
  let fd: number | null = null;
  try {
    fd = fs.openSync(logPath, 'r');
    const size = fs.fstatSync(fd).size;
    if (size === 0) return 1;
    const readLen = Math.min(size, TAIL_READ_BYTES);
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, size - readLen);
    const lastLine = buf.toString('utf8').trimEnd().split('\n').pop();
    if (!lastLine) return 1;
    const prev = JSON.parse(lastLine) as { ID?: unknown };
    const prevId = typeof prev.ID === 'number' ? prev.ID : Number(prev.ID);
    return Number.isFinite(prevId) ? prevId + 1 : 1;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return 1; // fresh/rotated file — normal, silent
    // Fallback-path logging: an unreadable/corrupt tail shouldn't wedge the counter — restart at 1 + record why.
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'ai-call-log', level: 'warn',
      message: 'AI call-log: could not read last-line ID — restarting advisory ID at 1',
      data: { logPath, error: err instanceof Error ? err.message : String(err) },
    });
    return 1;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* silent by design — fd already released, nothing to record */ } }
  }
}

/**
 * Append one 7-field JSONL record to the AI call log — a no-op when the flag is off.
 *
 * @param entry  the call metadata (scenario/promptId/promptStart/retryCount/status).
 * @param pathOverride  test/fixture override for the log path (never touches the real data root).
 */
export function writeAICallLogEntry(entry: AICallLogEntry, pathOverride?: string): void {
  if (!isAICallLogEnabled()) return; // default-off: single early-return, zero overhead

  const logPath = pathOverride ?? getAICallLogPath();
  let fd: number | null = null;
  try {
    // recursive mkdir is idempotent (no-op if the dir exists) — no existsSync check-then-create race.
    const dir = path.dirname(logPath);
    if (dir) fs.mkdirSync(dir, { recursive: true });

    const promptStart = entry.promptStart.length > PROMPT_START_MAX
      ? entry.promptStart.slice(0, PROMPT_START_MAX)
      : entry.promptStart;

    // Build in schema order (JS preserves string-key insertion order → JSONL field order matches PS).
    const record = {
      ID: nextAdvisoryId(logPath),
      Datetime: new Date().toISOString(), // ISO-8601 'Z' — PS reader parses via TryParse(RoundtripKind)
      Scenario: entry.scenario,
      PromptID: entry.promptId,
      PromptStart: promptStart,
      RetryCount: entry.retryCount,
      Status: entry.status,
      Model: entry.model,
      Backend: entry.backend,
      KeySource: normalizeKeySource(entry.keySource),
    };

    // Atomic single-line append (t/3245#3 condition 2): one O_APPEND write of a sub-PIPE_BUF buffer so a
    // concurrent PS append can't interleave. Bounded fields keep the record well under PIPE_BUF; if a
    // pathological record ever exceeded it we still write (best-effort) but note the lost guarantee.
    const line = Buffer.from(JSON.stringify(record) + '\n', 'utf8');
    if (line.length >= PIPE_BUF) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'ai-call-log', level: 'warn',
        message: 'AI call-log record exceeds PIPE_BUF — atomic-append guarantee not held for this line',
        data: { bytes: line.length, pipeBuf: PIPE_BUF, scenario: entry.scenario },
      });
    }
    fd = fs.openSync(logPath, 'a'); // 'a' → O_APPEND on POSIX
    // js/http-to-file-access: writing request-derived data (PromptStart) to the audit log is the
    // TL-approved feature itself (t/3245#3) — the PS writer does the identical thing. Injection is
    // prevented: the whole record is one JSON.stringify line (escapes newlines/control chars, so a
    // crafted prompt cannot forge a second JSONL line), PromptStart is truncated to 160 chars, and the
    // path is a fixed constant (getAICallLogPath), never derived from the data. No harm sink remains.
    fs.writeSync(fd, line); // codeql[js/http-to-file-access]
  } catch (err) {
    // Fail-safe (t/3235#1, Fallback-Path Logging): audit logging must never break the call it audits.
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'ai-call-log', level: 'warn',
      message: 'AI call-log append failed — continuing (audit log is non-fatal)',
      data: { logPath, error: err instanceof Error ? err.message : String(err) },
    });
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* silent by design — fd already released, nothing to record */ } }
  }
}
