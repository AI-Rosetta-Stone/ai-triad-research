// t/469: the convergence and vocabulary sections of the per-statement HOW. Each hides when empty.

import type { ConvergenceSignals, TranscriptEntry } from '../../types/debate';
import type { VocabResolution } from '../../utils/vocabularyAnnotations';
import { extractLineageNames } from '../../utils/lineageMatcher';
import { convergenceCells } from './statementHow';
import { VocabTermsView, LineageTermsView } from './VocabularyPanel';
import { povToCamp } from '../shared/CampGlyph';

/** The seven convergence signals as labelled cells, or the absent-data copy. */
export function ConvergenceSection({ signal }: { signal: ConvergenceSignals | undefined }) {
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
export function HowVocabulary({ entry, vocabResolutions, ambiguities }: {
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

