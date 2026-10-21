// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useEffect, useState, useCallback } from 'react';
import { useCommunityStore, type Submission } from '../../hooks/useCommunityStore';
import { useUserProfile } from '../../hooks/useAuthStatus';
import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';
import { allPovNodes } from '../../hooks/useTaxonomyStore/superseded';
import { useDebateStore } from '../../hooks/useDebateStore';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { useShallow } from 'zustand/react/shallow';
import { AdminErrorsTab } from './AdminErrorsTab';
import { UsageBrowserTab } from './UsageBrowserTab';
import { TOAST_DURATION_SUCCESS, TOAST_DURATION_INFO } from '../../constants';
import './AdminPanel.css';

type AdminTab = 'submissions' | 'enrichment' | 'errors' | 'usages';

function formatDate(iso: string): string {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString(); } catch (err) {
    getGlobalRecorder()?.record({ type: 'system.error', component: 'AdminPanel', level: 'error', message: 'formatDate failed', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
    return iso;
  }
}

function SubmissionRow({ sub, onApprove, onReject }: {
  sub: Submission;
  onApprove: () => Promise<void>;
  onReject: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);

  const handle = async (action: 'approve' | 'reject') => {
    setBusy(action);
    try {
      if (action === 'approve') await onApprove();
      else await onReject();
    } finally { setBusy(null); }
  };

  return (
    <tr className="admin-submission-row">
      <td>{sub.type}</td>
      <td className="admin-submission-id" title={sub.originalId}>{sub.originalId.slice(0, 8)}...</td>
      <td>{sub.submittedBy}</td>
      <td>{formatDate(sub.submittedAt)}</td>
      <td>{sub.note || '—'}</td>
      <td className="admin-submission-actions">
        <button
          className="btn btn-sm btn-primary"
          onClick={() => void handle('approve')}
          disabled={busy !== null}
        >
          {busy === 'approve' ? '...' : 'Approve'}
        </button>
        <button
          className="btn btn-sm btn-danger"
          onClick={() => void handle('reject')}
          disabled={busy !== null}
        >
          {busy === 'reject' ? '...' : 'Reject'}
        </button>
      </td>
    </tr>
  );
}

const POV_KEYS = ['accelerationist', 'safetyist', 'skeptic'] as const;

function EnrichmentRepairSection() {
  const taxState = useTaxonomyStore(useShallow(s => ({
    accelerationist: s.accelerationist,
    safetyist: s.safetyist,
    skeptic: s.skeptic,
  })));
  const { retryEnrichment, enrichmentStatus } = useDebateStore(
    useShallow(s => ({ retryEnrichment: s.retryEnrichment, enrichmentStatus: s.enrichmentStatus })),
  );
  const [repairing, setRepairing] = useState(false);
  const [repairMsg, setRepairMsg] = useState<string | null>(null);

  // t/4365: allPovNodes (selectable + superseded) so a superseded node with
  // _phrase_regen_pending still surfaces here. taxState holds only the live
  // store fields, not supersededNodes, so read the full set via getState().
  const pendingNodes: { id: string; label: string; pov: typeof POV_KEYS[number] }[] = [];
  for (const pov of POV_KEYS) {
    if (!taxState[pov]) continue;
    for (const node of allPovNodes(useTaxonomyStore.getState(), pov)) {
      if (node.graph_attributes?._phrase_regen_pending) {
        pendingNodes.push({ id: node.id, label: node.label, pov });
      }
    }
  }

  const handleRepairAll = useCallback(async () => {
    setRepairing(true);
    setRepairMsg(null);
    let ok = 0;
    let fail = 0;
    const currentTaxState = useTaxonomyStore.getState();
    const pending: { id: string; pov: typeof POV_KEYS[number] }[] = [];
    for (const pov of POV_KEYS) {
      for (const node of allPovNodes(currentTaxState, pov)) {
        if (node.graph_attributes?._phrase_regen_pending) pending.push({ id: node.id, pov });
      }
    }
    for (const { id, pov } of pending) {
      try {
        await retryEnrichment(id, pov);
        ok++;
      } catch (err) {
        getGlobalRecorder()?.record({ type: 'system.error', component: 'admin-enrichment-repair', level: 'warn', message: `Batch enrichment repair failed for ${id}`, error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
        fail++;
      }
    }
    setRepairMsg(`Repair complete: ${ok} succeeded, ${fail} failed`);
    setRepairing(false);
    setTimeout(() => setRepairMsg(null), TOAST_DURATION_SUCCESS);
  }, [retryEnrichment]);

  return (
    <div className="admin-panel-repair-section">
      <h3 className="admin-panel-repair-heading">Enrichment Repair</h3>
      <p className="admin-panel-repair-desc">
        Nodes with incomplete phrase regeneration ({pendingNodes.length} found):
      </p>
      {pendingNodes.length === 0 ? (
        <div className="admin-panel-all-enriched">All nodes are fully enriched.</div>
      ) : (
        <>
          <div className="admin-panel-pending-list">
            {pendingNodes.map(n => {
              const st = enrichmentStatus[n.id];
              return (
                <div key={n.id} className="admin-panel-pending-row">
                  <code className="admin-panel-pending-id">{n.id}</code>
                  <span className="admin-panel-pending-label">{n.label}</span>
                  {st?.status === 'pending' && <span className="admin-panel-status-pending">{'⧗'}</span>}
                  {st?.status === 'success' && <span className="admin-panel-status-success">{'✓'}</span>}
                  {st?.status === 'error' && <span className="admin-panel-status-error" title={st.error}>{'✗'}</span>}
                  <button
                    className="btn btn-sm admin-panel-retry-btn"
                    disabled={repairing || st?.status === 'pending'}
                    onClick={() => void retryEnrichment(n.id, n.pov)}
                  >Retry</button>
                </div>
              );
            })}
          </div>
          <button
            className="btn btn-primary admin-panel-repair-all-btn"
            disabled={repairing}
            onClick={() => void handleRepairAll()}
          >
            {repairing ? 'Repairing…' : `Repair All (${pendingNodes.length})`}
          </button>
        </>
      )}
      {repairMsg && <div className="admin-panel-repair-msg">{repairMsg}</div>}
    </div>
  );
}

export function AdminPanel() {
  const { submissions, fetchSubmissions, approveSubmission, rejectSubmission } = useCommunityStore();
  const profile = useUserProfile();
  const [activeTab, setActiveTab] = useState<AdminTab>('submissions');
  const [filter, setFilter] = useState<string>('pending');
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => { void fetchSubmissions(filter || undefined); }, [filter]);

  if (profile && !profile.isAdmin) {
    return (
      <div className="admin-panel">
        <div className="admin-header">
          <button className="btn btn-ghost" onClick={() => { window.location.hash = ''; window.location.reload(); }}>&larr; Back</button>
          <h2>Admin Panel</h2>
        </div>
        <div className="community-empty">You do not have admin access.</div>
      </div>
    );
  }

  const handleApprove = async (id: string) => {
    try {
      await approveSubmission(id);
      setMsg('Submission approved');
      void fetchSubmissions(filter || undefined);
    } catch (err) {
      const is409 = (err as { httpStatus?: number }).httpStatus === 409;
      getGlobalRecorder()?.record({ type: 'system.error', component: 'AdminPanel', level: is409 ? 'info' : 'error', message: is409 ? 'Approve 409 — already approved (benign)' : 'Failed to approve submission', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      setMsg(is409 ? 'Already approved — no action needed.' : `Error: ${err instanceof Error ? err.message : String(err)}`);
    }
    setTimeout(() => setMsg(null), TOAST_DURATION_INFO);
  };

  const handleReject = async (id: string) => {
    try {
      await rejectSubmission(id);
      setMsg('Submission rejected');
      void fetchSubmissions(filter || undefined);
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'AdminPanel', level: 'error', message: 'Failed to reject submission', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      setMsg(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
    setTimeout(() => setMsg(null), TOAST_DURATION_INFO);
  };

  const handleBack = () => { window.location.hash = '#community'; };

  return (
    <div className="admin-panel">
      <div className="admin-header">
        <button className="btn btn-ghost" onClick={handleBack}>&larr; Community</button>
        <h2>Admin Panel</h2>
      </div>

      <div className="admin-tab-bar">
        <button className={activeTab === 'submissions' ? 'active' : ''} onClick={() => setActiveTab('submissions')}>Submissions</button>
        <button className={activeTab === 'enrichment' ? 'active' : ''} onClick={() => setActiveTab('enrichment')}>Enrichment</button>
        <button className={activeTab === 'errors' ? 'active' : ''} onClick={() => setActiveTab('errors')}>Errors</button>
        <button className={activeTab === 'usages' ? 'active' : ''} onClick={() => setActiveTab('usages')}>Usages</button>
      </div>

      {msg && <div className="community-toast">{msg}</div>}

      {activeTab === 'submissions' && (
        <>
          <div className="admin-panel-filter-bar">
            <select
              className="admin-filter"
              value={filter}
              onChange={e => setFilter(e.target.value)}
            >
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
              <option value="">All</option>
            </select>
          </div>
          {submissions.length === 0 ? (
            <div className="community-empty">No {filter || ''} submissions.</div>
          ) : (
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Item ID</th>
                  <th>Submitted By</th>
                  <th>Date</th>
                  <th>Note</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {submissions.map(sub => (
                  <SubmissionRow
                    key={sub.id}
                    sub={sub}
                    onApprove={() => handleApprove(sub.id)}
                    onReject={() => handleReject(sub.id)}
                  />
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      {activeTab === 'enrichment' && <EnrichmentRepairSection />}

      {activeTab === 'errors' && <AdminErrorsTab />}

      {activeTab === 'usages' && <UsageBrowserTab />}
    </div>
  );
}
