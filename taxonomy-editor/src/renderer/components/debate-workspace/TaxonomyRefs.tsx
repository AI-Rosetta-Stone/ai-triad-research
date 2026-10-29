// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useEffect, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { TaxonomyRef, TranscriptEntry } from '../../types/debate';
import type { CoverageMap, StrengthWeightedCoverage } from '@lib/debate/coverageTracker';
import { humanizeSpeakerIds } from '../../utils/humanizeSpeakers';
import {
  nodeIdToTab, getNodeLabel, getNodeWeight, focusMainWindowNode,
  buildExplainPrompt, buildSelectionExplainPrompt, fixMarkdownLinks, resolvePolRef, getPolicyAction,
} from './utils';
import type { PolicyRefEntry } from './utils';
import { TaxNodeDetail } from '../shared/TaxNodeDetail';
import { TheoryLink } from '../shared/TheoryLink';
import { SectionErrorBoundary } from './SectionErrorBoundary';
import { ExplainPanel } from './ExplainPanel';
import { registerExplainTarget } from './explainRequestBus';
import './TaxonomyRefs.css';

// Prevents a TheoryLink click inside a <summary> from toggling its parent <details>
// (t/2347 mount f) — keeps the summary natively interactive, no stopPropagation wrapper.
function suppressDetailsToggleForHelp(e: React.MouseEvent) {
  if ((e.target as HTMLElement).closest('.theory-link')) e.preventDefault();
}

export function CoverageBadge({ coverageMap, strengthWeighted }: { coverageMap: CoverageMap; strengthWeighted?: StrengthWeightedCoverage | null }) {
  const { stats } = coverageMap;
  const pct = Math.round(stats.coveragePercentage);
  const colorClass = pct > 75 ? 'coverage-badge-green' : pct >= 40 ? 'coverage-badge-yellow' : 'coverage-badge-red';
  const covered = stats.coveredCount + stats.partiallyCoveredCount;
  const swPct = strengthWeighted ? Math.round(strengthWeighted.strength_weighted_coverage) : null;
  const titleParts = [
    `TAXONOMY GROUNDING`,
    `Measures how many of this debate's claims are grounded in taxonomy nodes.`,
    ``,
    `Current: ${covered}/${stats.totalClaims} claims grounded (${pct}%)`,
    `  ${stats.coveredCount} fully grounded (claim maps to 1+ taxonomy nodes)`,
    `  ${stats.partiallyCoveredCount} partially grounded (weak or indirect mapping)`,
    `  ${stats.uncoveredCount} ungrounded (no taxonomy connection)`,
  ];
  if (swPct !== null) {
    titleParts.push(``);
    titleParts.push(`Strength-weighted: ${swPct}%`);
    titleParts.push(`Weights each claim by its QBAF argumentation strength,`);
    titleParts.push(`so strongly-supported claims count more than weak ones.`);
  }
  titleParts.push(``);
  titleParts.push(`Color bands: green >75% | yellow 40-75% | red <40%`);
  titleParts.push(`Higher grounding = debate is well-anchored in the taxonomy.`);

  return (
    <span className={`coverage-badge ${colorClass}`} title={titleParts.join('\n')}>
      Grounding: {covered}/{stats.totalClaims} ({pct}%){swPct !== null && swPct !== pct ? ` · str: ${swPct}%` : ''}
    </span>
  );
}

export function TaxonomyPill({ taxRef, onSelect, selected }: {
  taxRef: TaxonomyRef;
  /** When provided, a click toggles inline selection instead of navigating to the main window (t/1724 pattern). */
  onSelect?: (nodeId: string) => void;
  selected?: boolean;
}) {
  const { colorVar } = nodeIdToTab(taxRef.node_id);
  const label = getNodeLabel(taxRef.node_id);

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onSelect) onSelect(taxRef.node_id);
    else focusMainWindowNode(taxRef.node_id);
  };

  const scoreLabel = taxRef.relevance_score != null
    ? ` (${taxRef.relevance_score.toFixed(2)})`
    : '';
  const primaryMarker = taxRef.primary ? '★ ' : '';

  return (
    <span
      className={`debate-taxonomy-pill debate-taxonomy-pill-clickable${taxRef.primary ? ' debate-taxonomy-pill-primary' : ''}${selected ? ' debate-taxonomy-pill-selected' : ''}`}
      // eslint-disable-next-line local/no-inline-style -- dynamic POV color from nodeIdToTab
      style={{ borderColor: colorVar, color: colorVar }}
      title={`${primaryMarker}${label}${scoreLabel}\n${taxRef.relevance}`}
      aria-pressed={onSelect ? selected === true : undefined}
      onClick={handleClick}
    >
      {primaryMarker}{taxRef.node_id}{scoreLabel}
    </span>
  );
}


function CaveatsBox({ caveats }: { caveats: string[] }) {
  const qualityCaveats = caveats.filter(c => !c.startsWith('[Ungrounded]'));
  const ungroundedCaveats = caveats.filter(c => c.startsWith('[Ungrounded]'));
  return (
    <div className="taxrefs-caveats-box">
      {qualityCaveats.length > 0 && (
        <>
          <div className="taxrefs-caveat-heading-amber">
            Argument Caveats — limitations a critical reader would challenge:
          </div>
          <ul className="taxrefs-caveat-list">
            {qualityCaveats.map((c, i) => (
              <li key={i} className="taxrefs-caveat-li">{humanizeSpeakerIds(c)}</li>
            ))}
          </ul>
        </>
      )}
      {ungroundedCaveats.length > 0 && (
        <>
          <div className="taxrefs-caveat-heading-indigo">
            Ungrounded Claims — from model knowledge, not the source corpus:
          </div>
          <ul className="taxrefs-caveat-list-last">
            {ungroundedCaveats.map((c, i) => (
              <li key={i} className="taxrefs-caveat-li-indigo">
                {humanizeSpeakerIds(c.replace('[Ungrounded] ', ''))}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function RefsHeader({ entry, explainOpen, onExplain, onToggleCaveats }: {
  entry?: TranscriptEntry;
  explainOpen: boolean;
  onExplain: () => void;
  onToggleCaveats: () => void;
}) {
  return (
    <div className="debate-taxonomy-refs">
      {entry && entry.speaker !== 'system' && entry.type !== 'fact-check' && (
        <button
          className="debate-reasoning-toggle"
          onClick={onExplain}
          aria-expanded={explainOpen}
          title="Explain this exchange in-app"
        >
          Explain
        </button>
      )}
      {entry?.caveats && entry.caveats.length > 0 && (
        <>
          <button
            className="debate-reasoning-toggle taxrefs-caveats-btn"
            onClick={onToggleCaveats}
            title="Unresolved argument limitations identified by the judge"
          >
            Caveats ({entry.caveats.length})
          </button>
          {/* Doc-link icon — gated on has-caveats + placed beside the Caveats control, no longer right-parked (t/2418).
              Uses the unified docPath form (t/2410, now on main). */}
          <TheoryLink
            docPath="docs/citation-diagnostics-design.md"
            label="Help: citation diagnostics design"
            size={14}
            className="taxrefs-refs-help"
          />
        </>
      )}
    </div>
  );
}

function BriefSection({ briefStage }: { briefStage: { work_product: Record<string, unknown> } }) {
  return (
    <details open className="debate-reasoning-section">
      <summary className="debate-reasoning-section-title taxrefs-section-brief" onClick={suppressDetailsToggleForHelp}>
        BRIEF
        <TheoryLink
          docPath="docs/artifact-guide.md"
          label="Help: artifact guide"
          size={14}
          className="taxrefs-section-help"
        />
      </summary>
      <div className="debate-reasoning-section-body">
        {(briefStage.work_product as Record<string, unknown>).situation_assessment
          ? <p className="taxrefs-brief-text">{String((briefStage.work_product as Record<string, unknown>).situation_assessment)}</p>
          : <p className="taxrefs-brief-empty">No situation assessment captured.</p>}
      </div>
    </details>
  );
}

function DirectiveBox({ wp }: { wp: Record<string, unknown> }) {
  const drp = wp.directive_response_plan as string | undefined;
  const dr = wp.directive_response as { directive: string; how_addressed: string } | undefined;
  if (!drp && !dr) return null;
  return (
    <div className="taxrefs-directive-box">
      <span className="taxrefs-directive-badge">MODERATOR DIRECTIVE</span>
      {dr && (
        <>
          <div className="taxrefs-mt-4"><strong>Directive:</strong> {dr.directive}</div>
          <div><strong>How addressed:</strong> {dr.how_addressed}</div>
        </>
      )}
      {drp && !dr && <div className="taxrefs-mt-4">{String(drp)}</div>}
    </div>
  );
}

function StrategicGoalBox({ wp }: { wp: Record<string, unknown> }) {
  if (!wp.strategic_goal) return null;
  return (
    <div className="taxrefs-goal-box">
      {String(wp.strategic_goal)}
    </div>
  );
}

function CoreThesisBox({ wp }: { wp: Record<string, unknown> }) {
  if (!wp.core_thesis) return null;
  return (
    <div className="taxrefs-thesis-box">
      <span className="taxrefs-inline-label">Core Thesis: </span>
      {String(wp.core_thesis)}
    </div>
  );
}

function FramingBox({ wp }: { wp: Record<string, unknown> }) {
  if (!wp.framing_choices) return null;
  return (
    <div className="taxrefs-framing-box">
      <span className="taxrefs-inline-label">Framing: </span>
      {Array.isArray(wp.framing_choices)
        ? (wp.framing_choices as { frame: string; why: string }[]).map((fc, i) => (
          <div key={i} className={i > 0 ? 'taxrefs-mt-4' : 'taxrefs-mt-2'}>
            <strong>{fc.frame}</strong>
            {fc.why && <span className="taxrefs-framing-why"> — {fc.why}</span>}
          </div>
        ))
        : <span>{String(wp.framing_choices)}</span>
      }
    </div>
  );
}

function PlannedMovesBox({ wp }: { wp: Record<string, unknown> }) {
  if (!Array.isArray(wp.planned_moves) || (wp.planned_moves as unknown[]).length === 0) return null;
  return (
    <details open className="taxrefs-details"><summary className="taxrefs-summary">Planned Moves</summary>
      {(wp.planned_moves as { move: string; target?: string; detail: string }[]).map((m, i) => (
        <div key={i} className="taxrefs-move-item">
          <span className="taxrefs-move-badge">{m.move}</span>
          {m.target && <span className="taxrefs-move-target">{'→'} {m.target}</span>}
          {m.detail && <div className="taxrefs-detail-2xs">{m.detail}</div>}
        </div>
      ))}
    </details>
  );
}

function ArgumentStructureBox({ wp, selectedPlanNodeId, setSelectedPlanNodeId }: {
  wp: Record<string, unknown>;
  selectedPlanNodeId: string | null;
  setSelectedPlanNodeId: React.Dispatch<React.SetStateAction<string | null>>;
}) {
  if (!Array.isArray(wp.argument_structure) || (wp.argument_structure as unknown[]).length === 0) return null;
  return (
    <details open className="taxrefs-details"><summary className="taxrefs-summary">Argumentation Structure</summary>
      {(wp.argument_structure as { point: string; evidence: string; taxonomy_anchor: string }[]).map((s, i) => (
        <div key={i} className="taxrefs-arg-item">
          <div className="taxrefs-arg-point">{s.point}</div>
          {s.evidence && <div className="taxrefs-detail-2xs">{s.evidence}</div>}
          {s.taxonomy_anchor && (
            <div className="taxrefs-mt-2">
              <span className="taxrefs-anchor-label">Anchor: </span>
              <button
                onClick={() => setSelectedPlanNodeId(prev => prev === s.taxonomy_anchor ? null : s.taxonomy_anchor)}
                aria-expanded={selectedPlanNodeId === s.taxonomy_anchor}
                title="Show this POV node's details"
                className="taxrefs-anchor-btn"
              >{s.taxonomy_anchor}</button>
            </div>
          )}
        </div>
      ))}
    </details>
  );
}

function ArgumentSketchBox({ wp }: { wp: Record<string, unknown> }) {
  if (!wp.argument_sketch) return null;
  return (
    <details open className="taxrefs-details"><summary className="taxrefs-summary">Argument Sketch</summary>
      <div className="taxrefs-sketch-box">
        {String(wp.argument_sketch)}
      </div>
    </details>
  );
}

// t/3418: anticipated_challenges/anticipated_responses migrated object → tagged-string
// (t/3404, PR #2093), but debates persisted under the old schema still have
// {challenge, type} objects — rendering one directly is React error #31.
function normalizeAnticipatedItem(r: unknown): string {
  if (typeof r === 'string') return r;
  if (r && typeof r === 'object' && 'challenge' in r) {
    const { challenge, type } = r as { challenge: unknown; type?: unknown };
    return `${type ? `${String(type)}: ` : ''}${String(challenge)}`;
  }
  return String(r);
}

function AnticipatedBox({ wp, field, title }: { wp: Record<string, unknown>; field: string; title: string }) {
  const items = wp[field];
  if (!Array.isArray(items) || items.length === 0) return null;
  return (
    <details className="taxrefs-details"><summary className="taxrefs-summary">{title}</summary>
      <ul className="taxrefs-anticipated-list">
        {items.map((r, i) => (
          <li key={i}>{normalizeAnticipatedItem(r)}</li>
        ))}
      </ul>
    </details>
  );
}

function PlanBody({ planStage, selectedPlanNodeId, setSelectedPlanNodeId }: {
  planStage: { stage: string; raw_response: string; work_product: Record<string, unknown> };
  selectedPlanNodeId: string | null;
  setSelectedPlanNodeId: React.Dispatch<React.SetStateAction<string | null>>;
}) {
  const wp = planStage.work_product as Record<string, unknown>;
  if (!wp || Object.keys(wp).length === 0) {
    return <Markdown remarkPlugins={[remarkGfm]}>{fixMarkdownLinks(planStage.raw_response)}</Markdown>;
  }
  return (
    <>
      {/* t/3419: each Box wrapped independently — a render throw in one field
          (e.g. a legacy-shaped work_product value) degrades to an inline
          fallback for that section instead of unmounting the whole PLAN body. */}
      <SectionErrorBoundary section="Directive"><DirectiveBox wp={wp} /></SectionErrorBoundary>
      <SectionErrorBoundary section="Strategic Goal"><StrategicGoalBox wp={wp} /></SectionErrorBoundary>
      <SectionErrorBoundary section="Core Thesis"><CoreThesisBox wp={wp} /></SectionErrorBoundary>
      <SectionErrorBoundary section="Framing"><FramingBox wp={wp} /></SectionErrorBoundary>
      <SectionErrorBoundary section="Planned Moves"><PlannedMovesBox wp={wp} /></SectionErrorBoundary>
      <SectionErrorBoundary section="Argument Structure">
        <ArgumentStructureBox wp={wp} selectedPlanNodeId={selectedPlanNodeId} setSelectedPlanNodeId={setSelectedPlanNodeId} />
      </SectionErrorBoundary>
      <SectionErrorBoundary section="Argument Sketch"><ArgumentSketchBox wp={wp} /></SectionErrorBoundary>
      <SectionErrorBoundary section="Anticipated Responses">
        <AnticipatedBox wp={wp} field="anticipated_responses" title="Anticipated Responses" />
      </SectionErrorBoundary>
      <SectionErrorBoundary section="Anticipated Challenges">
        <AnticipatedBox wp={wp} field="anticipated_challenges" title="Anticipated Challenges" />
      </SectionErrorBoundary>
      {/* Inline POV detail for the clicked argument-structure anchor (t/1724). */}
      {selectedPlanNodeId && <TaxNodeDetail nodeId={selectedPlanNodeId} onClose={() => setSelectedPlanNodeId(null)} />}
    </>
  );
}

function PlanSection({ planStage, selectedPlanNodeId, setSelectedPlanNodeId }: {
  planStage: { stage: string; raw_response: string; work_product: Record<string, unknown> };
  selectedPlanNodeId: string | null;
  setSelectedPlanNodeId: React.Dispatch<React.SetStateAction<string | null>>;
}) {
  return (
    <details open className="debate-reasoning-section">
      <summary className="debate-reasoning-section-title taxrefs-section-plan" onClick={suppressDetailsToggleForHelp}>
        PLAN
        <TheoryLink
          docPath="docs/artifact-guide.md"
          label="Help: artifact guide"
          size={14}
          className="taxrefs-section-help"
        />
      </summary>
      <div className="debate-reasoning-section-body">
        <PlanBody planStage={planStage} selectedPlanNodeId={selectedPlanNodeId} setSelectedPlanNodeId={setSelectedPlanNodeId} />
      </div>
    </details>
  );
}

function bdiWeight(tw: ReturnType<typeof getNodeWeight>): { label: string | null; value: number | undefined } {
  if (tw?.category === 'Beliefs') return { label: 'Confidence', value: tw.confidence };
  if (tw?.category === 'Desires') return { label: 'Priority', value: tw.priority };
  if (tw?.category === 'Intentions') return { label: 'Operationality', value: tw.operationality };
  return { label: null, value: undefined };
}

function BdiRefItem({ taxRef, selectedBdiNodeId, toggleBdiNode }: {
  taxRef: TaxonomyRef;
  selectedBdiNodeId: string | null;
  toggleBdiNode: (nodeId: string) => void;
}) {
  const label = getNodeLabel(taxRef.node_id);
  const { colorVar } = nodeIdToTab(taxRef.node_id);
  const { label: weightLabel, value: weightValue } = bdiWeight(getNodeWeight(taxRef.node_id));
  return (
    <div className="debate-reasoning-item">
      <button
        className="debate-reasoning-node"
        // eslint-disable-next-line local/no-inline-style -- dynamic POV color from nodeIdToTab
        style={{ color: colorVar }}
        aria-expanded={selectedBdiNodeId === taxRef.node_id}
        onClick={() => toggleBdiNode(taxRef.node_id)}
      >
        {taxRef.node_id}
      </button>
      <span className="debate-reasoning-label">{label}</span>
      <span className="debate-reasoning-weight taxrefs-anchor-label">
        ({taxRef.relevance_score != null && <>Relevance {taxRef.relevance_score.toFixed(2)}</>}
        {taxRef.relevance_score != null && weightLabel && weightValue != null && ' ; '}
        {weightLabel && weightValue != null && <>{weightLabel} {weightLabel === 'Confidence' ? weightValue.toFixed(2) : `${weightValue}/5`}</>})
      </span>
      <span className="debate-reasoning-text">{taxRef.relevance}</span>
    </div>
  );
}

/**
 * The BDI grounding content: chips, per-node entries, and the inline POV detail when a ref is
 * clicked. No outer disclosure — callers that need one (BdiSection, below) wrap it; the Why tab
 * (t/4625) renders it directly since the tab selection is itself the disclosure. Shared, not
 * copied, between How→Plan's collapsible BDI section and the standalone Why view.
 */
function BdiSectionBody({ refs, polRefs, selectedBdiNodeId, setSelectedBdiNodeId, toggleBdiNode }: {
  refs: TaxonomyRef[];
  polRefs: PolicyRefEntry[];
  selectedBdiNodeId: string | null;
  setSelectedBdiNodeId: React.Dispatch<React.SetStateAction<string | null>>;
  toggleBdiNode: (nodeId: string) => void;
}) {
  const sortedRefs = [...refs].sort((a, b) => (b.relevance_score ?? 0) - (a.relevance_score ?? 0));
  return (
    <div className="debate-reasoning-section-body">
      <div className="debate-taxonomy-refs taxrefs-refs-mb">
        {sortedRefs.map((taxRef) => (
          <TaxonomyPill
            key={taxRef.node_id}
            taxRef={taxRef}
            onSelect={toggleBdiNode}
            selected={selectedBdiNodeId === taxRef.node_id}
          />
        ))}
        {polRefs.map((polRef, i) => {
          const { id } = resolvePolRef(polRef);
          return (
            <span
              key={`${id}-${i}`}
              className={`debate-taxonomy-pill debate-taxonomy-pill-clickable taxrefs-pol-pill${selectedBdiNodeId === id ? ' debate-taxonomy-pill-selected' : ''}`}
              title={getPolicyAction(id)}
              aria-pressed={selectedBdiNodeId === id}
              onClick={(e) => { e.stopPropagation(); toggleBdiNode(id); }}
            >
              {id}
            </span>
          );
        })}
      </div>
      {sortedRefs.map((taxRef) => (
        <BdiRefItem key={taxRef.node_id} taxRef={taxRef} selectedBdiNodeId={selectedBdiNodeId} toggleBdiNode={toggleBdiNode} />
      ))}
      {polRefs.map((polRef, i) => {
        const { id, relevance } = resolvePolRef(polRef);
        return (
          <div key={`${id}-${i}`} className="debate-reasoning-item">
            <button
              className="debate-reasoning-node taxrefs-node-sit"
              aria-expanded={selectedBdiNodeId === id}
              onClick={() => toggleBdiNode(id)}
            >
              {id}
            </button>
            <span className="debate-reasoning-label">{getPolicyAction(id)}</span>
            <span className="debate-reasoning-text">{relevance ?? "Policy action referenced by this debater's argument"}</span>
          </div>
        );
      })}
      {/* Inline POV detail for the clicked BDI ref (chip or node id). */}
      {selectedBdiNodeId && <TaxNodeDetail nodeId={selectedBdiNodeId} onClose={() => setSelectedBdiNodeId(null)} />}
    </div>
  );
}

function BdiSection({ refs, polRefs, selectedBdiNodeId, setSelectedBdiNodeId, toggleBdiNode }: {
  refs: TaxonomyRef[];
  polRefs: PolicyRefEntry[];
  selectedBdiNodeId: string | null;
  setSelectedBdiNodeId: React.Dispatch<React.SetStateAction<string | null>>;
  toggleBdiNode: (nodeId: string) => void;
}) {
  return (
    <details className="debate-reasoning-section">
      <summary className="debate-reasoning-section-title taxrefs-section-bdi">BDI</summary>
      <BdiSectionBody refs={refs} polRefs={polRefs} selectedBdiNodeId={selectedBdiNodeId} setSelectedBdiNodeId={setSelectedBdiNodeId} toggleBdiNode={toggleBdiNode} />
    </details>
  );
}

/**
 * t/4625: the standalone "Why" tab — a statement's BDI grounding on its own, reusing
 * BdiSectionBody (same chips/per-node/inline-detail UI as How→Plan's BDI section). AC5: a
 * statement with no BDI refs (e.g. the System entry) shows a short empty-state line, not an
 * empty pane.
 */
export function BdiGroundingView({ refs, policyRefs, metaPolicyRefs }: {
  refs: TaxonomyRef[];
  policyRefs?: PolicyRefEntry[];
  metaPolicyRefs?: PolicyRefEntry[];
}) {
  const [selectedBdiNodeId, setSelectedBdiNodeId] = useState<string | null>(null);
  const toggleBdiNode = (nodeId: string) => setSelectedBdiNodeId(prev => prev === nodeId ? null : nodeId);
  const polRefs = metaPolicyRefs || policyRefs || [];
  if (refs.length === 0 && polRefs.length === 0) {
    return <p className="taxrefs-why-empty">No BDI grounding for this statement.</p>;
  }
  return <BdiSectionBody refs={refs} polRefs={polRefs} selectedBdiNodeId={selectedBdiNodeId} setSelectedBdiNodeId={setSelectedBdiNodeId} toggleBdiNode={toggleBdiNode} />;
}

function ReasoningList({ briefStage, planStage, refs, polRefs, selectedPlanNodeId, setSelectedPlanNodeId, selectedBdiNodeId, setSelectedBdiNodeId, toggleBdiNode }: {
  briefStage?: { stage: string; raw_response: string; work_product: Record<string, unknown> };
  planStage?: { stage: string; raw_response: string; work_product: Record<string, unknown> };
  refs: TaxonomyRef[];
  polRefs: PolicyRefEntry[];
  selectedPlanNodeId: string | null;
  setSelectedPlanNodeId: React.Dispatch<React.SetStateAction<string | null>>;
  selectedBdiNodeId: string | null;
  setSelectedBdiNodeId: React.Dispatch<React.SetStateAction<string | null>>;
  toggleBdiNode: (nodeId: string) => void;
}) {
  return (
    <div className="debate-reasoning-list">
      {briefStage && <BriefSection briefStage={briefStage} />}
      {planStage && <PlanSection planStage={planStage} selectedPlanNodeId={selectedPlanNodeId} setSelectedPlanNodeId={setSelectedPlanNodeId} />}
      {(refs.length > 0 || polRefs.length > 0) && (
        <BdiSection refs={refs} polRefs={polRefs} selectedBdiNodeId={selectedBdiNodeId} setSelectedBdiNodeId={setSelectedBdiNodeId} toggleBdiNode={toggleBdiNode} />
      )}
    </div>
  );
}

/**
 * t/4514: the inline Explain panel's open/close state, shared by the card's "Explain" button
 * (whole-exchange scope) and the right-click "Explain…" on a selection within this entry (scoped
 * to that selection via the explainRequestBus). Extracted from TaxonomyRefsSection to keep that
 * component's complexity under the file's budget.
 */
function useExplainPanel(entry: TranscriptEntry | undefined) {
  // `explainKey` bumps on every (re)open so the panel remounts and fetches fresh — including when
  // a selection-scoped request arrives while the whole-exchange explanation is already open, or
  // vice versa.
  const [explainScope, setExplainScope] = useState<{ prompt: string; label: string } | null>(null);
  const [explainKey, setExplainKey] = useState(0);

  const openExplain = (scope: { prompt: string; label: string }) => {
    setExplainScope(scope);
    setExplainKey(k => k + 1);
  };
  const closeExplain = () => setExplainScope(null);

  const handleExplainClick = () => {
    if (!entry) return;
    if (explainScope) { closeExplain(); return; } // toggle: already open → collapse
    openExplain({ prompt: buildExplainPrompt(entry), label: 'this exchange' });
  };

  // The right-click "Explain…" on a selection within this entry opens the SAME inline panel,
  // scoped to the selection rather than the whole exchange (t/4514 scoping rule).
  useEffect(() => {
    if (!entry) return;
    return registerExplainTarget(entry.id, ({ text }) => {
      openExplain({ prompt: buildSelectionExplainPrompt(text), label: 'this selection' });
    });
  }, [entry]);

  return { explainScope, explainKey, handleExplainClick, closeExplain };
}

/** Isolates the explainScope && <ExplainPanel> branch in its own function, out of
 *  TaxonomyRefsSection's complexity count (local/complexity-budget). */
function ExplainPanelSlot({ explainScope, explainKey, onClose }: {
  explainScope: { prompt: string; label: string } | null;
  explainKey: number;
  onClose: () => void;
}) {
  if (!explainScope) return null;
  return <ExplainPanel key={explainKey} prompt={explainScope.prompt} scopeLabel={explainScope.label} onClose={onClose} />;
}

export function TaxonomyRefsSection({ refs, policyRefs, metaPolicyRefs, entry, stageDiagnostics, forceExpanded }: {
  refs: TaxonomyRef[];
  policyRefs?: PolicyRefEntry[];
  metaPolicyRefs?: PolicyRefEntry[];
  entry?: TranscriptEntry;
  stageDiagnostics?: { stage: string; raw_response: string; work_product: Record<string, unknown> }[];
  forceExpanded?: boolean;
}) {
  const [caveatsExpanded, setCaveatsExpanded] = useState(false);
  const { explainScope, explainKey, handleExplainClick, closeExplain } = useExplainPanel(entry);
  // Selected PLAN-view taxonomy anchor → shows its POV details inline (t/1724).
  const [selectedPlanNodeId, setSelectedPlanNodeId] = useState<string | null>(null);
  // Selected BDI ref → shows its POV details inline below the list, in place of
  // navigating away to the main window (same t/1724 inline-detail pattern).
  const [selectedBdiNodeId, setSelectedBdiNodeId] = useState<string | null>(null);
  const toggleBdiNode = (nodeId: string) => setSelectedBdiNodeId(prev => prev === nodeId ? null : nodeId);
  const polRefs = metaPolicyRefs || policyRefs || [];

  const briefStage = stageDiagnostics?.find(s => s.stage === 'brief');
  const planStage = stageDiagnostics?.find(s => s.stage === 'plan');
  const hasDiagSections = !!(briefStage || planStage);
  const hasReasoning = refs.length > 0 || polRefs.length > 0 || hasDiagSections;

  if (!hasReasoning && !entry) return null;

  return (
    <div className="debate-taxonomy-refs-section">
      <RefsHeader
        entry={entry}
        explainOpen={!!explainScope}
        onExplain={handleExplainClick}
        onToggleCaveats={() => setCaveatsExpanded(e => !e)}
      />
      <ExplainPanelSlot explainScope={explainScope} explainKey={explainKey} onClose={closeExplain} />
      {caveatsExpanded && entry?.caveats && entry.caveats.length > 0 && <CaveatsBox caveats={entry.caveats} />}
      {forceExpanded && (
        <ReasoningList
          briefStage={briefStage}
          planStage={planStage}
          refs={refs}
          polRefs={polRefs}
          selectedPlanNodeId={selectedPlanNodeId}
          setSelectedPlanNodeId={setSelectedPlanNodeId}
          selectedBdiNodeId={selectedBdiNodeId}
          setSelectedBdiNodeId={setSelectedBdiNodeId}
          toggleBdiNode={toggleBdiNode}
        />
      )}
    </div>
  );
}
