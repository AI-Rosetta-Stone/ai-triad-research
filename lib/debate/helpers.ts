// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Pure helper functions extracted from useDebateStore.
 * No UI, Zustand, or Electron dependencies.
 */

import type { SpeakerId, TranscriptEntry, TaxonomyRef, TurnSymbol } from './types.js';
import { POVER_INFO } from './types.js';
import type { Pov, Category, GraphAttributes } from './taxonomyTypes.js';
import { getGlobalRecorder } from '../flight-recorder/index.js';
import { ActionableError } from './errors.js';
import { salvageJsonArray } from './partialJsonSalvage.js';

export function generateId(): string {
  return crypto.randomUUID();
}

export function nowISO(): string {
  return new Date().toISOString();
}

/** Strip markdown code fences from LLM responses */
export function stripCodeFences(text: string): string {
  return text.replace(/```json\s*/g, '').replace(/```/g, '').trim();
}

/** Strip "Excludes: ..." suffix from taxonomy node descriptions.
 *  Debate-facing prompts should not expose Excludes clauses to LLM debaters. */
export function stripExcludes(description: string): string {
  if (!description) return '';
  return description.replace(/\s*Excludes:\s*.*/s, '').trim();
}

const EMOJI_RE = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u;
const FALLBACK_SYMBOL = '\u{1F4AC}';

export function sanitizeTurnSymbols(symbols: TurnSymbol[]): TurnSymbol[] {
  return symbols.map(s => {
    if (s.symbol && EMOJI_RE.test(s.symbol)) return s;
    console.warn(`[turn-symbols] Replacing non-emoji symbol: ${JSON.stringify(s.symbol)}`);
    return { ...s, symbol: FALLBACK_SYMBOL };
  });
}

/**
 * Robust JSON parser for LLM responses. Handles:
 *  - Markdown code fences
 *  - Trailing commas
 *  - Bare newlines and unescaped quotes inside strings
 *  - Preamble/postamble text around the JSON object
 *
 * Returns the parsed object, or null if all strategies fail.
 */
export function parseAIJson<T = unknown>(text: string): T | null {
  // Strategy 1: strip fences + direct parse
  const stripped = stripCodeFences(text);
  try { return JSON.parse(stripped) as T; } catch { /* continue */ }

  // Strategy 2: repair common issues (trailing commas, bare newlines, unescaped quotes)
  try { return JSON.parse(repairJson(stripped)) as T; } catch { /* continue */ }

  // Strategy 3: extract the outermost JSON object or array from the text
  const objStart = text.indexOf('{');
  const arrStart = text.indexOf('[');
  const start = objStart >= 0 && (arrStart < 0 || objStart < arrStart) ? objStart : arrStart;
  if (start >= 0) {
    const opener = text[start];
    const closer = opener === '{' ? '}' : ']';
    // Find the matching close bracket by counting nesting
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\' && inStr) { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === opener) depth++;
      if (ch === closer) depth--;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        try { return JSON.parse(candidate) as T; } catch { /* continue */ }
        try { return JSON.parse(repairJson(candidate)) as T; } catch { /* continue */ }
        break;
      }
    }
  }

  // Strategy 4: bounded backtracking over ambiguous in-string quotes (t/1631).
  // Last-resort layer — only reached after strategies 1-3 fail. Resolves the
  // `,`-class ambiguity that single-token lookahead in repairJson cannot.
  const backtracked = repairJsonBacktrack(stripped);
  if (backtracked !== null) {
    try { return JSON.parse(backtracked) as T; } catch { /* continue */ }
  }

  // ADR-003 Family-B (Lossy Error Boundaries): every recovery strategy has now
  // failed on a body we could not parse. Record the discarded payload (bounded
  // head+tail) and the terminal recovery status BEFORE dropping to null, so a
  // silent drop is never indistinguishable from "model produced nothing."
  const head = text.slice(0, 400);
  const tail = text.length > 600 ? text.slice(-200) : '';
  getGlobalRecorder()?.record({
    type: 'system.error',
    component: 'parseAIJson',
    level: 'warn',
    message: `parseAIJson exhausted all recovery strategies; dropping ${text.length}-char payload to null`,
    data: {
      recovery_strategy: 'backtrack-exhausted',
      payload_length: text.length,
      ambiguous_quote_count: countAmbiguousQuotes(stripped),
      discarded_head: head,
      discarded_tail: tail,
    },
  });

  return null;
}

/**
 * Normalize an LLM claim extraction response into the expected `{claims: [...]}` shape.
 * Handles common model-specific variants:
 *  - Already correct: `{claims: [...]}`
 *  - Bare array: `[{text: ...}, ...]`
 *  - Wrong key: `{extracted_claims: [...]}` or `{results: [...]}`
 *
 * Returns null if the input can't be interpreted as a claims response.
 */
export function normalizeClaimsResponse(parsed: unknown): { claims: Record<string, unknown>[] } | null {
  if (!parsed || typeof parsed !== 'object') return null;

  // Case 1: bare array of claim-like objects
  if (Array.isArray(parsed)) {
    if (parsed.length > 0 && typeof parsed[0] === 'object' && parsed[0] !== null && 'text' in parsed[0]) {
      return { claims: parsed as Record<string, unknown>[] };
    }
    return null;
  }

  const obj = parsed as Record<string, unknown>;

  // Case 2: already has a `claims` array
  if (Array.isArray(obj.claims)) {
    return obj as { claims: Record<string, unknown>[] };
  }

  // Case 3: single key whose value is an array of claim-like objects
  const keys = Object.keys(obj);
  for (const key of keys) {
    const val = obj[key];
    if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'object' && val[0] !== null && 'text' in val[0]) {
      return { claims: val as Record<string, unknown>[] };
    }
  }

  return null;
}

/**
 * Attempt to repair common JSON issues from LLM responses:
 *  - Bare newlines inside string values
 *  - Unescaped quotes inside string values
 *  - Trailing commas before } or ]
 *
 * Strategy: find the top-level "statement" value and extract it by matching
 * the closing pattern, then re-escape it properly.
 */
function repairJson(text: string): string {
  // Strategy: locate known top-level keys and extract their string values robustly.
  // For the "statement" key specifically, the value often contains bare newlines and quotes.
  let repaired = text;

  // Fix bare newlines: walk through and escape newlines that appear inside JSON strings
  const chars: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < repaired.length; i++) {
    const ch = repaired[i];
    if (escaped) {
      chars.push(ch);
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      chars.push(ch);
      escaped = true;
      continue;
    }
    if (ch === '"') {
      // Heuristic: if we're "inside" a string and hit a quote, check if it looks like
      // a JSON structural quote (followed by : or , or } or ] or whitespace+those)
      // or a quote inside prose
      if (inString) {
        const rest = repaired.slice(i + 1).trimStart();
        const isStructural = rest.length === 0 || /^[,:\]}\n\r]/.test(rest);
        if (isStructural) {
          inString = false;
          chars.push(ch);
        } else {
          // This quote is inside a string value — escape it
          chars.push('\\', '"');
        }
        continue;
      } else {
        inString = true;
        chars.push(ch);
        continue;
      }
    }
    if (inString && (ch === '\n' || ch === '\r')) {
      chars.push(ch === '\n' ? '\\' : '\\', ch === '\n' ? 'n' : 'r');
      continue;
    }
    chars.push(ch);
  }
  repaired = chars.join('');

  // Remove trailing commas
  repaired = repaired.replace(/,\s*([\]}])/g, '$1');
  return repaired;
}

// --- Strategy 4: bounded backtracking over ambiguous in-string quotes (t/1631) ---
//
// The `repairJson` heuristic (above) commits to a single interpretation of each
// in-string `"` using a one-token lookahead: an unescaped quote followed by
// `,` `:` `}` `]` is treated as a string terminator. When such a quote is
// actually *inside* prose (e.g. `... the "safety" case, ...`), that guess
// corrupts the repair and `parseAIJson` drops the whole body to null — the
// production incident behind t/1631.
//
// A wider lookahead cannot resolve this: the `,`-class is genuinely ambiguous
// (both "terminator then next field" and "in-prose quote then more prose" are
// locally valid). The only correct resolution is to *try both* and keep the
// interpretation that yields parseable JSON. This is a last-resort layer,
// engaged only after strategies 1-3 have failed and only at the ambiguous
// branch points — the happy path never reaches it.
//
// Bounds (TL condition: "bounded, and prove the bound"):
//   * BACKTRACK_MAX_BRANCH_POINTS — an O(n) pre-count of ambiguous quotes; a
//     body with more than this is rejected up front (clean null), so we never
//     enter the search on a pathological input.
//   * BACKTRACK_MAX_CANDIDATES — a hard cap on branches explored *and*
//     candidate parses attempted during the search, so even within the
//     pre-count bound total work is O(n * cap), never exponential.
const BACKTRACK_MAX_BRANCH_POINTS = 24;
const BACKTRACK_MAX_CANDIDATES = 40;

/**
 * Count the ambiguous in-string quotes (unescaped `"` that the single-token
 * heuristic would read as structural). Pure O(n) scan — used to reject
 * pathological bodies before any backtracking begins.
 */
function countAmbiguousQuotes(text: string): number {
  let count = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') {
      if (inString) {
        const rest = text.slice(i + 1).trimStart();
        const isStructural = rest.length === 0 || /^[,:\]}\n\r]/.test(rest);
        if (isStructural) { count++; inString = false; }
      } else {
        inString = true;
      }
    }
  }
  return count;
}

/**
 * Bounded backtracking repair. At each ambiguous in-string `"`, first try
 * treating it as a string terminator (recurse); if that whole path fails to
 * yield parseable JSON, fall back to escaping the quote as in-prose and
 * continue. Returns a parseable JSON string, or null if every bounded
 * interpretation fails (or the input is pathological / has no ambiguity).
 */
function repairJsonBacktrack(text: string): string | null {
  const ambiguousCount = countAmbiguousQuotes(text);
  // No ambiguity → nothing this layer can add over strategies 1-3.
  if (ambiguousCount === 0) return null;
  // Pathological → clean null without entering the search (proves the bound).
  if (ambiguousCount > BACKTRACK_MAX_BRANCH_POINTS) return null;

  let candidatesTried = 0;
  let branchesExplored = 0;

  function search(startI: number, inStringInit: boolean, acc: string[]): string | null {
    let inString = inStringInit;
    let escaped = false;
    for (let i = startI; i < text.length; i++) {
      const ch = text[i];
      if (escaped) { acc.push(ch); escaped = false; continue; }
      if (ch === '\\') { acc.push(ch); escaped = true; continue; }
      if (ch === '"') {
        if (inString) {
          const rest = text.slice(i + 1).trimStart();
          const isStructural = rest.length === 0 || /^[,:\]}\n\r]/.test(rest);
          if (isStructural) {
            // Ambiguous branch point: try "terminate string" first.
            if (++branchesExplored > BACKTRACK_MAX_CANDIDATES) return null;
            const branchA = search(i + 1, false, [...acc, ch]);
            if (branchA !== null) return branchA;
            // Terminator interpretation failed downstream — treat as in-prose.
            acc.push('\\', '"');
            continue;
          } else {
            // Unambiguously in-prose — escape and continue (no branch).
            acc.push('\\', '"');
            continue;
          }
        } else {
          inString = true;
          acc.push(ch);
          continue;
        }
      }
      if (inString && (ch === '\n' || ch === '\r')) {
        acc.push('\\', ch === '\n' ? 'n' : 'r');
        continue;
      }
      acc.push(ch);
    }
    if (++candidatesTried > BACKTRACK_MAX_CANDIDATES) return null;
    const candidate = acc.join('').replace(/,\s*([\]}])/g, '$1');
    try { JSON.parse(candidate); return candidate; } catch { return null; }
  }

  return search(0, false, []);
}

/** Parse @-mentions from user input. Returns { targets, cleanedInput } */
export function parseAtMention(input: string): { targets: SpeakerId[]; cleanedInput: string } {
  const mentionMap: Record<string, SpeakerId> = {
    accelerationist: 'accelerationist',
    safetyist: 'safetyist',
    skeptic: 'skeptic',
    // Legacy aliases
    prometheus: 'accelerationist',
    sentinel: 'safetyist',
    cassandra: 'skeptic',
  };

  const targets: SpeakerId[] = [];
  let remaining = input;

  // Extract all leading @mentions
  while (true) {
    const match = remaining.match(/^@(\w+)[,:]?\s*/i);
    if (!match) break;
    const name = match[1].toLowerCase();
    const target = mentionMap[name];
    if (target && !targets.includes(target)) {
      targets.push(target);
      remaining = remaining.slice(match[0].length);
    } else {
      break;
    }
  }

  return { targets, cleanedInput: remaining };
}

/** Options for aggressive transcript compression after late-debate turns. */
export interface TranscriptCompressionOpts {
  /** Non-system entry count after which aggressive compression activates. Default: 30 (~round 10). */
  aggressiveAfterEntries?: number;
  /** Verbatim window when aggressive mode is active. Default: 5. */
  aggressiveVerbatimWindow?: number;
  /** Hard character cap on the formatted transcript block. Default: 8000 when aggressive. */
  maxChars?: number;
  /** Include taxonomy_ref relevance annotations on recent entries. Default: true.
   *  Set false for moderator-facing transcripts to prevent refs leaking as debater claims. */
  includeTaxonomyRefs?: boolean;
}

/** Format recent transcript entries for inclusion in prompts.
 *  When context summaries exist, prepends the latest summary for compressed history.
 *  After ~round 10 (30 non-system entries), automatically reduces the verbatim window
 *  from 8 to 5 and caps total output at ~8K chars. Only applies for standard windows
 *  (maxEntries ≤ 8); synthesis and calibration callers passing larger windows are unaffected. */
export function formatRecentTranscript(
  transcript: TranscriptEntry[],
  maxEntries: number = 8,
  contextSummaries?: { up_to_entry_id: string; summary: string; tier?: string }[],
  compressionOpts?: TranscriptCompressionOpts,
): string {
  // Aggressive compression for standard windows after ~round 10
  const nonSystemCount = transcript.filter(e => e.type !== 'system').length;
  const aggressiveThreshold = compressionOpts?.aggressiveAfterEntries ?? 30;
  const isAggressive = maxEntries <= 8 && nonSystemCount > aggressiveThreshold;
  const effectiveMax = isAggressive
    ? (compressionOpts?.aggressiveVerbatimWindow ?? 5)
    : maxEntries;

  const recent = transcript.slice(-(effectiveMax * 2)).filter((e) => e.type !== 'system').slice(-effectiveMax);
  if (recent.length === 0) return '(No prior exchanges)';

  const parts: string[] = [];

  // Prepend context summaries — tiered if available
  if (contextSummaries && contextSummaries.length > 0) {
    const distant = contextSummaries.filter(s => s.tier === 'distant');
    const medium = contextSummaries.filter(s => s.tier === 'medium');
    const legacy = contextSummaries.filter(s => !s.tier);

    if (distant.length > 0) {
      const latest = distant[distant.length - 1];
      parts.push(`[Distant context — structural summary]:\n${latest.summary}`);
    }
    if (medium.length > 0) {
      const latest = medium[medium.length - 1];
      parts.push(`[Medium context — key claims & commitments]:\n${latest.summary}`);
    }
    if (distant.length === 0 && medium.length === 0 && legacy.length > 0) {
      const latest = legacy[legacy.length - 1];
      parts.push(`[Earlier debate summary]: ${latest.summary}`);
    }
  }

  const recentRefThreshold = 3; // annotate the last N entries with metadata insights

  for (let idx = 0; idx < recent.length; idx++) {
    const e = recent[idx];
    const label = e.speaker === 'user' ? 'Moderator'
      : e.speaker === 'system' ? 'System'
      : POVER_INFO[e.speaker as Exclude<SpeakerId, 'user'>]?.label || e.speaker;
    const typeTag = e.type === 'question' ? ' [question]' : e.type === 'opening' ? ' [opening]' : '';
    const contentStr = typeof e.content === 'string' ? e.content : JSON.stringify(e.content);
    let entryText = `${label}${typeTag}: ${contentStr}`;

    // Surface key_assumptions as potential attack vectors for opponents
    // The Brief naturally uses other speakers' assumptions offensively and own assumptions defensively
    const assumptions = (e.metadata as Record<string, unknown>)?.key_assumptions as
      { assumption: string; if_wrong: string }[] | undefined;
    if (idx >= recent.length - recentRefThreshold && assumptions?.length) {
      const topAssumptions = assumptions.slice(0, 2);
      entryText += '\n' + topAssumptions.map(a =>
        `  [Assumes: "${a.assumption}" — if wrong: ${a.if_wrong}]`,
      ).join('\n');
    }

    // For the most recent entries, surface anticipated_responses from the Plan stage
    // so the Brief can assess whether prior strategic predictions were accurate
    const priorAnticipated = (e.metadata as Record<string, unknown>)?.anticipated_responses as string[] | undefined;
    if (idx < recent.length - 1 && priorAnticipated?.length) {
      const nextEntry = recent[idx + 1];
      const nextContent = typeof nextEntry.content === 'string' ? nextEntry.content : '';
      const nextLabel = nextEntry.speaker === 'user' ? 'Moderator'
        : POVER_INFO[nextEntry.speaker as Exclude<SpeakerId, 'user'>]?.label || nextEntry.speaker;
      entryText += `\n  [Predicted: ${priorAnticipated.slice(0, 2).join('; ')}]`;
      if (nextContent) {
        entryText += `\n  [Actual (${nextLabel}): see next entry — assess prediction accuracy]`;
      }
    }

    // For the most recent entries, append top taxonomy ref relevance explanations
    // so the next turn's Brief can reason about WHY prior turns cited specific nodes
    if (compressionOpts?.includeTaxonomyRefs !== false && idx >= recent.length - recentRefThreshold && e.taxonomy_refs?.length) {
      const topRefs = [...e.taxonomy_refs]
        .filter(r => r.relevance && r.relevance.length > 10)
        .sort((a, b) => (b.relevance_score ?? 0) - (a.relevance_score ?? 0))
        .slice(0, 2);
      if (topRefs.length > 0) {
        entryText += '\n' + topRefs.map(r =>
          `  → ${r.node_id}${r.label ? ` (${r.label})` : ''}: ${r.relevance}`,
        ).join('\n');
      }
    }

    parts.push(entryText);
  }

  const result = parts.join('\n\n');

  // Apply character cap — preserve recent entries (tail), truncate summaries (head)
  const maxChars = compressionOpts?.maxChars ?? (isAggressive ? 8000 : undefined);
  if (maxChars && result.length > maxChars) {
    return '[... earlier context truncated]\n\n' + result.slice(-(maxChars - 40));
  }
  return result;
}

/** Structured dialectical move annotation */
export interface MoveAnnotation {
  move: string;
  target?: string;
  detail: string;
}

/** Extended metadata from enriched debate prompts */
export interface PoverResponseMeta {
  move_types?: (string | MoveAnnotation)[];
  disagreement_type?: string;
  key_assumptions?: { assumption: string; if_wrong: string }[];
  my_claims?: { claim: string; targets: string[]; steelman_of?: string }[];
  /** Pre-CQ: bare string IDs. Post-CQ: objects with relevance. Consumers must check typeof. */
  policy_refs?: (string | { policy_id: string; relevance: string })[];
  position_update?: string;
  turn_symbols?: { symbol: string; tooltip: string }[];
  pin_response?: Record<string, unknown>;
  probe_response?: Record<string, unknown>;
  challenge_response?: Record<string, unknown>;
  clarification?: Record<string, unknown>;
  check_response?: Record<string, unknown>;
  revoice_response?: Record<string, unknown>;
  reflection?: Record<string, unknown>;
  compressed_thesis?: string;
  commitment?: Record<string, unknown>;
  directive_response?: { directive: string; how_addressed: string };
  talmudic_reference_response?: import('./types.js').TalmudicReferenceResponse;
}

/** Try to parse JSON, with repair fallback for LLM formatting issues */
export function parseJsonRobust(text: string): unknown {
  const stripped = stripCodeFences(text);
  try {
    return JSON.parse(stripped);
  } catch {
    // Try with repair (bare newlines, unescaped quotes, trailing commas)
    try {
      return JSON.parse(repairJson(stripped));
    } catch {
      // Last resort: find the first top-level JSON object via brace-depth matching
      const firstBrace = stripped.indexOf('{');
      if (firstBrace >= 0) {
        let depth = 0;
        let inString = false;
        let escape = false;
        for (let i = firstBrace; i < stripped.length; i++) {
          const ch = stripped[i];
          if (escape) { escape = false; continue; }
          if (ch === '\\' && inString) { escape = true; continue; }
          if (ch === '"') { inString = !inString; continue; }
          if (inString) continue;
          if (ch === '{') depth++;
          else if (ch === '}') { depth--; if (depth === 0) {
            const extracted = stripped.slice(firstBrace, i + 1);
            try { return JSON.parse(extracted); } catch { /* fall through */ }
            try { return JSON.parse(repairJson(extracted)); } catch { /* fall through */ }
            break;
          }}
        }
      }
      const preview = text.slice(0, 200).replace(/\n/g, '\\n');
      // ADR-003: record the discarded payload (bounded head+tail) before the
      // throw so an unrecoverable parse is never a silent boundary.
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'parseJsonRobust',
        level: 'warn',
        message: `parseJsonRobust exhausted all repair strategies on a ${text.length}-char payload`,
        data: {
          recovery_strategy: 'strip-fences|repair|brace-extract',
          payload_length: text.length,
          discarded_head: text.slice(0, 400),
          discarded_tail: text.length > 600 ? text.slice(-200) : '',
        },
      });
      // ADR-001: unrecoverable → ActionableError, not a bare throw. The two
      // substrings below ("Cannot parse JSON after all repair attempts" and
      // "Input preview:") are load-bearing for existing helpers.test.ts asserts.
      throw new ActionableError({
        goal: 'Parse a JSON object from an AI model response',
        problem:
          `Cannot parse JSON after all repair attempts (strip fences, repair quotes/newlines, extract braces). ` +
          `Input preview: ${preview}`,
        location: 'parseJsonRobust (lib/debate/helpers.ts)',
        nextSteps: [
          'Retry the operation — the AI often returns malformed or truncated output that parses on a fresh attempt.',
          'If it persists, switch to a model with more reliable structured-output (JSON) support.',
        ],
      });
    }
  }
}

// ── Partial JSON salvage ─────────────────────────────────

/** Extract a JSON array from a (possibly truncated or partly malformed) JSON string. Element-wise
 *  since t/774: one bad element no longer loses the whole list. Callers that must report what was
 *  dropped use salvageJsonArray directly. */
function extractArrayFromJson(json: string, key: string): unknown[] {
  return salvageJsonArray(json, key).items;
}

/** Extract all known synthesis arrays from a truncated JSON response.
 *  Used when parseAIJson returns null due to token-limit truncation. */
export function extractArraysFromPartialJson(json: string): Record<string, unknown[]> {
  return {
    areas_of_agreement: extractArrayFromJson(json, 'areas_of_agreement'),
    areas_of_disagreement: extractArrayFromJson(json, 'areas_of_disagreement'),
    cruxes: extractArrayFromJson(json, 'cruxes'),
    unresolved_questions: extractArrayFromJson(json, 'unresolved_questions'),
    taxonomy_coverage: extractArrayFromJson(json, 'taxonomy_coverage'),
    argument_map: extractArrayFromJson(json, 'argument_map'),
    preferences: extractArrayFromJson(json, 'preferences'),
    policy_implications: extractArrayFromJson(json, 'policy_implications'),
  };
}

const CANONICAL_MOVES: Record<string, string> = {
  'DISTINGUISH': 'DISTINGUISH',
  'COUNTEREXAMPLE': 'COUNTEREXAMPLE',
  'CONCEDE-AND-PIVOT': 'CONCEDE-AND-PIVOT',
  'CONCEDE_AND_PIVOT': 'CONCEDE-AND-PIVOT',
  'CONCEDEANDPIVOT': 'CONCEDE-AND-PIVOT',
  'CONCEDE AND PIVOT': 'CONCEDE-AND-PIVOT',
  'REFRAME': 'REFRAME',
  'EMPIRICAL CHALLENGE': 'EMPIRICAL CHALLENGE',
  'EMPIRICAL-CHALLENGE': 'EMPIRICAL CHALLENGE',
  'EMPIRICAL_CHALLENGE': 'EMPIRICAL CHALLENGE',
  'EMPIRICALCHALLENGE': 'EMPIRICAL CHALLENGE',
  'EXTEND': 'EXTEND',
  'UNDERCUT': 'UNDERCUT',
  'GROUND-CHECK': 'GROUND-CHECK',
  'GROUND_CHECK': 'GROUND-CHECK',
  'GROUNDCHECK': 'GROUND-CHECK',
  'CONDITIONAL-AGREE': 'CONDITIONAL-AGREE',
  'CONDITIONAL_AGREE': 'CONDITIONAL-AGREE',
  'CONDITIONALGREE': 'CONDITIONAL-AGREE',
  'IDENTIFY-CRUX': 'IDENTIFY-CRUX',
  'IDENTIFY_CRUX': 'IDENTIFY-CRUX',
  'IDENTIFYCRUX': 'IDENTIFY-CRUX',
  'CRUX': 'IDENTIFY-CRUX',
  'CRUX-IDENTIFICATION': 'IDENTIFY-CRUX',
  'FORCE_CRUX': 'IDENTIFY-CRUX',
  'PROPOSE-CRUX': 'IDENTIFY-CRUX',
  'CLARIFY-CRUX': 'IDENTIFY-CRUX',
  'INTEGRATE': 'INTEGRATE',
  'STEEL-BUILD': 'STEEL-BUILD',
  'STEEL_BUILD': 'STEEL-BUILD',
  'STEELBUILD': 'STEEL-BUILD',
  'EXPOSE-ASSUMPTION': 'EXPOSE-ASSUMPTION',
  'EXPOSE_ASSUMPTION': 'EXPOSE-ASSUMPTION',
  'EXPOSEASSUMPTION': 'EXPOSE-ASSUMPTION',
  'PRESUPPOSITION-CHALLENGE': 'EXPOSE-ASSUMPTION',
  'SPECIFY': 'SPECIFY',
  'SPECIFY-MECHANISM': 'SPECIFY',
  'SPECIFY_MECHANISM': 'SPECIFY',
  'SPECIFY-ASSUMPTIONS': 'EXPOSE-ASSUMPTION',
  'SPECIFY_ASSUMPTIONS': 'EXPOSE-ASSUMPTION',
  'ACKNOWLEDGE-ASSUMPTION': 'EXPOSE-ASSUMPTION',
  'ACKNOWLEDGE_ASSUMPTION': 'EXPOSE-ASSUMPTION',
  'CHALLENGE-ASSUMPTION': 'EXPOSE-ASSUMPTION',
  'SURFACE-ASSUMPTION': 'EXPOSE-ASSUMPTION',
  'CHALLENGE-EMPIRICAL': 'EMPIRICAL CHALLENGE',
  'RECIPROCAL-CHALLENGE': 'COUNTEREXAMPLE',
  'RECIPROCAL_CHALLENGE': 'COUNTEREXAMPLE',
  'BURDEN-SHIFT': 'BURDEN-SHIFT',
  'BURDEN_SHIFT': 'BURDEN-SHIFT',
  'BURDENSHIFT': 'BURDEN-SHIFT',
  'CONCEDE': 'CONCEDE',
  'PARTIAL-CONCEDE': 'CONDITIONAL-AGREE',
  'ACKNOWLEDGE-VULNERABILITY': 'CONDITIONAL-AGREE',
  'ACKNOWLEDGE-SCOPE': 'CONDITIONAL-AGREE',
  'REDUCE': 'REDUCE',
  'ESCALATE': 'ESCALATE',
  'ASSERT': 'ASSERT',
  'SPECIFY-BOUNDARY-CONDITIONS': 'SPECIFY',
  'RESOLVE-TENSION': 'IDENTIFY-CRUX',
  'RESOLVE_TENSION': 'IDENTIFY-CRUX',
  'CHALLENGE': 'EMPIRICAL CHALLENGE',
  'DIRECT-CHALLENGE': 'EMPIRICAL CHALLENGE',
  'DIRECT_CHALLENGE': 'EMPIRICAL CHALLENGE',
  'ANALOGY-CHALLENGE': 'COUNTEREXAMPLE',
  'CHALLENGE-ANALOGY': 'COUNTEREXAMPLE',
  'STEELMAN': 'STEEL-BUILD',
  'STEEL-MAN': 'STEEL-BUILD',
  'NARROW': 'DISTINGUISH',
  'NARROW-SCOPE': 'DISTINGUISH',
  'SYNTHESIZE': 'INTEGRATE',
  'SYNTHESIS': 'INTEGRATE',
  'QUALIFY': 'CONDITIONAL-AGREE',
  'QUALIFY-CLAIM': 'CONDITIONAL-AGREE',
  'CONDITIONAL-CONCESSION': 'CONDITIONAL-AGREE',
  'CONDITIONAL_CONCESSION': 'CONDITIONAL-AGREE',
  'PIVOT': 'CONCEDE-AND-PIVOT',
  'CONCESSION': 'CONCEDE-AND-PIVOT',
  'PROPOSE-TEST': 'SPECIFY',
  'PROPOSE_TEST': 'SPECIFY',
  'PROPOSE-BENCHMARK': 'SPECIFY',
  'PROPOSE_BENCHMARK': 'SPECIFY',
  'FALSIFY': 'SPECIFY',
  'COMPARATIVE-ANALYSIS': 'DISTINGUISH',
  'COMPARATIVE_ANALYSIS': 'DISTINGUISH',
  'ASSUMPTION-AUDIT': 'EXPOSE-ASSUMPTION',
  'ASSUMPTION_AUDIT': 'EXPOSE-ASSUMPTION',
  'REINTERPRET-EVIDENCE': 'REFRAME',
  'REINTERPRET_EVIDENCE': 'REFRAME',
  'SPECIFY-CRUX': 'IDENTIFY-CRUX',
  'SPECIFY_CRUX': 'IDENTIFY-CRUX',
  // Common LLM hallucinations not covered by fuzzy keywords
  'REBUT': 'COUNTEREXAMPLE',
  'REBUTTAL': 'COUNTEREXAMPLE',
  'REFUTE': 'COUNTEREXAMPLE',
  'ANALOGIZE': 'REFRAME',
  'ANALOGY': 'REFRAME',
  'CRITIQUE': 'EMPIRICAL CHALLENGE',
  'OBJECT': 'EMPIRICAL CHALLENGE',
  'OBJECTION': 'EMPIRICAL CHALLENGE',
  'DEFEND': 'EXTEND',
  'ELABORATE': 'EXTEND',
  'CLARIFY': 'SPECIFY',
  'OPERATIONALIZE': 'SPECIFY',
  'CONTEXTUALIZE': 'DISTINGUISH',
  'NUANCE': 'DISTINGUISH',
  'PROBLEMATIZE': 'EXPOSE-ASSUMPTION',
  'INTERROGATE': 'EXPOSE-ASSUMPTION',
  'QUESTION': 'EXPOSE-ASSUMPTION',
  'COMPARE': 'DISTINGUISH',
  'CONTRAST': 'DISTINGUISH',
};

const FUZZY_KEYWORDS: [RegExp, string][] = [
  [/CHALLENGE/i, 'EMPIRICAL CHALLENGE'],
  [/CONCEDE|CONCESSION|GRANT/i, 'CONCEDE-AND-PIVOT'],
  [/CRUX|TENSION|RESOLVE/i, 'IDENTIFY-CRUX'],
  [/ASSUMPTION|PRESUPPOS/i, 'EXPOSE-ASSUMPTION'],
  [/SPECIFY|MECHANISM|OPERATIONALIZE/i, 'SPECIFY'],
  [/STEEL|STRENGTHEN/i, 'STEEL-BUILD'],
  [/INTEGRAT|SYNTHESIZ|COMBIN/i, 'INTEGRATE'],
  [/NARROW|SCOPE|BOUNDAR/i, 'DISTINGUISH'],
  [/BURDEN|PROOF/i, 'BURDEN-SHIFT'],
  [/REFRAME|RECAST|SHIFT.*FRAME/i, 'REFRAME'],
  [/COUNTER.*EXAMPLE|EXCEPTION/i, 'COUNTEREXAMPLE'],
  [/CONDITION|QUALIF|PARTIAL/i, 'CONDITIONAL-AGREE'],
  [/UNDERCUT|WARRANT/i, 'UNDERCUT'],
  [/GROUND|FACT.*CHECK|VERIFY/i, 'GROUND-CHECK'],
  [/EXTEND|BUILD.*ON|EXPAND|DEFEND|ELABORAT/i, 'EXTEND'],
  [/REBUT|REFUT/i, 'COUNTEREXAMPLE'],
  [/ANALOG|COMPARE|CONTRAST/i, 'REFRAME'],
  [/CRITIQU|OBJECT/i, 'EMPIRICAL CHALLENGE'],
  [/CLARIF|OPERATIONALIZ/i, 'SPECIFY'],
  [/NUANC|CONTEXTUALI/i, 'DISTINGUISH'],
  [/PROBLEMATIZ|INTERROGAT/i, 'EXPOSE-ASSUMPTION'],
];

function canonicalizeMove(name: string): string {
  const key = name.toUpperCase().trim();
  const exact = CANONICAL_MOVES[key]
    ?? CANONICAL_MOVES[key.replace(/-/g, ' ')]
    ?? CANONICAL_MOVES[key.replace(/-/g, '_')];
  if (exact) return exact;

  for (const [pattern, canonical] of FUZZY_KEYWORDS) {
    if (pattern.test(key)) return canonical;
  }
  return name;
}

function normalizeMoveTypes(raw: unknown[]): (string | MoveAnnotation)[] {
  return raw.map(item => {
    if (typeof item === 'string') return canonicalizeMove(item);
    if (item && typeof item === 'object') {
      const obj = item as Record<string, unknown>;
      if (typeof obj.move === 'string') {
        return {
          move: canonicalizeMove(obj.move),
          target: typeof obj.target === 'string' ? obj.target : undefined,
          detail: typeof obj.detail === 'string' ? obj.detail : '',
        } as MoveAnnotation;
      }
    }
    return String(item);
  });
}

// ── Canonical move → edge classification ────────────────

export type MoveEdgeType = 'support' | 'attack' | 'neutral';

export interface MoveEdgeInfo {
  edgeType: MoveEdgeType;
  defaultAttackType?: 'rebut' | 'undercut' | 'undermine';
  dual?: boolean;
}

export const MOVE_EDGE_MAP: Record<string, MoveEdgeInfo> = {
  // ── Canonical 10 dialectical moves ──
  // Names use normalized form (spaces, uppercase) — the turn validator's
  // resolveMoveName() maps all aliases/legacy names to these before lookup.

  // Support moves — create RA-nodes / "supports" edges
  'CONCEDE AND PIVOT':    { edgeType: 'support', dual: true },
  'CONCEDE':              { edgeType: 'support' },
  'INTEGRATE':            { edgeType: 'support' },
  'EXTEND':               { edgeType: 'support' },

  // Attack moves — create CA-nodes / "attacks" edges
  'COUNTEREXAMPLE':       { edgeType: 'attack', defaultAttackType: 'rebut' },
  'DISTINGUISH':          { edgeType: 'attack', defaultAttackType: 'rebut' },
  'UNDERCUT':             { edgeType: 'attack', defaultAttackType: 'undercut' },
  'EMPIRICAL CHALLENGE':  { edgeType: 'attack', defaultAttackType: 'undermine' },
  'BURDEN SHIFT':         { edgeType: 'attack', defaultAttackType: 'undercut' },
  'REFRAME':              { edgeType: 'attack', defaultAttackType: 'rebut' },

  // Neutral moves — produce standalone claims, no directed edge
  'SPECIFY':              { edgeType: 'neutral' },
};

export const SUPPORT_MOVES = new Set(
  Object.entries(MOVE_EDGE_MAP).filter(([, v]) => v.edgeType === 'support').map(([k]) => k),
);
export const ATTACK_MOVES = new Set(
  Object.entries(MOVE_EDGE_MAP).filter(([, v]) => v.edgeType === 'attack').map(([k]) => k),
);
export const NEUTRAL_MOVES = new Set(
  Object.entries(MOVE_EDGE_MAP).filter(([, v]) => v.edgeType === 'neutral').map(([k]) => k),
);

/** Word-overlap ratio between two texts (words >3 chars). Shared for convergence diagnostics. */
export function wordOverlap(a: string, b: string): number {
  const aw = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  const bw = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  if (aw.size === 0) return 0;
  const inter = [...aw].filter(w => bw.has(w)).length;
  return inter / aw.size;
}

/** Extract the move name from either a plain string or a MoveAnnotation */
export function getMoveName(item: string | MoveAnnotation): string {
  return typeof item === 'string' ? item : item.move;
}

/** Parse a POVer response JSON from the LLM */
export function parsePoverResponse(text: string): { statement: string; taxonomyRefs: TaxonomyRef[]; meta: PoverResponseMeta } {
  if (!text || typeof text !== 'string') {
    return { statement: String(text ?? ''), taxonomyRefs: [], meta: {} };
  }

  let statement: string;
  let taxonomyRefs: TaxonomyRef[] = [];
  let meta: PoverResponseMeta = {};

  try {
    const parsed = parseJsonRobust(text) as Record<string, unknown>;
    statement = (typeof parsed.statement === 'string' ? parsed.statement : String(parsed.statement ?? '')) || text.trim();
    if (Array.isArray(parsed.taxonomy_refs)) {
      taxonomyRefs = parsed.taxonomy_refs
        .filter((r: Record<string, unknown>) => r.node_id && typeof r.node_id === 'string')
        .map((r: Record<string, unknown>) => ({
          node_id: r.node_id as string,
          relevance: (r.relevance as string) || '',
        }));
    }
    // Capture enriched debate metadata
    meta = {
      move_types: Array.isArray(parsed.move_types) ? normalizeMoveTypes(parsed.move_types) : undefined,
      disagreement_type: typeof parsed.disagreement_type === 'string' ? parsed.disagreement_type : undefined,
      key_assumptions: Array.isArray(parsed.key_assumptions) ? parsed.key_assumptions : undefined,
      my_claims: Array.isArray(parsed.my_claims) ? parsed.my_claims.filter(
        (c: Record<string, unknown>) => typeof c.claim === 'string' && Array.isArray(c.targets),
      ) : undefined,
      policy_refs: Array.isArray(parsed.policy_refs) ? parsed.policy_refs.filter(
        (r: unknown) => typeof r === 'string' || (r != null && typeof r === 'object' && typeof (r as { policy_id?: unknown }).policy_id === 'string'),
      ) : undefined,
      position_update: typeof parsed.position_update === 'string' ? parsed.position_update : undefined,
      turn_symbols: Array.isArray(parsed.turn_symbols) ? parsed.turn_symbols.filter(
        (s: Record<string, unknown>) => typeof s.symbol === 'string' && typeof s.tooltip === 'string',
      ) : undefined,
    };
  } catch {
    // Fallback: look for a JSON object with "statement" embedded after preamble text
    const jsonIdx = text.indexOf('{\n  "statement"');
    const jsonIdx2 = text.indexOf('{"statement"');
    const idx = jsonIdx >= 0 ? jsonIdx : jsonIdx2;
    if (idx > 0) {
      try {
        const parsed = parseJsonRobust(text.slice(idx)) as Record<string, unknown>;
        statement = (typeof parsed.statement === 'string' ? parsed.statement : String(parsed.statement ?? '')) || text.trim();
        if (Array.isArray(parsed.taxonomy_refs)) {
          taxonomyRefs = parsed.taxonomy_refs
            .filter((r: Record<string, unknown>) => r.node_id && typeof r.node_id === 'string')
            .map((r: Record<string, unknown>) => ({ node_id: r.node_id as string, relevance: (r.relevance as string) || '' }));
        }
        meta = {
          move_types: Array.isArray(parsed.move_types) ? normalizeMoveTypes(parsed.move_types) : undefined,
          disagreement_type: typeof parsed.disagreement_type === 'string' ? parsed.disagreement_type : undefined,
          key_assumptions: Array.isArray(parsed.key_assumptions) ? parsed.key_assumptions : undefined,
          my_claims: Array.isArray(parsed.my_claims) ? parsed.my_claims : undefined,
          policy_refs: Array.isArray(parsed.policy_refs) ? parsed.policy_refs : undefined,
          turn_symbols: Array.isArray(parsed.turn_symbols) ? parsed.turn_symbols.filter(
            (s: Record<string, unknown>) => typeof s.symbol === 'string' && typeof s.tooltip === 'string',
          ) : undefined,
        };
      } catch {
        statement = text.trim();
      }
    } else {
      statement = text.trim();
    }
  }

  return { statement, taxonomyRefs, meta };
}

export function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

export function looksTruncated(s: string): boolean {
  if (!s) return false;
  const trimmed = s.trimEnd();
  if (trimmed.length === 0) return false;
  let depth = 0;
  for (const c of trimmed) {
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
  }
  if (depth > 0) return true;
  const last = trimmed.slice(-1);
  return !(last === '}' || last === ']' || last === '"');
}

export function defaultGraphAttributes(pov: Pov, category: Category): GraphAttributes {
  const epistemicByCategory: Record<Category, string> = {
    Beliefs: 'empirical_claim',
    Desires: 'normative_prescription',
    Intentions: 'strategic_recommendation',
  };
  const scopeByCategory: Record<Category, 'claim' | 'scheme'> = {
    Beliefs: 'claim',
    Desires: 'claim',
    Intentions: 'scheme',
  };
  const rhetoricalByPov: Record<Pov, string> = {
    accelerationist: 'techno_optimism',
    safetyist: 'precautionary_framing',
    skeptic: 'structural_critique',
  };
  const emotionalByPov: Record<Pov, string> = {
    accelerationist: 'aspirational',
    safetyist: 'cautionary',
    skeptic: 'measured',
  };
  return {
    epistemic_type: epistemicByCategory[category],
    rhetorical_strategy: rhetoricalByPov[pov],
    emotional_register: emotionalByPov[pov],
    node_scope: scopeByCategory[category],
    assumes: [],
    falsifiability: 'medium',
  };
}

/**
 * Find the existing node with the highest word-overlap against `text`.
 * Returns both the overlap score and the argmax node (null when `existing` is empty
 * or nothing overlaps). Callers that only need the scalar can use
 * {@link maxOverlapVsExisting}, which delegates here.
 */
export function bestOverlapMatch<T extends { text: string }>(
  text: string,
  existing: T[],
): { overlap: number; node: T | null } {
  let max = 0;
  let best: T | null = null;
  for (const n of existing) {
    const o = wordOverlap(text, n.text);
    if (o > max) {
      max = o;
      best = n;
    }
  }
  return { overlap: max, node: best };
}

export function maxOverlapVsExisting(text: string, existing: { text: string }[]): number {
  return bestOverlapMatch(text, existing).overlap;
}

export function lookupTaxonomyEdgeWeight(
  sourceRefs: string[],
  targetRefs: string[],
  taxonomyEdges?: { source: string; target: string; weight?: number; modulated_weight?: number }[],
): number | undefined {
  if (!taxonomyEdges || sourceRefs.length === 0 || targetRefs.length === 0) return undefined;
  const srcSet = new Set(sourceRefs);
  const tgtSet = new Set(targetRefs);
  let best: number | undefined;
  for (const e of taxonomyEdges) {
    const w = e.modulated_weight ?? e.weight;
    if (w == null) continue;
    const match = (srcSet.has(e.source) && tgtSet.has(e.target))
      || (srcSet.has(e.target) && tgtSet.has(e.source));
    if (match && (best === undefined || w > best)) {
      best = w;
    }
  }
  return best;
}
