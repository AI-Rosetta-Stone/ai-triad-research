// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/725 (t/723, server contract t/724#4): the server's refusals of an anonymous visitor's debate or op-ed, as
// stable codes the UI maps to Design's lines (t/725, Design p/25#221). The mapping is on `reason` + `code`,
// never on the server's sentence. The contract:
//   401 { reason: 'no_session' }                                  the visitor has no session
//   403 { reason: 'anon_limit', code, signInRequired, limit? }    a limit of the anonymous tier
//   503 { retryable: true }                                       the counter store is down: a failure, not a sign-in
// codes: anon_oped_voices, anon_debate_kind, anon_debate_turns, anon_debate_unsaved, anon_debate_budget,
// anon_debate_daily. Any other 403/401/503 (anon_route_blocked and the rest) is not handled here.

export type AnonLimitCode =
  | 'anon_oped_voices' | 'anon_debate_kind' | 'anon_debate_turns'
  | 'anon_debate_unsaved' | 'anon_debate_budget' | 'anon_debate_daily';

export type AnonRefusal =
  | { kind: 'limit'; code: AnonLimitCode; limit?: number }
  | { kind: 'no_session' };

const CODES: ReadonlySet<string> = new Set<AnonLimitCode>([
  'anon_oped_voices', 'anon_debate_kind', 'anon_debate_turns', 'anon_debate_unsaved', 'anon_debate_budget', 'anon_debate_daily',
]);

/** The refusal in a response body, given the HTTP status. Null for anything that isn't one of these. */
export function anonRefusalFromBody(status: number, body: unknown): AnonRefusal | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as { reason?: unknown; code?: unknown; limit?: unknown };
  if (status === 401 && b.reason === 'no_session') return { kind: 'no_session' };
  if (status === 403 && b.reason === 'anon_limit' && typeof b.code === 'string' && CODES.has(b.code)) {
    return { kind: 'limit', code: b.code as AnonLimitCode, ...(typeof b.limit === 'number' ? { limit: b.limit } : {}) };
  }
  return null;
}

/** The JSON object the bridge embeds in an error's problem text after "HTTP <status>: ", if it parses. */
function bodyFromProblem(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { /* telemetry — silent by design: no JSON in the text means it is not one of these refusals */ return undefined; }
}

/** The refusal on a bridge error (web-bridge's ActionableError carries `httpStatus` and the body in its problem
 *  text). A thrown error that already carries the parsed refusal (`anonRefusal`) wins. */
export function anonRefusalOf(err: unknown): AnonRefusal | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as { anonRefusal?: AnonRefusal; httpStatus?: number; problem?: unknown; message?: unknown };
  if (e.anonRefusal) return e.anonRefusal;
  if (typeof e.httpStatus !== 'number') return null;
  return anonRefusalFromBody(e.httpStatus, bodyFromProblem(`${String(e.problem ?? '')} ${String(e.message ?? '')}`));
}

/** True for a refusal whose remedy is signing in. anon_debate_unsaved is not: the debate wasn't saved, and
 *  signing in doesn't fix that (Design p/25#221, item 3). */
export function refusalOffersSignIn(r: AnonRefusal): boolean {
  return r.kind === 'no_session' || r.code !== 'anon_debate_unsaved';
}

/** Design's lines, verbatim (t/725#3, p/25#221). Never the server's sentence. */
export function anonRefusalLine(r: AnonRefusal): string {
  if (r.kind === 'no_session') return 'Your session has ended. Sign in to continue.';
  switch (r.code) {
    case 'anon_oped_voices': return 'Sign in to create more than one voice at a time.';
    case 'anon_debate_kind': return 'Sign in to run Deep dive and Socratic debates.';
    case 'anon_debate_turns': return 'This debate has reached the length limit for debates without signing in. Sign in to continue it.';
    case 'anon_debate_unsaved': return "This debate couldn't be saved, so it can't continue. Try starting it again.";
    case 'anon_debate_budget': return 'This debate has used all the AI calls allowed without signing in. Sign in to continue it.';
    case 'anon_debate_daily': return "You've started all the debates allowed per day without signing in. Sign in to start more, or try again tomorrow.";
  }
}

/** A 503 with retryable true is a failure to retry, never a sign-in prompt (TL t/724#7, Security t/724#5). */
export const RETRYABLE_FAILURE_LINE = 'Something went wrong on our side. Try again in a moment.';

export function isRetryableFailure(status: number | undefined, body: unknown): boolean {
  return status === 503 && !!body && typeof body === 'object' && (body as { retryable?: unknown }).retryable === true;
}
