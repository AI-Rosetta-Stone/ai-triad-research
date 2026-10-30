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

  const handleTabChange = (tab: TabId) => {
    setActiveTab(tab);
    setSelectedRowId(null);
  };

  // Rows render the ADR §5 inline display snapshot (node.label) rather than a live taxonomy
  // lookup — the taxonomy is mutable, so a result opened later degrades to stale labels rather
  // than broken references. Live resolution happens only for the selected row's detail pane.
  const getCampRows = (camp: CampTab) =>
    (grounding.nodesByCamp[camp] ?? []).map(node => ({ id: node.nodeId, label: node.label }));

  // Falls back to the single anchor situation (always present once a situation was tagged)
  // when the child ticket's ranked situationNodes list (t/4592) isn't populated — the tab must
  // never be empty just because the richer field is missing from an older/simpler result.
  const getSituationRows = () => {
    if (grounding.situationNodes && grounding.situationNodes.length > 0) {
      return grounding.situationNodes.slice(0, 3).map(node => ({ id: node.nodeId, label: node.label }));
    }
    if (grounding.anchorSituationId) {
      return [{ id: grounding.anchorSituationId, label: grounding.anchorSummary ?? grounding.anchorSituationId }];
    }
    return [];
  };

  const currentRows = useMemo(() => {
    if (activeTab === 'situation') return getSituationRows();
    return getCampRows(activeTab);
  }, [activeTab, grounding]);

  // Design (t/4591#6): the first row is selected by default when a tab opens.
  const effectiveSelectedRowId = selectedRowId ?? currentRows[0]?.id ?? null;

  const selectedNodeMissing = effectiveSelectedRowId !== null && lookupPinnedData(effectiveSelectedRowId) === null;

  return (
    <div className="grounding-section">
      <span className="inquiry-eyebrow">Why</span>

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
        <button
          role="tab"
          aria-selected={activeTab === 'situation'}
          aria-controls="grounding-panel-situation"
          className={`grounding-tab ${activeTab === 'situation' ? 'active' : ''}`}
          onClick={() => handleTabChange('situation')}
        >
          Situation
        </button>
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
              : `No grounding items for ${CAMP_LABELS[activeTab]}`}
          </div>
        ) : (
          <div className="grounding-content">
            <table className="grounding-table" aria-label={`${activeTab === 'situation' ? 'Situation' : CAMP_LABELS[activeTab]} grounding nodes`}>
              <thead>
                <tr>
                  <th scope="col">ID</th>
                  <th scope="col">Title</th>
                </tr>
              </thead>
              <tbody>
                {currentRows.map((row) => (
                  <tr
                    key={row.id}
                    className={`grounding-row ${effectiveSelectedRowId === row.id ? 'selected' : ''}`}
                    onClick={() => setSelectedRowId(row.id)}
                    aria-selected={effectiveSelectedRowId === row.id}
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

            {effectiveSelectedRowId && (
              <div className="grounding-detail">
                <LinkedNodePreview nodeId={effectiveSelectedRowId} />
                {selectedNodeMissing && (
                  <div className="grounding-detail-missing">
                    This item is no longer in the taxonomy ({effectiveSelectedRowId})
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
