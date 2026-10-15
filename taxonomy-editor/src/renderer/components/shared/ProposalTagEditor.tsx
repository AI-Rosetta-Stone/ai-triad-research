// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4214 R-6b (spec t/4211): the reviewer picks the wing tags of a node a propose_new proposal will create. It
// starts from the seat's own tag (R-4). Shown only for a POV with registry tags (Skeptic today). An untagged node
// is NOT shared ground: it is left out of every wing's Scope debates (t/3955); shared ground is tagged with both
// wings (CL #3315 review).

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
        {value.length === 0 ? untaggedHint(options) : 'The node belongs to the checked wing(s).'}
      </div>
    </fieldset>
  );
}

/** What leaving every tag unchecked means, in the POV's own wing names. */
function untaggedHint(options: PovTagOption[]): string {
  const labels = options.map(o => o.label);
  const named = labels.length > 1 ? `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}` : labels[0];
  return `No wing tag: this node will be left out of ${named} Scope debates. To share it, tag ${labels.length === 2 ? 'both wings' : 'every wing'}.`;
}
