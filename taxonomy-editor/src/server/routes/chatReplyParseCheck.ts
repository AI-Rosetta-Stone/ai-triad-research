// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/618 (TL p/16#386): catch the intermittent chat reply that doesn't parse with real traffic, not paid test turns.
// On staging 1 of 3 JSON-mode turns failed a strict JSON.parse while finishing normally (t/491#18). After every
// finished chat turn (a normal stop) the server tries the reply the way the product does (renderer
// useChatStore.parseChatResponse): strict JSON first, then with code fences and <think> blocks stripped, then the
// outermost {...}. A strict failure is WARN-logged and counted for /health. Observation only: the reply is sent
// unchanged either way.
//
// t/618 follow-up (TL p/16#434, Quality p/17#79): the WARN carries STRUCTURE ONLY, never reply text. A reply can quote
// the user's own words, and t/579 showed that logs and dumps leave our control. Logged: model, stop reason, JSON mode,
// length, fenced, whether the product parser recovers it, and the parse error's kind (every quoted fragment removed,
// since V8's JSON errors quote the offending input), position, and the class of the character at that position.

import { log } from '../logger.js';

export interface ChatReplyParseCounts {
  /** Finished turns whose reply failed a strict JSON.parse. */
  strictFailures: number;
  /** Of those, the ones that still failed after the product's recovery (fences, <think>, outermost braces). */
  unrecovered: number;
}

const counts: ChatReplyParseCounts = { strictFailures: 0, unrecovered: 0 };

/** The per-process counts for /health (each replica reports its own). */
export function getChatReplyParseCounts(): ChatReplyParseCounts {
  return { ...counts };
}

/** Test seam. */
export function _resetChatReplyParseCountsForTest(): void {
  counts.strictFailures = 0;
  counts.unrecovered = 0;
}

const FENCE = /^\s*```[a-zA-Z]*\s*\n?([\s\S]*?)\n?\s*```\s*$/;
const CONTROL_CHAR = /[\u0000-\u001f]/;

/** The fixed kinds a JSON.parse failure maps to. The engine's message quotes about ten characters of the input, and
 *  that snippet can hold quotes of its own, so no part of the message is ever kept (Quality p/17#85): the message's
 *  own leading words only pick a kind from this closed list. */
const PARSE_ERROR_KINDS: ReadonlyArray<[RegExp, string]> = [
  [/^Unexpected end of JSON input/, 'unexpected_end'],
  [/^Unexpected non-whitespace character after JSON/, 'trailing_characters'],
  [/^Unexpected token/, 'unexpected_token'],
  [/^Unexpected (number|string)/, 'unexpected_value'],
  [/^Unterminated string/, 'unterminated_string'],
  [/^Bad control character/, 'bad_control_character'],
  [/^Bad (escaped character|Unicode escape)/, 'bad_escape'],
  [/^(No number after minus sign|Exponent part is missing a number|Unterminated fractional number)/, 'bad_number'],
  [/^Expected /, 'expected_token'],
];

/** A fixed kind for a JSON.parse error message, and its position when the message ENDS with one. The position is
 *  read only from the message's own tail ("... at position N (line L column C)"), never from the quoted snippet. */
export function parseErrorShape(message: string): { kind: string; position: number | null } {
  const kind = PARSE_ERROR_KINDS.find(([re]) => re.test(message))?.[1] ?? 'other';
  const m = / at position (\d+)(?: \(line \d+ column \d+\))?$/.exec(message);
  return { kind, position: m ? Number(m[1]) : null };
}

/** A coarse class for the character at `i`, never the character itself. */
export function charClass(text: string, i: number | null): string | null {
  if (i === null) return null;
  if (i < 0 || i >= text.length) return 'end';
  const c = text[i];
  if (c === '"' || c === "'") return 'quote';
  if ('{}[]:,'.includes(c)) return 'json-punct';
  if (c === '\\') return 'backslash';
  if (c === '`') return 'backtick';
  if (c === '\n' || c === '\r') return 'newline';
  if (/\s/.test(c)) return 'whitespace';
  if (CONTROL_CHAR.test(c)) return 'control';
  if (/\d/.test(c)) return 'digit';
  if (/[A-Za-z]/.test(c)) return 'letter';
  return 'other';
}

function tryParse(text: string): { ok: true } | { ok: false; error: string } {
  try { JSON.parse(text); return { ok: true }; } catch (err) { /* telemetry — silent by design: a parse failure is the result, reported by the caller */ return { ok: false, error: (err as Error).message }; }
}

/** The product's recovery steps, in order; true when any yields a JSON object. */
function recovers(text: string): boolean {
  const unfenced = FENCE.exec(text)?.[1] ?? text;
  const noThink = unfenced.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  if (tryParse(noThink).ok) return true;
  const first = noThink.indexOf('{');
  const last = noThink.lastIndexOf('}');
  return first !== -1 && last > first && tryParse(noThink.slice(first, last + 1)).ok;
}

export interface FinishedTurn {
  model: string | undefined;
  stopReason: string | null | undefined;
  jsonMode: boolean;
  /** Which server path produced the reply (the Gemini stream or the non-streaming fallback). */
  path: 'gemini-stream' | 'generate';
}

/** Check one finished reply. Never throws, never changes what is sent, never logs reply text. */
export function checkFinishedChatReply(text: string, turn: FinishedTurn): void {
  try {
    const strict = tryParse(text);
    if (strict.ok) return;
    counts.strictFailures++;
    const recovered = recovers(text);
    if (!recovered) counts.unrecovered++;
    const shape = parseErrorShape(strict.error);
    log.server.warn({
      component: 'chat-stream', reason: 'chat-reply-parse-failed', path: turn.path,
      model: turn.model ?? null, stopReason: turn.stopReason ?? null, jsonMode: turn.jsonMode,
      chars: text.length, fenced: FENCE.test(text), recoveredByProductParser: recovered,
      parseErrorKind: shape.kind, parseErrorPosition: shape.position, charClassAtError: charClass(text, shape.position),
    }, `chat-stream: a finished reply failed strict JSON parsing${recovered ? ' (the product parser recovers it)' : ' and the product parser cannot recover it'} (t/618)`);
  } catch (err) {
    log.server.warn({ component: 'chat-stream', err: (err as Error)?.name ?? 'Error' }, 'chat-stream: reply parse check itself failed; skipped (t/618)');
  }
}
