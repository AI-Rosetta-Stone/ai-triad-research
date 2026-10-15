// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Custodian-check prompt and output parser for tag-aware reflection (t/4213 D-2).
//
// One model call per checked edit, covering every custodian soul at once (spec §4).
// Temperature 0 — the check is a yes/no gate, not a creative task.
//
// CL has mandatory review of this prompt's wording before merge.

import { parseAIJson } from '../helpers.js';

// ── Input types ────────────────────────────────────────────────────────────

export interface CustodianCheckSoul {
  /** Soul id, e.g. 'skeptic.institutional' */
  soul: string;
  label: string;
  value_hierarchy: string[];
  boundaries: {
    hardcoded: string[];
    softcoded: string[];
  };
}

export interface CustodianCheckInput {
  editType: 'revise' | 'qualify' | 'deprecate';
  currentLabel: string;
  currentDescription: string;
  proposedLabel: string;
  proposedDescription: string;
  /** The reflector's stated rationale for the edit. */
  rationale: string;
  /** The target node's pov_tags (e.g. ['critical', 'institutional']). */
  nodeTags: string[];
  /** The seat's pov_tag, or null for an untagged seat. */
  seatTag: string | null;
  custodians: CustodianCheckSoul[];
}

// ── Output types ───────────────────────────────────────────────────────────

export type CustodianVerdict = 'consistent' | 'tension' | 'conflict';

export interface CustodianVerdictRow {
  soul: string;
  verdict: CustodianVerdict;
  /** Verbatim boundary or value text that was triggered, or null for 'consistent'. */
  cited: string | null;
  reason: string;
}

export interface CustodianCheckResult {
  verdicts: CustodianVerdictRow[];
}

/** Returned when the output cannot be trusted: missing verdict, invalid value, or conflict with no citation. */
export interface CustodianUnchecked {
  unchecked: string;
}

export type CustodianCheckOutput = CustodianCheckResult | CustodianUnchecked;

// ── Prompt builder ─────────────────────────────────────────────────────────

export function buildCustodianCheckPrompt(params: CustodianCheckInput): string {
  const {
    editType,
    currentLabel, currentDescription,
    proposedLabel, proposedDescription,
    rationale,
    nodeTags, seatTag,
    custodians,
  } = params;

  const nodeTagLine = nodeTags.length > 0
    ? `Node tags: [${nodeTags.join(', ')}]`
    : 'Node tags: [none — untagged node]';
  const seatTagLine = seatTag != null
    ? `Editing seat tag: ${seatTag}`
    : 'Editing seat: untagged (umbrella)';

  const custodianBlocks = custodians.map(c => `
=== CUSTODIAN: ${c.soul} (${c.label}) ===

Value hierarchy (rank order, most important first):
${c.value_hierarchy.map((v, i) => `  ${i + 1}. ${v}`).join('\n')}

Hardcoded boundaries (must never be violated):
${c.boundaries.hardcoded.map(b => `  • ${b}`).join('\n')}

Softcoded boundaries (should not be strained without clear reason):
${c.boundaries.softcoded.map(b => `  • ${b}`).join('\n')}`).join('\n');

  return `You are a neutral judge checking whether a proposed taxonomy-node edit stays true to a set of custodian souls.

Your task: for each custodian soul listed below, decide whether the PROPOSED text is consistent, in tension, or in conflict with that soul's position.

== THE EDIT ==

Edit type: ${editType}
${nodeTagLine}
${seatTagLine}

Current label: "${currentLabel}"
Current description: ${currentDescription}

Proposed label: "${proposedLabel}"
Proposed description: ${proposedDescription}

Reflector's rationale: ${rationale}

== JUDGING INSTRUCTIONS ==

Judge ONLY what the proposed text INTRODUCES compared to the current text. A change that keeps an existing conflict without making it worse is CONSISTENT.

For each custodian soul:
- CONFLICT: the proposed text asserts something a hardcoded boundary explicitly forbids, OR it inverts the order of two values in the custodian's value hierarchy.
- TENSION: the proposed text strains a softcoded boundary, or shifts emphasis between values without inverting them.
- CONSISTENT: neither of the above.

For CONFLICT and TENSION: quote the exact boundary or value text that is triggered in "cited". For CONSISTENT: set "cited" to null.

Do not judge writing quality or whether the custodian would have phrased it differently — judge only whether the proposed text is false or unacceptable to the custodian.

== CUSTODIAN SOULS ==
${custodianBlocks}

== OUTPUT FORMAT ==

Respond with a JSON object exactly matching this schema. A verdict is REQUIRED for every custodian listed above.

{
  "verdicts": [
    {
      "soul": "<soul id, e.g. skeptic.institutional>",
      "verdict": "consistent" | "tension" | "conflict",
      "cited": "<verbatim boundary or value text, or null>",
      "reason": "<one sentence>"
    }
  ]
}`;
}

// ── Output parser ──────────────────────────────────────────────────────────

const VALID_VERDICTS = new Set<string>(['consistent', 'tension', 'conflict']);

/**
 * Parse the model output from a custodian check call.
 *
 * Returns `{ unchecked: reason }` when:
 * - the JSON is unparseable
 * - any custodian from the input has a missing verdict
 * - any verdict value is not 'consistent' | 'tension' | 'conflict'
 * - any 'conflict' verdict has a null or empty 'cited' field
 *
 * These conditions are all treated as unchecked (fails closed, spec §3).
 */
export function parseCustodianCheckOutput(
  raw: string,
  expectedSouls: string[],
): CustodianCheckOutput {
  const parsed = parseAIJson(raw);
  if (parsed === null) {
    return { unchecked: 'model output was not valid JSON' };
  }

  if (typeof parsed !== 'object' || !('verdicts' in parsed)) {
    return { unchecked: 'model output missing "verdicts" field' };
  }

  const rawVerdicts = (parsed as { verdicts: unknown }).verdicts;
  if (!Array.isArray(rawVerdicts)) {
    return { unchecked: '"verdicts" is not an array' };
  }

  const bySOul = new Map<string, unknown>();
  for (const row of rawVerdicts) {
    if (row && typeof row === 'object' && typeof (row as Record<string, unknown>).soul === 'string') {
      bySOul.set((row as Record<string, unknown>).soul as string, row);
    }
  }

  const verdicts: CustodianVerdictRow[] = [];
  for (const soul of expectedSouls) {
    const row = bySOul.get(soul);
    if (!row || typeof row !== 'object') {
      return { unchecked: `missing verdict for custodian ${soul}` };
    }
    const r = row as Record<string, unknown>;
    const verdict = r.verdict;
    if (typeof verdict !== 'string' || !VALID_VERDICTS.has(verdict)) {
      return { unchecked: `invalid verdict value "${String(verdict)}" for custodian ${soul}` };
    }
    const cited = r.cited === null || r.cited === undefined ? null : String(r.cited);
    if (verdict === 'conflict' && !cited) {
      return { unchecked: `conflict verdict for ${soul} has no citation — cannot verify` };
    }
    const reason = typeof r.reason === 'string' ? r.reason : String(r.reason ?? '');
    verdicts.push({ soul, verdict: verdict as CustodianVerdict, cited, reason });
  }

  return { verdicts };
}
