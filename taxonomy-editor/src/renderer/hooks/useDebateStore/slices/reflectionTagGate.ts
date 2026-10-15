// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4214 R-2 and R-3 (spec t/4211 §3, §4): tag-aware reflection. A tagged Skeptic seat speaks for one wing, so
// its edits to another wing's nodes, or edits that contradict a co-owning wing, must not land silently.
//   R-2 `annotateTagChecks`: after the DOLCE retries, stamp each revise/qualify/deprecate edit with its tag
//        relation (D-1), the custodian verdicts (D-2, one model call at temperature 0), the target's tag
//        fingerprint and a hash of the checked text.
//   R-3 `evaluateTagGate`: at apply time, refuse `foreign`, `conflict`, `unchecked` and stale-stamp edits unless
//        the reviewer overrides (`allowCrossTag`). `tension` blocks the same way while TENSION_NEEDS_CONFIRMATION
//        holds (interim rule, t/4214#6). It fails closed: a missing or failed check blocks rather than passes.

import { classifyTagRelation, type PovTagEntry, type TagRelation } from '@lib/debate/reflectionScope';
import {
  buildCustodianCheckPrompt, parseCustodianCheckOutput,
  type CustodianCheckInput, type CustodianCheckSoul, type CustodianVerdictRow,
} from '@lib/debate/prompts/reflectionTagCheck';
import { resolvePoverInfo } from '@lib/debate/tagSoulRegistry';
import { loadPovTagRegistry } from '@lib/schema/povTags';
import { hashString } from '@lib/debate/helpers';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { resolveBackend, type ModelRegistry } from '@lib/ai-client/registry';
import aiModelsRegistry from '../../../../../../ai-models.json';
import type { PovInfo, SpeakerId } from '@lib/debate/types';
import type { ReflectionEdit, ReflectionTagCheck } from '../types';

type Speaker = Exclude<SpeakerId, 'user'>;
type GenerateText = (prompt: string, model: string, timeoutMs?: number, temperature?: number) => Promise<{ text: string }>;

const CHECKED_EDIT_TYPES = new Set(['revise', 'qualify', 'deprecate']);

/** The POV's tag entries as D-1 wants them; `[]` for a POV with no tags. */
export function povTagEntries(pov: string): PovTagEntry[] {
  const entries = loadPovTagRegistry().povs[pov as keyof ReturnType<typeof loadPovTagRegistry>['povs']] ?? [];
  return entries.map(e => ({ id: e.id, soul_doc: e.soul_doc }));
}

/** The target's tags as a stable fingerprint; a tag change after the check makes the stamp stale. */
export function tagsFingerprint(tags: readonly string[] | undefined): string {
  return [...(tags ?? [])].sort().join(',');
}

/** A hash of the text the custodians judged; a reviewer label/description override makes the stamp stale. */
export function checkedTextHash(label: string, description: string): string {
  return hashString(`${label}\n${description}`);
}

/** A custodian soul id (`skeptic` or `skeptic.institutional`) as the judge's input. */
function custodianSoul(soulId: string): CustodianCheckSoul {
  const [speaker, tag] = soulId.split('.') as [Speaker, string | undefined];
  const soul: PovInfo = tag ? resolvePoverInfo(speaker, { tag, mode: 'scope' }).soul : resolvePoverInfo(speaker).soul;
  const rec = soul as unknown as { value_hierarchy?: string[] };
  return {
    soul: soulId,
    label: tag ? `${soul.label} (${tag})` : soul.label,
    value_hierarchy: rec.value_hierarchy ?? [],
    boundaries: { hardcoded: soul.boundaries?.hardcoded ?? [], softcoded: soul.boundaries?.softcoded ?? [] },
  };
}

/**
 * The model the custodian check runs on, whatever model the reflection itself used (CL p/785#34). M1 v2 (PR #3318)
 * passed on it (conflict kappa 0.85, n=46; flag kappa 0.65; 0% unchecked) and failed on flash-lite (flag kappa
 * 0.41). Spec section 4: changing it needs a fresh M1 run. No fallback model (CL p/785#38): without a key for its
 * backend the calls are skipped and each edit is stamped `unchecked` (fails closed), never passed.
 */
export const CUSTODIAN_CHECK_MODEL = 'gemini-3.1-pro-preview';

/** The pinned model's backend, from the registry (never from the id prefix). */
export const CUSTODIAN_CHECK_BACKEND = resolveBackend(CUSTODIAN_CHECK_MODEL, aiModelsRegistry as Pick<ModelRegistry, 'models'>);

/** The reviewer-facing reason when the backend has no key (CL p/785#38). */
export const NO_CHECK_KEY_REASON =
  `Tag check needs a Gemini API key (the judge is pinned to ${CUSTODIAN_CHECK_MODEL}). Add GEMINI_API_KEY, or review and confirm each flagged edit.`;

interface AnnotateContext {
  pov: string;
  seatTag: string | null;
  /** Current `pov_tags` of a node by id (from the live taxonomy). */
  nodeTags: (nodeId: string) => string[] | undefined;
  generateText: GenerateText;
  /** Whether CUSTODIAN_CHECK_BACKEND has a key; asked at most once per run, and only when an edit needs a check. */
  hasCheckKey: () => Promise<boolean>;
  debateId?: string;
}

/**
 * The key check, memoised for one run. If the lookup itself fails, the calls are tried anyway: each then fails
 * or succeeds on its own, with its real error text in the `unchecked` reason.
 */
function memoisedKeyCheck(ctx: AnnotateContext): () => Promise<boolean> {
  let answer: Promise<boolean> | undefined;
  // Promise.resolve().then: a lookup that throws synchronously is caught the same way as a rejected one.
  return () => (answer ??= Promise.resolve().then(() => ctx.hasCheckKey()).catch((err) => {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'reflection-tag-check', level: 'warn', debate_id: ctx.debateId,
      message: 'reflection tag check: the API-key lookup failed; trying the custodian calls anyway',
      data: { backend: CUSTODIAN_CHECK_BACKEND },
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return true;
  }));
}

/** Run the custodian check for one edit; any failure is `unchecked`, logged, never thrown. */
async function runCustodianCheck(
  edit: ReflectionEdit, targetTags: string[], custodians: string[], ctx: AnnotateContext,
): Promise<{ verdicts?: CustodianVerdictRow[]; unchecked?: string }> {
  try {
    // The same params go to the prompt and the parser: the parser verifies citations and evidence against them.
    const checkParams: CustodianCheckInput = {
      editType: edit.edit_type as 'revise' | 'qualify' | 'deprecate',
      currentLabel: edit.current_label ?? '',
      currentDescription: edit.current_description ?? '',
      proposedLabel: edit.proposed_label,
      proposedDescription: edit.proposed_description,
      rationale: edit.rationale,
      nodeTags: targetTags,
      seatTag: ctx.seatTag,
      custodians: custodians.map(custodianSoul),
    };
    const prompt = buildCustodianCheckPrompt(checkParams);
    const { text } = await ctx.generateText(prompt, CUSTODIAN_CHECK_MODEL, undefined, 0);
    const out = parseCustodianCheckOutput(text, checkParams);
    if ('unchecked' in out) {
      getGlobalRecorder()?.record({
        type: 'state.error', component: 'reflection-tag-check', level: 'warn', debate_id: ctx.debateId,
        message: `reflection tag check unusable for ${edit.node_id}; the edit is flagged unchecked: ${out.unchecked}`,
        data: { node_id: edit.node_id, custodians, reason: out.unchecked },
      });
      return { unchecked: out.unchecked };
    }
    return { verdicts: out.verdicts };
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'reflection-tag-check', level: 'warn', debate_id: ctx.debateId,
      message: `reflection tag check failed for ${edit.node_id}; the edit is flagged unchecked`,
      data: { node_id: edit.node_id, custodians },
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return { unchecked: `the tag check failed: ${String(err)}` };
  }
}

/** The relation-level outcome, before any custodian verdicts. */
function relationOutcome(relation: TagRelation, edit: ReflectionEdit, seatTag: string | null): { needsCheck: boolean; conflictNote?: string } {
  if (relation === 'shared' && edit.edit_type === 'deprecate' && seatTag) {
    // Spec §3 rule 4: deprecating shared ground removes it from the other wing too.
    return { needsCheck: false, conflictNote: `To drop this node from ${seatTag} only, remove the ${seatTag} tag instead (pov-tag proposal queue).` };
  }
  return { needsCheck: relation === 'shared' || relation === 'untagged_target' || relation === 'umbrella_on_tagged' };
}

/**
 * R-2: stamp every revise/qualify/deprecate edit with its tag check, in place. A POV with no tags gets a
 * `no_tags` stamp and no model call, so Accelerationist and Safetyist reflections cost nothing extra.
 */
export async function annotateTagChecks(edits: ReflectionEdit[], ctx: AnnotateContext, isStillValid: () => boolean): Promise<void> {
  const registry = povTagEntries(ctx.pov);
  const hasKey = memoisedKeyCheck(ctx);
  let skippedNoKey = 0;
  for (const edit of edits) {
    if (!edit.node_id || !CHECKED_EDIT_TYPES.has(edit.edit_type)) continue;
    if (!isStillValid()) return;
    const targetTags = ctx.nodeTags(edit.node_id) ?? [];
    const { relation, custodians } = classifyTagRelation(ctx.seatTag, targetTags, registry);
    const { needsCheck, conflictNote } = relationOutcome(relation, edit, ctx.seatTag);
    let check: { verdicts?: CustodianVerdictRow[]; unchecked?: string } = {};
    if (needsCheck && custodians.length > 0) {
      if (await hasKey()) check = await runCustodianCheck(edit, targetTags, custodians, ctx);
      else { check = { unchecked: NO_CHECK_KEY_REASON }; skippedNoKey++; }
    }
    const stamp: ReflectionTagCheck = {
      relation,
      custodians,
      seat_tag: ctx.seatTag,
      target_tags: targetTags,
      tags_fp: tagsFingerprint(targetTags),
      text_hash: checkedTextHash(edit.proposed_label, edit.proposed_description),
      ...(check.verdicts ? { verdicts: check.verdicts, model: CUSTODIAN_CHECK_MODEL } : {}),
      ...(check.unchecked ? { unchecked: check.unchecked, model: CUSTODIAN_CHECK_MODEL } : {}),
      ...(conflictNote ? { deprecate_shared_note: conflictNote } : {}),
    };
    edit.tag_check = stamp;
  }
  if (skippedNoKey > 0) {
    // One WARN per run with the count, not one per edit (CL p/785#38).
    getGlobalRecorder()?.record({
      type: 'state.error', component: 'reflection-tag-check', level: 'warn', debate_id: ctx.debateId,
      message: `reflection tag check skipped: no API key for ${CUSTODIAN_CHECK_BACKEND}; ${skippedNoKey} edit(s) left unchecked for the reviewer to confirm`,
      data: { backend: CUSTODIAN_CHECK_BACKEND, model: CUSTODIAN_CHECK_MODEL, unchecked_count: skippedNoKey, pov: ctx.pov },
    });
  }
}

/**
 * Interim rule (CL ruling t/4214#6, M1 calibration PR #3310): the judge is reliable at the flag level (κ 0.69) but
 * not yet at telling `tension` from `conflict` (κ 0.35, n=34). So both need the reviewer's confirmation before apply;
 * the verdict and citation are shown either way, and `conflict` is no stronger a block than `tension`.
 * LIFTED (t/4230): the v2 judge on CUSTODIAN_CHECK_MODEL passed M1 report section 5.2 (CL p/785#34, PR #3318), so
 * `tension` is shown but no longer blocks, and the panel drops "Possible". Set it back to true only if a fresh M1
 * run on the pinned model fails again.
 */
export const TENSION_NEEDS_CONFIRMATION = false;

/**
 * Whether a tag-gate block refuses the apply (CL p/785#5). ON since R-6, whose ReflectionsPanel shows the block
 * reason and arms an explicit "Apply anyway (cross-wing)" override (`allowCrossTag`). Set to false only if that
 * confirm path is lost: while off, a block is recorded as a WARN (`applyReflectionEdit.cross_tag_would_block`) and
 * returned as a note, and the edit applies.
 */
export const TAG_GATE_ENFORCED = true;

export type TagGateBlock = 'foreign' | 'conflict' | 'tension' | 'unchecked' | 'stale';

export interface TagGateResult {
  /** Why the edit is refused without an override, or null when it may apply. */
  block: TagGateBlock | null;
  /** The reviewer-facing reason. */
  reason: string;
}

/**
 * R-3: decide whether an edit may apply as-is. `liveTags` is the node's current `pov_tags`; `finalLabel` and
 * `finalDescription` are what will actually be written (after any reviewer override).
 */
export function evaluateTagGate(
  edit: ReflectionEdit, pov: string, liveTags: string[] | undefined, finalLabel: string, finalDescription: string,
  tensionNeedsConfirmation: boolean = TENSION_NEEDS_CONFIRMATION,
): TagGateResult {
  if (!edit.node_id || !CHECKED_EDIT_TYPES.has(edit.edit_type)) return { block: null, reason: '' };
  if (povTagEntries(pov).length === 0) return { block: null, reason: '' };
  const stamp = edit.tag_check;
  if (!stamp) return { block: 'unchecked', reason: 'This edit has no tag check (it predates tag-aware reflection). Re-run reflection, or apply anyway to override.' };
  if (stamp.tags_fp !== tagsFingerprint(liveTags) || stamp.text_hash !== checkedTextHash(finalLabel, finalDescription)) {
    return { block: 'stale', reason: "The node's tags or the edited text changed since the tag check. Re-run the tag check, or apply anyway to override." };
  }
  if (stamp.relation === 'foreign') {
    return { block: 'foreign', reason: `This node belongs to ${stamp.target_tags.join(', ')}, not ${stamp.seat_tag}.` };
  }
  if (stamp.deprecate_shared_note) return { block: 'conflict', reason: stamp.deprecate_shared_note };
  if (stamp.unchecked) return { block: 'unchecked', reason: `The tag check could not be completed: ${stamp.unchecked}` };
  return verdictGate(stamp.verdicts ?? [], tensionNeedsConfirmation);
}

/** The custodian verdicts' outcome: `conflict` blocks; `tension` blocks only under the interim rule. */
function verdictGate(verdicts: CustodianVerdictRow[], tensionNeedsConfirmation: boolean): TagGateResult {
  const conflict = verdicts.find(v => v.verdict === 'conflict');
  if (conflict) return { block: 'conflict', reason: `Conflicts with ${conflict.soul}${citedText(conflict)}. ${conflict.reason}` };
  const tension = tensionNeedsConfirmation ? verdicts.find(v => v.verdict === 'tension') : undefined;
  if (tension) return { block: 'tension', reason: `In tension with ${tension.soul}${citedText(tension)}. ${tension.reason} Confirm to apply.` };
  return { block: null, reason: '' };
}

/** The quoted citation, or a note when the parser dropped an unverified one (a tension citation can be null). */
function citedText(v: CustodianVerdictRow): string {
  return v.cited ? `: "${v.cited}"` : ' (no verified citation)';
}
