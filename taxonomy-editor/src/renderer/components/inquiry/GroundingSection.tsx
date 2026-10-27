// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useState } from 'react';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import type { InquiryResult } from '../../bridge/types';
import type { Camp } from '@lib/inquiry/schema';
import { CAMP_LABELS } from './inquiryDisplay';
import './GroundingSection.css';

type GroundingCamp = Camp;
const CAMPS: GroundingCamp[] = ['acc', 'saf', 'skp'];

interface GroundingSectionProps {
  result: InquiryResult;
}

export function GroundingSection({ result }: GroundingSectionProps) {
  // Hide section if no grounding data
  if (!result.grounding) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'GroundingSection',
      level: 'warn',
      message: 'Inquiry result missing grounding data (older result?)',
    });
    return null;
  }

  const [activeTab, setActiveTab] = useState<GroundingCamp | 'situation'>('acc');
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);

  // Get items for the active tab
  interface GroundingItem {
    nodeId: string;
    label: string;
  }

  const getTabItems = (): GroundingItem[] => {
    if (activeTab === 'situation') {
      return result.grounding.anchorSituationId
        ? [{ nodeId: result.grounding.anchorSituationId, label: result.grounding.anchorSummary || result.grounding.anchorSituationId }]
        : [];
    }
    const items = result.grounding.nodesByCamp?.[activeTab as 'acc' | 'saf' | 'skp' | 'cc'] || [];
    return items as GroundingItem[];
  };

  const items = getTabItems();
  const resolvedSelectedId = selectedRowId ?? (items.length > 0 ? items[0]?.nodeId : null);

  return (
    <div className="inquiry-sect">
      <span className="inquiry-eyebrow">Grounding</span>
      <div className="grounding-tabs" role="tablist">
        {[...CAMPS, 'situation' as const].map(camp => (
          <button
            key={camp}
            role="tab"
            aria-selected={activeTab === camp}
            className={`grounding-tab ${activeTab === camp ? 'active' : ''}`}
            onClick={() => {
              setActiveTab(camp);
              setSelectedRowId(null); // Reset selection on tab change
            }}
          >
            {camp === 'situation' ? 'Situation' : CAMP_LABELS[camp as 'acc' | 'saf' | 'skp' | 'cc']}
          </button>
        ))}
      </div>

      <div className="grounding-content" role="tabpanel">
        {items.length === 0 ? (
          <div className="grounding-empty">
            {activeTab === 'situation'
              ? 'No situation grounding available.'
              : `No grounding items for ${CAMP_LABELS[activeTab] as string}.`}
          </div>
        ) : (
          <>
            <table className="grounding-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Title</th>
                </tr>
              </thead>
              <tbody>
                {items.map(item => (
                  <tr
                    key={item.nodeId}
                    className={`grounding-row ${resolvedSelectedId === item.nodeId ? 'selected' : ''}`}
                    onClick={() => setSelectedRowId(item.nodeId)}
                    role="button"
                    tabIndex={0}
                    aria-selected={resolvedSelectedId === item.nodeId}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelectedRowId(item.nodeId);
                      }
                    }}
                  >
                    <td className="grounding-id">{item.nodeId}</td>
                    <td className="grounding-label">{item.label}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {resolvedSelectedId && (
              <div className="grounding-detail">
                <p className="grounding-detail-note">
                  Full node details would render here (reuse read-only node renderer).
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}




