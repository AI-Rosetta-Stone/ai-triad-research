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
    expect(f.parseErrorKind).toBe('bad_control_character');
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

  it('parseErrorShape keeps nothing of the message: a fixed kind only; charClass never returns the character', async () => {
    const { parseErrorShape, charClass } = await import('../routes/chatReplyParseCheck.js');
    const s = parseErrorShape(`Unexpected token 'M', "MARKER-7f3a is not json" is not valid JSON`);
    expect(s).toEqual({ kind: 'unexpected_token', position: null });
    expect(parseErrorShape('Bad control character in string literal in JSON at position 21 (line 1 column 22)')).toEqual({ kind: 'bad_control_character', position: 21 });
    // Quality p/17#85: the quoted snippet holds quotes of its own, which mis-paired the old quoted-span regexes and
    // left reply words behind. Also a snippet that itself says "position 99" must not be read as the position.
    const inner = parseErrorShape(`Unexpected token 'r', ..."a "reply" 're' at position 99 MARKER-7f3a"... is not valid JSON`);
    expect(inner).toEqual({ kind: 'unexpected_token', position: null });
    expect(parseErrorShape('Some future engine message quoting MARKER-7f3a')).toEqual({ kind: 'other', position: null });
    expect(['quote', 'json-punct', 'backslash', 'backtick', 'newline', 'whitespace', 'control', 'digit', 'letter', 'other', 'end', null])
      .toEqual(expect.arrayContaining([charClass('é', 0), charClass('x', 5), charClass('x', null)]));
    expect(charClass('a{', 1)).toBe('json-punct');
  });

  // TL p/16#453: structure only. Whatever the reply holds, and wherever the engine's message quotes it, no marker
  // from the reply reaches the WARN, and the kind is one of the fixed labels.
  it('a reply containing a marker never appears in the WARN, with quotes around and inside the failing spot', () => {
    const M = 'MARKER-7f3a';
    const KINDS = ['unexpected_end', 'trailing_characters', 'unexpected_token', 'unexpected_value', 'unterminated_string', 'bad_control_character', 'bad_escape', 'bad_number', 'expected_token', 'other'];
    const replies = [
      `${M} "quoted ${M}" 'and ${M}' is not json`,
      `{"response": "${M}" "${M}" '${M}'}`,
      `{"a":"${M}"} ${M} "${M}"`,
      `{"response":"${M}\n${M}"}`,
      `{"response":"${M}`,
      `{"response":"\\q${M}"}`,
      `{"n":-${M}}`,
      `"${M}' "re" 'reply' ${M}`,
      `{'${M}': "${M}"}`,
    ];
    for (const reply of replies) {
      h.warn.mockClear();
      checkFinishedChatReply(reply, TURN);
      expect(h.warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(h.warn.mock.calls)).not.toContain('MARKER');
      expect(JSON.stringify(h.warn.mock.calls)).not.toContain('7f3a');
      expect(KINDS).toContain(fields().parseErrorKind);
    }
  });

  it('never throws, even on a pathological input', () => {
    expect(() => checkFinishedChatReply(undefined as unknown as string, TURN)).not.toThrow();
  });
});
