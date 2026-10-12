// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// AI Call Log — main-process writer (t/3288; mirrors src/server/ai/aiCallLog.ts).
//
// The main-process counterpart to the server TS writer (src/server/ai/aiCallLog.ts) and the
// PowerShell writer (scripts/AITriad/Private/AICallLog.ps1). Appends main-process AI calls
// (Electron debate path via electronAIAdapter → generateText) to the SAME append-only
// `ai-call-log.jsonl` under the resolved data root so Get-/Show-AICallLog read a UNIFIED log.
//
// Identical contract to the server writer (t/3241#6): same PIPE_BUF atomic-append guarantee, same
// fail-safe (IO errors are WARN-recorded and swallowed — audit log must NEVER break the call it
// audits). The only difference from the server copy is the data-root import: this uses
// getDataRootPath() from main/fileIO rather than getDataRoot() from server/config.
//
// t/4088: Model, Backend and KeySource were added after Status (fields 8-10). Contract artifact:
// tests/fixtures/ai-call-log/README.md, shared with the PS writer and the TS server writer.
// KeySource is a CLOSED vocabulary (never the key, or any part of it) — an unmappable value is
// written as '' with a WARN, never as free text (TL t/4088#3). The known env:<VAR> names are
// BACKEND_KEY_ENV_VARS's values, so this can't drift from lib/ai-client's own key-routing rules.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getDataRootPath } from './fileIO.js';
import { getGlobalRecorder } from '../../../lib/flight-recorder/index.js';
import { BACKEND_KEY_ENV_VARS } from '../../../lib/ai-client/apiKeyFallback.js';

/** Conservative PIPE_BUF floor (Linux = 4096; POSIX minimum = 512). A single write() of a buffer
 *  below this to an O_APPEND fd is atomic, so concurrent PS+TS appends can't interleave a line. */
const PIPE_BUF = 4096;

/** Max PromptStart length — matches the PS writer's 160-char truncation (schema of record). */
const PROMPT_START_MAX = 160;

/** Bytes read from the file tail to derive the next advisory ID (avoids reading the whole log). */
const TAIL_READ_BYTES = 8192;

/** Every backend's own key variable, flattened — the only names a valid `env:<VAR>` may name. */
const KNOWN_KEY_VARS: ReadonlySet<string> = new Set(Object.values(BACKEND_KEY_ENV_VARS).flat());

/** True when `value` is in the closed KeySource vocabulary (t/4088): '' (unknown), explicit,
 *  fallback:AI_API_KEY, store, keyvault, none, or env:<a known backend key variable>. */
function isValidKeySource(value: string): boolean {
  if (value === '' || value === 'explicit' || value === 'fallback:AI_API_KEY' || value === 'store' || value === 'keyvault' || value === 'none') {
    return true;
  }
  const m = /^env:([A-Z][A-Z0-9_]*)$/.exec(value);
  return !!m && KNOWN_KEY_VARS.has(m[1]);
}

export interface AICallLogEntry {
  /** Caller tag (Debate / Chat / Fact Check / Logical Form). */
  scenario: string;
  /** UsageID from ai-usages.json, or '' when absent. */
  promptId: string;
  /** The rendered prompt; truncated to the first 160 chars on write. */
  promptStart: string;
  /** 0 on the first attempt, N for the Nth retry. */
  retryCount: number;
  /** HTTP/API status (e.g. '200', '429', '500', 'timeout', 'error'). */
  status: string;
  /** The registry id actually called (t/4088). Defaults to '' (pre-t/4088 callers). */
  model?: string;
  /** The `ai-models.json` backend of `model`, from the registry — never guessed from the id (t/4088). */
  backend?: string;
  /** Where the key came from — closed vocabulary (t/4088); an unmappable value is written as ''
   *  with a WARN, never as free text. */
  keySource?: string;
}

/**
 * Is the AI call log enabled? True iff `AI_CALL_LOG_ENABLED` is truthy (1|true|yes|on).
 * Default OFF — mirrors the PS `Test-AICallLogEnabled` contract exactly.
 */
export function isAICallLogEnabled(): boolean {
  const v = process.env.AI_CALL_LOG_ENABLED;
  return !!v && /^(1|true|yes|on)$/i.test(v.trim());
}

/** Absolute path to `ai-call-log.jsonl` under the resolved data root. */
export function getAICallLogPath(): string {
  return path.join(getDataRootPath(), 'ai-call-log.jsonl');
}

function nextAdvisoryId(logPath: string): number {
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
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return 1;
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'ai-call-log', level: 'warn',
      message: 'AI call-log (main): could not read last-line ID — restarting advisory ID at 1',
      data: { logPath, error: err instanceof Error ? err.message : String(err) },
    });
    return 1;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* silent by design — fd already released */ } }
  }
}

/**
 * Append one 10-field JSONL record to the AI call log — a no-op when the flag is off.
 * Fail-safe: IO errors are WARN-recorded and swallowed (audit log must never break the call it audits).
 */
export function writeAICallLogEntry(entry: AICallLogEntry, pathOverride?: string): void {
  if (!isAICallLogEnabled()) return;

  const logPath = pathOverride ?? getAICallLogPath();
  let fd: number | null = null;
  try {
    const dir = path.dirname(logPath);
    if (dir) fs.mkdirSync(dir, { recursive: true });

    const promptStart = entry.promptStart.length > PROMPT_START_MAX
      ? entry.promptStart.slice(0, PROMPT_START_MAX)
      : entry.promptStart;

    let keySource = entry.keySource ?? '';
    if (!isValidKeySource(keySource)) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'ai-call-log', level: 'warn',
        message: "AI call-log (main): KeySource is not in the closed vocabulary (tests/fixtures/ai-call-log/README.md); writing '' instead (t/4088)",
      });
      keySource = '';
    }

    const record = {
      ID: nextAdvisoryId(logPath),
      Datetime: new Date().toISOString(),
      Scenario: entry.scenario,
      PromptID: entry.promptId,
      PromptStart: promptStart,
      RetryCount: entry.retryCount,
      Status: entry.status,
      Model: entry.model ?? '',
      Backend: entry.backend ?? '',
      KeySource: keySource,
    };

    const line = Buffer.from(JSON.stringify(record) + '\n', 'utf8');
    if (line.length >= PIPE_BUF) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'ai-call-log', level: 'warn',
        message: 'AI call-log (main) record exceeds PIPE_BUF — atomic-append guarantee not held for this line',
        data: { bytes: line.length, pipeBuf: PIPE_BUF, scenario: entry.scenario },
      });
    }
    fd = fs.openSync(logPath, 'a');
    fs.writeSync(fd, line); // codeql[js/http-to-file-access] -- PromptStart is truncated to 160 chars, JSON.stringify escapes newlines (no JSONL injection), path is fixed constant
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'ai-call-log', level: 'warn',
      message: 'AI call-log (main) append failed — continuing (audit log is non-fatal)',
      data: { logPath, error: err instanceof Error ? err.message : String(err) },
    });
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* silent by design — fd already released */ } }
  }
}
