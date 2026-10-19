// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { checkTagScope } from '@lib/debate/relevanceSelection';
import type { SeatTag, TagMode } from '@lib/debate/types/session';
import { loadPovTagRegistry, type PovTagRegistry } from '@lib/schema/povTags';
import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';
import type { SpeakerId } from '../../types/debate';
import './ChatTagPicker.css';

type ChatPov = Exclude<SpeakerId, 'user'>;
type TagScope = ReturnType<typeof checkTagScope>;

/** Registry label for a POV's tag, or `undefined` if the tag isn't registered for that POV. */
export function seatTagLabel(pov: ChatPov, tag: string | undefined, registry: PovTagRegistry): string | undefined {
  if (!tag) return undefined;
  return registry.povs[pov]?.find((t) => t.id === tag)?.label;
}

/**
 * Setup-time refuse reason for a tag + mode, or `undefined` if it's fine to start (TL t/3957#7
 * condition B(a); extended at t/3959#5 — CL's permanent ruling, p/736#31 — to also refuse Prioritize
 * at zero tagged nodes). Scope has a floor of 5; Prioritize has no floor above zero.
 */
export function tagBlockedReason(scope: TagScope | null, mode: TagMode | undefined): string | undefined {
  if (!scope || !mode) return undefined;
  if (mode === 'scope' && !scope.sufficient) {
    return `${scope.inScope.length} in scope — below the minimum (5); pick a different tag or use Prioritize`;
  }
  if (mode === 'prioritize' && scope.inScope.length === 0) {
    return 'no nodes carry this tag; pick a different tag or use Scope';
  }
  return undefined;
}

interface ChatTagPickerProps {
  pov: ChatPov;
  seatTag: SeatTag | undefined;
  onChange: (tag: SeatTag | undefined) => void;
}

/** POV tag + Scope/Prioritize picker for chat setup (t/3959; spec §4). Renders nothing when the
 *  registry has no tags for `pov` — tag souls ship per-POV, so an untagged POV shows no picker. */
export function ChatTagPicker({ pov, seatTag, onChange }: ChatTagPickerProps) {
  const entries = loadPovTagRegistry().povs[pov] ?? [];
  if (entries.length === 0) return null;

  const povNodes = useTaxonomyStore.getState()[pov]?.nodes ?? [];
  const scope = seatTag ? checkTagScope(povNodes, { tag: seatTag.pov_tag, mode: seatTag.tag_mode }) : null;

  const handleTagChange = (tagId: string) => {
    if (!tagId) { onChange(undefined); return; }
    onChange({ pov_tag: tagId, tag_mode: seatTag?.tag_mode ?? 'scope' });
  };

  const handleModeChange = (mode: TagMode) => {
    if (!seatTag) return;
    onChange({ ...seatTag, tag_mode: mode });
  };

  return (
    <div className="chat-tag-picker">
      <select
        className="chat-tag-picker-select"
        value={seatTag?.pov_tag ?? ''}
        onChange={(e) => handleTagChange(e.target.value)}
        aria-label={`${pov} tag`}
      >
        <option value="">None</option>
        {entries.map((t) => (
          <option key={t.id} value={t.id}>{t.label}</option>
        ))}
      </select>
      {seatTag && (
        <div className="chat-tag-picker-mode">
          <label>
            <input
              type="radio"
              name={`${pov}-tag-mode`}
              checked={seatTag.tag_mode === 'scope'}
              onChange={() => handleModeChange('scope')}
            />
            Scope
          </label>
          <label>
            <input
              type="radio"
              name={`${pov}-tag-mode`}
              checked={seatTag.tag_mode === 'prioritize'}
              onChange={() => handleModeChange('prioritize')}
            />
            Prioritize
          </label>
        </div>
      )}
      {scope && seatTag && (() => {
        const blocked = tagBlockedReason(scope, seatTag.tag_mode);
        const tagLabel = entries.find((t) => t.id === seatTag.pov_tag)?.label ?? seatTag.pov_tag;
        return (
          <div className={`chat-tag-picker-scope${blocked ? ' insufficient' : ''}`}>
            {scope.inScope.length} in scope, {scope.excluded.length} not tagged {tagLabel}
            {blocked && ` — ${blocked}`}
          </div>
        );
      })()}
    </div>
  );
}
