// t/469: per-statement HOW, Layout A (docs/ux/debate-statement-how.md). The Openings card vocabulary
// (claim grid, lens cards, assumption cards, More) over a statement's own data. Each part is shown
// only where its field exists; no plan-stage section is used.

import type { ArgumentNetworkNode, ArgumentNetworkEdge, ConvergenceSignals, TranscriptEntry } from '../../types/debate';
import type { VocabResolution } from '../../utils/vocabularyAnnotations';
import { buildStatementHow, readDebateHow, statementCounts, type StatementHowClaim, type StatementHowModel } from './statementHow';
import { ClaimRow } from './StatementHowClaims';
import { ConvergenceSection, HowVocabulary } from './StatementHowSections';
import { speakerLabel } from './utils';
import './TaxonomyRefs.css';
import './StatementHowLayout.css';


/** The debate fields the HOW view reads. */
export interface StatementHowDebate {
  argument_network?: { nodes: ArgumentNetworkNode[]; edges: ArgumentNetworkEdge[] };
  convergence_signals?: ConvergenceSignals[];
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

export function StatementHowLayout({ entry, debate, vocabResolutions, meta }: {
  entry: TranscriptEntry;
  debate: StatementHowDebate | null | undefined;
  vocabResolutions: VocabResolution[] | undefined;
  meta: Record<string, unknown> | undefined;
}) {
  const { nodes, edges, convergence } = readDebateHow(debate, entry.id);
  if (!nodes || nodes.length === 0) return <div className="claims-empty">No argument network yet</div>;
  const model = buildStatementHow(entry, nodes, edges);
  const ambiguities = meta?.vocabulary_ambiguities as { colloquial: string; offset?: number }[] | undefined;
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
