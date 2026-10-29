// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Extracted from StatementCard.tsx (ADR-007 line-slice, t/4625 — added here to keep
// StatementCard.tsx under the file's max-lines budget). The per-statement view-mode
// toggle: Text | Why | How ('analysis' tier id unchanged — How is a label-only rename).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TranscriptEntry } from '../../types/debate';
import type { VocabResolution } from '../../utils/vocabularyAnnotations';
import type { useDebateStore } from '../../hooks/useDebateStore';
import { TIER_LABELS, modeOfTier, type DisplayMode } from './utils';

export type SetEntryDisplayTier = ReturnType<typeof useDebateStore.getState>['setEntryDisplayTier'];

type TextTier = 'brief' | 'medium' | 'detailed';
type AnalysisTier = 'reasoning' | 'terms' | 'lineage' | 'claims' | 'convergence';
const TEXT_TIERS: TextTier[] = ['brief', 'medium', 'detailed'];
const WHY_TIERS = ['why'] as const;
// t/4625: Text | Why | How; `analysis` id unchanged (label-only rename).
const MODE_IDS = [{ id: 'text', label: 'Text' }, { id: 'why', label: 'Why' }, { id: 'analysis', label: 'How' }] as const;

export const TIER_TITLES: Record<string, string> = {
  brief: '2-3 sentences', medium: '1-2 paragraphs', detailed: 'Full response',
  reasoning: 'Brief, plan & BDI (replaces text)', claims: 'Argument network claims',
  terms: 'Vocabulary disambiguation', lineage: 'Intellectual lineage references',
  convergence: 'Convergence diagnostics', why: "This statement's BDI grounding",
};

export function StatementTierPills({ entry, activeTier, setEntryDisplayTier, vocabResolutions, hasLineageRefs }: {
  entry: TranscriptEntry;
  activeTier: string;
  setEntryDisplayTier: SetEntryDisplayTier;
  vocabResolutions: VocabResolution[] | undefined;
  hasLineageRefs: boolean;
}) {
  const activeMode = modeOfTier(activeTier);

  const [lastText, setLastText] = useState<TextTier>(
    activeMode === 'text' ? (activeTier as TextTier) : 'detailed'
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
    () => (['reasoning', 'terms', 'lineage', 'claims', 'convergence'] as AnalysisTier[]).filter(t => {
      if (t === 'terms') return !!(vocabResolutions && vocabResolutions.length > 0);
      if (t === 'lineage') return hasLineageRefs;
      return true;
    }),
    [vocabResolutions, hasLineageRefs],
  );

  const subTiers: readonly string[] = activeMode === 'text' ? TEXT_TIERS : activeMode === 'why' ? WHY_TIERS : analysisOptions;
  const isOverridden = entry.display_tier != null;

  const modeRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const handleModeSelect = useCallback((mode: DisplayMode) => {
    if (mode === activeMode) return;
    if (mode === 'text') setEntryDisplayTier(entry.id, lastText);
    else if (mode === 'analysis') setEntryDisplayTier(entry.id, lastAnalysis);
    else setEntryDisplayTier(entry.id, 'why');
  }, [activeMode, lastText, lastAnalysis, entry.id, setEntryDisplayTier]);

  const handleSubSelect = useCallback((tier: string) => {
    setEntryDisplayTier(entry.id, tier as TextTier | AnalysisTier | 'why');
    if (activeMode === 'text') setLastText(tier as TextTier);
    else if (activeMode === 'analysis') setLastAnalysis(tier as AnalysisTier);
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
          </button>
        ))}
      </span>
      {/* Value selector — native <select> styled as a dropdown button (t/2274 §13).
          Override → dot on the button + "Match global default" item. Why has a single
          value, so its dropdown is just an anchor for that, not a real choice. */}
      <span className="debate-value-dropdown-wrap">
        <select
          className="debate-detail-dropdown debate-value-dropdown"
          aria-label={activeMode === 'text' ? 'Text detail level' : activeMode === 'why' ? 'Why view' : 'How view'}
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
          {subTiers.map(tier => (
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
    </span>
  );
}
