// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useState, useEffect, useMemo, useCallback } from 'react';
import { loadPovTagRegistry, type PovTagRegistry } from '@lib/schema/povTags';
import type { PovTagProposal, PovTagProposalsFile, ValueBasisRun } from '@lib/schema/povTagProposals';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { api, isElectronMode } from '@bridge';
import type { Pov } from '../../types/taxonomy';
import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';
import { mergeHeld } from '../../hooks/useTaxonomyStore/superseded';
import type { PovKey } from '../../hooks/useTaxonomyStore/superseded';
import { mapErrorToUserMessage } from '../../utils/errorMessages';
import { reviewTier, sortForReview } from '../../utils/povTagProposalOrder';
import {
  proposalsForPov, filterProposals, decisionFor, proposalFileUncommitted,
  DEFAULT_PROPOSAL_FILTER, NO_TAG, type ProposalFilter,
} from '../../utils/povTagProposalQueue';
import { provenanceState } from '../../utils/povTagValueBasis';
import { PovTagEditor } from './PovTagEditor';
import { ValueBasisBlock, ProvenanceNote, bundledSkepticSoulProvenance } from './PovTagValueBasis';
import './PovTagProposalQueue.css';

const COMPONENT = 'pov-tag-proposal-queue';
const STATUS_OPTIONS = ['all', 'pending', 'accepted', 'modified', 'rejected'] as const;
const CATEGORY_OPTIONS = ['all', 'beliefs', 'desires', 'intentions'] as const;

const errorOf = (err: unknown) => ({ name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack });

/** The side file, or null when it is absent or unavailable (a missing handler or a read error is a WARN). */
async function loadProposals(): Promise<PovTagProposalsFile | null> {
  try {
    return await api.loadPovTagProposals();
  } catch (err) {
    getGlobalRecorder()?.record({ type: 'system.error', component: COMPONENT, level: 'warn', message: 'POV-tag proposals could not be loaded; the review queue is hidden', error: errorOf(err) });
    return null;
  }
}

/**
 * Entry point beside the POV tag filter (t/4052). Hidden when the side file is absent or has nothing for this POV.
 */
export function PovTagProposalButton({ pov }: { pov: Pov }) {
  const [file, setFile] = useState<PovTagProposalsFile | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let live = true;
    void loadProposals().then(f => { if (live) setFile(f); });
    return () => { live = false; };
  }, []);
  const items = useMemo(() => proposalsForPov(file, pov), [file, pov]);
  if (!file || items.length === 0) return null;
  const pending = items.filter(p => p.status === 'pending').length;
  return (
    <>
      <button type="button" className="btn btn-ghost btn-sm ptp-open-btn" onClick={() => setOpen(true)} title="Review proposed POV tags">
        Tag proposals ({pending} pending)
      </button>
      {open && <PovTagProposalQueue pov={pov} initialFile={file} onClose={(latest) => { setFile(latest); setOpen(false); }} />}
    </>
  );
}

/**
 * The review queue (t/4052). Accept / Modify / Reject record a decision in pov-tag-proposals.json only; nothing
 * here writes pov_tags or a node file. Desktop only: hosted web lists proposals read-only (its POST answers 405).
 */
export function PovTagProposalQueue({ pov, initialFile, onClose }: {
  pov: Pov;
  initialFile: PovTagProposalsFile;
  onClose: (latest: PovTagProposalsFile) => void;
}) {
  const [file, setFile] = useState(initialFile);
  const [filter, setFilter] = useState<ProposalFilter>(DEFAULT_PROPOSAL_FILTER);
  const [editing, setEditing] = useState<{ nodeId: string; draft: string[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, string>>({});
  const [uncommitted, setUncommitted] = useState(false);
  const canReview = isElectronMode();
  const nodes = useTaxonomyStore((s) => s[pov]?.nodes);
  const heldNodes = useTaxonomyStore((s) => s.supersededNodes?.[pov as PovKey]); // t/4355: a proposal may target a since-superseded node
  const registry = useMemo(() => loadPovTagRegistry(), []);
  const tagOptions = registry.povs[pov as keyof typeof registry.povs] ?? [];
  const tagLabel = (id: string) => tagOptions.find(t => t.id === id)?.label ?? id;
  const nodeById = useMemo(() => new Map(mergeHeld(nodes ?? [], heldNodes ?? []).map(n => [n.id, n])), [nodes, heldNodes]);
  const all = useMemo(() => proposalsForPov(file, pov), [file, pov]);
  const shown = useMemo(() => sortForReview(filterProposals(all, filter)), [all, filter]);
  // t/4052#9: justifications are compared against the souls THIS app bundles, via the canonical comparator.
  const run = file.value_basis_run;
  const provenance = useMemo(() => provenanceState(run?.soul_provenance, bundledSkepticSoulProvenance()), [run]);

  const refreshUncommitted = useCallback(() => {
    if (!canReview) return;
    api.getChangedFiles()
      .then(changed => setUncommitted(proposalFileUncommitted(changed)))
      .catch(err => {
        getGlobalRecorder()?.record({ type: 'system.error', component: COMPONENT, level: 'warn', message: 'Could not check whether reviews are committed; the note is not shown', error: errorOf(err) });
      });
  }, [canReview]);
  useEffect(() => { refreshUncommitted(); }, [refreshUncommitted]);

  const setMessage = (nodeId: string, text: string) => setMessages(m => ({ ...m, [nodeId]: text }));

  const decide = async (p: PovTagProposal, kind: 'accept' | 'reject' | 'modify', draft?: string[]) => {
    setBusy(p.node_id);
    setMessage(p.node_id, '');
    try {
      const result = await api.reviewPovTagProposal(p.node_id, decisionFor(kind, p.proposed, draft), p.status);
      if ('refused' in result) {
        getGlobalRecorder()?.record({ type: 'state.change', component: COMPONENT, level: 'warn', message: `Review refused (${result.refused}) for ${p.node_id}`, data: { problems: result.problems } });
        if (result.refused === 'conflict') {
          const fresh = await loadProposals();
          if (fresh) setFile(fresh);
          setMessage(p.node_id, 'Someone else reviewed this item first. It has been refreshed; check it and decide again.');
        } else {
          setMessage(p.node_id, `Not saved: ${result.problems.join('; ')}`);
        }
        return;
      }
      setFile(result.file);
      setEditing(null);
      refreshUncommitted();
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: COMPONENT, level: 'error', message: `Saving the review for ${p.node_id} failed`, error: errorOf(err) });
      setMessage(p.node_id, `Could not save the review: ${mapErrorToUserMessage(err)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="dialog-overlay" onClick={() => onClose(file)}>
      <div className="ptp-dialog" role="dialog" aria-label="POV tag proposals" onClick={e => e.stopPropagation()}>
        <div className="ptp-header">
          <h2 className="ptp-title">POV tag proposals</h2>
          <button type="button" className="btn btn-ghost" onClick={() => onClose(file)} aria-label="Close">&times;</button>
        </div>
        {/* t/4083 (PI UAT): an accept records the decision only; pov_tags are written later in one batch (spec t3935 §7 step 4). */}
        <div className="ptp-note ptp-outcome">
          Decisions are recorded here, not on the node. Tags are applied to the taxonomy in one batch once every item is reviewed ({all.filter(p => p.status === 'pending').length} pending).
        </div>
        {!canReview && <div className="ptp-note">Reviews are recorded from the desktop app so they land in the data repo. This list is read-only here.</div>}
        {uncommitted && <div className="ptp-note">Reviews are saved in your local data checkout but not yet committed; step 4 uses data <code>main</code>.</div>}
        {run && <ProvenanceNote state={provenance} />}
        <div className="ptp-filters">
          <select aria-label="Status" value={filter.status} onChange={e => setFilter(f => ({ ...f, status: e.target.value as ProposalFilter['status'] }))}>
            {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s === 'all' ? 'All statuses' : s}</option>)}
          </select>
          <select aria-label="Proposed tag" value={filter.tag} onChange={e => setFilter(f => ({ ...f, tag: e.target.value }))}>
            <option value="all">Any proposed tag</option>
            <option value={NO_TAG}>No tag proposed</option>
            {tagOptions.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
          <select aria-label="Category" value={filter.category} onChange={e => setFilter(f => ({ ...f, category: e.target.value }))}>
            {CATEGORY_OPTIONS.map(c => <option key={c} value={c}>{c === 'all' ? 'All categories' : c}</option>)}
          </select>
          <span className="ptp-count">{shown.length} of {all.length}</span>
        </div>
        <ol className="ptp-list">
          {shown.map(p => (
            <ProposalItem
              key={p.node_id}
              pov={pov}
              p={p}
              node={nodeById.get(p.node_id)}
              registry={registry}
              run={run}
              tagLabel={tagLabel}
              editing={editing?.nodeId === p.node_id ? editing.draft : null}
              disabled={!canReview || busy !== null}
              message={messages[p.node_id]}
              onEdit={draft => setEditing(draft ? { nodeId: p.node_id, draft } : null)}
              onDecide={(kind, draft) => void decide(p, kind, draft)}
            />
          ))}
        </ol>
      </div>
    </div>
  );
}

/** t/4083 (PI UAT): an accepted or modified decision is saved in the proposals file, not on the node. */
function RecordedBadge({ status }: { status: PovTagProposal['status'] }) {
  if (status !== 'accepted' && status !== 'modified') return null;
  return (
    <span className="ptp-recorded" title="This decision is saved in the proposals file. The node's POV tags change only when the reviewed batch is applied.">
      Recorded — not yet applied
    </span>
  );
}

/** One proposal: the node, what was proposed and why, and the decision controls. */
function ProposalItem({ pov, p, node, registry, run, tagLabel, editing, disabled, message, onEdit, onDecide }: {
  pov: Pov;
  p: PovTagProposal;
  node: { label?: string; description?: string } | undefined;
  registry: PovTagRegistry;
  run: ValueBasisRun | undefined;
  tagLabel: (id: string) => string;
  /** The Modify draft, or null when not modifying. */
  editing: string[] | null;
  disabled: boolean;
  message: string | undefined;
  onEdit: (draft: string[] | null) => void;
  onDecide: (kind: 'accept' | 'reject' | 'modify', draft?: string[]) => void;
}) {
  const chips = (ids: readonly string[]) => ids.length === 0
    ? <span className="ptp-none">No tag</span>
    : ids.map(id => <span key={id} className="pov-tag-chip">{tagLabel(id)}</span>);
  return (
    <li className="ptp-item">
      <div className="ptp-item-head">
        <span className="ptp-tier">{reviewTier(p).label}</span>
        <strong>{node?.label ?? '(node not loaded)'}</strong>
        <code>{p.node_id}</code>
        <span className={`ptp-status ptp-status-${p.status}`}>{p.status}</span>
        <RecordedBadge status={p.status} />
      </div>
      {node?.description && <p className="ptp-desc">{node.description}</p>}
      <div className="ptp-row"><span className="ptp-key">Proposed</span>{chips(p.proposed)}</div>
      {p.status !== 'pending' && p.final && (
        <div className="ptp-row"><span className="ptp-key">Final</span>{chips(p.final)}<span className="ptp-meta">by {p.reviewed_by ?? '?'} · {p.reviewed_at ?? '?'}</span></div>
      )}
      <div className="ptp-meta">Crux: {typeof p.crux === 'string' ? p.crux : 'none'} · Confidence: {typeof p.confidence === 'number' ? p.confidence.toFixed(2) : 'n/a'}</div>
      {run ? <ValueBasisBlock p={p} run={run} tagLabel={tagLabel} /> : p.rationale && <p className="ptp-rationale">{p.rationale}</p>}
      {editing ? (
        <div className="ptp-modify">
          <PovTagEditor pov={pov} tags={editing} readOnly={false} registry={registry} onChange={next => onEdit(next ?? [])} />
          <button type="button" className="btn btn-primary btn-sm" disabled={disabled} onClick={() => onDecide('modify', editing)}>Save</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onEdit(null)}>Cancel</button>
        </div>
      ) : (
        <div className="ptp-actions">
          <button type="button" className="btn btn-sm" disabled={disabled} onClick={() => onDecide('accept')}>Accept</button>
          <button type="button" className="btn btn-sm" disabled={disabled} onClick={() => onEdit([...p.proposed])}>Modify</button>
          <button type="button" className="btn btn-sm" disabled={disabled} onClick={() => onDecide('reject')}>Reject</button>
        </div>
      )}
      {message && <div className="error-text">{message}</div>}
    </li>
  );
}
