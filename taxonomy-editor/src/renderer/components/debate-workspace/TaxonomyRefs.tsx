// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useEffect, useMemo, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { TaxonomyRef, TranscriptEntry } from '../../types/debate';
import type { CoverageMap, StrengthWeightedCoverage } from '@lib/debate/coverageTracker';
import { humanizeSpeakerIds } from '../../utils/humanizeSpeakers';
import {
  nodeIdToTab, getNodeLabel, focusMainWindowNode,
  buildExplainPrompt, buildSelectionExplainPrompt, fixMarkdownLinks, resolvePolRef, getPolicyAction,
} from './utils';
import type { PolicyRefEntry } from './utils';
import { TaxNodeDetail } from '../shared/TaxNodeDetail';
import { TheoryLink } from '../shared/TheoryLink';
import { SectionErrorBoundary } from './SectionErrorBoundary';
import { ExplainPanel } from './ExplainPanel';
import { registerExplainTarget } from './explainRequestBus';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
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

// t/331: Parse claim-map data from work_product
interface ParsedClaim {
  index: number;
  point: string;
  evidence?: string;
  taxonomy_anchor?: string;
  attack?: ParsedAttack; // attack targeting this claim
}

interface ParsedAttack {
  text: string;
  targetAnchor?: string; // which claim's anchor this targets
  claimIndex?: number; // which claim (1-based)
  steelmanText?: string; // steelman annotation text, if any
  steelmanAnnotationId?: string;
  verificationStatus?: string;
  annotationId?: string;
}

interface ParsedAssumption {
  text: string;
}

function parseWorkProduct(wp: Record<string, unknown>, camp: string) {
  const claims: ParsedClaim[] = [];
  if (Array.isArray(wp.argument_structure)) {
    (wp.argument_structure as { point: string; evidence?: string; taxonomy_anchor?: string }[]).forEach((s, i) => {
      claims.push({
        index: i + 1,
        point: s.point,
        evidence: s.evidence,
        taxonomy_anchor: s.taxonomy_anchor,
      });
    });
  }

  const unmappedAttacks: ParsedAttack[] = [];
  const assumptions: ParsedAssumption[] = [];
  let verifiedCount = 0;

  if (Array.isArray(wp.anticipated_challenges)) {
    (wp.anticipated_challenges as unknown[]).forEach((item, idx) => {
      const text = normalizeAnticipatedItem(item);
      if (text.startsWith('ATTACK:')) {
        const attackText = text.replace(/^ATTACK:\s*/, '').replace(/\s*targeting node \S+$/, '');
        // Try to map attack to a claim by finding anchors in the text
        let mapped = false;
        for (const claim of claims) {
          if (claim.taxonomy_anchor && attackText.includes(claim.taxonomy_anchor)) {
            claim.attack = {
              text: attackText,
              targetAnchor: claim.taxonomy_anchor,
              claimIndex: claim.index,
              annotationId: `AN-${idx}`,
            };
            mapped = true;
            verifiedCount++;
            break;
          }
        }
        if (!mapped) {
          unmappedAttacks.push({
            text: attackText,
            annotationId: `AN-${idx}`,
          });
        }
      } else if (text.startsWith('ASSUMPTION:')) {
        assumptions.push({ text: text.replace(/^ASSUMPTION:\s*/, '') });
      } else {
        // Untagged challenge as assumption
        assumptions.push({ text });
      }
    });
  }

  return {
    claims,
    unmappedAttacks,
    assumptions,
    verifiedAttacks: verifiedCount,
  };
}

function stripLeadingVerb(text: string): string {
  const match = text.match(/^(Establish that |Argue that )/i);
  return match ? text.slice(match[0].length) : text;
}

interface ClaimMapLayoutProps {
  wp: Record<string, unknown>;
  stage?: string;
  camp?: string;
  motion?: string;
  selectedPlanNodeId: string | null;
  setSelectedPlanNodeId: React.Dispatch<React.SetStateAction<string | null>>;
}

function ClaimMapLayout({ wp, stage = '', camp = '', motion, selectedPlanNodeId, setSelectedPlanNodeId }: ClaimMapLayoutProps) {
  const { claims, unmappedAttacks, assumptions, verifiedAttacks } = useMemo(
    () => parseWorkProduct(wp, camp),
    [wp, camp]
  );

  const coreThesis = wp.core_thesis ? String(wp.core_thesis) : '';
  const strategicGoal = wp.strategic_goal ? String(wp.strategic_goal) : '';
  const framingChoices = wp.framing_choices;
  const stageStr = String(stage || '');
  const [moreExpanded, setMoreExpanded] = useState(false);

  // Count total attacks (mapped + unmapped)
  const totalAttacks = claims.filter(c => c.attack).length + unmappedAttacks.length;

  // Fallback for legacy entries: if no core_thesis, show old stacked view
  if (!coreThesis && !strategicGoal) {
    return (
      <>
        <SectionErrorBoundary section="Strategic Goal"><StrategicGoalBox wp={wp} /></SectionErrorBoundary>
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
        {selectedPlanNodeId && <TaxNodeDetail nodeId={selectedPlanNodeId} onClose={() => setSelectedPlanNodeId(null)} />}
      </>
    );
  }

  return (
    <div className="claim-map-layout">
      {/* Header card */}
      <header className="claim-map-header">
        <div className="claim-map-header-top">
          <div className="claim-map-eyebrow">{(camp || 'PLAN').toUpperCase()} · {stageStr}</div>
          <div className="claim-map-counts">
            {claims.length} claim{claims.length === 1 ? '' : 's'} · {totalAttacks} attack{totalAttacks === 1 ? '' : 's'} · {assumptions.length} assumption{assumptions.length === 1 ? '' : 's'} · {verifiedAttacks} verified
          </div>
        </div>
        {coreThesis && <h2 className="claim-map-headline">{coreThesis}</h2>}
        {strategicGoal && (
          <div className="claim-map-ask">
            <strong>The ask:</strong> {stripLeadingVerb(strategicGoal)}
          </div>
        )}
        {motion && <div className="claim-map-motion">Motion — {motion}</div>}
      </header>

      {/* Lens cards */}
      {framingChoices && (
        <div className="claim-map-lenses">
          {Array.isArray(framingChoices)
            ? (framingChoices as { frame: string; why: string }[]).map((fc, i) => (
              <div key={i} className="claim-map-lens-card">
                <div className="claim-map-lens-eyebrow">LENS {i + 1}</div>
                <h3 className="claim-map-lens-title">{String(fc.frame)}</h3>
                <p className="claim-map-lens-why">{String(fc.why)}</p>
              </div>
            ))
            : (
              <div className="claim-map-lens-card">
                <div className="claim-map-lens-eyebrow">LENS 1</div>
                <h3 className="claim-map-lens-title">{String(framingChoices)}</h3>
              </div>
            )
          }
        </div>
      )}

      {/* Argument grid */}
      {claims.length > 0 && (
        <div className="claim-map-section">
          <div className="claim-map-arg-header">
            <h3>Argument</h3>
            <div className="claim-map-legend">
              <span className="claim-map-legend-item">
                <span className="claim-map-dot claim-map-dot-info">●</span> Our claim
              </span>
              <span className="claim-map-legend-item">
                <span className="claim-map-dot claim-map-dot-warning">●</span> Anticipated attack
              </span>
            </div>
          </div>
          <ol className="claim-map-grid" aria-label="Argument: claims and anticipated attacks">
            {claims.map((claim) => (
              <li key={claim.index} className="claim-map-row">
                <div className="claim-map-claim-col">
                  <div className="claim-map-claim-card">
                    <div className="claim-map-claim-badge">C{claim.index}</div>
                    <p className="claim-map-claim-point">{claim.point}</p>
                    {claim.evidence && <div className="claim-map-claim-evidence"><strong>Evidence</strong> · {claim.evidence}</div>}
                    {claim.taxonomy_anchor && (
                      <button
                        className="claim-map-anchor-chip"
                        onClick={() => setSelectedPlanNodeId((prev: string | null) => prev === claim.taxonomy_anchor ? null : (claim.taxonomy_anchor ?? null))}
                        aria-expanded={selectedPlanNodeId === claim.taxonomy_anchor}
                      >
                        {claim.taxonomy_anchor}
                      </button>
                    )}
                  </div>
                </div>
                <div className="claim-map-attack-col" aria-label={claim.attack ? `Attack on C${claim.index}` : `No attack mapped to C${claim.index}`}>
                  {claim.attack ? (
                    <div className="claim-map-attack-card">
                      <div className="claim-map-attack-eyebrow">← ATTACK ON C{claim.attack.claimIndex}</div>
                      <p className="claim-map-attack-text">{claim.attack.text}</p>
                      <div className="claim-map-attack-footer">
                        <span className="claim-map-attack-status">Unverified</span>
                        {claim.attack.annotationId && <span className="claim-map-attack-id">{claim.attack.annotationId}</span>}
                      </div>
                    </div>
                  ) : (
                    <div className="claim-map-no-attack">
                      <p className="claim-map-no-attack-title">No attack mapped to C{claim.index}</p>
                      <p className="claim-map-no-attack-text">No anticipated attack targets this claim.</p>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>
          
          {/* Unmapped attacks row */}
          {unmappedAttacks.length > 0 && (
            <div className="claim-map-unmapped-attacks">
              {unmappedAttacks.map((attack, i) => (
                <div key={i} className="claim-map-unmapped-row">
                  <div className="claim-map-unmapped-label">Unmapped attack</div>
                  <div className="claim-map-attack-card">
                    <p className="claim-map-attack-text">{attack.text}</p>
                    <div className="claim-map-attack-footer">
                      <span className="claim-map-attack-status">Unverified</span>
                      {attack.annotationId && <span className="claim-map-attack-id">{attack.annotationId}</span>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Assumption cards */}
      {assumptions.length > 0 && (
        <div className="claim-map-assumptions">
          {assumptions.map((assumption, i) => (
            <div key={i} className="claim-map-assumption-card">
              <div className="claim-map-assumption-eyebrow">LOAD-BEARING ASSUMPTION · UNDERPINS THE ASK</div>
              <p className="claim-map-assumption-text">{assumption.text}</p>
            </div>
          ))}
        </div>
      )}

      {/* More from plan collapsible */}
      <details className="claim-map-more">
        <summary className="claim-map-more-summary">
          <span className="claim-map-more-toggle">{moreExpanded ? '▾' : '▸'}</span> More from the plan
        </summary>
        <div className="claim-map-more-content" onClick={() => setMoreExpanded(true)}>
          <SectionErrorBoundary section="Planned Moves"><PlannedMovesBox wp={wp} /></SectionErrorBoundary>
          <SectionErrorBoundary section="Argument Sketch"><ArgumentSketchBox wp={wp} /></SectionErrorBoundary>
          <SectionErrorBoundary section="Anticipated Responses">
            <AnticipatedBox wp={wp} field="anticipated_responses" title="Anticipated Responses" />
          </SectionErrorBoundary>
        </div>
      </details>

      {/* Inline POV detail */}
      {selectedPlanNodeId && <TaxNodeDetail nodeId={selectedPlanNodeId} onClose={() => setSelectedPlanNodeId(null)} />}
    </div>
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
  
  // t/331: Try claim-map layout; fallback to legacy on error
  return (
    <SectionErrorBoundary section="Claim Map Layout">
      <ClaimMapLayout
        wp={wp}
        stage={planStage.stage}
        camp="Plan"
        motion={undefined}
        selectedPlanNodeId={selectedPlanNodeId}
        setSelectedPlanNodeId={setSelectedPlanNodeId}
      />
    </SectionErrorBoundary>
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

function BdiRefItem({ taxRef, selectedBdiNodeId, toggleBdiNode }: {
  taxRef: TaxonomyRef;
  selectedBdiNodeId: string | null;
  toggleBdiNode: (nodeId: string) => void;
}) {
  const label = getNodeLabel(taxRef.node_id);
  const { colorVar } = nodeIdToTab(taxRef.node_id);
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
      <span className="debate-reasoning-text">{taxRef.relevance}</span>
    </div>
  );
}

/** t/187: BDI groups in Taxonomy-tree order. Situation nodes (`sit-NNN`) carry no BDI
 *  category; they get their own group after Beliefs rather than being dropped. */
const BDI_GROUPS = [
  { key: 'desires', label: 'Desires' },
  { key: 'intentions', label: 'Intentions' },
  { key: 'beliefs', label: 'Beliefs' },
  { key: 'situations', label: 'Situations' },
] as const;

/** Category from a `{pov}-{category}-NNN` node id, or `situations` for `sit-NNN` and legacy `cc-NNN`. An id matching
 *  neither is shown under Situations so it stays visible, with a WARN (Design, p/14#20). */
function bdiGroupKey(nodeId: string): string {
  const [prefix, cat] = nodeId.split('-');
  if (cat === 'desires' || cat === 'intentions' || cat === 'beliefs') return cat;
  if (prefix === 'sit' || prefix === 'cc') return 'situations';
  getGlobalRecorder()?.record({
    type: 'system.error',
    component: 'debate-workspace',
    level: 'warn',
    message: `BDI grounding: node id "${nodeId}" has no BDI category and isn't a situation; showing it under Situations`,
  });
  return 'situations';
}

/** Non-empty BDI groups in BDI_GROUPS order, each sorted by relevance (desc). */
function groupRefsByBdi(refs: TaxonomyRef[]): { key: string; label: string; refs: TaxonomyRef[] }[] {
  const sorted = [...refs].sort((a, b) => (b.relevance_score ?? 0) - (a.relevance_score ?? 0));
  const keyed = sorted.map(r => ({ ref: r, key: bdiGroupKey(r.node_id) }));
  return BDI_GROUPS
    .map(g => ({ key: g.key, label: g.label, refs: keyed.filter(k => k.key === g.key).map(k => k.ref) }))
    .filter(g => g.refs.length > 0);
}

function BdiGroup({ label, refs, selectedBdiNodeId, toggleBdiNode }: {
  label: string;
  refs: TaxonomyRef[];
  selectedBdiNodeId: string | null;
  toggleBdiNode: (nodeId: string) => void;
}) {
  return (
    <div className="taxrefs-bdi-group" role="group" aria-label={`${label}, ${refs.length} node${refs.length === 1 ? '' : 's'}`}>
      <div className="taxrefs-bdi-group-label">{label} ({refs.length})</div>
      <div className="debate-taxonomy-refs taxrefs-refs-mb">
        {refs.map((taxRef) => (
          <TaxonomyPill key={taxRef.node_id} taxRef={taxRef} onSelect={toggleBdiNode} selected={selectedBdiNodeId === taxRef.node_id} />
        ))}
      </div>
      {refs.map((taxRef) => (
        <BdiRefItem key={taxRef.node_id} taxRef={taxRef} selectedBdiNodeId={selectedBdiNodeId} toggleBdiNode={toggleBdiNode} />
      ))}
    </div>
  );
}

function PolicyRefsBlock({ polRefs, selectedBdiNodeId, toggleBdiNode }: {
  polRefs: PolicyRefEntry[];
  selectedBdiNodeId: string | null;
  toggleBdiNode: (nodeId: string) => void;
}) {
  return (
    <div className="taxrefs-policy-refs" role="group" aria-label={`Policy actions, ${polRefs.length} ${polRefs.length === 1 ? 'action' : 'actions'}`}>
      <div className="taxrefs-bdi-group-label">Policy actions ({polRefs.length})</div>
      <div className="debate-taxonomy-refs taxrefs-refs-mb">
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
    </div>
  );
}

/**
 * The BDI grounding content: chips, per-node entries, and the inline POV detail when a ref is
 * clicked. t/187: grouped Desires → Intentions → Beliefs (→ Situations), policy refs last. No outer disclosure — the Why tab (t/4625) renders it directly since the tab
 * selection is itself the disclosure (t/4625 follow-up: this used to also back a collapsible
 * BDI section inside How→Plan, removed as redundant with the always-visible Why tab).
 */
function BdiSectionBody({ refs, polRefs, selectedBdiNodeId, setSelectedBdiNodeId, toggleBdiNode }: {
  refs: TaxonomyRef[];
  polRefs: PolicyRefEntry[];
  selectedBdiNodeId: string | null;
  setSelectedBdiNodeId: React.Dispatch<React.SetStateAction<string | null>>;
  toggleBdiNode: (nodeId: string) => void;
}) {
  const groups = useMemo(() => groupRefsByBdi(refs), [refs]);
  return (
    <div className="debate-reasoning-section-body">
      {groups.map(g => (
        <BdiGroup key={g.key} label={g.label} refs={g.refs} selectedBdiNodeId={selectedBdiNodeId} toggleBdiNode={toggleBdiNode} />
      ))}
      {polRefs.length > 0 && <PolicyRefsBlock polRefs={polRefs} selectedBdiNodeId={selectedBdiNodeId} toggleBdiNode={toggleBdiNode} />}
      {/* Inline POV detail for the clicked BDI ref (chip or node id). */}
      {selectedBdiNodeId && <TaxNodeDetail nodeId={selectedBdiNodeId} onClose={() => setSelectedBdiNodeId(null)} />}
    </div>
  );
}

/**
 * t/4625: the standalone "Why" tab — a statement's BDI grounding on its own, via
 * BdiSectionBody. AC5: a statement with no BDI refs (e.g. the System entry) shows a short
 * empty-state line, not an empty pane. (How→Plan used to also show this in a collapsible BDI
 * section; removed as redundant with this always-visible view, t/4625#10.)
 */
export function BdiGroundingView({ refs, policyRefs, metaPolicyRefs, emptyText = 'No BDI grounding for this statement.' }: {
  refs: TaxonomyRef[];
  policyRefs?: PolicyRefEntry[];
  metaPolicyRefs?: PolicyRefEntry[];
  /** t/187: empty-state line; Chat passes its own wording (t/167#3). */
  emptyText?: string;
}) {
  const [selectedBdiNodeId, setSelectedBdiNodeId] = useState<string | null>(null);
  const toggleBdiNode = (nodeId: string) => setSelectedBdiNodeId(prev => prev === nodeId ? null : nodeId);
  const polRefs = metaPolicyRefs || policyRefs || [];
  if (refs.length === 0 && polRefs.length === 0) {
    return <p className="taxrefs-why-empty">{emptyText}</p>;
  }
  return <BdiSectionBody refs={refs} polRefs={polRefs} selectedBdiNodeId={selectedBdiNodeId} setSelectedBdiNodeId={setSelectedBdiNodeId} toggleBdiNode={toggleBdiNode} />;
}

function ReasoningList({ briefStage, planStage, selectedPlanNodeId, setSelectedPlanNodeId }: {
  briefStage?: { stage: string; raw_response: string; work_product: Record<string, unknown> };
  planStage?: { stage: string; raw_response: string; work_product: Record<string, unknown> };
  selectedPlanNodeId: string | null;
  setSelectedPlanNodeId: React.Dispatch<React.SetStateAction<string | null>>;
}) {
  return (
    <div className="debate-reasoning-list">
      {briefStage && <BriefSection briefStage={briefStage} />}
      {planStage && <PlanSection planStage={planStage} selectedPlanNodeId={selectedPlanNodeId} setSelectedPlanNodeId={setSelectedPlanNodeId} />}
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
          selectedPlanNodeId={selectedPlanNodeId}
          setSelectedPlanNodeId={setSelectedPlanNodeId}
        />
      )}
    </div>
  );
}
