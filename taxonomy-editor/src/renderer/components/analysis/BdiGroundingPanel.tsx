// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useMemo, useState } from 'react';
import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';
import { allNodesById, isSupersededNode } from '../../hooks/useTaxonomyStore/superseded';
import { SupersededBanner } from '../taxonomy/SupersededBanner';
import type { PovNode } from '../../types/taxonomy';
import type { ConceptLinkRef, EntityLinkRef } from '@lib/entities/types';
import type { LogicalForm } from '@lib/entities/logicalForm';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import './BdiGroundingPanel.css';

// Measured maturity figures (t/3353 §2, docs/logical-form-surfacing-and-consumption-proposal.md).
// Update alongside the register if these are re-measured — cited, never invented.
const FOL_WEAK_AXES_NOTE =
  'Experimental — predicate (~0.68) and args (~0.30) axes are unvalidated. ' +
  'Do not treat participants below as authoritative.';

const FOL_HOLDER_LABEL: Record<string, string> = {
  'camp:acc': 'Accelerationist',
  'camp:saf': 'Safetyist',
  'camp:skp': 'Skeptic',
};

// logical_form is validated by lib/entities/logicalForm.ts but not yet declared on the PovNode
// TS interface (t/3157 added entity_refs/concept_refs there; logical_form predates that and is
// accessed via cast elsewhere in this codebase, e.g. taxonomyDataSlice.ts's reattach-on-save path).
function getLogicalForm(node: PovNode): LogicalForm | undefined {
  return (node as unknown as { logical_form?: LogicalForm }).logical_form;
}

interface TopicalCandidates {
  refs: { ref: string; match_level: string }[];
}

// Option-C `topical_candidates` (t/3389, logical-form-schema.md §topical_candidates) is additive
// phase-1 and Python-only so far — no TS Zod entry yet. Read defensively at runtime; render only
// the documented shape, never assume a ref-kind beyond what's present (t/3397 spec point 6).
function getTopicalCandidates(lf: LogicalForm): TopicalCandidates | undefined {
  const tc = (lf as unknown as { topical_candidates?: unknown }).topical_candidates;
  if (!tc || typeof tc !== 'object') return undefined;
  const refs = (tc as Record<string, unknown>).refs;
  if (!Array.isArray(refs)) return undefined;
  return { refs: refs as { ref: string; match_level: string }[] };
}

// Copy reviewed and approved by CL (field-semantics owner) — e/155#2. Do not edit without
// looping CL in again; this is prompt/ontology-adjacent labeling text (t/3466).
const DEBATE_GROUNDING_CAPTION =
  "First-person restatement — used by the debate engine as this node's grounding text, " +
  "distinct from the node's editorial description.";
const DEBATE_GROUNDING_ABSENT_TEXT =
  "Not yet grounded — this node doesn't have a first-person restatement yet.";

function DebateGroundingSection({ text }: { text: string | undefined }) {
  return (
    <section className="bdi-gr-section bdi-gr-debate-grounding">
      <div className="bdi-gr-section-header">
        <span className="bdi-gr-section-title">Debate Grounding</span>
        <span className="bdi-gr-fp-badge" title="First-person, own-voice restatement of the node">first-person</span>
      </div>
      {text ? (
        <>
          <blockquote className="bdi-gr-fp-quote">&ldquo;{text}&rdquo;</blockquote>
          <p className="bdi-gr-fp-caption">{DEBATE_GROUNDING_CAPTION}</p>
        </>
      ) : (
        <p className="bdi-gr-section-empty bdi-gr-fp-absent">{DEBATE_GROUNDING_ABSENT_TEXT}</p>
      )}
    </section>
  );
}

function confidencePct(v: number): string {
  return v >= 1 ? '100%' : `${Math.round(v * 100)}%`;
}

interface ConceptRowProps {
  linkRef: ConceptLinkRef;
  onClick: () => void;
}

function ConceptRow({ linkRef, onClick }: ConceptRowProps) {
  const isProposed = linkRef.status === 'proposed';
  return (
    <button
      className={`bdi-gr-row${isProposed ? ' bdi-gr-row--proposed' : ''}`}
      onClick={onClick}
      title={`${linkRef.ref} — open Vocabulary panel`}
    >
      <span className="bdi-gr-surface">{linkRef.surface}</span>
      <span className={`bdi-gr-method bdi-gr-method--${linkRef.method}`}>{linkRef.method}</span>
      <span className={`bdi-gr-status bdi-gr-status--${linkRef.status}`}>{linkRef.status}</span>
      <span className="bdi-gr-conf">{confidencePct(linkRef.link_confidence)}</span>
    </button>
  );
}

interface EntityRowProps {
  linkRef: EntityLinkRef;
  onClick: () => void;
}

function EntityRow({ linkRef, onClick }: EntityRowProps) {
  const isProposed = linkRef.status === 'proposed';
  return (
    <button
      className={`bdi-gr-row${isProposed ? ' bdi-gr-row--proposed' : ''}`}
      onClick={onClick}
      title={`${linkRef.ref} — open entity record`}
    >
      <span className="bdi-gr-surface">{linkRef.surface}</span>
      <span className="bdi-gr-ref">{linkRef.ref}</span>
      <span className={`bdi-gr-method bdi-gr-method--${linkRef.method}`}>{linkRef.method}</span>
      <span className={`bdi-gr-status bdi-gr-status--${linkRef.status}`}>{linkRef.status}</span>
      <span className="bdi-gr-conf">{confidencePct(linkRef.link_confidence)}</span>
    </button>
  );
}

function FormalizationSection({ logicalForm }: { logicalForm: LogicalForm }) {
  const [expanded, setExpanded] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const topicalCandidates = getTopicalCandidates(logicalForm);
  const aboutRefs = logicalForm.about ?? [];

  return (
    <section className="bdi-gr-section bdi-gr-fol">
      <button
        type="button"
        className="bdi-gr-section-header bdi-gr-fol-toggle"
        onClick={() => setExpanded(e => !e)}
        aria-expanded={expanded}
      >
        <span className="bdi-gr-fol-caret">{expanded ? '▾' : '▸'}</span>
        <span className="bdi-gr-section-title">Formalization</span>
        <span className="bdi-gr-fol-badge" title="Derived, unconsumed layer — no downstream consumer relies on this yet">experimental</span>
      </button>

      {expanded && (
        <div className="bdi-gr-fol-body">
          <p className="bdi-gr-fol-weak-note">{FOL_WEAK_AXES_NOTE}</p>

          <div className="bdi-gr-fol-header-row">
            <span className="bdi-gr-fol-predicate">{logicalForm.predicate}</span>
            <span className={`bdi-gr-fol-polarity bdi-gr-fol-polarity--${logicalForm.polarity}`}>{logicalForm.polarity}</span>
            {logicalForm.modality && (
              <span className="bdi-gr-fol-modality">
                {FOL_HOLDER_LABEL[logicalForm.modality.holder] ?? logicalForm.modality.holder} · {logicalForm.modality.attitude}
              </span>
            )}
            <span className="bdi-gr-fol-temporal">
              {logicalForm.temporal.type}{logicalForm.temporal.value ? ` ${logicalForm.temporal.value}` : ''}
            </span>
          </div>

          <div className="bdi-gr-fol-participants">
            <div className="bdi-gr-fol-participants-header">
              <span className="bdi-gr-fol-participants-title">Participants</span>
              <span className="bdi-gr-fol-low-reliability" title="args ~0.30 — see the experimental note above">⚠ low-reliability axis</span>
            </div>
            {logicalForm.args.length === 0
              ? <p className="bdi-gr-section-empty">No participants recorded.</p>
              : logicalForm.args.map((arg, i) => (
                <div key={i} className="bdi-gr-fol-arg-row">
                  <span className="bdi-gr-fol-arg-role">{arg.role}</span>
                  <span className="bdi-gr-ref">{arg.ref}</span>
                  <span className="bdi-gr-fol-arg-sort">{arg.sort}</span>
                  <span className="bdi-gr-fol-arg-match">{arg.match_level}</span>
                </div>
              ))}
          </div>

          {aboutRefs.length > 0 && (
            <div className="bdi-gr-fol-about">
              <span className="bdi-gr-fol-about-label">about</span>
              {aboutRefs.map((a, i) => (
                <span key={i} className="bdi-gr-status bdi-gr-status--proposed" title={`match_level: ${a.match_level}`}>
                  {a.ref}
                </span>
              ))}
            </div>
          )}

          {topicalCandidates && topicalCandidates.refs.length > 0 && (
            <div className="bdi-gr-fol-about">
              <span className="bdi-gr-fol-about-label">topical candidates</span>
              <span className="bdi-gr-status bdi-gr-status--proposed" title="validated: false — Option-C concept layer, t/3389">unvalidated</span>
              {topicalCandidates.refs.map((r, i) => (
                <span key={i} className="bdi-gr-status bdi-gr-status--proposed" title={`match_level: ${r.match_level}`}>
                  {r.ref}
                </span>
              ))}
            </div>
          )}

          <div className="bdi-gr-fol-footer-row">
            <span className={`bdi-gr-fol-status bdi-gr-fol-status--${logicalForm.status}`}>{logicalForm.status}</span>
            <span
              className="bdi-gr-fol-confidence"
              title="Self-rated by the formalization pass — stipulated, not correlated with measured correctness"
            >
              confidence {confidencePct(logicalForm.formalization_confidence)} (self-rated)*
            </span>
          </div>

          <button type="button" className="bdi-gr-fol-debug-toggle" onClick={() => setShowRaw(s => !s)}>
            {showRaw ? 'Hide raw frame' : 'View raw frame (debug)'}
          </button>
          {showRaw && <pre className="bdi-gr-fol-raw">{JSON.stringify(logicalForm, null, 2)}</pre>}
        </div>
      )}
    </section>
  );
}

export function BdiGroundingPanel() {
  const { selectedNodeId, accelerationist, safetyist, skeptic, setToolbarPanel } = useTaxonomyStore();

  const node = useMemo(() => {
    if (!selectedNodeId) return null;
    const found = allNodesById(useTaxonomyStore.getState()).get(selectedNodeId) ?? null;
    if (!found && selectedNodeId) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'BdiGroundingPanel',
        level: 'warn',
        message: `Selected node not found in any POV file: ${selectedNodeId}`,
        error: { name: 'NotFound', message: `Node ${selectedNodeId} not in acc/saf/skp`, stack: '' },
      });
    }
    return found;
  }, [selectedNodeId, accelerationist, safetyist, skeptic]);

  if (!selectedNodeId || !node) {
    return <div className="bdi-gr-empty">Select a BDI node to view its concept and entity links.</div>;
  }

  const conceptRefs = node.concept_refs ?? [];
  const entityRefs = node.entity_refs ?? [];
  const logicalForm = getLogicalForm(node);
  const debateGrounding = node.graph_attributes?.debate_grounding;

  return (
    <div className="bdi-gr-root">
      {isSupersededNode(node) && <SupersededBanner node={node} />}
      <DebateGroundingSection text={debateGrounding} />

      <section className="bdi-gr-section">
        <div className="bdi-gr-section-header">
          <span className="bdi-gr-section-title">Concepts</span>
          <span className="bdi-gr-dolce bdi-gr-dolce--kind" title="DOLCE: universal · kind">universal · kind</span>
          <span className="bdi-gr-section-count">{conceptRefs.length}</span>
        </div>
        {conceptRefs.length === 0
          ? <p className="bdi-gr-section-empty">No concept links on this node.</p>
          : conceptRefs.map(r => (
            <ConceptRow key={r.ref} linkRef={r} onClick={() => setToolbarPanel('vocabulary')} />
          ))}
      </section>

      <section className="bdi-gr-section">
        <div className="bdi-gr-section-header">
          <span className="bdi-gr-section-title">Entities</span>
          <span className="bdi-gr-dolce bdi-gr-dolce--particular" title="DOLCE: particular">particular</span>
          <span className="bdi-gr-section-count">{entityRefs.length}</span>
        </div>
        {entityRefs.length === 0
          ? <p className="bdi-gr-section-empty">No entity links — this is normal for most nodes.</p>
          : entityRefs.map(r => (
            <EntityRow key={r.ref} linkRef={r} onClick={() => setToolbarPanel('entities')} />
          ))}
      </section>

      {logicalForm && <FormalizationSection logicalForm={logicalForm} />}
    </div>
  );
}
