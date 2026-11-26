// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { TaxonomyRef, TranscriptEntry } from '../../types/debate';
import type { CoverageMap, StrengthWeightedCoverage } from '@lib/debate/coverageTracker';
import { humanizeSpeakerIds } from '../../utils/humanizeSpeakers';
import {
  nodeIdToTab, getNodeLabel,
  buildExplainPrompt, buildSelectionExplainPrompt, fixMarkdownLinks, resolvePolRef, getPolicyAction,
} from './utils';
import type { PolicyRefEntry } from './utils';
import { TaxNodeDetail } from '../shared/TaxNodeDetail';
import { TheoryLink } from '../shared/TheoryLink';
import { SectionErrorBoundary } from './SectionErrorBoundary';
import { normalizeAnticipatedItem, parseLenses, parseWorkProduct, stripLeadingVerb, type ParsedAssumption, type ParsedAttack, type ParsedClaim, type ParsedLens, type SteelmanContext, type WarnFn } from './claimMap';
import { ExplainPanel } from './ExplainPanel';
import { registerExplainTarget } from './explainRequestBus';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';
import { useDebateStore } from '../../hooks/useDebateStore';
import { useWhyExplanations, type WhyExplanations } from './whyExplanations';
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

interface ClaimMapLayoutProps {
  wp: Record<string, unknown>;
  stage?: string;
  camp?: string; // the speaker's camp, e.g. SKEPTIC
  motion?: string; // the session motion; the line is omitted when absent
  steelmanCtx?: SteelmanContext; // the debate's steelman nodes, for tagged attacks (t/388)
  selectedPlanNodeId: string | null;
  setSelectedPlanNodeId: React.Dispatch<React.SetStateAction<string | null>>;
}

/** t/388: a linked steelman shows its own text and verdict on the attack card. Without one the
 *  attack reads as Unverified and shows its own challenge text. */
function attackText(attack: ParsedAttack): string {
  return attack.steelman ? attack.steelman.text : attack.text;
}

function attackStatus(attack: ParsedAttack): string {
  const verdict = attack.steelman?.verdict;
  if (verdict === 'faithful') return 'Faithful to target';
  if (verdict === 'diverges') return 'Misrepresents target';
  return 'Unverified';
}

/** The verdict pill, plus the steelman's node id once the tag has resolved to a real node (Design p/14#91).
 *  A tag that resolves to nothing shows no id (TL p/11#53). */
function AttackFooter({ attack }: { attack: ParsedAttack }) {
  return (
    <div className="claim-map-attack-footer">
      <span className="claim-map-attack-status">{attackStatus(attack)}</span>
      {attack.steelman && attack.steelmanId && <span className="claim-map-attack-id">{attack.steelmanId}</span>}
    </div>
  );
}

function attackEyebrowSuffix(attack: ParsedAttack): string {
  return attack.steelman ? ` · STEELMAN OF THE ${attack.steelman.camp.toUpperCase()}` : '';
}

// Every item the claim map skips is logged, so the fallback is never silent.
const warnClaimMap: WarnFn = message => getGlobalRecorder()?.record({
  type: 'system.error',
  component: 'debate-workspace',
  level: 'warn',
  message: `Claim map: ${message}`,
});

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function ClaimMapHeader({ eyebrow, counts, coreThesis, strategicGoal, motion }: {
  eyebrow: string;
  counts: string;
  coreThesis: string;
  strategicGoal: string;
  motion?: string;
}) {
  return (
    <header className="claim-map-header">
      <div className="claim-map-header-top">
        <div className="claim-map-eyebrow">{eyebrow}</div>
        <div className="claim-map-counts">{counts}</div>
      </div>
      {coreThesis && <h2 className="claim-map-headline">{coreThesis}</h2>}
      {strategicGoal && (
        <div className="claim-map-ask">
          <strong>The ask:</strong> {stripLeadingVerb(strategicGoal)}
        </div>
      )}
      {motion && <div className="claim-map-motion">Motion — {motion}</div>}
    </header>
  );
}

function ClaimMapLenses({ lenses }: { lenses: ParsedLens[] }) {
  return (
    <ul className="claim-map-lenses">
      {lenses.map((lens, i) => (
        <li key={i} className="claim-map-lens-card">
          <div className="claim-map-lens-eyebrow">LENS {i + 1}</div>
          <h3 className="claim-map-lens-title">{lens.title}</h3>
          {lens.why && <p className="claim-map-lens-why">{lens.why}</p>}
        </li>
      ))}
    </ul>
  );
}

function ClaimMapRow({ claim, selectedPlanNodeId, setSelectedPlanNodeId }: {
  claim: ParsedClaim;
  selectedPlanNodeId: string | null;
  setSelectedPlanNodeId: React.Dispatch<React.SetStateAction<string | null>>;
}) {
  const anchor = claim.taxonomy_anchor;
  return (
    <li className="claim-map-row">
      <div className="claim-map-claim-col">
        <div className="claim-map-claim-card">
          <div className="claim-map-claim-badge">C{claim.index}</div>
          <p className="claim-map-claim-point">{claim.point}</p>
          {claim.evidence && <div className="claim-map-claim-evidence"><strong>Evidence</strong> · {claim.evidence}</div>}
          {anchor && (
            <button
              className="claim-map-anchor-chip"
              onClick={() => setSelectedPlanNodeId(prev => (prev === anchor ? null : anchor))}
              aria-expanded={selectedPlanNodeId === anchor}
            >
              {anchor}
            </button>
          )}
        </div>
      </div>
      <div className="claim-map-attack-col" role="group" aria-label={claim.attack ? `Attack on C${claim.index}` : `No attack mapped to C${claim.index}`}>
        {claim.attack ? (
          <div className="claim-map-attack-card">
            <div className="claim-map-attack-eyebrow">← ATTACK ON C{claim.index}{attackEyebrowSuffix(claim.attack)}</div>
            <p className="claim-map-attack-text">{attackText(claim.attack)}</p>
            <AttackFooter attack={claim.attack} />
          </div>
        ) : (
          <div className="claim-map-no-attack">
            <p className="claim-map-no-attack-title">No attack mapped to C{claim.index}</p>
            <p className="claim-map-no-attack-text">No anticipated attack targets this claim.</p>
          </div>
        )}
      </div>
    </li>
  );
}

function ClaimMapArgument({ claims, unmappedAttacks, selectedPlanNodeId, setSelectedPlanNodeId }: {
  claims: ParsedClaim[];
  unmappedAttacks: ParsedAttack[];
  selectedPlanNodeId: string | null;
  setSelectedPlanNodeId: React.Dispatch<React.SetStateAction<string | null>>;
}) {
  return (
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
        {claims.map(claim => (
          <ClaimMapRow key={claim.index} claim={claim} selectedPlanNodeId={selectedPlanNodeId} setSelectedPlanNodeId={setSelectedPlanNodeId} />
        ))}
      </ol>
      {unmappedAttacks.length > 0 && (
        <div className="claim-map-unmapped-attacks">
          {unmappedAttacks.map((attack, i) => (
            <div key={i} className="claim-map-unmapped-row">
              <div className="claim-map-unmapped-label">Unmapped attack</div>
              <div className="claim-map-attack-card">
                {/* t/388: an unmapped attack names no claim, so its eyebrow is only the steelman label. Without it the steelman's text would read as the attack. */}
                {attack.steelman && <div className="claim-map-attack-eyebrow">STEELMAN OF THE {attack.steelman.camp.toUpperCase()}</div>}
                <p className="claim-map-attack-text">{attackText(attack)}</p>
                <AttackFooter attack={attack} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ClaimMapAssumptions({ assumptions }: { assumptions: ParsedAssumption[] }) {
  return (
    <div className="claim-map-assumptions">
      {assumptions.map((assumption, i) => (
        <div key={i} className="claim-map-assumption-card">
          <div className="claim-map-assumption-eyebrow">
            {assumption.tagged ? 'LOAD-BEARING ASSUMPTION · UNDERPINS THE ASK' : 'ANTICIPATED CHALLENGE'}
          </div>
          <p className="claim-map-assumption-text">{assumption.text}</p>
        </div>
      ))}
    </div>
  );
}

function ClaimMapMore({ wp }: { wp: Record<string, unknown> }) {
  // Hidden when the entry has none of the three sections, so no empty disclosure shows.
  if (!wp.planned_moves && !wp.argument_sketch && !wp.anticipated_responses) return null;
  return (
    <details className="claim-map-more">
      {/* The caret is drawn in CSS from the [open] state. */}
      <summary className="claim-map-more-summary">
        <span className="claim-map-more-toggle" aria-hidden="true" /> More from the plan
      </summary>
      <div className="claim-map-more-content">
        <SectionErrorBoundary section="Planned Moves"><PlannedMovesBox wp={wp} /></SectionErrorBoundary>
        <SectionErrorBoundary section="Argument Sketch"><ArgumentSketchBox wp={wp} /></SectionErrorBoundary>
        <SectionErrorBoundary section="Anticipated Responses">
          <AnticipatedBox wp={wp} field="anticipated_responses" title="Anticipated Responses" />
        </SectionErrorBoundary>
      </div>
    </details>
  );
}

// Legacy entries (no core_thesis or strategic_goal) keep the old stacked view.
function LegacyPlanView({ wp, selectedPlanNodeId, setSelectedPlanNodeId }: {
  wp: Record<string, unknown>;
  selectedPlanNodeId: string | null;
  setSelectedPlanNodeId: React.Dispatch<React.SetStateAction<string | null>>;
}) {
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

// Zero terms are left out. No "verified" term until verification is wired (t/388).
// Zero terms are left out, verified included: only a steelman with a verdict counts (t/388).
function claimMapCounts(claimCount: number, attackCount: number, assumptionCount: number, verifiedCount: number): string {
  return [
    claimCount > 0 && plural(claimCount, 'claim'),
    attackCount > 0 && plural(attackCount, 'attack'),
    assumptionCount > 0 && plural(assumptionCount, 'assumption'),
    verifiedCount > 0 && `${verifiedCount} verified`,
  ].filter(Boolean).join(' · ');
}

function ClaimMapLayout({ wp, stage = '', camp, motion, steelmanCtx, selectedPlanNodeId, setSelectedPlanNodeId }: ClaimMapLayoutProps) {
  const { claims, unmappedAttacks, assumptions, verifiedAttacks } = useMemo(() => parseWorkProduct(wp, warnClaimMap, steelmanCtx), [wp, steelmanCtx]);

  const coreThesis = wp.core_thesis ? String(wp.core_thesis) : '';
  const strategicGoal = wp.strategic_goal ? String(wp.strategic_goal) : '';
  const lenses = useMemo(() => parseLenses(wp.framing_choices, warnClaimMap), [wp]);

  if (!coreThesis && !strategicGoal) {
    return <LegacyPlanView wp={wp} selectedPlanNodeId={selectedPlanNodeId} setSelectedPlanNodeId={setSelectedPlanNodeId} />;
  }

  const totalAttacks = claims.filter(c => c.attack).length + unmappedAttacks.length;
  const counts = claimMapCounts(claims.length, totalAttacks, assumptions.length, verifiedAttacks);

  return (
    <div className="claim-map-layout">
      <SectionErrorBoundary section="Plan Header">
        <ClaimMapHeader
          eyebrow={[camp, stage || 'plan'].filter(Boolean).map(part => String(part).toUpperCase()).join(' · ')}
          counts={counts}
          coreThesis={coreThesis}
          strategicGoal={strategicGoal}
          motion={motion}
        />
      </SectionErrorBoundary>
      {lenses.length > 0 && (
        <SectionErrorBoundary section="Lenses"><ClaimMapLenses lenses={lenses} /></SectionErrorBoundary>
      )}
      {claims.length > 0 && (
        <SectionErrorBoundary section="Argument">
          <ClaimMapArgument
            claims={claims}
            unmappedAttacks={unmappedAttacks}
            selectedPlanNodeId={selectedPlanNodeId}
            setSelectedPlanNodeId={setSelectedPlanNodeId}
          />
        </SectionErrorBoundary>
      )}
      {assumptions.length > 0 && (
        <SectionErrorBoundary section="Assumptions"><ClaimMapAssumptions assumptions={assumptions} /></SectionErrorBoundary>
      )}
      <SectionErrorBoundary section="More from the plan"><ClaimMapMore wp={wp} /></SectionErrorBoundary>
      {selectedPlanNodeId && <TaxNodeDetail nodeId={selectedPlanNodeId} onClose={() => setSelectedPlanNodeId(null)} />}
    </div>
  );
}

/** t/388: the session motion, but only when this entry belongs to the active debate. A chat answer
 *  or an entry from another debate gets no motion line rather than someone else's topic. */
function motionForEntry(debate: { topic?: { final?: string }; transcript?: { id: string }[] } | null | undefined, entryId: string | undefined): string | undefined {
  if (!debate || !entryId || !debate.transcript?.some(t => t.id === entryId)) return undefined;
  return debate.topic?.final || undefined;
}

function PlanBody({ planStage, selectedPlanNodeId, setSelectedPlanNodeId, entry }: {
  entry?: TranscriptEntry;
  planStage: { stage: string; raw_response: string; work_product: Record<string, unknown> };
  selectedPlanNodeId: string | null;
  setSelectedPlanNodeId: React.Dispatch<React.SetStateAction<string | null>>;
}) {
  const motion = useDebateStore(s => motionForEntry(s.activeDebate, entry?.id));
  // t/388: the debate's argument-network nodes, so a tagged attack can resolve its steelman.
  const networkNodes = useDebateStore(s => s.activeDebate?.argument_network?.nodes);
  const steelmanCtx = useMemo<SteelmanContext>(
    () => ({ nodes: networkNodes ?? [], entryId: entry?.id, speaker: entry?.speaker ?? '' }),
    [networkNodes, entry?.id, entry?.speaker],
  );
  const wp = planStage.work_product as Record<string, unknown>;
  if (!wp || Object.keys(wp).length === 0) {
    return <Markdown remarkPlugins={[remarkGfm]}>{fixMarkdownLinks(planStage.raw_response)}</Markdown>;
  }
  
  // t/331: claim-map layout. Entries with no thesis or goal use the legacy view inside it.
  return (
    <>
      <SectionErrorBoundary section="Directive"><DirectiveBox wp={wp} /></SectionErrorBoundary>
      <SectionErrorBoundary section="Claim Map Layout">
        <ClaimMapLayout
          wp={wp}
          // t/388: the stage word comes from the entry type; the entry has no round number to show.
          stage={entry?.type === 'opening' ? 'opening plan' : planStage.stage}
          camp={entry?.speaker}
          motion={motion}
          steelmanCtx={steelmanCtx}
          selectedPlanNodeId={selectedPlanNodeId}
          setSelectedPlanNodeId={setSelectedPlanNodeId}
        />
      </SectionErrorBoundary>
    </>
  );
}

function PlanSection({ planStage, selectedPlanNodeId, setSelectedPlanNodeId, entry }: {
  entry?: TranscriptEntry;
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
        <PlanBody planStage={planStage} selectedPlanNodeId={selectedPlanNodeId} setSelectedPlanNodeId={setSelectedPlanNodeId} entry={entry} />
      </div>
    </details>
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

// ── t/778: the debate's compact Why panel ────────────────────────────────

/** A node's label: its own, else resolved from the taxonomy. A missing node reads "No longer in
 *  the taxonomy" once the taxonomy has loaded; while it loads the row offers a neutral toggle. */
function useCompactLabel(taxRef: TaxonomyRef): { text: string; missing: boolean } {
  const resolved = getNodeLabel(taxRef.node_id);
  const isMissing = !taxRef.label && resolved === taxRef.node_id;
  const taxonomyLoaded = useTaxonomyStore(s => s.accelerationist !== null && s.safetyist !== null && s.skeptic !== null && s.situations !== null);
  if (!isMissing) return { text: taxRef.label || resolved, missing: false };
  return { text: taxonomyLoaded ? 'No longer in the taxonomy' : 'Why this node', missing: taxonomyLoaded };
}

interface CompactRowProps {
  id: string;
  label: string;
  missing?: boolean;
  relevance: string | null | undefined;
  color?: string;
  primary?: boolean;
  sit?: boolean;
  detailOpen: boolean;
  onToggleDetail: () => void;
  expanded: boolean;
  onToggleExpanded: () => void;
}

/** One row: `▸ id  label`. The id opens the node detail as before; the label toggles the row's
 *  explanation. A long label wraps under itself, never under the id. */
function CompactRow(p: CompactRowProps) {
  return (
    // eslint-disable-next-line local/no-inline-style -- dynamic POV color from nodeIdToTab
    <div className={`debate-why-row${p.detailOpen ? ' debate-reasoning-item--open' : ''}${p.sit && p.detailOpen ? ' taxrefs-item-sit' : ''}`} style={p.detailOpen && p.color ? { borderLeftColor: p.color } : undefined}>
      <div className="debate-why-row-line">
        <span className="debate-reasoning-caret" aria-hidden="true">{p.expanded ? '▾' : '▸'}</span>
        {p.primary && <span className="debate-reasoning-primary" title="Primary reference" aria-label="Primary reference">★</span>}
        <button
          type="button"
          className={`debate-reasoning-node${p.sit ? ' taxrefs-node-sit' : ''}`}
          // eslint-disable-next-line local/no-inline-style -- dynamic POV color from nodeIdToTab
          style={p.color ? { color: p.color } : undefined}
          aria-expanded={p.detailOpen}
          onClick={p.onToggleDetail}
        >
          {p.id}
        </button>
        <button
          type="button"
          className={`debate-why-row-label${p.missing ? ' debate-reasoning-label--missing' : ''}`}
          aria-expanded={p.expanded}
          onClick={p.onToggleExpanded}
        >
          {p.label}
        </button>
      </div>
      {p.expanded && <p className="debate-why-row-text">{p.relevance}</p>}
    </div>
  );
}

/** A group heading line: the label on the left and, on the first line of the panel, the
 *  Expand all / Collapse all control on the right (t/778, Design p/14#134). */
function WhyHeading({ label, control }: { label: string; control?: ReactNode }) {
  return (
    <div className="debate-why-head">
      <span className="taxrefs-bdi-group-label">{label}</span>
      {control}
    </div>
  );
}

interface CompactListProps {
  selectedBdiNodeId: string | null;
  toggleBdiNode: (nodeId: string) => void;
  expl: WhyExplanations;
}

function CompactBdiRef({ taxRef, selectedBdiNodeId, toggleBdiNode, expl }: CompactListProps & { taxRef: TaxonomyRef }) {
  const { text, missing } = useCompactLabel(taxRef);
  const { colorVar } = nodeIdToTab(taxRef.node_id);
  return (
    <CompactRow
      id={taxRef.node_id} label={text} missing={missing} relevance={taxRef.relevance} color={colorVar} primary={!!taxRef.primary}
      sit={taxRef.node_id.startsWith('sit-')}
      detailOpen={selectedBdiNodeId === taxRef.node_id} onToggleDetail={() => toggleBdiNode(taxRef.node_id)}
      expanded={expl.isOpen(taxRef.node_id)} onToggleExpanded={() => expl.toggle(taxRef.node_id)}
    />
  );
}

function CompactPolicyRefs({ polRefs, selectedBdiNodeId, toggleBdiNode, expl, control }: CompactListProps & { polRefs: PolicyRefEntry[]; control?: ReactNode }) {
  return (
    <div className="taxrefs-policy-refs" role="group" aria-label={`Policy actions, ${polRefs.length} ${polRefs.length === 1 ? 'action' : 'actions'}`}>
      <WhyHeading label={`Policy actions (${polRefs.length})`} control={control} />
      {polRefs.map((polRef, i) => {
        const { id, relevance } = resolvePolRef(polRef);
        return (
          <CompactRow
            key={`${id}-${i}`} id={id} label={getPolicyAction(id)} relevance={relevance ?? "Policy action referenced by this debater's argument"} sit
            detailOpen={selectedBdiNodeId === id} onToggleDetail={() => toggleBdiNode(id)}
            expanded={expl.isOpen(id)} onToggleExpanded={() => expl.toggle(id)}
          />
        );
      })}
    </div>
  );
}

/** t/778 §1: Desires, Intentions and Beliefs run as one list with no group headings (the id
 *  carries the category). Situations and policy actions keep theirs, as they are not BDI. */
function CompactBdiBody({ refs, polRefs, selectedBdiNodeId, setSelectedBdiNodeId, toggleBdiNode, expl, listId, control }: CompactListProps & {
  refs: TaxonomyRef[];
  polRefs: PolicyRefEntry[];
  setSelectedBdiNodeId: React.Dispatch<React.SetStateAction<string | null>>;
  listId: string;
  /** The Expand all / Collapse all link: on the BDI eyebrow, or on the first heading when there are no BDI rows. */
  control: ReactNode;
}) {
  const groups = useMemo(() => groupRefsByBdi(refs), [refs]);
  const bdiRefs = groups.filter(g => g.key !== 'situations').flatMap(g => g.refs);
  const sitRefs = groups.find(g => g.key === 'situations')?.refs ?? [];
  const row = (taxRef: TaxonomyRef) => (
    <CompactBdiRef key={taxRef.node_id} taxRef={taxRef} selectedBdiNodeId={selectedBdiNodeId} toggleBdiNode={toggleBdiNode} expl={expl} />
  );
  return (
    <div className="debate-reasoning-section-body" id={listId}>
      {bdiRefs.length > 0 && (
        <div className="taxrefs-bdi-group" role="group" aria-label="BDI nodes">
          <WhyHeading label="BDI" control={control} />
          {bdiRefs.map(row)}
        </div>
      )}
      {sitRefs.length > 0 && (
        <div className="taxrefs-bdi-group" role="group" aria-label={`Situations, ${sitRefs.length} node${sitRefs.length === 1 ? '' : 's'}`}>
          <WhyHeading label={`Situations (${sitRefs.length})`} control={bdiRefs.length === 0 ? control : undefined} />
          {sitRefs.map(row)}
        </div>
      )}
      {polRefs.length > 0 && (
        <CompactPolicyRefs
          polRefs={polRefs} selectedBdiNodeId={selectedBdiNodeId} toggleBdiNode={toggleBdiNode} expl={expl}
          control={bdiRefs.length === 0 && sitRefs.length === 0 ? control : undefined}
        />
      )}
      {selectedBdiNodeId && <TaxNodeDetail nodeId={selectedBdiNodeId} onClose={() => setSelectedBdiNodeId(null)} />}
    </div>
  );
}

/**
 * t/4625, t/778: the standalone "Why" tab — a statement's BDI grounding on its own, via
 * BdiSectionBody. AC5: a statement with no BDI refs (e.g. the System entry) shows a short
 * empty-state line, not an empty pane. (How→Plan used to also show this in a collapsible BDI
 * section; removed as redundant with this always-visible view, t/4625#10.)
 */
export function BdiGroundingView({ refs, policyRefs, metaPolicyRefs, emptyText = 'No BDI grounding for this statement.', stateKey }: {
  refs: TaxonomyRef[];
  policyRefs?: PolicyRefEntry[];
  metaPolicyRefs?: PolicyRefEntry[];
  /** t/187: empty-state line; Chat passes its own wording (t/167#3). */
  emptyText?: string;
  /** t/778: which statement's open rows to keep for the session (the entry id). Without it the
   *  rows are kept for as long as this panel stays mounted (Chat). */
  stateKey?: string;
}) {
  const [selectedBdiNodeId, setSelectedBdiNodeId] = useState<string | null>(null);
  const toggleBdiNode = (nodeId: string) => setSelectedBdiNodeId(prev => prev === nodeId ? null : nodeId);
  const polRefs = metaPolicyRefs || policyRefs || [];
  const listId = useId();
  const rowIds = useMemo(() => [...refs.map(r => r.node_id), ...polRefs.map(p => resolvePolRef(p).id)], [refs, polRefs]);
  const expl = useWhyExplanations(stateKey, rowIds);
  if (refs.length === 0 && polRefs.length === 0) {
    return <p className="taxrefs-why-empty">{emptyText}</p>;
  }
  const control = (
    <button type="button" className="debate-why-expand-all" aria-controls={listId} onClick={() => expl.setAll(!expl.allOpen)}>
      {expl.allOpen ? 'Collapse all' : 'Expand all'}
    </button>
  );
  return (
    <CompactBdiBody
      refs={refs} polRefs={polRefs} selectedBdiNodeId={selectedBdiNodeId} setSelectedBdiNodeId={setSelectedBdiNodeId}
      toggleBdiNode={toggleBdiNode} expl={expl} listId={listId} control={control}
    />
  );
}

function ReasoningList({ briefStage, planStage, selectedPlanNodeId, setSelectedPlanNodeId, entry }: {
  entry?: TranscriptEntry;
  briefStage?:{ stage: string; raw_response: string; work_product: Record<string, unknown> };
  planStage?: { stage: string; raw_response: string; work_product: Record<string, unknown> };
  selectedPlanNodeId: string | null;
  setSelectedPlanNodeId: React.Dispatch<React.SetStateAction<string | null>>;
}) {
  return (
    <div className="debate-reasoning-list">
      {briefStage && <BriefSection briefStage={briefStage} />}
      {planStage && <PlanSection planStage={planStage} selectedPlanNodeId={selectedPlanNodeId} setSelectedPlanNodeId={setSelectedPlanNodeId} entry={entry} />}
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
          entry={entry}
          selectedPlanNodeId={selectedPlanNodeId}
          setSelectedPlanNodeId={setSelectedPlanNodeId}
        />
      )}
    </div>
  );
}
