// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4214 R-6b (spec t/4211): the reviewer picks the wing tags of a node a propose_new proposal will create. It
// starts from the seat's own tag (R-4); clearing every tag makes the node common ground for the whole camp. Shown
// only for a POV with registry tags (Skeptic today).

import { loadPovTagRegistry } from '@lib/schema/povTags';
import './ProposalTagEditor.css';

export interface PovTagOption { id: string; label: string }

/** The POV's registry tags as editor options; `[]` for a POV with no tags. */
export function povTagOptionsFor(pov: string): PovTagOption[] {
  const entries = loadPovTagRegistry().povs[pov as keyof ReturnType<typeof loadPovTagRegistry>['povs']] ?? [];
  return entries.map(e => ({ id: e.id, label: e.label }));
}

export function ProposalTagEditor({ options, value, onChange, disabled }: {
  options: PovTagOption[];
  value: string[];
  onChange: (tags: string[]) => void;
  disabled?: boolean;
}) {
  if (options.length === 0) return null;
  const toggle = (id: string, on: boolean) => onChange(on ? [...value, id] : value.filter(t => t !== id));
  return (
    <fieldset className="rp-proposal-tags" disabled={disabled}>
      <legend className="rp-proposal-tags-legend">Wing tags for the new node</legend>
      {options.map(o => (
        <label key={o.id} className="rp-proposal-tag-option">
          <input type="checkbox" checked={value.includes(o.id)} onChange={e => toggle(o.id, e.target.checked)} />
          {o.label}
        </label>
      ))}
      <div className="rp-proposal-tags-hint">
        {value.length === 0 ? 'No tag: common ground for the whole camp.' : 'The node belongs to the checked wing(s).'}
      </div>
    </fieldset>
  );
}
