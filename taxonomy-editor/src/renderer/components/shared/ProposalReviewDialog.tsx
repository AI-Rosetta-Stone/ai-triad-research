// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Batch approve UI for taxonomy proposals (TA-3, t/135).
 * Propose-review-apply pattern — auto-apply BLOCKED.
 * Shows all TaxoAdapt proposals with approve/reject per item.
 */

import { useState, useEffect } from 'react';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { api } from '@bridge';
import { useDialog } from './useDialog'; // t/4909
import './ProposalReviewDialog.css';

interface Proposal {
  action: string;
  target_node_id: string | null;
  suggested_id: string | null;
  pov: string;
  category: string;
  label: string;
  description: string;
  rationale: string;
  evidence_doc_ids: string[];
  evidence_count: number;
  status: string;
}

interface ProposalFile {
  filename: string;
  generated_at: string;
  model: string;
  taxonomy_version: string;
  summary_count: number;
  proposals: Proposal[];
  error?: string;
}

interface ProposalReviewDialogProps {
  onClose: () => void;
}

const ACTION_COLORS: Record<string, string> = {
  NEW: '#16a34a',
  SPLIT: '#2563eb',
  MERGE: '#d97706',
  RELABEL: '#7c3aed',
  REORDER: '#0891b2',
  DEPTH_EXPAND: '#059669',
  WIDTH_EXPAND: '#be185d',
};

const POV_COLORS: Record<string, string> = {
  accelerationist: 'var(--color-acc)',
  safetyist: 'var(--color-saf)',
  skeptic: 'var(--color-skp)',
  situations: 'var(--color-sit)',
};

export function ProposalReviewDialog({ onClose }: ProposalReviewDialogProps) {
  const [files, setFiles] = useState<ProposalFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedFileIdx, setSelectedFileIdx] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<string | null>(null);
  const { dialogRef, titleId } = useDialog({ onCancel: onClose }); // t/4909

  useEffect(() => {
    setLoading(true);
    void api.listProposals().then((data: unknown[]) => {
      setFiles(data as ProposalFile[]);
    }).finally(() => setLoading(false));
  }, []);

  const selectedFile = files[selectedFileIdx];

  const handleStatusChange = (proposalIdx: number, newStatus: string) => {
    setFiles(prev => prev.map((f, fi) => {
      if (fi !== selectedFileIdx) return f;
      return {
        ...f,
        proposals: f.proposals.map((p, pi) =>
          pi === proposalIdx ? { ...p, status: newStatus } : p
        ),
      };
    }));
  };

  const handleSave = async () => {
    if (!selectedFile) return;
    setSaving(true);
    setSaveResult(null);
    try {
      const { filename, ...data } = selectedFile;
      const result = await api.saveProposal(filename, data);
      setSaveResult(result.error ?? 'Saved');
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'proposal-review', level: 'error', message: 'proposal save failed', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      setSaveResult(String(err));
    } finally {
      setSaving(false);
    }
  };

  const approveAll = () => {
    setFiles(prev => prev.map((f, fi) => {
      if (fi !== selectedFileIdx) return f;
      return { ...f, proposals: f.proposals.map(p => ({ ...p, status: 'approved' })) };
    }));
  };

  const rejectAll = () => {
    setFiles(prev => prev.map((f, fi) => {
      if (fi !== selectedFileIdx) return f;
      return { ...f, proposals: f.proposals.map(p => ({ ...p, status: 'rejected' })) };
    }));
  };

  if (loading) {
    return (
      <div className="dialog-overlay" onClick={onClose}>
        <div ref={dialogRef} className="dialog proposal-dialog" role="dialog" aria-modal aria-labelledby={titleId} onClick={e => e.stopPropagation()}>
          <p id={titleId}>Loading proposals...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div ref={dialogRef} className="dialog proposal-dialog" role="dialog" aria-modal aria-labelledby={titleId} onClick={e => e.stopPropagation()}>
        <div className="proposal-header">
          <h3 id={titleId}>Taxonomy Proposals</h3>
          <div className="proposal-file-selector">
            {files.length > 0 ? (
              <select
                value={selectedFileIdx}
                onChange={e => setSelectedFileIdx(Number(e.target.value))}
              >
                {files.map((f, i) => (
                  <option key={f.filename} value={i}>
                    {f.filename} ({f.proposals?.length ?? 0} proposals)
                  </option>
                ))}
              </select>
            ) : (
              <span className="proposal-empty">No proposal files found</span>
            )}
          </div>
        </div>

        {selectedFile && !selectedFile.error && (
          <>
            <div className="proposal-meta">
              <span>Generated: {new Date(selectedFile.generated_at).toLocaleDateString()}</span>
              <span>Model: {selectedFile.model}</span>
              <span>Sources: {selectedFile.summary_count}</span>
              <span>Version: {selectedFile.taxonomy_version}</span>
            </div>

            <div className="proposal-bulk-actions">
              <button className="btn btn-sm" onClick={approveAll}>Approve All</button>
              <button className="btn btn-sm" onClick={rejectAll}>Reject All</button>
              <span className="proposal-counts">
                {selectedFile.proposals.filter(p => p.status === 'approved').length} approved,{' '}
                {selectedFile.proposals.filter(p => p.status === 'rejected').length} rejected,{' '}
                {selectedFile.proposals.filter(p => p.status !== 'approved' && p.status !== 'rejected').length} pending
              </span>
            </div>

            <div className="proposal-list">
              {selectedFile.proposals.map((p, i) => (
                <div key={i} className={`proposal-item proposal-item-${p.status}`}>
                  <div className="proposal-item-header">
                    <span
                      className="proposal-action-badge"
                      /* eslint-disable-next-line local/no-inline-style -- backgroundColor is computed per-action from ACTION_COLORS lookup */
                      style={{ backgroundColor: ACTION_COLORS[p.action] ?? '#64748b' }}
                    >
                      {p.action}
                    </span>
                    <span
                      className="proposal-pov-badge"
                      /* eslint-disable-next-line local/no-inline-style -- color is computed per-pov from POV_COLORS lookup */
                      style={{ color: POV_COLORS[p.pov] ?? 'var(--text-muted)' }}
                    >
                      {p.pov}
                    </span>
                    <span className="proposal-category">{p.category}</span>
                    <div className="proposal-item-actions">
                      <button
                        className={`btn btn-sm ${p.status === 'approved' ? 'btn-primary' : 'btn-ghost'}`}
                        onClick={() => handleStatusChange(i, p.status === 'approved' ? 'pending' : 'approved')}
                      >
                        {p.status === 'approved' ? '\u2713 Approved' : 'Approve'}
                      </button>
                      <button
                        className={`btn btn-sm ${p.status === 'rejected' ? 'btn-danger' : 'btn-ghost'}`}
                        onClick={() => handleStatusChange(i, p.status === 'rejected' ? 'pending' : 'rejected')}
                      >
                        {p.status === 'rejected' ? '\u2717 Rejected' : 'Reject'}
                      </button>
                    </div>
                  </div>
                  <div className="proposal-item-label">{p.label}</div>
                  <div className="proposal-item-desc">{p.description}</div>
                  <div className="proposal-item-rationale">
                    <strong>Rationale:</strong> {p.rationale}
                  </div>
                  {p.evidence_doc_ids && p.evidence_doc_ids.length > 0 && (
                    <div className="proposal-item-evidence">
                      Evidence: {p.evidence_count} source{p.evidence_count !== 1 ? 's' : ''} ({p.evidence_doc_ids.slice(0, 3).join(', ')}{p.evidence_doc_ids.length > 3 ? '...' : ''})
                    </div>
                  )}
                  {p.suggested_id && (
                    <div className="proposal-item-id">Suggested ID: <code>{p.suggested_id}</code></div>
                  )}
                  {p.target_node_id && (
                    <div className="proposal-item-id">Target: <code>{p.target_node_id}</code></div>
                  )}
                </div>
              ))}
            </div>

            <div className="proposal-footer">
              <button
                className="btn btn-primary"
                onClick={handleSave}
                disabled={saving}
              >
                {saving ? 'Saving...' : 'Save Decisions'}
              </button>
              {saveResult && <span className="proposal-save-result">{saveResult}</span>}
              <button className="btn btn-ghost" onClick={onClose}>Close</button>
            </div>
          </>
        )}

        {selectedFile?.error && (
          <div className="proposal-error">{selectedFile.error}</div>
        )}

        {files.length === 0 && !loading && (
          <div className="proposal-empty-state">
            <p>No taxonomy proposals found.</p>
            <p>Run <code>Invoke-TaxonomyProposal</code> in PowerShell to generate proposals from health analysis.</p>
            <button className="btn btn-ghost" onClick={onClose}>Close</button>
          </div>
        )}
      </div>
    </div>
  );
}
