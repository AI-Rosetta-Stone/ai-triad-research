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

  it('a raw newline inside the response string (t/167#30): unrecovered, counted, with the error kind, position and character class', () => {
    checkFinishedChatReply('{"response":"line one\nline two","taxonomy_refs":[]}', TURN);
    expect(getChatReplyParseCounts()).toEqual({ strictFailures: 1, unrecovered: 1 });
    const f = fields();
    expect(String(f.parseErrorKind)).toMatch(/JSON|control character|position/i);
    expect(f.parseErrorPosition).toBe(21);
    expect(f.charClassAtError).toBe('newline');
  });

  // t/618 follow-up (TL p/16#434): structure only. A marker anywhere in the reply, at its start, middle, end or the
  // parse-error position (which V8 quotes in its message), never reaches the WARN.
  it('never logs reply text: a marker at the start, middle, end or error position is absent from the WARN', () => {
    const M = 'MARKER-7f3a';
    for (const reply of [
      `${M} is not json at all`,
      `{"response":"ok ${M} ok",${M}}`,
      `prefix text then ${M}`,
      `{"response":"${M}\nraw newline ${M}"}`,
      `Here is ${M}: {"response":"${M}"} and more ${M}`,
    ]) {
      h.warn.mockClear();
      checkFinishedChatReply(reply, TURN);
      expect(h.warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(h.warn.mock.calls)).not.toContain(M);
      const f = fields();
      expect(f).not.toHaveProperty('head');
      expect(f).not.toHaveProperty('tail');
      expect(f).not.toHaveProperty('parseError');
      expect(f.chars).toBe(reply.length);
    }
  });

  it('parseErrorShape strips every quoted fragment from a V8 message; charClass never returns the character', async () => {
    const { parseErrorShape, charClass } = await import('../routes/chatReplyParseCheck.js');
    const s = parseErrorShape(`Unexpected token 'M', "MARKER-7f3a is not json" is not valid JSON`);
    expect(s.kind).toBe(`Unexpected token <token>, <input> is not valid JSON`);
    expect(parseErrorShape('Bad control character in string literal in JSON at position 21 (line 1 column 22)').position).toBe(21);
    expect(['quote', 'json-punct', 'backslash', 'backtick', 'newline', 'whitespace', 'control', 'digit', 'letter', 'other', 'end', null])
      .toEqual(expect.arrayContaining([charClass('é', 0), charClass('x', 5), charClass('x', null)]));
    expect(charClass('a{', 1)).toBe('json-punct');
  });

  it('never throws, even on a pathological input', () => {
    expect(() => checkFinishedChatReply(undefined as unknown as string, TURN)).not.toThrow();
  });
});
