// t/469: per-statement HOW, Layout A (docs/ux/debate-statement-how.md). The Openings card vocabulary
// (claim grid, lens cards, assumption cards, More) over a statement's own data. Each part is shown
// only where its field exists; no plan-stage section is used.

import { useState } from 'react';
import type { ArgumentNetworkNode, ArgumentNetworkEdge, ConvergenceSignals, TranscriptEntry } from '../../types/debate';
import type { VocabResolution } from '../../utils/vocabularyAnnotations';
import { extractLineageNames } from '../../utils/lineageMatcher';
import { buildStatementHow, collapseItems, convergenceCells, statementCounts, type StatementHowClaim, type StatementHowItem, type StatementHowModel } from './statementHow';
import { VocabTermsView, LineageTermsView } from './VocabularyPanel';
import { speakerLabel } from './utils';
import { povToCamp } from '../shared/CampGlyph';
import './TaxonomyRefs.css';
import './StatementHowLayout.css';

const COLLAPSE_AT = 3;

/** One claim and its attacks and supports. The first three are shown; the rest sit behind "Show N more". */
function ClaimRow({ claim }: { claim: StatementHowClaim }) {
  const [expanded, setExpanded] = useState(false);
  const items: StatementHowItem[] = [...claim.attacks, ...claim.supports];
  const { shown, hidden } = collapseItems(items, COLLAPSE_AT);
  const visible = expanded ? items : shown;
  return (
    <li className="claim-map-row">
      <div className="claim-map-claim-col">
        <div className="claim-map-claim-card">
          <div className="claim-map-claim-badge">C{claim.index}</div>
          <p className="claim-map-claim-point">{claim.node.text ?? ''}</p>
        </div>
      </div>
      <div className="sh-item-col" role="group" aria-label={items.length === 0 ? `No attack mapped to C${claim.index}` : `Attacks and supports on C${claim.index}`}>
        {items.length === 0 && (
          <div className="claim-map-no-attack">
            <p className="claim-map-no-attack-title">No attack mapped to C{claim.index}</p>
          </div>
        )}
        {visible.map(item => <HowItemCard key={item.id} item={item} index={claim.index} />)}
        {!expanded && hidden > 0 && (
          <button type="button" className="sh-show-more" aria-expanded={false} onClick={() => setExpanded(true)}>
            Show {hidden} more
          </button>
        )}
      </div>
    </li>
  );
}

function HowItemCard({ item, index }: { item: StatementHowItem; index: number }) {
  if (item.kind === 'attacks') {
    return (
      <div className="claim-map-attack-card">
        <div className="claim-map-attack-eyebrow">← ATTACK ON C{index}</div>
        <p className="claim-map-attack-text">{item.text}</p>
        <div className="claim-map-attack-footer">
          <span className="claim-map-attack-status">Unverified</span>
        </div>
      </div>
    );
  }
  return (
    <div className="sh-support-card">
      <div className="sh-support-eyebrow">SUPPORTS C{index}</div>
      <p className="sh-support-text">{item.text}</p>
    </div>
  );
}

function HowMoves({ moves, claims }: { moves: StatementHowModel['moves']; claims: StatementHowClaim[] }) {
  const linked = (target: string | undefined) => {
    const idx = claims.find(c => c.node.id === target)?.index;
    return idx ? `→ C${idx}` : target ? `→ ${target}` : undefined;
  };
  return (
    <div className="sh-moves" aria-label="Planned moves">
      <span className="sh-moves-label">Planned moves</span>
      {moves.map((m, i) => (
        <span key={i} className="sh-move-chip" tabIndex={0} title={m.detail ?? m.move}>
          {m.move}{linked(m.target) && <span className="sh-move-target"> {linked(m.target)}</span>}
        </span>
      ))}
    </div>
  );
}

function HowAssumptions({ assumptions }: { assumptions: StatementHowModel['assumptions'] }) {
  return (
    <div className="claim-map-assumptions">
      {assumptions.map((a, i) => (
        <div key={i} className="claim-map-assumption-card">
          <div className="claim-map-assumption-eyebrow">ASSUMPTION</div>
          <p className="claim-map-assumption-text">{a.assumption}</p>
          {a.if_wrong && <p className="sh-if-wrong"><strong>If wrong:</strong> {a.if_wrong}</p>}
        </div>
      ))}
    </div>
  );
}

function HowAnticipated({ items }: { items: string[] }) {
  return (
    <details className="claim-map-more" open={items.length <= 2}>
      <summary className="claim-map-more-summary">
        <span className="claim-map-more-toggle" aria-hidden="true" /> Anticipated responses ({items.length})
      </summary>
      <ul className="sh-anticipated">
        {items.map((s, i) => <li key={i}>{s}</li>)}
      </ul>
    </details>
  );
}

/** The seven convergence signals as labelled cells, or the absent-data copy. */
function ConvergenceSection({ signal }: { signal: ConvergenceSignals | undefined }) {
  return (
    <section className="sh-section" aria-label="Convergence">
      <div className="claim-map-eyebrow">CONVERGENCE</div>
      {signal ? (
        <ul className="sh-convergence">
          {convergenceCells(signal).map(([label, value]) => (
            <li key={label} className="claim-map-lens-card">
              <div className="claim-map-lens-eyebrow">{label}</div>
              <div className="sh-convergence-value">{value}</div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="convergence-empty">No convergence data for this turn.</div>
      )}
    </section>
  );
}

/** Vocabulary and lineage cards. Each part is hidden when it has nothing to show. */
function HowVocabulary({ entry, vocabResolutions, ambiguities }: {
  entry: TranscriptEntry;
  vocabResolutions: VocabResolution[] | undefined;
  ambiguities?: { colloquial: string; offset?: number }[];
}) {
  const hasVocab = !!vocabResolutions && vocabResolutions.length > 0;
  const hasLineage = extractLineageNames(entry.content).length > 0;
  if (!hasVocab && !hasLineage) return null;
  return (
    <section className="sh-section" aria-label="Vocabulary and lineage">
      {hasVocab && (
        <VocabTermsView resolutions={vocabResolutions!} ambiguities={ambiguities} statementText={entry.content} speakerPov={povToCamp(entry.speaker) ? entry.speaker : undefined} />
      )}
      {hasLineage && <LineageTermsView content={entry.content} />}
    </section>
  );
}

export function StatementHowLayout({ entry, nodes, edges, convergence, vocabResolutions, ambiguities }: {
  entry: TranscriptEntry;
  nodes: ArgumentNetworkNode[] | undefined;
  edges: ArgumentNetworkEdge[] | undefined;
  convergence: ConvergenceSignals | undefined;
  vocabResolutions: VocabResolution[] | undefined;
  ambiguities?: { colloquial: string; offset?: number }[];
}) {
  if (!nodes || nodes.length === 0) return <div className="claims-empty">No argument network yet</div>;
  const model = buildStatementHow(entry, nodes, edges ?? []);
  const counts = statementCounts(model);
  return (
    <div className="sh-layout">
      <header className="sh-header">
        <div className="claim-map-eyebrow">{speakerLabel(entry.speaker).toUpperCase()} · STATEMENT</div>
        {counts && <div className="claim-map-counts">{counts}</div>}
        {model.focus && <div className="sh-focus"><strong>Focus:</strong> {model.focus}</div>}
        {model.moves.length > 0 && <HowMoves moves={model.moves} claims={model.claims} />}
      </header>

      {model.claims.length === 0 ? (
        <div className="claims-empty">No claims extracted for this statement</div>
      ) : (
        <ol className="claim-map-grid sh-claims" aria-label="Claims and their attacks and supports">
          {model.claims.map(claim => <ClaimRow key={claim.node.id} claim={claim} />)}
        </ol>
      )}

      {model.assumptions.length > 0 && <HowAssumptions assumptions={model.assumptions} />}
      {model.anticipated.length > 0 && <HowAnticipated items={model.anticipated} />}
      <ConvergenceSection signal={convergence} />
      <HowVocabulary entry={entry} vocabResolutions={vocabResolutions} ambiguities={ambiguities} />
    </div>
  );
}
