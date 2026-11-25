// @vitest-environment node
// t/618 (TL p/16#386): a finished chat reply that fails strict JSON parsing is WARN-logged (model, stop reason, JSON
// mode, length, fenced, parse error, first and last 40 characters only) and counted for /health. Observation only.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../logger.js', () => ({ log: { server: { info: vi.fn(), warn: h.warn, error: vi.fn(), debug: vi.fn() } } }));

import { checkFinishedChatReply, getChatReplyParseCounts, _resetChatReplyParseCountsForTest } from '../routes/chatReplyParseCheck.js';

const TURN = { model: 'gemini-3.5-flash-lite', stopReason: 'stop', jsonMode: true, path: 'gemini-stream' as const };
const fields = () => h.warn.mock.calls[0][0] as Record<string, unknown>;

beforeEach(() => { h.warn.mockClear(); _resetChatReplyParseCountsForTest(); });

describe('t/618: finished chat reply parse check', () => {
  it('valid JSON: no WARN, no count', () => {
    checkFinishedChatReply('{"response":"hi","taxonomy_refs":[]}', TURN);
    expect(h.warn).not.toHaveBeenCalled();
    expect(getChatReplyParseCounts()).toEqual({ strictFailures: 0, unrecovered: 0 });
  });

  it('fenced JSON: a strict failure the product parser recovers (fenced: true, recovered: true)', () => {
    checkFinishedChatReply('```json\n{"response":"hi","taxonomy_refs":[]}\n```', TURN);
    expect(getChatReplyParseCounts()).toEqual({ strictFailures: 1, unrecovered: 0 });
    expect(fields()).toMatchObject({ reason: 'chat-reply-parse-failed', fenced: true, recoveredByProductParser: true, model: 'gemini-3.5-flash-lite', stopReason: 'stop', jsonMode: true });
  });

  it('JSON wrapped in prose: recovered via the outermost braces', () => {
    checkFinishedChatReply('Here you go: {"response":"hi"} hope that helps', TURN);
    expect(getChatReplyParseCounts()).toEqual({ strictFailures: 1, unrecovered: 0 });
    expect(fields()).toMatchObject({ fenced: false, recoveredByProductParser: true });
  });

  it('a raw newline inside the response string (t/167#30): unrecovered, counted, with the parse error', () => {
    checkFinishedChatReply('{"response":"line one\nline two","taxonomy_refs":[]}', TURN);
    expect(getChatReplyParseCounts()).toEqual({ strictFailures: 1, unrecovered: 1 });
    expect(String(fields().parseError)).toMatch(/JSON|control character|position/i);
  });

  it('logs only the first and last 40 characters of the reply, never the middle', () => {
    const middle = 'SECRET-MIDDLE-CONTENT-'.repeat(20);
    const reply = `${'A'.repeat(40)}${middle}${'Z'.repeat(40)}`;
    checkFinishedChatReply(reply, TURN);
    const f = fields();
    expect(f.head).toBe('A'.repeat(40));
    expect(f.tail).toBe('Z'.repeat(40));
    expect(f.chars).toBe(reply.length);
    expect(JSON.stringify(h.warn.mock.calls)).not.toContain('SECRET-MIDDLE');
  });

  it('never throws, even on a pathological input', () => {
    expect(() => checkFinishedChatReply(undefined as unknown as string, TURN)).not.toThrow();
  });
});
