import { ActionableError } from '@lib/debate/errors';

/**
 * Translate raw error messages into user-friendly, actionable guidance.
 */
export function mapErrorToUserMessage(err: unknown): string {
  // ActionableError already carries a one-line human-readable `problem`; its `.message` is the full
  // Goal/Error/Location/Resolve block, which must never be surfaced raw to users (t/2491).
  if (err instanceof ActionableError) return err.problem;

  const msg = err instanceof Error ? err.message : String(err);
  const errorCode = (err as Record<string, unknown> | null)?.errorCode;

  return (
    classifyContextLengthError(msg, errorCode) ??
    classifyRateLimitError(msg) ??
    classifyServiceOverloadError(msg) ??
    classifyPythonError(msg) ??
    classifyFileNotFoundError(msg) ??
    classifyApiKeyError(msg) ??
    classifyJsonError(msg) ??
    classifyPermissionError(msg) ??
    classifyDiskError(msg) ??
    classifyTimeoutError(msg) ??
    classifyServerError(msg) ??
    classifyConnectionError(msg, err) ??
    (msg.length > 200 ? msg.slice(0, 200) + '...' : msg)
  );
}

// Context window exceeded — check BEFORE rate-limit since both can mention "RESOURCE_EXHAUSTED"
function classifyContextLengthError(msg: string, errorCode: unknown): string | null {
  if (errorCode === 'context_too_long' || msg.includes('context_too_long') || msg.includes('context window')) {
    return 'Input is too long for this model. Try fewer debate rounds, compress the history, or switch to a model with a larger context window.';
  }
  return null;
}

// API rate limiting — check BEFORE Python errors since chained errors can contain both
function classifyRateLimitError(msg: string): string | null {
  if (msg.includes('429') || msg.includes('rate limit') || msg.includes('Rate limit')) {
    return 'API rate limited. Wait a minute and try again, or switch to a different model in Settings.';
  }
  return null;
}

// API overloaded
function classifyServiceOverloadError(msg: string): string | null {
  if (msg.includes('503') || msg.includes('529') || msg.includes('overloaded')) {
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
function classifyJsonError(msg: string): string | null {
  if (!msg.includes('JSON') && !msg.includes('Unexpected token') && !msg.includes('parse')) return null;
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
function classifyTimeoutError(msg: string): string | null {
  if (msg.includes('timeout') || msg.includes('ETIMEDOUT') || msg.includes('timed out')) {
    return 'Operation timed out. The AI service may be slow — try again or switch to a faster model.';
  }
  return null;
}

// HTTP 500 / 502 / 504 server and gateway errors (t/2906).
// 500 check is above the generic HTTP guard so it wins; 503/529 already caught above.
function classifyServerError(msg: string): string | null {
  if (msg.includes('500') || msg.toLowerCase().includes('internal server error')) {
    return 'The AI service ran into a problem. Retrying automatically — hang tight.';
  }
  if (msg.includes('502') || msg.includes('504') || msg.toLowerCase().includes('bad gateway') || msg.toLowerCase().includes('gateway timeout')) {
    return 'A gateway error occurred. Retrying shortly.';
  }
  return null;
}

// AbortError / circuit breaker / generic 4xx-5xx not caught above (t/2906).
// Genuine aborts only — user-cancel is intercepted by isCancellationError before this maps.
function classifyConnectionError(msg: string, err: unknown): string | null {
  if (err instanceof Error && err.name === 'AbortError') {
    return 'Connection interrupted. Retrying…';
  }
  if (msg.toLowerCase().includes('circuit') && msg.toLowerCase().includes('open')) {
    return 'The service is temporarily unavailable. Your debate is paused — it will resume automatically.';
  }
  // Generic HTTP 4xx/5xx not caught above (400, 401, 422, etc.) — last, so specific
  // guards (429, 500, 502/504, 503) always win over this catch-all (t/2906).
  if (/HTTP [4-5]\d{2}/.test(msg)) {
    return 'An unexpected error occurred. If this persists, try reloading.';
  }
  return null;
}
