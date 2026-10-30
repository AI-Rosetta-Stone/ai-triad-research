// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useState, useMemo } from 'react';
import type { Camp, GroundingEnvelope } from '@lib/inquiry';
import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';
import { LinkedNodePreview } from '../shared/LinkedNodePreview';
import './GroundingSection.css';

const CAMP_TABS = ['acc', 'saf', 'skp'] as const satisfies readonly Camp[];
type CampTab = typeof CAMP_TABS[number];
type TabId = CampTab | 'situation';

const CAMP_LABELS: Record<CampTab, string> = {
  acc: 'Accelerationist',
  saf: 'Safetyist',
  skp: 'Skeptic',
};

interface GroundingSectionProps {
  grounding: GroundingEnvelope;
}

export function GroundingSection({ grounding }: GroundingSectionProps) {
  const lookupPinnedData = useTaxonomyStore(s => s.lookupPinnedData);

  const [activeTab, setActiveTab] = useState<TabId>('acc');
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);

  const hasAnyCampNodes = CAMP_TABS.some(camp => (grounding.nodesByCamp[camp]?.length ?? 0) > 0);
  const hasSituationNodes = (grounding.situationNodes?.length ?? 0) > 0;
  const shouldShowSituationTab = hasSituationNodes;

  const handleTabChange = (tab: TabId) => {
    setActiveTab(tab);
    setSelectedRowId(null);
  };

  // Rows render the ADR §5 inline display snapshot (node.label) rather than a live taxonomy
  // lookup — the taxonomy is mutable, so a result opened later degrades to stale labels rather
  // than broken references. Live resolution happens only for the selected row's detail pane.
  const getCampRows = (camp: CampTab) =>
    (grounding.nodesByCamp[camp] ?? []).map(node => ({ id: node.nodeId, label: node.label }));

  const getSituationRows = () =>
    (grounding.situationNodes ?? []).slice(0, 3).map(node => ({ id: node.nodeId, label: node.label }));

  const currentRows = useMemo(() => {
    if (activeTab === 'situation') return getSituationRows();
    return getCampRows(activeTab);
  }, [activeTab, grounding]);

  const selectedNodeMissing = selectedRowId !== null && lookupPinnedData(selectedRowId) === null;

  if (!hasAnyCampNodes && !shouldShowSituationTab) return null;

  return (
    <div className="grounding-section">
      <span className="grounding-eyebrow">Why</span>

      <div className="grounding-tabs" role="tablist">
        {CAMP_TABS.map(camp => (
          <button
            key={camp}
            role="tab"
            aria-selected={activeTab === camp}
            aria-controls={`grounding-panel-${camp}`}
            className={`grounding-tab ${activeTab === camp ? 'active' : ''}`}
            onClick={() => handleTabChange(camp)}
          >
            {CAMP_LABELS[camp]}
          </button>
        ))}
        {shouldShowSituationTab && (
          <button
            role="tab"
            aria-selected={activeTab === 'situation'}
            aria-controls="grounding-panel-situation"
            className={`grounding-tab ${activeTab === 'situation' ? 'active' : ''}`}
            onClick={() => handleTabChange('situation')}
          >
            Situation
          </button>
        )}
      </div>

      <div
        id={`grounding-panel-${activeTab}`}
        role="tabpanel"
        className="grounding-panel"
      >
        {currentRows.length === 0 ? (
          <div className="grounding-empty">
            {activeTab === 'situation'
              ? 'No situation nodes available'
              : `No grounding nodes for ${CAMP_LABELS[activeTab]}`}
          </div>
        ) : (
          <div className="grounding-content">
            <table className="grounding-table" role="grid" aria-label={`${activeTab === 'situation' ? 'Situation' : CAMP_LABELS[activeTab]} grounding nodes`}>
              <thead>
                <tr>
                  <th scope="col">Node ID</th>
                  <th scope="col">Label</th>
                </tr>
              </thead>
              <tbody>
                {currentRows.map((row) => (
                  <tr
                    key={row.id}
                    className={`grounding-row ${selectedRowId === row.id ? 'selected' : ''}`}
                    onClick={() => setSelectedRowId(row.id)}
                    role="row"
                    aria-selected={selectedRowId === row.id}
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelectedRowId(row.id);
                      }
                    }}
                  >
                    <td className="grounding-cell-id">{row.id}</td>
                    <td className="grounding-cell-label">{row.label}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {selectedRowId && (
              <div className="grounding-detail">
                <LinkedNodePreview nodeId={selectedRowId} />
                {selectedNodeMissing && (
                  <div className="grounding-detail-missing">
                    Node no longer in taxonomy
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
