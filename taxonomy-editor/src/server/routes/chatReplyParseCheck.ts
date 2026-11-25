// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/618 (TL p/16#386): catch the intermittent chat reply that doesn't parse with real traffic, not paid test turns.
// On staging 1 of 3 JSON-mode turns failed a strict JSON.parse while finishing normally (t/491#18). After every
// finished chat turn (a normal stop) the server tries the reply the way the product does (renderer
// useChatStore.parseChatResponse): strict JSON first, then with code fences and <think> blocks stripped, then the
// outermost {...}. A strict failure is WARN-logged with the model, the stop reason, JSON mode, the length, whether it
// was fenced, the parse error, and the first and last 40 characters only (no other content), and is counted for /health.
// Observation only: the reply is sent unchanged either way.

import { log } from '../logger.js';

const EDGE_CHARS = 40;

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

/** Check one finished reply. Never throws, and never changes what is sent. */
export function checkFinishedChatReply(text: string, turn: FinishedTurn): void {
  try {
    const strict = tryParse(text);
    if (strict.ok) return;
    counts.strictFailures++;
    const recovered = recovers(text);
    if (!recovered) counts.unrecovered++;
    log.server.warn({
      component: 'chat-stream', reason: 'chat-reply-parse-failed', path: turn.path,
      model: turn.model ?? null, stopReason: turn.stopReason ?? null, jsonMode: turn.jsonMode,
      chars: text.length, fenced: FENCE.test(text), recoveredByProductParser: recovered, parseError: strict.error,
      head: text.slice(0, EDGE_CHARS), tail: text.length > EDGE_CHARS ? text.slice(-EDGE_CHARS) : '',
    }, `chat-stream: a finished reply failed strict JSON parsing${recovered ? ' (the product parser recovers it)' : ' and the product parser cannot recover it'} (t/618)`);
  } catch (err) {
    log.server.warn({ component: 'chat-stream', err: String(err) }, 'chat-stream: reply parse check itself failed; skipped (t/618)');
  }
}
