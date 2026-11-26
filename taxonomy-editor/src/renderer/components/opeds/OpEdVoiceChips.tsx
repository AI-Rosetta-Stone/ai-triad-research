// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// The op-ed voices control. A signed-in user picks any of the three camps (multi-select chips, one op-ed each).
// An anonymous visitor picks exactly one: a radio group with no voice preselected, so no camp is the house default
// (t/725, Design t/725#3, p/25#221; the server refuses more than one voice, t/724#4).

import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { PovKey } from '../../../../../lib/oped/types';
import { POV_META } from '@lib/electron-shared/povMeta';
import { POV_KEYS } from '@lib/debate/types';
import { CampGlyph, povToCamp } from '../shared/CampGlyph';
import { ANON_ONE_VOICE_LINE } from './anonOpEdCopy';

function voiceLabels(voices: PovKey[]): string {
  return voices.map(v => POV_META[v].label).join(', ');
}

export function voiceCountLine(voices: PovKey[]): string {
  if (voices.length === 0) return 'Select at least one voice.';
  if (voices.length === 1) return `Will create 1 op-ed — ${voiceLabels(voices)}.`;
  return `Will create ${voices.length} op-eds on the same topic — ${voiceLabels(voices)} — shown in tabs.`;
}

/** Arrow keys move an anonymous visitor's single voice choice (radio-group behaviour), and focus follows. */
function onVoiceRadioKey(e: ReactKeyboardEvent<HTMLDivElement>, voices: Set<PovKey>, select: (pov: PovKey) => void): void {
  if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(e.key)) return;
  e.preventDefault();
  const forward = e.key === 'ArrowRight' || e.key === 'ArrowDown';
  const cur = POV_KEYS.findIndex(v => voices.has(v));
  const nextIdx = cur < 0 ? (forward ? 0 : POV_KEYS.length - 1) : (cur + (forward ? 1 : -1) + POV_KEYS.length) % POV_KEYS.length;
  select(POV_KEYS[nextIdx]);
  const group = e.currentTarget;
  requestAnimationFrame(() => (group.querySelectorAll('button')[nextIdx] as HTMLElement | undefined)?.focus());
}

/** The attributes that make a chip a checkbox-like toggle (signed in) or a radio (anonymous). Tab enters and leaves
 *  the radio group; only the checked chip (or the first, when none is checked) is in the tab order. */
function chipSemantics(isAnonymous: boolean, pov: PovKey, voices: Set<PovKey>) {
  const selected = voices.has(pov);
  if (!isAnonymous) return { 'aria-pressed': selected };
  return { role: 'radio' as const, 'aria-checked': selected, tabIndex: selected || (voices.size === 0 && pov === POV_KEYS[0]) ? 0 : -1 };
}

export function OpEdVoiceChips({ voices, orderedVoices, isAnonymous, toggleVoice }: {
  voices: Set<PovKey>;
  orderedVoices: PovKey[];
  isAnonymous: boolean;
  toggleVoice: (pov: PovKey) => void;
}) {
  return (
    <div>
      <label className="oped-field-label" id="oped-voices-label">
        {isAnonymous ? 'Voice' : 'Voices — one op-ed each'} <span className="oped-required-mark" aria-hidden="true">*</span>
      </label>
      <div
        className="oped-voice-chips"
        role={isAnonymous ? 'radiogroup' : 'group'}
        aria-labelledby="oped-voices-label"
        onKeyDown={isAnonymous ? (e) => onVoiceRadioKey(e, voices, toggleVoice) : undefined}
      >
        {POV_KEYS.map(pov => {
          const camp = povToCamp(pov);
          const selected = voices.has(pov);
          return (
            <button
              key={pov}
              type="button"
              className="oped-voice-chip"
              {...chipSemantics(isAnonymous, pov, voices)}
              // eslint-disable-next-line local/no-inline-style -- dynamic: camp accent when selected (theme-aware)
              style={selected ? { color: `var(${POV_META[pov].cssVar})` } : undefined}
              onClick={() => toggleVoice(pov)}
            >
              {camp && <span className="oped-voice-chip-glyph" aria-hidden="true"><CampGlyph camp={camp} size={13} /></span>}
              {POV_META[pov].label}
            </button>
          );
        })}
      </div>
      {isAnonymous && <p className="oped-voice-note">{ANON_ONE_VOICE_LINE}</p>}
      <p className="oped-voice-count" aria-live="polite">{isAnonymous && orderedVoices.length === 0 ? '' : voiceCountLine(orderedVoices)}</p>
    </div>
  );
}
