// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useState, useEffect, useMemo } from 'react';
import { POV_KEYS } from '@lib/debate/types';
import { api } from '@bridge';
import { useDebateStore } from '../../hooks/useDebateStore';
import { useTaxonomyStore, getStoredModel } from '../../hooks/useTaxonomyStore';
import { useFeatureFlagStore } from '../../hooks/useFeatureFlags';
import type { ArgumentNetworkNode } from '../../types/debate';
import { QbafClaimBadge } from '../taxonomy/QbafOverlay';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { triggerPovNodeRegeneration } from '../../utils/regeneratePlainDescription';
import { allNodesById, allPovNodeIds, resolveNodeId } from '../../hooks/useTaxonomyStore/superseded';
import type { Pov } from '../../types/taxonomy';
import {
  extractConflictCandidates,
  extractSteelmanCandidates,
  extractDebateRefCandidates,
  extractVerdictCandidates,
  extractConceptCandidates,
  validateConflictDescription,
  validateCondensedSteelman,
  validateProposedConcept,
  generateConflictSlug,
} from '../../utils/harvestUtils';
import type {
  HarvestConflictItem,
  HarvestSteelmanItem,
  HarvestDebateRefItem,
  HarvestVerdictItem,
  HarvestConceptItem,
  HarvestManifestItem,
} from '../../utils/harvestUtils';
import './HarvestDialog.css';

// --- Module-level types (moved from inline HarvestDialog scope) ---

interface TaxonomyProposal {
  id: string;
  label: string;
  description: string;
  pov: string;
  category: string;
  rationale: string;
  sourceClaims: string[];
  checked: boolean;
}

interface TaxonomyModification {
  id: string;
  nodeId: string;
  nodeLabel: string;
  modificationType: string;
  suggestedChange: string;
  rationale: string;
  sourceClaims: string[];
  checked: boolean;
}

interface ConcessionUpdate {
  id: string;
  nodeId: string;
  nodeLabel: string;
  nodeDescription: string;
  updateType: 'qualify' | 'weaken' | 'retire';
  bdiLayer: string;
  weightedScore: number;
  distinctDebates: number;
  concessions: {
    text: string;
    speaker: string;
    concededTo: string;
    debateId: string;
    type: 'full' | 'conditional' | 'tactical';
  }[];
  checked: boolean;
}

// --- Constants ---

const CONCESSION_THRESHOLD = 3.0;
const CONCESSION_MIN_DEBATES = 2;
const CONCESSION_WEIGHTS: Record<string, number> = { full: 1.0, conditional: 0.5, tactical: 0.0 };
const HARVEST_STRENGTH_THRESHOLD = 0.7;

// --- Pure helpers ---

type TaxState = ReturnType<typeof useTaxonomyStore.getState>;

function buildConcessionCandidates(taxState: TaxState): ConcessionUpdate[] {
  const candidates: ConcessionUpdate[] = [];
  for (const pov of POV_KEYS) {
    const file = taxState[pov];
    if (!file?.nodes) continue;
    for (const node of file.nodes) {
      const history = node.concession_history;
      if (!Array.isArray(history) || history.length === 0) continue;
      const weightedScore = history.reduce(
        (sum, r) => sum + (CONCESSION_WEIGHTS[r.concession_type] ?? 0),
        0,
      );
      const distinctDebates = new Set(history.map(r => r.debate_id)).size;
      if (weightedScore >= CONCESSION_THRESHOLD && distinctDebates >= CONCESSION_MIN_DEBATES) {
        const primaryBdi = history.reduce((counts, r) => {
          counts[r.bdi_impact] = (counts[r.bdi_impact] ?? 0) + 1;
          return counts;
        }, {} as Record<string, number>);
        const topBdi = Object.entries(primaryBdi).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'belief';
        candidates.push({
          id: `hc-${candidates.length}`,
          nodeId: node.id,
          nodeLabel: node.label,
          nodeDescription: node.description,
          updateType: weightedScore >= 6.0 ? 'retire' : weightedScore >= 4.5 ? 'weaken' : 'qualify',
          bdiLayer: topBdi,
          weightedScore,
          distinctDebates,
          concessions: history.map(r => ({
            text: r.text,
            speaker: r.speaker,
            concededTo: r.conceded_to,
            debateId: r.debate_id,
            type: r.concession_type,
          })),
          checked: true,
        });
      }
    }
  }
  return candidates;
}

function parseSynthesisMetadata(
  synthMeta: Record<string, unknown>,
  getNodeLabel: (id: string) => string | null,
): { proposals: TaxonomyProposal[]; modifications: TaxonomyModification[] } {
  type RawProposal = { label: string; description: string; pov: string; category: string; rationale: string; source_claims?: string[] };
  type RawMod = { node_id: string; modification_type: string; suggested_change: string; rationale: string; source_claims?: string[] };

  const rawProposals = synthMeta.taxonomy_proposals as RawProposal[] | undefined;
  const proposals: TaxonomyProposal[] = Array.isArray(rawProposals)
    ? rawProposals.map((p, i) => ({
        id: `hp-${i}`,
        label: p.label ?? '',
        description: p.description ?? '',
        pov: p.pov ?? 'situations',
        category: p.category ?? 'Intentions',
        rationale: p.rationale ?? '',
        sourceClaims: p.source_claims ?? [],
        checked: true,
      }))
    : [];

  const rawMods = synthMeta.taxonomy_modifications as RawMod[] | undefined;
  const modifications: TaxonomyModification[] = Array.isArray(rawMods)
    ? rawMods.map((m, i) => ({
        id: `hm-${i}`,
        nodeId: m.node_id ?? '',
        nodeLabel: getNodeLabel(m.node_id) || m.node_id,
        modificationType: m.modification_type ?? 'refine_description',
        suggestedChange: m.suggested_change ?? '',
        rationale: m.rationale ?? '',
        sourceClaims: m.source_claims ?? [],
        checked: true,
      }))
    : [];

  return { proposals, modifications };
}

function applyQbafPreuncheck(
  conflicts: HarvestConflictItem[],
  anNodes: ArgumentNetworkNode[],
): void {
  for (const item of conflicts) {
    const relatedNodes = anNodes.filter(n =>
      item.linkedNodes.some(ln => n.taxonomy_refs.includes(ln)),
    );
    const avgStrength = relatedNodes.length > 0
      ? relatedNodes.reduce((sum, n) => sum + (n.computed_strength ?? 0.5), 0) / relatedNodes.length
      : 0.5;
    if (avgStrength < HARVEST_STRENGTH_THRESHOLD) {
      item.checked = false;
    }
  }
}

function resolveVerdictPrevails(
  prevails: string,
  activeDebate: { transcript: { type: string; metadata?: Record<string, unknown> }[] } | null,
): string {
  if (!/^C\d+$/.test(prevails)) return prevails;
  const synthEntry = activeDebate?.transcript.find(e => e.type === 'concluding');
  type ArgMap = { claim_id: string; claim: string; claimant: string }[];
  const argMap = (synthEntry?.metadata?.synthesis as { argument_map?: ArgMap } | undefined)?.argument_map;
  const claim = argMap?.find(c => c.claim_id === prevails);
  return claim ? `${claim.claimant}: "${claim.claim}"` : prevails;
}

// --- Apply helpers ---

type ApplyResult = { manifest: HarvestManifestItem; success: boolean };

async function applyConflictItem(
  item: HarvestConflictItem,
  debateId: string,
): Promise<ApplyResult> {
  if (!item.checked) {
    return { manifest: { type: 'conflict', action: 'created', id: item.id, status: 'rejected' }, success: false };
  }
  const faithfulText = item.verbatim || item.point;
  const conflictId = generateConflictSlug(item.generatedLabel || faithfulText, debateId);
  try {
    await api.harvestCreateConflict({
      claim_id: conflictId,
      claim_label: item.generatedLabel || faithfulText.slice(0, 60),
      description: item.generatedDescription || faithfulText,
      status: 'open',
      linked_taxonomy_nodes: item.linkedNodes,
      instances: item.positions.map(p => ({
        doc_id: `debate:${debateId}`,
        stance: p.pover === item.positions[0]?.pover ? 'supports' : 'disputes',
        assertion: p.stance,
        date_flagged: new Date().toISOString().slice(0, 10),
      })),
      source: 'debate-harvest',
      source_debate_id: debateId,
    });
    return { manifest: { type: 'conflict', action: 'created', id: conflictId, status: 'applied' }, success: true };
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'harvest-dialog', level: 'error',
      message: `Failed to create conflict ${conflictId}`,
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return { manifest: { type: 'conflict', action: 'created', id: conflictId, status: 'rejected' }, success: false };
  }
}

async function applySteelmanItem(
  item: HarvestSteelmanItem,
  debateId: string,
): Promise<ApplyResult> {
  if (!item.checked || !item.proposedSteelman) {
    return { manifest: { type: 'steelman', action: 'updated', id: item.targetNodeId, status: 'rejected' }, success: false };
  }
  try {
    await api.harvestUpdateSteelman(item.targetNodeId, item.attackerPov, item.proposedSteelman);
    return { manifest: { type: 'steelman', action: 'updated', id: `${item.targetNodeId}:from_${item.attackerPov}`, status: 'applied' }, success: true };
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'harvest-dialog', level: 'error',
      message: `Failed to update steelman for ${item.targetNodeId}`,
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return { manifest: { type: 'steelman', action: 'updated', id: item.targetNodeId, status: 'rejected' }, success: false };
  }
}

async function applyDebateRefItem(
  item: HarvestDebateRefItem,
  debateId: string,
): Promise<ApplyResult> {
  if (!item.checked) {
    return { manifest: { type: 'debate_ref', action: 'added', id: item.nodeId, status: 'rejected' }, success: false };
  }
  try {
    await api.harvestAddDebateRef(item.nodeId, debateId);
    return { manifest: { type: 'debate_ref', action: 'added', id: item.nodeId, status: 'applied' }, success: true };
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'harvest-dialog', level: 'error',
      message: `Failed to add debate ref for ${item.nodeId}`,
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return { manifest: { type: 'debate_ref', action: 'added', id: item.nodeId, status: 'rejected' }, success: false };
  }
}

async function applyVerdictItem(
  item: HarvestVerdictItem,
  debateId: string,
): Promise<ApplyResult> {
  if (!item.checked) {
    return { manifest: { type: 'verdict', action: 'updated', id: item.id, status: 'rejected' }, success: false };
  }
  const conflictSlug = item.targetConflictId || generateConflictSlug(item.conflict, debateId);
  try {
    await api.harvestAddVerdict(conflictSlug, {
      prevails: item.prevails,
      criterion: item.criterion,
      rationale: item.rationale,
      what_would_change_this: item.whatWouldChange,
      source_debate_id: debateId,
      harvested_at: new Date().toISOString(),
    });
    return { manifest: { type: 'verdict', action: 'updated', id: conflictSlug, status: 'applied' }, success: true };
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'harvest-dialog', level: 'error',
      message: `Failed to add verdict for ${conflictSlug}`,
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return { manifest: { type: 'verdict', action: 'updated', id: conflictSlug, status: 'rejected' }, success: false };
  }
}

async function applyConceptItem(
  item: HarvestConceptItem,
  debateId: string,
): Promise<ApplyResult> {
  if (!item.checked || !item.suggestedLabel) {
    const status = item.checked ? 'rejected' : 'rejected';
    return { manifest: { type: 'concept', action: 'queued', id: item.id, status }, success: false };
  }
  try {
    await api.harvestQueueConcept({
      label: item.suggestedLabel,
      description: item.suggestedDescription,
      suggested_pov: item.suggestedPov,
      suggested_category: item.suggestedCategory,
      source_debate_id: debateId,
      evidence: item.text,
    });
    return { manifest: { type: 'concept', action: 'queued', id: item.suggestedLabel, status: 'applied' }, success: true };
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'harvest-dialog', level: 'error',
      message: `Failed to queue concept ${item.id}`,
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return { manifest: { type: 'concept', action: 'queued', id: item.id, status: 'rejected' }, success: false };
  }
}

async function applyModificationItem(
  item: TaxonomyModification,
  debateId: string,
): Promise<ApplyResult> {
  const rejected: ApplyResult = { manifest: { type: 'modification', action: 'updated', id: item.nodeId, status: 'rejected' }, success: false };
  if (!item.checked || !item.suggestedChange) return rejected;
  if (item.modificationType !== 'refine_description') return rejected;
  try {
    const store = useTaxonomyStore.getState();
    let appliedPov: Pov | null = null;
    for (const pov of POV_KEYS) {
      const node = store[pov]?.nodes?.find(n => n.id === item.nodeId);
      if (node) {
        store.updatePovNode(pov, item.nodeId, { description: item.suggestedChange }, { source: 'debate_reflection', debateId, reason: item.rationale });
        appliedPov = pov;
        break;
      }
    }
    if (appliedPov) {
      triggerPovNodeRegeneration(appliedPov, item.nodeId, item.suggestedChange, store.updatePovNode);
    }
    return { manifest: { type: 'modification', action: 'updated', id: item.nodeId, status: 'applied' }, success: true };
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'harvest-dialog', level: 'error',
      message: `Failed to apply modification to ${item.nodeId}`,
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return rejected;
  }
}

// --- Section components ---

interface ConflictSectionProps {
  conflicts: HarvestConflictItem[];
  setConflicts: React.Dispatch<React.SetStateAction<HarvestConflictItem[]>>;
}
function ConflictSection({ conflicts, setConflicts }: ConflictSectionProps) {
  if (conflicts.length === 0) return null;
  const toggleConflict = (id: string) =>
    setConflicts(prev => prev.map(c => c.id === id ? { ...c, checked: !c.checked } : c));
  return (
    <div className="harvest-section">
      <h3>Conflicts ({conflicts.filter(c => c.checked).length}/{conflicts.length})</h3>
      {conflicts.map(item => (
        <div key={item.id} className={`harvest-item ${item.checked ? 'harvest-item-checked' : ''}`}>
          <label className="harvest-item-header">
            <input type="checkbox" checked={item.checked} onChange={() => toggleConflict(item.id)} />
            <span className="harvest-item-title">{item.point}</span>
            {item.bdiLayer && <span className="harvest-badge">{item.bdiLayer}</span>}
            {item.resolvability && <span className="harvest-badge harvest-badge-muted">{item.resolvability.replace(/_/g, ' ')}</span>}
          </label>
          {item.checked && (
            <div className="harvest-item-body">
              {item.positions.map((p, i) => (
                <div key={i} className="harvest-position">
                  <strong>{p.pover}:</strong> {p.stance}
                </div>
              ))}
              {item.generatedLabel && (
                <div className="harvest-generated">
                  <label>Label: <input
                    value={item.generatedLabel}
                    onChange={e => setConflicts(prev => prev.map(c => c.id === item.id ? { ...c, generatedLabel: e.target.value } : c))}
                  /></label>
                  <label>Description: <textarea
                    value={item.generatedDescription || ''}
                    onChange={e => setConflicts(prev => prev.map(c => c.id === item.id ? { ...c, generatedDescription: e.target.value } : c))}
                    rows={5}
                  /></label>
                </div>
              )}
              {item.warnings.length > 0 && (
                <div className="harvest-warnings">
                  {item.warnings.map((w, i) => <div key={i} className="harvest-warning">{w}</div>)}
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

interface SteelmanSectionProps {
  steelmans: HarvestSteelmanItem[];
  setSteelmans: React.Dispatch<React.SetStateAction<HarvestSteelmanItem[]>>;
}
function SteelmanSection({ steelmans, setSteelmans }: SteelmanSectionProps) {
  if (steelmans.length === 0) return null;
  const toggleSteelman = (id: string) =>
    setSteelmans(prev => prev.map(s => s.id === id ? { ...s, checked: !s.checked } : s));
  return (
    <div className="harvest-section">
      <h3>Steelman Refinements ({steelmans.filter(s => s.checked).length}/{steelmans.length})</h3>
      {steelmans.map(item => (
        <div key={item.id} className={`harvest-item ${item.checked ? 'harvest-item-checked' : ''}`}>
          <label className="harvest-item-header">
            <input type="checkbox" checked={item.checked} onChange={() => toggleSteelman(item.id)} />
            <span className="harvest-item-title">{item.targetNodeLabel}</span>
            <span className="harvest-badge">from {item.attackerPov}</span>
          </label>
          {item.checked && (
            <div className="harvest-item-body">
              {item.currentSteelman && (
                <div className="harvest-steelman-current">
                  <strong>Current:</strong> {item.currentSteelman}
                </div>
              )}
              {item.proposedSteelman ? (
                <div className="harvest-steelman-proposed">
                  <strong>Proposed:</strong>
                  <textarea
                    value={item.proposedSteelman}
                    onChange={e => setSteelmans(prev => prev.map(s => s.id === item.id ? { ...s, proposedSteelman: e.target.value } : s))}
                    rows={2}
                  />
                </div>
              ) : (
                <div className="harvest-steelman-source">
                  <strong>Source:</strong> {item.sourceExcerpt}
                </div>
              )}
              {item.warnings.length > 0 && (
                <div className="harvest-warnings">
                  {item.warnings.map((w, i) => <div key={i} className="harvest-warning">{w}</div>)}
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

interface VerdictSectionProps {
  verdicts: HarvestVerdictItem[];
  setVerdicts: React.Dispatch<React.SetStateAction<HarvestVerdictItem[]>>;
  activeDebate: { transcript: { type: string; metadata?: Record<string, unknown> }[] } | null;
}
function VerdictSection({ verdicts, setVerdicts, activeDebate }: VerdictSectionProps) {
  if (verdicts.length === 0) return null;
  const toggleVerdict = (id: string) =>
    setVerdicts(prev => prev.map(v => v.id === id ? { ...v, checked: !v.checked } : v));
  return (
    <div className="harvest-section">
      <h3>Preference Verdicts ({verdicts.filter(v => v.checked).length}/{verdicts.length})</h3>
      {verdicts.map(item => (
        <div key={item.id} className={`harvest-item ${item.checked ? 'harvest-item-checked' : ''}`}>
          <label className="harvest-item-header">
            <input type="checkbox" checked={item.checked} onChange={() => toggleVerdict(item.id)} />
            <span className="harvest-item-title">{item.conflict}</span>
            <span className="harvest-badge">{item.criterion?.replace(/_/g, ' ')}</span>
          </label>
          {item.checked && (
            <div className="harvest-item-body">
              <div><strong>Prevails:</strong> {resolveVerdictPrevails(item.prevails, activeDebate)}</div>
              <div><strong>Rationale:</strong> {item.rationale}</div>
              {item.whatWouldChange && (
                <div><strong>Would change if:</strong> {item.whatWouldChange}</div>
              )}
              {item.warnings.length > 0 && (
                <div className="harvest-warnings">
                  {item.warnings.map((w, i) => <div key={i} className="harvest-warning">{w}</div>)}
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

interface ConceptSectionProps {
  concepts: HarvestConceptItem[];
  setConcepts: React.Dispatch<React.SetStateAction<HarvestConceptItem[]>>;
}
function ConceptSection({ concepts, setConcepts }: ConceptSectionProps) {
  if (concepts.length === 0) return null;
  const toggleConcept = (id: string) =>
    setConcepts(prev => prev.map(c => c.id === id ? { ...c, checked: !c.checked } : c));
  return (
    <div className="harvest-section">
      <h3>New Concepts ({concepts.filter(c => c.checked).length}/{concepts.length})</h3>
      {concepts.map(item => (
        <div key={item.id} className={`harvest-item ${item.checked ? 'harvest-item-checked' : ''}`}>
          <label className="harvest-item-header">
            <input type="checkbox" checked={item.checked} onChange={() => toggleConcept(item.id)} />
            <span className="harvest-item-title">{item.text.slice(0, 100)}{item.text.length > 100 ? '...' : ''}</span>
            <span className="harvest-badge">{item.speaker}</span>
          </label>
          {item.checked && (
            <div className="harvest-item-body">
              {item.suggestedLabel ? (
                <div className="harvest-generated">
                  <label>Label: <input
                    value={item.suggestedLabel}
                    onChange={e => setConcepts(prev => prev.map(c => c.id === item.id ? { ...c, suggestedLabel: e.target.value } : c))}
                  /></label>
                  <label>Perspective:
                    <select value={item.suggestedPov} onChange={e => setConcepts(prev => prev.map(c => c.id === item.id ? { ...c, suggestedPov: e.target.value } : c))}>
                      <option value="accelerationist">Accelerationist</option>
                      <option value="safetyist">Safetyist</option>
                      <option value="skeptic">Skeptic</option>
                      <option value="situations">Situations</option>
                    </select>
                  </label>
                  <label>Category:
                    <select value={item.suggestedCategory} onChange={e => setConcepts(prev => prev.map(c => c.id === item.id ? { ...c, suggestedCategory: e.target.value } : c))}>
                      <option value="Desires">Desires</option>
                      <option value="Beliefs">Beliefs</option>
                      <option value="Intentions">Intentions</option>
                    </select>
                  </label>
                  <label>Description: <textarea
                    value={item.suggestedDescription}
                    onChange={e => setConcepts(prev => prev.map(c => c.id === item.id ? { ...c, suggestedDescription: e.target.value } : c))}
                    rows={3}
                  /></label>
                </div>
              ) : (
                <div className="harvest-steelman-source"><strong>Source claim:</strong> {item.text}</div>
              )}
              {item.warnings.length > 0 && (
                <div className="harvest-warnings">
                  {item.warnings.map((w, i) => <div key={i} className="harvest-warning">{w}</div>)}
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

interface ProposalSectionProps {
  proposals: TaxonomyProposal[];
  setProposals: React.Dispatch<React.SetStateAction<TaxonomyProposal[]>>;
}
function ProposalSection({ proposals, setProposals }: ProposalSectionProps) {
  if (proposals.length === 0) return null;
  return (
    <div className="harvest-section">
      <h3>New Node Proposals ({proposals.filter(p => p.checked).length}/{proposals.length})</h3>
      {proposals.map((item, i) => (
        <div key={item.id} className={`harvest-item ${item.checked ? 'harvest-item-checked' : ''}`}>
          <label className="harvest-item-header">
            <input type="checkbox" checked={item.checked} onChange={() => setProposals(prev => prev.map((p, j) => j === i ? { ...p, checked: !p.checked } : p))} />
            <span className="harvest-item-title">{item.label || '(untitled)'}</span>
            <span className="harvest-badge">{item.pov}</span>
            <span className="harvest-badge">{item.category}</span>
          </label>
          {item.checked && (
            <div className="harvest-item-body">
              <div className="harvest-proposal-desc">{item.description}</div>
              <div className="harvest-proposal-rationale"><strong>Rationale:</strong> {item.rationale}</div>
              {item.sourceClaims.length > 0 && (
                <div className="harvest-proposal-claims">Source claims: {item.sourceClaims.join(', ')}</div>
              )}
              <div className="harvest-proposal-edit">
                <label>Label: <input value={item.label} onChange={e => setProposals(prev => prev.map((p, j) => j === i ? { ...p, label: e.target.value } : p))} /></label>
                <label>Description: <textarea value={item.description} rows={3} onChange={e => setProposals(prev => prev.map((p, j) => j === i ? { ...p, description: e.target.value } : p))} /></label>
                <label>Perspective: <select value={item.pov} onChange={e => setProposals(prev => prev.map((p, j) => j === i ? { ...p, pov: e.target.value } : p))}>
                  <option value="accelerationist">Accelerationist</option>
                  <option value="safetyist">Safetyist</option>
                  <option value="skeptic">Skeptic</option>
                  <option value="situations">Situations</option>
                </select></label>
                <label>Category: <select value={item.category} onChange={e => setProposals(prev => prev.map((p, j) => j === i ? { ...p, category: e.target.value } : p))}>
                  <option value="Beliefs">Beliefs</option>
                  <option value="Desires">Desires</option>
                  <option value="Intentions">Intentions</option>
                </select></label>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

interface ModificationSectionProps {
  modifications: TaxonomyModification[];
  setModifications: React.Dispatch<React.SetStateAction<TaxonomyModification[]>>;
}
function ModificationSection({ modifications, setModifications }: ModificationSectionProps) {
  if (modifications.length === 0) return null;
  return (
    <div className="harvest-section">
      <h3>Node Modifications ({modifications.filter(m => m.checked).length}/{modifications.length})</h3>
      {modifications.map((item, i) => (
        <div key={item.id} className={`harvest-item ${item.checked ? 'harvest-item-checked' : ''}`}>
          <label className="harvest-item-header">
            <input type="checkbox" checked={item.checked} onChange={() => setModifications(prev => prev.map((m, j) => j === i ? { ...m, checked: !m.checked } : m))} />
            <span className="harvest-item-title">{item.nodeLabel}</span>
            <span className="harvest-badge">{item.modificationType.replace(/_/g, ' ')}</span>
          </label>
          {item.checked && (
            <div className="harvest-item-body">
              <div><strong>Node:</strong> <code>{item.nodeId}</code></div>
              <div><strong>Suggested change:</strong> {item.suggestedChange}</div>
              <div><strong>Rationale:</strong> {item.rationale}</div>
              {item.sourceClaims.length > 0 && (
                <div className="harvest-proposal-claims">Source claims: {item.sourceClaims.join(', ')}</div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

interface ConcessionSectionProps {
  concessionUpdates: ConcessionUpdate[];
  setConcessionUpdates: React.Dispatch<React.SetStateAction<ConcessionUpdate[]>>;
}
function ConcessionSection({ concessionUpdates, setConcessionUpdates }: ConcessionSectionProps) {
  if (concessionUpdates.length === 0) return null;
  return (
    <div className="harvest-section">
      <h3>Concession-Driven Updates ({concessionUpdates.filter(c => c.checked).length}/{concessionUpdates.length})</h3>
      {concessionUpdates.map((item, i) => (
        <div key={item.id} className={`harvest-item ${item.checked ? 'harvest-item-checked' : ''}`}>
          <label className="harvest-item-header">
            <input type="checkbox" checked={item.checked} onChange={() => setConcessionUpdates(prev => prev.map((c, j) => j === i ? { ...c, checked: !c.checked } : c))} />
            <span className="harvest-item-title">{item.nodeLabel}</span>
            <span className={`harvest-badge harvest-badge-${item.updateType}`}>{item.updateType}</span>
            <span className="harvest-badge">{item.bdiLayer}</span>
          </label>
          {item.checked && (
            <div className="harvest-item-body">
              <div className="harvest-concession-node">
                <code>{item.nodeId}</code>: {item.nodeDescription.slice(0, 150)}{item.nodeDescription.length > 150 ? '...' : ''}
              </div>
              <div className="harvest-concession-score">
                Weighted score: {item.weightedScore.toFixed(1)} / {CONCESSION_THRESHOLD} across {item.distinctDebates} debate{item.distinctDebates !== 1 ? 's' : ''}
              </div>
              <div className="harvest-concession-evidence">
                <strong>Concession evidence:</strong>
                {item.concessions.map((c, ci) => (
                  <div key={ci} className="harvest-concession-entry">
                    <span className={`harvest-concession-type harvest-concession-type-${c.type}`}>{c.type}</span>
                    <span className="harvest-concession-speaker">{c.speaker} → {c.concededTo}</span>
                    <span className="harvest-concession-text">"{c.text.slice(0, 120)}{c.text.length > 120 ? '...' : ''}"</span>
                  </div>
                ))}
              </div>
              {item.updateType === 'retire' && (
                <div className="harvest-concession-warning">
                  Retiring this node will archive it. References from summaries, conflicts, and edges will be preserved but marked as referencing a retired node.
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// --- HarvestDialog interface ---

interface HarvestDialogProps {
  onClose: () => void;
  fileData?: Record<string, unknown>;
}

// --- Main component ---

export function HarvestDialog({ onClose, fileData }: HarvestDialogProps) {
  const activeDebate = useDebateStore(s => s.activeDebate);
  const taxState = useTaxonomyStore.getState();

  const [conflicts, setConflicts] = useState<HarvestConflictItem[]>([]);
  const [steelmans, setSteelmans] = useState<HarvestSteelmanItem[]>([]);
  const [debateRefs, setDebateRefs] = useState<HarvestDebateRefItem[]>([]);
  const [verdicts, setVerdicts] = useState<HarvestVerdictItem[]>([]);
  const [concepts, setConcepts] = useState<HarvestConceptItem[]>([]);
  const [proposals, setProposals] = useState<TaxonomyProposal[]>([]);
  const [modifications, setModifications] = useState<TaxonomyModification[]>([]);
  const [concessionUpdates, setConcessionUpdates] = useState<ConcessionUpdate[]>([]);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<{ applied: number; failed: number } | null>(null);
  const [generatingConflicts, setGeneratingConflicts] = useState(false);
  const [generatingSteelmans, setGeneratingSteelmans] = useState(false);

  const getNodeLabel = (id: string): string | null => {
    const node = allNodesById(taxState).get(id); // superseded included: the debate cited it (t/4355)
    if (node) return node.label;
    const ccNode = taxState.situations?.nodes?.find(n => n.id === id);
    return ccNode?.label || null;
  };

  const allNodeIds = allPovNodeIds(taxState);
  for (const n of taxState.situations?.nodes || []) allNodeIds.add(n.id);

  console.log('[HarvestDialog] Render — fileData:', !!fileData, 'activeDebate:', !!activeDebate,
    'conflicts:', conflicts.length, 'steelmans:', steelmans.length, 'verdicts:', verdicts.length, 'concepts:', concepts.length);

  useEffect(() => {
    console.log('[HarvestDialog] useEffect — fileData:', !!fileData, 'activeDebate id:', activeDebate?.id);
    if (fileData) {
      // File mode — use pre-computed harvest data directly
      const fc = (fileData.conflicts as HarvestConflictItem[]) || [];
      const fs = (fileData.steelmans as HarvestSteelmanItem[]) || [];
      const fv = (fileData.verdicts as HarvestVerdictItem[]) || [];
      const fn = (fileData.concepts as HarvestConceptItem[]) || [];
      console.log('[HarvestDialog] File mode — setting:', fc.length, 'conflicts,', fs.length, 'steelmans,', fv.length, 'verdicts,', fn.length, 'concepts');
      setConflicts(fc);
      setSteelmans(fs);
      setVerdicts(fv);
      setConcepts(fn);
      return;
    }
    if (!activeDebate) return;

    // Q-15: Pre-uncheck low-strength items when QBAF is enabled
    const qbafEnabled = useFeatureFlagStore.getState().flags['release-qbaf-analysis'] ?? false;
    const anNodes: ArgumentNetworkNode[] = activeDebate.argument_network?.nodes ?? [];
    const candidateConflicts = extractConflictCandidates(activeDebate);
    if (qbafEnabled && anNodes.some(n => n.computed_strength != null)) {
      applyQbafPreuncheck(candidateConflicts, anNodes);
    }
    setConflicts(candidateConflicts);

    // A steelman is written onto its node; a superseded target is read-only history, so write to the survivor (t/4355).
    setSteelmans(extractSteelmanCandidates(activeDebate, getNodeLabel).map(s => {
      const survivor = resolveNodeId(taxState, s.targetNodeId);
      return survivor === s.targetNodeId ? s : { ...s, targetNodeId: survivor, targetNodeLabel: getNodeLabel(survivor) || survivor };
    }));
    setVerdicts(extractVerdictCandidates(activeDebate));
    setConcepts(extractConceptCandidates(activeDebate, allNodeIds));
    setConcessionUpdates(buildConcessionCandidates(taxState));

    const synthEntry = activeDebate.transcript.find(e => e.type === 'concluding');
    const synthMeta = (synthEntry?.metadata as Record<string, unknown>)?.synthesis as Record<string, unknown> | undefined;
    if (synthMeta) {
      const { proposals: p, modifications: m } = parseSynthesisMetadata(synthMeta, getNodeLabel);
      setProposals(p);
      setModifications(m);
    }
  }, [activeDebate?.id, fileData]);

  // Fill in current steelman text from taxonomy store
  useEffect(() => {
    setSteelmans(prev => prev.map(s => {
      for (const pov of POV_KEYS) {
        const node = taxState[pov]?.nodes?.find(n => n.id === s.targetNodeId);
        if (node) {
          const sv = node.graph_attributes?.steelman_vulnerability;
          const current = typeof sv === 'string' ? sv :
            (sv as Record<string, string>)?.[`from_${s.attackerPov}`] || '';
          return { ...s, currentSteelman: current };
        }
      }
      return s;
    }));
  }, [steelmans.length]);

  const existingLabels = new Set<string>();
  for (const pov of POV_KEYS) {
    for (const n of taxState[pov]?.nodes || []) existingLabels.add(n.label.toLowerCase());
  }
  for (const n of taxState.situations?.nodes || []) existingLabels.add(n.label.toLowerCase());

  // AI-generate conflict descriptions for checked items
  const generateConflictDescriptions = async () => {
    const checked = conflicts.filter(c => c.checked && !c.generatedLabel);
    if (checked.length === 0) return;
    setGeneratingConflicts(true);

    const model = useDebateStore.getState().debateModel || getStoredModel();

    for (const item of checked) {
      try {
        const positionsText = item.positions.map(p => `${p.pover}: ${p.stance}`).join('\n');
        const prompt = `Generate a label and description for this conflict entry.

Disagreement: "${item.point}"
${item.bdiLayer ? `BDI layer: ${item.bdiLayer}` : ''}
Positions:
${positionsText}

Return ONLY JSON (no markdown):
{
  "claim_label": "5-10 word label for this conflict",
  "description": "1-2 sentence description of what is contested"
}

IMPORTANT: Return ONLY claim_label and description. Do NOT include linked_taxonomy_nodes or any node IDs.`;
        const { text } = await api.generateText(prompt, model);
        const cleaned = text.replace(/```json\s*/g, '').replace(/```/g, '').trim();
        const fb = cleaned.indexOf('{'), lb = cleaned.lastIndexOf('}');
        const parsed = JSON.parse(fb >= 0 && lb > fb ? cleaned.slice(fb, lb + 1) : cleaned);

        // Use the original linkedNodes from transcript refs — don't let AI override
        const generated = {
          claim_label: parsed.claim_label || (item.verbatim || item.point).slice(0, 60),
          description: parsed.description || item.verbatim || item.point,
          linked_taxonomy_nodes: item.linkedNodes, // Always use real IDs, not AI-generated
        };
        const warnings = validateConflictDescription(generated, allNodeIds);

        setConflicts(prev => prev.map(c => c.id === item.id ? {
          ...c,
          generatedLabel: generated.claim_label,
          generatedDescription: generated.description,
          linkedNodes: generated.linked_taxonomy_nodes,
          warnings,
        } : c));
      } catch (err) {
        getGlobalRecorder()?.record({
          type: 'system.error',
          component: 'harvest-dialog',
          level: 'error',
          message: 'AI conflict description generation failed',
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        });
        setConflicts(prev => prev.map(c => c.id === item.id ? {
          ...c,
          generatedLabel: (item.verbatim || item.point).slice(0, 60),
          generatedDescription: item.verbatim || item.point,
          warnings: ['AI generation failed — using fallback text'],
        } : c));
      }
    }
    setGeneratingConflicts(false);
  };

  // AI-condense steelman candidates
  const generateSteelmanCondensations = async () => {
    const checked = steelmans.filter(s => s.checked && !s.proposedSteelman);
    if (checked.length === 0) return;
    setGeneratingSteelmans(true);

    const model = useDebateStore.getState().debateModel || getStoredModel();

    for (const item of checked) {
      try {
        const prompt = `Condense this counterargument into 1-2 sentences (50-200 chars) that capture the strongest version of the attack from the ${item.attackerPov} perspective. Be specific to the target position, not generic.

Target node: "${item.targetNodeLabel}"
Original argument by ${item.attackerPov}:
"${item.sourceExcerpt}"

Return ONLY the condensed steelman text, no JSON, no quotes.`;
        const { text } = await api.generateText(prompt, model);
        const condensed = text.trim().replace(/^["']|["']$/g, '');
        const warnings = validateCondensedSteelman(condensed, item.sourceExcerpt, item.attackerPov);

        setSteelmans(prev => prev.map(s => s.id === item.id ? {
          ...s, proposedSteelman: condensed, warnings,
        } : s));
      } catch (err) {
        getGlobalRecorder()?.record({
          type: 'system.error',
          component: 'harvest-dialog',
          level: 'error',
          message: 'AI steelman condensation failed',
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        });
        setSteelmans(prev => prev.map(s => s.id === item.id ? {
          ...s, proposedSteelman: item.sourceExcerpt.slice(0, 150),
          warnings: ['AI condensation failed — using truncated original'],
        } : s));
      }
    }
    setGeneratingSteelmans(false);
  };

  // AI-generate concept proposals for checked items
  const generateConceptProposals = async () => {
    const checked = concepts.filter(c => c.checked && !c.suggestedLabel);
    if (checked.length === 0) return;

    const model = useDebateStore.getState().debateModel || getStoredModel();

    for (const item of checked) {
      try {
        const prompt = `Propose a taxonomy node for this concept from an AI policy debate.

Concept: "${item.text}"
Speaker POV: ${item.suggestedPov}

Generate:
1. A 3-8 word plain-language label (newspaper headline style)
2. A genus-differentia description (choose ONE category). IMPORTANT: Encompasses and Excludes MUST each start on a new line (use \\n): "${item.suggestedPov === 'situations' ? 'A situation that [differentia].\\nEncompasses: ...\\nExcludes: ...' : `A Belief / A Desire / An Intention within ${item.suggestedPov} discourse that [differentia].\\nEncompasses: ...\\nExcludes: ...`}"
3. The best category: Desires, Beliefs, or Intentions
4. The node scope: "claim" (specific testable assertion), "scheme" (argumentative pattern), or "bridging" (connects claims to schemes)

Return ONLY JSON (no markdown):
{"label": "...", "description": "...", "category": "Desires or Beliefs or Intentions", "node_scope": "claim or scheme or bridging"}`;

        const { text } = await api.generateText(prompt, model);
        let cleaned = text.replace(/```json\s*/g, '').replace(/```/g, '').trim();
        const fb = cleaned.indexOf('{'), lb = cleaned.lastIndexOf('}');
        if (fb >= 0 && lb > fb) cleaned = cleaned.slice(fb, lb + 1);
        const parsed = JSON.parse(cleaned);

        const warnings = validateProposedConcept(
          { label: parsed.label, description: parsed.description, pov: item.suggestedPov, category: parsed.category || item.suggestedCategory },
          existingLabels,
        );

        setConcepts(prev => prev.map(c => c.id === item.id ? {
          ...c,
          suggestedLabel: parsed.label || item.text.slice(0, 40),
          suggestedDescription: parsed.description || item.text,
          suggestedCategory: parsed.category || item.suggestedCategory,
          warnings,
        } : c));
      } catch (err) {
        getGlobalRecorder()?.record({
          type: 'system.error',
          component: 'harvest-dialog',
          level: 'error',
          message: 'AI concept proposal generation failed',
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        });
        setConcepts(prev => prev.map(c => c.id === item.id ? {
          ...c,
          suggestedLabel: item.text.slice(0, 40),
          suggestedDescription: item.text,
          warnings: ['AI generation failed'],
        } : c));
      }
    }
  };

  // Apply all checked items
  const handleApply = async () => {
    if (!activeDebate) return;
    setApplying(true);
    getGlobalRecorder()?.record({
      type: 'lifecycle', component: 'harvest', level: 'info', message: 'harvest.start',
      data: { debate_id: activeDebate.id, conflicts: conflicts.filter(c => c.checked).length, steelmans: steelmans.filter(s => s.checked).length, debate_refs: debateRefs.filter(r => r.checked).length, verdicts: verdicts.filter(v => v.checked).length, concepts: concepts.filter(c => c.checked).length },
    });

    const manifest: HarvestManifestItem[] = [];
    const successes: boolean[] = [];

    for (const item of conflicts) {
      const r = await applyConflictItem(item, activeDebate.id);
      manifest.push(r.manifest);
      successes.push(r.success);
    }
    for (const item of steelmans) {
      const r = await applySteelmanItem(item, activeDebate.id);
      manifest.push(r.manifest);
      successes.push(r.success);
    }
    for (const item of debateRefs) {
      const r = await applyDebateRefItem(item, activeDebate.id);
      manifest.push(r.manifest);
      successes.push(r.success);
    }
    for (const item of verdicts) {
      const r = await applyVerdictItem(item, activeDebate.id);
      manifest.push(r.manifest);
      successes.push(r.success);
    }
    for (const item of concepts) {
      const r = await applyConceptItem(item, activeDebate.id);
      manifest.push(r.manifest);
      successes.push(r.success);
    }
    for (const item of modifications) {
      const r = await applyModificationItem(item, activeDebate.id);
      manifest.push(r.manifest);
      successes.push(r.success);
    }

    const applied = successes.filter(Boolean).length;
    const failed = successes.length - applied;

    await api.harvestSaveManifest({
      debate_id: activeDebate.id,
      debate_title: activeDebate.title,
      harvested_at: new Date().toISOString(),
      items: manifest,
    });

    setResult({ applied, failed });
    getGlobalRecorder()?.record({
      type: 'lifecycle', component: 'harvest', level: applied > 0 ? 'info' : 'warn', message: 'harvest.complete',
      data: { debate_id: activeDebate.id, applied, failed, manifest_items: manifest.length },
    });
    setApplying(false);
  };

  const checkedCount = conflicts.filter(c => c.checked).length +
    steelmans.filter(s => s.checked).length +
    verdicts.filter(v => v.checked).length +
    concepts.filter(c => c.checked).length +
    modifications.filter(m => m.checked).length;

  const needsGeneration = conflicts.some(c => c.checked && !c.generatedLabel) ||
    steelmans.some(s => s.checked && !s.proposedSteelman) ||
    concepts.some(c => c.checked && !c.suggestedLabel);

  if (!activeDebate && !fileData) return null;

  const isFileMode = !!fileData;
  const isEmpty = conflicts.length === 0 && steelmans.length === 0 && verdicts.length === 0
    && concepts.length === 0 && proposals.length === 0 && modifications.length === 0
    && concessionUpdates.length === 0;

  return (
    <div className={isFileMode ? '' : 'dialog-overlay'} onClick={isFileMode ? undefined : onClose}>
      <div className={isFileMode ? 'harvest-dialog' : 'dialog harvest-dialog'} onClick={e => e.stopPropagation()}>
        <h2>Harvest Debate Findings</h2>
        <p className="harvest-subtitle">Select findings to promote into the taxonomy. Review and edit before applying.</p>

        {result ? (
          <div className="harvest-result">
            <div className="harvest-result-summary">
              Applied {result.applied} items{result.failed > 0 ? `, ${result.failed} failed` : ''}.
            </div>
            <div className="dialog-actions">
              <button className="btn btn-primary" onClick={onClose}>Done</button>
            </div>
          </div>
        ) : (
          <>
            <ConflictSection conflicts={conflicts} setConflicts={setConflicts} />
            <SteelmanSection steelmans={steelmans} setSteelmans={setSteelmans} />
            <VerdictSection verdicts={verdicts} setVerdicts={setVerdicts} activeDebate={activeDebate} />
            <ConceptSection concepts={concepts} setConcepts={setConcepts} />
            <ProposalSection proposals={proposals} setProposals={setProposals} />
            <ModificationSection modifications={modifications} setModifications={setModifications} />
            <ConcessionSection concessionUpdates={concessionUpdates} setConcessionUpdates={setConcessionUpdates} />

            {isEmpty && (
              <div className="harvest-empty">No harvestable findings in this debate. Run a synthesis first.</div>
            )}

            <div className="dialog-actions">
              <button className="btn" onClick={onClose}>Cancel</button>
              {needsGeneration && (
                <button
                  className="btn"
                  onClick={() => { void generateConflictDescriptions(); void generateSteelmanCondensations(); void generateConceptProposals(); }}
                  disabled={generatingConflicts || generatingSteelmans}
                >
                  {generatingConflicts || generatingSteelmans ? 'Generating...' : 'Generate Descriptions'}
                </button>
              )}
              <button
                className="btn btn-primary"
                onClick={handleApply}
                disabled={checkedCount === 0 || applying || needsGeneration}
              >
                {applying ? 'Applying...' : `Apply ${checkedCount} items`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
