// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useState, useMemo } from 'react';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import type { Camp, GroundingEnvelope } from '@lib/inquiry';
import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';

type TabId = Camp | 'situation';

const CAMP_LABELS: Record<Camp, string> = {
  acc: 'Accelerationist',
  saf: 'Safetyist',
  skp: 'Skeptic',
  cc: 'Cross-Cutting',
};

interface PublicGroundingSectionProps {
  grounding: GroundingEnvelope;
}

export function PublicGroundingSection({ grounding }: PublicGroundingSectionProps) {
  const allNodes = useTaxonomyStore(s => ({ accelerationist: s.accelerationist, safetyist: s.safetyist, skeptic: s.skeptic }));

  const [activeTab, setActiveTab] = useState<TabId>('acc');

  const campTabs: TabId[] = ['acc', 'saf', 'skp'];
  const hasAnyCampNodes = campTabs.some(camp => (grounding.nodesByCamp[camp]?.length ?? 0) > 0);
  const hasSituationNodes = (grounding.situationNodes?.length ?? 0) > 0;
  const shouldShowSituationTab = hasSituationNodes;

  const handleTabChange = (tab: TabId) => {
    setActiveTab(tab);
  };

  const getNodeLabel = (nodeId: string): string => {
    try {
      const parts = nodeId.split('-');
      if (parts.length < 3) return nodeId;

      const pov = parts[0];
      let povKey: keyof typeof allNodes | null = null;
      if (pov === 'acc') povKey = 'accelerationist';
      else if (pov === 'saf') povKey = 'safetyist';
      else if (pov === 'skp') povKey = 'skeptic';

      if (povKey && allNodes[povKey]?.[nodeId]) {
        return allNodes[povKey][nodeId].label || nodeId;
      }
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'PublicGroundingSection',
        level: 'warn',
        message: 'Failed to resolve node label',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
    }
    return nodeId;
  };

  const getCampRows = (camp: Camp) => {
    const nodes = grounding.nodesByCamp[camp] ?? [];
    return nodes.map(node => ({
      id: node.nodeId,
      label: getNodeLabel(node.nodeId),
    }));
  };

  const getSituationRows = () => {
    return (grounding.situationNodes ?? []).slice(0, 3).map(node => ({
      id: node.nodeId,
      label: node.label,
    }));
  };

  const currentRows = useMemo(() => {
    if (activeTab === 'situation') return getSituationRows();
    return getCampRows(activeTab as Camp);
  }, [activeTab, grounding, allNodes]);

  if (!hasAnyCampNodes && !shouldShowSituationTab) return null;

  return (
    <section className="pov-inquiry-sect">
      <span className="pov-inquiry-eyebrow">Grounding</span>

      <div className="pov-grounding-tabs" role="tablist">
        {campTabs.map(camp => (
          <button
            key={camp}
            role="tab"
            aria-selected={activeTab === camp}
            aria-controls={`pov-grounding-panel-${camp}`}
            className={`pov-grounding-tab ${activeTab === camp ? 'active' : ''}`}
            onClick={() => handleTabChange(camp)}
          >
            {CAMP_LABELS[camp]}
          </button>
        ))}
        {shouldShowSituationTab && (
          <button
            role="tab"
            aria-selected={activeTab === 'situation'}
            aria-controls="pov-grounding-panel-situation"
            className={`pov-grounding-tab ${activeTab === 'situation' ? 'active' : ''}`}
            onClick={() => handleTabChange('situation')}
          >
            Situation
          </button>
        )}
      </div>

      <div
        id={`pov-grounding-panel-${activeTab}`}
        role="tabpanel"
        className="pov-grounding-panel"
      >
        {currentRows.length === 0 ? (
          <div className="pov-grounding-empty">
            {activeTab === 'situation'
              ? 'No situation nodes available'
              : `No grounding nodes for ${CAMP_LABELS[activeTab as Camp]}`}
          </div>
        ) : (
          <div className="pov-grounding-nodes mono">
            {currentRows.map((row) => row.label).join(' · ')}
          </div>
        )}
      </div>
    </section>
  );
}
