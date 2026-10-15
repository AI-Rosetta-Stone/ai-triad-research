// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4214 R-2 and R-3 (spec t/4211 §3, §4): tag-aware reflection. A tagged Skeptic seat speaks for one wing, so
// its edits to another wing's nodes, or edits that contradict a co-owning wing, must not land silently.
//   R-2 `annotateTagChecks`: after the DOLCE retries, stamp each revise/qualify/deprecate edit with its tag
//        relation (D-1), the custodian verdicts (D-2, one model call at temperature 0), the target's tag
//        fingerprint and a hash of the checked text.
//   R-3 `evaluateTagGate`: at apply time, refuse `foreign`, `conflict`, `unchecked` and stale-stamp edits unless
//        the reviewer overrides (`allowCrossTag`). `tension` is shown, never blocking. It fails closed: a missing
//        or failed check blocks rather than passes.

import { classifyTagRelation, type PovTagEntry, type TagRelation } from '@lib/debate/reflectionScope';
import {
  buildCustodianCheckPrompt, parseCustodianCheckOutput,
  type CustodianCheckSoul, type CustodianVerdictRow,
} from '@lib/debate/prompts/reflectionTagCheck';
import { resolvePoverInfo } from '@lib/debate/tagSoulRegistry';
import { loadPovTagRegistry } from '@lib/schema/povTags';
import { hashString } from '@lib/debate/helpers';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
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

interface AnnotateContext {
  pov: string;
  seatTag: string | null;
  model: string;
  /** Current `pov_tags` of a node by id (from the live taxonomy). */
  nodeTags: (nodeId: string) => string[] | undefined;
  generateText: GenerateText;
  debateId?: string;
}

/** Run the custodian check for one edit; any failure is `unchecked`, logged, never thrown. */
async function runCustodianCheck(
  edit: ReflectionEdit, targetTags: string[], custodians: string[], ctx: AnnotateContext,
): Promise<{ verdicts?: CustodianVerdictRow[]; unchecked?: string }> {
  try {
    const prompt = buildCustodianCheckPrompt({
      editType: edit.edit_type as 'revise' | 'qualify' | 'deprecate',
      currentLabel: edit.current_label ?? '',
      currentDescription: edit.current_description ?? '',
      proposedLabel: edit.proposed_label,
      proposedDescription: edit.proposed_description,
      rationale: edit.rationale,
      nodeTags: targetTags,
      seatTag: ctx.seatTag,
      custodians: custodians.map(custodianSoul),
    });
    const { text } = await ctx.generateText(prompt, ctx.model, undefined, 0);
    const out = parseCustodianCheckOutput(text, custodians);
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
  for (const edit of edits) {
    if (!edit.node_id || !CHECKED_EDIT_TYPES.has(edit.edit_type)) continue;
    if (!isStillValid()) return;
    const targetTags = ctx.nodeTags(edit.node_id) ?? [];
    const { relation, custodians } = classifyTagRelation(ctx.seatTag, targetTags, registry);
    const { needsCheck, conflictNote } = relationOutcome(relation, edit, ctx.seatTag);
    const check = needsCheck && custodians.length > 0 ? await runCustodianCheck(edit, targetTags, custodians, ctx) : {};
    const stamp: ReflectionTagCheck = {
      relation,
      custodians,
      seat_tag: ctx.seatTag,
      target_tags: targetTags,
      tags_fp: tagsFingerprint(targetTags),
      text_hash: checkedTextHash(edit.proposed_label, edit.proposed_description),
      ...(check.verdicts ? { verdicts: check.verdicts, model: ctx.model } : {}),
      ...(check.unchecked ? { unchecked: check.unchecked, model: ctx.model } : {}),
      ...(conflictNote ? { deprecate_shared_note: conflictNote } : {}),
    };
    edit.tag_check = stamp;
  }
}

export type TagGateBlock = 'foreign' | 'conflict' | 'unchecked' | 'stale';

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
  const conflict = stamp.verdicts?.find(v => v.verdict === 'conflict');
  if (conflict) return { block: 'conflict', reason: `Conflicts with ${conflict.soul}: "${conflict.cited}". ${conflict.reason}` };
  return { block: null, reason: '' };
}
