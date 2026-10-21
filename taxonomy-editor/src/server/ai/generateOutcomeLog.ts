// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4410 sizing (Azure p/806#31, TL p/806#32): model, token counts and the 429 cause per generate
// call reached only the flight recorder, so prod data couldn't say which free-tier limit binds
// (RPM, TPM or RPD) or how many tokens a debate spends. One stdout line per chain-link outcome.
// Emitted under component:'api' — the component proven to reach Log Analytics (t/3246).
// Never logs prompt text, response text or keys.

import { log } from '../logger.js';
import { is429Error } from './providerErrors.js';

export type QuotaCause = 'rpm' | 'tpm' | 'rpd' | 'unclassified';

/** Gemini's 429 body names the exhausted quota, e.g. `GenerateRequestsPerMinutePerProjectPerModel-FreeTier`,
 *  `GenerateContentInputTokensPerModelPerMinute-FreeTier`, `GenerateRequestsPerDayPerProjectPerModel-FreeTier`.
 *  Returns the cause plus the quota-id token itself (an identifier, not sensitive) when present. */
export function classify429(err: unknown): { cause: QuotaCause; quotaId?: string } {
  const s = String((err as Error)?.message ?? err);
  const quotaId = s.match(/\b[A-Za-z]*(?:PerMinute|PerDay)[A-Za-z]*(?:-[A-Za-z]+)?\b/)?.[0];
  if (!quotaId) return { cause: 'unclassified' };
  if (/PerDay/.test(quotaId)) return { cause: 'rpd', quotaId };
  if (/Token/i.test(quotaId)) return { cause: 'tpm', quotaId };
  return { cause: 'rpm', quotaId };
}

export interface GenerateOutcome {
  model: string;
  backend: string;
  retryCount: number;
  /** aiBackends.ts's mapped TokenUsage; undefined when the provider reported none. */
  tokenUsage?: { inputTokens: number; outputTokens: number };
  err?: unknown;
}

export function logGenerateOutcome(o: GenerateOutcome): void {
  const base = { component: 'api', subsystem: 'ai-generate', model: o.model, backend: o.backend, retryCount: o.retryCount };
  if (o.err === undefined) {
    log.api.info({
      ...base, outcome: 'ok',
      inputTokens: o.tokenUsage?.inputTokens ?? null, outputTokens: o.tokenUsage?.outputTokens ?? null,
    }, 'generate outcome');
    return;
  }
  const rateLimited = is429Error(o.err);
  log.api.warn({
    ...base,
    outcome: rateLimited ? 'rate_limited' : 'error',
    ...(rateLimited ? classify429(o.err) : {}),
  }, 'generate outcome');
}
