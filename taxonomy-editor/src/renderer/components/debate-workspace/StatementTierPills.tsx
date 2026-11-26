// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Extracted from StatementCard.tsx (ADR-007 line-slice, t/4625 — added here to keep
// StatementCard.tsx under the file's max-lines budget). The per-statement view-mode
// toggle: Statement | Why · N sources | How ('analysis' tier id unchanged — How is a label-only
// rename). t/701 §4 made the labels say what is behind them; §2 removed the per-card length
// dropdown (each card has a Read full statement link instead), so only How keeps a dropdown.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TranscriptEntry } from '../../types/debate';
import type { useDebateStore } from '../../hooks/useDebateStore';
import { TIER_LABELS, modeOfTier, type DisplayMode } from './utils';
import './StatementBrief.css';

export type SetEntryDisplayTier = ReturnType<typeof useDebateStore.getState>['setEntryDisplayTier'];

type TextTier = 'brief' | 'detailed';
type AnalysisTier = 'reasoning' | 'lineage' | 'claims';
type WhyTier = 'why' | 'terms';
// t/4625: Text | Why | How; `analysis` id unchanged (label-only rename).
const MODE_IDS = [{ id: 'text', label: 'Statement' }, { id: 'why', label: 'Why' }, { id: 'analysis', label: 'How' }] as const;

export const TIER_TITLES: Record<string, string> = {
  reasoning: 'Brief, plan & BDI (replaces text)', claims: 'Argument network claims',
  terms: 'Vocabulary disambiguation', lineage: 'Intellectual lineage references',
  why: "This statement's BDI grounding",
};

export function StatementTierPills({ entry, activeTier, setEntryDisplayTier, hasLineageRefs, whySourceCount = 0 }: {
  entry: TranscriptEntry;
  activeTier: string;
  setEntryDisplayTier: SetEntryDisplayTier;
  hasLineageRefs: boolean;
  /** How many BDI grounding refs the Why tab lists; 0 shows a bare `Why`. */
  whySourceCount?: number;
}) {
  const activeMode = modeOfTier(activeTier);

  const [lastText, setLastText] = useState<TextTier>(
    activeMode === 'text' ? (activeTier as TextTier) : 'brief'
  );
  const [lastAnalysis, setLastAnalysis] = useState<AnalysisTier>(
    activeMode === 'analysis' ? (activeTier as AnalysisTier) : 'reasoning'
  );

  // Sync per-card memory when tier changes externally (global default reset, override clear).
  useEffect(() => {
    const mode = modeOfTier(activeTier);
    if (mode === 'analysis') setLastAnalysis(activeTier as AnalysisTier);
    else if (mode === 'text') setLastText(activeTier as TextTier);
  }, [activeTier]);

  const analysisOptions = useMemo<AnalysisTier[]>(
    () => (['reasoning', 'lineage', 'claims'] as AnalysisTier[]).filter(t => t !== 'lineage' || hasLineageRefs),
    [hasLineageRefs],
  );
  const isOverridden = entry.display_tier != null;

  const modeRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const handleModeSelect = useCallback((mode: DisplayMode) => {
    if (mode === activeMode) return;
    if (mode === 'text') setEntryDisplayTier(entry.id, lastText);
    else if (mode === 'analysis') setEntryDisplayTier(entry.id, lastAnalysis);
    else setEntryDisplayTier(entry.id, 'why');
  }, [activeMode, lastText, lastAnalysis, entry.id, setEntryDisplayTier]);

  const handleSubSelect = useCallback((tier: string) => {
    setEntryDisplayTier(entry.id, tier as AnalysisTier | WhyTier);
    if (activeMode === 'analysis') setLastAnalysis(tier as AnalysisTier);
  }, [activeMode, entry.id, setEntryDisplayTier]);

  const handleModeKey = useCallback((e: { key: string; preventDefault(): void }, idx: number) => {
    let next = idx;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (idx + 1) % MODE_IDS.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (idx - 1 + MODE_IDS.length) % MODE_IDS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = MODE_IDS.length - 1;
    else return;
    e.preventDefault();
    handleModeSelect(MODE_IDS[next].id);
    requestAnimationFrame(() => modeRefs.current[next]?.focus());
  }, [handleModeSelect]);

  return (
    <span className="debate-tier-pills">
      <span role="radiogroup" aria-label="View mode" className="debate-mode-group">
        {MODE_IDS.map(({ id, label }, i) => (
          <button
            key={id}
            ref={el => { modeRefs.current[i] = el; }}
            type="button"
            role="radio"
            aria-checked={activeMode === id}
            tabIndex={activeMode === id ? 0 : -1}
            className={`debate-mode-seg${activeMode === id ? ' debate-mode-seg-active' : ''}`}
            onClick={(e) => { e.stopPropagation(); handleModeSelect(id); }}
            onKeyDown={(e) => handleModeKey(e, i)}
          >
            {label}
            {id === 'why' && whySourceCount > 0 && (
              <span className="debate-mode-seg-count"> · {whySourceCount} {whySourceCount === 1 ? 'source' : 'sources'}</span>
            )}
          </button>
        ))}
      </span>
      {/* Value selector — native <select> styled as a dropdown button (t/2274 §13).
          Override → dot on the button + "Match global default" item. How only: Why's
          BDI | Vocabulary choice lives in the panel's own tabs (t/4904#2), and Statement's
          length is the card's Read full statement link (t/701 §2, §3). */}
      {activeMode === 'analysis' && (
      <span className="debate-value-dropdown-wrap">
        <select
          className="debate-detail-dropdown debate-value-dropdown"
          aria-label="How view"
          value={activeTier}
          title={TIER_TITLES[activeTier]}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => {
            e.stopPropagation();
            const v = e.target.value;
            if (v === '__match_global__') setEntryDisplayTier(entry.id, undefined);
            else handleSubSelect(v);
          }}
        >
          {analysisOptions.map(tier => (
            <option key={tier} value={tier}>{TIER_LABELS[tier]}</option>
          ))}
          {isOverridden && <option value="__match_global__">Match global default</option>}
        </select>
        {isOverridden && (
          <span
            className="debate-value-override-dot"
            title="Overrides global default"
            aria-label="Overrides global default"
          />
        )}
      </span>
      )}
    </span>
  );
}
