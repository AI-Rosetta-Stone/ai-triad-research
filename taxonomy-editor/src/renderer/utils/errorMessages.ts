import { ActionableError } from '@lib/debate/errors';

/** Which kind of call failed: 'ai' (default) gets model-oriented advice; 'operation' (library
 *  delete/rename/export etc.) gets neutral text that doesn't mention models (t/108). */
export interface MapErrorOptions { kind?: 'ai' | 'operation' }

/**
 * Translate raw error messages into user-friendly, actionable guidance.
 */
export function mapErrorToUserMessage(err: unknown, opts?: MapErrorOptions): string {
  // ActionableError already carries a one-line human-readable `problem`; its `.message` is the full
  // Goal/Error/Location/Resolve block, which must never be surfaced raw to users (t/2491).
  if (err instanceof ActionableError) return actionableErrorText(err, opts);

  const msg = err instanceof Error ? err.message : String(err);
  const errorCode = (err as Record<string, unknown> | null)?.errorCode;

  return (
    classifyContextLengthError(msg, errorCode) ??
    classifyRateLimitError(msg, opts) ??
    classifyServiceOverloadError(msg, opts) ??
    classifyPythonError(msg) ??
    classifyFileNotFoundError(msg) ??
    classifyApiKeyError(msg) ??
    classifyJsonError(msg, opts) ??
    classifyPermissionError(msg) ??
    classifyDiskError(msg) ??
    classifyTimeoutError(msg, opts) ??
    classifyServerError(msg, opts) ??
    classifyConnectionError(msg, err, opts) ??
    (msg.length > 200 ? msg.slice(0, 200) + '...' : msg)
  );
}

// 'operation' calls get neutral text with no model/debate/auto-retry claims (t/108, t/122).
function isOperation(opts: MapErrorOptions | undefined): boolean {
  return opts?.kind === 'operation';
}

const GENERIC_HTTP_TEXT = 'An unexpected error occurred. If this persists, try reloading.';

// A bridge non-2xx carries `httpStatus` and a raw problem ("DELETE /api/chats/x failed with HTTP 429:
// {...}") — map those by status (t/108). Problems the bridge words itself (WRITE_CONFLICT, daily token
// limit, missing API key…) also carry a status but are already user-facing copy, and stay verbatim.
// Matched by the bridge's exact prefix (web-bridge.ts get/mutation/put/patch), not "HTTP <n>"
// anywhere, so a hand-written message that quotes a status isn't remapped (TL p/10#36).
const BRIDGE_RAW_PROBLEM = /^[A-Z]+ \S+ failed with HTTP (\d{3}):/;

function actionableErrorText(err: ActionableError, opts: MapErrorOptions | undefined): string {
  const status = err.httpStatus;
  const raw = BRIDGE_RAW_PROBLEM.exec(err.problem);
  if (typeof status !== 'number' || !raw || Number(raw[1]) !== status) return err.problem;
  return classifyHttpStatus(status, opts);
}

// Reuses the classifiers' own 429/503/529/500/502/504 text so the two paths can't drift (t/108).
// - Bridge errors default to 'operation' unless the caller passes kind 'ai' explicitly: 48 callers pass
//   no kind and many are plain server ops, where AI text would be false (TL p/10#38).
// - 5xx always takes the 'operation' wording, whatever the kind: nothing retries a plain bridge call,
//   so "Retrying automatically" / "Retrying shortly" would be false here (TL p/10#39).
// - 401 is a signed-out session; 403 is a signed-in user without permission (Design t/108#10).
function classifyHttpStatus(status: number, opts: MapErrorOptions | undefined): string {
  if (status === 404) return 'That item no longer exists.';
  if (status === 401) return 'Your session has expired. Sign in again.';
  if (status === 403) return "You don't have permission to do that.";
  const code = String(status);
  const statusOpts: MapErrorOptions = { kind: status < 500 && opts?.kind === 'ai' ? 'ai' : 'operation' };
  return classifyRateLimitError(code, statusOpts) ?? classifyServiceOverloadError(code, statusOpts) ?? classifyServerError(code, statusOpts) ?? GENERIC_HTTP_TEXT;
}

// Context window exceeded — check BEFORE rate-limit since both can mention "RESOURCE_EXHAUSTED"
function classifyContextLengthError(msg: string, errorCode: unknown): string | null {
  if (errorCode === 'context_too_long' || msg.includes('context_too_long') || msg.includes('context window')) {
    return 'Input is too long for this model. Try fewer debate rounds, compress the history, or switch to a model with a larger context window.';
  }
  return null;
}

// API rate limiting — check BEFORE Python errors since chained errors can contain both
function classifyRateLimitError(msg: string, opts: MapErrorOptions | undefined): string | null {
  if (msg.includes('429') || msg.includes('rate limit') || msg.includes('Rate limit')) {
    if (opts?.kind === 'operation') return 'Too many requests. Wait a minute and try again.';
    return 'API rate limited. Wait a minute and try again, or switch to a different model in Settings.';
  }
  return null;
}

// API overloaded
function classifyServiceOverloadError(msg: string, opts: MapErrorOptions | undefined): string | null {
  if (msg.includes('503') || msg.includes('529') || msg.includes('overloaded')) {
    if (isOperation(opts)) return 'The service is busy right now. Try again in a few seconds.';
    return 'AI service is temporarily overloaded. Try again in a few seconds.';
  }
  return null;
}

// Python/embedding issues
function classifyPythonError(msg: string): string | null {
  if (!msg.includes('Python') && !msg.includes('python3') && !msg.includes('python')) return null;
  if (msg.includes('not found') || msg.includes('ENOENT') || msg.includes('not installed')) {
    return 'Python is not installed or not on PATH. Install Python 3.9+ from python.org and run: pip3 install sentence-transformers';
  }
  if (msg.includes('sentence_transformers') || msg.includes('sentence-transformers')) {
    return 'The sentence-transformers package is missing. Run: pip3 install sentence-transformers';
  }
  return `Python error: ${msg.slice(0, 200)}`;
}

// File not found
function classifyFileNotFoundError(msg: string): string | null {
  if (!msg.includes('ENOENT') && !msg.includes('no such file') && !msg.includes('not found')) return null;
  if (msg.includes('embeddings.json')) {
    return 'Embeddings file not found. Run Update-TaxEmbeddings in PowerShell to generate it.';
  }
  if (msg.includes('taxonomy') || msg.includes('Origin')) {
    return 'Taxonomy data not found. Check that the data repository is available and .aitriad.json is configured.';
  }
  return `File not found: ${msg.slice(0, 150)}`;
}

// No API key
function classifyApiKeyError(msg: string): string | null {
  if (msg.includes('No') && msg.includes('API key')) {
    return msg; // Already actionable — pass through
  }
  return null;
}

// JSON parse errors
function classifyJsonError(msg: string, opts: MapErrorOptions | undefined): string | null {
  if (!msg.includes('JSON') && !msg.includes('Unexpected token') && !msg.includes('parse')) return null;
  if (isOperation(opts)) return "The data couldn't be read. Try again, and reload if it keeps happening.";
  if (msg.includes('AI') || msg.includes('response') || msg.includes('generate')) {
    return 'The AI returned an invalid response. Try again — this sometimes happens with complex prompts.';
  }
  return `Data file is corrupted: ${msg.slice(0, 150)}`;
}

// Permission errors
function classifyPermissionError(msg: string): string | null {
  if (msg.includes('EACCES') || msg.includes('permission denied')) {
    return `Permission denied. Check file permissions: ${msg.slice(0, 150)}`;
  }
  return null;
}

// Disk space
function classifyDiskError(msg: string): string | null {
  if (msg.includes('ENOSPC') || msg.includes('disk') || msg.includes('space')) {
    return 'Disk is full. Free up space and try again.';
  }
  return null;
}

// Timeout
function classifyTimeoutError(msg: string, opts: MapErrorOptions | undefined): string | null {
  if (msg.includes('timeout') || msg.includes('ETIMEDOUT') || msg.includes('timed out')) {
    if (isOperation(opts)) return 'The server took too long to respond. Try again.';
    return 'Operation timed out. The AI service may be slow — try again or switch to a faster model.';
  }
  return null;
}

// HTTP 500 / 502 / 504 server and gateway errors (t/2906).
// 500 check is above the generic HTTP guard so it wins; 503/529 already caught above.
function classifyServerError(msg: string, opts: MapErrorOptions | undefined): string | null {
  if (msg.includes('500') || msg.toLowerCase().includes('internal server error')) {
    if (isOperation(opts)) return 'The server ran into a problem. Try again in a moment.';
    return 'The AI service ran into a problem. Retrying automatically — hang tight.';
  }
  if (msg.includes('502') || msg.includes('504') || msg.toLowerCase().includes('bad gateway') || msg.toLowerCase().includes('gateway timeout')) {
    if (isOperation(opts)) return "The server couldn't be reached. Try again in a moment.";
    return 'A gateway error occurred. Retrying shortly.';
  }
  return null;
}

// AbortError / circuit breaker / generic 4xx-5xx not caught above (t/2906).
// Genuine aborts only — user-cancel is intercepted by isCancellationError before this maps.
function classifyConnectionError(msg: string, err: unknown, opts: MapErrorOptions | undefined): string | null {
  if (err instanceof Error && err.name === 'AbortError') {
    if (isOperation(opts)) return 'The connection was interrupted. Try again.';
    return 'Connection interrupted. Retrying…';
  }
  if (msg.toLowerCase().includes('circuit') && msg.toLowerCase().includes('open')) {
    if (isOperation(opts)) return 'The service is temporarily unavailable. Try again in a minute.';
    return 'The service is temporarily unavailable. Your debate is paused — it will resume automatically.';
  }
  // Generic HTTP 4xx/5xx not caught above (400, 401, 422, etc.) — last, so specific
  // guards (429, 500, 502/504, 503) always win over this catch-all (t/2906).
  if (/HTTP [4-5]\d{2}/.test(msg)) return GENERIC_HTTP_TEXT;
  return null;
}
