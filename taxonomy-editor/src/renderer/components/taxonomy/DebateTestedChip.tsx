// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useState, useEffect } from 'react';
import type { DebateTestedTier, DebateTestedRecord } from '../../bridge/types';
import type { PovNode } from '../../types/taxonomy';
import './DebateTestedChip.css';

const TIER_COLORS: Record<DebateTestedTier, { bg: string; fg: string }> = {
  untested:    { bg: '#e2e8f0', fg: '#475569' },
  cited:       { bg: '#dbeafe', fg: '#1e40af' },
  contested:   { bg: '#fef3c7', fg: '#92400e' },
  well_tested: { bg: '#bbf7d0', fg: '#166534' },
};

const TIER_LABELS: Record<DebateTestedTier, string> = {
  untested: 'Untested',
  cited: 'Cited',
  contested: 'Contested',
  well_tested: 'Well Tested',
};

export async function computeSha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', data);
  const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  return `sha256:${hex}`;
}

interface DebateTestedChipProps {
  record?: DebateTestedRecord;
  description?: string;
  onClick?: () => void;
  compact?: boolean;
}

export function DebateTestedChip({ record, description, onClick, compact }: DebateTestedChipProps) {
  const tier: DebateTestedTier = record?.tier ?? 'untested';
  const colors = TIER_COLORS[tier];
  const [isStale, setIsStale] = useState(false);

  useEffect(() => {
    if (!record?.description_hash || !description) {
      setIsStale(!record ? false : !record.description_hash);
      return;
    }
    let cancelled = false;
    void computeSha256(description).then(hash => {
      if (!cancelled) setIsStale(hash !== record.description_hash);
    });
    return () => { cancelled = true; };
  }, [record?.description_hash, description]);

  return (
    <span
      className={`debate-tested-chip${onClick ? ' clickable' : ''}${compact ? ' compact' : ''}`}
      // eslint-disable-next-line local/no-inline-style -- tier colors computed from record.tier, not static
      style={{ background: colors.bg, color: colors.fg }}
      onClick={onClick}
      title={isStale ? 'Stale — node description changed since last test' : `Debate-Tested: ${TIER_LABELS[tier]}`}
    >
      {TIER_LABELS[tier]}
      {isStale && <span className="debate-tested-stale" title="Description changed since last test">⚠</span>}
    </span>
  );
}

export { TIER_LABELS as DEBATE_TESTED_TIER_LABELS, TIER_COLORS as DEBATE_TESTED_TIER_COLORS };
export type { DebateTestedChipProps };

/** NodeDetail meta-line status segment (t/4574 spec §2.1) — moved out of the Content/Analysis
 *  tab. Omitted entirely when the node has no debate_tested record. */
export function NodeStatusBadge({ node, onToggleDrilldown }: { node: PovNode; onToggleDrilldown: () => void }) {
  const record = node.graph_attributes?.debate_tested;
  if (!record) return null;
  const tier: DebateTestedTier = record.tier ?? 'untested';
  const colors = TIER_COLORS[tier];
  return (
    <>
      <span className="nd-meta-sep">/</span>
      <button
        type="button"
        className="nd-header-status"
        /* eslint-disable-next-line local/no-inline-style -- tier color computed from record.tier */
        style={{ color: colors.fg }}
        onClick={onToggleDrilldown}
      >
        {/* Design, t/4574#15 nit: sentence case in the meta line, as in the mockup —
            TIER_LABELS stays Title Case for its other (chip) consumers. */}
        {tier === 'well_tested' ? '✓ Well tested' : TIER_LABELS[tier]}
      </button>
    </>
  );
}
