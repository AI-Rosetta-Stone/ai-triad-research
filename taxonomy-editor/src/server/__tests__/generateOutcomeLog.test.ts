// @vitest-environment node
//
// t/4410 sizing — one stdout line per generate chain-link outcome: model, tokens, and for a 429 the
// exhausted quota (RPM / TPM / RPD), so prod data can say which free-tier limit binds.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { infoMock, warnMock } = vi.hoisted(() => ({ infoMock: vi.fn(), warnMock: vi.fn() }));
vi.mock('../logger.js', () => ({ log: { api: { info: infoMock, warn: warnMock, error: vi.fn() } } }));

import { classify429, logGenerateOutcome } from '../ai/generateOutcomeLog.js';

beforeEach(() => { infoMock.mockClear(); warnMock.mockClear(); });

const gemini429 = (quotaId: string) => new Error(
  `Gemini 429: {"error":{"code":429,"status":"RESOURCE_EXHAUSTED","details":[{"violations":[{"quotaId":"${quotaId}"}]}]}}`,
);

describe('t/4410 — classify429', () => {
  it('per-minute request quota → rpm', () => {
    expect(classify429(gemini429('GenerateRequestsPerMinutePerProjectPerModel-FreeTier')))
      .toEqual({ cause: 'rpm', quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' });
  });
  it('per-minute token quota → tpm', () => {
    expect(classify429(gemini429('GenerateContentInputTokensPerModelPerMinute-FreeTier')).cause).toBe('tpm');
  });
  it('per-day quota → rpd', () => {
    expect(classify429(gemini429('GenerateRequestsPerDayPerProjectPerModel-FreeTier')).cause).toBe('rpd');
  });
  it('a 429 with no quota id → unclassified', () => {
    expect(classify429(new Error('429 Too Many Requests'))).toEqual({ cause: 'unclassified' });
  });
});

describe('t/4410 — logGenerateOutcome', () => {
  it('success: INFO under component:api with model and token counts', () => {
    logGenerateOutcome({ model: 'gemini-2.5-flash', backend: 'gemini', retryCount: 0, tokenUsage: { inputTokens: 1200, outputTokens: 340 } });
    expect(infoMock).toHaveBeenCalledWith(expect.objectContaining({
      component: 'api', subsystem: 'ai-generate', outcome: 'ok', model: 'gemini-2.5-flash', inputTokens: 1200, outputTokens: 340,
    }), 'generate outcome');
  });
  it('success with no usage reported: token fields are null, not missing', () => {
    logGenerateOutcome({ model: 'm', backend: 'gemini', retryCount: 0 });
    expect(infoMock).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: null, outputTokens: null }), 'generate outcome');
  });
  it('429: WARN, outcome rate_limited, with the quota cause', () => {
    logGenerateOutcome({ model: 'm', backend: 'gemini', retryCount: 3, err: gemini429('GenerateRequestsPerMinutePerProjectPerModel-FreeTier') });
    expect(warnMock).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'rate_limited', cause: 'rpm', retryCount: 3 }), 'generate outcome');
  });
  it('a non-429 failure: WARN, outcome error, no cause field', () => {
    logGenerateOutcome({ model: 'm', backend: 'gemini', retryCount: 0, err: new Error('503 Service Unavailable') });
    const [fields] = warnMock.mock.calls[0];
    expect(fields).toMatchObject({ outcome: 'error' });
    expect(fields).not.toHaveProperty('cause');
  });
  it('never logs the error message itself (it can echo prompt fragments)', () => {
    logGenerateOutcome({ model: 'm', backend: 'gemini', retryCount: 0, err: new Error('400 bad request: PROMPT-FRAGMENT-xyz') });
    expect(JSON.stringify(warnMock.mock.calls[0])).not.toContain('PROMPT-FRAGMENT-xyz');
  });
});
