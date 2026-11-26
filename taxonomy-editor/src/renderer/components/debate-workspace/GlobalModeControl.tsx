// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// The debate-wide display control in the toolbar: Text | Why | How, then the value for that mode.
// Moved out of DebateWorkspace.tsx (ADR-007 line-slice) when t/701 changed it:
//   §2: on Text the value is a two-way Brief | Full toggle, replacing the Brief / Medium / Detailed
//       dropdown. Medium is no longer offered; a stored `medium` shows as Brief (lengthTier).
//   §8: `Expand all turns` / `Collapse earlier turns` sits next to it.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { useDebateStore } from '../../hooks/useDebateStore';
import { TIER_LABELS, lengthTier, modeOfTier, shownTier, type DisplayMode } from './utils';
import { useTurnCollapseControls } from './turnCollapse';
import './StatementBrief.css';

type DWStore = ReturnType<typeof useDebateStore.getState>;
type GlobalTextTier = 'brief' | 'detailed';
type GlobalAnalysisTier = 'reasoning' | 'claims';
const GLOBAL_ANALYSIS_TIERS: GlobalAnalysisTier[] = ['reasoning', 'claims'];
const GLOBAL_WHY_TIERS = ['why'] as const;
const GLOBAL_LENGTHS: { tier: GlobalTextTier; label: string; title: string }[] = [
  { tier: 'brief', label: 'Brief', title: 'Show every statement as its claim and key points' },
  { tier: 'detailed', label: 'Full', title: 'Show every statement in full' },
];
const GLOBAL_TIER_TITLES: Record<string, string> = {
  reasoning: 'Show brief, plan & BDI (replaces text)',
  claims: 'Show argument network claims',
  why: "Show every turn's BDI grounding",
};
// t/4625: Text | Why | How. `analysis` id unchanged (label-only rename: Analysis → How).
const GLOBAL_MODE_IDS = [{ id: 'text', label: 'Text' }, { id: 'why', label: 'Why' }, { id: 'analysis', label: 'How' }] as const;

/** t/701 §8: the toolbar's turn-collapse control. Renders nothing until the debate has enough
 *  turns for any to collapse. Text, not an icon, so the state reads without colour. */
function TurnCollapseButton({ debateId, transcript }: {
  debateId: string | undefined;
  transcript: readonly { id: string; type: string }[] | undefined;
}) {
  const { available, anyCollapsed, expandAll, collapseEarlier } = useTurnCollapseControls(debateId, transcript);
  if (!available) return null;
  return (
    <button type="button" className="debate-link-btn" onClick={anyCollapsed ? expandAll : collapseEarlier}>
      {anyCollapsed ? 'Expand all turns' : 'Collapse earlier turns'}
    </button>
  );
}

export function GlobalModeControl({ defaultTier: storedTier, setDefaultTier, debateId, transcript }: {
  defaultTier: DWStore['defaultDisplayTier'];
  setDefaultTier: DWStore['setDefaultDisplayTier'];
  debateId?: string;
  transcript?: readonly { id: string; type: string }[];
}) {
  // A saved 'convergence' opens on Reasoning (t/697); a saved 'medium' shows as Brief (t/701 §2).
  const defaultTier = lengthTier(shownTier(storedTier));
  const activeMode = modeOfTier(defaultTier);
  const [lastText, setLastText] = useState<GlobalTextTier>(
    activeMode === 'text' ? (defaultTier as GlobalTextTier) : 'brief'
  );
  const [lastAnalysis, setLastAnalysis] = useState<GlobalAnalysisTier>(
    activeMode === 'analysis' ? (defaultTier as GlobalAnalysisTier) : 'reasoning'
  );

  useEffect(() => {
    const mode = modeOfTier(defaultTier);
    if (mode === 'analysis') setLastAnalysis(defaultTier as GlobalAnalysisTier);
    else if (mode === 'text') setLastText(defaultTier as GlobalTextTier);
  }, [defaultTier]);

  const subTiers: readonly string[] = activeMode === 'why' ? GLOBAL_WHY_TIERS : GLOBAL_ANALYSIS_TIERS;
  const modeRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const handleModeSelect = useCallback((mode: DisplayMode) => {
    if (mode === activeMode) return;
    if (mode === 'text') setDefaultTier(lastText);
    else if (mode === 'analysis') setDefaultTier(lastAnalysis);
    else setDefaultTier('why');
  }, [activeMode, lastText, lastAnalysis, setDefaultTier]);

  const handleSubSelect = useCallback((tier: string) => {
    setDefaultTier(tier as GlobalAnalysisTier | 'why');
    if (activeMode === 'analysis') setLastAnalysis(tier as GlobalAnalysisTier);
  }, [activeMode, setDefaultTier]);

  // A click on Brief or Full always reaches the store, even on the length already active:
  // setDefaultDisplayTier clears every per-card override, so the whole debate follows the
  // toggle and no card is left on the other length without a visible reason (Design, p/14#110).
  const handleLengthSelect = useCallback((tier: GlobalTextTier) => {
    setDefaultTier(tier);
    setLastText(tier);
  }, [setDefaultTier]);

  const handleModeKey = useCallback((e: { key: string; preventDefault(): void }, idx: number) => {
    let next = idx;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (idx + 1) % GLOBAL_MODE_IDS.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (idx - 1 + GLOBAL_MODE_IDS.length) % GLOBAL_MODE_IDS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = GLOBAL_MODE_IDS.length - 1;
    else return;
    e.preventDefault();
    handleModeSelect(GLOBAL_MODE_IDS[next].id);
    requestAnimationFrame(() => modeRefs.current[next]?.focus());
  }, [handleModeSelect]);

  return (
    <span className="debate-tier-global" style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
      <span role="radiogroup" aria-label="View mode" className="debate-mode-group">
        {GLOBAL_MODE_IDS.map(({ id, label }, i) => (
          <button
            key={id}
            ref={el => { modeRefs.current[i] = el; }}
            type="button"
            role="radio"
            aria-checked={activeMode === id}
            tabIndex={activeMode === id ? 0 : -1}
            className={`debate-mode-seg${activeMode === id ? ' debate-mode-seg-active' : ''}`}
            onClick={() => handleModeSelect(id)}
            onKeyDown={(e) => handleModeKey(e, i)}
          >
            {label}
          </button>
        ))}
      </span>
      {activeMode === 'text' ? (
        <span role="group" aria-label="Statement length" className="debate-mode-group debate-length-toggle">
          {GLOBAL_LENGTHS.map(({ tier, label, title }) => (
            <button
              key={tier}
              type="button"
              aria-pressed={defaultTier === tier}
              title={title}
              className={`debate-mode-seg${defaultTier === tier ? ' debate-mode-seg-active' : ''}`}
              onClick={() => handleLengthSelect(tier)}
            >
              {label}
            </button>
          ))}
        </span>
      ) : (
        // Value selector for Why and How: a native <select> dropdown (t/2274 §13). The global
        // control has no per-statement override, so no dot / match-global item here.
        <select
          className="debate-detail-dropdown debate-value-dropdown"
          aria-label={activeMode === 'why' ? 'Why view' : 'How view'}
          value={defaultTier}
          title={GLOBAL_TIER_TITLES[defaultTier]}
          onChange={(e) => handleSubSelect(e.target.value)}
        >
          {subTiers.map(tier => (
            <option key={tier} value={tier}>{TIER_LABELS[tier]}</option>
          ))}
        </select>
      )}
      <TurnCollapseButton debateId={debateId} transcript={transcript} />
    </span>
  );
}
