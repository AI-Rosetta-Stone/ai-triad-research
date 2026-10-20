// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useState, useEffect, useMemo } from 'react';
import { api } from '@bridge';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { groupByDocument } from './sourceGrouping';
import './PolicySourcesPanel.css';

export interface PolicySourceReference {
  docId: string;
  /** t/4336: the real document this reference belongs to (t/4334). Until the policy index carries it, rows
   *  group by `docId` and the grouping helper WARNs once. */
  canonicalDocId?: string;
  title: string;
  dateIngested: string;
  sourceTime: string;
  stance: string;
  nodeId: string;
  pov: string;
}

type PolicySourceIndex = Record<string, PolicySourceReference[]>;

// Module-level cache -- built once, reused across renders
let _policyIndexCache: PolicySourceIndex | null = null;
let _policyIndexLoading = false;
let _policyIndexListeners: Array<() => void> = [];

async function getPolicySourceIndex(): Promise<PolicySourceIndex> {
  if (_policyIndexCache) return _policyIndexCache;
  if (_policyIndexLoading) {
    return new Promise((resolve) => {
      _policyIndexListeners.push(() => resolve(_policyIndexCache!));
    });
  }
  _policyIndexLoading = true;
  try {
    _policyIndexCache = (await api.buildPolicySourceIndex()) as PolicySourceIndex;
  } catch (err) {
    getGlobalRecorder()?.record({ type: 'system.error', component: 'policy-sources', level: 'error', message: 'Failed to build policy source index', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
    _policyIndexCache = {};
  }
  _policyIndexLoading = false;
  for (const cb of _policyIndexListeners) cb();
  _policyIndexListeners = [];
  return _policyIndexCache;
}

/** Expose the cached index for other components (e.g. PolicyDashboard timeline) */
export { getPolicySourceIndex };

const STANCE_LABELS: Record<string, string> = {
  strongly_aligned: 'Strongly Aligned',
  aligned: 'Aligned',
  neutral: 'Neutral',
  qualifies: 'Qualifies',
  disputes: 'Disputes',
};

const POV_LABELS: Record<string, string> = {
  accelerationist: 'Acc',
  safetyist: 'Saf',
  skeptic: 'Skp',
};

/** The same node, stance and POV repeated across a document's split parts is one reference. */
const POLICY_REF_KEY = (r: PolicySourceReference) => `${r.nodeId}\u0000${r.stance}\u0000${r.pov}`;

interface PolicySourcesPanelProps {
  policyId: string;
}

export function PolicySourcesPanel({ policyId }: PolicySourcesPanelProps) {
  const [refs, setRefs] = useState<PolicySourceReference[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setExpanded(null);
    void getPolicySourceIndex().then((index) => {
      setRefs(index[policyId] || []);
      setLoading(false);
    });
  }, [policyId]);

  // t/4336: one row per real document, the same reference counted once (shared with SourcesPanel).
  const grouped = useMemo(
    () => (refs ? groupByDocument(refs, { refKey: POLICY_REF_KEY, component: 'policy-sources' }) : []),
    [refs],
  );

  if (loading) {
    return <div className="policy-sources-loading">Loading source references...</div>;
  }

  if (grouped.length === 0) {
    return <div className="policy-sources-empty">No sources reference this policy.</div>;
  }

  const refCount = grouped.reduce((n, g) => n + g.refs.length, 0);
  return (
    <div className="policy-sources-panel">
      <div className="policy-sources-summary">
        {refCount} reference{refCount !== 1 ? 's' : ''} across {grouped.length} document{grouped.length !== 1 ? 's' : ''}
      </div>

      {grouped.map(({ canonicalDocId: docId, first, refs: docRefs }) => {
        const isExpanded = expanded === docId;

        return (
          <div key={docId} className="policy-sources-doc">
            <button
              className={`policy-sources-doc-header${isExpanded ? ' policy-sources-doc-expanded' : ''}`}
              onClick={() => setExpanded(isExpanded ? null : docId)}
            >
              <span className="policy-sources-doc-title">{first.title}</span>
              <span className="policy-sources-doc-meta">
                <span className="policy-sources-doc-count">{docRefs.length}</span>
                {first.dateIngested && (
                  <span className="policy-sources-doc-date">{first.dateIngested}</span>
                )}
              </span>
            </button>

            {isExpanded && (
              <div className="policy-sources-doc-body">
                {docRefs.map((r, i) => (
                  <div key={i} className="policy-sources-ref">
                    <span className={`policy-sources-stance policy-sources-stance-${r.stance}`}>
                      {STANCE_LABELS[r.stance] ?? r.stance}
                    </span>
                    <span className="policy-sources-pov">{POV_LABELS[r.pov] ?? r.pov}</span>
                    <span className="policy-sources-node-id">{r.nodeId}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
