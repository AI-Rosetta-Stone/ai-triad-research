// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useState, useMemo } from 'react';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import type { Camp, GroundingEnvelope } from '@lib/inquiry';
import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';
import type { PovNode } from '../../types/taxonomy';
import { LinkedNodePreview } from '../shared/LinkedNodePreview';
import './GroundingSection.css';

type TabId = Camp | 'situation';

const CAMP_LABELS: Record<Camp, string> = {
  acc: 'Accelerationist',
  saf: 'Safetyist',
  skp: 'Skeptic',
  cc: 'Cross-Cutting',
};

interface GroundingSectionProps {
  grounding: GroundingEnvelope;
  nodesByPov?: Record<string, PovNode>;
}

export function GroundingSection({ grounding, nodesByPov = {} }: GroundingSectionProps) {
  const allNodes = useTaxonomyStore(s => ({ accelerationist: s.accelerationist, safetyist: s.safetyist, skeptic: s.skeptic }));

  const [activeTab, setActiveTab] = useState<TabId>('acc');
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);

  const campTabs: TabId[] = ['acc', 'saf', 'skp'];
  const hasAnyCampNodes = campTabs.some(camp => (grounding.nodesByCamp[camp]?.length ?? 0) > 0);
  const hasSituationNodes = (grounding.situationNodes?.length ?? 0) > 0;
  const shouldShowSituationTab = hasSituationNodes;

  const handleTabChange = (tab: TabId) => {
    setActiveTab(tab);
    setSelectedRowId(null);
  };

  const getNodeLabel = (nodeId: string): string => {
    try {
      const parts = nodeId.split('-');
      if (parts.length < 3) return nodeId;

      const pov = parts[0];
      const category = parts[1];
      const index = parts[2];

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
        component: 'GroundingSection',
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
      id: node.id,
      label: getNodeLabel(node.id),
    }));
  };

  const getSituationRows = () => {
    return (grounding.situationNodes ?? []).slice(0, 3).map(node => ({
      id: node.id,
      label: node.id,
    }));
  };

  const currentRows = useMemo(() => {
    if (activeTab === 'situation') return getSituationRows();
    return getCampRows(activeTab as Camp);
  }, [activeTab, grounding, allNodes]);

  if (!hasAnyCampNodes && !shouldShowSituationTab) return null;

  return (
    <div className="grounding-section">
      <span className="grounding-eyebrow">Grounding</span>

      <div className="grounding-tabs" role="tablist">
        {campTabs.map(camp => (
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
              : `No grounding nodes for ${CAMP_LABELS[activeTab as Camp]}`}
          </div>
        ) : (
          <div className="grounding-content">
            <table className="grounding-table" role="grid" aria-label={`${CAMP_LABELS[activeTab as Camp]} grounding nodes`}>
              <thead>
                <tr>
                  <th scope="col">Node ID</th>
                  <th scope="col">Label</th>
                </tr>
              </thead>
              <tbody>
                {currentRows.map((row, idx) => (
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
                {!currentRows.find(r => r.id === selectedRowId) && (
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
