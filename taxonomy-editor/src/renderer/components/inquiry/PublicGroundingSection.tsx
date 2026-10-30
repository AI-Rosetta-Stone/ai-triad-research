// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useState, useMemo } from 'react';
import type { Camp, PublicInquiryShare } from '@lib/inquiry';

const CAMP_TABS = ['acc', 'saf', 'skp'] as const satisfies readonly Camp[];
type CampTab = typeof CAMP_TABS[number];
type TabId = CampTab | 'situation';

const CAMP_LABELS: Record<CampTab, string> = {
  acc: 'Accelerationist',
  saf: 'Safetyist',
  skp: 'Skeptic',
};

// The public share's grounding projection strips nodeId (private taxonomy id — see
// lib/inquiry/publicShare.ts PublicNodeRefSchema) — only label + camp survive. This component
// renders those pre-baked labels verbatim; it never resolves anything live against the taxonomy.
type PublicGrounding = PublicInquiryShare['grounding'];

interface PublicGroundingSectionProps {
  grounding: PublicGrounding;
}

export function PublicGroundingSection({ grounding }: PublicGroundingSectionProps) {
  const [activeTab, setActiveTab] = useState<TabId>('acc');

  const hasAnyCampNodes = CAMP_TABS.some(camp => (grounding.nodesByCamp[camp]?.length ?? 0) > 0);
  const hasSituationNodes = (grounding.situationNodes?.length ?? 0) > 0;
  const shouldShowSituationTab = hasSituationNodes;

  const handleTabChange = (tab: TabId) => {
    setActiveTab(tab);
  };

  const getCampLabels = (camp: CampTab) => (grounding.nodesByCamp[camp] ?? []).map(node => node.label);

  const getSituationLabels = () => (grounding.situationNodes ?? []).slice(0, 3).map(node => node.label);

  const currentLabels = useMemo(() => {
    if (activeTab === 'situation') return getSituationLabels();
    return getCampLabels(activeTab);
  }, [activeTab, grounding]);

  if (!hasAnyCampNodes && !shouldShowSituationTab) return null;

  return (
    <section className="pov-inquiry-sect">
      <span className="pov-inquiry-eyebrow">Why</span>

      <div className="pov-grounding-tabs" role="tablist">
        {CAMP_TABS.map(camp => (
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
        {currentLabels.length === 0 ? (
          <div className="pov-grounding-empty">
            {activeTab === 'situation'
              ? 'No situation nodes available'
              : `No grounding nodes for ${CAMP_LABELS[activeTab]}`}
          </div>
        ) : (
          <div className="pov-grounding-nodes mono">
            {currentLabels.join(' · ')}
          </div>
        )}
      </div>
    </section>
  );
}
