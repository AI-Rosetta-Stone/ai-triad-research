// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { checkTagScope } from '@lib/debate/relevanceSelection';
import type { PovNode } from '@lib/debate/taxonomyTypes';
import type { SeatTag, TagMode } from '@lib/debate/types';
import { loadPovTagRegistry, type PovTagRegistry } from '@lib/schema/povTags';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import './SeatTagPicker.css';

export type PovName = 'accelerationist' | 'safetyist' | 'skeptic';

/** The bundled registry, or `null` on a load failure (malformed committed file) —
 *  callers render no picker rather than crash the setup dialog. */
export function registryOrNull(): PovTagRegistry | null {
  try {
    return loadPovTagRegistry();
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'new-debate-dialog', level: 'warn',
      message: 'POV tag registry failed to load; seat tag pickers hidden (t/3958)',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return null;
  }
}

/** The seat's active tag label, e.g. "Critical", or `undefined` if untagged or the
 *  tag was retired from the registry after selection. */
export function seatTagLabel(pov: PovName, seatTag: SeatTag | undefined, registry: PovTagRegistry | null): string | undefined {
  if (!seatTag) return undefined;
  return registry?.povs[pov]?.find(t => t.id === seatTag.pov_tag)?.label;
}

/** Setup-time refusal (TL t/3957#7 cond B(a), t/3958#2/#3): Scope needs `checkTagScope`'s
 *  fixed floor; Prioritize has no floor but refuses at zero tagged nodes — otherwise a whole
 *  seat would run under a tag soul's persona (t/3957#5 cond A: the tag soul REPLACES the base
 *  soul) backing no actual tagged content. `undefined` ⇒ this seat does not block Start. */
export function seatTagRefusal(povNodes: PovNode[], seatTag: SeatTag | undefined): { inScope: number; excluded: number; minimum?: number } | undefined {
  if (!seatTag) return undefined;
  const { inScope, excluded, sufficient } = checkTagScope(povNodes, { tag: seatTag.pov_tag, mode: seatTag.tag_mode });
  if (seatTag.tag_mode === 'scope' && !sufficient) return { inScope: inScope.length, excluded: excluded.length, minimum: 5 };
  if (seatTag.tag_mode === 'prioritize' && inScope.length === 0) return { inScope: 0, excluded: excluded.length };
  return undefined;
}

/** TL p/696#6: the insufficient-scope message must show all three values — in-scope count,
 *  excluded count, and the minimum — not just in-scope and minimum. Shared by SeatTagPicker's
 *  own inline refusal and NewDebateDialog's banner so the wording only lives once. */
export function seatTagIssueMessage(refusal: NonNullable<ReturnType<typeof seatTagRefusal>>): string {
  return refusal.minimum
    ? `Only ${refusal.inScope} in scope, ${refusal.excluded} excluded (minimum ${refusal.minimum})`
    : 'No nodes carry this tag';
}

interface SeatTagPickerProps {
  pov: PovName;
  povNodes: PovNode[];
  registry: PovTagRegistry | null;
  seatTag: SeatTag | undefined;
  onChange: (seatTag: SeatTag | undefined) => void;
}

/** Per-seat tag + SCOPE/PRIORITIZE picker (t/3958; spec §4). Renders nothing when the
 *  registry has no tags for `pov`. */
export function SeatTagPicker({ pov, povNodes, registry, seatTag, onChange }: SeatTagPickerProps) {
  const entries = registry?.povs[pov] ?? [];
  if (entries.length === 0) return null;

  const handleTagChange = (tagId: string) => {
    if (!tagId) { onChange(undefined); return; }
    onChange({ pov_tag: tagId, tag_mode: seatTag?.tag_mode ?? 'scope' });
  };

  const handleModeChange = (mode: TagMode) => {
    if (!seatTag) return;
    onChange({ ...seatTag, tag_mode: mode });
  };

  const refusal = seatTagRefusal(povNodes, seatTag);
  const scopeCount = seatTag?.tag_mode === 'scope'
    ? checkTagScope(povNodes, { tag: seatTag.pov_tag, mode: seatTag.tag_mode })
    : undefined;

  return (
    <div className="seat-tag-picker">
      <select
        className="seat-tag-picker-select"
        aria-label={`Tag for ${pov}`}
        value={seatTag?.pov_tag ?? ''}
        onChange={e => handleTagChange(e.target.value)}
      >
        <option value="">None</option>
        {entries.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
      </select>

      {seatTag && (
        <div className="seat-tag-picker-mode" role="radiogroup" aria-label="Tag mode">
          <label className={`seat-tag-picker-mode-opt${seatTag.tag_mode === 'scope' ? ' active' : ''}`}>
            <input type="radio" name={`seat-tag-mode-${pov}`} checked={seatTag.tag_mode === 'scope'} onChange={() => handleModeChange('scope')} />
            Scope
          </label>
          <label className={`seat-tag-picker-mode-opt${seatTag.tag_mode === 'prioritize' ? ' active' : ''}`}>
            <input type="radio" name={`seat-tag-mode-${pov}`} checked={seatTag.tag_mode === 'prioritize'} onChange={() => handleModeChange('prioritize')} />
            Prioritize
          </label>
        </div>
      )}

      {scopeCount && (
        // t/4275: "untagged" over-claimed — excluded nodes may carry a different wing's tag (94 of 100 on prod).
        <div className="seat-tag-picker-count">{scopeCount.inScope.length} in scope, {scopeCount.excluded.length} not tagged {seatTagLabel(pov, seatTag, registry) ?? seatTag?.pov_tag}</div>
      )}

      {refusal && (
        <div className="seat-tag-picker-refusal" role="alert">{seatTagIssueMessage(refusal)} — pick a different tag or mode.</div>
      )}
    </div>
  );
}
