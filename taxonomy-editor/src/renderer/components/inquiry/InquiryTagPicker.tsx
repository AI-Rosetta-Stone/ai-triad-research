// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4246: the Ask panel's POV tag picker. An inquiry takes one tag for one camp (`tagSelection`,
// t/3965), so the user picks the camp, then the tag, then Scope or Prioritize. The same floor
// rules as chat apply (tagBlockedReason). Only camps whose registry has tags are offered; with no
// tags anywhere, nothing renders.

import { useState } from 'react';
import { checkTagScope } from '@lib/debate/relevanceSelection';
import { loadPovTagRegistry, type PovName, type TagMode, type TagSelection } from '@lib/schema/povTags';
import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';
import { tagBlockedReason } from '../chat/ChatTagPicker';
import './InquiryTagPicker.css';

const POV_LABELS: Record<PovName, string> = { accelerationist: 'Accelerationist', safetyist: 'Safetyist', skeptic: 'Skeptic' };

/** Camps that have registry tags, in display order. */
export function taggedPovs(): PovName[] {
  const povs = loadPovTagRegistry().povs;
  return (Object.keys(POV_LABELS) as PovName[]).filter(p => (povs[p] ?? []).length > 0);
}

/** The scope a selection would have, or null when the camp's nodes aren't loaded (nothing to count). */
function scopeOf(sel: TagSelection) {
  const nodes = useTaxonomyStore.getState()[sel.pov]?.nodes ?? [];
  return nodes.length > 0 ? checkTagScope(nodes, { tag: sel.tag, mode: sel.mode }) : null;
}

/**
 * Why this selection can't run, or `undefined`. Only judged when the camp's nodes are loaded: with
 * nothing to count, the UI doesn't refuse, and the server's own floor check decides.
 */
export function inquiryTagBlocked(sel: TagSelection | undefined): string | undefined {
  if (!sel) return undefined;
  return tagBlockedReason(scopeOf(sel), sel.mode);
}

export function InquiryTagPicker({ value, onChange }: { value: TagSelection | undefined; onChange: (sel: TagSelection | undefined) => void }) {
  const povs = taggedPovs();
  // With no selection, the camp menu only steers which tags the tag menu lists.
  const [browsePov, setBrowsePov] = useState<PovName | undefined>(undefined);
  if (povs.length === 0) return null;

  const pov = value?.pov ?? browsePov ?? povs[0];
  const entries = loadPovTagRegistry().povs[pov] ?? [];
  const scope = value ? scopeOf(value) : null;
  const blocked = inquiryTagBlocked(value);

  const pickPov = (next: PovName) => { setBrowsePov(next); if (value && next !== value.pov) onChange(undefined); };
  const pickTag = (tag: string) => onChange(tag ? { pov, tag, mode: value?.mode ?? 'scope' } : undefined);
  const pickMode = (mode: TagMode) => { if (value) onChange({ ...value, mode }); };

  return (
    <div className="inquiry-tag-picker" role="group" aria-label="POV tag">
      <span className="inquiry-mlab">POV tag</span>
      {povs.length > 1 && (
        <select className="inquiry-msel" aria-label="Tag camp" value={pov} onChange={(e) => pickPov(e.target.value as PovName)}>
          {povs.map(p => <option key={p} value={p}>{POV_LABELS[p]}</option>)}
        </select>
      )}
      <select className="inquiry-msel" aria-label={`${POV_LABELS[pov]} tag`} value={value?.tag ?? ''} onChange={(e) => pickTag(e.target.value)}>
        <option value="">None (untagged)</option>
        {entries.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
      </select>
      {value && (
        <span className="inquiry-tag-mode" role="radiogroup" aria-label="Tag mode">
          <label><input type="radio" name="inquiry-tag-mode" checked={value.mode === 'scope'} onChange={() => pickMode('scope')} />Scope</label>
          <label><input type="radio" name="inquiry-tag-mode" checked={value.mode === 'prioritize'} onChange={() => pickMode('prioritize')} />Prioritize</label>
        </span>
      )}
      {scope && (
        <span className={`inquiry-tag-scope${blocked ? ' insufficient' : ''}`}>
          {scope.inScope.length} in scope, {scope.excluded.length} untagged{blocked && `: ${blocked}`}
        </span>
      )}
    </div>
  );
}
